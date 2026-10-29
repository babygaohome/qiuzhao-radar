'use strict'

const assert = require('node:assert/strict')
const { createSnapshotStore, digestId } = require('../cloudfunctions/intelDigest/snapshot-store')

function sdkMissingDocument (id) {
  return Object.assign(new Error(`document.get:fail document with _id ${id} does not exist`), { errCode: -1 })
}

function fakeDb (initial = {}) {
  const tables = new Map(Object.entries(initial).map(([name, rows]) => [name, new Map(Object.entries(rows))]))
  const failures = new Map()
  function collection (name) {
    if (!tables.has(name)) tables.set(name, new Map())
    const rows = tables.get(name)
    const maybeFail = (op) => { if (failures.has(`${name}.${op}`)) throw failures.get(`${name}.${op}`) }
    return {
      doc (id) {
        return {
          async get () { maybeFail('get'); if (!rows.has(id)) throw sdkMissingDocument(id); return { data: structuredClone(rows.get(id)) } },
          async set ({ data }) { maybeFail('set'); rows.set(id, structuredClone(data)); return { stats: { updated: 1 } } }
        }
      },
      where (query) {
        return {
          async remove () {
            maybeFail('remove')
            let removed = 0
            for (const [id, row] of rows) {
              if (Object.entries(query).every(([key, value]) => row[key] === value)) { rows.delete(id); removed++ }
            }
            return { stats: { removed } }
          }
        }
      }
    }
  }
  return {
    collection,
    async runTransaction (fn) { return fn({ collection }) },
    tables, failures,
    set (table, id, value) { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table).set(id, structuredClone(value)) }
  }
}

const basePreference = { _id: 'alice', generation: 2, dailyDigestEnabled: true, deleted: false, digestGeneration: 0, timezone: 'Asia/Shanghai' }
const baseSnapshot = { localDate: '2026-10-29', timezone: 'Asia/Shanghai', itemIds: ['item-a'], jobCompanyIds: ['company-a'], algorithmVersion: 'v1', generatedAt: '2026-10-29T00:00:00.000Z' }

async function testIdempotencyAndIsolation () {
  const db = fakeDb({ intel_preferences: { alice: basePreference, bob: { ...basePreference, _id: 'bob' } } })
  const store = createSnapshotStore({ db })
  const first = await store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: baseSnapshot })
  const second = await store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: { ...baseSnapshot, itemIds: ['later-item'] } })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.deepEqual(second.record.itemIds, ['item-a'])
  assert.deepEqual(await store.getMine({ openid: 'bob', localDate: '2026-10-29' }), null)
  assert.equal(await store.getMine({ openid: 'alice', localDate: '2026-10-29' }).then(x => x.openid), undefined, 'public view omits openid')
  assert.equal(db.tables.get('intel_digests').size, 1)
  assert.notEqual(digestId('alice', '2026-10-29', 2, 0), digestId('bob', '2026-10-29', 2, 0))
}

async function testGenerationAndDisabled () {
  for (const pref of [
    { ...basePreference, generation: 3 },
    { ...basePreference, deleted: true },
    { ...basePreference, dailyDigestEnabled: false }
  ]) {
    const db = fakeDb({ intel_preferences: { alice: pref } })
    const store = createSnapshotStore({ db })
    await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: baseSnapshot }))
    assert.equal(db.tables.get('intel_digests'), undefined)
  }
}

async function testPostCommitFence () {
  const db = fakeDb({ intel_preferences: { alice: basePreference } })
  const original = db.runTransaction.bind(db)
  let changed = false
  db.runTransaction = async fn => {
    const result = await original(fn)
    if (!changed) {
      changed = true
      db.set('intel_preferences', 'alice', { ...basePreference, generation: 2, digestGeneration: 1, deleted: false })
      // Model a rapid re-enable and same-date save before the old writer's post-commit fence.
      db.set('intel_digests', digestId('alice', '2026-10-29', 2, 1), {
        _id: digestId('alice', '2026-10-29', 2, 1), openid: 'alice', localDate: '2026-10-29',
        timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 1, itemIds: ['new-generation-item'], jobCompanyIds: [], status: 'ready'
      })
    }
    return result
  }
  const store = createSnapshotStore({ db })
  await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: baseSnapshot }), e => ['stale_generation', 'stale_digest_generation', 'digest_disabled'].includes(e.code))
  assert.deepEqual(db.tables.get('intel_digests').get(digestId('alice', '2026-10-29', 2, 1)).itemIds, ['new-generation-item'], 'cleanup of a stale generation must preserve a new post-delete snapshot')
}

async function testWhitelistAndFailures () {
  const db = fakeDb({ intel_preferences: { alice: basePreference } })
  const store = createSnapshotStore({ db })
  await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: { ...baseSnapshot, resume: 'private' } }), e => e.code === 'bad_request')
  db.failures.set('intel_digests.set', Object.assign(new Error('write denied'), { code: 'permission_denied' }))
  await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: baseSnapshot }), /write denied/)
  db.failures.delete('intel_digests.set')
  db.failures.set('intel_digests.get', Object.assign(new Error('read denied'), { code: 'permission_denied' }))
  await assert.rejects(store.getMine({ openid: 'alice', localDate: '2026-10-29' }), /read denied/)
  await assert.rejects(store.saveIfAbsent({ openid: '', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: baseSnapshot }), e => e.code === 'unauthenticated')
}


