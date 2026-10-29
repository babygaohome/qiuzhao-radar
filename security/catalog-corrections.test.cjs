'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { create, allowedEvidenceUrl } = require('../cloudfunctions/api/catalog-corrections')
const { extractTitles } = require('../cloudfunctions/api/catalog-audit')

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex')

function harness ({ companies = [], failWrite = false, failReadback = false, mutateBeforeWrite } = {}) {
  const tables = { companies: new Map(companies.map(company => [company._id, clone(company)])), meta: new Map() }
  const sequence = []
  let writeOccurred = false
  const command = {
    exists: value => ({ op: 'exists', value }),
    eq: value => ({ op: 'eq', value }),
    set: value => ({ op: 'set', value })
  }
  const matches = (row, condition) => Object.entries(condition).every(([key, expected]) => {
    const actual = row[key]
    if (expected && expected.op === 'exists') return (actual !== undefined) === expected.value
    if (expected && expected.op === 'eq') return deepEqual(actual, expected.value)
    return actual === expected
  })
  const db = { collection (name) {
    return {
      async add ({ data }) {
        sequence.push(name === 'meta' ? 'backup' : 'add')
        if (tables[name].has(data._id)) throw Error('duplicate document id')
        tables[name].set(data._id, clone(data))
        return { _id: data._id }
      },
      where (condition) {
        return {
          limit () { return this },
          async get () {
            if (failReadback && writeOccurred && name === 'companies') throw Error('readback unavailable')
            const row = tables[name].get(condition._id)
            return { data: row ? [clone(row)] : [] }
          },
          async update ({ data }) {
            sequence.push('company-write')
            if (failWrite) throw Error('write failed')
            if (mutateBeforeWrite) mutateBeforeWrite(tables[name].get(condition._id))
            const row = tables[name].get(condition._id)
            if (!row || !matches(row, condition)) return { stats: { updated: 0 } }
            for (const [key, value] of Object.entries(data)) row[key] = clone(value && value.op === 'set' ? value.value : value)
            writeOccurred = true
            return { stats: { updated: 1 } }
          }
        }
      }
    }
  } }
  return {
    db, command, tables, sequence,
    async readDoc (name, id) {
      if (failReadback && writeOccurred && name === 'companies') throw Error('readback unavailable')
      return clone(tables[name] && tables[name].get(id) || null)
    }
  }
}

function company (id = 'c1', fields = {}) {
  return { _id: id, company: '示例制药集团', source: 'auto', positions: ['研发工程师', '工艺工程师'],
    fullJobs: [{ title: '研发工程师' }], posBySrc: { import: ['工艺工程师'] }, note: '旧岗位信息', deadline: '2027-01-01',
    url: 'https://example.invalid', v: 'official', privateMemo: 'keep', ...fields }
}

function makePlan (record, overrides = {}) {
  const officialJobs = overrides.officialJobs || [
    { title: '研发工程师', company: '示例制药集团', url: 'https://sinopharm2027.iguopin.com/job/123', quote: '2027届研发工程师', exists: true, cohort: 'matched', open: true, status: 'open', officialSource: 'confirmed', checkedAt: '2026-10-22T00:00:00.000Z' },
    { title: '工艺工程师', company: '示例制药集团', url: 'https://www.iguopin.com/job/detail/456', quote: '工艺工程师招聘', exists: true, cohort: 'matched', open: true, status: 'open', officialSource: 'confirmed', checkedAt: '2026-10-22T00:00:00.000Z' }
  ]
  const results = overrides.results || Object.fromEntries(['研发工程师', '工艺工程师'].map(title => [title, {
    exists: true, cohort: 'matched', open: true, officialSource: 'confirmed', quote: title
  }]))
  return {
    id: overrides.id || 'correction-plan-1', checkedAt: '2026-10-22T00:00:00.000Z',
    sourceUrl: 'https://sinopharm2027.iguopin.com/job',
    items: [{ id: record._id, company: record.company, source: record.source,
      expectedTitleHash: hash(JSON.stringify(extractTitles(record))), officialJobs, results,
      entity: { status: 'name_matched', quote: record.company }, ...overrides.item }]
  }
}

