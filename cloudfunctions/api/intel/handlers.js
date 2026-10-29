'use strict'

const CATEGORIES = new Set(['all', 'jobs', 'ai', 'semiconductor', 'electronics'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function failure (error, message) { return { error, message } }

function createIntelHandlers (options) {
  options = options || {}
  const readItems = options.readItems || (() => [])
  const enabled = options.enabled === true

  async function intelFeed (event, openid) {
    if (!openid) return failure('unauthenticated', '请通过微信小程序登录后使用')
    if (!enabled) return failure('feature_disabled', '情报功能暂未开启')
    const category = event.category === undefined ? 'all' : event.category
    if (!CATEGORIES.has(category)) return failure('bad_request', '资讯分类无效')
    const limit = event.limit === undefined ? 20 : Number(event.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return failure('bad_request', '每页数量须为 1 到 20')
    if (event.cursor !== undefined && event.cursor !== null && event.cursor !== '') return failure('bad_request', '当前试运行不支持分页游标')
    const items = await readItems()
    const filtered = items.filter(item => item && item.status === 'published' && (category === 'all' || item.category === category))
    return { items: filtered.slice(0, limit).map(publicItem), nextCursor: null, digestAt: null }
  }

  async function intelItem (event, openid) {
    if (!openid) return failure('unauthenticated', '请通过微信小程序登录后使用')
    if (!enabled) return failure('feature_disabled', '情报功能暂未开启')
    if (typeof event.id !== 'string' || !ID.test(event.id)) return failure('bad_request', '资讯编号无效')
    const items = await readItems()
    const item = items.find(row => row && row.status === 'published' && row.id === event.id)
    if (!item) return failure('not_found', '这条资讯暂不可用')
    return { item: publicItem(item) }
  }

  return { intelFeed, intelItem }
}

function publicItem (item) {
  const fields = ['id', 'category', 'title', 'summaryZh', 'summaryStatus', 'publishedAt', 'sourceName', 'originalUrl', 'evidenceLinks']
  const out = {}
  fields.forEach(key => { if (item[key] !== undefined) out[key] = item[key] })
  return out
}

module.exports = { createIntelHandlers, CATEGORIES: [...CATEGORIES], ID }
