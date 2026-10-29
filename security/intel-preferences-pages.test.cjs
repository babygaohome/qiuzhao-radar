const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const tick = () => Promise.resolve().then(() => Promise.resolve())
const plain = value => JSON.parse(JSON.stringify(value))
function deferred () { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function makePage (relative, api, wx = {}, featureConfig = {}) {
  let definition
  const modules = {
    '../../utils/util.js': { api, copyLink () {} },
    '../../config.js': Object.assign({ intelEnabled: true, intelDemoMode: false, intelDigestEnabled: false }, featureConfig),
    './demo-fixtures.js': [],
    '../intel/demo-fixtures.js': []
  }
  const file = path.join(root, relative)
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page (page) { definition = page }, wx: Object.assign({ navigateTo () {}, showToast () {}, stopPullDownRefresh () {} }, wx),
    require (name) { if (!(name in modules)) throw new Error('unexpected require: ' + name); return modules[name] }
  }, { filename: file })
  return Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData (value) { Object.assign(this.data, value) } })
}

async function preferencesPage () {
  const calls = []
  const page = makePage('miniprogram/pages/intel-preferences/index.js', (action, data) => {
    const req = deferred(); calls.push({ action, data, ...req }); return req.promise
  })
  page.onLoad()
  assert.equal(calls[0].action, 'intelGetPreferences')
  calls[0].resolve({ preferences: { topics: { ai: 1 }, subtopics: ['rag'], blockedTopics: ['rumor'], languages: ['zh'], timezone: 'Asia/Shanghai', digestLocalTime: '08:00', dailyDigestEnabled: false, behaviorLearningEnabled: false, revision: 4 } })
  await tick()
  assert.equal(page.data.loading, false)
  assert.equal(page.data.topicChoices.find(item => item.key === 'ai').selected, true)
  assert.deepEqual(Array.from(page.data.blockedTopics), ['rumor'])
  page.onLearningChange({ detail: { value: true } })
  assert.equal(page.data.behaviorLearningEnabled, false, 'learning stays closed when a user tries to enable collection')
  page.onToggleTopic({ currentTarget: { dataset: { key: 'semiconductor' } } })
  page.onToggleSubtopic({ currentTarget: { dataset: { key: 'rag' } } })
  page.onSave()
  assert.equal(calls[1].action, 'intelSavePreferences')
  assert.equal(calls[1].data.revision, 4)
  assert.deepEqual(Object.keys(calls[1].data.preferences).sort(), ['behaviorLearningEnabled', 'blockedTopics', 'dailyDigestEnabled', 'digestLocalTime', 'languages', 'subtopics', 'timezone', 'topics'].sort())
  assert.deepEqual(Array.from(calls[1].data.preferences.languages), ['zh'])
  assert.deepEqual(Array.from(calls[1].data.preferences.blockedTopics), ['rumor'])
  assert.equal(calls[1].data.preferences.behaviorLearningEnabled, false, 'MVP must never enable implicit behavior collection')
  calls[1].resolve({ ok: true, revision: 5, preferences: Object.assign({}, calls[1].data.preferences, { revision: 5 }) })
  await tick()
  assert.equal(page.data.revision, 5)
  assert.equal(page.data.saved, true)
  page.applyPreferences({ behaviorLearningEnabled: true, revision: 5 })
  page.onLearningChange({ detail: { value: false } })
  assert.equal(page.data.behaviorLearningEnabled, false, 'an existing learning setting can be turned off')
  page.onSave()
  assert.equal(calls[2].data.preferences.behaviorLearningEnabled, false)
  calls[2].resolve({ ok: true, revision: 6, preferences: Object.assign({}, calls[2].data.preferences, { revision: 6 }) })
  await tick()

  const failed = makePage('miniprogram/pages/intel-preferences/index.js', () => Promise.reject({ message: 'offline' }))
  failed.onLoad(); await tick()
  assert.equal(failed.data.error, 'offline')
  assert.equal(failed.data.loaded, false)

  const digestOff = makePage('miniprogram/pages/intel-preferences/index.js', () => Promise.resolve({}), {}, { intelDigestEnabled: false })
  const digestOn = makePage('miniprogram/pages/intel-preferences/index.js', () => Promise.resolve({}), {}, { intelDigestEnabled: true })
  assert.equal(digestOff.data.digestReady, false)
  assert.equal(digestOn.data.digestReady, true)
}

