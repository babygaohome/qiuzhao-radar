'use strict'

const assert = require('node:assert/strict')
const { createDigestService } = require('../cloudfunctions/intelDigest/service')
const { createSnapshotStore } = require('../cloudfunctions/intelDigest/snapshot-store')
const { createDigestHandlers } = require('../cloudfunctions/api/intel/digest-handlers')

const ZONE = 'Asia/Shanghai'
const NOW = Date.parse('2026-10-29T01:30:00.000Z')

function createDb () {
  const tables = new Map()
  const failures = new Map()
  const command = { in: values => ({ $in: values }) }
  const getTable = name => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  const matches = (row, query) => Object.entries(query).every(([field, expected]) => {
    if (expected && Array.isArray(expected.$in)) return expected.$in.includes(row[field])
    if (expected && expected.$lt !== undefined) return row[field] < expected.$lt
    return row[field] === expected
  })
  function collection (name) {
    return {
      doc (id) {
        return {
          async get () {
            const failure = failures.get(`${name}:${id}`)
            if (failure) throw failure
            const row = getTable(name).get(id)
            return { data: row ? { ...row } : null }
          },
          async set ({ data }) { getTable(name).set(id, { ...data, _id: id }); return { stats: { updated: 1 } } },
          async remove () { return { stats: { removed: getTable(name).delete(id) ? 1 : 0 } } }
        }
      },
      where (query) {
        let projection = null
        let max = Infinity
        let sort = null
        return {
          field (fields) { projection = fields; return this },
          orderBy (field, direction) { sort = [field, direction]; return this },
          limit (value) { max = value; return this },
          async get () {
            const failure = failures.get(`${name}:query`)
            if (failure) throw failure
            let rows = [...getTable(name).values()].filter(row => matches(row, query))
            if (sort) rows = rows.sort((a, b) => {
              const result = String(a[sort[0]]).localeCompare(String(b[sort[0]]))
              return sort[1] === 'desc' ? -result : result
            })
            rows = rows.slice(0, max).map(row => {
              if (!projection) return { ...row }
              return Object.fromEntries(Object.keys(projection).filter(key => projection[key] === true).map(key => [key, row[key]]))
            })
            return { data: rows }
          },
          async remove () {
            const table = getTable(name)
            let removed = 0
            for (const [id, row] of table) if (matches(row, query)) { table.delete(id); removed++ }
            return { stats: { removed } }
          }
        }
      }
    }
  }
  const db = {
    command,
    collection,
    async runTransaction (fn) { return fn(db) },
    put (name, id, data) { getTable(name).set(id, { ...data, _id: id }) },
    fail (name, id, error) { failures.set(`${name}:${id}`, error) },
    failQuery (name, error) { failures.set(`${name}:query`, error) },
    rows (name) { return [...getTable(name).values()].map(row => ({ ...row })) }
  }
  return db
}

function makeItem (id, patch = {}) {
  return {
    _id: id,
    id,
    status: 'published',
    dateStatus: 'confirmed',
    category: 'ai',
    sourceIds: ['huggingface-transformers-releases'],
    sourceName: 'huggingface/transformers · GitHub Releases',
    sourceKind: 'open_source_release',
    title: `Release ${id}`,
    originalUrl: `https://github.com/huggingface/transformers/releases/${id}`,
    publishedAt: '2026-10-28T13:00:00.000Z',
    ...patch
  }
}

function makePreference (openid, patch = {}) {
  return {
    _id: openid,
    timezone: ZONE,
    digestLocalTime: '08:00',
    dailyDigestEnabled: true,
    topics: { ai: 0.35 },
    blockedTopics: [],
    generation: 2,
    digestGeneration: 1,
    ...patch
  }
}

