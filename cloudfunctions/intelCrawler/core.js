'use strict'

const https = require('node:https')
const crypto = require('node:crypto')

const SOURCES = Object.freeze([
  { id: 'huggingface-transformers-releases', owner: 'huggingface', repo: 'transformers', category: 'ai', sourceKind: 'open_source_release' },
  { id: 'chipsalliance-chisel-releases', owner: 'chipsalliance', repo: 'chisel', category: 'semiconductor', sourceKind: 'developer_release' }
])
const HOST = 'api.github.com'
const MAX_BODY = 1024 * 1024
const MAX_RETRIES = 2
const REQUEST_TIMEOUT_MS = 8000
const MAX_ITEMS_PER_SOURCE = 30

function releaseUrl (source) { return `https://${HOST}/repos/${source.owner}/${source.repo}/releases?per_page=10` }

function validateUrl (value, source) {
  const registered = SOURCES.find(entry => entry.id === source.id && entry.owner === source.owner && entry.repo === source.repo)
  if (!registered) throw new Error('source_not_allowed')
  let url
  try { url = new URL(value) } catch (_) { throw new Error('invalid_url') }
  if (url.protocol !== 'https:' || url.hostname !== HOST || url.port || url.username || url.password || url.hash || url.search !== '?per_page=10' || url.pathname !== `/repos/${source.owner}/${source.repo}/releases`) throw new Error('url_not_allowed')
  return url
}

function requestJson (url, { request = https.request, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, maxBody = MAX_BODY, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let req
    let settled = false
    let networkStage = 'request'
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      fn(value)
    }
    const fail = error => {
      if (error && typeof error === 'object' && !error.networkStage) error.networkStage = networkStage
      finish(reject, error)
    }
    const deadline = setTimeout(() => {
      const error = Object.assign(new Error('request_timeout'), { code: 'request_timeout', networkStage })
      fail(error)
      if (req && typeof req.destroy === 'function') { try { req.destroy(error) } catch (_) {} }
    }, timeoutMs)
    try {
      req = request(url, { method: 'GET', family: 4, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'InfoFlow-ingestion-preview' } }, res => {
        if (settled) { if (res.resume) res.resume(); return }
        networkStage = 'response'
        const status = res.statusCode || 0
        if (status >= 300 && status < 400) { res.resume(); fail(Object.assign(new Error('redirect_rejected'), { code: 'redirect_rejected' })); return }
        let size = 0; const chunks = []
        res.on('data', chunk => {
          if (settled) return
          networkStage = 'body'
          size += chunk.length
          if (size > maxBody) {
            const error = Object.assign(new Error('response_too_large'), { code: 'response_too_large' })
            fail(error)
            if (req && typeof req.destroy === 'function') { try { req.destroy(error) } catch (_) {} }
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (settled) return
          const headers = res.headers || {}
          if (status === 403 || status === 429) {
            let deferMs = 60000
            const retryAfter = Number(headers['retry-after'])
            if (Number.isFinite(retryAfter) && retryAfter > 0) deferMs = retryAfter * 1000
            else if (headers['x-ratelimit-remaining'] === '0' && Number(headers['x-ratelimit-reset'])) deferMs = Math.max(60000, Number(headers['x-ratelimit-reset']) * 1000 - now())
            fail(Object.assign(new Error('rate_limited'), { code: 'rate_limited', deferMs })); return
          }
          if (status < 200 || status >= 300) { fail(Object.assign(new Error(`http_${status}`), { code: 'http_error', status })); return }
          try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (_) { fail(Object.assign(new Error('invalid_json'), { code: 'invalid_json' })) }
        })
        res.on('error', fail)
      })
      req.on('socket', socket => {
        networkStage = 'dns'
        socket.on('lookup', error => { networkStage = error ? 'dns' : 'connect' })
        socket.on('connect', () => { networkStage = 'tls' })
        socket.on('secureConnect', () => { networkStage = 'response' })
      })
      req.on('error', fail)
      req.end()
    } catch (error) { fail(error) }
  })
}

function normalize (source, release, fetchedAt) {
  if (!release || release.draft || release.prerelease || !Number.isSafeInteger(Number(release.id)) || typeof release.html_url !== 'string' || typeof release.name !== 'string' || !release.name.trim()) return null
  let url
  try { url = new URL(release.html_url) } catch (_) { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.hash || url.search || url.pathname !== `/${source.owner}/${source.repo}/releases/tag/${encodeURIComponent(String(release.tag_name || ''))}`) return null
  const publishedAt = typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? new Date(release.published_at).toISOString() : null
  const stable = `${source.owner}/${source.repo}#${release.id}`
  const id = crypto.createHash('sha256').update(stable).digest('hex')
  return { id, _id: id, sourceName: `${source.owner}/${source.repo} · GitHub Releases`, category: source.category, title: release.name.trim(), originalUrl: url.toString(), sourceIds: [source.id], sourceKind: source.sourceKind, publishedAt, dateStatus: publishedAt ? 'confirmed' : 'unconfirmed', fetchedAt, summaryZh: '', summaryStatus: 'unavailable', status: 'published' }
}

