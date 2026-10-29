'use strict'

const assert = require('node:assert/strict')
const { createWindow, localDateTimeToEpoch, selectDigest, DEFAULT_SOURCE_IDS } = require('../cloudfunctions/intelDigest/core')

function item (id, overrides = {}) {
  return Object.assign({
    id,
    _id: id,
    status: 'published',
    dateStatus: 'confirmed',
    category: 'ai',
    title: `Paper ${id}`,
    sourceName: 'huggingface/transformers · GitHub Releases',
    sourceKind: 'open_source_release',
    sourceIds: [DEFAULT_SOURCE_IDS[0]],
    originalUrl: `https://github.com/huggingface/transformers/releases/${id}`,
    publishedAt: '2026-03-08T11:00:00Z',
    summaryZh: 'A verified recent update.'
  }, overrides)
}
function digest (items, overrides = {}) {
  return selectDigest(Object.assign({
    localDate: '2026-03-08', localTime: '08:00', timeZone: 'America/New_York',
    preferences: { topics: { ai: 1, semiconductor: 1, electronics: 0 }, blockedTopics: [] },
    items
  }, overrides))
}

function run () {
  const spring = createWindow({ localDate: '2026-03-08', localTime: '08:00', timeZone: 'America/New_York' })
  assert.equal(spring.end, '2026-03-08T12:00:00.000Z')
  assert.equal(spring.start, '2026-03-07T12:00:00.000Z')
  const fall = createWindow({ localDate: '2026-11-01', localTime: '08:00', timeZone: 'America/New_York' })
  assert.equal(fall.end, '2026-11-01T13:00:00.000Z')
  assert.equal(fall.start, '2026-10-31T13:00:00.000Z')
  assert.equal(new Date(localDateTimeToEpoch('2026-11-01', '01:30', 'America/New_York')).toISOString(), '2026-11-01T05:30:00.000Z', 'ambiguous fall-back wall time resolves to first occurrence')
  assert.throws(() => localDateTimeToEpoch('2026-03-08', '02:30', 'America/New_York'), /nonexistent_local_time/)
  assert.throws(() => createWindow({ localDate: '2026-02-30', localTime: '08:00', timeZone: 'UTC' }), /invalid_local_date/)
  assert.throws(() => createWindow({ localDate: '2026-03-08', localTime: '24:00', timeZone: 'UTC' }), /invalid_local_time/)
  assert.throws(() => createWindow({ localDate: '2026-03-08', localTime: '08:00', timeZone: 'Mars/Olympus' }), /invalid_time_zone/)

  const window = digest([])
  assert.equal(window.items.length, 0)
  assert.equal(window.reservedJobSlots, 4)
  assert.deepEqual(window.itemIds, [])
  assert.equal(digest([item('invalid-calendar-date', { publishedAt: '2026-02-30T11:00:00Z' })]).items.length, 0, 'impossible calendar dates are rejected')
  const inStart = item('at-start', { publishedAt: window.windowStart })
  const inEnd = item('at-end', { publishedAt: window.windowEnd })
  const outside = item('too-old', { publishedAt: new Date(Date.parse(window.windowStart) - 1).toISOString() })
  const excluded = digest([inStart, inEnd, outside])
  assert.deepEqual(excluded.itemIds, ['at-end', 'at-start'])

  const duplicate = item('zz-duplicate', { originalUrl: item('later').originalUrl, publishedAt: '2026-03-08T11:30:00Z' })
  const badDate = item('no-date', { publishedAt: null })
  const badDateStatus = item('unconfirmed', { dateStatus: 'unconfirmed' })
  const badSource = item('no-source', { sourceName: '' })
  const unknownSource = item('unknown-source', { sourceIds: ['unregistered-source'] })
  const badUrl = item('unsafe-url', { originalUrl: 'http://example.com/x' })
  const blocked = item('blocked', { topicTags: ['RAG'] })
  const inputItems = [
    item('later', { publishedAt: '2026-03-08T11:55:00Z' }),
    item('earlier', { publishedAt: '2026-03-08T11:05:00Z' }),
    duplicate, badDate, badDateStatus, badSource, unknownSource, badUrl,
    item('blocked', { topicTags: ['RAG'] })
  ]
  const filtered = digest(inputItems, { preferences: { topics: { ai: 1 }, blockedTopics: ['rag'] } })
  assert.deepEqual(filtered.itemIds, ['later', 'earlier'], 'deduplicates canonical source URL, missing/unconfirmed dates, invalid sources and blocked tags')
  assert.deepEqual(filtered.items.map(row => row.reason), ['subscribed_channel', 'subscribed_channel'])
  assert.equal(filtered.items[0].itemId, 'later')
  assert.equal(filtered.items[0].sourceName, 'huggingface/transformers · GitHub Releases')
  assert.equal(filtered.items[0].summaryZh, 'A verified recent update.')
  assert.deepEqual(digest(inputItems, { preferences: { topics: { ai: 1 }, blockedTopics: ['rag'] } }), filtered, 'selection is deterministic')
  assert.deepEqual(digest(inputItems.slice().reverse(), { preferences: { topics: { ai: 1 }, blockedTopics: ['rag'] } }), filtered, 'reversing duplicate input order preserves the snapshot')

  const mixed = []
  for (let i = 0; i < 8; i++) mixed.push(item(`ai-${i}`, { publishedAt: new Date(Date.parse(window.windowEnd) - i * 60000).toISOString() }))
  for (let i = 0; i < 7; i++) mixed.push(item(`semi-${i}`, {
    category: 'semiconductor', sourceName: 'chipsalliance/chisel · GitHub Releases', sourceKind: 'developer_release',
    sourceIds: [DEFAULT_SOURCE_IDS[1]], originalUrl: `https://github.com/chipsalliance/chisel/releases/${i}`,
    publishedAt: new Date(Date.parse(window.windowEnd) - (20 + i) * 60000).toISOString()
  }))
  mixed.push(item('electron-1', { category: 'electronics', sourceIds: ['huggingface-transformers-releases'] }))
  const capped = digest(mixed, { preferences: { topics: { ai: 0.6, semiconductor: 0.4, electronics: 0.1 }, blockedTopics: [] } })
  assert.equal(capped.buckets.ai.length, 4)
  assert.equal(capped.buckets.semiconductor.length, 3)
  assert.equal(capped.buckets.explore.length, 1)
  assert.equal(capped.items.length, 8)
  assert.equal(capped.items.length + capped.reservedJobSlots <= 12, true)
  assert.equal(capped.items[0].category, 'ai', 'explicit channel weights determine deterministic mixed ordering')
  assert.deepEqual(capped.buckets.jobs, [], 'no job candidates are fabricated or inferred')

  const allOff = digest(mixed, { preferences: { topics: { ai: 0, semiconductor: 0, electronics: 0 }, blockedTopics: [] } })
  assert.equal(allOff.items.length, 0, 'explicitly disabling every channel returns no industry items')
  const noPreferences = digest([item('cold-start')], { preferences: {} })
  assert.deepEqual(noPreferences.itemIds, ['cold-start'], 'missing explicit preferences still permits recent confirmed content')
  console.log('intel-digest-core: all assertions passed')
}

run()
