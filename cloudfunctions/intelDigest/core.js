'use strict'

const DAY_MS = 24 * 60 * 60 * 1000
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CATEGORIES = new Set(['jobs', 'ai', 'semiconductor', 'electronics'])
const DEFAULT_SOURCE_IDS = new Set([
  'huggingface-transformers-releases',
  'chipsalliance-chisel-releases'
])
const CHANNEL_LIMITS = Object.freeze({ jobs: 4, ai: 4, semiconductor: 3, explore: 1 })
const TOTAL_LIMIT = 12

function isRecord (value) { return !!value && typeof value === 'object' && !Array.isArray(value) }

function validDate (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const check = new Date(Date.UTC(y, m - 1, d))
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d
}

function partsAt (epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(epochMs))
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
}

function sameWallTime (epochMs, target, timeZone) {
  const actual = partsAt(epochMs, timeZone)
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].every(key => actual[key] === target[key])
}

function localDateTimeToEpoch (date, time, timeZone) {
  if (!validDate(date)) throw new TypeError('invalid_local_date')
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TypeError('invalid_local_time')
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) throw new TypeError('invalid_time_zone')
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const target = { year, month, day, hour, minute, second: 0 }
  let formatter
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone }) } catch (_) { throw new TypeError('invalid_time_zone') }
  // Force eager validation before probing offsets.
  formatter.format(new Date(0))
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute)
  const offsets = new Set()
  for (let hours = -36; hours <= 36; hours += 6) {
    const probe = wallAsUtc + hours * 60 * 60 * 1000
    const p = partsAt(probe, timeZone)
    const representedAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    offsets.add(representedAsUtc - Math.floor(probe / 1000) * 1000)
  }
  const matches = [...offsets]
    .map(offset => wallAsUtc - offset)
    .filter(epoch => sameWallTime(epoch, target, timeZone))
    .sort((a, b) => a - b)
  // A repeated wall time at DST fall-back resolves to its first occurrence.
  // A nonexistent wall time at spring-forward is rejected instead of shifted.
  if (!matches.length) throw new RangeError('nonexistent_local_time')
  return matches[0]
}

function createWindow ({ localDate, localTime = '08:00', timeZone }) {
  const endMs = localDateTimeToEpoch(localDate, localTime, timeZone)
  const startMs = endMs - DAY_MS
  return {
    localDate,
    timeZone,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString()
  }
}

function safeUrl (value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key)
    return url.toString()
  } catch (_) { return null }
}

function canonicalUrl (value) {
  const url = safeUrl(value)
  if (!url) return null
  try {
    const parsed = new URL(url)
    parsed.hostname = parsed.hostname.toLowerCase()
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    parsed.searchParams.sort()
    return parsed.toString()
  } catch (_) { return null }
}

function cleanLabel (value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '') : ''
}

function validTimestamp (value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match || !validDate(match[1])) return null
  const hour = Number(match[2]); const minute = Number(match[3]); const second = Number(match[4])
  if (hour > 23 || minute > 59 || second > 59) return null
  if (match[6] && (Number(match[7]) > 23 || Number(match[8]) > 59)) return null
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? epoch : null
}

function sourceAllowed (item, allowedSourceIds) {
  const ids = Array.isArray(item.sourceIds) ? item.sourceIds : []
  return ids.some(id => allowedSourceIds.has(id))
}

function matchesBlocked (item, blocked) {
  if (!blocked.size) return false
  const labels = [item.category]
  for (const key of ['topicTags', 'tags', 'subtopics']) {
    if (Array.isArray(item[key])) labels.push(...item[key])
  }
  return labels.some(label => blocked.has(cleanLabel(label)))
}

function compareText (a, b) { return a < b ? -1 : a > b ? 1 : 0 }
function compareRows (a, b) {
  return b.publishedMs - a.publishedMs || compareText(a.id, b.id)
}
function compareCandidates (a, b) {
  return b.publishedMs - a.publishedMs || compareText(a.id, b.id) ||
    compareText(a.urlKey, b.urlKey) || compareText(a.title, b.title) ||
    compareText(a.sourceName, b.sourceName) || compareText(a.originalUrl, b.originalUrl) ||
    compareText(a.summaryZh || '', b.summaryZh || '')
}

