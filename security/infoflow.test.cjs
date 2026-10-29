const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createIntelHandlers } = require('../cloudfunctions/api/intel/handlers.js')

async function tick () { await Promise.resolve(); await Promise.resolve() }

async function backendContract () {
  const rows = [
    { id: 'a-1', category: 'ai', title: 'A', summaryZh: 'summary', summaryStatus: 'unknown', status: 'published', originalUrl: 'https://example.org/a', privateField: 'secret' },
    { id: 'hidden', category: 'ai', title: 'Hidden', status: 'draft' },
    { id: 's-1', category: 'semiconductor', title: 'S', status: 'published' }
  ]
  let calls = 0
  const enabled = createIntelHandlers({ enabled: true, readItems: async () => { calls++; return rows } })
  assert.equal((await enabled.intelFeed({}, '')).error, 'unauthenticated')
  assert.equal((await enabled.intelFeed({ category: 'wat' }, 'A')).error, 'bad_request')
  assert.equal((await enabled.intelFeed({ limit: 21 }, 'A')).error, 'bad_request')
  assert.equal((await enabled.intelFeed({ cursor: 'tampered' }, 'A')).error, 'bad_request')
  const feed = await enabled.intelFeed({ category: 'ai', limit: 20, openid: 'B' }, 'A')
  assert.deepEqual(feed.items.map(x => x.id), ['a-1'])
  assert.equal(feed.items[0].privateField, undefined)
  assert.equal(feed.items[0].summaryStatus, 'unknown')
  assert.equal((await enabled.intelItem({ id: 'hidden' }, 'A')).error, 'not_found')
  assert.equal((await enabled.intelItem({ id: 'bad id' }, 'A')).error, 'bad_request')
  assert.equal((await enabled.intelItem({ id: 'a-1', openid: 'B' }, 'A')).item.id, 'a-1')
  assert.equal(calls, 3)
  const disabled = createIntelHandlers({ enabled: false, readItems: async () => { throw Error('must not read') } })
  assert.equal((await disabled.intelFeed({}, 'A')).error, 'feature_disabled')
  assert.equal((await disabled.intelItem({ id: 'a-1' }, 'A')).error, 'feature_disabled')
}

async function signedPagination () {
  let time = 100000
  const key = 'test-only-cursor-key-with-at-least-32-bytes'
  const rows = [
    { id: 'older', category: 'ai', title: 'Older', publishedAt: '2026-01-01T00:00:00Z', status: 'published' },
    { id: 'newer', category: 'ai', title: 'Newer', publishedAt: '2026-02-01T00:00:00Z', status: 'published' },
    { id: 'newest', category: 'ai', title: 'Newest', publishedAt: '2026-03-01T00:00:00Z', status: 'published' }
  ]
  const handlers = createIntelHandlers({ enabled: true, cursorSecret: key, now: () => time, readItems: async () => rows })
  const first = await handlers.intelFeed({ category: 'ai', limit: 1 }, 'owner-a')
  assert.equal(first.items[0].id, 'newest')
  assert.ok(first.nextCursor)
  assert.equal((await handlers.intelFeed({ category: 'ai', limit: 1, cursor: first.nextCursor }, 'owner-a')).items[0].id, 'newer')
  assert.equal((await handlers.intelFeed({ category: 'ai', limit: 1, cursor: first.nextCursor }, 'owner-b')).error, 'bad_request')
  assert.equal((await handlers.intelFeed({ category: 'semiconductor', limit: 1, cursor: first.nextCursor }, 'owner-a')).error, 'bad_request')
  assert.equal((await handlers.intelFeed({ category: 'ai', limit: 2, cursor: first.nextCursor }, 'owner-a')).error, 'bad_request')
  rows.push({ id: 'inserted', category: 'ai', title: 'Changed snapshot', publishedAt: '2026-04-01T00:00:00Z', status: 'published' })
  assert.equal((await handlers.intelFeed({ category: 'ai', limit: 1, cursor: first.nextCursor }, 'owner-a')).error, 'bad_request')
  const expiring = await handlers.intelFeed({ category: 'ai', limit: 1 }, 'owner-a')
  time += 15 * 60 * 1000 + 1
  assert.equal((await handlers.intelFeed({ category: 'ai', limit: 1, cursor: expiring.nextCursor }, 'owner-a')).error, 'bad_request')
  const noKey = createIntelHandlers({ enabled: true, readItems: async () => rows })
  assert.equal((await noKey.intelFeed({ category: 'ai', limit: 1 }, 'owner-a')).error, 'server_error')
  assert.equal((await noKey.intelFeed({ category: 'ai', limit: 1, cursor: first.nextCursor }, 'owner-a')).error, 'bad_request')
}

