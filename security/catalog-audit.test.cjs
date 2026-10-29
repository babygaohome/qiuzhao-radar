'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { create, extractTitles, extractSourceUrls, evaluate, RUN_ID, MANIFEST_ID } = require('../cloudfunctions/api/catalog-audit')

const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))
const op = (kind, value) => ({ __op: kind, value })
const command = new Proxy({}, { get: (_, k) => (...args) => op(k, args[0]) })
function matches (row, q) {
  return Object.entries(q || {}).every(([key, cond]) => {
    const val = key.split('.').reduce((v, k) => v && v[k], row)
    if (!cond || !cond.__op) return val === cond
    switch (cond.__op) {
      case 'eq': return JSON.stringify(val) === JSON.stringify(cond.value)
      case 'exists': return (val !== undefined) === cond.value
      case 'in': return cond.value.includes(val)
      case 'gt': return val > cond.value
      case 'lte': return val <= cond.value
      case 'lt': return val < cond.value
      default: return false
    }
  })
}
function dbHarness (companies = []) {
  const tables = { companies: new Map(companies.map(c => [c._id, clone(c)])), meta: new Map() }
  const collection = name => {
    const data = tables[name] || (tables[name] = new Map())
    const query = (condition = {}, cap = Infinity, order = null) => ({
      where: q => query(q, cap, order), limit: n => query(condition, n, order), orderBy: (field, dir) => query(condition, cap, [field, dir]),
      field: () => query(condition, cap, order),
      async get () { let rows = [...data.values()].filter(x => matches(x, condition)); if (order) rows.sort((a, b) => (a[order[0]] || '').localeCompare(b[order[0]] || '') * (order[1] === 'desc' ? -1 : 1)); return { data: rows.slice(0, cap).map(clone) } },
      async count () { return { total: [...data.values()].filter(x => matches(x, condition)).length } },
      async update ({ data: patch }) { const rows = [...data.values()].filter(x => matches(x, condition)); for (const row of rows) apply(row, patch); return { stats: { updated: rows.length } } },
      async remove () { const rows = [...data.values()].filter(x => matches(x, condition)); rows.forEach(x => data.delete(x._id)); return { stats: { removed: rows.length } } }
    })
    return Object.assign(query(), {
      doc (id) { return { async get () { if (!data.has(id)) throw Error('missing'); return { data: clone(data.get(id)) } }, async set ({ data: d }) { data.set(id, { ...clone(d), _id: id }); return {} }, async update ({ data: d }) { const row = data.get(id); if (!row) return { stats: { updated: 0 } }; apply(row, d); return { stats: { updated: 1 } } } } },
      async add ({ data: row }) { const id = row._id || `new${data.size}`; if (data.has(id)) throw Error('duplicate _id exists'); data.set(id, { ...clone(row), _id: id }); return { _id: id } }
    })
  }
  const db = { collection }
  return { db, tables, readDoc: async (name, id) => tables[name].has(id) ? clone(tables[name].get(id)) : null }
}
function apply (row, patch) { for (const [k, v] of Object.entries(patch)) row[k] = clone(v && v.__op === 'set' ? v.value : v) }
const job = (title, company, validThrough, description = '2027届校园招聘') => ({ '@type': 'JobPosting', title, hiringOrganization: { '@type': 'Organization', name: company }, validThrough, description })
const page = (...jobs) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': jobs })}</script>`

test('inventory snapshots all actual title sources, excludes private/non-public rows, and repeated start preserves work', async () => {
  const rows = [
    { _id: 'a', company: '企业甲', source: 'auto', owner: undefined, manualReview: { evidenceUrls: [] }, positions: ['工程师'], fullJobs: [{ title: '研究员' }], posBySrc: { 官网: ['工程师', '产品经理'] }, publicJobs: [{ title: '管培生' }], discoveryEvidence: { jobs: [{ title: '算法工程师' }] }, note: '绝不凭备注造岗' },
    { _id: 'b', company: '企业乙', source: 'curated', positions: [], note: '只在备注出现的职位' },
    { _id: 'c', company: '私有', source: 'manual', owner: 'x', positions: ['岗位'] },
    { _id: 'd', company: '用户行', source: 'auto', owner: 'x', positions: ['岗位'] }
  ]
  const h = dbHarness(rows)
  const audit = create({ ...h, command, fetchRaw: async () => '' })
  await audit.run('start'); await audit.run('start')
  assert.equal(h.tables.meta.size, 1, 'duplicate start must not replace manifest')
  await audit.inventory()
  const task = [...h.tables.meta.values()].find(x => x.kind === 'catalogAuditTask' && x.cid === 'a')
  assert.deepEqual(task.titles.map(x => x.title).sort(), ['算法工程师', '工程师', '管培生', '产品经理', '研究员'].sort())
  assert.equal(task.state, 'pending')
  assert.ok(![...h.tables.meta.values()].some(x => x.cid === 'c' || x.cid === 'd'))
  const missing = [...h.tables.meta.values()].find(x => x.cid === 'b')
  assert.equal(missing.state, 'missing_titles')
})

