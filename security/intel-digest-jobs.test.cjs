'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { createDigestJobsReader, verifiedRoles, toEpoch, beijingDateAt, beijingDeadlineDate, MAX_RESULTS, NO_DEADLINE_SENTINEL } = require('../cloudfunctions/api/intel/digest-jobs')

const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const role = (overrides = {}) => ({ checkedAt: '2026-10-29T08:00:00.000Z', exists: true, cohort: 'matched', open: true, status: 'open', officialSource: 'confirmed', url: 'https://jobs.example.org/apply', ...overrides })
const good = (id, overrides = {}) => ({
  _id: id, company: `Company ${id}`, source: 'auto', owner: undefined, publicOnly: false,
  disputed: false, manualReview: { status: 'verified' },
  catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'abc', proofMethod: 'official_structured', jobs: { Engineer: role() } },
  deadline: '2026-12-31', dl: '2026-12-31', updated: '2026-10-29T08:00:00.000Z', addedAt: '2026-10-01',
  note: 'PRIVATE NOTE SHOULD NEVER BE READ', ...overrides
})

function evaluator (filter, row) {
  if (!filter) return true
  if (filter.$and) return filter.$and.every(x => evaluator(x, row))
  if (filter.$in) return filter.$in.includes(row[filter.$field] || row._id)
  if (filter.$gt) return (row[filter.$field] || row._id) > filter.$gt
  if (filter.$eq) return row[filter.$field] === filter.$eq
  if (filter.$ne) return row[filter.$field] !== filter.$ne
  if (filter.$call) return filter.$call(row)
  return Object.entries(filter).every(([key, value]) => {
    if (value && value.$in) return value.$in.includes(row[key])
    if (value && value.$gt !== undefined) return row[key] > value.$gt
    return row[key] === value
  })
}
function makeDb (tables, failAt = null) {
  const accesses = []
  const command = {
    in: values => ({ $in: values }),
    gt: value => ({ $gt: value }),
    and: filters => ({ $and: filters }),
    neq: value => ({ $ne: value })
  }
  return {
    command,
    accesses,
    collection (name) {
      let filter = null
      let take = Infinity
      let orderKey = null
      const builder = {
        where (value) { filter = value; return builder },
        field (fields) {
          if (name === 'apps') {
            assert(['_id', 'cid', 'status'].join(',') === Object.keys(fields).sort().join(',') || Object.keys(fields).join(',') === '_id')
          }
          if (name === 'companies') {
            assert(!('note' in fields) && !('positions' in fields) && !('fullJobs' in fields))
          }
          return builder
        },
        orderBy (key) { orderKey = key; return builder },
        limit (n) { take = n; return builder },
        async get () {
          accesses.push(name)
          if (failAt === name) throw new Error(`${name}_read_failed`)
          let rows = (tables[name] || []).filter(row => evaluator(filter, row))
          if (orderKey) rows.sort((a, b) => String(a[orderKey] || '').localeCompare(String(b[orderKey] || '')))
          return { data: rows.slice(0, take) }
        }
      }
      return builder
    }
  }
}

