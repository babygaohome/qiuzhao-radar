'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { analyzeCompany, MAX_ISSUES } = require('../cloudfunctions/api/catalog-quality')

test('checks only actual title fields and leaves the input arrays untouched', () => {
  const company = {
    _id: 'public-1', company: '示例企业', source: 'auto',
    positions: ['软件工程师…', '软件工程师…', '等3类岗位'],
    fullJobs: [{ title: '岗位信息待确认' }],
    posBySrc: { 官网: ['软件工程师…', '其他'] },
    publicJobs: [{ title: '详见官网招聘' }],
    discoveryEvidence: { jobs: [{ title: '未在海报中明确列出' }] },
    note: '备注里写着正常岗位信息，不作为岗位标题'
  }
  const before = JSON.stringify(company)
  const result = analyzeCompany(company)
  assert.equal(JSON.stringify(company), before)
  assert.equal(result.requiresReview, true)
  assert.equal(result.scope, 'field_quality_only')
  assert.deepEqual(result.titleIssues.map(x => x.reason), [
    'truncated_or_ellipsis', 'counted_roles_placeholder', 'role_information_pending_confirmation',
    'see_recruitment_or_website', 'generic_other', 'not_listed_in_poster'
  ])
  assert.equal(result.titleIssues.filter(x => x.title === '软件工程师…').length, 1, 'same title from multiple sources is reported once')
  assert.ok(!('note' in result))
})

test('does not flag concrete job titles that include recruitment-year wording', () => {
  const result = analyzeCompany({
    _id: 'public-2', company: '示例企业', source: 'curated',
    positions: ['算法工程师-2027校招', '销售助理（2027届）', '2027届产品经理岗位'],
    posBySrc: { 官网: ['算法工程师-2027校招'] },
    note: '2027届校园招聘公告'
  })
  assert.equal(result, null)
})

test('flags an overall campus recruitment announcement but not a concrete role headline', () => {
  const result = analyzeCompany({ _id: 'public-3', company: '示例企业', source: 'auto', positions: ['2027届校园招聘公告'] })
  assert.deepEqual(result.titleIssues, [{ title: '2027届校园招聘公告', reason: 'announcement_title_not_specific_role' }])
  assert.equal(analyzeCompany({ _id: 'public-4', company: '示例企业', source: 'auto', positions: ['算法工程师-2027校招'] }), null)
  assert.equal(analyzeCompany({ _id: 'public-5', company: '东莞银行', source: 'auto', positions: ['金融科技培训生-东莞银行2027届秋季校园招聘'] }), null)
  assert.equal(analyzeCompany({ _id: 'public-6', company: '海尔智家', source: 'auto', positions: ['海尔智家2027届全球校园招聘—硬件研发类'] }), null)
  assert.deepEqual(analyzeCompany({ _id: 'public-7', company: '现代汽车研发中心', source: 'auto', positions: ['现代汽车研发中心2027届校园招聘'] }).titleIssues[0].reason, 'announcement_title_not_specific_role')
})

test('does not infer a missing title from note and skips private or non-public records', () => {
  assert.equal(analyzeCompany({ _id: 'none', company: '示例企业', source: 'auto', positions: [], note: '岗位信息待确认' }), null)
  assert.equal(analyzeCompany({ _id: 'private', company: '示例企业', source: 'manual', owner: 'u1', positions: ['岗位信息待确认'] }), null)
  assert.equal(analyzeCompany({ _id: 'owned', company: '示例企业', source: 'auto', owner: 'u1', positions: ['其他'] }), null)
  assert.equal(analyzeCompany({ _id: 'owner-null', company: '示例企业', source: 'curated', owner: null, positions: ['其他'] }), null)
})

test('caps issue output and does not claim existence, freshness, or verification', () => {
  const result = analyzeCompany({ _id: 'many', company: '示例企业', source: 'auto', positions: Array.from({ length: 130 }, (_, i) => `岗位${i}…`) })
  assert.equal(result.titleIssues.length, MAX_ISSUES)
  assert.equal(result.requiresReview, true)
  assert.deepEqual(Object.keys(result).sort(), ['requiresReview', 'scope', 'titleIssues'])
  assert.ok(result.titleIssues.every(x => Object.keys(x).sort().join(',') === 'reason,title'))
  assert.ok(!JSON.stringify(result).match(/verified|checkedAt|open|exists|closed/i))
})
