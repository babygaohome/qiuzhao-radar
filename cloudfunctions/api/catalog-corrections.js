'use strict'

const crypto = require('node:crypto')
const { extractTitles } = require('./catalog-audit')
const { coverageFingerprint, titleKeys } = require('./audit-coverage')

const MAX_ITEMS = 5
const MAX_RUN_MS = 20000
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const normalizedTitle = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
const getData = result => result && (result.data || result)

function allowedEvidenceUrl (value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    if (host === 'sinopharm2027.iguopin.com') return url.pathname === '/job' || url.pathname.startsWith('/job/')
    if (host === 'www.iguopin.com') return url.pathname === '/job/detail' || url.pathname.startsWith('/job/detail/')
    if (host === 'career.cmbc.com.cn' && url.pathname === '/') {
      return /^#\/app\/recruitmentlist\/campus\/?$/.test(url.hash) ||
        /^#\/app\/recruitmentview\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/?$/i.test(url.hash)
    }
    return false
  } catch (_) { return false }
}

function cloneJobs (jobs) {
  if (!Array.isArray(jobs)) return []
  const seen = new Set()
  const out = []
  for (const job of jobs) {
    if (!job || typeof job.title !== 'string') continue
    const title = job.title.trim()
    const key = normalizedTitle(title)
    if (!title || !key || seen.has(key)) continue
    seen.add(key)
    out.push(Object.assign({}, clone(job), { title }))
  }
  return out
}