async function run () {
  const apiReader = fs.readFileSync(path.join(__dirname, '../cloudfunctions/api/intel/digest-jobs.js'))
  const timerReader = fs.readFileSync(path.join(__dirname, '../cloudfunctions/intelDigest/digest-jobs.js'))
  assert.equal(crypto.createHash('sha256').update(apiReader).digest('hex'), crypto.createHash('sha256').update(timerReader).digest('hex'), 'standalone and API readers must stay identical')
  assert.equal(MAX_RESULTS, 4)
  assert.equal(toEpoch('2026-02-30'), null)
  assert.equal(toEpoch('2026-02-30T00:00:00.000Z'), null)
  assert.equal(toEpoch('2026-10-29T25:00:00Z'), null)
  assert.equal(toEpoch('2026-10-29T00:00:00+25:00'), null)
  assert.equal(toEpoch('2026-10-29T08:00:00.000Z'), Date.parse('2026-10-29T08:00:00.000Z'))
  assert.equal(beijingDateAt(Date.parse('2026-10-29T15:30:00Z')), '2026-10-29')
  assert.equal(beijingDeadlineDate('2026-10-29'), '2026-10-29')
  assert.equal(beijingDeadlineDate(NO_DEADLINE_SENTINEL), null)
  assert.equal(verifiedRoles(good('bad', { catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'x', proofMethod: 'official_structured', jobs: { Engineer: role({ cohort: 'unconfirmed' }) } } })).length, 0)

  const apps = [
    { _id: 'a1', openid: 'A', cid: 'verified', status: 'want', note: 'secret', referral: 'secret' },
    { _id: 'a1b', openid: 'A', cid: 'deadline-today', status: 'want' },
    { _id: 'a2', openid: 'A', cid: 'manual-other', status: 'applied' },
    { _id: 'a3', openid: 'A', cid: 'hidden', status: 'test' },
    { _id: 'a4', openid: 'A', cid: 'disputed', status: 'interview' },
    { _id: 'a5', openid: 'A', cid: 'unverified', status: 'want' },
    { _id: 'a6', openid: 'A', cid: 'stale', status: 'want' },
    { _id: 'b1', openid: 'B', cid: 'other-user', status: 'want' }
  ]
  const companies = [
    good('verified'),
    good('manual-other', { source: 'manual', owner: 'B' }),
    good('hidden'),
    good('disputed', { disputed: true }),
    good('unverified', { catalogAudit: { state: 'partial', coverageComplete: false, coverageFingerprint: '', proofMethod: 'official_structured', jobs: { Engineer: role() } } }),
    good('stale', { updated: '2026-10-20T08:00:00.000Z', catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'abc', proofMethod: 'official_structured', jobs: { Engineer: role({ checkedAt: '2026-10-20T08:00:00.000Z' }) } } }),
    good('deadline-today', { deadline: '2026-10-29', dl: '2026-10-29', updated: '2026-10-29T11:30:00.000Z' }),
    good('expired-deadline', { deadline: '2026-10-28', dl: '2026-10-28' }),
    good('unknown-deadline', { deadline: '', dl: '9999-12-31' }),
    good('bad-url', { catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'abc', proofMethod: 'official_structured', jobs: { Engineer: role({ url: 'http://jobs.example.org/apply' }) } } }),
    good('unconfirmed-source', { catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'abc', proofMethod: 'official_structured', jobs: { Engineer: role({ officialSource: 'unconfirmed' }) } } }),
    good('other-user')
  ]
  const db = makeDb({ apps, companies })
  const observed = []
  const reader = createDigestJobsReader({
    db, command: db.command, now: () => NOW,
    readHidden: async openid => { observed.push(['hidden', openid]); return openid === 'A' ? ['hidden'] : [] },
    buildWhere: (event, openid, hidden) => {
      observed.push(['visibility', event.tab, openid, hidden])
      return { $call: company => {
        const verified = company.catalogAudit && company.catalogAudit.state === 'verified' && company.catalogAudit.coverageComplete === true &&
          typeof company.catalogAudit.coverageFingerprint === 'string' && company.catalogAudit.coverageFingerprint &&
          ['browser_official', 'official_structured'].includes(company.catalogAudit.proofMethod) && company.disputed !== true
        const alive = company.dl >= '2026-10-29' && !(company.manualReview && ['expired', 'unconfirmed'].includes(company.manualReview.status))
        const ownerAllowed = company.source !== 'manual' || company.owner === openid
        return verified && alive && ownerAllowed && !company.publicOnly && !hidden.includes(company._id)
      } }
    }
  })
  const result = await reader.read('A')
  assert.deepEqual(result.map(x => x.companyId), ['deadline-today', 'verified'])
  assert.equal(result.find(x => x.companyId === 'verified').reason, '你标记的已核实岗位')
  assert.equal(observed[0][1], 'A')
  assert.deepEqual(observed[1], ['visibility', 'all', 'A', ['hidden']])
  assert.deepEqual(Object.keys(result[0]).sort(), ['company', 'companyId', 'deadline', 'originalUrl', 'reason', 'title'])
  assert.equal(JSON.stringify(result).includes('PRIVATE NOTE'), false)
  assert.equal('openid' in result[0], false)
  assert.equal('status' in result[0], false)
  assert.equal('education' in result[0], false)
  const bResult = await reader.read('B')
  assert.deepEqual(bResult.map(x => x.companyId), ['other-user'])
  assert.deepEqual(await reader.read('A', { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T12:00:00.000Z', openid: 'B' }), result, 'window options cannot override server identity')
  const windowReader = createDigestJobsReader({
    db: makeDb({ apps: [{ _id: 'm1', openid: 'A', cid: 'deadline-today', status: 'want' }], companies: [good('deadline-today', { deadline: '2026-10-29', updated: '2026-10-29T08:00:00.000Z' })] }),
    command: makeDb({}).command, buildWhere: () => ({}), readHidden: async () => [], now: () => NOW
  })
  assert.deepEqual(await windowReader.read('A', { start: '2026-10-28T00:00:00.000Z', end: '2026-10-28T08:00:00.000Z' }), [], 'jobs updated after the digest window are excluded even if the scheduler runs late')
  await assert.rejects(windowReader.read('A', { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T13:00:00.000Z' }), error => error.code === 'invalid_window')

  const oldCompanyNewRole = good('old-company-new-role', {
    updated: '2026-10-20T08:00:00.000Z',
    catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'fp', proofMethod: 'official_structured', jobs: { Engineer: role({ checkedAt: '2026-10-29T10:00:00.000Z' }) } }
  })
  const newCompanyOldRole = good('new-company-old-role', {
    updated: '2026-10-29T10:00:00.000Z',
    catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'fp', proofMethod: 'official_structured', jobs: { Engineer: role({ checkedAt: '2026-10-28T10:00:00.000Z' }) } }
  })
  const missingRoleTime = good('missing-role-time', {
    catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'fp', proofMethod: 'official_structured', jobs: { Engineer: role({ checkedAt: undefined }) } }
  })
  const roleWindow = createDigestJobsReader({
    db: makeDb({
      apps: ['old-company-new-role', 'new-company-old-role', 'missing-role-time'].map((cid, i) => ({ _id: `r${i}`, openid: 'A', cid, status: 'want' })),
      companies: [oldCompanyNewRole, newCompanyOldRole, missingRoleTime]
    }),
    command: makeDb({}).command,
    buildWhere: () => ({}),
    readHidden: async () => [],
    now: () => NOW
  })
  assert.deepEqual((await roleWindow.read('A')).map(x => x.companyId), ['old-company-new-role'], 'the per-role verification time, not a company update, controls freshness')

  const midnightCompany = good('midnight', { deadline: '2026-10-29', dl: '2026-10-29', updated: '2026-10-28T16:30:00.000Z', catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'abc', proofMethod: 'official_structured', jobs: { Engineer: role({ checkedAt: '2026-10-28T16:30:00.000Z' }) } } })
  const midnightReader = createDigestJobsReader({
    db: makeDb({ apps: [{ _id: 'm1', openid: 'A', cid: 'midnight', status: 'want' }], companies: [midnightCompany] }),
    command: makeDb({}).command,
    buildWhere: (event, openid, hidden) => ({ $call: row => row.dl >= beijingDateAt(Date.parse('2026-10-28T17:00:00.000Z')) && !hidden.includes(row._id) }),
    readHidden: async () => [], now: () => Date.parse('2026-10-28T17:00:00.000Z')
  })
  assert.deepEqual((await midnightReader.read('A')).map(row => row.companyId), ['midnight'], 'deadline date is valid for the full Beijing business day')

  await assert.rejects(reader.read(''), e => e.code === 'unauthenticated')
  const failed = createDigestJobsReader({ db: makeDb({}, 'apps'), command: makeDb({}).command, buildWhere: () => ({}), readHidden: async () => [], now: () => NOW })
  await assert.rejects(failed.read('A'), /apps_read_failed/)
  const hiddenFail = createDigestJobsReader({ db: makeDb({}), command: makeDb({}).command, buildWhere: () => ({}), readHidden: async () => { throw new Error('hidden_failed') }, now: () => NOW })
  await assert.rejects(hiddenFail.read('A'), /hidden_failed/)

  const exactlyMaxApps = Array.from({ length: 1000 }, (_, i) => ({ _id: String(i).padStart(4, '0'), openid: 'A', cid: 'job', status: 'want' }))
  const bounded = createDigestJobsReader({ db: makeDb({ apps: exactlyMaxApps, companies: [] }), command: makeDb({}).command, buildWhere: () => ({}), readHidden: async () => [], now: () => NOW })
  assert.deepEqual(await bounded.read('A'), [], 'exactly the app cap is complete when the one-row probe is empty')
  const overflow = createDigestJobsReader({ db: makeDb({ apps: [...exactlyMaxApps, { _id: 'zzzz', openid: 'A', cid: 'overflow', status: 'want' }] }), command: makeDb({}).command, buildWhere: () => ({}), readHidden: async () => [], now: () => NOW })
  await assert.rejects(overflow.read('A'), error => error.code === 'application_window_overflow')
}

run().then(() => console.log('intel-digest-jobs: all assertions passed'), error => { console.error(error); process.exitCode = 1 })
