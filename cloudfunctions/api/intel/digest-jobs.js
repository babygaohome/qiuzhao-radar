'use strict'

const ACTIVE_APPLICATION_STATES = Object.freeze(['want', 'applied', 'test', 'interview'])
const APPROVED_PROOF_METHODS = new Set(['browser_official', 'official_structured'])
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_APPS = 1000
const APP_PAGE = 100
const APP_PROBE = 1
const NO_DEADLINE_SENTINEL = '9999-12-31'
const MAX_RESULTS = 4
const WINDOW_MS = 24 * 60 * 60 * 1000

function fail (code) { return Object.assign(new Error(code), { code }) }
function isRecord (value) { return !!value && typeof value === 'object' && !Array.isArray(value) }

function validHttpsUrl (value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || url.hostname === 'localhost' ||
      url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':')) return null
    return url.toString()
  } catch (_) { return null }
}

function toEpoch (value) {
  if (typeof value !== 'string' || !value) return null
  const dateTime = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (dateTime) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = dateTime
    const year = Number(yearText), month = Number(monthText), day = Number(dayText)
    const calendarDate = new Date(Date.UTC(year, month - 1, day))
    if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day ||
        Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
        (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59))) return null
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return null
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  }
  return epoch
}


function beijingDateAt (epochMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(epochMs))
  const value = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function beijingDeadlineDate (value) {
  if (typeof value !== 'string' || !value || value === NO_DEADLINE_SENTINEL) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const epoch = toEpoch(value)
    return epoch === null ? null : value
  }
  const epoch = toEpoch(value)
  return epoch === null ? null : beijingDateAt(epoch)
}

function verifiedRoles (company) {
  if (!isRecord(company) || company.publicOnly || company.disputed === true ||
    (company.source === 'manual' && typeof company.owner !== 'string')) return []
  if (company.manualReview && ['expired', 'unconfirmed'].includes(company.manualReview.status)) return []
  const audit = company.catalogAudit
  if (!isRecord(audit) || audit.state !== 'verified' || audit.coverageComplete !== true ||
    typeof audit.coverageFingerprint !== 'string' || !audit.coverageFingerprint || !APPROVED_PROOF_METHODS.has(audit.proofMethod)) return []
  if (!isRecord(audit.jobs)) return []
  return Object.entries(audit.jobs).filter(([title, job]) => typeof title === 'string' && title.trim() && isRecord(job) &&
    job.exists === true && job.cohort === 'matched' && job.open === true && job.status === 'open' && job.officialSource === 'confirmed')
}