test('extractors do not use notes and drop known reseller links', () => {
  assert.deepEqual(extractTitles({ note: '岗位甲', positions: [] }), [])
  assert.deepEqual(extractTitles({ positions: ['岗甲'], fullJobs: [{ title: '岗乙' }] }).map(x => x.title).sort(), ['岗乙', '岗甲'])
  assert.deepEqual(extractSourceUrls({ url: 'https://jobs.51job.com/x', origUrl: 'https://example.com/careers', candidateUrl: 'https://www.jobui.com/company/x', publicSource: { url: 'https://jobs.example.edu.cn/x' } }), ['https://example.com/careers'])
})

test('inventory uses at most four concurrent durable inserts and retries a failed batch without skipping a company', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ _id: `c${String(i).padStart(2, '0')}`, company: `企业${i}`, source: 'auto', positions: ['工程师'] }))
  const h = dbHarness(rows)
  const collection = h.db.collection
  let active = 0; let peak = 0; let fail = true
  h.db.collection = name => {
    const col = collection(name); const add = col.add
    col.add = async input => {
      if (name !== 'meta' || input.data.kind !== 'catalogAuditTask') return add(input)
      active++; peak = Math.max(peak, active)
      try {
        await new Promise(resolve => setTimeout(resolve, 2))
        if (input.data.cid === 'c01' && fail) { fail = false; throw Error('transient insert failure') }
        return await add(input)
      } finally { active-- }
    }
    return col
  }
  const audit = create({ ...h, command, fetchRaw: async () => '' })
  await audit.start()
  await assert.rejects(audit.inventory(), /transient insert failure/)
  assert.equal(h.tables.meta.get(MANIFEST_ID).cursor, '')
  await audit.inventory()
  assert.equal(peak, 4)
  assert.equal([...h.tables.meta.values()].filter(x => x.kind === 'catalogAuditTask').length, 12)
  assert.equal(h.tables.meta.get(MANIFEST_ID).cursor, 'c11')
  assert.equal((await audit.status()).counts.verified, 0)
})

test('JSON-LD requires exact employer and exact role; tracks cohort and current open status separately', () => {
  const roles = [{ title: '算法工程师' }, { title: '产品经理' }, { title: '旧岗位' }]
  const result = evaluate(page(
    job('算法工程师', '示例科技有限公司', '2027-01-01', '面向2027届'),
    job('产品经理', '示例科技有限公司', '2025-01-01', '面向2026届'),
    job('旧岗位', '母集团有限公司', '2028-01-01', '2027届')
  ), { company: '示例科技有限公司', titles: roles, url: 'https://example.com/jobs', now: () => new Date('2026-10-22T00:00:00Z') })
  assert.equal(result.entity.status, 'name_matched')
  assert.equal(result.entity.registeredExists, 'unconfirmed')
  assert.equal(result.jobs['算法工程师'].exists, true)
  assert.equal(result.jobs['算法工程师'].cohort, 'matched')
  assert.equal(result.jobs['算法工程师'].open, true)
  assert.equal(result.jobs['产品经理'].exists, true)
  assert.equal(result.jobs['产品经理'].cohort, 'mismatch')
  assert.equal(result.jobs['产品经理'].open, false)
  assert.equal(result.jobs['旧岗位'].exists, 'unconfirmed', 'parent employer cannot confirm subsidiary role')
  assert.equal(evaluate('<html><div id="app"></div></html>', { company: '示例科技有限公司', titles: roles, url: 'https://example.com', now: () => new Date() }).jobs['算法工程师'].status, 'unconfirmed')
})

