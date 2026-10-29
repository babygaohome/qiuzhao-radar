'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createReadItems, createIntelHandlers, READ_WINDOW } = require('../cloudfunctions/api/intel/handlers')

test('repository reads only published projected intel_items in bounded deterministic _id batches', async () => {
  const calls = []
  const docs = Array.from({ length: 205 }, (_, n) => ({ _id: `item-${String(n).padStart(3, '0')}`, status: 'published', category: 'ai', title: `Release ${n}`, private: 'must not be projected' }))
  const db = { collection (name) {
    assert.equal(name, 'intel_items')
    const query = { where (selector) { calls.push({ selector }); return query }, field (projection) { calls.at(-1).projection = projection; return query }, orderBy (field, direction) { calls.at(-1).order = [field, direction]; return query }, skip (skip) { calls.at(-1).skip = skip; return query }, limit (limit) { calls.at(-1).limit = limit; return query }, async get () { const c = calls.at(-1); const keys = Object.keys(c.projection); return { data: docs.filter(row => row.status === 'published').slice(c.skip, c.skip + c.limit).map(row => Object.fromEntries(keys.filter(k => c.projection[k]).map(k => [k, row[k]]))) } } }
    return query
  } }
  const rows = await createReadItems(db)()
  assert.equal(rows.length, 205)
  assert.equal(rows[0].id, 'item-000')
  assert.deepEqual(calls.map(c => c.skip), [0, 100, 200])
  assert.equal(calls.every(c => c.selector.status === 'published' && c.order[0] === '_id' && c.order[1] === 'asc'), true)
  assert.equal(calls.flatMap(c => Object.keys(c.selector)).includes('openid'), false)
  assert.equal(calls.reduce((n, c) => n + c.limit, 0) <= READ_WINDOW, true)
  assert.equal(rows[0].private, undefined)
})

test('crawler fetchedAt refresh does not invalidate a signed public snapshot cursor', async () => {
  let fetchedAt = '2026-10-29T00:00:00.000Z'
  const key = 'integration-cursor-secret-at-least-32-bytes'
  const readItems = async () => [
    { _id: 'one', category: 'ai', title: 'One', status: 'published', publishedAt: '2026-10-01T00:00:00Z', fetchedAt },
    { _id: 'two', category: 'ai', title: 'Two', status: 'published', publishedAt: '2026-09-01T00:00:00Z', fetchedAt }
  ].map(row => ({ ...row, id: row._id }))
  const api = createIntelHandlers({ enabled: true, cursorSecret: key, readItems })
  const first = await api.intelFeed({ category: 'ai', limit: 1 }, 'user')
  assert.ok(first.nextCursor)
  fetchedAt = '2026-10-30T00:00:00.000Z'
  const second = await api.intelFeed({ category: 'ai', limit: 1, cursor: first.nextCursor }, 'user')
  assert.equal(second.items[0].id, 'two')
})