async function main () {
  assert.equal(allowedEvidenceUrl('https://career.cmbc.com.cn/#/app/recruitmentlist/campus'), true)
  assert.equal(allowedEvidenceUrl('https://career.cmbc.com.cn/#/app/recruitmentlist/campus/'), true)
  assert.equal(allowedEvidenceUrl('https://career.cmbc.com.cn/#/app/recruitmentview/123e4567-e89b-12d3-a456-426614174000'), true)
  assert.equal(allowedEvidenceUrl('https://career.cmbc.com.cn/#/app/recruitmentview/123E4567-E89B-12D3-A456-426614174000/'), true)
  for (const url of [
    'http://career.cmbc.com.cn/#/app/recruitmentlist/campus',
    'https://career.cmbc.com.cn/login#/app/recruitmentlist/campus',
    'https://career.cmbc.com.cn/#/app/recruitmentlist/social',
    'https://career.cmbc.com.cn/#/app/recruitmentview/not-a-uuid',
    'https://sub.career.cmbc.com.cn/#/app/recruitmentlist/campus',
    'https://career.cmbc.com.cn.evil.example/#/app/recruitmentlist/campus',
    'https://other.example/#/app/recruitmentlist/campus'
  ]) assert.equal(allowedEvidenceUrl(url), false, `unexpectedly allowed ${url}`)
  assert.equal(allowedEvidenceUrl('https://sinopharm2027.iguopin.com/job'), true, 'existing Sinopharm plan source remains supported')
  assert.equal(allowedEvidenceUrl('https://www.iguopin.com/job/detail?id=218163505562388010'), true, 'existing Sinopharm detail URL remains supported')

  const original = company()
  const h = harness({ companies: [original] })
  const plan = makePlan(original)
  const correction = create({ db: h.db, command: h.command, readDoc: h.readDoc, plan, now: () => '2026-10-22T01:00:00.000Z' })
  const result = await correction.run()
  assert.deepEqual(result.applied, ['c1'])
  assert.equal(result.remaining, 0)
  assert.ok(h.sequence.indexOf('backup') >= 0 && h.sequence.indexOf('backup') < h.sequence.indexOf('company-write'), 'snapshot must be stored before company update')
  const saved = h.tables.companies.get('c1')
  assert.deepEqual(saved.positions, ['研发工程师', '工艺工程师'])
  assert.deepEqual(saved.fullJobs, plan.items[0].officialJobs.map(j => j.title), 'legacy matching code consumes title strings; rich evidence remains in catalogAudit')
  assert.deepEqual(saved.catalogAudit.officialJobs, plan.items[0].officialJobs)
  assert.equal(saved.catalogAudit.state, 'verified')
  assert.equal(saved.catalogAudit.legacyRolesNotAllConfirmed, false)
  assert.equal(saved.deadline, original.deadline)
  assert.equal(saved.url, original.url)
  assert.equal(saved.v, original.v)
  assert.equal(saved.privateMemo, original.privateMemo)
  const backupId = [...h.tables.meta.keys()][0]
  assert.deepEqual(h.tables.meta.get(backupId).before, original)

  const cmbcRecord = company('cmbc')
  const cmbcPlan = makePlan(cmbcRecord, { id: 'cmbc-plan', item: {} })
  cmbcPlan.sourceUrl = 'https://career.cmbc.com.cn/#/app/recruitmentlist/campus'
  const detailIds = ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001']
  cmbcPlan.items[0].officialJobs.forEach((job, index) => {
    job.url = `https://career.cmbc.com.cn/#/app/recruitmentview/${detailIds[index]}`
  })
  for (const [title, result] of Object.entries(cmbcPlan.items[0].results)) {
    result.company = cmbcRecord.company
    result.url = cmbcPlan.items[0].officialJobs.find(job => job.title === title).url
    result.quote = `${title} 2027届`
  }
  const cmbcHarness = harness({ companies: [cmbcRecord] })
  const cmbcResult = await create({ db: cmbcHarness.db, command: cmbcHarness.command, readDoc: cmbcHarness.readDoc, plan: cmbcPlan }).run()
  assert.deepEqual(cmbcResult.applied, ['cmbc'], 'the scoped CMBC official list/detail route can apply a plan')
  assert.equal(cmbcHarness.tables.companies.get('cmbc').catalogAudit.state, 'verified')

  const repeated = await correction.run()
  assert.deepEqual(repeated.alreadyApplied, ['c1'])
  assert.equal(h.tables.meta.size, 1, 'idempotent rerun must not duplicate snapshots')

  const oneLegacy = company('oneLegacy', { positions: ['研发工程师'], fullJobs: [], posBySrc: {}, note: '只有一个旧岗位' })
  const oneLegacyJobs = [
    { title: '研发工程师', company: oneLegacy.company, url: 'https://sinopharm2027.iguopin.com/job/old', quote: '研发工程师2027届', exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' },
    { title: '临床运营专员', company: oneLegacy.company, url: 'https://www.iguopin.com/job/detail/new', quote: '临床运营专员招聘', exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' }
  ]
  const oneLegacyPlan = makePlan(oneLegacy, { id: 'one-legacy-plan', officialJobs: oneLegacyJobs, results: {
    '研发工程师': { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed', quote: '研发工程师2027届' }
  } })
  const oneLegacyHarness = harness({ companies: [oneLegacy] })
  const oneLegacyCorrection = create({ db: oneLegacyHarness.db, command: oneLegacyHarness.command, readDoc: oneLegacyHarness.readDoc, plan: oneLegacyPlan })
  assert.deepEqual((await oneLegacyCorrection.run()).applied, ['oneLegacy'])
  assert.equal(oneLegacyHarness.tables.companies.get('oneLegacy').catalogAudit.state, 'verified')
  assert.equal(oneLegacyHarness.tables.companies.get('oneLegacy').catalogAudit.legacyRolesNotAllConfirmed, false)
  const oneLegacyRerun = await oneLegacyCorrection.run()
  assert.deepEqual(oneLegacyRerun.alreadyApplied, ['oneLegacy'], 'rerun must use backed-up pre-correction titles even after adding a new official job')
  assert.equal(oneLegacyRerun.conflicts.length, 0)

  const uncertain = company('c2')
  const uncertainPlan = makePlan(uncertain, { id: 'partial-plan', officialJobs: [
    { title: '研发工程师', company: uncertain.company, url: 'https://sinopharm2027.iguopin.com/job/123', quote: '岗位存在', exists: true, cohort: 'matched', open: 'unconfirmed', officialSource: 'confirmed' }
  ] })
  const h2 = harness({ companies: [uncertain] })
  await create({ db: h2.db, command: h2.command, readDoc: h2.readDoc, plan: uncertainPlan }).run()
  assert.equal(h2.tables.companies.get('c2').catalogAudit.state, 'partial', 'an unconfirmed open state cannot become verified')

  const privateRecord = company('private', { owner: 'owner-1' })
  const privatePlan = makePlan(privateRecord)
  const h3 = harness({ companies: [privateRecord] })
  const privateResult = await create({ db: h3.db, command: h3.command, readDoc: h3.readDoc, plan: privatePlan }).run()
  assert.equal(privateResult.conflicts[0].reason, 'company_identity_or_visibility_changed')
  assert.equal(h3.tables.meta.size, 0, 'private record must not be snapshotted or changed')

  const changed = company('changed', { positions: ['新岗位'] })
  const changedPlan = makePlan(company('changed'))
  const h4 = harness({ companies: [changed] })
  const changedResult = await create({ db: h4.db, command: h4.command, readDoc: h4.readDoc, plan: changedPlan }).run()
  assert.equal(changedResult.conflicts[0].reason, 'title_hash_changed')
  assert.equal(h4.tables.meta.size, 0)

  const writeFailRecord = company('writeFail')
  const h5 = harness({ companies: [writeFailRecord], failWrite: true })
  const failedWrite = await create({ db: h5.db, command: h5.command, readDoc: h5.readDoc, plan: makePlan(writeFailRecord) }).run()
  assert.equal(failedWrite.applied.length, 0)
  assert.equal(failedWrite.conflicts.length, 1)
  assert.equal(failedWrite.remaining, 1)
  assert.equal(h5.tables.meta.size, 1, 'failed write retains the recovery snapshot')

  const readbackRecord = company('readbackFail')
  const h6 = harness({ companies: [readbackRecord], failReadback: true })
  const failedReadback = await create({ db: h6.db, command: h6.command, readDoc: h6.readDoc, plan: makePlan(readbackRecord) }).run()
  assert.equal(failedReadback.applied.length, 0)
  assert.equal(failedReadback.conflicts[0].reason, 'readback_failed')
  assert.equal(failedReadback.remaining, 1)

  const noOldJobs = company('noOldJobs', { positions: [], fullJobs: [], posBySrc: {}, note: '无明确岗位' })
  const noOpenJobs = [{ title: '研发工程师', company: noOldJobs.company, url: 'https://www.iguopin.com/job/detail/456', quote: '有职位但在招状态未确认', exists: true, cohort: 'matched', open: 'unconfirmed', officialSource: 'confirmed' }]
  const noOpenPlan = makePlan(noOldJobs, { id: 'no-open', officialJobs: noOpenJobs, results: { '未明岗位': { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' } } })
  const h7 = harness({ companies: [noOldJobs] })
  await create({ db: h7.db, command: h7.command, readDoc: h7.readDoc, plan: noOpenPlan }).run()
  assert.equal(h7.tables.companies.get('noOldJobs').catalogAudit.state, 'partial')

  const missingResultRecord = company('missingResult')
  const missingResultPlan = makePlan(missingResultRecord, { id: 'missing-role-result', results: {
    '研发工程师': { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' }
  } })
  const h8 = harness({ companies: [missingResultRecord] })
  await create({ db: h8.db, command: h8.command, readDoc: h8.readDoc, plan: missingResultPlan }).run()
  assert.equal(h8.tables.companies.get('missingResult').catalogAudit.state, 'partial', 'missing evidence for an old title prevents verified state')

  const unsupported = company('unsupported')
  const unsupportedJobs = [{ title: '全新岗位', company: unsupported.company, url: 'https://www.iguopin.com/job/detail/new', quote: '官网列出全新岗位', exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' }]
  const unsupportedPlan = makePlan(unsupported, { id: 'unsupported-proof', officialJobs: unsupportedJobs, results: {
    '研发工程师': { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed', quote: '伪造结果没有岗位链接' },
    '工艺工程师': { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed', quote: '伪造结果没有岗位链接' }
  } })
  const hUnsupported = harness({ companies: [unsupported] })
  await create({ db: hUnsupported.db, command: hUnsupported.command, readDoc: hUnsupported.readDoc, plan: unsupportedPlan }).run()
  assert.equal(hUnsupported.tables.companies.get('unsupported').catalogAudit.state, 'partial', 'true booleans without matching job evidence must not verify old roles')

  const racing = company('racing')
  const raceHarness = harness({ companies: [racing], mutateBeforeWrite: row => { row.positions = ['外部并发更新岗位'] } })
  const raceResult = await create({ db: raceHarness.db, command: raceHarness.command, readDoc: raceHarness.readDoc, plan: makePlan(racing) }).run()
  assert.equal(raceResult.conflicts[0].reason, 'conditional_update_conflict')
  assert.deepEqual(raceHarness.tables.companies.get('racing').positions, ['外部并发更新岗位'])
  assert.equal(raceHarness.tables.meta.size, 1, 'conditional conflict retains the pre-write snapshot')

  const updatedRace = company('updatedRace', { updated: 'old-timestamp' })
  const updatedRaceHarness = harness({ companies: [updatedRace], mutateBeforeWrite: row => { row.updated = 'new-timestamp' } })
  const updatedRaceResult = await create({ db: updatedRaceHarness.db, command: updatedRaceHarness.command, readDoc: updatedRaceHarness.readDoc, plan: makePlan(updatedRace) }).run()
  assert.equal(updatedRaceResult.conflicts[0].reason, 'conditional_update_conflict', 'updated timestamp participates in the CAS condition')

  const batchRecords = Array.from({ length: 7 }, (_, index) => company('batch' + index))
  const batchPlan = {
    id: 'batch-plan', checkedAt: '2026-10-22T00:00:00.000Z', sourceUrl: 'https://sinopharm2027.iguopin.com/job',
    items: batchRecords.map(record => makePlan(record, { id: 'batch-plan' }).items[0])
  }
  const batchHarness = harness({ companies: batchRecords })
  const batchCorrection = create({ db: batchHarness.db, command: batchHarness.command, readDoc: batchHarness.readDoc, plan: batchPlan })
  const batch1 = await batchCorrection.run()
  assert.equal(batch1.applied.length, 5)
  assert.equal(batch1.remaining, 2)
  const batch2 = await batchCorrection.run()
  assert.equal(batch2.applied.length, 2, 'rerun must skip applied records and continue to later items')
  assert.equal(batch2.alreadyApplied.length, 5)
  assert.equal(batch2.remaining, 0)

  await assert.rejects(create({ db: h.db, command: h.command, readDoc: h.readDoc, plan }).run({ maxItems: 11 }), /maxItems/)
  console.log('PASS correction snapshot ordering, conditional/idempotent application, visibility and title conflicts, conservative state and failure reporting')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
