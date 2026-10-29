'use strict'

const SNAPSHOT_ID = 'manualReview20261022'
const SOURCE_ALLOWLIST = new Set(['auto', 'curated'])
const STATUSES = new Set(['open', 'expired', 'unconfirmed'])
const DAY_RE = /^20\d\d-\d\d-\d\d$/
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/

function assert (condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'invalid_manual_review' })
}

function validDate (s) {
  return DAY_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s
}

function validatePlan (plan) {
  assert(plan && plan.snapshotId === SNAPSHOT_ID, '人工核查快照编号不匹配')
  assert(Array.isArray(plan.companies) && plan.companies.length === 12, '人工核查白名单数量不匹配')
  const byId = new Map()
  const names = new Set()
  for (const row of plan.companies) {
    assert(row && /^a[0-9a-f]{10,40}$/.test(row.id) && typeof row.company === 'string' && row.company.trim(), '公司白名单格式错误')
    assert(!byId.has(row.id) && !names.has(row.company), '公司白名单重复')
    byId.set(row.id, row.company)
    names.add(row.company)
  }
  assert(Array.isArray(plan.reviews), '人工核查结果格式错误')
  const seen = new Set()
  for (const review of plan.reviews) {
    assert(review && byId.get(review.id) === review.company, '人工核查结果不在公司白名单')
    assert(!seen.has(review.id), '同一家公司出现多个核查结果')
    seen.add(review.id)
    assert(SOURCE_ALLOWLIST.has(review.source), '只允许修正公开的自动收录或精选企业记录')
    assert(STATUSES.has(review.status), '人工核查状态无效')
    assert(typeof review.reason === 'string' && review.reason.trim().length > 0 && review.reason.length <= 500, '人工核查依据说明无效')
    assert(Array.isArray(review.evidenceUrls) && review.evidenceUrls.length <= 8, '官网证据链接数量无效')
    if (review.status !== 'unconfirmed') assert(review.evidenceUrls.length >= 1, '官网确认仍在招或已结束必须附真实官网证据')
    for (const value of review.evidenceUrls) {
      assert(typeof value === 'string' && value.length <= 2048, '官网证据链接格式错误')
      const u = new URL(value)
      assert(u.protocol === 'https:' && u.hostname && !u.username && !u.password, '官网证据必须是无凭据的 HTTPS 链接')
    }
    if (review.deadline !== undefined && review.deadline !== '') assert(validDate(review.deadline), '核查截止日期格式无效')
    if (review.checkedAt !== undefined) assert(typeof review.checkedAt === 'string' && ISO_RE.test(review.checkedAt) && !Number.isNaN(Date.parse(review.checkedAt)), '核查时间格式无效')
  }
  return byId
}

function sameReview (a, b) {
  return !!a && a.status === b.status && JSON.stringify(a.evidenceUrls) === JSON.stringify(b.evidenceUrls) &&
    a.reason === b.reason && (a.deadline || '') === (b.deadline || '')
}

function create ({ db, command = db.command, readDoc, plan }) {
  validatePlan(plan)
  const companyCol = db.collection('companies')
  const metaCol = db.collection('meta')

  async function findPublicCompany (id, company) {
    const doc = await readDoc('companies', id)
    if (!doc || doc._id !== id || doc.company !== company || !SOURCE_ALLOWLIST.has(doc.source) || doc.owner) return null
    return doc
  }

  async function snapshot () {
    const existing = await readDoc('meta', SNAPSHOT_ID)
    if (existing) return { mode: 'snapshot', saved: false, companyCount: (existing.beforeCompanies || []).length, hasAudit: !!existing.audit, missing: existing.missing || [] }
    const beforeCompanies = []
    const missing = []
    for (const item of plan.companies) {
      const doc = await findPublicCompany(item.id, item.company)
      if (!doc) { missing.push(item.id); continue }
      beforeCompanies.push(doc)
    }
    const audit = await readDoc('meta', 'audit')
    const data = { capturedAt: new Date().toISOString(), beforeCompanies, audit, missing }
    try {
      await metaCol.add({ data: Object.assign({ _id: SNAPSHOT_ID }, data) })
      return { mode: 'snapshot', saved: true, companyCount: beforeCompanies.length, hasAudit: !!audit, missing }
    } catch (e) {
      // A concurrent snapshot may win the unique _id. Re-read so a real DB error
      // still surfaces, and never replace its before image.
      const raced = await readDoc('meta', SNAPSHOT_ID)
      if (!raced) throw e
      return { mode: 'snapshot', saved: false, companyCount: (raced.beforeCompanies || []).length, hasAudit: !!raced.audit, missing: raced.missing || [] }
    }
  }

  async function apply () {
    assert(plan.reviews.length > 0, '研究证据尚未填写，不能应用空的人工核查计划')
    const snap = await readDoc('meta', SNAPSHOT_ID)
    assert(snap && Array.isArray(snap.beforeCompanies), '请先保存本次核查的原始快照')
    const beforeById = new Map(snap.beforeCompanies.map(c => [c._id, c]))
    const currentById = new Map()
    // Validate the complete batch before the first write.
    for (const review of plan.reviews) {
      const before = beforeById.get(review.id)
      assert(before && before.company === review.company && before.source === review.source && SOURCE_ALLOWLIST.has(before.source), '公司与原始快照不一致')
      const current = await findPublicCompany(review.id, review.company)
      assert(current && current.source === review.source, '公司记录已变化或不再属于公开来源')
      assert(!current.manualReview || sameReview(current.manualReview, review), '已有不同的人工核查结果，需要重新审查')
      currentById.set(review.id, current)
    }

    const applied = []
    const now = new Date().toISOString()
    for (const review of plan.reviews) {
      const current = currentById.get(review.id)
      const manualReview = current.manualReview && sameReview(current.manualReview, review)
        ? current.manualReview
        : {
            status: review.status,
            at: review.checkedAt || now,
            evidenceUrls: [...review.evidenceUrls],
            reason: review.reason.trim(),
            ...(review.deadline ? { deadline: review.deadline } : {})
          }
      if (!(current.manualReview && sameReview(current.manualReview, review))) {
        const result = await companyCol.where({ _id: review.id, company: review.company, source: review.source, owner: command.exists(false), manualReview: command.exists(false) }).update({ data: { manualReview: command.set(manualReview) } })
        assert(result && result.stats && result.stats.updated === 1, '公司记录在更新期间发生变化，已停止写入')
      }
      const after = await readDoc('companies', review.id)
      assert(after && after.company === review.company && after.source === review.source && sameReview(after.manualReview, review), '人工核查结果读回校验失败')
      applied.push({ id: review.id, company: review.company, source: review.source, manualReview: after.manualReview })
    }

    if (!snap.afterCompanies) await metaCol.doc(SNAPSHOT_ID).update({ data: { afterCompanies: applied, appliedAt: now, appliedStatus: 'complete' } })
    return { mode: 'apply', applied: applied.length, alreadyApplied: applied.filter(x => currentById.get(x.id).manualReview).length }
  }

  return { run: async ({ mode = 'snapshot' } = {}) => {
    assert(mode === 'snapshot' || mode === 'apply', '人工核查任务模式无效')
    return mode === 'apply' ? apply() : snapshot()
  } }
}

module.exports = { create, validatePlan, sameReview, SNAPSHOT_ID }