function create ({ db, command, readDoc, plan, now = () => new Date() }) {
  if (!db || !command || typeof readDoc !== 'function' || !plan || typeof plan.id !== 'string' || !Array.isArray(plan.items)) {
    throw new TypeError('catalog-corrections requires db, command, readDoc and a plan')
  }
  const companies = db.collection('companies')
  const meta = db.collection('meta')
  const asIso = value => new Date(value || now()).toISOString()
  const correctionId = item => `catalogCorrection_${hash(`${plan.id}:${item.id}`).slice(0, 32)}`
  const withinBudget = async (promise, deadline) => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('correction_budget_exhausted')
    let timer
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('correction_budget_exhausted')), remaining)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  const readCompany = async id => {
    const result = await companies.where({ _id: id }).limit(1).get()
    return result && Array.isArray(result.data) ? result.data[0] || null : null
  }

  function validResults (results, oldTitles, officialJobs, company) {
    if (!results || !Object.keys(results).length || !oldTitles.every(title => Object.prototype.hasOwnProperty.call(results, title))) return false
    return Object.entries(results).every(([title, result]) => {
      if (!result || result.exists !== true || result.cohort !== 'matched' || typeof result.open !== 'boolean' || result.officialSource !== 'confirmed') return false
      const matchedJob = officialJobs.some(job => normalizedTitle(job.title) === normalizedTitle(title) && job.company === company &&
        allowedEvidenceUrl(job.url) && typeof job.quote === 'string' && job.quote.trim())
      const resultHasEvidence = result.company === company && allowedEvidenceUrl(result.url || result.sourceUrl) &&
        typeof result.quote === 'string' && result.quote.trim()
      return matchedJob || resultHasEvidence
    })
  }

  function isVerified (results, oldTitles, officialJobs, company) {
    return validResults(results, oldTitles, officialJobs, company) && officialJobs.length > 0 && officialJobs.every(job =>
      job.exists === true && job.cohort === 'matched' && typeof job.open === 'boolean' && job.officialSource === 'confirmed')
  }

  function desiredValues (item, checkedAt, baseline) {
    const officialJobs = cloneJobs(item.officialJobs)
    const titles = officialJobs.map(job => job.title)
    const note = (`官网门户列出以下岗位，开放状态以逐岗证据为准：${titles.join('、')}`).slice(0, 1000)
    const oldTitles = extractTitles(baseline).map(row => row.title)
    const results = clone(item.results || {})
    const resultKeys = new Set(Object.keys(results).map(normalizedTitle))
    const state = isVerified(results, oldTitles, officialJobs, item.company) && titleKeys(baseline).every(key => resultKeys.has(key)) ? 'verified' : 'partial'
    return {
      officialJobs,
      values: {
        positions: titles,
        fullJobs: titles,
        note,
        catalogChangedAt: checkedAt.slice(0, 10),
        search: [baseline.company, baseline.industry, baseline.ctype, baseline.cities, baseline.batch, ...titles].filter(Boolean).join(' ').toLowerCase().slice(0, 12000),
        catalogAudit: {
          runId: plan.id,
          state,
          proofMethod: 'browser_official',
          coverageComplete: state === 'verified',
          coverageFingerprint: coverageFingerprint({ ...baseline, positions: titles, fullJobs: titles }),
          portalPaginationComplete: true,
          entity: clone(item.entity || {}),
          jobs: results,
          officialJobs,
          checkedAt,
          legacyRolesNotAllConfirmed: state !== 'verified'
        }
      }
    }
  }

  function stable (value) {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  function same (a, b) { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)) }

  async function run ({ maxItems = MAX_ITEMS } = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10) throw new RangeError('maxItems must be an integer from 1 to 10')
    const started = Date.now()
    const deadline = started + MAX_RUN_MS
    const checkedAt = asIso(plan.checkedAt)
    const applied = []
    const alreadyApplied = []
    const conflicts = []
    let writeTargets = 0

    for (const item of plan.items) {
      if (writeTargets >= maxItems || Date.now() - started >= MAX_RUN_MS) break
      const id = item && String(item.id || '')
      try {
        if (!id || !item || typeof item.company !== 'string' || !allowedEvidenceUrl(plan.sourceUrl)) {
          conflicts.push({ id, reason: 'invalid_plan_or_source' })
          continue
        }
        const current = await withinBudget(readCompany(id), deadline)
        if (!current) {
          conflicts.push({ id, reason: 'company_missing' })
          continue
        }
        if ((current._id !== undefined && current._id !== id) || current.company !== item.company || (item.source !== undefined && current.source !== item.source) ||
          !['auto', 'curated'].includes(current.source) || current.owner !== undefined) {
          conflicts.push({ id, reason: 'company_identity_or_visibility_changed' })
          continue
        }
        const backupId = correctionId(item)
        const isAlreadyTagged = current.catalogAudit && current.catalogAudit.runId === plan.id
        let baseline = current
        if (isAlreadyTagged) {
          const snapshot = getData(await withinBudget(readDoc('meta', backupId), deadline))
          if (!snapshot || snapshot.runId !== plan.id || snapshot.companyId !== id || !snapshot.before) {
            conflicts.push({ id, reason: 'applied_snapshot_missing' })
            continue
          }
          baseline = snapshot.before
          if (baseline.company !== item.company || baseline.source !== current.source || baseline.owner !== undefined ||
            hash(JSON.stringify(extractTitles(baseline))) !== item.expectedTitleHash) {
            conflicts.push({ id, reason: 'applied_snapshot_invalid' })
            continue
          }
        }
        const { officialJobs, values } = desiredValues(item, checkedAt, baseline)
        if (isAlreadyTagged) {
          if (same(current.positions, values.positions) && same(current.fullJobs, values.fullJobs) && current.note === values.note &&
            current.search === values.search && current.catalogChangedAt === values.catalogChangedAt && same(current.catalogAudit, values.catalogAudit)) alreadyApplied.push(id)
          else conflicts.push({ id, reason: 'applied_state_changed' })
          continue
        }

        const currentTitles = extractTitles(current)
        if (!/^[0-9a-f]{64}$/.test(item.expectedTitleHash || '') || hash(JSON.stringify(currentTitles)) !== item.expectedTitleHash) {
          conflicts.push({ id, reason: 'title_hash_changed' })
          continue
        }
        if (officialJobs.some(job => !allowedEvidenceUrl(job.url))) {
          conflicts.push({ id, reason: 'invalid_job_evidence_source' })
          continue
        }
        const rawJobs = Array.isArray(item.officialJobs) ? item.officialJobs : []
        if (officialJobs.length !== rawJobs.length || rawJobs.some(job => !job || job.company !== item.company || job.exists !== true ||
          job.cohort !== 'matched' || job.officialSource !== 'confirmed' ||
          (job.open !== 'unconfirmed' && typeof job.open !== 'boolean'))) {
          conflicts.push({ id, reason: 'invalid_job_evidence' })
          continue
        }

        writeTargets++
        const snapshot = { _id: backupId, runId: plan.id, companyId: id, company: item.company, createdAt: asIso(), before: clone(current) }
        try {
          await withinBudget(meta.add({ data: snapshot }), deadline)
        } catch (error) {
          const existing = getData(await withinBudget(readDoc('meta', backupId), deadline))
          if (!existing || existing.runId !== plan.id || existing.companyId !== id) throw error
        }

        const condition = {
          _id: id,
          company: item.company,
          source: current.source,
          owner: command.exists(false)
        }
        for (const field of ['positions', 'fullJobs', 'posBySrc', 'note', 'catalogAudit', 'updated', 'search']) {
          condition[field] = current[field] === undefined ? command.exists(false) : command.eq(current[field])
        }
        const updateData = {
          positions: command.set(values.positions),
          fullJobs: command.set(values.fullJobs),
          note: command.set(values.note),
          catalogChangedAt: command.set(values.catalogChangedAt),
          search: command.set(values.search),
          catalogAudit: command.set(values.catalogAudit)
        }
        const updated = await withinBudget(companies.where(condition).update({ data: updateData }), deadline)
        if (!updated || !updated.stats || updated.stats.updated !== 1) {
          conflicts.push({ id, reason: 'conditional_update_conflict' })
          continue
        }
        let saved
        try { saved = await withinBudget(readCompany(id), deadline) } catch (_) { throw new Error('readback_failed') }
        if (!saved) throw new Error('readback_missing')
        if (saved.catalogAudit && same(saved.catalogAudit, values.catalogAudit) && same(saved.positions, values.positions) &&
          same(saved.fullJobs, values.fullJobs) && saved.note === values.note && saved.search === values.search && saved.catalogChangedAt === values.catalogChangedAt) {
          applied.push(id)
        } else conflicts.push({ id, reason: 'readback_mismatch' })
      } catch (error) {
        conflicts.push({ id, reason: error && ['readback_missing', 'readback_failed'].includes(error.message) ? error.message : 'apply_failed',
          code: String(error && (error.code || error.errCode) || '').slice(0, 80), detail: String(error && (error.message || error.errMsg) || 'unknown').slice(0, 240) })
      }
    }
    const remaining = Math.max(0, plan.items.length - applied.length - alreadyApplied.length)
    return { runId: plan.id, applied, alreadyApplied, conflicts, remaining }
  }

  return { run }
}

module.exports = { create, allowedEvidenceUrl, cloneJobs }
