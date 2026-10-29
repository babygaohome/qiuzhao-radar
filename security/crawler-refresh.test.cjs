'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const https = require('node:https')
const { EventEmitter } = require('node:events')

const project = path.resolve(__dirname, '..')
const config = JSON.parse(fs.readFileSync(path.join(project, 'cloudfunctions/crawler/config.json'), 'utf8'))
let scenario = null

function query (name, criteria) {
  const q = {
    where (next) { return query(name, next) },
    field () { return this },
    limit () { return this },
    skip () { return this },
    orderBy () { return this },
    async get () {
      if (name === 'meta' && criteria && criteria._id === 'crawler') return { data: [Object.assign({}, scenario.initialState)] }
      if (name === 'meta' && criteria && criteria._id === 'crawlerLease') return { data: [] }
      return { data: [] }
    },
    async count () { return { total: 0 } },
    async update () { return { stats: { updated: 0 } } },
    async add () { return { _id: 'crawlerLease' } }
  }
  return q
}

function fakeDatabase () {
  const command = new Proxy({}, { get: (_, op) => (...args) => ({ op, args }) })
  return {
    command,
    collection (name) {
      return Object.assign(query(name), {
        where: criteria => query(name, criteria),
        doc (id) {
          return {
            async set ({ data }) {
              assert.equal(Object.prototype.hasOwnProperty.call(data, '_id'), false, 'document _id must not be written as data')
              if (name === 'meta' && id === 'crawler') scenario.crawlerWrites.push(data)
              if (name === 'meta' && id === 'catalog') scenario.catalogWrites.push(data)
              return { stats: { updated: 1 } }
            },
            async update ({ data }) {
              if (name === 'meta' && id === 'crawler') scenario.crawlerWrites.push(data)
              if (name === 'meta' && id === 'catalog') scenario.catalogWrites.push(data)
              return { stats: { updated: 1 } }
            },
            async remove () { return { stats: { removed: 1 } } }
          }
        }
      })
    }
  }
}

// The crawler's pure scheduling helpers do not need a live cloud SDK or database.
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return {
    DYNAMIC_CURRENT_ENV: 'test',
    init () {},
    database: fakeDatabase,
    getWXContext () { return {} }
  }
  if (request === 'lodash') return {}
  return originalLoad.call(this, request, parent, isMain)
}
const crawler = require(path.join(project, 'cloudfunctions/crawler/index.js'))
const { summarizeSources, cursorAfter, forEachLimit, withoutDocumentId } = crawler._test
Module._load = originalLoad

test('crawler trigger schedules a check every thirty minutes, including overnight', () => {
  assert.equal(config.triggers[0].config, '0 7,37 * * * * *')
})

test('a source cursor advances only when every planned request succeeds', () => {
  const sources = summarizeSources({ qiuzhaowang: 4, niuqi: 8 }, {
    qiuzhaowang: { requests: 4, failed: false, ms: 1400 },
    niuqi: { requests: 7, failed: true, ms: 9200 }
  })

  assert.deepEqual(sources.qiuzhaowang, { status: 'ok', requests: 4, planned: 4, ms: 1400 })
  assert.deepEqual(sources.niuqi, { status: 'failed', requests: 7, planned: 8, ms: 9200 })
  assert.equal(cursorAfter(sources, 'qiuzhaowang', 3, 7), 7)
  assert.equal(cursorAfter(sources, 'niuqi', 5, 12), 5)
})

test('successful empty pages count as successful fetches; a failed fetch does not', () => {
  const successfulEmptyPage = summarizeSources({ offerstar: 1 }, {
    offerstar: { requests: 1, failed: false, ms: 80, rows: 0 }
  })
  const httpFailure = summarizeSources({ offerstar: 1 }, {
    offerstar: { requests: 1, failed: true, ms: 80 }
  })

  assert.equal(successfulEmptyPage.offerstar.status, 'ok')
  assert.equal(httpFailure.offerstar.status, 'failed')
})

test('metadata copied from a database record drops the reserved document id', () => {
  assert.deepEqual(withoutDocumentId({ _id: 'crawler', lastSuccessAt: '2026-10-22T00:00:00.000Z' }), {
    lastSuccessAt: '2026-10-22T00:00:00.000Z'
  })
})