async function feedbackPages () {
  const requests = []
  const list = makePage('miniprogram/pages/intel/index.js', (action, data) => {
    const req = deferred(); requests.push({ action, data, ...req }); return req.promise
  })
  list.onLoad()
  list.setData({ items: [{ id: 'item-1', feedback: { liked: false, bookmarked: false, disliked: false } }] })
  list.onFeedback({ currentTarget: { dataset: { id: 'item-1', action: 'bookmark' } } })
  assert.equal(requests[0].action, 'intelFeedback')
  assert.deepEqual(plain(requests[0].data), { itemId: 'item-1', feedbackAction: 'bookmark' })
  requests[0].resolve({ ok: true, state: { liked: false, bookmarked: true, disliked: false } }); await tick()
  assert.equal(list.data.items[0].feedback.bookmarked, true)
  list.onFeedback({ currentTarget: { dataset: { id: 'item-1', action: 'unbookmark' } } })
  requests[1].resolve({ ok: true, state: { liked: false, bookmarked: false, disliked: false } }); await tick()
  assert.equal(list.data.items[0].feedback.bookmarked, false, 'inverse action supports undo')
  list.onFeedback({ currentTarget: { dataset: { id: 'item-1', action: 'like' } } })
  requests[2].reject({ message: 'network down' }); await tick()
  assert.equal(list.data.items[0].feedback.liked, false, 'failed feedback keeps prior state')
  assert.equal(list.data.items[0].feedbackError, 'network down')

  const detailCalls = []
  const detail = makePage('miniprogram/pages/intel-detail/detail.js', (action, data) => {
    const req = deferred(); detailCalls.push({ action, data, ...req }); return req.promise
  })
  detail.onLoad({ id: 'item-2' })
  detailCalls[0].resolve({ item: { id: 'item-2', title: 'Title', feedback: { liked: true } } }); await tick()
  detail.onFeedback({ currentTarget: { dataset: { action: 'unlike' } } })
  assert.deepEqual(plain(detailCalls[1].data), { itemId: 'item-2', feedbackAction: 'unlike' })
  detailCalls[1].resolve({ state: { liked: false, bookmarked: false, disliked: false } }); await tick()
  assert.equal(detail.data.item.feedback.liked, false)
}

function copyClaims () {
  const preferenceCopy = fs.readFileSync(path.join(root, 'miniprogram/pages/intel-preferences/index.wxml'), 'utf8')
  const feedCopy = fs.readFileSync(path.join(root, 'miniprogram/pages/intel/index.wxml'), 'utf8')
  assert.match(preferenceCopy, /已选频道的内容会优先排在列表前面/)
  assert.match(preferenceCopy, /细分兴趣、资讯语言和显式反馈目前只保存，不参与筛选或排序/)
  assert.match(preferenceCopy, /当前版本尚未开放每日简报/)
  assert.match(preferenceCopy, /当前版本尚未用这些反馈调整推荐顺序/)
  assert.match(preferenceCopy, /当前版本不会收集阅读行为/)
  assert.match(preferenceCopy, /wx:if="\{\{digestReady\}\}"[^>]*>每小时检查一次；到达你设置的时间后生成站内简报/)
  assert.match(preferenceCopy, /wx:else class="preferences-hint">当前版本尚未开放每日简报/)
  assert.match(feedCopy, /行业情报/)
  assert.match(feedCopy, /class="intel-settings-link intel-digest-link"/)
  assert.doesNotMatch(feedCopy, /今日情报|DAILY BRIEFING/i)
}

Promise.resolve().then(preferencesPage).then(feedbackPages).then(copyClaims).then(() => {
  process.stdout.write('InfoFlow preferences, explicit-only learning, feedback and undo behavior: PASS\n')
}).catch(error => { console.error(error); process.exitCode = 1 })