async function runIngestion ({ fetchJson = requestJson, store, clock = () => new Date(), sources = SOURCES, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxRetries = MAX_RETRIES }) {
  if (!store || typeof store.acquireLease !== 'function' || typeof store.releaseLease !== 'function' || typeof store.upsert !== 'function' || typeof store.getCheckpoint !== 'function' || typeof store.setCheckpoint !== 'function') throw new Error('store_contract_required')
  const token = crypto.randomUUID()
  if (!await store.acquireLease(token)) return { status: 'lease_conflict', sources: [] }
  const results = []
  let deferredUntil = 0
  try {
    const startedAt = clock().toISOString()
    if (store.createRun) await store.createRun(token, { status: 'running', startedAt, sources: [] })
    let requestedSource = false
    for (const source of sources.slice(0, 2)) {
      const result = { sourceId: source.id, status: 'failed', fetched: 0, addedOrUpdated: 0 }
      if (deferredUntil) { results.push({ ...result, status: 'deferred', deferMs: deferredUntil, error: 'rate_limited' }); continue }
      try {
        const url = validateUrl(releaseUrl(source), source)
        let payload
        result.stage = 'fetch'
        if (requestedSource) await sleep(1000)
        requestedSource = true
        for (let attempt = 0; ; attempt++) {
          try { payload = await fetchJson(url.toString(), source); break } catch (error) {
            if (error.code === 'rate_limited') { result.status = 'deferred'; result.deferMs = error.deferMs; deferredUntil = error.deferMs || 60000; throw error }
            const transientNetworkErrors = ['request_timeout', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']
            if (attempt >= maxRetries || !(transientNetworkErrors.includes(error.code) || (error.code === 'http_error' && (!error.status || error.status >= 500)))) throw error
            await sleep(1000 * (attempt + 1))
          }
        }
        if (!Array.isArray(payload)) throw Object.assign(new Error('invalid_payload'), { code: 'invalid_payload' })
        result.stage = 'checkpoint_read'
        const checkpoint = await store.getCheckpoint(source.id)
        const page = payload.slice(0, MAX_ITEMS_PER_SOURCE)
        const fetchedAt = clock().toISOString()
        for (const release of page) {
          result.stage = 'normalize'
          const item = normalize(source, release, fetchedAt)
          if (item) { result.stage = 'upsert'; await store.upsert(item, token); result.addedOrUpdated++ }
        }
        result.stage = 'checkpoint_write'
        await store.setCheckpoint(source.id, { page: 1, completedAt: fetchedAt, previousCompletedAt: checkpoint && checkpoint.completedAt || null }, token)
        result.fetched = page.length; result.status = 'success'; result.stage = 'completed'
      } catch (error) {
        result.error = safeError(error)
        result.errorCode = Number.isFinite(error && error.errCode) ? error.errCode : null
        if (error && ['request', 'dns', 'connect', 'tls', 'response', 'body'].includes(error.networkStage)) result.networkStage = error.networkStage
      }
      results.push(result)
    }
    const output = { status: results.every(r => r.status === 'success') ? 'success' : 'partial', sources: results }
    if (store.updateRun) await store.updateRun(token, { status: output.status, finishedAt: clock().toISOString(), sources: results })
    return output
  } catch (error) {
    if (store.updateRun) await store.updateRun(token, { status: 'failed', finishedAt: clock().toISOString(), error: safeError(error), sources: results }).catch(() => {})
    throw error
  } finally { await store.releaseLease(token) }
}

function safeError (error) {
  const allowed = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ERR_INVALID_ARG_TYPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'lease_lost', 'source_not_allowed', 'invalid_url', 'url_not_allowed', 'request_timeout', 'http_error', 'rate_limited', 'response_too_large', 'redirect_rejected', 'invalid_json', 'invalid_payload', 'write_failed']
  return error && allowed.includes(error.code) ? error.code : 'ingestion_failed'
}

class MemoryStore {
  constructor ({ now = Date.now, leaseMs = 300000 } = {}) { this.items = new Map(); this.checkpoints = new Map(); this.runs = new Map(); this.lease = null; this.now = now; this.leaseMs = leaseMs }
  async acquireLease (token) { if (this.lease && (typeof this.lease !== 'object' || this.lease.expiresAt > this.now())) return false; this.lease = { token, expiresAt: this.now() + this.leaseMs }; return true }
  assertLease (token) { if (!this.lease || this.lease.token !== token || this.lease.expiresAt <= this.now()) throw Object.assign(new Error('lease_lost'), { code: 'lease_lost' }) }
  async releaseLease (token) { if (this.lease && this.lease.token === token) this.lease = null }
  async createRun (token, metadata) { this.assertLease(token); this.runs.set(token, { ...metadata, runId: token }) }
  async updateRun (token, metadata) { this.assertLease(token); this.runs.set(token, { ...(this.runs.get(token) || {}), ...metadata, runId: token }) }
  async upsert (item, token) { if (token !== undefined) this.assertLease(token); this.items.set(item._id, item) }
  async getCheckpoint (sourceId) { return this.checkpoints.get(sourceId) || null }
  async setCheckpoint (sourceId, checkpoint, token) { this.assertLease(token); this.checkpoints.set(sourceId, checkpoint) }
}

module.exports = { SOURCES, MAX_BODY, MAX_ITEMS_PER_SOURCE, validateUrl, requestJson, normalize, runIngestion, MemoryStore, _test: { releaseUrl, safeError } }