test('verify checks every title and writes an isolated catalogAudit field while preserving manual review', async () => {
  const company = { _id: 'c1', company: '示例科技有限公司', source: 'auto', positions: ['算法工程师', '产品经理'], url: 'https://example.com/careers', manualReview: { status: 'needs_review', note: 'keep this' }, v: 'original' }
  const h = dbHarness([company]); let fetched = 0
  const audit = create({ ...h, command, fetchRaw: async () => { fetched++; return page(job('算法工程师', company.company, '2028-01-01', '2027届'), job('产品经理', company.company, '2027-01-01', '2027届')) }, now: () => new Date('2026-10-22T00:00:00Z'), officialHosts: { '示例科技有限公司': 'example.com' } })
  await audit.start(); await audit.inventory(); await audit.inventory(); await audit.verify()
  const task = [...h.tables.meta.values()].find(x => x.kind === 'catalogAuditTask')
  assert.equal(task.state, 'verified'); assert.equal(Object.keys(task.results).length, 2); assert.equal(fetched, 1)
  const saved = h.tables.companies.get('c1')
  assert.deepEqual(saved.manualReview, company.manualReview); assert.equal(saved.v, 'original'); assert.equal(saved.positions.length, 2)
  assert.equal(saved.catalogAudit.runId, RUN_ID)
})

test('matching JSON-LD without an explicit official-host mapping is evidence, not verification', async () => {
  const company = { _id: 'u', company: '示例公司', source: 'auto', positions: ['岗位'], url: 'https://example.com/careers' }
  const h = dbHarness([company])
  const audit = create({ ...h, command, fetchRaw: async () => page(job('岗位', company.company, '2028-01-01', '2027届')) })
  await audit.start(); await audit.inventory(); await audit.inventory(); await audit.verify()
  const task = [...h.tables.meta.values()].find(x => x.kind === 'catalogAuditTask')
  assert.equal(task.results['岗位'].exists, true)
  assert.equal(task.results['岗位'].officialSource, 'unconfirmed')
  assert.equal(task.state, 'awaiting_official_domain')
  assert.notEqual(task.state, 'verified')
})

test('search quota remains unresolved and does not turn a search snippet into evidence', async () => {
  const h = dbHarness([{ _id: 'q', company: '无来源公司', source: 'curated', positions: ['研发'] }])
  const audit = create({ ...h, command, fetchRaw: async () => '', search: async () => { throw Error('no_search_quota') } })
  await audit.start(); await audit.inventory(); await audit.inventory(); await audit.verify()
  const task = [...h.tables.meta.values()].find(x => x.kind === 'catalogAuditTask')
  assert.equal(task.state, 'awaiting_search')
  assert.equal(task.results['研发'].exists, 'unconfirmed')
  assert.equal((await audit.status()).counts.awaiting_search, 1)
})

test('a known reposting site is filtered before fetching and cannot verify a role', async () => {
  const h = dbHarness([{ _id: 'r', company: '企业', source: 'auto', positions: ['岗位'], url: 'https://www.jobui.com/job/1' }])
  let fetches = 0
  const audit = create({ ...h, command, fetchRaw: async () => { fetches++; return page(job('岗位', '企业', '2028-01-01', '2027届')) } })
  await audit.start(); await audit.inventory(); await audit.inventory(); await audit.verify()
  const task = [...h.tables.meta.values()].find(x => x.kind === 'catalogAuditTask')
  assert.equal(fetches, 0)
  assert.notEqual(task.state, 'verified')
  assert.equal(task.results['岗位'].exists, 'unconfirmed')
})

test('active lock prevents concurrent inventory and initial pass never claims full completion with unresolved work', async () => {
  const h = dbHarness([{ _id: 'z', company: '企业', source: 'auto', positions: ['工程师'] }])
  h.tables.meta.set('catalogAuditLock20261022v1', { _id: 'catalogAuditLock20261022v1', token: 'other', until: Date.now() + 60000 })
  const audit = create({ ...h, command, fetchRaw: async () => '' })
  await audit.start()
  assert.equal((await audit.inventory()).busy, true)
  h.tables.meta.get('catalogAuditLock20261022v1').until = 0
  await audit.inventory(); await audit.inventory(); await audit.verify()
  const status = await audit.status()
  assert.notEqual(status.phase, 'complete')
  assert.equal(status.runId, RUN_ID); assert.equal(MANIFEST_ID, 'catalogAudit20261022v1')
})

