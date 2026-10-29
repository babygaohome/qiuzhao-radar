'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { SOURCES, requestJson, runIngestion, MemoryStore } = require('../cloudfunctions/intelCrawler/core')

const urlFor = source => `https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=10`

test('hard HTTP deadline covers a request that never establishes a socket', async () => {
  let destroyed
  const request = () => {
    const req = new EventEmitter()
    req.end = () => {}
    req.destroy = error => { destroyed = error; req.emit('error', error) }
    return req
  }
  await assert.rejects(requestJson(urlFor(SOURCES[0]), { request, timeoutMs: 15 }), error => error.code === 'request_timeout' && error.networkStage === 'request')
  assert.equal(destroyed.code, 'request_timeout')
})

test('requests pin IPv4 and report a stalled TLS stage without exposing network details', async () => {
  let options
  const request = (_url, requestOptions) => {
    options = requestOptions
    const req = new EventEmitter()
    req.end = () => {
      const socket = new EventEmitter()
      req.emit('socket', socket)
      socket.emit('lookup', null)
      socket.emit('connect')
    }
    req.destroy = error => req.emit('error', error)
    return req
  }
  await assert.rejects(requestJson(urlFor(SOURCES[0]), { request, timeoutMs: 15 }), error => error.code === 'request_timeout' && error.networkStage === 'tls' && !('address' in error) && !('url' in error))
  assert.equal(options.family, 4)
})

test('IPv4 request completes through the response and body stages', async () => {
  let family
  const request = (_url, options, callback) => {
    family = options.family
    const req = new EventEmitter()
    req.end = () => {
      const socket = new EventEmitter()
      req.emit('socket', socket)
      socket.emit('lookup', null)
      socket.emit('connect')
      socket.emit('secureConnect')
      const res = new EventEmitter()
      res.statusCode = 200
      res.headers = {}
      callback(res)
      res.emit('data', Buffer.from('[{"ok":true}]'))
      res.emit('end')
    }
    req.destroy = error => req.emit('error', error)
    return req
  }
  assert.deepEqual(await requestJson(urlFor(SOURCES[0]), { request, timeoutMs: 100 }), [{ ok: true }])
  assert.equal(family, 4)
})

test('ECONNRESET is retried and successful response settles normally', async () => {
  let attempts = 0
  const sleeps = []
  const store = new MemoryStore()
  const result = await runIngestion({
    store,
    sources: [SOURCES[0]],
    sleep: async ms => sleeps.push(ms),
    fetchJson: async () => { if (attempts++ === 0) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return [] }
  })
  assert.equal(result.status, 'success')
  assert.equal(attempts, 2)
  assert.deepEqual(sleeps, [1000])
  assert.equal(store.checkpoints.has(SOURCES[0].id), true)
})

test('rate limits are not retried', async () => {
  let calls = 0
  const store = new MemoryStore()
  const result = await runIngestion({
    store,
    sleep: async () => {},
    fetchJson: async (_url, source) => {
      calls++
      if (source === SOURCES[0]) throw Object.assign(new Error('limited'), { code: 'rate_limited', deferMs: 60000 })
      return []
    }
  })
  assert.equal(calls, 1)
  assert.deepEqual(result.sources.map(source => source.status), ['deferred', 'deferred'])
})

test('a permanent failure remains isolated to its source', async () => {
  const result = await runIngestion({
    store: new MemoryStore(),
    sleep: async () => {},
    fetchJson: async (_url, source) => {
      if (source === SOURCES[0]) throw Object.assign(new Error('missing host'), { code: 'ENOTFOUND' })
      return []
    }
  })
  assert.deepEqual(result.sources.map(source => source.status), ['failed', 'success'])
})

test('ingestion persists only an allowlisted network stage for source failures', async () => {
  const result = await runIngestion({
    store: new MemoryStore(),
    sources: [SOURCES[0]],
    sleep: async () => {},
    fetchJson: async () => { throw Object.assign(new Error('timed out'), { code: 'request_timeout', networkStage: 'tls', address: '203.0.113.8' }) }
  })
  assert.equal(result.sources[0].networkStage, 'tls')
  assert.equal(result.sources[0].address, undefined)
})

test('DNS name-not-found is not classified as transient', async () => {
  let attempts = 0
  const result = await runIngestion({
    store: new MemoryStore(),
    sources: [SOURCES[0]],
    sleep: async () => {},
    fetchJson: async () => { attempts++; throw Object.assign(new Error('missing host'), { code: 'ENOTFOUND' }) }
  })
  assert.equal(attempts, 1)
  assert.equal(result.sources[0].error, 'ENOTFOUND')
})
