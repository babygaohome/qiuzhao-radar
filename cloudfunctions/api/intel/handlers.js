'use strict'

const crypto = require('crypto')

const CATEGORIES = new Set(['all', 'jobs', 'ai', 'semiconductor', 'electronics'])
const ITEM_CATEGORIES = new Set(['jobs', 'ai', 'semiconductor', 'electronics'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CURSOR_VERSION = 1
const CURSOR_TTL_MS = 15 * 60 * 1000
const CURSOR_SECRET_ENV = 'INFOFLOW_CURSOR_SECRET'

function failure (error, message) { return { error, message } }
function isRecord (value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
function userHash (openid) { return crypto.createHash('sha256').update(openid).digest('hex') }
function b64url (value) { return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') }
function fromB64urlBytes (value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid cursor')
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}
function cursorSignature (body, secret) { return crypto.createHmac('sha256', secret).update(body).digest() }
function encodeCursor (payload, secret) {
  const body = b64url(JSON.stringify(payload))
  return body + '.' + b64url(cursorSignature(body, secret))
}
function decodeCursor (token, secret) {
  if (typeof token !== 'string' || token.length > 2048) throw new Error('invalid cursor')
  const parts = token.split('.')
  if (parts.length !== 2) throw new Error('invalid cursor')
  const expected = cursorSignature(parts[0], secret)
  const actual = fromB64urlBytes(parts[1])
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error('invalid cursor')
  const payload = JSON.parse(fromB64urlBytes(parts[0]).toString('utf8'))
  if (!isRecord(payload)) throw new Error('invalid cursor')
  return payload
}

function createIntelHandlers (options) {
  options = options || {}
  const readItems = options.readItems || (() => [])
  const enabled = options.enabled === true
  const now = typeof options.now === 'function' ? options.now : Date.now
  const configuredSecret = typeof options.cursorSecret === 'string' && options.cursorSecret.length >= 32
    ? options.cursorSecret
    : (typeof process !== 'undefined' && process.env && process.env[CURSOR_SECRET_ENV] || '')

  const secret = typeof configuredSecret === 'string' && configuredSecret.length >= 32 ? configuredSecret : ''

  async function intelFeed (event, openid) {
    if (typeof openid !== 'string' || !openid.trim()) return failure('unauthenticated', '请通过微信小程序登录后使用')
    if (!enabled) return failure('feature_disabled', '情报功能暂未开启')
    if (!isRecord(event)) return failure('bad_request', '资讯请求无效')
    const category = event.category === undefined ? 'all' : event.category
    if (typeof category !== 'string' || !CATEGORIES.has(category)) return failure('bad_request', '资讯分类无效')
    const limit = event.limit === undefined ? 20 : event.limit
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return failure('bad_request', '每页数量须为 1 到 20')
    if (event.cursor !== undefined && event.cursor !== null && event.cursor !== '' && !secret) return failure('bad_request', '分页游标无效或已过期')

    let rows
    try {
      const source = await readItems()
      if (!Array.isArray(source)) return failure('server_error', '资讯暂不可用')
      rows = source.filter(row => row && row.status === 'published' && (category === 'all' || row.category === category))
        .filter(row => typeof row.id === 'string' && ID.test(row.id))
        .sort(compareItems)
    } catch (_) { return failure('server_error', '资讯暂不可用') }

    const snapshot = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    const owner = userHash(openid)
    let offset = 0
    if (event.cursor !== undefined && event.cursor !== null && event.cursor !== '') {
      try {
        const cursor = decodeCursor(event.cursor, secret)
        if (cursor.v !== CURSOR_VERSION || cursor.u !== owner || cursor.c !== category || cursor.s !== snapshot ||
            cursor.l !== limit || !Number.isSafeInteger(cursor.o) || cursor.o < 1 || cursor.o >= rows.length ||
            !Number.isSafeInteger(cursor.e) || cursor.e <= now()) throw new Error('cursor binding mismatch')
        offset = cursor.o
      } catch (_) { return failure('bad_request', '分页游标无效或已过期') }
    }

    const page = rows.slice(offset, offset + limit).map(publicItem)
    const nextOffset = offset + page.length
    let nextCursor = null
    if (nextOffset < rows.length) {
      if (!secret || secret.length < 32) return failure('server_error', '分页暂不可用')
      nextCursor = encodeCursor({ v: CURSOR_VERSION, u: owner, c: category, s: snapshot, l: limit, o: nextOffset, e: now() + CURSOR_TTL_MS }, secret)
    }
    return { items: page, nextCursor, digestAt: null }
  }

  async function intelItem (event, openid) {
    if (typeof openid !== 'string' || !openid.trim()) return failure('unauthenticated', '请通过微信小程序登录后使用')
    if (!enabled) return failure('feature_disabled', '情报功能暂未开启')
    if (!isRecord(event) || typeof event.id !== 'string' || !ID.test(event.id)) return failure('bad_request', '资讯编号无效')
    try {
      const items = await readItems()
      if (!Array.isArray(items)) return failure('server_error', '资讯暂不可用')
      const item = items.find(row => row && row.status === 'published' && row.id === event.id)
      if (!item) return failure('not_found', '这条资讯暂不可用')
      return { item: publicItem(item) }
    } catch (_) { return failure('server_error', '资讯暂不可用') }
  }

  return { intelFeed, intelItem }
}

function compareItems (a, b) {
  const aDate = typeof a.publishedAt === 'string' ? a.publishedAt : ''
  const bDate = typeof b.publishedAt === 'string' ? b.publishedAt : ''
  if (aDate !== bDate) return aDate < bDate ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function safeText (value, max) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
}

function safeSourceUrl (value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') ||
        host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return undefined
    return url.toString()
  } catch (_) { return undefined }
}

function publicItem (item) {
  const out = { id: item.id }
  if (ITEM_CATEGORIES.has(item.category)) out.category = item.category
  for (const [key, max] of [['title', 300], ['summaryZh', 2000], ['summaryStatus', 40], ['publishedAt', 64], ['sourceName', 200]]) {
    const value = safeText(item[key], max)
    if (value !== undefined) out[key] = value
  }
  const originalUrl = safeSourceUrl(item.originalUrl)
  if (originalUrl) out.originalUrl = originalUrl
  if (Array.isArray(item.evidenceLinks)) {
    out.evidenceLinks = item.evidenceLinks.slice(0, 10).map(safeSourceUrl).filter(Boolean)
  }
  return out
}

module.exports = { createIntelHandlers, CATEGORIES: [...CATEGORIES], ID, publicItem }