test('inventory failure leaves cursor unchanged so the same page is retried safely', async () => {
  const h = dbHarness([{ _id: 'a', company: '企业甲', source: 'auto', positions: ['岗位'] }])
  const baseCollection = h.db.collection.bind(h.db)
  let failTask = true
  h.db.collection = name => {
    const col = baseCollection(name)
    if (name === 'meta') {
      const add = col.add.bind(col)
      col.add = async ({ data }) => {
        if (data.kind === 'catalogAuditTask' && failTask) { failTask = false; throw Error('simulated write failure') }
        return add({ data })
      }
    }
    return col
  }
  const audit = create({ ...h, command, fetchRaw: async () => '' })
  await audit.start()
  await assert.rejects(audit.inventory(), /simulated write failure/)
  assert.equal(h.tables.meta.get(MANIFEST_ID).cursor, '')
  await audit.inventory()
  assert.equal([...h.tables.meta.values()].filter(x => x.kind === 'catalogAuditTask').length, 1)
  assert.equal(h.tables.meta.get(MANIFEST_ID).cursor, 'a')
})

test('company catalog write failure stays write_pending and retries idempotently', async () => {
  const company = { _id: 'w', company: '公司', source: 'auto', positions: ['岗位'], url: 'https://example.com/jobs', manualReview: { status: 'keep' } }
  const h = dbHarness([company])
  const baseCollection = h.db.collection.bind(h.db)
  let fail = true
  h.db.collection = name => {
    const col = baseCollection(name)
    if (name === 'companies') {
      const where = col.where.bind(col)
      col.where = q => {
        const query = where(q)
        const update = query.update.bind(query)
        query.update = async args => { if (fail) { fail = false; throw Error('simulated company patch failure') }; return update(args) }
        return query
      }
    }
    return col
  }
  let fetches = 0
  const audit = create({ ...h, command, fetchRaw: async () => { fetches++; return page(job('岗位', company.company, '2028-01-01', '2027届')) }, officialHosts: { 公司: 'example.com' } })
  await audit.start(); await audit.inventory(); await audit.inventory()
  await assert.rejects(audit.verify(), /simulated company patch failure/)
  const task = [...h.tables.meta.values()].find(x => x.kind === 'catalogAuditTask')
  assert.equal(task.state, 'write_pending')
  await audit.verify()
  assert.equal(task.state, 'verified')
  assert.equal(fetches, 1, 'retry replays the durable patch without refetching')
  assert.deepEqual(h.tables.companies.get('w').manualReview, company.manualReview)
})

test('default verify call inventories a bounded page and verifies available companies before inventory completes', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ _id: String(i).padStart(4, '0'), company: `公司${i}`, source: 'auto', positions: ['岗位'], url: 'https://example.com/jobs' }))
  const h = dbHarness(rows)
  let fetches = 0
  const audit = create({ ...h, command, fetchRaw: async () => { fetches++; return '' } })
  await audit.start()
  const first = await audit.run('verify')
  assert.equal(first.inventoryComplete, false)
  assert.equal(first.processed, 5)
  assert.equal(fetches, 5, 'verification should start during inventory rather than waiting for the full scan')
  assert.equal(first.taskCount, 500)
  assert.equal(first.counts.verified, 0, 'an empty/unreadable page is never promoted to verified')
})

test('queue state cannot count as verified before its company patch is confirmed', async () => {
  const h = dbHarness([])
  const audit = create({ ...h, command, fetchRaw: async () => '' })
  await audit.start()
  h.tables.meta.set('fakeVerified', { _id: 'fakeVerified', kind: 'catalogAuditTask', runId: RUN_ID, state: 'verified', catalogApplied: false })
  const status = await audit.status()
  assert.equal(status.counts.verified, 0)
  assert.equal(status.allVerified, false)
  assert.equal(status.unresolvedCompanyCount, 1)
})

