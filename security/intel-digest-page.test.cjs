'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const tick = () => Promise.resolve().then(() => Promise.resolve())
const plain = value => JSON.parse(JSON.stringify(value))
function deferred () { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function makePage (api, wx = {}) {
  let definition
  const filename = path.join(root, 'miniprogram/pages/intel-digest/index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page (value) { definition = value },
    require (name) { assert.equal(name, '../../utils/util.js'); return { api } },
    wx: Object.assign({ navigateTo () {} }, wx),
    module: { exports: {} },
    URL
  }, { filename })
  return Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData (value) { Object.assign(this.data, value) } })
}

function makeIntelPage (config, wx = {}) {
  let definition
  const filename = path.join(root, 'miniprogram/pages/intel/index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page (value) { definition = value },
    require (name) {
      if (name === '../../utils/util.js') return { api: async () => ({ items: [] }) }
      if (name === '../../config.js') return config
      if (name === './demo-fixtures.js') return []
      throw new Error(`Unexpected require ${name}`)
    },
    wx: Object.assign({ navigateTo () {} }, wx),
    module: { exports: {} },
    URL
  }, { filename })
  return Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData (value) { Object.assign(this.data, value) } })
}

async function run () {
  const calls = []
  const page = makePage((action, data) => { const req = deferred(); calls.push({ action, data, ...req }); return req.promise })
  page.onLoad()
  assert.equal(calls[0].action, 'intelDigestToday')
  calls[0].resolve({ digest: { localDate: '2026-10-29', items: [{ itemId: 'item-1', title: 'Real title', sourceName: 'Known source', originalUrl: 'https://example.org/a', reason: 'Subscribed channel' }], jobItems: [] } })
  await tick()
  assert.equal(page.data.loading, false)
  assert.equal(page.data.items.length, 1)
  assert.equal(page.data.items[0].title, 'Real title')
  assert.equal(page.data.empty, false)
  assert.equal(page.data.contractNotice.includes('逐步开放'), true)
  page.onOpenItem({ currentTarget: { dataset: { id: 'item-1' } } })
  assert.equal(page.data.items[0].itemId, 'item-1')

  const empty = makePage(() => Promise.resolve({ digest: null }))
  empty.onLoad(); await tick()
  assert.equal(empty.data.empty, true)
  assert.equal(empty.data.items.length, 0, 'empty state must not fabricate entries')

  const retryCalls = []
  const retry = makePage(() => { const req = deferred(); retryCalls.push(req); return req.promise })
  retry.onLoad(); retryCalls[0].reject({ message: 'offline' }); await tick()
  assert.equal(retry.data.error, 'offline')
  retry.onRetry()
  assert.equal(retryCalls.length, 2)
  retryCalls[1].resolve({ digest: null }); await tick()
  assert.equal(retry.data.error, '')
  assert.equal(retry.data.empty, true)

  const historyCalls = []
  const history = makePage((action, data) => { const req = deferred(); historyCalls.push({ action, data, ...req }); return req.promise })
  history.onLoad(); historyCalls[0].resolve({ digest: null }); await tick()
  history.onSelectTab({ currentTarget: { dataset: { tab: 'history' } } })
  assert.equal(historyCalls[1].action, 'intelDigestHistory')
  historyCalls[1].resolve({ digests: [{ localDate: '2026-10-28', itemCount: 3 }] }); await tick()
  assert.equal(history.data.histories.length, 1)
  assert.equal(history.data.histories[0].itemCount, 3)
  history.onOpenHistoryDate({ currentTarget: { dataset: { date: '2026-10-28' } } })
  assert.equal(historyCalls[2].action, 'intelDigestByDate')
  assert.deepEqual(plain(historyCalls[2].data), { localDate: '2026-10-28' })
  assert.equal(history.data.historyDetailLoading, true)
  historyCalls[2].resolve({ digest: { localDate: '2026-10-28', items: [{ itemId: 'old-1', title: 'Old published item', sourceName: 'Archive source' }] } }); await tick()
  assert.equal(history.data.historyItems[0].itemId, 'old-1')
  history.onBackToHistory()
  assert.equal(history.data.historyLocalDate, '')
  assert.equal(history.data.histories.length, 1)

  history.onOpenHistoryDate({ currentTarget: { dataset: { date: '2026-10-28' } } })
  historyCalls[3].reject({ message: 'archive unavailable' }); await tick()
  assert.equal(history.data.historyDetailError, 'archive unavailable')
  history.onRetry()
  assert.equal(historyCalls[4].action, 'intelDigestByDate', 'retry from an archived day requests that day again')
  historyCalls[4].resolve({ digest: null }); await tick()
  assert.equal(history.data.historyDetailEmpty, true)
  assert.equal(history.data.historyItems.length, 0)

  const pageCalls = []
  const paged = makePage((action, data) => { const req = deferred(); pageCalls.push({ action, data, ...req }); return req.promise })
  paged.onLoad(); pageCalls[0].resolve({ digest: null }); await tick()
  paged.onSelectTab({ currentTarget: { dataset: { tab: 'history' } } })
  pageCalls[1].resolve({ digests: [{ localDate: '2026-10-28', itemCount: 1 }], nextCursor: 'cursor-1' }); await tick()
  assert.equal(paged.data.historyHasMore, true)
  paged.onLoadMoreHistory()
  assert.equal(pageCalls[2].action, 'intelDigestHistory')
  assert.deepEqual(plain(pageCalls[2].data), { limit: 30, cursor: 'cursor-1' })
  paged.onLoadMoreHistory()
  assert.equal(pageCalls.length, 3, 'duplicate load-more taps do not issue duplicate requests')
  pageCalls[2].resolve({ digests: [{ localDate: '2026-10-28', itemCount: 99 }, { localDate: '2026-10-27', itemCount: 2 }], nextCursor: 'cursor-2' }); await tick()
  assert.equal(paged.data.histories.length, 2, 'duplicate dates are not appended')
  assert.equal(paged.data.histories[0].itemCount, 1, 'existing date summary stays stable')
  assert.equal(paged.data.historyCursor, 'cursor-2')
  paged.onLoadMoreHistory(); pageCalls[3].reject({ message: 'offline' }); await tick()
  assert.equal(paged.data.historyMoreError, 'offline')
  assert.equal(paged.data.historyCursor, 'cursor-2', 'failed page retains cursor for retry')
  paged.onRetry(); assert.equal(pageCalls[4].data.cursor, 'cursor-2')
  pageCalls[4].resolve({ digests: [{ localDate: '2026-10-26', itemCount: 0 }], nextCursor: '' }); await tick()
  assert.equal(paged.data.histories.length, 3)
  assert.equal(paged.data.historyHasMore, false, 'empty nextCursor ends pagination')

  const pageRaceCalls = []
  const pageRace = makePage((action, data) => { const req = deferred(); pageRaceCalls.push({ action, data, ...req }); return req.promise })
  pageRace.onLoad(); pageRaceCalls[0].resolve({ digest: null }); await tick()
  pageRace.onSelectTab({ currentTarget: { dataset: { tab: 'history' } } })
  pageRaceCalls[1].resolve({ digests: [{ localDate: '2026-10-28', itemCount: 1 }], nextCursor: 'race-cursor' }); await tick()
  pageRace.onLoadMoreHistory()
  pageRace.onSelectTab({ currentTarget: { dataset: { tab: 'today' } } })
  assert.equal(pageRace.data.historyMoreLoading, false, 'leaving history clears more spinner')
  pageRaceCalls[2].resolve({ digests: [{ localDate: '2026-10-27', itemCount: 3 }], nextCursor: '' }); await tick()
  assert.equal(pageRace.data.histories.length, 1, 'late history page cannot mutate after switching tabs')
  assert.equal(pageRace.data.historyCursor, 'race-cursor')

  const archivedRaceCalls = []
  const archivedRace = makePage((action, data) => { const req = deferred(); archivedRaceCalls.push({ action, data, ...req }); return req.promise })
  archivedRace.onLoad(); archivedRaceCalls[0].resolve({ digest: null }); await tick()
  archivedRace.onSelectTab({ currentTarget: { dataset: { tab: 'history' } } })
  archivedRaceCalls[1].resolve({ digests: [{ localDate: '2026-10-28', itemCount: 1 }, { localDate: '2026-10-27', itemCount: 2 }] }); await tick()
  archivedRace.onOpenHistoryDate({ currentTarget: { dataset: { date: '2026-10-28' } } })
  archivedRace.onBackToHistory()
  archivedRace.onOpenHistoryDate({ currentTarget: { dataset: { date: '2026-10-27' } } })
  assert.equal(archivedRaceCalls.length, 4)
  archivedRaceCalls[2].resolve({ digest: { localDate: '2026-10-28', items: [{ itemId: 'late-archive', title: 'Late' }] } }); await tick()
  assert.equal(archivedRace.data.historyLocalDate, '2026-10-27')
  assert.equal(archivedRace.data.historyDetailLoading, true)
  assert.equal(archivedRace.data.historyItems.length, 0)
  archivedRaceCalls[3].resolve({ digest: { localDate: '2026-10-27', items: [{ itemId: 'current-archive', title: 'Current' }] } }); await tick()
  assert.equal(archivedRace.data.historyItems[0].itemId, 'current-archive')
  archivedRace.onOpenHistoryDate({ currentTarget: { dataset: { date: '2026-10-28' } } })
  archivedRace.onSelectTab({ currentTarget: { dataset: { tab: 'today' } } })
  assert.equal(archivedRace.data.historyDetailLoading, false)
  archivedRaceCalls[4].resolve({ digest: { localDate: '2026-10-28', items: [{ itemId: 'late-tab', title: 'Late tab' }] } }); await tick()
  assert.equal(archivedRace.data.historyItems.length, 0, 'late detail must not restore content after leaving history')

  const todayHistoryCalls = []
  const todayHistory = makePage((action, data) => { const req = deferred(); todayHistoryCalls.push({ action, data, ...req }); return req.promise })
  todayHistory.onLoad()
  assert.equal(todayHistory.data.loading, true)
  todayHistory.onSelectTab({ currentTarget: { dataset: { tab: 'history' } } })
  assert.equal(todayHistory.data.loading, false, 'leaving today clears its pending spinner')
  assert.equal(todayHistory.data.historyLoading, true)
  todayHistory.onSelectTab({ currentTarget: { dataset: { tab: 'today' } } })
  assert.equal(todayHistory.data.historyLoading, false, 'leaving history clears its pending spinner')
  assert.equal(todayHistory.data.loading, true, 'returning to uncached today starts a fresh request')
  assert.equal(todayHistoryCalls.length, 3)
  todayHistoryCalls[0].resolve({ digest: { localDate: '2026-10-29', items: [{ itemId: 'stale-today', title: 'Stale' }] } })
  todayHistoryCalls[1].resolve({ digests: [{ localDate: '2026-10-28', itemCount: 1 }] })
  await tick()
  assert.equal(todayHistory.data.tab, 'today')
  assert.equal(todayHistory.data.loading, true, 'stale today response cannot clear fresh loading state')
  assert.equal(todayHistory.data.historyLoading, false)
  todayHistoryCalls[2].resolve({ digest: { localDate: '2026-10-29', items: [{ itemId: 'fresh-today', title: 'Fresh' }] } })
  await tick()
  assert.equal(todayHistory.data.items[0].itemId, 'fresh-today')
  assert.equal(todayHistory.data.loading, false)

  const historyTodayCalls = []
  const historyToday = makePage((action, data) => { const req = deferred(); historyTodayCalls.push({ action, data, ...req }); return req.promise })
  historyToday.onLoad()
  historyTodayCalls[0].resolve({ digest: null }); await tick()
  historyToday.onSelectTab({ currentTarget: { dataset: { tab: 'history' } } })
  assert.equal(historyToday.data.historyLoading, true)
  historyToday.onSelectTab({ currentTarget: { dataset: { tab: 'today' } } })
  assert.equal(historyToday.data.historyLoading, false)
  assert.equal(historyToday.data.loading, true)
  assert.equal(historyTodayCalls.length, 3)
  historyToday.onSelectTab({ currentTarget: { dataset: { tab: 'history' } } })
  assert.equal(historyToday.data.loading, false)
  assert.equal(historyToday.data.historyLoading, true)
  assert.equal(historyTodayCalls.length, 4, 'returning to uncached history starts a fresh request')
  historyTodayCalls[1].resolve({ digests: [{ localDate: '2026-10-27', itemCount: 99 }] })
  historyTodayCalls[2].resolve({ digest: { localDate: '2026-10-29', items: [{ itemId: 'stale', title: 'Stale' }] } })
  await tick()
  assert.equal(historyToday.data.tab, 'history')
  assert.equal(historyToday.data.historyLoading, true, 'stale history response cannot clear fresh loading state')
  assert.equal(historyToday.data.histories.length, 0)
  historyTodayCalls[3].resolve({ digests: [{ localDate: '2026-10-28', itemCount: 2 }] })
  await tick()
  assert.equal(historyToday.data.histories[0].localDate, '2026-10-28')
  assert.equal(historyToday.data.historyLoading, false)

  const detail = []
  const open = makePage(async () => ({ digest: { localDate: '2026-10-29', items: [] } }), { navigateTo: value => detail.push(value.url) })
  open.onOpenItem({ currentTarget: { dataset: { id: '../bad' } } })
  open.onOpenItem({ currentTarget: { dataset: { id: 'news:1' } } })
  assert.deepEqual(detail, ['/pages/intel-detail/detail?id=news%3A1'])

  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/intel-digest/index.wxml'), 'utf8')
  assert.doesNotMatch(markup, /微信通知|邮件推送|示例资讯/)
  const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
  assert.equal(app.pages.includes('pages/intel-digest/index'), true, 'digest page is registered')

  const configSource = fs.readFileSync(path.join(root, 'miniprogram/config.js'), 'utf8')
  const clientConfig = require(path.join(root, 'miniprogram/config.js'))
  assert.equal(clientConfig.intelDigestEnabled, false, 'digest entry defaults off')
  assert.match(configSource, /intelDigestEnabled:\s*false/)
  const links = []
  const hiddenEntry = makeIntelPage({ intelEnabled: true, intelDemoMode: false, intelDigestEnabled: false }, { navigateTo: value => links.push(value.url) })
  hiddenEntry.onLoad()
  assert.equal(hiddenEntry.data.digestEnabled, false)
  hiddenEntry.onOpenDigest()
  assert.deepEqual(links, [], 'disabled digest entry cannot navigate')
  const visibleEntry = makeIntelPage({ intelEnabled: true, intelDemoMode: false, intelDigestEnabled: true }, { navigateTo: value => links.push(value.url) })
  visibleEntry.onLoad()
  assert.equal(visibleEntry.data.digestEnabled, true)
  visibleEntry.onOpenDigest()
  assert.deepEqual(links, ['/pages/intel-digest/index'], 'enabled digest entry navigates to the registered page')
  const entryMarkup = fs.readFileSync(path.join(root, 'miniprogram/pages/intel/index.wxml'), 'utf8')
  assert.match(entryMarkup, /wx:if="\{\{digestEnabled\}\}"[^>]*onOpenDigest/)
  console.log('intel-digest-page: all assertions passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
