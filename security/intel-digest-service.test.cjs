'use strict'

const assert = require('node:assert/strict')
const { createDigestService } = require('../cloudfunctions/intelDigest/service')

function sourceItem (id = 'release-a') {
  return { id, status: 'published', dateStatus: 'confirmed', category: 'ai', sourceIds: ['huggingface-transformers-releases'], sourceName: 'Hugging Face', sourceKind: 'release', title: 'A release', originalUrl: `https://github.com/huggingface/transformers/releases/${id}`, publishedAt: '2026-10-28T13:00:00Z' }
}

function setup (options = {}) {
  const calls = { preferences: [], feeds: [], saves: [], reads: [] }
  const preferences = options.preferences || { dailyDigestEnabled: true, timezone: 'Asia/Shanghai', digestLocalTime: '08:00', generation: 2, digestGeneration: 7, topics: { ai: 0.35 } }
  const saved = new Map()
  let feedItems = options.items || [sourceItem()]
  const service = createDigestService({
    resolveIdentity: async context => { calls.identity = context; return options.openid || 'server-user' },
    readPreferences: async openid => { calls.preferences.push(openid); return preferences },
    readItems: async range => { calls.feeds.push(range); return feedItems },
    snapshotStore: {
      saveIfAbsent: async args => {
        calls.saves.push(args)
        const key = `${args.openid}:${args.localDate}:${args.generation}`
        if (saved.has(key)) return { created: false, record: saved.get(key) }
        const record = { ...args.snapshot }
        saved.set(key, record)
        return { created: true, record }
      },
      getMine: async args => { calls.reads.push(args); return saved.get(`${args.openid}:${args.localDate}:${preferences.generation}`) || null }
    },
    now: options.now || (() => Date.parse('2026-10-29T01:30:00Z'))
  })
  return { service, calls, setItems: items => { feedItems = items } }
}

async function run () {
  const base = setup()
  const result = await base.service.generate({}, { trusted: true })
  assert.equal(result.created, true)
  assert.deepEqual(result.snapshot.itemIds, ['release-a'])
  assert.deepEqual(result.snapshot.jobCompanyIds, [])
  assert.equal('openid' in result.snapshot, false)
  assert.equal(base.calls.saves[0].digestGeneration, 7)
  assert.deepEqual(base.calls.feeds[0], { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' })
  assert.equal('openid' in base.calls.feeds[0], false)

  // Existing daily snapshots remain stable when the feed changes after generation.
  base.setItems([sourceItem('release-b')])
  const again = await base.service.generate({}, { trusted: true })
  assert.equal(again.created, false)
  assert.deepEqual(again.snapshot.itemIds, ['release-a'])
  assert.equal('items' in again, false)
  assert.equal(base.calls.saves.length, 2)

  const disabled = setup({ preferences: { dailyDigestEnabled: false, timezone: 'Asia/Shanghai', digestLocalTime: '08:00', generation: 0 } })
  await assert.rejects(disabled.service.generate({}, {}), e => e.code === 'digest_disabled')
  assert.equal(disabled.calls.feeds.length, 0)

  const deleted = setup({ preferences: { dailyDigestEnabled: true, deleted: true, timezone: 'Asia/Shanghai', digestLocalTime: '08:00', generation: 3 } })
  await assert.rejects(deleted.service.generate({}, {}), e => e.code === 'digest_disabled')
  assert.equal(deleted.calls.feeds.length, 0)

  const noTimezone = setup({ preferences: { dailyDigestEnabled: true, digestLocalTime: '08:00', generation: 0 } })
  await assert.rejects(noTimezone.service.generate({}, {}), e => e.code === 'invalid_timezone')
  assert.equal(noTimezone.calls.feeds.length, 0)

  const beforeCutoff = setup({ now: () => Date.parse('2026-10-28T23:59:00Z') })
  await assert.rejects(beforeCutoff.service.generate({}, {}), e => e.code === 'digest_not_due')
  assert.equal(beforeCutoff.calls.feeds.length, 0)
  await assert.rejects(base.service.generate({ localDate: '2026-10-28' }, {}), e => e.code === 'digest_date_not_current')

  const noItems = setup({ items: [] })
  const empty = await noItems.service.generate({}, {})
  assert.deepEqual(empty.snapshot.itemIds, [])
  assert.deepEqual(empty.snapshot.jobCompanyIds, [])

  const storeFailure = setup()
  storeFailure.service = createDigestService({
    resolveIdentity: async () => 'server-user',
    readPreferences: async () => ({ dailyDigestEnabled: true, timezone: 'Asia/Shanghai', digestLocalTime: '08:00', generation: 0 }),
    readItems: async () => [sourceItem()],
    snapshotStore: { saveIfAbsent: async () => { throw Object.assign(new Error('database unavailable'), { code: 'database_unavailable' }) }, getMine: async () => null },
    now: () => Date.parse('2026-10-29T01:30:00Z')
  })
  await assert.rejects(storeFailure.service.generate({}, {}), e => e.code === 'database_unavailable')

  const deniedIdentity = createDigestService({ resolveIdentity: async () => '', readPreferences: async () => ({}), readItems: async () => [], snapshotStore: { saveIfAbsent: async () => ({}), getMine: async () => null } })
  await assert.rejects(deniedIdentity.generate({}, {}), e => e.code === 'unauthenticated')
}

run().then(() => console.log('intel-digest-service: all assertions passed')).catch(error => { console.error(error); process.exitCode = 1 })
