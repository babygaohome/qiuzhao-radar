'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { SOURCES, validateUrl, requestJson, normalize, runIngestion, MemoryStore } = require('../cloudfunctions/intelCrawler/core')
const crawler = require('../cloudfunctions/intelCrawler')

const fixture = (id = 1, published_at = '2026-10-01T00:00:00Z') => ({ id, name: `release ${id}`, tag_name: `v${id}`, html_url: `https://github.com/${SOURCES[0].owner}/${SOURCES[0].repo}/releases/tag/v${id}`, published_at })

test('ordinary invocation and event flags cannot enable cloud ingestion', async () => {
  assert.deepEqual(await crawler._test.createMain({ cloud: { init () {}, getWXContext: () => ({}), database: () => ({ runTransaction: async () => {} }) }, getRuntimeEnv: () => ({}), processEnv: {} })({ triggerName: 'timer', enabled: true }), { ok: false, code: 'INVALID_TRIGGER' })
})

test('exact host and path are required and caller supplied URLs are rejected', () => {
  const source = SOURCES[0]
  const good = `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=30`
  assert.equal(validateUrl(good, source).hostname, 'api.github.com')
  assert.throws(() => validateUrl('https://api.github.com/repos/attacker/anything/releases?per_page=30', { id: 'attacker', owner: 'attacker', repo: 'anything' }), /source_not_allowed/)
  for (const bad of [good.replace('api.github.com', '127.0.0.1'), good.replace('/repos/', '/redirect/'), `${good}&url=https://evil.test`, good.replace('https:', 'http:')]) assert.throws(() => validateUrl(bad, source))
})

test('redirects are rejected and oversized body is aborted', async () => {
  const source = SOURCES[0]; const url = `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=30`
  async function fake(statusCode, body, headers = {}) {
    return requestJson(url, { request: (_url, _options, cb) => {
      const req = new EventEmitter(); req.setTimeout = () => {}; req.end = () => { const res = new EventEmitter(); res.statusCode = statusCode; res.headers = headers; res.resume = () => {}; cb(res); if (body) { res.emit('data', Buffer.from(body)); res.emit('end') } }; req.destroy = err => req.emit('error', err); return req
    }, maxBody: 3 })
  }
  await assert.rejects(fake(302, ''), /redirect_rejected/)
  await assert.rejects(fake(200, '[1,2,3]'), /response_too_large/)
})

test('normalization preserves metadata and makes absent publish dates visibly unknown', () => {
  const source = SOURCES[0]
  const a = normalize(source, fixture(2), '2026-10-29T00:00:00.000Z')
  const b = normalize(source, fixture(2), '2026-10-30T00:00:00.000Z')
  assert.equal(a._id, b._id); assert.equal(a.summaryZh, ''); assert.equal(a.originalUrl, fixture(2).html_url)
  const unknown = normalize(source, fixture(3, null), '2026-10-29T00:00:00.000Z')
  assert.equal(unknown.publishedAt, null); assert.equal(unknown.dateStatus, 'unconfirmed')
})

test('retries transient failures, deduplicates ids, isolates failed sources, and checkpoints only after writes', async () => {
  const store = new MemoryStore(); let attempts = 0; let failSecondSource = true; const sleeps = []
  const result = await runIngestion({ store, sleep: async ms => sleeps.push(ms), fetchJson: async (_url, source) => {
    if (source === SOURCES[0] && attempts++ === 0) throw Object.assign(new Error(), { code: 'request_timeout' })
    if (source === SOURCES[1] && failSecondSource) throw Object.assign(new Error(), { code: 'http_error', status: 503 })
    return [fixture(4), fixture(4)]
  } })
  assert.equal(result.status, 'partial'); assert.deepEqual(sleeps, [1000, 1000, 1000, 2000]); assert.equal(store.items.size, 1)
  assert.equal(store.checkpoints.has(SOURCES[0].id), true); assert.equal(store.checkpoints.has(SOURCES[1].id), false)
  failSecondSource = false
  const resumed = await runIngestion({ store, fetchJson: async () => [fixture(4)] })
  assert.equal(resumed.status, 'success'); assert.equal(store.items.size, 1); assert.equal(store.checkpoints.has(SOURCES[1].id), true)
})

test('failed writes preserve older items and do not advance checkpoint', async () => {
  const store = new MemoryStore(); const existing = normalize(SOURCES[0], fixture(5), '2026-10-01T00:00:00Z'); await store.upsert(existing)
  const originalUpsert = store.upsert.bind(store); store.upsert = async item => { if (item._id !== existing._id) throw new Error('write_failed'); return originalUpsert(item) }
  const result = await runIngestion({ store, sources: [SOURCES[0]], fetchJson: async () => [fixture(5), fixture(6)] })
  assert.equal(result.status, 'partial'); assert.equal(store.items.has(existing._id), true); assert.equal(store.checkpoints.has(SOURCES[0].id), false)
})

test('lease conflicts do not start fetching and release runs after errors', async () => {
  const store = new MemoryStore(); store.lease = 'other'; let fetched = false
  assert.equal((await runIngestion({ store, fetchJson: async () => { fetched = true } })).status, 'lease_conflict'); assert.equal(fetched, false)
  store.lease = null
  await runIngestion({ store, sources: [SOURCES[0]], fetchJson: async () => { throw new Error('offline') } })
  assert.equal(store.lease, null)
})


test('rate limiting defers all sources and malformed links are skipped', async () => {
  const core = require('../cloudfunctions/intelCrawler/core')
  let calls = 0
  const result = await core.runIngestion({ store: new core.MemoryStore(), sleep: async () => {}, fetchJson: async () => { calls++; throw Object.assign(new Error('limited'), { code: 'rate_limited', deferMs: 90000 }) } })
  assert.equal(calls, 1)
  assert(result.sources.every(row => row.status === 'deferred'))
  const source = core.SOURCES[0]
  assert.equal(core.normalize(source, { id: 1, name: 'bad', html_url: 'not a url' }, new Date().toISOString()), null)
  assert.equal(core.normalize(source, { id: 1, name: 'bad', tag_name: 'v1', html_url: 'https://user:pass@github.com/huggingface/transformers/releases/tag/v1' }, new Date().toISOString()), null)
})
