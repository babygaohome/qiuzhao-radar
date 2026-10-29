'use strict'

const crypto = require('crypto')

const FIELDS = new Set(['topics', 'subtopics', 'blockedTopics', 'languages', 'timezone', 'digestLocalTime', 'dailyDigestEnabled', 'behaviorLearningEnabled'])
const FEEDBACK_ACTIONS = new Set(['like', 'unlike', 'bookmark', 'unbookmark', 'dislike', 'undislike'])
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOPICS = new Set(['jobs', 'ai', 'semiconductor', 'electronics'])
const SUBTOPIC = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/

function fail (code, message, extra) { return Object.assign({ error: code, message }, extra || {}) }
function isObject (x) { return !!x && typeof x === 'object' && !Array.isArray(x) }
function isMissingDocument (error) {
  const message = String(error && (error.message || error.errMsg || error))
  if (/permission|denied|collection.*(?:not exist|not found)|database collection not exist/i.test(message)) return false
  const code = error && (error.errCode !== undefined ? error.errCode : error.code)
  if (code === 'DATABASE_DOCUMENT_NOT_EXIST') return true
  return code === -1 && /document with _id .+ does not exist/i.test(message)
}
async function readOptionalDocument (db, collection, id) {
  try { const result = await db.collection(collection).doc(id).get(); return result && result.data || null } catch (error) {
    if (isMissingDocument(error)) return null
    throw error
  }
}
async function markIntelDeleted (db, openid, command, now) {
  const col = db.collection('intel_preferences')
  for (let attempt = 0; attempt < 5; attempt++) {
    const old = await readOptionalDocument(db, 'intel_preferences', openid)
    const revision = old && Number.isSafeInteger(old.revision) ? old.revision : 0
    const generation = old && Number.isSafeInteger(old.generation) ? old.generation : 0
    const next = { deleted: true, generation: generation + 1, revision: revision + 1, deletedAt: now() }
    if (!old) {
      try { await col.add({ data: Object.assign({ _id: openid }, next) }); return { previousGeneration: generation, generation: generation + 1 } } catch (error) {
        if (/duplicate|already exists|_id.*exist/i.test(String(error && (error.message || error.errMsg || error)))) continue
        throw error
      }
    }
    const condition = { _id: openid }
    condition.revision = old.revision === undefined ? command.exists(false) : old.revision
    const removeFields = Object.fromEntries([...FIELDS, 'updatedAt'].map(key => [key, command.remove()]))
    const result = await col.where(condition).update({ data: Object.assign({}, removeFields, next) })
    if (result && result.stats && result.stats.updated) return { previousGeneration: generation, generation: generation + 1 }
  }
  const error = new Error('个人情报数据正被并发修改，请重试删除')
  error.code = 'conflict'
  throw error
}
function feedbackId (openid, itemId, generation) {
  const scope = generation ? openid + '\0' + generation + '\0' + itemId : openid + '\0' + itemId
  return crypto.createHash('sha256').update(scope).digest('hex')
}
function defaultPreferences () { return { topics: {}, subtopics: [], blockedTopics: [], languages: ['zh', 'en'], timezone: 'Asia/Shanghai', digestLocalTime: '08:00', dailyDigestEnabled: false, behaviorLearningEnabled: false, revision: 0 } }
function preferenceView (data) {
  const out = defaultPreferences()
  for (const key of [...FIELDS, 'revision']) if (data && data[key] !== undefined) out[key] = data[key]
  return out
}

function validatePreferences (input) {
  if (!isObject(input) || Object.keys(input).some(key => !FIELDS.has(key))) return null
  const out = {}
  if (input.topics !== undefined) {
    if (!isObject(input.topics) || Object.keys(input.topics).some(key => !TOPICS.has(key)) || Object.values(input.topics).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) return null
    out.topics = input.topics
  }
  for (const key of ['subtopics', 'blockedTopics']) {
    if (input[key] !== undefined) {
      if (!Array.isArray(input[key]) || input[key].length > 100 || input[key].some(x => typeof x !== 'string' || !SUBTOPIC.test(x))) return null
      out[key] = [...new Set(input[key])]
    }
  }
  if (input.languages !== undefined) {
    if (!Array.isArray(input.languages) || input.languages.length > 10 || input.languages.some(x => !['zh', 'en', 'ja', 'ko'].includes(x))) return null
    out.languages = [...new Set(input.languages)]
  }
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || input.timezone.length > 64 || !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(input.timezone)) return null
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }) } catch (_) { return null }
    out.timezone = input.timezone
  }
  if (input.digestLocalTime !== undefined) {
    if (typeof input.digestLocalTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.digestLocalTime)) return null
    out.digestLocalTime = input.digestLocalTime
  }
  for (const key of ['dailyDigestEnabled', 'behaviorLearningEnabled']) if (input[key] !== undefined) {
    if (typeof input[key] !== 'boolean') return null
    // Implicit behavioral signals are not collected in this MVP.
    if (key === 'behaviorLearningEnabled' && input[key] === true) return null
    out[key] = input[key]
  }
  return out
}

