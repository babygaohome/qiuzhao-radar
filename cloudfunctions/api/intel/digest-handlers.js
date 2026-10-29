'use strict'

const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const DIGEST_ENABLED_ENV = 'INTEL_DIGEST_ENABLED'
const HISTORY_LIMIT = 30
const HISTORY_DEFAULT_LIMIT = 20
// Keep this allowlist local to the api function package; CloudBase deploys each
// cloud function directory independently.
const APPROVED_SOURCE_IDS = new Set(['huggingface-transformers-releases', 'chipsalliance-chisel-releases'])

function fail (code, message) { return Object.assign(new Error(message), { code }) }
function isRecord (value) { return !!value && typeof value === 'object' && !Array.isArray(value) }

async function readOptionalDocument (db, collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get()
    return result && result.data || null
  } catch (error) {
    const message = String(error && (error.message || error.errMsg || error))
    if (/permission|denied|collection.*(?:not exist|not found)|database collection not exist/i.test(message)) throw error
    const code = error && (error.errCode !== undefined ? error.errCode : error.code)
    if (code === 'DATABASE_DOCUMENT_NOT_EXIST' || (code === -1 && /document with _id .+ does not exist/i.test(message))) return null
    throw error
  }
}

function validateIdentity (openid) {
  if (typeof openid !== 'string' || !openid.trim() || openid.length > 128) throw fail('unauthenticated', 'server identity required')
}

function validateTimezone (timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) throw fail('bad_request', 'timezone invalid')
  try { new Intl.DateTimeFormat('en', { timeZone }) } catch (_) { throw fail('bad_request', 'timezone invalid') }
  return timeZone
}

function localDateAt (epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(epochMs))
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function digestId (openid, localDate, generation, digestGeneration, timeZone) {
  validateTimezone(timeZone)
  if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(digestGeneration) || digestGeneration < 0) throw fail('bad_request', 'generation invalid')
  return require('crypto').createHash('sha256')
    .update(`${openid}\0${localDate}\0${generation}\0${digestGeneration}\0${timeZone}`)
    .digest('hex')
}

function currentState (preferences, timeZone) {
  return {
    generation: Number.isSafeInteger(preferences.generation) ? preferences.generation : 0,
    digestGeneration: Number.isSafeInteger(preferences.digestGeneration) ? preferences.digestGeneration : 0,
    timeZone: validateTimezone(timeZone)
  }
}

function safeUrl (value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || host === 'localhost' ||
      host.endsWith('.localhost') || host.endsWith('.local') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null
    return url.toString()
  } catch (_) { return null }
}

function validTimestamp (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const epoch = Date.parse(value)
  if (!Number.isFinite(epoch)) return null
  const date = value.slice(0, 10)
  const [year, month, day] = date.split('-').map(Number)
  const validCalendarDate = new Date(Date.UTC(year, month - 1, day))
  if (validCalendarDate.getUTCFullYear() !== year || validCalendarDate.getUTCMonth() !== month - 1 || validCalendarDate.getUTCDate() !== day) return null
  const time = value.slice(11, 19).split(':').map(Number)
  if (time[0] > 23 || time[1] > 59 || time[2] > 59) return null
  return epoch
}

function publicItem (item, expectedId) {
  if (!isRecord(item) || item.status !== 'published' || item.dateStatus !== 'confirmed') return null
  const id = typeof item.id === 'string' ? item.id : item._id
  if (id !== expectedId || !ITEM_ID.test(id)) return null
  const sourceIds = Array.isArray(item.sourceIds) ? item.sourceIds : []
  if (!sourceIds.some(sourceId => APPROVED_SOURCE_IDS.has(sourceId))) return null
  const publishedMs = validTimestamp(item.publishedAt)
  const originalUrl = safeUrl(item.originalUrl)
  if (!Number.isFinite(publishedMs) || !originalUrl || typeof item.sourceName !== 'string' || !item.sourceName.trim() ||
    typeof item.sourceKind !== 'string' || !item.sourceKind.trim() || typeof item.title !== 'string' ||
    !item.title.trim() || item.title.length > 300 || /[\u0000-\u001f\u007f]/.test(item.title)) return null
  const out = {
    itemId: id,
    title: item.title.trim(),
    sourceName: item.sourceName.trim().slice(0, 200),
    originalUrl,
    reason: '近期资讯',
    publishedAt: new Date(publishedMs).toISOString()
  }
  if (typeof item.summaryZh === 'string' && item.summaryZh.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(item.summaryZh)) out.summaryZh = item.summaryZh.trim()
  return out
}

