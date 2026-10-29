'use strict'

// Resumable, evidence-conservative public catalog audit. All persistence and network
// access are injected so this module can be exercised without cloud credentials.
const crypto = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { coverageFingerprint, titleKeys } = require('./audit-coverage')

const RUN_ID = 'catalog-audit-20261022-v1'
const MANIFEST_ID = 'catalogAudit20261022v1'
const LOCK_ID = 'catalogAuditLock20261022v1'
const TASK_PREFIX = 'catalogAuditTask_'
// Process larger pages per timer tick; the wall-clock guard below keeps reads
// and per-document writes within the maintenance function's execution budget.
const MAX_INVENTORY = 500
const INVENTORY_CONCURRENCY = 4
const MAX_INVENTORY_MS = 20000
const MAX_VERIFY = 5
const MAX_BODY = 1024 * 1024
const MAX_URLS = 2
const REPOST_HOST = /(^|\.)(51job|liepin|zhaopin|boss|zhipin|lagou|jobui|kanzhun|shixiseng|yingjiesheng|nowcoder|chinahr|job592|job001|job5156)\./i
const INSTITUTION_HOST = /(^|\.)(gov\.[a-z.]+|gov\.cn|edu\.[a-z.]+|edu\.cn|ncss\.cn|chsi\.com\.cn)$/i
const ms = x => new Date(x).getTime()
const hash = x => crypto.createHash('sha256').update(String(x)).digest('hex')
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x))