function createPreferenceHandlers (options) {
  const { db } = options
  const takeLimit = options.takeLimit || (async () => {})
  const now = options.now || (() => new Date().toISOString())
  async function intelGetPreferences (_, openid) {
    const data = await readOptionalDocument(db, 'intel_preferences', openid)
    if (data && data.deleted === true) return { preferences: preferenceView({ revision: data.revision || 0 }), learningState: 'disabled' }
    const prefs = preferenceView(data)
    return { preferences: prefs, learningState: 'disabled' }
  }
  async function intelSavePreferences (event, openid) {
    if (!isObject(event) || !isObject(event.preferences) || !Number.isSafeInteger(event.revision) || event.revision < 0) return fail('bad_request', '偏好设置无效')
    const patch = validatePreferences(event.preferences)
    if (!patch) return fail('bad_request', '包含不支持的偏好设置')
    const col = db.collection('intel_preferences')
    const oldResult = await readOptionalDocument(db, 'intel_preferences', openid)
    await takeLimit(openid, 'intelPreferences', 30)
    const old = Object.assign(defaultPreferences(), oldResult || {})
    if (old.revision !== event.revision) return fail('conflict', '偏好已在其他设备更新，请刷新后重试', { revision: old.revision, preferences: old })
    const next = Object.assign({}, patch, { revision: old.revision + 1, updatedAt: now() })
    if (oldResult) {
      const updateData = Object.assign({}, next, { deleted: false, generation: oldResult.generation || 0 })
      const updated = await col.where({ _id: openid, revision: old.revision }).update({ data: updateData })
      if (!updated || !updated.stats || !updated.stats.updated) {
        const current = await readOptionalDocument(db, 'intel_preferences', openid)
        const prefs = preferenceView(current)
        return fail('conflict', '偏好已在其他设备更新，请刷新后重试', { revision: prefs.revision, preferences: prefs })
      }
    } else {
      try { await col.add({ data: Object.assign({ _id: openid }, defaultPreferences(), next) }) } catch (error) {
        if (!/duplicate|already exists|_id.*exist/i.test(String(error && (error.message || error.errMsg || error)))) throw error
        const current = await readOptionalDocument(db, 'intel_preferences', openid)
        const prefs = preferenceView(current)
        return fail('conflict', '偏好已在其他设备更新，请刷新后重试', { revision: prefs.revision, preferences: prefs })
      }
    }
    const afterWrite = await readOptionalDocument(db, 'intel_preferences', openid)
    if (afterWrite && afterWrite.deleted === true) {
      return fail('gone', '个人情报数据已删除，请重新打开设置')
    }
    return { ok: true, revision: next.revision, preferences: preferenceView(Object.assign({}, old, patch, { revision: next.revision, behaviorLearningEnabled: false })) }
  }
  async function intelFeedback (event, openid) {
    if (!isObject(event) || typeof event.itemId !== 'string' || !ITEM_ID.test(event.itemId) || !FEEDBACK_ACTIONS.has(event.feedbackAction)) return fail('bad_request', '资讯反馈无效')
    if (event.reason !== undefined && (typeof event.reason !== 'string' || event.reason.length > 80 || /[\u0000-\u001f\u007f]/.test(event.reason))) return fail('bad_request', '反馈原因无效')
    const prefsBefore = await readOptionalDocument(db, 'intel_preferences', openid)
    if (prefsBefore && prefsBefore.deleted === true) return fail('gone', '个人情报数据已删除，请重新打开设置')
    await takeLimit(openid, 'intelFeedback', 120)
    const generation = prefsBefore && Number.isSafeInteger(prefsBefore.generation) ? prefsBefore.generation : 0
    const id = feedbackId(openid, event.itemId, generation)
    const col = db.collection('intel_feedback')
    const oldResult = await readOptionalDocument(db, 'intel_feedback', id)
    const key = event.feedbackAction.startsWith('un') ? event.feedbackAction.slice(2) : event.feedbackAction
    const stateKey = key === 'like' ? 'liked' : key === 'bookmark' ? 'bookmarked' : 'disliked'
    const value = !event.feedbackAction.startsWith('un')
    let state
    const patch = { [`state.${stateKey}`]: value, updatedAt: now() }
    if (event.reason) patch.reason = event.reason
    if (oldResult) {
      const updated = await col.doc(id).update({ data: patch })
      if (!updated || !updated.stats || !updated.stats.updated) return fail('server_error', '反馈暂不可用')
      state = Object.assign({ liked: false, bookmarked: false, disliked: false }, oldResult.state || {}, { [stateKey]: value })
    } else {
      const data = { _id: id, openid, itemId: event.itemId, generation, state: { liked: false, bookmarked: false, disliked: false, [stateKey]: value }, updatedAt: patch.updatedAt }
      if (event.reason) data.reason = event.reason
      try { await col.add({ data }); state = data.state } catch (error) {
        if (!/duplicate|already exists|_id.*exist/i.test(String(error && (error.message || error.errMsg || error)))) throw error
        await col.doc(id).update({ data: patch })
        const latest = await readOptionalDocument(db, 'intel_feedback', id)
        state = Object.assign({ liked: false, bookmarked: false, disliked: false }, latest && latest.state || {})
      }
    }
    // Close the race with deleteAllMine: deletion marks the preference tombstone
    // before removing feedback; a writer that crossed that boundary removes its
    // just-written record instead of recreating private data.
    const prefsAfter = await readOptionalDocument(db, 'intel_preferences', openid)
    if ((prefsAfter && prefsAfter.deleted === true) || (prefsAfter && (prefsAfter.generation || 0) !== generation)) {
      await col.doc(id).remove()
      return fail('gone', '个人情报数据已删除，请重新打开设置')
    }
    return { ok: true, state }
  }
  return { intelGetPreferences, intelSavePreferences, intelFeedback }
}

module.exports = { createPreferenceHandlers, validatePreferences, defaultPreferences, preferenceView, feedbackId, FEEDBACK_ACTIONS, readOptionalDocument, markIntelDeleted }