async function testGenerationScopedReadAndTimezone () {
  const oldId = digestId('alice', '2026-10-29', 2, 0)
  const currentId = digestId('alice', '2026-10-29', 3, 0)
  const db = fakeDb({
    intel_preferences: { alice: { ...basePreference, generation: 3 } },
    intel_digests: {
      [oldId]: { _id: oldId, openid: 'alice', localDate: '2026-10-29', generation: 2, digestGeneration: 0, itemIds: ['old'] },
      [currentId]: { _id: currentId, openid: 'alice', localDate: '2026-10-29', generation: 3, digestGeneration: 0, itemIds: ['current'] }
    }
  })
  const store = createSnapshotStore({ db })
  assert.deepEqual((await store.getMine({ openid: 'alice', localDate: '2026-10-29' })).itemIds, ['current'])
  assert.notEqual(oldId, currentId, 'generation is part of the stable snapshot key')
  await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'UTC', generation: 3, digestGeneration: 0, snapshot: { ...baseSnapshot, timezone: 'UTC' } }), e => e.code === 'stale_timezone')
  db.set('intel_preferences', 'alice', { ...basePreference, generation: 3, deleted: true })
  await assert.rejects(store.getMine({ openid: 'alice', localDate: '2026-10-29' }), e => e.code === 'digest_disabled')
}

async function testTransientPreferenceReadDoesNotDeleteSnapshot () {
  const id = digestId('alice', '2026-10-29', 2, 0)
  const existing = { _id: id, openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, itemIds: ['keep'], jobCompanyIds: [], status: 'ready' }
  const db = fakeDb({ intel_preferences: { alice: basePreference }, intel_digests: { [id]: existing } })
  const baseTransaction = db.runTransaction.bind(db)
  let transactionReads = 0
  db.runTransaction = async fn => baseTransaction(tx => {
    const wrapped = {
      collection: name => {
        const col = tx.collection(name)
        if (name !== 'intel_preferences') return col
        return { doc: key => {
          const doc = col.doc(key)
          return { ...doc, async get () { transactionReads++; return doc.get() } }
        } }
      }
    }
    return fn(wrapped)
  })
  const originalCollection = db.collection.bind(db)
  db.collection = name => {
    const col = originalCollection(name)
    if (name !== 'intel_preferences') return col
    return { ...col, doc: key => {
      const doc = col.doc(key)
      return { ...doc, async get () {
        if (transactionReads > 0) throw Object.assign(new Error('permission denied'), { code: 'permission_denied' })
        return doc.get()
      } }
    } }
  }
  const store = createSnapshotStore({ db })
  await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: baseSnapshot }), /permission denied/)
  assert.deepEqual(db.tables.get('intel_digests').get(id).itemIds, ['keep'], 'transient read failure does not delete an existing snapshot')
}


async function testExistingSnapshotSurvivesTimezoneRace () {
  const id = digestId('alice', '2026-10-29', 2, 0)
  const existing = { _id: id, openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, itemIds: ['keep'], jobCompanyIds: [], status: 'ready' }
  const db = fakeDb({ intel_preferences: { alice: basePreference }, intel_digests: { [id]: existing } })
  const originalTransaction = db.runTransaction.bind(db)
  let changed = false
  db.runTransaction = async fn => {
    const result = await originalTransaction(fn)
    if (!changed) { changed = true; db.set('intel_preferences', 'alice', { ...basePreference, timezone: 'UTC' }) }
    return result
  }
  const store = createSnapshotStore({ db })
  await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 0, snapshot: baseSnapshot }), e => e.code === 'stale_timezone')
  assert.deepEqual(db.tables.get('intel_digests').get(id).itemIds, ['keep'], 'post-check on idempotent result cannot delete the pre-existing snapshot')
}


async function testDigestGenerationRejectsQuickReenable () {
  const db = fakeDb({ intel_preferences: { alice: { ...basePreference, dailyDigestEnabled: true, digestGeneration: 2 } } })
  const store = createSnapshotStore({ db })
  await assert.rejects(store.saveIfAbsent({ openid: 'alice', localDate: '2026-10-29', timezone: 'Asia/Shanghai', generation: 2, digestGeneration: 1, snapshot: baseSnapshot }), e => e.code === 'stale_digest_generation')
  assert.equal(db.tables.get('intel_digests'), undefined)
  const id = digestId('alice', '2026-10-29', 2, 2)
  db.set('intel_digests', id, { _id: id, openid: 'alice', localDate: '2026-10-29', generation: 2, digestGeneration: 2, timezone: 'Asia/Shanghai', itemIds: ['fresh'], jobCompanyIds: [], status: 'ready' })
  assert.deepEqual((await store.getMine({ openid: 'alice', localDate: '2026-10-29' })).itemIds, ['fresh'])
}

async function run () {
  await testIdempotencyAndIsolation()
  await testGenerationAndDisabled()
  await testGenerationScopedReadAndTimezone()
  await testDigestGenerationRejectsQuickReenable()
  await testTransientPreferenceReadDoesNotDeleteSnapshot()
  await testExistingSnapshotSurvivesTimezoneRace()
  await testPostCommitFence()
  await testWhitelistAndFailures()
  console.log('intel-digest-store: all assertions passed')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