function normName (s) { return String(s || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }
function normTitle (s) { return String(s || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }

function extractTitles (company = {}) {
  const rows = new Map()
  const add = (value, source) => {
    const title = typeof value === 'string' ? value.trim() : value && typeof value.title === 'string' ? value.title.trim() : ''
    if (!title || title.length > 180) return
    const key = normTitle(title)
    if (!key) return
    const row = rows.get(key) || { title, sources: [] }
    if (source && !row.sources.includes(source)) row.sources.push(source)
    rows.set(key, row)
  }
  ;(Array.isArray(company.positions) ? company.positions : []).forEach(x => add(x, 'positions'))
  ;(Array.isArray(company.fullJobs) ? company.fullJobs : []).forEach(x => add(x, 'fullJobs'))
  for (const [source, jobs] of Object.entries(company.posBySrc || {})) if (Array.isArray(jobs)) jobs.forEach(x => add(x, source))
  ;(Array.isArray(company.publicJobs) ? company.publicJobs : []).forEach(x => add(x, 'publicJobs'))
  ;(company.discoveryEvidence && Array.isArray(company.discoveryEvidence.jobs) ? company.discoveryEvidence.jobs : []).forEach(x => add(x, 'discoveryEvidence.jobs'))
  return [...rows.values()].sort((a, b) => normTitle(a.title).localeCompare(normTitle(b.title)))
}

function extractSourceUrls (c = {}) {
  const candidates = [c.url, c.origUrl, c.candidateUrl,
    ...(Array.isArray(c.manualReview && c.manualReview.evidenceUrls) ? c.manualReview.evidenceUrls : []),
    c.publicSource && c.publicSource.url, c.ncss && c.ncss.url,
    typeof c.agg === 'string' ? c.agg : c.agg && (c.agg.url || c.agg.origUrl)]
  const out = []
  for (const raw of candidates) {
    try {
      const u = new URL(typeof raw === 'string' ? raw : raw && raw.url)
      if (u.protocol !== 'https:' || u.username || u.password || REPOST_HOST.test(u.hostname) || INSTITUTION_HOST.test(u.hostname)) continue
      const clean = u.href.slice(0, 1000)
      if (!out.includes(clean)) out.push(clean)
    } catch (_) {}
  }
  return out.slice(0, 12)
}

function parseJsonLd (html) {
  const out = []
  const visit = x => {
    if (!x) return
    if (Array.isArray(x)) return x.forEach(visit)
    if (typeof x !== 'object') return
    const types = Array.isArray(x['@type']) ? x['@type'] : [x['@type']]
    if (types.some(t => String(t).toLowerCase() === 'jobposting')) out.push(x)
    if (x['@graph']) visit(x['@graph'])
    for (const [k, v] of Object.entries(x)) if (k !== '@graph' && v && typeof v === 'object') visit(v)
  }
  for (const m of String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { visit(JSON.parse(m[1].trim())) } catch (_) {}
  }
  return out
}

function evaluate (html, { company, titles, url, now = () => new Date(), officialSource = 'unconfirmed', cohort = '2027' }) {
  const checkedAt = new Date(now()).toISOString()
  const body = String(html || '').slice(0, MAX_BODY)
  const postings = parseJsonLd(body)
  const companyName = normName(company)
  const entityRows = postings.filter(p => normName(p.hiringOrganization && p.hiringOrganization.name) === companyName)
  const entity = entityRows.length ? { status: 'name_matched', registeredExists: 'unconfirmed', officialSource, quote: entityRows[0].hiringOrganization.name, url, checkedAt } : null
  const jobs = {}
  for (const t of titles) {
    const matches = entityRows.filter(p => normTitle(p.title) === normTitle(t.title))
    if (!matches.length) {
      jobs[t.title] = { exists: 'unconfirmed', cohort: 'unconfirmed', open: 'unconfirmed', status: 'unconfirmed', quote: '', url, checkedAt, reason: postings.length ? 'no_exact_employer_and_title_match' : 'no_jobposting_jsonld' }
      continue
    }
    const p = matches[0]
    const desc = typeof p.description === 'string' ? p.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    const quote = (p.title + (desc ? ': ' + desc.slice(0, 240) : '')).slice(0, 360)
    const cohortEvidence = `${p.title || ''} ${desc}`
    const year = String(cohort)
    const yearShort = year.slice(-2)
    const previous = String(Number(year) - 1)
    const cohortMatch = new RegExp(`${year}届|${year}年校招|${yearShort}届|${year}校园招聘`)
    const cohortMismatch = new RegExp(`${previous}届|${previous}年校招|${previous.slice(-2)}届`)
    const cohortStatus = cohortMatch.test(cohortEvidence) ? 'matched' : cohortMismatch.test(cohortEvidence) ? 'mismatch' : 'unconfirmed'
    let open = 'unconfirmed'
    let status = 'exists_unconfirmed_open'
    const valid = p.validThrough ? Date.parse(p.validThrough) : NaN
    if (Number.isFinite(valid)) {
      if (valid < ms(checkedAt)) { open = false; status = 'closed' } else { open = true; status = 'open' }
    }
    jobs[t.title] = { exists: true, cohort: cohortStatus, open, status, officialSource, quote, url: typeof p.url === 'string' ? p.url : url, checkedAt, reason: cohortStatus === 'mismatch' ? 'job_exists_wrong_cohort' : cohortStatus === 'matched' ? 'exact_jsonld_jobposting' : 'cohort_not_stated' }
  }
  return { entity: entity || { status: 'unconfirmed', registeredExists: 'unconfirmed', quote: '', url, checkedAt }, jobs }
}

function getData (r) { return r && (r.data || r) }
function isDup (e) { return /duplicate|already exists|_id.*exist|document.*exist/i.test(String(e && (e.message || e.errMsg) || e)) }
function titleState (results) {
  const vals = Object.values(results || {})
  if (!vals.length) return 'missing_titles'
  if (vals.every(x => (x.status === 'open' || x.status === 'closed') && x.cohort === 'matched' && x.officialSource === 'confirmed')) return 'verified'
  if (vals.some(x => x.exists === true && x.officialSource !== 'confirmed')) return 'awaiting_official_domain'
  if (vals.some(x => x.exists === true)) return 'partial'
  return 'unconfirmed'
}

function create ({ db, command, readDoc, fetchRaw, search, now = () => new Date(), cohort = '2027', officialHosts = {} }) {
  if (!db || !command || typeof readDoc !== 'function' || typeof fetchRaw !== 'function') throw new Error('catalog audit dependencies required')
  const meta = db.collection('meta')
  const companies = db.collection('companies')
  const clock = () => new Date(now()).getTime()
  const within = async (promise, deadline) => {
    const left = deadline - Date.now()
    if (left <= 0) throw Error('audit_budget_exhausted')
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('audit_budget_exhausted')), left) })]) } finally { if (timer) clearTimeout(timer) }
  }
  const readMeta = async id => getData(await readDoc('meta', id))
  const readCompany = async id => (await companies.where({ _id: id }).limit(1).get()).data[0] || null
  const updateManifest = async patch => meta.doc(MANIFEST_ID).update({ data: Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, command.set(v)])) })
  const boundedFetch = async (url, deadline) => {
    return within(fetchRaw(url), deadline)
  }
  const boundedSearch = async (query, deadline) => {
    return within(search(query), deadline)
  }
  const officialSourceFor = (company, url) => {
    const configured = officialHosts[normName(company)] || officialHosts[company] || []
    const hosts = (Array.isArray(configured) ? configured : [configured]).map(x => {
      try { return new URL(String(x).includes('://') ? x : `https://${x}`).hostname.toLowerCase() } catch (_) { return '' }
    }).filter(Boolean)
    try {
      const host = new URL(url).hostname.toLowerCase()
      return hosts.some(h => host === h || host.endsWith(`.${h}`)) ? 'confirmed' : 'unconfirmed'
    } catch (_) { return 'unconfirmed' }
  }

  async function acquire () {
    const token = crypto.randomBytes(16).toString('hex')
    const until = clock() + 60000
    try { await meta.add({ data: { _id: LOCK_ID, token, until } }); return token } catch (e) { if (!isDup(e)) throw e }
    const lock = await readMeta(LOCK_ID)
    if (!lock || Number(lock.until) > clock()) return null
    const r = await meta.where({ _id: LOCK_ID, token: lock.token, until: command.lte(clock()) }).update({ data: { token: command.set(token), until: command.set(until) } })
    return r && r.stats && r.stats.updated ? token : null
  }
  async function release (token) { await meta.where({ _id: LOCK_ID, token }).remove().catch(() => {}) }

  async function start () {
    try { await meta.add({ data: { _id: MANIFEST_ID, runId: RUN_ID, phase: 'inventory', inventoryComplete: false, cursor: '', counters: {}, createdAt: new Date(clock()).toISOString(), updatedAt: new Date(clock()).toISOString() } }) } catch (e) { if (!isDup(e)) throw e }
    return status()
  }

  async function status () {
    const manifest = await readMeta(MANIFEST_ID)
    if (!manifest) return { runId: RUN_ID, phase: 'not_started', counts: {}, elapsedMs: 0 }
    const states = ['pending', 'write_pending', 'verified', 'partial', 'unconfirmed', 'awaiting_search', 'awaiting_official_domain', 'needs_browser', 'missing_titles', 'conflict']
    const counts = {}
    for (const state of states) {
      const condition = { runId: RUN_ID, kind: 'catalogAuditTask', state }
      if (state === 'verified') condition.catalogApplied = true
      const r = await meta.where(condition).count()
      counts[state] = r.total || 0
    }
    const allTasks = await meta.where({ runId: RUN_ID, kind: 'catalogAuditTask' }).count()
    const taskCount = allTasks.total || 0
    const allVerified = manifest.inventoryComplete === true && taskCount > 0 && counts.verified === taskCount
    return { runId: RUN_ID, phase: manifest.phase, inventoryComplete: manifest.inventoryComplete === true,
      taskCount, counts, allVerified, unresolvedCompanyCount: taskCount - counts.verified,
      elapsedMs: Math.max(0, clock() - ms(manifest.createdAt || clock())) }
  }

  async function inventory ({ budgetMs = MAX_INVENTORY_MS, includeStatus = true } = {}) {
    const token = await acquire()
    if (!token) return { busy: true, ...(await status()) }
    try {
      const manifest = await readMeta(MANIFEST_ID)
      if (!manifest) return { error: 'not_started' }
      if (manifest.inventoryComplete) return includeStatus ? status() : { inventoryComplete: true, added: 0, repeated: 0, skipped: 0 }
      const started = Date.now()
      const budgetDeadline = started + Math.max(1000, Math.min(MAX_INVENTORY_MS, Number(budgetMs) || MAX_INVENTORY_MS))
      const where = { source: command.in(['auto', 'curated']), owner: command.exists(false) }
      if (manifest.cursor) where._id = command.gt(manifest.cursor)
      const got = await companies.where(where).field({ _id: true, company: true, source: true, url: true, origUrl: true, candidateUrl: true, manualReview: true, publicSource: true, ncss: true, agg: true, positions: true, fullJobs: true, posBySrc: true, publicJobs: true, discoveryEvidence: true }).orderBy('_id', 'asc').limit(MAX_INVENTORY).get()
      const rows = got.data || []
      if (!rows.length) {
        await updateManifest({ inventoryComplete: true, phase: 'verifying', updatedAt: new Date(clock()).toISOString() })
        return includeStatus ? status() : { inventoryComplete: true, added: 0, repeated: 0, skipped: 0 }
      }
      let inserted = 0; let repeated = 0; let skipped = 0
      let last = manifest.cursor || ''
      for (let offset = 0; offset < rows.length; offset += INVENTORY_CONCURRENCY) {
        if (Date.now() >= budgetDeadline) break
        const batch = rows.slice(offset, offset + INVENTORY_CONCURRENCY)
        const outcomes = await Promise.allSettled(batch.map(async c => {
        if (!['auto', 'curated'].includes(c.source) || c.owner !== undefined) { skipped++; return }
        const titles = extractTitles(c)
        const urls = extractSourceUrls(c)
        const fingerprint = hash(JSON.stringify({ id: c._id, company: c.company, source: c.source, titles }))
        const _id = TASK_PREFIX + hash(c._id).slice(0, 40)
        const task = { _id, kind: 'catalogAuditTask', runId: RUN_ID, cid: c._id, company: c.company || '', source: c.source, sourceUrls: urls, titles, fingerprint, state: titles.length ? 'pending' : 'missing_titles', results: {}, entity: { status: 'unconfirmed', registeredExists: 'unconfirmed' }, attempts: 0, retryAt: 0, createdAt: new Date(clock()).toISOString() }
        if (Buffer.byteLength(JSON.stringify(task)) > MAX_BODY) { task.titles = []; task.state = 'missing_titles'; task.reason = 'snapshot_overflow' }
        try { await meta.add({ data: task }); inserted++ } catch (e) {
          if (!isDup(e)) throw e
          const old = await readMeta(_id)
          if (old && old.runId === RUN_ID && old.cid === c._id && old.fingerprint === fingerprint) repeated++
          else { skipped++; }
        }
        }))
        // Advance only after the whole contiguous batch is durable. A failed
        // member leaves the persisted cursor unchanged; successful inserts are
        // safely recognized as duplicates on the next attempt.
        const failed = outcomes.find(x => x.status === 'rejected')
        if (failed) throw failed.reason
        last = batch[batch.length - 1]._id
      }
      const taskCount = await meta.where({ runId: RUN_ID, kind: 'catalogAuditTask' }).count()
      const counters = Object.assign({}, manifest.counters || {}, { inventoryTasks: taskCount.total || 0 })
      await updateManifest({ cursor: last, counters, phase: 'inventory', updatedAt: new Date(clock()).toISOString() })
      const progress = { inventoryComplete: false, cursor: last, added: inserted, repeated, skipped }
      return includeStatus ? { ...(await status()), ...progress } : progress
    } finally { await release(token) }
  }

  async function verify ({ budgetMs = 35000 } = {}) {
    const started = Date.now()
    const deadline = started + Math.max(1000, Math.min(35000, Number(budgetMs) || 35000))
    let token
    try {
      token = await within(acquire(), deadline)
      if (!token) return { busy: true, ...(await within(status(), deadline)) }
      const manifest = await within(readMeta(MANIFEST_ID), deadline)
      if (!manifest) return { error: 'not_started' }
      // Inventory and verification are independent resumable work. Verify the
      // first available tasks while later companies are still being inventoried.
      const tasks = await within(meta.where({ runId: RUN_ID, kind: 'catalogAuditTask', state: command.in(['pending', 'partial', 'unconfirmed', 'awaiting_search', 'awaiting_official_domain', 'needs_browser', 'write_pending']), retryAt: command.lte(clock()) }).orderBy('_id', 'asc').limit(MAX_VERIFY).get(), deadline)
      let processed = 0
      const flushTask = async task => {
        // A later browser review has stronger, job-specific evidence. Background
        // parsers must not replace it with an unsupported/empty-page result.
        const current = await within(readCompany(task.cid), deadline)
        if (!current || current.company !== task.company || current.source !== task.source || current.owner !== undefined) {
          await within(meta.doc(task._id).update({ data: { state: command.set('conflict'), catalogApplied: command.set(false), reason: command.set('company_identity_changed') } }), deadline)
          task.state = 'conflict'
          return
        }
        if (current.catalogAudit && current.catalogAudit.proofMethod === 'browser_official') {
          const review = current.catalogAudit
          await within(meta.doc(task._id).update({ data: {
            state: command.set(review.state), results: command.set(review.jobs || {}),
            entity: command.set(review.entity || {}), checkedAt: command.set(review.checkedAt),
            proofMethod: command.set('browser_official'), retryAt: command.set(Number.MAX_SAFE_INTEGER),
            catalogApplied: command.set(true), reviewRunId: command.set(review.runId)
          } }), deadline)
          task.state = review.state
          return
        }
        if (task.fingerprint !== hash(JSON.stringify({ id: current._id, company: current.company, source: current.source, titles: extractTitles(current) }))) {
          await within(meta.doc(task._id).update({ data: { state: command.set('conflict'), catalogApplied: command.set(false), reason: command.set('company_titles_changed') } }), deadline)
          task.state = 'conflict'
          return
        }
        let finalState = task.pendingFinalState || task.state
        if (finalState === 'verified') {
          const covered = new Set(Object.keys(task.results || {}).map(normTitle))
          if (!titleKeys(current).every(key => covered.has(key))) finalState = 'partial'
        }
        const retryAt = task.pendingRetryAt == null ? task.retryAt : task.pendingRetryAt
        if (task.state !== 'write_pending') {
          task.pendingFinalState = finalState
          task.pendingRetryAt = retryAt
          await within(meta.doc(task._id).update({ data: {
            state: command.set('write_pending'), pendingFinalState: command.set(finalState), pendingRetryAt: command.set(retryAt),
            sourceUrls: command.set(task.sourceUrls || []), searchAttempted: command.set(!!task.searchAttempted),
            results: command.set(task.results), entity: command.set(task.entity), attempts: command.set(task.attempts), checkedAt: command.set(task.checkedAt)
          } }), deadline)
          task.state = 'write_pending'
        }
        const summary = { runId: RUN_ID, state: finalState, entity: task.entity, jobs: task.results, checkedAt: task.checkedAt,
          proofMethod: 'official_structured', coverageComplete: finalState === 'verified', coverageFingerprint: coverageFingerprint(current), legacyRolesNotAllConfirmed: finalState !== 'verified' }
        const condition = { _id: task.cid, company: task.company, source: task.source, owner: command.exists(false) }
        for (const field of ['positions', 'fullJobs', 'posBySrc', 'publicJobs', 'discoveryEvidence', 'catalogAudit', 'updated']) {
          condition[field] = current[field] === undefined ? command.exists(false) : command.eq(current[field])
        }
        const saved = await within(companies.where(condition).update({ data: { catalogAudit: command.set(summary) } }), deadline)
        if (!saved || !saved.stats || ![0, 1].includes(saved.stats.updated)) throw Error('catalog_company_write_conflict')
        const after = await within(readCompany(task.cid), deadline)
        if (!after || after.company !== task.company || after.source !== task.source || after.owner !== undefined ||
          coverageFingerprint(after) !== summary.coverageFingerprint || !isDeepStrictEqual(after.catalogAudit, summary)) throw Error('catalog_company_write_conflict')
        await within(meta.doc(task._id).update({ data: { state: command.set(finalState), pendingFinalState: command.set(''), pendingRetryAt: command.set(0), retryAt: command.set(retryAt), catalogApplied: command.set(true) } }), deadline)
        task.state = finalState
      }
      for (const task of tasks.data || []) {
        if (Date.now() >= deadline) break
        processed++
        if (task.state === 'write_pending') { await flushTask(task); continue }
        const checkedAt = new Date(clock()).toISOString()
        const results = {}; const sourceUrls = [...(task.sourceUrls || [])].slice(0, MAX_URLS)
        let evidence = null; let fetchError = false
        for (const url of sourceUrls) {
          if (Date.now() >= deadline) break
          try {
          const raw = await boundedFetch(url, deadline)
            let body = typeof raw === 'string' ? raw : raw && (raw.body || raw.text || raw.data) || ''
            if (Buffer.byteLength(String(body)) > MAX_BODY) body = Buffer.from(String(body)).subarray(0, MAX_BODY).toString('utf8')
            if (!String(body).trim() || /<div[^>]+id=["'](app|root)["'][^>]*>\s*<\/div>/i.test(body)) { fetchError = true; continue }
            const ev = evaluate(body, { company: task.company, titles: task.titles || [], url, now, cohort, officialSource: officialSourceFor(task.company, url) })
            if (ev.entity.status === 'name_matched' || Object.values(ev.jobs).some(x => x.exists === true)) { evidence = ev; break }
            fetchError = true
          } catch (_) { fetchError = true }
        }
        if (!sourceUrls.length && typeof search === 'function' && !task.searchAttempted) {
          try {
            const found = await boundedSearch(`${task.company} 官网 招聘`, deadline)
            const urls = Array.isArray(found) ? found.map(x => typeof x === 'string' ? x : x.url).filter(Boolean) : []
            task.sourceUrls = extractSourceUrls({ url: urls[0] })
            task.searchAttempted = true
            if (task.sourceUrls.length) {
              const s = await boundedFetch(task.sourceUrls[0], deadline)
              const body = typeof s === 'string' ? s : s && (s.body || s.text || s.data) || ''
              if (body && Buffer.byteLength(String(body)) <= MAX_BODY) evidence = evaluate(body, { company: task.company, titles: task.titles || [], url: task.sourceUrls[0], now, cohort, officialSource: officialSourceFor(task.company, task.sourceUrls[0]) })
            }
          } catch (e) {
            if (/quota|no_search_quota/i.test(String(e && e.message || e))) { task.searchAttempted = false; task.state = 'awaiting_search' } else task.searchAttempted = true
          }
        }
        if (evidence) {
          Object.assign(results, evidence.jobs)
          task.entity = evidence.entity
          task.state = titleState(results)
          task.verifiedAt = checkedAt
        } else if (task.state !== 'awaiting_search') {
          task.state = fetchError ? 'needs_browser' : task.sourceUrls.length ? 'unconfirmed' : 'awaiting_search'
          for (const t of task.titles || []) results[t.title] = task.results && task.results[t.title] || { exists: 'unconfirmed', cohort: 'unconfirmed', open: 'unconfirmed', status: 'unconfirmed', quote: '', url: '', checkedAt, reason: fetchError ? 'source_unavailable_or_javascript' : 'no_official_source' }
          task.entity = { status: 'unconfirmed', registeredExists: 'unconfirmed', quote: '', url: '', checkedAt }
        }
        if (!Object.keys(results).length) for (const t of task.titles || []) results[t.title] = task.results && task.results[t.title] || { exists: 'unconfirmed', cohort: 'unconfirmed', open: 'unconfirmed', status: 'unconfirmed', quote: '', url: '', checkedAt, reason: task.state === 'awaiting_search' ? 'search_quota_or_no_source' : 'not_confirmed' }
        task.results = Object.assign({}, task.results || {}, results)
        task.attempts = Number(task.attempts || 0) + 1
        task.checkedAt = checkedAt
        task.retryAt = task.state === 'verified' ? Number.MAX_SAFE_INTEGER : clock() + (task.state === 'awaiting_search' ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000)
        await flushTask(task)
      }
      const untouched = await within(meta.where({ runId: RUN_ID, kind: 'catalogAuditTask', state: command.in(['pending', 'write_pending']) }).count(), deadline)
      const phase = manifest.inventoryComplete && !(untouched.total || 0) ? 'initial_pass_finished' : 'verifying'
      await within(updateManifest({ phase, updatedAt: new Date(clock()).toISOString() }), deadline)
      return { ...(await within(status(), deadline)), processed }
    } finally { if (token) await within(release(token), deadline).catch(() => {}) }
  }

  async function run (mode = 'verify') {
    if (mode === 'start') return start()
    if (mode === 'status') return status()
    if (mode === 'inventory') return inventory()
    if (mode === 'verify') {
      const manifest = await readMeta(MANIFEST_ID)
      if (!manifest) return start()
      if (!manifest.inventoryComplete) {
        // Leave enough of the 60s cloud-function window for bounded source
        // checks and durable writes. Previously each timer tick only inventoried
        // 100 companies and verification waited for the entire collection scan.
        await inventory({ budgetMs: 10000, includeStatus: false })
      }
      return verify()
    }
    return { error: 'invalid_mode' }
  }

  async function publishReview (item) {
    const current = getData(await readDoc('companies', item.id))
    const review = current && current.catalogAudit
    if (!current || current.company !== item.company || current.source !== item.source || current.owner !== undefined ||
      !review || review.proofMethod !== 'browser_official' || review.runId !== item.reviewRunId) throw Error('review_not_applied')
    const id = TASK_PREFIX + hash(item.id).slice(0, 40)
    const titles = item.auditTitles || extractTitles(current)
    const values = { kind: 'catalogAuditTask', runId: RUN_ID, cid: item.id, company: item.company, source: item.source,
      sourceUrls: [...new Set((review.officialJobs || []).map(j => j.url).filter(Boolean))], titles,
      fingerprint: hash(JSON.stringify({ id: item.id, company: item.company, source: item.source, titles })),
      state: review.state, results: review.jobs || {}, entity: review.entity || {},
      proofMethod: 'browser_official', reviewRunId: review.runId, checkedAt: review.checkedAt,
      retryAt: Number.MAX_SAFE_INTEGER, catalogApplied: true, attempts: 0 }
    try { await meta.add({ data: { _id: id, ...values, createdAt: new Date(clock()).toISOString() } }) } catch (e) {
      if (!isDup(e)) throw e
      const saved = await meta.where({ _id: id, cid: item.id, company: item.company, runId: RUN_ID }).update({
        data: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, command.set(v)]))
      })
      // CloudBase reports changed documents, so an idempotent replay can return
      // zero. The full intended values must still pass the readback below.
      if (!saved || !saved.stats || ![0, 1].includes(saved.stats.updated)) throw Error('review_task_conflict')
    }
    const saved = await readMeta(id)
    if (!saved || !Object.entries(values).every(([key, value]) => isDeepStrictEqual(saved[key], value))) throw Error('review_task_readback_failed')
    return { cid: item.id, state: review.state, roleCount: Object.keys(review.jobs || {}).length }
  }
  return { run, start, inventory, verify, status, publishReview }
}

module.exports = { create, extractTitles, extractSourceUrls, parseJsonLd, evaluate, normName, normTitle, RUN_ID, MANIFEST_ID }
