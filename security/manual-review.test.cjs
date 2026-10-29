'use strict'

// Production API/module handlers run against the same in-memory CloudBase SDK pattern as isolation.test.cjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const project = path.resolve(__dirname, '..')
const isolationPath = path.join(__dirname, 'isolation.test.cjs')
const moduleUnderTest = require(path.join(project, 'cloudfunctions/api/manual-review.js'))
const planPath = path.join(project, 'cloudfunctions/api/manual-review-plan.json')
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

// Load only the reusable in-memory harness definitions, without running the unrelated suite.
const harnessSource = fs.readFileSync(isolationPath, 'utf8').split('let passed = 0')[0]
  .replace("getWXContext: () => ({ OPENID: identity })", "getWXContext: () => identity ? ({ OPENID: identity }) : ({})")
const scope = { require: name => name === '@cloudbase/node-sdk' ? { SYMBOL_CURRENT_ENV: 'test', init: () => ({ auth: () => ({ getUserInfo: () => null }) }) } : require(name), __dirname: path.dirname(isolationPath), console, Buffer, URL, setTimeout, clearTimeout }
vm.runInNewContext(harnessSource + '\nthis.makeHarness = harness', scope)

function put (h, id, doc) { h.table('companies').set(id, { _id: id, ...JSON.parse(JSON.stringify(doc)) }) }
function valueMatches (actual, q) {
  if (q && q.__op) {
    switch (q.__op) {
      case 'neq': return actual === undefined || actual === null ? true : actual !== q.value
      case 'in': return q.value.includes(actual)
      case 'nin': return !q.value.includes(actual)
      case 'gte': return actual >= q.value
      case 'lte': return actual <= q.value
      case 'exists': return (actual !== undefined) === q.value
      default: return false
    }
  }
  return actual === q
}
function matchesRow (row, condition) {
  if (condition && condition.__op === 'and') return condition.value.every(x => matchesRow(row, x))
  if (condition && condition.__op === 'or') return condition.value.some(x => matchesRow(row, x))
  return Object.entries(condition || {}).every(([key, value]) => valueMatches(key.split('.').reduce((x, p) => x == null ? undefined : x[p], row), value))
}

const evidence = ['https://careers.example.com/campus/2027']
const basePlan = () => ({ ...plan, companies: plan.companies.map(x => ({ ...x })), reviews: [] })