async function run () {
  const db = createDb()
  db.put('intel_preferences', 'account-a', makePreference('account-a'))
  db.put('intel_preferences', 'account-b', makePreference('account-b'))
  db.put('intel_items', 'release-a', makeItem('release-a'))
  db.put('intel_items', 'release-b', makeItem('release-b'))

  const store = createSnapshotStore({ db, now: () => new Date(NOW).toISOString() })
  const service = createDigestService({
    resolveIdentity: async context => context && context.authenticatedOpenid,
    readPreferences: async openid => {
      const result = await db.collection('intel_preferences').doc(openid).get()
      return result.data
    },
    readItems: async ({ start, end }) => {
      return db.rows('intel_items').filter(item => Date.parse(item.publishedAt) >= Date.parse(start) && Date.parse(item.publishedAt) <= Date.parse(end))
    },
    snapshotStore: store,
    now: () => NOW
  })
  const readHandlers = createDigestHandlers({ db, now: () => NOW })

  const generated = await service.generate({}, { authenticatedOpenid: 'account-a' })
  assert.equal(generated.created, true)
  assert.deepEqual(generated.snapshot.itemIds, ['release-a', 'release-b'])
  assert.equal(generated.snapshot.localDate, '2026-10-29')
  assert.equal(generated.snapshot.timezone, ZONE)
  assert.equal('openid' in generated.snapshot, false)

  const todayA = await readHandlers.intelDigestToday({}, 'account-a')
  assert.deepEqual(todayA.digest.items.map(item => item.itemId), generated.snapshot.itemIds)
  assert.deepEqual(todayA.digest.items.map(item => item.title), ['Release release-a', 'Release release-b'])
  assert.equal(todayA.digest.items[0].reason, '近期资讯')
  const historyA = await readHandlers.intelDigestHistory({}, 'account-a')
  assert.deepEqual(historyA.digests, [{ localDate: '2026-10-29', itemCount: 2, generatedAt: generated.snapshot.generatedAt }])
  const dateA = await readHandlers.intelDigestByDate({ localDate: '2026-10-29', openid: 'account-a' }, 'account-a')
  assert.deepEqual(dateA, todayA)

  // A request body cannot substitute a different account's identity.
  const todayB = await readHandlers.intelDigestToday({ openid: 'account-a' }, 'account-b')
  assert.equal(todayB.digest, null)
  assert.deepEqual(await readHandlers.intelDigestHistory({}, 'account-b'), { digests: [], nextCursor: null })
  assert.equal((await service.getMine({ authenticatedOpenid: 'account-b' }, '2026-10-29')), null)

  // A closed and re-enabled digest gets a new generation; the prior snapshot is not visible.
  const prefA = db.rows('intel_preferences').find(row => row._id === 'account-a')
  db.put('intel_preferences', 'account-a', { ...prefA, dailyDigestEnabled: false, digestGeneration: 2 })
  assert.equal((await readHandlers.intelDigestToday({}, 'account-a')).digest, null)
  db.put('intel_preferences', 'account-a', { ...prefA, digestGeneration: 3 })
  assert.equal((await readHandlers.intelDigestToday({}, 'account-a')).digest, null)
  const regenerated = await service.generate({}, { authenticatedOpenid: 'account-a' })
  assert.equal(regenerated.created, true)
  assert.equal(regenerated.snapshot.digestGeneration, undefined)
  assert.deepEqual((await readHandlers.intelDigestToday({}, 'account-a')).digest.items.map(item => item.itemId), ['release-a', 'release-b'])

  // Service refuses generation before the user's configured local time.
  const earlyService = createDigestService({
    resolveIdentity: async ctx => ctx.authenticatedOpenid,
    readPreferences: async () => makePreference('account-a'),
    readItems: async () => { throw new Error('must not read before due time') },
    snapshotStore: store,
    now: () => Date.parse('2026-10-28T23:59:00.000Z')
  })
  await assert.rejects(earlyService.generate({}, { authenticatedOpenid: 'account-a' }), error => error.code === 'digest_not_due')

  // Storage/read failures remain visible; they are not misreported as empty data.
  db.failQuery('intel_digests', Object.assign(new Error('permission denied'), { errCode: -502005 }))
  await assert.rejects(readHandlers.intelDigestHistory({}, 'account-a'), error => error.errCode === -502005)
  db.failQuery('intel_digests', null)

  console.log('intel-digest-integration: all assertions passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