test('database write pool stays within the configured concurrency bound', async () => {
  let active = 0
  let peak = 0
  const items = Array.from({ length: 40 }, (_, i) => i)
  await forEachLimit(items, 8, async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve))
    active--
  })
  assert.equal(peak, 8)
})

async function runLifecycle (failSources) {
  scenario = {
    failSources,
    initialState: {
      _id: 'crawler', campusV: 1, groupV: 1,
      qzwCursor: 5, gmoCursor: 9, jobupCursor: 7, hustCursor: 4,
      niuqiCursor: 11, niuqiDeepCursor: 3, lastSuccessAt: '2026-10-20T12:00:00.000Z'
    },
    crawlerWrites: [], catalogWrites: []
  }

  const originalGet = https.get
  const originalTimeout = global.setTimeout
  https.get = (url, options, callback) => {
    const req = new EventEmitter()
    req.destroy = () => { req.emit('error', new Error('mock abort')); req.emit('close') }
    process.nextTick(() => {
      const res = new EventEmitter()
      res.statusCode = failSources ? 503 : 200
      res.headers = {}
      res.resume = () => {}
      callback(res)
      if (!failSources) {
        res.emit('data', Buffer.alloc(0))
        res.emit('end')
      }
      req.emit('close')
    })
    return req
  }
  global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 900 ? 0 : ms, ...args)

  try { return await crawler.main({ Type: 'timer' }) } finally {
    https.get = originalGet
    global.setTimeout = originalTimeout
  }
}

test('main lifecycle records a successful crawl and advances completed source cursors', async () => {
  const result = await runLifecycle(false)
  const finalState = scenario.crawlerWrites.at(-1)

  assert.equal(result.status, 'ok')
  assert.equal(finalState.status, 'ok')
  assert.equal(finalState.lastSuccessAt, result.at)
  assert.equal(finalState.qzwCursor, result.pages.qiuzhaowang.at(-1) + 1)
  assert.ok(finalState.sources.qiuzhaowang.requests === finalState.sources.qiuzhaowang.planned)
  assert.ok(scenario.catalogWrites.length > 0)
  assert.equal(scenario.catalogWrites.at(-1).lastCrawlStatus, 'ok')
  for (const write of scenario.crawlerWrites) assert.equal(Object.prototype.hasOwnProperty.call(write, '_id'), false)
})

test('all-source failure preserves last success and cursors and does not refresh catalog metadata', async () => {
  const result = await runLifecycle(true)
  const finalState = scenario.crawlerWrites.at(-1)

  assert.equal(result.status, 'error')
  assert.equal(finalState.status, 'error')
  assert.equal(finalState.lastSuccessAt, scenario.initialState.lastSuccessAt)
  assert.equal(finalState.qzwCursor, scenario.initialState.qzwCursor)
  assert.equal(finalState.gmoCursor, scenario.initialState.gmoCursor)
  assert.equal(finalState.niuqiCursor, scenario.initialState.niuqiCursor)
  assert.deepEqual(scenario.catalogWrites, [])
})

test('write-pool failure waits for in-flight writes before rejecting', async () => {
  const order = []
  await assert.rejects(forEachLimit([0, 1, 2, 3], 2, async item => {
    if (item === 0) {
      await new Promise(resolve => setImmediate(resolve))
      order.push('failed')
      throw new Error('write failed')
    }
    order.push(`started-${item}`)
    await new Promise(resolve => setTimeout(resolve, 5))
    order.push(`finished-${item}`)
  }), /write failed/)
  assert.ok(order.includes('finished-1'))
  assert.ok(!order.includes('started-2'))
})

// Regression for a real CloudBase failure: plain empty maps disappear during
// update serialization, producing an invalid empty $set. Production must use set.
test('changed empty maps use explicit replacement instead of an empty SDK update', () => {
  const patch = crawler._test.changedFields({ _id: 'a', posBySrc: { old: ['old'] }, v: 'single' }, { _id: 'a', posBySrc: {}, v: 'multi' })
  assert.equal(patch.posBySrc.op, 'set')
  assert.deepEqual(patch.posBySrc.args, [{}])
  assert.equal(patch.v, undefined)
  assert.equal(patch._id, undefined)
})