function createDigestHandlers ({ db, now = () => Date.now() } = {}) {
  if (!db || typeof db.collection !== 'function') throw new TypeError('database_required')

  async function readState (openid) {
    const pref = await readOptionalDocument(db, 'intel_preferences', openid)
    if (!pref || pref.deleted === true || pref.dailyDigestEnabled !== true) return null
    return { pref, ...currentState(pref, pref.timezone) }
  }

  async function intelDigestToday (_, openid) {
    validateIdentity(openid)
    const state = await readState(openid)
    if (!state) return { digest: null }
    const localDate = localDateAt(now(), state.timeZone)
    return readDigestForDate(openid, state, localDate)
  }

  async function intelDigestByDate (event, openid) {
    validateIdentity(openid)
    if (!isRecord(event) || !isValidLocalDate(event.localDate)) throw fail('bad_request', 'digest date invalid')
    const state = await readState(openid)
    if (!state) return { digest: null }
    const currentLocalDate = localDateAt(now(), state.timeZone)
    if (event.localDate > currentLocalDate) throw fail('bad_request', 'future digest date invalid')
    return readDigestForDate(openid, state, event.localDate)
  }

  async function readDigestForDate (openid, state, localDate) {
    const id = digestId(openid, localDate, state.generation, state.digestGeneration, state.timeZone)
    const record = await readOptionalDocument(db, 'intel_digests', id)
    if (!record || record._id !== id || record.openid !== openid || record.localDate !== localDate ||
      record.status !== 'ready' || record.generation !== state.generation || record.digestGeneration !== state.digestGeneration ||
      record.timezone !== state.timeZone) return { digest: null }
    if (!Array.isArray(record.itemIds) || record.itemIds.length > 12 || new Set(record.itemIds).size !== record.itemIds.length || record.itemIds.some(itemId => typeof itemId !== 'string' || !ITEM_ID.test(itemId))) {
      throw fail('server_error', 'digest snapshot invalid')
    }
    const items = await loadPublicItems(db, record.itemIds)
    return { digest: {
      localDate,
      items,
      jobItems: [],
      generatedAt: record.generatedAt
    } }
  }

  async function intelDigestHistory (event, openid) {
    validateIdentity(openid)
    if (event !== undefined && event !== null && !isRecord(event)) throw fail('bad_request', 'digest history request invalid')
    event = event || {}
    const limit = event.limit === undefined ? HISTORY_DEFAULT_LIMIT : event.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMIT) throw fail('bad_request', 'digest history limit invalid')
    const cursor = event.cursor === undefined || event.cursor === null || event.cursor === '' ? null : event.cursor
    if (cursor !== null && !isValidLocalDate(cursor)) throw fail('bad_request', 'digest history cursor invalid')
    const state = await readState(openid)
    if (!state) return { digests: [], nextCursor: null }
    const query = {
      openid,
      generation: state.generation,
      digestGeneration: state.digestGeneration,
      timezone: state.timeZone
    }
    if (cursor !== null) query.localDate = db.command.lt(cursor)
    const result = await db.collection('intel_digests').where(query)
      .field({ _id: true, openid: true, localDate: true, timezone: true, generation: true, digestGeneration: true, status: true, itemIds: true, jobCompanyIds: true, generatedAt: true })
      .orderBy('localDate', 'desc').limit(limit + 1).get()
    if (!isRecord(result) || !Array.isArray(result.data)) throw fail('server_error', 'digest history unavailable')
    const rows = result.data
    const digests = rows.map(row => historySummary(row, openid, state))
    const page = digests.slice(0, limit)
    return { digests: page, nextCursor: digests.length > limit && page.length ? page[page.length - 1].localDate : null }
  }

  return { intelDigestToday, intelDigestByDate, intelDigestHistory }
}

function historySummary (row, openid, state) {
  if (!isRecord(row) || row.openid !== openid || row.status !== 'ready' || row.timezone !== state.timeZone ||
    row.generation !== state.generation || row.digestGeneration !== state.digestGeneration ||
    typeof row.localDate !== 'string' || !isValidLocalDate(row.localDate) ||
    !Array.isArray(row.itemIds) || row.itemIds.length > 12 || row.itemIds.some(id => typeof id !== 'string' || !ITEM_ID.test(id)) ||
    !Array.isArray(row.jobCompanyIds) || row.jobCompanyIds.length > 12 || row.jobCompanyIds.some(id => typeof id !== 'string') ||
    row.itemIds.length + row.jobCompanyIds.length > 12 ||
    typeof row.generatedAt !== 'string' || !Number.isFinite(Date.parse(row.generatedAt)) ||
    row._id !== digestId(openid, row.localDate, state.generation, state.digestGeneration, state.timeZone)) {
    throw fail('server_error', 'digest history record invalid')
  }
  return {
    localDate: row.localDate,
    itemCount: row.itemIds.length + row.jobCompanyIds.length,
    generatedAt: row.generatedAt
  }
}

// Construct an inert router when the server-side rollout flag is off. This
// keeps preview clients from touching newly provisioned collections before
// operators deliberately enable the feature.
function createDigestFeatureHandlers ({ db, enabled, now } = {}) {
  if (enabled !== true) {
    const disabled = async () => ({ error: 'feature_disabled', message: '每日简报暂未开放' })
    return { intelDigestToday: disabled, intelDigestByDate: disabled, intelDigestHistory: disabled }
  }
  const handlers = createDigestHandlers({ db, now })
  return {
    intelDigestToday: (event, serverOpenid) => handlers.intelDigestToday(event, serverOpenid),
    intelDigestByDate: (event, serverOpenid) => handlers.intelDigestByDate(event, serverOpenid),
    intelDigestHistory: (event, serverOpenid) => handlers.intelDigestHistory(event, serverOpenid)
  }
}

function isValidLocalDate (value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

async function loadPublicItems (db, ids) {
  if (!ids.length) return []
  const result = await db.collection('intel_items').where({ _id: db.command.in(ids), status: 'published' })
    .field({ _id: true, status: true, dateStatus: true, category: true, title: true, sourceName: true, sourceKind: true, sourceIds: true, originalUrl: true, publishedAt: true, summaryZh: true })
    .limit(Math.min(ids.length, 12)).get()
  if (!isRecord(result) || !Array.isArray(result.data)) throw fail('server_error', 'digest items unavailable')
  const rows = result.data
  const byId = new Map(rows.map(row => [row && row._id, row]))
  const output = []
  for (const id of ids) {
    const safe = publicItem(byId.get(id), id)
    if (safe) output.push(safe)
  }
  return output
}

module.exports = { createDigestHandlers, createDigestFeatureHandlers, digestId, localDateAt, publicItem, validTimestamp, HISTORY_LIMIT, DIGEST_ENABLED_ENV, APPROVED_SOURCE_IDS: [...APPROVED_SOURCE_IDS] }