async function pageBehavior () {
  const pending = []
  const calls = []
  let page
  const box = {
    require (name) {
      if (name === '../../utils/util.js') return { api: (action, data) => {
        calls.push({ action, data })
        return new Promise((resolve, reject) => pending.push({ resolve, reject, action, data }))
      }, copyLink () {} }
      if (name === '../../config.js') return { intelEnabled: true, intelDemoMode: false }
      if (name === './demo-fixtures.js') return require('../miniprogram/pages/intel/demo-fixtures.js')
      if (name === '../intel/demo-fixtures.js') return []
      throw Error('unexpected require ' + name)
    },
    Page (value) { page = value },
    wx: { navigateTo (x) { box.navigated = x.url }, stopPullDownRefresh () {} }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/intel/index.js'), 'utf8'), box)
  const p = Object.assign({}, page, { data: JSON.parse(JSON.stringify(page.data)), setData (x) { Object.assign(this.data, x) } })
  p.onLoad()
  p.loadFeed()
  p.setData({ category: 'ai' })
  p.loadFeed()
  assert.equal(calls.length, 2)
  assert.equal(calls[0].data.openid, undefined, 'client must not choose the account identity')
  pending[1].resolve({ items: [{ id: 'new', title: 'newest' }] })
  await tick()
  pending[0].resolve({ items: [{ id: 'stale', title: 'old' }] })
  await tick()
  assert.equal(p.data.items[0].id, 'new', 'late older response must not overwrite newer result')
  p.onOpenItem({ currentTarget: { dataset: { id: 'safe:1' } } })
  assert.match(box.navigated, /id=safe%3A1/)
  const before = calls.length
  p.onOpenItem({ currentTarget: { dataset: { id: '../bad' } } })
  assert.equal(calls.length, before)

  const detailSource = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/intel-detail/detail.js'), 'utf8')
  let detail
  const detailBox = Object.assign({}, box, { Page: value => { detail = value } })
  vm.runInNewContext(detailSource, detailBox)
  const d = Object.assign({}, detail, { data: JSON.parse(JSON.stringify(detail.data)), setData (x) { Object.assign(this.data, x) } })
  d.onLoad({ id: 'a-1' })
  assert.equal(calls.at(-1).action, 'intelItem')
  const request = pending.at(-1)
  request.reject({ message: 'private stack text' })
  await tick()
  assert.equal(d.data.error, 'private stack text')

  let demoPage
  const demoBox = Object.assign({}, box, {
    Page: value => { demoPage = value },
    require (name) {
      if (name === '../../utils/util.js') return { api () { throw Error('demo must not call API') } }
      if (name === '../../config.js') return { intelEnabled: false, intelDemoMode: true }
      if (name === './demo-fixtures.js') return [
        { id: 'demo-ai', demo: true, category: 'ai', title: 'synthetic AI' },
        { id: 'demo-chip', demo: true, category: 'semiconductor', title: 'synthetic semiconductor' }
      ]
      throw Error('unexpected demo require ' + name)
    }
  })
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/intel/index.js'), 'utf8'), demoBox)
  const preview = Object.assign({}, demoPage, { data: JSON.parse(JSON.stringify(demoPage.data)), setData (x) { Object.assign(this.data, x) } })
  preview.onLoad()
  assert.equal(preview.data.demo, true)
  assert.equal(preview.data.items[0].demo, true)
  preview.onSelectCategory({ currentTarget: { dataset: { category: 'semiconductor' } } })
  assert.equal(preview.data.items.length, 1)
  assert.equal(preview.data.items[0].category, 'semiconductor')
}

async function apiRouteIdentity () {
  const root = path.resolve(__dirname, '..')
  const source = fs.readFileSync(path.join(__dirname, 'isolation.test.cjs'), 'utf8').split('let passed = 0')[0]
  const box = { require, __dirname, console, Buffer, URL, setTimeout, clearTimeout }
  vm.runInNewContext(source + '\nthis.harness = harness', box)
  const h = box.harness()
  const unauthenticated = await h.call('', 'intelFeed', { openid: 'B' })
  assert.equal(unauthenticated.error, 'unauthenticated')
  const disabled = await h.call('A', 'intelFeed', { openid: 'B' })
  assert.equal(disabled.error, 'feature_disabled')
  assert.equal(Object.prototype.hasOwnProperty.call(h.box.exports._test.handlers, 'intelFeed'), true)
  assert.equal(Object.prototype.hasOwnProperty.call(h.box.exports._test.handlers, 'intelItem'), true)
  void root
}

Promise.resolve().then(backendContract).then(signedPagination).then(pageBehavior).then(apiRouteIdentity).then(() => {
  process.stdout.write('InfoFlow contract, API route identity/default flag, page events/races/errors: PASS\n')
}).catch(error => { console.error(error); process.exitCode = 1 })