function selectDigest (input) {
  if (!isRecord(input)) throw new TypeError('invalid_input')
  const window = createWindow(input)
  const preferences = isRecord(input.preferences) ? input.preferences : {}
  const channels = isRecord(preferences.topics) ? preferences.topics : {}
  const blocked = new Set(Array.isArray(preferences.blockedTopics) ? preferences.blockedTopics.map(cleanLabel).filter(Boolean) : [])
  const allowedSourceIds = input.allowedSourceIds === undefined
    ? DEFAULT_SOURCE_IDS
    : new Set(Array.isArray(input.allowedSourceIds) ? input.allowedSourceIds.filter(id => typeof id === 'string') : [])
  const startMs = Date.parse(window.start)
  const endMs = Date.parse(window.end)
  const rows = Array.isArray(input.items) ? input.items : []
  const candidates = []
  for (const item of rows) {
    if (!isRecord(item) || item.status !== 'published' || item.dateStatus !== 'confirmed') continue
    const id = typeof item.id === 'string' ? item.id : item._id
    if (typeof id !== 'string' || !ITEM_ID.test(id) || !CATEGORIES.has(item.category)) continue
    if (!sourceAllowed(item, allowedSourceIds) || typeof item.sourceName !== 'string' || !item.sourceName.trim() || typeof item.sourceKind !== 'string' || !item.sourceKind.trim()) continue
    const originalUrl = safeUrl(item.originalUrl)
    const urlKey = canonicalUrl(item.originalUrl)
    if (!originalUrl || !urlKey) continue
    const publishedMs = validTimestamp(item.publishedAt)
    if (publishedMs === null || publishedMs < startMs || publishedMs > endMs) continue
    if (matchesBlocked(item, blocked)) continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (!title || title.length > 300 || /[\u0000-\u001f\u007f]/.test(title)) continue
    const row = { id, category: item.category, title, sourceName: item.sourceName.trim().slice(0, 200), originalUrl, urlKey, publishedAt: new Date(publishedMs).toISOString(), publishedMs }
    if (typeof item.summaryZh === 'string' && item.summaryZh.trim() && item.summaryZh.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(item.summaryZh)) row.summaryZh = item.summaryZh.trim()
    candidates.push(row)
  }
  // Choose each duplicate representative only after a complete stable ordering.
  // This makes snapshot contents independent of database input order.
  candidates.sort(compareCandidates)
  const byId = new Map()
  const seenUrls = new Set()
  for (const row of candidates) {
    if (byId.has(row.id) || seenUrls.has(row.urlKey)) continue
    byId.set(row.id, row)
    seenUrls.add(row.urlKey)
  }
  const available = [...byId.values()].sort(compareRows)
  const hasExplicitTopics = isRecord(preferences.topics) && Object.keys(preferences.topics).length > 0
  const explicit = Object.entries(channels)
    .filter(([topic, weight]) => ['ai', 'semiconductor', 'electronics'].includes(topic) && typeof weight === 'number' && Number.isFinite(weight) && weight > 0)
    .sort(([aTopic, aWeight], [bTopic, bWeight]) => bWeight - aWeight || aTopic.localeCompare(bTopic))
  const rank = new Map(explicit.map(([topic], index) => [topic, index]))
  const ai = available.filter(row => row.category === 'ai' && (!hasExplicitTopics || rank.has('ai'))).slice(0, CHANNEL_LIMITS.ai)
  const semiconductor = available.filter(row => row.category === 'semiconductor' && (!hasExplicitTopics || rank.has('semiconductor'))).slice(0, CHANNEL_LIMITS.semiconductor)
  const explore = available.filter(row => row.category === 'electronics' && (!hasExplicitTopics || rank.has('electronics'))).slice(0, CHANNEL_LIMITS.explore)
  const buckets = { jobs: [], ai: ai.map(row => withReason(row, rank)), semiconductor: semiconductor.map(row => withReason(row, rank)), explore: explore.map(row => withReason(row, rank)) }
  const items = [...buckets.ai, ...buckets.semiconductor, ...buckets.explore]
    .sort((a, b) => (rank.get(a.category) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.category) ?? Number.MAX_SAFE_INTEGER) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.itemId.localeCompare(b.itemId))
    .slice(0, TOTAL_LIMIT - CHANNEL_LIMITS.jobs)
  return {
    localDate: window.localDate,
    timezone: window.timeZone,
    windowStart: window.start,
    windowEnd: window.end,
    algorithmVersion: 'm4-core-v1',
    itemIds: items.map(item => item.itemId),
    items,
    buckets,
    reservedJobSlots: CHANNEL_LIMITS.jobs
  }
}

function withReason (row, rank) {
  const item = {
    itemId: row.id,
    category: row.category,
    title: row.title,
    sourceName: row.sourceName,
    originalUrl: row.originalUrl,
    publishedAt: row.publishedAt,
    reason: rank.has(row.category) ? 'subscribed_channel' : 'recent_confirmed_update'
  }
  if (row.summaryZh) item.summaryZh = row.summaryZh
  return item
}

module.exports = { createWindow, localDateTimeToEpoch, selectDigest, DEFAULT_SOURCE_IDS: [...DEFAULT_SOURCE_IDS], CHANNEL_LIMITS, TOTAL_LIMIT }
