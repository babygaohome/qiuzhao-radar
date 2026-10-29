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
  db.put('intel_preferences', 'account-a', makePreference('account-a', { topics: { ai: 0.35, jobs: 0.4 } }))
  db.put('intel_preferences', 'account-b', makePreference('account-b', { topics: { jobs: 0.4 } }))
  db.put('intel_items', 'release-a', makeItem('release-a'))
  db.put('intel_items', 'release-b', makeItem('release-b'))

  // Existing apps are the user's explicit job shortlist. The adapter keeps
  // the app ownership, visibility, role-audit, and deadline gates together.
  db.put('profiles', 'account-a', { hidden: ['hidden-a'] })
  db.put('profiles', 'account-b', { hidden: [] })
  for (const app of [
    { _id: 'app-a', openid: 'account-a', cid: 'verified-a', status: 'want' },
    { _id: 'app-hidden', openid: 'account-a', cid: 'hidden-a', status: 'want' },
    { _id: 'app-unverified', openid: 'account-a', cid: 'unverified-a', status: 'want' },
    { _id: 'app-expired', openid: 'account-a', cid: 'expired-a', status: 'want' },
    { _id: 'app-b', openid: 'account-b', cid: 'verified-b', status: 'want' }
  ]) db.put('apps', app._id, app)
  const verified = company => ({
    source: 'auto', company, deadline: '2026-10-31', url: 'https://jobs.example.org/apply',
    positions: ['软件工程师'], catalogAudit: {
      state: 'verified', coverageComplete: true, coverageFingerprint: 'sha256-fixture',
      proofMethod: 'browser_official'
    }
  })
  db.put('companies', 'verified-a', { _id: 'verified-a', ...verified('甲企业') })
  db.put('companies', 'verified-b', { _id: 'verified-b', ...verified('乙企业') })
  db.put('companies', 'hidden-a', { _id: 'hidden-a', ...verified('隐藏企业') })
  db.put('companies', 'unverified-a', { _id: 'unverified-a', ...verified('未核验企业'), catalogAudit: { state: 'pending' } })
  db.put('companies', 'expired-a', { _id: 'expired-a', ...verified('过期企业'), deadline: '2026-10-28' })
  db.put('companies', 'private-b', { _id: 'private-b', source: 'manual', owner: 'account-b', company: '乙私有企业', deadline: '2026-10-31', url: 'https://jobs.example.org/private', positions: ['工程师'], catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'private', proofMethod: 'browser_official' } })

  function readOwnedVerifiedJobs (openid, window, companyIds) {
    const profile = db.rows('profiles').find(row => row._id === openid) || {}
    const hidden = new Set(profile.hidden || [])
    const applications = db.rows('apps').filter(app => app.openid === openid && ['want', 'applied', 'test', 'interview', 'offer'].includes(app.status))
    const rows = []
    for (const app of applications) {
      if (companyIds && !companyIds.includes(app.cid)) continue
      if (hidden.has(app.cid)) continue
      const company = db.rows('companies').find(row => row._id === app.cid)
      if (!company || (company.source === 'manual' && company.owner !== openid)) continue
      const audit = company.catalogAudit || {}
      if (company.disputed === true || audit.state !== 'verified' || audit.coverageComplete !== true ||
        !audit.coverageFingerprint || !['browser_official', 'official_structured'].includes(audit.proofMethod)) continue
      if (company.manualReview && ['expired', 'unconfirmed'].includes(company.manualReview.status)) continue
      if (!/^\d{4}-\d{2}-\d{2}$/.test(company.deadline) || company.deadline <= window.start.slice(0, 10)) continue
      const title = Array.isArray(company.positions) ? company.positions.find(Boolean) : null
      if (!title) continue
      rows.push({ companyId: company._id, title, company: company.company,
        deadline: company.deadline, originalUrl: company.url, reason: '你标记的已核实岗位' })
      if (rows.length >= 4) break
    }
    return rows
  }

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
    readJobs: async (openid, window) => readOwnedVerifiedJobs(openid, window),
    snapshotStore: store,
    now: () => NOW
  })
  const readHandlers = createDigestHandlers({ db, now: () => NOW, loadJobItems: (openid, ids) => readOwnedVerifiedJobs(openid, { start: '2026-10-29T00:00:00.000Z' }, ids) })

  const generated = await service.generate({}, { authenticatedOpenid: 'account-a' })
  assert.equal(generated.created, true)
  assert.deepEqual(generated.snapshot.itemIds, ['release-a', 'release-b'])
  assert.equal(generated.snapshot.localDate, '2026-10-29')
  assert.equal(generated.snapshot.timezone, ZONE)
  assert.equal('openid' in generated.snapshot, false)
  assert.deepEqual(generated.snapshot.jobCompanyIds, ['verified-a'])

  const generatedB = await service.generate({}, { authenticatedOpenid: 'account-b' })
  assert.deepEqual(generatedB.snapshot.jobCompanyIds, ['verified-b'])

  const todayA = await readHandlers.intelDigestToday({}, 'account-a')
  assert.deepEqual(todayA.digest.items.map(item => item.itemId), generated.snapshot.itemIds)
  assert.deepEqual(todayA.digest.items.map(item => item.title), ['Release release-a', 'Release release-b'])
  assert.equal(todayA.digest.items[0].reason, '近期资讯')
  assert.deepEqual(todayA.digest.jobItems, [{
    companyId: 'verified-a',
    title: '软件工程师',
    company: '甲企业',
    deadline: '2026-10-31',
    originalUrl: 'https://jobs.example.org/apply',
    reason: '你标记的已核实岗位'
  }])
  assert.deepEqual(Object.keys(todayA.digest.jobItems[0]).sort(),
    ['companyId', 'title', 'company', 'deadline', 'originalUrl', 'reason'].sort())
  const historyA = await readHandlers.intelDigestHistory({}, 'account-a')
  assert.deepEqual(historyA.digests, [{ localDate: '2026-10-29', itemCount: 3, generatedAt: generated.snapshot.generatedAt }])
  const dateA = await readHandlers.intelDigestByDate({ localDate: '2026-10-29', openid: 'account-a' }, 'account-a')
  assert.deepEqual(dateA, todayA)

  // A request body cannot substitute a different account's identity.
  const todayB = await readHandlers.intelDigestToday({ openid: 'account-a' }, 'account-b')
  assert.deepEqual(todayB.digest.jobItems.map(item => item.companyId), ['verified-b'])
  assert.equal(todayB.digest.jobItems.some(item => item.companyId === 'verified-a'), false)
  assert.deepEqual((await readHandlers.intelDigestHistory({}, 'account-b')).digests.map(row => row.itemCount), [1])
  assert.equal((await service.getMine({ authenticatedOpenid: 'account-b' }, '2026-10-29')).itemIds.length, 0)

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