function createDigestJobsReader ({ db, command, buildWhere, readHidden, now = () => Date.now() } = {}) {
  if (!db || typeof db.collection !== 'function' || !command || typeof command.in !== 'function' || typeof command.and !== 'function' || typeof command.gt !== 'function') throw new TypeError('database_required')
  if (typeof buildWhere !== 'function' || typeof readHidden !== 'function') throw new TypeError('existing_visibility_filters_required')

  async function read (serverOpenid, window = null) {
    if (typeof serverOpenid !== 'string' || !serverOpenid.trim() || serverOpenid.length > 128) throw fail('unauthenticated')
    const checkedAt = now()
    if (!Number.isFinite(checkedAt)) throw fail('invalid_clock')
    let start = checkedAt - WINDOW_MS
    if (window !== null) {
      if (!window || typeof window !== 'object') throw fail('invalid_window')
      start = toEpoch(window.start)
      const windowEnd = toEpoch(window.end)
      if (start === null || windowEnd === null || windowEnd <= start || windowEnd > checkedAt) throw fail('invalid_window')
    }
    const eligibleAt = window === null ? checkedAt : toEpoch(window.end)
    const hidden = await readHidden(serverOpenid)
    if (!Array.isArray(hidden) || hidden.some(id => typeof id !== 'string')) throw fail('visibility_unavailable')
    // Inject the exact existing company-list filter; this preserves the product's
    // verifiedCond, aliveCond, owner and hidden-company rules without copying them.
    const visibility = buildWhere({ tab: 'all' }, serverOpenid, hidden)
    if (visibility === undefined || visibility === null) throw fail('visibility_unavailable')

    const appIds = new Set()
    let cursor = ''
    let fullWindow = true
    for (let page = 0; page < MAX_APPS / APP_PAGE; page++) {
      const query = { openid: serverOpenid, status: command.in(ACTIVE_APPLICATION_STATES) }
      if (cursor) query._id = command.gt(cursor)
      const result = await db.collection('apps').where(query)
        .field({ _id: true, cid: true, status: true })
        .orderBy('_id', 'asc').limit(APP_PAGE).get()
      if (!result || !Array.isArray(result.data)) throw fail('application_data_unavailable')
      const rows = result.data
      for (const row of rows) {
        if (!isRecord(row) || typeof row.cid !== 'string' || !APP_ID.test(row.cid) || !ACTIVE_APPLICATION_STATES.includes(row.status)) throw fail('application_data_invalid')
        appIds.add(row.cid)
      }
      if (rows.length < APP_PAGE) { fullWindow = false; break }
      const next = rows[rows.length - 1]._id
      if (typeof next !== 'string' || !next || next === cursor) throw fail('application_cursor_invalid')
      cursor = next
    }
    if (fullWindow) {
      const probeQuery = { openid: serverOpenid, status: command.in(ACTIVE_APPLICATION_STATES), _id: command.gt(cursor) }
      const probe = await db.collection('apps').where(probeQuery).field({ _id: true }).orderBy('_id', 'asc').limit(APP_PROBE).get()
      if (!probe || !Array.isArray(probe.data)) throw fail('application_data_unavailable')
      if (probe.data.length > 0) throw fail('application_window_overflow')
    }
    if (!appIds.size) return []

    const candidates = []
    const ids = [...appIds].sort()
    for (let offset = 0; offset < ids.length; offset += APP_PAGE) {
      const batch = ids.slice(offset, offset + APP_PAGE)
      const result = await db.collection('companies').where(command.and([
        { _id: command.in(batch) },
        visibility
      ])).field({
        _id: true, company: true, source: true, owner: true, publicOnly: true, disputed: true,
        manualReview: true, catalogAudit: true, deadline: true, dl: true, updated: true, addedAt: true
      }).limit(APP_PAGE).get()
      if (!result || !Array.isArray(result.data)) throw fail('company_data_unavailable')
      for (const company of result.data) {
        if (!isRecord(company) || !appIds.has(company._id)) continue
        const rawDeadline = typeof company.deadline === 'string' && company.deadline ? company.deadline : company.dl
        const deadlineValue = beijingDeadlineDate(rawDeadline)
        if (deadlineValue === null || deadlineValue < beijingDateAt(eligibleAt)) continue
        if (typeof company.company !== 'string' || !company.company.trim()) continue
        for (const [title, role] of verifiedRoles(company)) {
          const checkedAt = toEpoch(role.checkedAt)
          if (checkedAt === null || checkedAt < start || checkedAt > eligibleAt ||
              typeof role.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(role.checkedAt)) continue
          const originalUrl = validHttpsUrl(role.url)
          if (!originalUrl) continue
          candidates.push({
            companyId: company._id,
            title: title.trim().slice(0, 180),
            company: company.company.trim().slice(0, 180),
            deadline: deadlineValue,
            originalUrl,
            reason: '你标记的已核实岗位',
            checkedAt: new Date(checkedAt).toISOString()
          })
        }
      }
    }
    candidates.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt) || a.companyId.localeCompare(b.companyId) || a.title.localeCompare(b.title))
    const seen = new Set()
    return candidates.filter(candidate => {
      if (seen.has(candidate.companyId)) return false
      seen.add(candidate.companyId)
      return true
    }).slice(0, MAX_RESULTS).map(({ checkedAt, ...candidate }) => candidate)
  }

  return { read }
}

module.exports = { createDigestJobsReader, verifiedRoles, validHttpsUrl, toEpoch, beijingDateAt, beijingDeadlineDate, ACTIVE_APPLICATION_STATES, MAX_RESULTS, MAX_APPS, NO_DEADLINE_SENTINEL }
