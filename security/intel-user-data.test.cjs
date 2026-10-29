'use strict'

// Uses the production API handlers with the established in-memory CloudBase harness.
// No cloud writes, external network, or resume/profile-derived preference inference.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createIntelHandlers } = require('../cloudfunctions/api/intel/handlers')
const { readOptionalDocument } = require('../cloudfunctions/api/intel/preferences')
const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(__dirname, 'isolation.test.cjs'), 'utf8').split('let passed = 0')[0]
const box = { require, __dirname, console, Buffer, URL, setTimeout, clearTimeout }
vm.createContext(box)
vm.runInNewContext(source + '\nthis.harness = harness', box)

async function test () {
  const h = box.harness()
  const rawCollection = h.db.collection.bind(h.db)
  h.db.collection = name => {
    const collection = rawCollection(name)
    if (!['intel_preferences', 'intel_feedback'].includes(name)) return collection
    return new Proxy(collection, { get (target, key) {
      if (key === 'doc') return id => {
        const doc = target.doc(id)
        return new Proxy(doc, { get (document, method) {
          if (method === 'get') return async () => {
            try { return await document.get() } catch (error) {
              if (error && error.message === 'not found') throw Object.assign(new Error(`document.get:fail document with _id ${id} does not exist`), { code: -1 })
              throw error
            }
          }
          const value = Reflect.get(document, method)
          return typeof value === 'function' ? value.bind(document) : value
        } })
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  const createdCollections = []
  const originalCreateCollection = h.db.createCollection.bind(h.db)
  h.db.createCollection = async name => { createdCollections.push(name); return originalCreateCollection(name) }
  const saveA = await h.call('A', 'intelSavePreferences', { revision: 0, preferences: { topics: { ai: 0.7, jobs: 0.3 }, subtopics: ['rag'], behaviorLearningEnabled: false } })
  assert.equal(saveA.ok, true)
  assert.equal(saveA.revision, 1)
  assert.equal(saveA.preferences.behaviorLearningEnabled, false)
  assert.equal((await h.call('A', 'intelGetPreferences')).preferences.topics.ai, 0.7)
  assert.equal(createdCollections.some(name => /^intel_/.test(name)), false, 'API must not auto-create InfoFlow collections')

  // Digest scheduling generation changes only on real enablement transitions and deletion.
  const digestPrefs = await h.call('G', 'intelSavePreferences', { revision: 0, preferences: { topics: { ai: 1 } } })
  assert.equal(digestPrefs.ok, true)
  assert.equal(Object.hasOwn(digestPrefs.preferences, 'digestGeneration'), false, 'internal digest generation must not be returned')
  assert.equal(h.table('intel_preferences').get('G').digestGeneration, 0, 'new preference starts digest generation at zero')
  assert.equal((await h.call('G', 'intelFeedback', { itemId: 'digest-feedback', feedbackAction: 'like' })).ok, true)
  const feedbackBeforeToggle = [...h.table('intel_feedback').values()].find(row => row.openid === 'G')
  assert.equal(feedbackBeforeToggle.generation, 0)

  const digestEnabled = await h.call('G', 'intelSavePreferences', { revision: 1, preferences: { dailyDigestEnabled: true } })
  assert.equal(digestEnabled.ok, true)
  assert.equal(h.table('intel_preferences').get('G').digestGeneration, 1)
  assert.equal(h.table('intel_preferences').get('G').generation, 0, 'digest enablement must not change feedback generation')
  const unchangedDigestFlag = await h.call('G', 'intelSavePreferences', { revision: 2, preferences: { timezone: 'Australia/Brisbane' } })
  assert.equal(unchangedDigestFlag.ok, true)
  assert.equal(h.table('intel_preferences').get('G').digestGeneration, 1, 'ordinary preference updates do not change digest generation')
  assert.equal((await h.call('G', 'intelSavePreferences', { revision: 3, preferences: { dailyDigestEnabled: false } })).ok, true)
  assert.equal(h.table('intel_preferences').get('G').digestGeneration, 2, 'disabling advances digest generation')
  assert.equal((await h.call('G', 'intelSavePreferences', { revision: 4, preferences: { dailyDigestEnabled: true } })).ok, true)
  assert.equal(h.table('intel_preferences').get('G').digestGeneration, 3, 're-enabling after disable advances digest generation')
  assert.equal(h.table('intel_preferences').get('G').generation, 0, 'digest toggles leave feedback generation unchanged')
  assert.equal((await h.call('G', 'intelFeedback', { itemId: 'digest-feedback', feedbackAction: 'bookmark' })).state.liked, true, 'feedback remains available across digest toggles')
  assert.equal(h.table('intel_feedback').get(feedbackBeforeToggle._id).generation, 0)
  const digestExport = await h.call('G', 'exportMine')
  assert.equal(Object.hasOwn(digestExport.intel.preferences, 'digestGeneration'), false, 'internal digest generation must not be exported')
  const deletedDigestPrefs = await h.call('G', 'deleteAllMine', { confirm: '确认删除' })
  assert.equal(deletedDigestPrefs.error, undefined)
  assert.equal(h.table('intel_preferences').get('G').digestGeneration, 4, 'deletion advances digest generation')
  const digestRestartState = await h.call('G', 'intelGetPreferences')
  assert.equal(Object.hasOwn(digestRestartState.preferences, 'digestGeneration'), false, 'tombstone generation is private')
  assert.equal((await h.call('G', 'intelSavePreferences', { revision: digestRestartState.preferences.revision, preferences: { dailyDigestEnabled: true } })).ok, true)
  assert.equal(h.table('intel_preferences').get('G').digestGeneration, 5, 'restart after deletion must continue rather than reset digest generation')
  assert.equal(h.table('intel_preferences').get('G').generation, 1, 'restart preserves established feedback generation semantics')
  const digestRestartFeedback = await h.call('G', 'intelFeedback', { itemId: 'digest-feedback', feedbackAction: 'like' })
  assert.equal(digestRestartFeedback.ok, true, 'feedback remains available after explicitly re-enabling preferences')
  assert.equal(digestRestartFeedback.state.liked, true)
  assert.equal([...h.table('intel_feedback').values()].find(row => row.openid === 'G').generation, 1)

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

  h.table('intel_digests').set('digest-a', {
    _id: 'digest-a', openid: 'A', localDate: '2026-10-29', timezone: 'Asia/Shanghai',
    algorithmVersion: 'm4-test', itemIds: ['item-a'], jobCompanyIds: ['company-a'],
    generatedAt: '2026-10-29T01:00:00.000Z', status: 'ready', readAt: '2026-10-29T02:00:00.000Z',
    generation: 0, digestGeneration: 2
  })
  const exported = await h.call('A', 'exportMine')
  assert.equal(exported.intel.preferences.topics.ai, 0.7)
  assert.equal(exported.intel.feedback.length, 2)
  assert.equal(exported.intel.digests[0].readAt, '2026-10-29T02:00:00.000Z', 'digest read state is included in personal export')
  assert.equal(Object.hasOwn(exported.intel.digests[0], 'digestGeneration'), false, 'internal digest generation is not exported')
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

  // Only the SDK's exact missing-document error may produce the empty preference state.
  const getError = error => ({ collection: () => ({ doc: () => ({ get: async () => { throw error } }) }) })
  assert.equal(await readOptionalDocument(getError(Object.assign(new Error('document with _id test-user does not exist'), { code: -1 })), 'intel_preferences', 'test-user'), null)
  assert.equal(await readOptionalDocument(getError(Object.assign(new Error('document absent'), { errCode: 'DATABASE_DOCUMENT_NOT_EXIST' })), 'intel_preferences', 'test-user'), null)
  await assert.rejects(readOptionalDocument(getError(Object.assign(new Error('document with _id test-user does not exist'), { code: -502005 })), 'intel_preferences', 'test-user'))
  await assert.rejects(readOptionalDocument(getError(Object.assign(new Error('permission denied: document with _id test-user does not exist'), { code: -1 })), 'intel_preferences', 'test-user'))
  await assert.rejects(readOptionalDocument(getError(Object.assign(new Error('collection intel_preferences does not exist'), { code: -1 })), 'intel_preferences', 'test-user'))
  await assert.rejects(readOptionalDocument(getError(Object.assign(new Error('document does not exist'), { code: -1 })), 'intel_preferences', 'test-user'))

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

  // An in-flight deletion must preserve a digest created after re-enabling the account.
  await h.call('Z', 'intelSavePreferences', { revision: 0, preferences: { dailyDigestEnabled: true } })
  h.table('intel_digests').set('z-legacy', { _id: 'z-legacy', openid: 'Z', localDate: '2026-10-28', itemIds: ['legacy'] })
  h.table('intel_digests').set('z-old', { _id: 'z-old', openid: 'Z', generation: 0, localDate: '2026-10-29', itemIds: ['old'] })
  h.table('intel_digests').set('b-new', { _id: 'b-new', openid: 'B', generation: 1, localDate: '2026-10-29', itemIds: ['b'] })
  let reachedDigestSweepResolve, resumeDigestSweepResolve
  const reachedDigestSweep = new Promise(resolve => { reachedDigestSweepResolve = resolve })
  const resumeDigestSweep = new Promise(resolve => { resumeDigestSweepResolve = resolve })
  const beforeDigestRace = h.db.collection.bind(h.db)
  let heldFirstDigestRemove = false
  h.db.collection = name => {
    const collection = beforeDigestRace(name)
    if (name !== 'intel_digests') return collection
    return new Proxy(collection, { get (target, key) {
      if (key === 'where') return condition => {
        const query = target.where(condition)
        return new Proxy(query, { get (queryTarget, queryKey) {
          if (queryKey === 'remove') return async () => {
            if (!heldFirstDigestRemove) {
              heldFirstDigestRemove = true
              reachedDigestSweepResolve()
              await resumeDigestSweep
            }
            return queryTarget.remove()
          }
          const value = Reflect.get(queryTarget, queryKey)
          return typeof value === 'function' ? value.bind(queryTarget) : value
        } })
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  const deletingZ = h.call('Z', 'deleteAllMine', { confirm: '确认删除' })
  await reachedDigestSweep
  const zTombstone = await h.call('Z', 'intelGetPreferences')
  assert.equal((await h.call('Z', 'intelSavePreferences', { revision: zTombstone.preferences.revision, preferences: { dailyDigestEnabled: true } })).ok, true)
  h.table('intel_digests').set('z-fresh', { _id: 'z-fresh', openid: 'Z', generation: 1, localDate: '2026-10-29', itemIds: ['fresh'] })
  resumeDigestSweepResolve()
  assert.equal((await deletingZ).error, undefined)
  h.db.collection = beforeDigestRace
  const remainingDigests = [...h.table('intel_digests').values()]
  assert.equal(remainingDigests.some(row => row._id === 'z-legacy'), false, 'delete removes legacy digests without a generation')
  assert.equal(remainingDigests.some(row => row._id === 'z-old'), false, 'delete removes digests from the tombstoned generation')
  assert.equal(remainingDigests.some(row => row._id === 'z-fresh'), true, 'delete must preserve a digest from the re-enabled generation')
  assert.equal(remainingDigests.some(row => row._id === 'b-new'), true, 'delete must preserve another account digest')
}

test().then(() => process.stdout.write('intel-user-data: all assertions passed\n')).catch(error => { console.error(error); process.exitCode = 1 })
