'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createCloudBaseStore, LEASE_ID } = require('../cloudfunctions/intelCrawler/cloudbase-store')
const { SOURCES, normalize, runIngestion } = require('../cloudfunctions/intelCrawler/core')
const crawler = require('../cloudfunctions/intelCrawler')

function fakeDb () {
  const data = new Map()
  const key = (collection, id) => `${collection}/${id}`
  const collection = name => ({
    doc: id => ({
      async get () {
        const value = data.get(key(name, id))
        if (!value) throw Object.assign(new Error('document does not exist'), { code: 'DATABASE_DOCUMENT_NOT_EXIST' })
        return { data: { ...value, _id: id } }
      },
      async set ({ data: value }) { data.set(key(name, id), { ...value }); return { stats: { updated: 1 } } },
      async update ({ data: patch }) {
        const old = data.get(key(name, id))
        if (!old) throw Object.assign(new Error('document does not exist'), { code: 'DATABASE_DOCUMENT_NOT_EXIST' })
        data.set(key(name, id), { ...old, ...patch }); return { stats: { updated: 1 } }
      }
    })
  })
  return { data, collection, async runTransaction (fn) { return fn({ collection }) } }
}

test('lease expires, takeover fences stale writes, and only current token releases it', async () => {
  let now = 1000
  const db = fakeDb(); const store = createCloudBaseStore(db, { now: () => now, leaseMs: 100 })
  assert.equal(await store.acquireLease('old'), true)
  assert.equal(await store.acquireLease('other'), false)
  now = 1101
  assert.equal(await store.acquireLease('new'), true)
  await assert.rejects(store.upsert({ _id: 'x', title: 'stale' }, 'old'), { code: 'lease_lost' })
  await assert.rejects(store.setCheckpoint('source', { page: 1 }, 'old'), { code: 'lease_lost' })
  assert.equal(await store.releaseLease('old'), false)
  await store.upsert({ _id: 'x', title: 'current' }, 'new')
  await store.setCheckpoint('source', { page: 1, completedAt: '2026-10-29T00:00:00Z' }, 'new')
  assert.deepEqual(db.data.get('intel_items/x'), { title: 'current' })
  assert.equal((await store.getCheckpoint('source')).sourceId, 'source')
  assert.equal(db.data.get(`intel_runs/${LEASE_ID}`).token, 'new')
  assert.equal(await store.releaseLease('new'), true)
})

test('CloudBase storage persists item, checkpoint, and run metadata across retries without secrets', async () => {
  let now = 5000
  const db = fakeDb(); const store = createCloudBaseStore(db, { now: () => now, leaseMs: 1000 })
  const source = SOURCES[0]
  const release = { id: 42, name: 'Release 42', tag_name: 'v42', html_url: `https://github.com/${source.owner}/${source.repo}/releases/tag/v42`, published_at: '2026-10-28T12:00:00Z' }
  let failed = true
  const first = await runIngestion({ store, sources: [source], sleep: async () => {}, fetchJson: async () => {
    if (failed) throw Object.assign(new Error('authorization header should not persist'), { code: 'http_error', status: 503 })
    return [release]
  } })
  assert.equal(first.status, 'partial')
  assert.equal(db.data.has('intel_items/' + normalize(source, release, '2026-10-29T00:00:00Z')._id), false)
  assert.equal(db.data.has('intel_sources/' + source.id), false)
  failed = false; now++
  const second = await runIngestion({ store, sources: [source], clock: () => new Date('2026-10-29T00:00:00Z'), sleep: async () => {}, fetchJson: async () => [release] })
  assert.equal(second.status, 'success')
  const item = normalize(source, release, '2026-10-29T00:00:00.000Z')
  assert.equal(db.data.has(`intel_items/${item._id}`), true)
  assert.equal((await store.getCheckpoint(source.id)).page, 1)
  const runs = [...db.data.entries()].filter(([key]) => key.startsWith('intel_runs/') && key !== `intel_runs/${LEASE_ID}`)
  assert.equal(runs.length, 2)
  assert.equal(runs[1][1].status, 'success')
  assert.doesNotMatch(JSON.stringify(runs), /authorization header|Bearer|secret/i)
})

test('timer is disabled by default and authenticated by runtime source plus required envelope fields', async () => {
  assert.deepEqual(await crawler._test.createMain({ cloud: { init () {}, getWXContext: () => ({}), database: () => ({ runTransaction: async () => {} }) }, getRuntimeEnv: () => ({}), processEnv: {} })({ Type: 'timer', TriggerName: crawler._test.TRIGGER_NAME, Time: new Date().toISOString() }), {
    ok: false, code: 'INVALID_TRIGGER'
  })
  const valid = { Type: 'timer', TriggerName: crawler._test.TRIGGER_NAME, Time: '2026-10-29T00:00:00.000Z' }
  assert.equal(crawler._test.validTimerEnvelope(valid, {}, { TRIGGER_SRC: 'timer' }), true)
  assert.equal(crawler._test.validTimerEnvelope(valid, {}, {}), false)
  assert.equal(crawler._test.validTimerEnvelope({ ...valid, TriggerName: 'forged' }, {}, { TRIGGER_SRC: 'timer' }), false)
  assert.equal(crawler._test.validTimerEnvelope(valid, { OPENID: 'user' }, { TRIGGER_SRC: 'timer' }), false)
})

