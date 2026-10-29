const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const pendingTick = () => Promise.resolve().then(() => Promise.resolve())
function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function pageFrom (file, modules, wxApi) {
  let definition
  const context = {
    Page (value) { definition = value },
    wx: wxApi || { navigateTo () {}, stopPullDownRefresh () {} },
    require (name) {
      if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name]
      throw new Error('unexpected require: ' + name)
    }
  }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file })
  return definition
}
function instance (definition) {
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData (values) { Object.assign(this.data, values) }
  })
}

async function listPageBehavior () {
  const requests = []
  const config = { intelEnabled: true, intelDemoMode: false }
  const definition = pageFrom(path.join(root, 'miniprogram/pages/intel/index.js'), {
    '../../utils/util.js': { api (action, data) {
      const call = deferred()
      requests.push({ action, data, ...call })
      return call.promise
    } },
    '../../config.js': config,
    './demo-fixtures.js': []
  })
  const page = instance(definition)
  page.onLoad()
  page.onShow()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].data.openid, undefined)

  const firstCursor = 'cursor-page-2'
  requests[0].resolve({ items: [{ id: 'a', category: 'ai', title: 'A', publishedAt: '2026-10-29T10:00:00Z' }], nextCursor: firstCursor })
  await pendingTick()
  assert.equal(page.data.items[0].displayDate, '2026-10-29')
  assert.equal(page.data.items[0].displaySummaryStatus, '摘要状态未知')

  page.loadMore()
  assert.equal(requests[1].data.cursor, firstCursor)
  requests[1].resolve({ items: [{ id: 'a', title: 'duplicate' }, { id: 'b', title: 'B' }], nextCursor: 'cursor-page-3' })
  await pendingTick()
  assert.deepEqual(page.data.items.map(item => item.id), ['a', 'b'])

  page.loadMore()
  requests[2].reject({ message: 'page failed' })
  await pendingTick()
  assert.equal(page.data.moreError, 'page failed')
  assert.deepEqual(page.data.items.map(item => item.id), ['a', 'b'], 'load-more failure keeps rows')
  page.onRetryMore()
  requests[3].resolve({ items: [{ id: 'c' }], nextCursor: null })
  await pendingTick()
  assert.deepEqual(page.data.items.map(item => item.id), ['a', 'b', 'c'])

  const oldRefresh = page.loadFeed({ keepItems: true })
  const refreshRequest = requests[4]
  page.setData({ category: 'ai' })
  page.onSelectCategory({ currentTarget: { dataset: { category: 'electronics' } } })
  assert.equal(requests.length, 6)
  refreshRequest.resolve({ items: [{ id: 'stale-refresh' }] })
  requests[5].resolve({ items: [{ id: 'electronics-current', category: 'electronics' }] })
  await oldRefresh
  await pendingTick()
  assert.deepEqual(page.data.items.map(item => item.id), ['electronics-current'], 'category change invalidates refresh result')

  const oldCategoryRequest = page.loadFeed()
  const stale = requests[6]
  page.onSelectCategory({ currentTarget: { dataset: { category: 'ai' } } })
  stale.resolve({ items: [{ id: 'stale-category' }] })
  requests[7].resolve({ items: [{ id: 'ai-current', category: 'ai' }], nextCursor: 'late-cursor' })
  await oldCategoryRequest
  await pendingTick()
  assert.deepEqual(page.data.items.map(item => item.id), ['ai-current'])

  page.loadMore()
  const late = requests[8]
  let writesAfterUnload = 0
  const originalSetData = page.setData
  page.setData = function (values) { writesAfterUnload++; return originalSetData.call(this, values) }
  page.onUnload()
  late.resolve({ items: [{ id: 'too-late' }] })
  await pendingTick()
  assert.equal(writesAfterUnload, 0, 'unloaded page must not update state')
  assert.deepEqual(page.data.items.map(item => item.id), ['ai-current'])
}

async function flagsAndDetail () {
  let definition
  let apiCalls = 0
  const config = { intelEnabled: false, intelDemoMode: false }
  const disabled = pageFrom(path.join(root, 'miniprogram/pages/intel/index.js'), {
    '../../utils/util.js': { api () { apiCalls++; return Promise.resolve({}) } },
    '../../config.js': config,
    './demo-fixtures.js': []
  })
  const off = instance(disabled)
  off.onLoad()
  off.onShow()
  off.loadFeed()
  assert.equal(apiCalls, 0, 'disabled feature must not call API')

  const attempts = []
  const detailDefinition = pageFrom(path.join(root, 'miniprogram/pages/intel-detail/detail.js'), {
    '../../utils/util.js': {
      api (action, data) {
        assert.equal(action, 'intelItem')
        const call = deferred()
        attempts.push({ data, ...call })
        return call.promise
      }, copyLink () {}
    },
    '../../config.js': { intelEnabled: true, intelDemoMode: false },
    '../intel/demo-fixtures.js': []
  })
  definition = detailDefinition
  const detail = instance(definition)
  detail.onLoad({ id: 'news-1' })
  attempts[0].reject({ message: 'try again' })
  await pendingTick()
  assert.equal(detail.data.error, 'try again')
  detail.onRetry()
  attempts[1].resolve({ item: { id: 'news-1', category: 'semiconductor', title: 'Chip', publishedAt: 'not-date' } })
  await pendingTick()
  assert.equal(detail.data.item.categoryLabel, '半导体')
  assert.equal(detail.data.item.displayDate, '发布时间未知')
  assert.equal(detail.data.item.displaySummaryStatus, '摘要状态未知')
  assert.equal(attempts[1].data.id, 'news-1')

  const stalePage = instance(detailDefinition)
  stalePage.onLoad({ id: 'news-2' })
  const lateDetail = attempts[2]
  let writes = 0
  const oldSetData = stalePage.setData
  stalePage.setData = function (values) { writes++; return oldSetData.call(this, values) }
  stalePage.onUnload()
  lateDetail.resolve({ item: { id: 'news-2' } })
  await pendingTick()
  assert.equal(writes, 0)
}

Promise.resolve().then(listPageBehavior).then(flagsAndDetail).then(() => {
  process.stdout.write('InfoFlow page pagination, race cancellation, flags, retries and labels: PASS\n')
}).catch(error => { console.error(error); process.exitCode = 1 })