test('changed company titles remain a conflict instead of verifying an obsolete snapshot', async () => {
  const company = { _id: 'changed', company: '公司', source: 'auto', positions: ['岗位'], url: 'https://example.com/jobs' }
  const h = dbHarness([company])
  const audit = create({ ...h, command, fetchRaw: async () => page(job('岗位', '公司', '2028-01-01', '2027届')), officialHosts: { 公司: 'example.com' } })
  await audit.start(); await audit.inventory(); await audit.inventory()
  h.tables.companies.get('changed').positions.push('新岗位未查')
  await audit.verify()
  const task = [...h.tables.meta.values()].find(x => x.kind === 'catalogAuditTask')
  assert.equal(task.state, 'conflict')
  assert.equal((await audit.status()).counts.verified, 0)
  assert.equal(h.tables.companies.get('changed').catalogAudit, undefined)
})

test('browser job evidence survives background parsing and is published only after application', async () => {
  const review = { runId: 'review1', proofMethod: 'browser_official', state: 'verified', coverageComplete: true,
    jobs: { 岗位: { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' } },
    entity: { status: 'name_matched' }, officialJobs: [{ title: '岗位', url: 'https://example.com/jobs' }], checkedAt: '2026-10-22T10:00:00Z' }
  const company = { _id: 'reviewed', company: '公司', source: 'auto', positions: ['岗位'], url: 'https://example.com/jobs' }
  const h = dbHarness([company])
  const audit = create({ ...h, command, fetchRaw: async () => '' })
  await audit.start(); await audit.inventory(); await audit.inventory()
  await assert.rejects(audit.publishReview({ id: 'reviewed', company: '公司', source: 'auto', reviewRunId: 'review1' }), /review_not_applied/)
  h.tables.companies.get('reviewed').catalogAudit = clone(review)
  await audit.verify()
  assert.deepEqual(h.tables.companies.get('reviewed').catalogAudit, review)
  assert.equal((await audit.status()).counts.verified, 1)
  const published = await audit.publishReview({ id: 'reviewed', company: '公司', source: 'auto', reviewRunId: 'review1' })
  assert.equal(published.state, 'verified')
  assert.equal((await audit.status()).taskCount, 1)
  const originalCollection = h.db.collection
  h.db.collection = name => {
    const col = originalCollection(name)
    const originalWhere = col.where
    col.where = condition => {
      const q = originalWhere(condition)
      if (name === 'meta' && condition.cid === 'reviewed') q.update = async () => ({ stats: { updated: 0 } })
      return q
    }
    return col
  }
  const replay = create({ ...h, command, fetchRaw: async () => '' })
  assert.equal((await replay.publishReview({ id: 'reviewed', company: '公司', source: 'auto', reviewRunId: 'review1' })).state, 'verified', 'identical cloud replay may change zero documents')
  const storedTask = [...h.tables.meta.values()].find(x => x.cid === 'reviewed')
  storedTask.results = {}
  await assert.rejects(replay.publishReview({ id: 'reviewed', company: '公司', source: 'auto', reviewRunId: 'review1' }), /review_task_readback_failed/, 'zero changed rows with different evidence is not accepted')
})

test('a crawler title change between evidence read and write cannot publish a verified company', async () => {
  const company = { _id: 'racing', company: '并发企业', source: 'auto', positions: ['工程师'], url: 'https://example.com/jobs' }
  const h = dbHarness([company]); const collection = h.db.collection; let changed = false
  h.db.collection = name => {
    const col = collection(name); const where = col.where
    col.where = condition => {
      const query = where(condition); const update = query.update
      if (name === 'companies' && condition.positions) query.update = async input => {
        if (!changed) { changed = true; h.tables.companies.get('racing').positions.push('新增未核岗位') }
        return update(input)
      }
      return query
    }
    return col
  }
  const audit = create({ ...h, command, officialHosts: { 并发企业: 'example.com' },
    fetchRaw: async () => page(job('工程师', '并发企业', '2028-01-01', '2027届')) })
  await audit.start(); await audit.inventory()
  await assert.rejects(audit.verify(), /catalog_company_write_conflict/)
  assert.equal(h.tables.companies.get('racing').catalogAudit, undefined)
  assert.equal((await audit.status()).counts.verified, 0)
  await audit.verify()
  assert.equal((await audit.status()).counts.conflict, 1)
})
