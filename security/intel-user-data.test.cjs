'use strict'

// Uses the production API handlers with the established in-memory CloudBase harness.
// No cloud writes, external network, or resume/profile-derived preference inference.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createIntelHandlers } = require('../cloudfunctions/api/intel/handlers')
const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(__dirname, 'isolation.test.cjs'), 'utf8').split('let passed = 0')[0]
const box = { require, __dirname, console, Buffer, URL, setTimeout, clearTimeout }
vm.createContext(box)
vm.runInNewContext(source + '\nthis.harness = harness', box)

async function test () {
  const h = box.harness()
  const createdCollections = []
  const originalCreateCollection = h.db.createCollection.bind(h.db)
  h.db.createCollection = async name => { createdCollections.push(name); return originalCreateCollection(name) }
  const saveA = await h.call('A', 'intelSavePreferences', { revision: 0, preferences: { topics: { ai: 0.7, jobs: 0.3 }, subtopics: ['rag'], behaviorLearningEnabled: false } })
  assert.equal(saveA.ok, true)
  assert.equal(saveA.revision, 1)
  assert.equal(saveA.preferences.behaviorLearningEnabled, false)
  assert.equal((await h.call('A', 'intelGetPreferences')).preferences.topics.ai, 0.7)
  assert.equal(createdCollections.some(name => /^intel_/.test(name)), false, 'API must not auto-create InfoFlow collections')

  const feedRows = [
    { id: 'semi-new', category: 'semiconductor', status: 'published', publishedAt: '2026-10-29T00:00:00Z', title: 'New semiconductor' },
    { id: 'ai-old', category: 'ai', status: 'published', publishedAt: '2026-10-20T00:00:00Z', title: 'Older AI' },
    { id: 'ai-older', category: 'ai', status: 'published', publishedAt: '2026-10-10T00:00:00Z', title: 'Old AI' }
  ]
  const feedApi = createIntelHandlers({
    db: h.db,
    enabled: true,
    cursorSecret: 'm3-feed-cursor-secret-with-more-than-32-bytes',
    readItems: async () => feedRows,
    now: () => Date.now()
  })
  await h.call('U', 'intelSavePreferences', { revision: 0, preferences: { topics: { ai: 1 } } })
  const subscribedFirst = await feedApi.intelFeed({ category: 'all', limit: 1 }, 'U')
  assert.equal(subscribedFirst.items[0].id, 'ai-old', 'explicitly subscribed topics precede newer unselected topics')
  assert.equal(subscribedFirst.items[0].feedback.liked, false)
  assert.equal((await feedApi.intelFeed({ category: 'all', limit: 1, cursor: subscribedFirst.nextCursor }, 'U')).items[0].id, 'ai-older', 'the next subscribed item remains ahead of newer unselected topics')
  await h.call('U', 'intelSavePreferences', { revision: 1, preferences: { topics: { semiconductor: 1 } } })
  assert.equal((await feedApi.intelFeed({ category: 'all', limit: 1, cursor: subscribedFirst.nextCursor }, 'U')).error, 'conflict', 'preference changes invalidate the personalized pagination snapshot')
  await h.call('U', 'intelSavePreferences', { revision: 2, preferences: { topics: { ai: 1 } } })
  const cursorBeforeFeedback = await feedApi.intelFeed({ category: 'all', limit: 1 }, 'U')
  await h.call('U', 'intelFeedback', { itemId: 'ai-old', feedbackAction: 'like' })
  assert.equal((await feedApi.intelFeed({ category: 'all', limit: 1, cursor: cursorBeforeFeedback.nextCursor }, 'U')).error, 'conflict', 'feedback changes invalidate the personalized pagination snapshot')
  const subscribedFresh = await feedApi.intelFeed({ category: 'all', limit: 1 }, 'U')
  assert.equal(subscribedFresh.items[0].feedback.liked, true)
  await h.call('B', 'intelFeedback', { itemId: 'ai-old', feedbackAction: 'dislike' })
  const accountBPage = await feedApi.intelFeed({ category: 'all', limit: 20 }, 'B')
  assert.equal(accountBPage.items[0].id, 'semi-new', 'no topic selection preserves date/id order')
  assert.equal(accountBPage.items.find(row => row.id === 'ai-old').feedback.disliked, true)
  assert.equal(accountBPage.items.find(row => row.id === 'ai-old').feedback.liked, false, 'feedback is account-isolated')
  assert.equal((await feedApi.intelFeed({ category: 'all', limit: 1, cursor: subscribedFresh.nextCursor }, 'B')).error, 'bad_request', 'pagination cursors are account-bound')
  assert.deepEqual(await h.call('A', 'intelSavePreferences', { revision: 0, preferences: { topics: { ai: 1 } } }).then(x => x.error), 'conflict')
  assert.equal((await h.call('A', 'intelSavePreferences', { revision: 1, preferences: { openid: 'B' } })).error, 'bad_request')
  assert.equal((await h.call('A', 'intelSavePreferences', { revision: 1, preferences: { behaviorLearningEnabled: true } })).error, 'bad_request')

  const [like1, like2] = await Promise.all([
    h.call('A', 'intelFeedback', { itemId: 'article-1', feedbackAction: 'like' }),
    h.call('A', 'intelFeedback', { itemId: 'article-1', feedbackAction: 'bookmark' })
  ])
  assert.equal(like1.state.liked, true)
  assert.equal(like2.state.bookmarked, true)
  assert.equal([...h.table('intel_feedback').values()].find(x => x.openid === 'A').state.bookmarked, true)
  assert.equal((await h.call('A', 'intelFeedback', { itemId: 'article-1', feedbackAction: 'bookmark' })).state.bookmarked, true)
  assert.equal((await h.call('A', 'intelFeedback', { itemId: 'article-1', feedbackAction: 'unlike' })).state.liked, false)
  assert.equal((await h.call('A', 'intelFeedback', { itemId: 'article-1', feedbackAction: 'unbookmark' })).state.bookmarked, false)
  await h.call('B', 'intelFeedback', { itemId: 'article-1', feedbackAction: 'dislike' })
  assert.equal([...h.table('intel_feedback').values()].filter(x => x.openid === 'A').length, 1)
  assert.equal([...h.table('intel_feedback').values()].filter(x => x.openid === 'B' && x.itemId === 'article-1').length, 1)
  const limited = await h.call('A', 'intelFeedback', { itemId: 'article-rate', feedbackAction: 'like' })
  // A has already made five feedback writes; continue to the per-user daily ceiling.
  let last
  for (let n = 0; n < 114; n++) last = await h.call('A', 'intelFeedback', { itemId: 'article-rate', feedbackAction: 'like' })
  assert.equal(limited.ok, true)
  assert.equal(last.ok, true)
  assert.equal((await h.call('A', 'intelFeedback', { itemId: 'article-rate', feedbackAction: 'like' })).error, 'intelFeedback_limit')

  const exported = await h.call('A', 'exportMine')
  assert.equal(exported.intel.preferences.topics.ai, 0.7)
  assert.equal(exported.intel.feedback.length, 2)
  assert.equal(JSON.stringify(exported.intel).includes('B'), false)

  // Competing preference writes with the same revision: exactly one can commit.
  const writes = await Promise.all([
    h.call('A', 'intelSavePreferences', { revision: 1, preferences: { timezone: 'Australia/Brisbane' } }),
    h.call('A', 'intelSavePreferences', { revision: 1, preferences: { timezone: 'Asia/Tokyo' } })
  ])
  assert.equal(writes.filter(x => x.ok).length, 1)
  assert.equal(writes.filter(x => x.error === 'conflict').length, 1)

  // Delete A while B's records are present; only A's new collections are removed.
  await h.call('A', 'deleteAllMine', { confirm: '确认删除', openid: 'B' })
  assert.equal([...h.table('intel_feedback').values()].filter(x => x.openid === 'A').length, 0)
  assert.equal(h.table('intel_preferences').get('A').topics, undefined, 'delete must erase the stored preference payload')
  assert.equal([...h.table('intel_feedback').values()].filter(x => x.openid === 'B').length, 2)
  assert.equal((await h.call('A', 'intelFeedback', { itemId: 'article-2', feedbackAction: 'like' })).error, 'gone')
  const after = await h.call('A', 'exportMine')
  assert.equal(after.intel.preferences, null)
  assert.equal(after.intel.feedback.length, 0)
  assert.equal((await h.call('B', 'intelGetPreferences')).preferences.behaviorLearningEnabled, false)

  // A user can explicitly start a fresh preference set after deleting their data.
  const deletedPreferences = await h.call('A', 'intelGetPreferences')
  const restarted = await h.call('A', 'intelSavePreferences', { revision: deletedPreferences.preferences.revision, preferences: { subtopics: ['agents'] } })
  assert.equal(restarted.ok, true)
  assert.equal((await h.call('A', 'intelGetPreferences')).preferences.subtopics[0], 'agents')

  // Failure injection: deletion must return an error if a new collection cannot be swept.
  await h.call('D', 'intelFeedback', { itemId: 'article-delete-failure', feedbackAction: 'like' })
  const originalDbCollection = h.db.collection.bind(h.db)
  const injectQueryFailure = (collectionName, method, message) => {
    h.db.collection = name => {
      const collection = originalDbCollection(name)
      if (name !== collectionName) return collection
      function wrap (query) {
        return new Proxy(query, { get (target, key) {
          if (key === method) return async () => { throw new Error(message) }
          const value = Reflect.get(target, key)
          if (['where', 'field', 'orderBy', 'skip', 'limit'].includes(key) && typeof value === 'function') return (...args) => wrap(value.apply(target, args))
          return typeof value === 'function' ? value.bind(target) : value
        } })
      }
      return new Proxy(collection, { get (target, key) {
        if (key === 'where') return (...args) => wrap(target.where(...args))
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
  }
  injectQueryFailure('intel_feedback', 'remove', 'injected delete failure')
  const deleteFailed = await h.call('D', 'deleteAllMine', { confirm: '确认删除' })
  h.db.collection = originalDbCollection
  assert.equal(deleteFailed.error, 'server_error')
  assert.equal([...h.table('intel_feedback').values()].some(x => x.openid === 'D'), true, 'failed delete must not claim success or hide retained data')

  // Export failures must propagate instead of producing an apparently empty backup.
  injectQueryFailure('intel_feedback', 'get', 'injected export failure')
  const exportFailed = await h.call('D', 'exportMine')
  h.db.collection = originalDbCollection
  assert.equal(exportFailed.error, 'server_error')
  assert.equal(exportFailed.intel, undefined)

  const initialWrites = await Promise.all([
    h.call('E', 'intelSavePreferences', { revision: 0, preferences: { subtopics: ['rag'] } }),
    h.call('E', 'intelSavePreferences', { revision: 0, preferences: { subtopics: ['agents'] } })
  ])
  assert.equal(initialWrites.filter(x => x.ok).length, 1, 'first-time preference creation must be atomic')
  assert.equal(initialWrites.filter(x => x.error === 'conflict').length, 1)

  // A missing configured collection is a server error, not an empty preference record.
  h.db.collection = name => {
    if (name === 'intel_preferences') throw new Error('database collection not exist')
    return originalDbCollection(name)
  }
  assert.equal((await h.call('E', 'intelGetPreferences')).error, 'server_error')
  h.db.collection = originalDbCollection

  // Two simultaneous deletes must each commit a unique generation/revision increment.
  const [deleteOne, deleteTwo] = await Promise.all([
    h.call('X', 'deleteAllMine', { confirm: '确认删除' }),
    h.call('X', 'deleteAllMine', { confirm: '确认删除' })
  ])
  assert.equal(deleteOne.error, undefined)
  assert.equal(deleteTwo.error, undefined)
  assert.equal(h.table('intel_preferences').get('X').generation, 2)
  assert.equal(h.table('intel_preferences').get('X').revision, 2)

  // Force an old-generation feedback insert to finish after deletion and re-enable.
  let enteredResolve, releaseResolve
  const entered = new Promise(resolve => { enteredResolve = resolve })
  const gate = new Promise(resolve => { releaseResolve = resolve })
  const originalCollection = h.db.collection.bind(h.db)
  h.db.collection = name => {
    const collection = originalCollection(name)
    if (name !== 'intel_feedback') return collection
    return new Proxy(collection, { get (target, key) {
      if (key === 'add') return async args => {
        if (args.data.generation === 0) { enteredResolve(); await gate }
        return target.add(args)
      }
      return target[key]
    } })
  }
  const racedWrite = h.call('C', 'intelFeedback', { itemId: 'article-race', feedbackAction: 'like' })
  await entered
  await h.call('C', 'deleteAllMine', { confirm: '确认删除' })
  const cDeletedPreferences = await h.call('C', 'intelGetPreferences')
  assert.equal((await h.call('C', 'intelSavePreferences', { revision: cDeletedPreferences.preferences.revision, preferences: { subtopics: ['rag'] } })).ok, true)
  const newGenerationWrite = await h.call('C', 'intelFeedback', { itemId: 'article-race', feedbackAction: 'bookmark' })
  assert.equal(newGenerationWrite.state.bookmarked, true)
  releaseResolve()
  assert.equal((await racedWrite).error, 'gone')
  const cRecords = [...h.table('intel_feedback').values()].filter(x => x.openid === 'C')
  assert.equal(cRecords.length, 1)
  assert.equal(cRecords[0].generation, 1)
  assert.equal(cRecords[0].state.bookmarked, true, 'old-generation cleanup must never delete the new record')
}

test().then(() => process.stdout.write('intel-user-data: all assertions passed\n')).catch(error => { console.error(error); process.exitCode = 1 })