async function main () {
  const h = scope.makeHarness()
  const make = p => moduleUnderTest.create({ db: h.db, command: h.db.command, readDoc: async (col, id) => h.table(col).get(id) || null, today: () => '2026-10-22', plan: p })

  // The public mini-program caller cannot invoke the timer-only task.
  assert.equal((await h.call('A', 'manualReview', { Type: 'timer', Task: 'manualReview' })).error, 'unknown_action')
  assert.equal(h.table('meta').has(moduleUnderTest.SNAPSHOT_ID), false)

  // The privileged timer branch invokes the fixed plan, while user event fields cannot choose a target.
  const timerHarness = scope.makeHarness()
  const planReviewById = new Map(plan.reviews.map(r => [r.id, r]))
  for (const item of plan.companies) put(timerHarness, item.id, { company: item.company, source: (planReviewById.get(item.id) || {}).source || 'auto' })
  timerHarness.table('meta').set('audit', { _id: 'audit', items: [{ id: plan.companies[0].id, ok: false }] })
  timerHarness.call('', 'unused')
  const timerSnapshot = await timerHarness.box.exports.main({ Type: 'timer', Task: 'manualReview', Mode: 'snapshot', id: 'not-allowlisted' })
  assert.equal(timerSnapshot.saved, true)
  assert.equal(timerHarness.table('meta').has('timerSeen'), false, 'manual console task must not masquerade as a scheduled maintenance trigger')
  assert.equal(timerSnapshot.companyCount, plan.companies.length)
  const timerApply = await timerHarness.box.exports.main({ Type: 'timer', Task: 'manualReview', Mode: 'apply', reviews: [{ id: 'not-allowlisted', status: 'expired' }] })
  assert.equal(timerApply.applied, plan.reviews.length, 'timer apply must use the packaged plan rather than event reviews')
  assert.equal(timerHarness.table('companies').get('not-allowlisted'), undefined)
  for (const review of plan.reviews) assert.equal(timerHarness.table('companies').get(review.id).manualReview.status, review.status)

  const p = basePlan(); p.reviews = []
  const rows = p.companies.slice(0, 6)
  for (const row of rows) put(h, row.id, {
    company: row.company, source: 'auto', v: 'official', url: evidence[0], dl: '2026-12-31', deadline: '2026-12-31',
    positions: ['软件工程师'], note: '软件工程师', search: (row.company + ' 软件工程师').toLowerCase()
  })
  h.table('meta').set('audit', { _id: 'audit', day: '2026-10-22', items: [{ id: rows[0].id, company: rows[0].company, ok: false, why: '原文无法读取' }] })
  const service = make(p)
  const snapshot = await service.run()
  assert.equal(snapshot.saved, true)
  assert.equal(snapshot.companyCount, 6)
  const before = h.table('meta').get(moduleUnderTest.SNAPSHOT_ID)
  assert.equal(Object.hasOwn(before, '_id'), true)
  assert.equal(before.beforeCompanies.length, 6)
  assert.equal(before.audit.items[0].ok, false)
  put(h, rows[0].id, { ...h.table('companies').get(rows[0].id), changedAfterSnapshot: true })
  assert.equal((await service.run()).saved, false)
  assert.equal(h.table('meta').get(moduleUnderTest.SNAPSHOT_ID).beforeCompanies[0].changedAfterSnapshot, undefined)
  const brokenReader = moduleUnderTest.create({ db: h.db, readDoc: async (col, id) => { if (col === 'companies') throw new Error('database timeout'); return null }, plan: p })
  await assert.rejects(brokenReader.run(), /database timeout/)
  assert.equal(h.table('meta').has(moduleUnderTest.SNAPSHOT_ID), true, 'read failure must not be converted into a replacement empty snapshot')

  // Supplying patch data through an event is ignored; only the fixed review plan can be applied.
  await assert.rejects(service.run({ mode: 'apply', reviews: [{ id: rows[0].id, status: 'expired' }] }), /证据尚未填写/)
  assert.equal(h.table('companies').get(rows[0].id).manualReview, undefined)

  p.reviews = [
    { id: rows[0].id, company: rows[0].company, source: 'auto', status: 'open', evidenceUrls: evidence, reason: '企业官网列有2027校园招聘岗位' },
    { id: rows[1].id, company: rows[1].company, source: 'auto', status: 'unconfirmed', evidenceUrls: [], reason: '官网暂未找到对应招聘公告' },
    { id: rows[2].id, company: rows[2].company, source: 'auto', status: 'expired', evidenceUrls: evidence, reason: '官网页面明确显示本批招聘已结束' }
  ]
  const apply = make(p)
  const result = await apply.run({ mode: 'apply' })
  assert.equal(result.applied, 3)
  assert.equal(h.table('meta').get(moduleUnderTest.SNAPSHOT_ID).afterCompanies.length, 3)
  const open = h.table('companies').get(rows[0].id)
  const pending = h.table('companies').get(rows[1].id)
  const expired = h.table('companies').get(rows[2].id)
  assert.equal(open.v, 'official', 'manual review must preserve crawler/source trust fields')
  assert.equal(open.deadline, '2026-12-31', 'manual review must preserve the existing deadline')
  assert.equal(open.manualReview.status, 'open')
  assert.equal(pending.v, 'official', 'unconfirmed override must not mutate original source evidence')
  assert.equal(pending.manualReview.status, 'unconfirmed')
  assert.equal(expired.deadline, '2026-12-31', 'expired status must not fabricate or replace source deadlines')
  assert.equal(expired.manualReview.status, 'expired')
  assert.equal((await apply.run({ mode: 'apply' })).applied, 3, 'applying the same plan is idempotent')
  assert.equal(h.table('meta').get(moduleUnderTest.SNAPSHOT_ID).beforeCompanies[0].changedAfterSnapshot, undefined, 'rerun must preserve original before snapshot')

  // Reject malformed plan entries and a record whose company/source changed after snapshot.
  const bad = basePlan(); bad.reviews = [{ id: rows[3].id, company: rows[3].company, source: 'auto', status: 'open', evidenceUrls: ['http://example.com'], reason: 'bad protocol' }]
  assert.throws(() => make(bad), /HTTPS/)
  const mismatch = basePlan(); mismatch.reviews = [{ id: rows[3].id, company: 'Wrong company', source: 'auto', status: 'open', evidenceUrls: evidence, reason: 'mismatch' }]
  assert.throws(() => make(mismatch), /白名单/)
  const invalidStatus = basePlan(); invalidStatus.reviews = [{ id: rows[3].id, company: rows[3].company, source: 'auto', status: 'closed', evidenceUrls: evidence, reason: 'invalid state' }]
  assert.throws(() => make(invalidStatus), /状态无效/)
  const conflicting = basePlan(); conflicting.reviews = [{ id: rows[3].id, company: rows[3].company, source: 'curated', status: 'open', evidenceUrls: evidence, reason: 'wrong source' }]
  await assert.rejects(make(conflicting).run({ mode: 'apply' }), /快照不一致/)

  // A competing manual verdict inserted after preflight must fail the atomic absent-field condition.
  const raceHarness = scope.makeHarness()
  const raceRow = plan.companies[0]
  put(raceHarness, raceRow.id, { company: raceRow.company, source: 'auto', v: 'official', dl: '2026-12-31', deadline: '2026-12-31' })
  raceHarness.table('meta').set(moduleUnderTest.SNAPSHOT_ID, { _id: moduleUnderTest.SNAPSHOT_ID, beforeCompanies: [{ _id: raceRow.id, company: raceRow.company, source: 'auto' }] })
  const originalCollection = raceHarness.db.collection.bind(raceHarness.db)
  raceHarness.db.collection = name => {
    const col = originalCollection(name)
    if (name !== 'companies') return col
    const originalWhere = col.where.bind(col)
    col.where = condition => {
      const query = originalWhere(condition)
      const originalUpdate = query.update.bind(query)
      query.update = async args => {
        const doc = raceHarness.table('companies').get(raceRow.id)
        doc.manualReview = { status: 'unconfirmed', at: '2026-10-22T00:00:00.000Z', evidenceUrls: [], reason: '另一核查任务' }
        return originalUpdate(args)
      }
      return query
    }
    return col
  }
  const racePlan = basePlan()
  racePlan.reviews = [{ id: raceRow.id, company: raceRow.company, source: 'auto', status: 'open', evidenceUrls: evidence, reason: '官网招聘中' }]
  await assert.rejects(moduleUnderTest.create({ db: raceHarness.db, command: raceHarness.db.command, readDoc: async (col, id) => raceHarness.table(col).get(id) || null, plan: racePlan }).run({ mode: 'apply' }), /发生变化/)
  assert.equal(raceHarness.table('companies').get(raceRow.id).manualReview.status, 'unconfirmed', 'concurrent manual verdict must not be overwritten')

  // Exercise production verified/leads/list/ranking logic with open, unconfirmed, and expired overrides.
  assert.equal(matchesRow(open, h.box.exports._test.verifiedCond()), false, 'company-level open review cannot replace a complete per-role audit')
  assert.equal(matchesRow(pending, h.box.exports._test.verifiedCond()), false)
  assert.equal(matchesRow(open, h.box.exports._test.leadsCond()), true, 'company-level review remains in the lead/review queue')
  assert.equal(matchesRow(pending, h.box.exports._test.leadsCond()), true)
  assert.equal(matchesRow(expired, h.box.exports._test.aliveCond()), false)
  const verified = await h.call('A', 'list', { tab: 'verified' })
  const leads = await h.call('A', 'list', { tab: 'leads' })
  const closed = await h.call('A', 'list', { tab: 'leads', showClosed: true })
  assert(!verified.items.some(x => x._id === open._id || x._id === pending._id || x._id === expired._id))
  assert(leads.items.some(x => x._id === pending._id))
  assert(leads.items.some(x => x._id === open._id))
  assert(!leads.items.some(x => x._id === expired._id))
  assert(closed.items.some(x => x._id === expired._id), 'showClosed must retain reviewed expired companies')
  const pProfile = { role: '软件工程师', major: '', city: '', edu: '本科', industries: [], ctypes: [] }
  const ranked = h.box.exports._test.rankAll([open, pending, expired], pProfile, { keywords: [], industries: [] })
  assert(ranked.list.some(x => x.j._id === open._id), 'open company-level review remains rankable as an unverified lead')
  assert(!ranked.list.some(x => x.j._id === pending._id || x.j._id === expired._id))
  h.table('profiles').set('A', { _id: 'A', ai: { v: 2, at: '2026-10-22T01:00:00.000Z', batches: 1, summary: 'cached', ranked: [{ id: expired._id, ai: { score: 90 } }] } })
  assert.equal((await h.call('A', 'aiReview', { at: '2026-10-22T01:00:00.000Z', batch: 0 })).error, 'stale', 'a cached AI review must recheck the current expiry status')

  const util = require(path.join(project, 'miniprogram/utils/util.js'))
  assert.equal(util.countdown(expired).text, '官网复核已结束')
  assert.match(util.datesLine(expired), /官网人工复核：该招聘已结束/)
  assert.equal(util.badge(pending).text, '公司级复核待确认')
  assert.match(util.evidenceView(pending).level, /岗位待逐岗核验/)
  assert.equal(util.evidenceView(open).verified, false, 'company-level manual review must not be presented as role-level verification')
  assert.match(util.evidenceView(open).lines.map(x => x.k).join(' '), /公司级复核记录/)
  assert.equal(util.evidenceView(expired).verified, false)
  assert.match(util.evidenceView(expired).lines.find(x => x.k === '公司级复核记录').v, /曾标记结束/)
  const sourcePending = util.evidenceView({ ...pending, url: 'https://careers.example.com', origUrl: 'https://careers.example.com/notice', ncss: { n: 1, url: 'https://ncss.cn/job' }, verify: { url: 'https://gov.cn/notice', at: '2026-10-22' } })
  assert(sourcePending.lines.some(x => x.k === '招聘入口记录'), 'stored URL should retain its generic provenance label')
  assert(sourcePending.lines.some(x => x.k === '原文链接记录'))
  assert(sourcePending.lines.some(x => x.k === '就业平台来源记录'))
  assert(sourcePending.lines.some(x => x.k === '历史核查记录'))
  assert.equal(sourcePending.lines.some(x => x.k === '企业官网'), false, 'pending sources must not be mislabelled as confirmed employer sites')
  const openView = util.evidenceView(open)
  assert(openView.lines.some(x => x.k === '复核依据链接'))
  assert.equal(util.phase(open), 'open')
  console.log('PASS manual review snapshot, timer access, immutable before image, plan allowlist, idempotent patch, verified/leads/query, AI exclusion and card evidence')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
