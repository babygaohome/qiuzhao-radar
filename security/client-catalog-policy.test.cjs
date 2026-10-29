const assert = require('node:assert/strict')
const { badge, evidenceView, vExplain } = require('../miniprogram/utils/util.js')

const strict = {
  source: 'curated', v: 'official', hasOrig: true, instOk: true,
  catalogAudit: {
    state: 'verified', coverageComplete: true, coverageFingerprint: 'f'.repeat(64),
    proofMethod: 'browser_official', checkedAt: '2026-10-22T10:00:00.000Z',
    jobs: { '软件工程师': { exists: true, cohort: 'matched', open: true } }
  }
}

function assertPending (company, message) {
  const e = evidenceView(company)
  assert.equal(e.verified, false, message)
  assert.notEqual(badge(company).text, '逐岗已核实', message)
}

// A completed current catalog audit is the only public company-level signal
// that can tell the UI every catalog role has been checked.
{
  assert.equal(evidenceView(strict).verified, true)
  assert.equal(badge(strict).text, '逐岗已核实')
  assert.match(vExplain(strict), /1 个岗位均已按企业官方来源逐岗核验/)
}

// Old source classifications, links and previous verification claims remain
// visible as source information but cannot certify all current roles.
for (const company of [
  { source: 'curated', v: 'official' },
  { source: 'auto', v: 'official', url: 'https://company.example/jobs' },
  { source: 'auto', hasOrig: true, origUrl: 'https://company.example/post' },
  { source: 'auto', instOk: true, ncss: { n: 2 } },
  { source: 'auto', verify: { status: 'verified', at: '2026-10-21' } },
  { source: 'curated', catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f'.repeat(64), proofMethod: 'queued' } },
  { source: 'curated', catalogAudit: { state: 'verified', coverageComplete: false, coverageFingerprint: 'f'.repeat(64), proofMethod: 'browser_official' } },
  { source: 'curated', catalogAudit: { state: 'verified', coverageComplete: true, proofMethod: 'browser_official' } }
]) {
  assertPending(company, `legacy or incomplete evidence must remain pending: ${JSON.stringify(company)}`)
  assert.doesNotMatch(vExplain(company), /招聘信息属实|官网核查时在招|招聘已结束/)
}

// A company-wide manual review cannot promote its many stored roles.
{
  const open = { source: 'auto', manualReview: { status: 'open', reason: 'company record checked' } }
  assertPending(open)
  assert.equal(badge(open).text, '公司级复核记录')
  assert.match(evidenceView(open).lines.find(x => x.k === '公司级复核记录').v, /曾标记在招/)
  const expired = { source: 'auto', manualReview: { status: 'expired' } }
  assertPending(expired)
  assert.match(evidenceView(expired).lines.find(x => x.k === '公司级复核记录').v, /曾标记结束/)
}

// Own manual entries keep their private “self-added” label without being
// presented as an independent recruitment verification.
{
  const own = { source: 'manual' }
  assertPending(own)
  assert.equal(badge(own).text, '自己添加')
  assert.match(evidenceView(own).level, /自己添加/)
}

// A dispute vetoes an otherwise complete audit.
{
  const disputed = { ...strict, disputed: true }
  assertPending(disputed)
  assert.equal(badge(disputed).text, '复核中')
}

// Recorded links get an accurate pending explanation rather than a false
// statement that no original link exists.
{
  const e = evidenceView({ source: 'auto', url: 'https://company.example/jobs' })
  assert.match(e.summary, /招聘入口记录，尚未完成/)
  assert.doesNotMatch(e.summary, /还没拿到企业原文/)
}

console.log('client catalog policy tests passed (6 groups)')
