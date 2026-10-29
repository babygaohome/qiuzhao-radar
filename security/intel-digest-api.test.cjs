'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createDigestHandlers, createDigestFeatureHandlers, digestId, validTimestamp, DIGEST_ENABLED_ENV } = require('../cloudfunctions/api/intel/digest-handlers')
const { digestId: snapshotDigestId } = require('../cloudfunctions/intelDigest/snapshot-store')

const A = 'test-openid-a'
const B = 'test-openid-b'
const ZONE = 'Asia/Shanghai'
const now = Date.parse('2026-10-29T02:00:00.000Z')

function createDb () {
  const tables = new Map()
  const failures = new Map()
  const updateFailures = new Map()
  const queryCounts = new Map()
  const command = { in: values => ({ $in: values }), lt: value => ({ $lt: value }) }
  const key = (name, id) => `${name}:${id}`
  function table (name) {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  function collection (name) {
    return {
      doc (id) {
        return {
          async get () {
            const failure = failures.get(key(name, id))
            if (failure) throw failure
            const row = table(name).get(id)
            return row ? { data: { ...row } } : { data: null }
          },
          async update ({ data }) {
            const failure = updateFailures.get(key(name, id)) || failures.get(key(name, id))
            if (failure) throw failure
            const row = table(name).get(id)
            if (!row) return { stats: { updated: 0 } }
            Object.assign(row, data)
            return { stats: { updated: 1 } }
          }
        }
      },
      where (query) {
        let order = null
        let limit = Infinity
        let projection = null
        return {
          orderBy (field, direction) { order = [field, direction]; return this },
          limit (value) { limit = value; return this },
          field (value) { projection = value; return this },
          async get () {
            queryCounts.set(name, (queryCounts.get(name) || 0) + 1)
            const queryFailure = failures.get(key(name, '__query__'))
            if (queryFailure) throw queryFailure
            const rows = [...table(name).values()].filter(row => Object.entries(query).every(([field, value]) => {
              if (value && Array.isArray(value.$in)) return value.$in.includes(row[field])
              if (value && typeof value.$lt === 'string') return String(row[field]) < value.$lt
              return row[field] === value
            }))
            if (order) rows.sort((a, b) => order[1] === 'desc' ? String(b[order[0]]).localeCompare(String(a[order[0]])) : String(a[order[0]]).localeCompare(String(b[order[0]])))
            return { data: rows.slice(0, limit).map(row => projection
              ? Object.fromEntries(Object.keys(projection).filter(field => projection[field] === true && row[field] !== undefined).map(field => [field, row[field]]))
              : { ...row }) }
          }
        }
      }
    }
  }
  const db = {
    command,
    collection,
    put (name, id, row) { table(name).set(id, { ...row, _id: id }) },
    fail (name, id, error) { failures.set(key(name, id), error) },
    failUpdate (name, id, error) { updateFailures.set(key(name, id), error) },
    failQuery (name, error) { failures.set(key(name, '__query__'), error) },
    queryCount (name) { return queryCounts.get(name) || 0 },
    rows (name) { return [...table(name).values()] },
    runTransaction: fn => fn(db)
  }
  return db
}

function feedbackId (openid, itemId, generation) {
  const scope = generation ? openid + '\0' + generation + '\0' + itemId : openid + '\0' + itemId
  return crypto.createHash('sha256').update(scope).digest('hex')
}

function preference (overrides = {}) {
  return { _id: A, timezone: ZONE, dailyDigestEnabled: true, generation: 2, digestGeneration: 1, ...overrides }
}

function snapshot (openid, localDate, overrides = {}) {
  const generation = overrides.generation ?? 2
  const digestGeneration = overrides.digestGeneration ?? 1
  const timezone = overrides.timezone || ZONE
  return {
    _id: digestId(openid, localDate, generation, digestGeneration, timezone), openid, localDate,
    timezone, generation, digestGeneration, status: 'ready', algorithmVersion: 'm4-core-v1',
    itemIds: ['item-2', 'item-1'], jobCompanyIds: [], generatedAt: '2026-10-29T01:00:00.000Z', ...overrides
  }
}

function item (id, overrides = {}) {
  return {
    _id: id, status: 'published', dateStatus: 'confirmed', sourceIds: ['huggingface-transformers-releases'],
    sourceName: 'huggingface/transformers · GitHub Releases', sourceKind: 'open_source_release',
    title: `Title ${id}`, originalUrl: `https://github.com/huggingface/transformers/releases/${id}`,
    publishedAt: '2026-10-29T01:00:00.000Z', summaryZh: 'verified summary', privateNote: 'must not escape', ...overrides
  }
}

function malformedQueryResultDb (base, collectionName, result) {
  return {
    command: base.command,
    collection (name) {
      if (name !== collectionName) return base.collection(name)
      return {
        where () {
          const query = {
            field () { return this },
            orderBy () { return this },
            limit () { return this },
            async get () { return result }
          }
          return query
        }
      }
    }
  }
}

async function run () {
  let checks = 0
  const check = (condition, message) => { assert.ok(condition, message); checks++ }
  const db = createDb()
  db.put('intel_preferences', A, preference())
  db.put('intel_preferences', B, preference({ _id: B, timezone: 'Pacific/Auckland' }))
  const today = '2026-10-29'
  check(DIGEST_ENABLED_ENV === 'INTEL_DIGEST_ENABLED', 'feature gate uses a server-only environment variable')
  check(digestId(A, today, 2, 1, ZONE) === snapshotDigestId(A, today, 2, 1, ZONE), 'API and snapshot writer derive the same private key')
  const snapA = snapshot(A, today)
  snapA.jobCompanyIds = ['verified-company', 'hidden-company', 'expired-company']
  db.put('intel_digests', snapA._id, snapA)
  db.put('intel_digests', snapshot(B, today, { timezone: 'Pacific/Auckland' })._id,
    snapshot(B, today, { timezone: 'Pacific/Auckland', itemIds: ['b-item'] }))
  db.put('intel_items', 'item-1', item('item-1'))
  db.put('intel_items', 'item-2', item('item-2', { privateNote: 'secret two' }))
  db.put('intel_items', 'other-account-private', item('other-account-private', { sourceIds: ['unapproved-source'] }))
  db.put('intel_feedback', feedbackId(A, 'item-2', 2), { openid: A, itemId: 'item-2', generation: 2, state: { bookmarked: true } })
  db.put('intel_feedback', feedbackId(A, 'item-1', 1), { openid: A, itemId: 'item-1', generation: 1, state: { bookmarked: true } })
  db.put('intel_feedback', feedbackId(B, 'item-1', 2), { openid: B, itemId: 'item-1', generation: 2, state: { bookmarked: true } })

  let jobLoadCalls = 0
  let requestedJobIdentity = ''
  const safeJob = {
    companyId: 'verified-company', title: '已核验工程师', company: '公开企业', deadline: '2026-10-31',
    originalUrl: 'https://example.com/jobs/1', reason: '你标记的已核实岗位', privateNote: 'must not escape'
  }
  const loadJobItems = async (openid, ids) => {
    jobLoadCalls++
    requestedJobIdentity = openid
    assert.deepEqual(ids, ['verified-company', 'hidden-company', 'expired-company'])
    return [safeJob]
  }
  const handlers = createDigestHandlers({ db, now: () => now, loadJobItems })
  check(validTimestamp('2026-02-30T01:00:00Z') === null, 'invalid calendar timestamps are rejected')
  const todayResult = await handlers.intelDigestToday({ openid: B }, A)
  check(todayResult.digest.localDate === today, 'date uses server supplied timezone and current time')
  check(todayResult.digest.items.map(x => x.itemId).join(',') === 'item-2,item-1', 'saved ordering is preserved')
  check(todayResult.digest.items[0].feedback.bookmarked === true && todayResult.digest.items[1].feedback.bookmarked === false, 'today attaches only current-user current-generation bookmark state')
  check(todayResult.digest.jobItems.length === 1 && todayResult.digest.jobItems[0].companyId === 'verified-company', 'only currently revalidated snapshot companies are shown')
  check(requestedJobIdentity === A, 'job loader receives only server supplied identity')
  check(!JSON.stringify(todayResult.digest.jobItems).includes('privateNote'), 'job private fields are omitted')
  check(jobLoadCalls === 1, 'job loader only runs for snapshots with jobs')
  check(!JSON.stringify(todayResult).includes('privateNote'), 'private item fields are omitted')
  check(todayResult.digest.items.every(x => x.reason === '近期资讯'), 'reason is factual static text')
  const byDate = await handlers.intelDigestByDate({ localDate: today, openid: B }, A)
  check(byDate.digest.localDate === today && byDate.digest.items.map(x => x.itemId).join(',') === 'item-2,item-1', 'by-date reuses scoped snapshot and ignores event identity')
  check(byDate.digest.jobItems.length === 1 && byDate.digest.jobItems[0].companyId === 'verified-company', 'by-date jobs are revalidated for server user')
  check(byDate.digest.items[0].feedback.bookmarked === true && byDate.digest.items[1].feedback.bookmarked === false, 'by-date attaches only current-user current-generation bookmark state')
  db.put('intel_feedback', feedbackId(A, 'item-2', 2), { openid: A, itemId: 'item-2', generation: 2, state: { bookmarked: false } })
  check((await handlers.intelDigestByDate({ localDate: today }, A)).digest.items[0].feedback.bookmarked === false, 'bookmark revocation is reflected on subsequent reads')
  const emptyFeedbackCalls = db.queryCount('intel_feedback')
  const emptySnapshot = snapshot(A, '2026-10-26', { itemIds: [], jobCompanyIds: [] })
  db.put('intel_digests', emptySnapshot._id, emptySnapshot)
  await handlers.intelDigestByDate({ localDate: '2026-10-26' }, A)
  check(db.queryCount('intel_feedback') === emptyFeedbackCalls, 'empty item snapshots do not query feedback')
  const marked = await handlers.intelMarkDigestRead({ localDate: today, snapshotToken: todayResult.digest.snapshotToken, openid: B }, A)
  check(marked.ok === true && marked.readAt === new Date(now).toISOString(), 'read state uses server identity and server clock')
  const storedReadAt = db.rows('intel_digests').find(row => row._id === digestId(A, today, 2, 1, ZONE)).readAt
  check(storedReadAt === marked.readAt, 'read state updates the existing owned snapshot')
  const accountBSnapshotId = digestId(B, today, 2, 1, 'Pacific/Auckland')
  check(!db.rows('intel_digests').find(row => row._id === accountBSnapshotId).readAt, 'event identity cannot mark another user snapshot')
  await assert.rejects(handlers.intelMarkDigestRead({ localDate: today, snapshotToken: accountBSnapshotId }, A), error => error && error.code === 'stale_digest')
  checks++
  check(db.rows('intel_digests').find(row => row._id === snapA._id).readAt === marked.readAt, 'cross-account token does not alter the caller snapshot')
  check((await handlers.intelMarkDigestRead({ localDate: today, snapshotToken: todayResult.digest.snapshotToken }, A)).readAt === storedReadAt, 'read marking is idempotent')
  check((await handlers.intelDigestToday({ openid: B }, A)).digest.readAt === storedReadAt, 'today returns read timestamp')
  check((await handlers.intelDigestHistory({}, A)).digests.find(row => row.localDate === today).readAt === storedReadAt, 'history returns read timestamp')
  const beforeMissingRead = db.rows('intel_digests').length
  const missingReadId = digestId(A, '2026-10-27', 2, 1, ZONE)
  check((await handlers.intelMarkDigestRead({ localDate: '2026-10-27', snapshotToken: missingReadId }, A)).error === 'not_found' && db.rows('intel_digests').length === beforeMissingRead, 'missing snapshot is never created to mark read')
  await assert.rejects(handlers.intelMarkDigestRead({ localDate: '2026-10-30' }, A), error => error && error.code === 'bad_request')
  checks++
  db.put('intel_preferences', A, preference({ deleted: true }))
  check((await handlers.intelMarkDigestRead({ localDate: today, snapshotToken: todayResult.digest.snapshotToken }, A)).error === 'feature_disabled', 'deleted users cannot change digest read state')
  db.put('intel_preferences', A, preference())
  const staleReadDb = createDb()
  staleReadDb.put('intel_preferences', A, preference({ timezone: 'Pacific/Auckland' }))
  const oldZoneSnapshot = snapshot(A, today, { timezone: ZONE, generation: 2, digestGeneration: 1 })
  staleReadDb.put('intel_digests', oldZoneSnapshot._id, oldZoneSnapshot)
  const staleReadHandlers = createDigestHandlers({ db: staleReadDb, now: () => now })
  await assert.rejects(staleReadHandlers.intelMarkDigestRead({ localDate: today, snapshotToken: oldZoneSnapshot._id }, A), error => error && error.code === 'stale_digest')
  checks++
  const oldGenerationSnapshot = snapshot(A, today, { generation: 1, digestGeneration: 1 })
  staleReadDb.put('intel_digests', oldGenerationSnapshot._id, oldGenerationSnapshot)
  await assert.rejects(staleReadHandlers.intelMarkDigestRead({ localDate: today, snapshotToken: oldGenerationSnapshot._id }, A), error => error && error.code === 'stale_digest')
  checks++
  const aReadAfterStaleToken = staleReadDb.rows('intel_digests').find(row => row._id === oldZoneSnapshot._id).readAt
  check(aReadAfterStaleToken === undefined, 'stale timezone/generation tokens do not update old snapshots')
  const readFailureDb = createDb()
  readFailureDb.put('intel_preferences', A, preference())
  const readFailureSnapshot = snapshot(A, today)
  readFailureDb.put('intel_digests', readFailureSnapshot._id, readFailureSnapshot)
  readFailureDb.fail('intel_digests', readFailureSnapshot._id, Object.assign(new Error('write unavailable'), { errCode: -1 }))
  await assert.rejects(createDigestHandlers({ db: readFailureDb, now: () => now }).intelMarkDigestRead({ localDate: today, snapshotToken: readFailureSnapshot._id }, A), /write unavailable/)
  checks++
  check(!readFailureDb.rows('intel_digests')[0].readAt, 'failed read marking does not report success or alter the snapshot')
  const writeFailureDb = createDb()
  writeFailureDb.put('intel_preferences', A, preference())
  const writeFailureSnapshot = snapshot(A, today)
  writeFailureDb.put('intel_digests', writeFailureSnapshot._id, writeFailureSnapshot)
  writeFailureDb.failUpdate('intel_digests', writeFailureSnapshot._id, Object.assign(new Error('transaction write failed'), { errCode: -1 }))
  await assert.rejects(createDigestHandlers({ db: writeFailureDb, now: () => now }).intelMarkDigestRead({ localDate: today, snapshotToken: writeFailureSnapshot._id }, A), /transaction write failed/)
  checks++
  check(!writeFailureDb.rows('intel_digests')[0].readAt, 'transaction write failure cannot be reported as successful')
  for (const malformedIds of [undefined, 'verified-company', ['verified-company', 'verified-company'], ['a', 'b', 'c', 'd', 'e']]) {
    const malformedDb = createDb()
    malformedDb.put('intel_preferences', A, preference())
    const malformedSnapshot = snapshot(A, today, { itemIds: [], jobCompanyIds: ['verified-company'] })
    if (malformedIds === undefined) delete malformedSnapshot.jobCompanyIds
    else malformedSnapshot.jobCompanyIds = malformedIds
    malformedDb.put('intel_digests', malformedSnapshot._id, malformedSnapshot)
    let malformedJobReads = 0
    const malformedHandlers = createDigestHandlers({
      db: malformedDb,
      now: () => now,
      loadJobItems: async () => { malformedJobReads++; return [] }
    })
    await assert.rejects(malformedHandlers.intelDigestToday({}, A), error => error && error.code === 'server_error')
    check(malformedJobReads === 0, 'corrupt job company IDs fail before calling the private-data reader')
  }
  check((await handlers.intelDigestByDate({ localDate: '2026-10-28' }, A)).digest === null, 'missing historical date returns empty snapshot')
  await assert.rejects(handlers.intelDigestByDate({ localDate: '2026-02-30' }, A), error => error && error.code === 'bad_request')
  checks++
  await assert.rejects(handlers.intelDigestByDate({ localDate: '2026-10-30' }, A), error => error && error.code === 'bad_request')
  checks++

  let disabledTouches = 0
  const disabled = createDigestFeatureHandlers({ enabled: false, db: { collection () { disabledTouches++; throw new Error('must not touch database while disabled') } } })
  const disabledToday = await disabled.intelDigestToday({ openid: B }, A)
  const disabledByDate = await disabled.intelDigestByDate({ openid: B, localDate: today }, A)
  const disabledMark = await disabled.intelMarkDigestRead({ openid: B, localDate: today, snapshotToken: snapA._id }, A)
  const disabledHistory = await disabled.intelDigestHistory({ openid: B }, A)
  check(disabledToday.error === 'feature_disabled' && disabledByDate.error === 'feature_disabled' && disabledMark.error === 'feature_disabled' && disabledHistory.error === 'feature_disabled', 'disabled digest routes return a feature flag response')
  check(disabledTouches === 0, 'disabled digest routes do not access collections')
  const disabledJobs = createDigestFeatureHandlers({ enabled: false, loadJobItems () { throw new Error('disabled feature must not read jobs') }, db })
  check((await disabledJobs.intelDigestToday({}, A)).error === 'feature_disabled', 'disabled jobs route is inert')
  const gated = createDigestFeatureHandlers({ enabled: true, db, now: () => now, loadJobItems })
  const gatedResult = await gated.intelDigestToday({ openid: B }, A)
  check(gatedResult.digest.localDate === today, 'enabled feature router uses the server supplied identity over request data')
  const gatedByDate = await gated.intelDigestByDate({ openid: B, localDate: today }, A)
  check(gatedByDate.digest.localDate === today, 'enabled by-date route uses the server supplied identity over request data')

  const history = await handlers.intelDigestHistory({ openid: B }, A)
  check(history.digests.length === 2 && history.digests[0].localDate === today && history.digests[1].localDate === '2026-10-26', 'request event identity cannot substitute for server identity')
  check(history.digests[0].snapshotToken === snapA._id, 'history exposes only the owner-scoped snapshot token required for read state')
  check(history.digests[0].itemCount === 5 && history.nextCursor === null, 'history exposes bounded summary only')

  for (let offset = 1; offset <= 65; offset++) {
    const date = new Date(Date.UTC(2026, 9, 29 - offset)).toISOString().slice(0, 10)
    const row = snapshot(A, date)
    db.put('intel_digests', row._id, row)
  }
  const allDates = []
  let cursor
  do {
    const page = await handlers.intelDigestHistory({ cursor, limit: 30, openid: B }, A)
    allDates.push(...page.digests.map(row => row.localDate))
    cursor = page.nextCursor || undefined
  } while (cursor)
  check(allDates.length === 66, 'history cursor pages cover all own snapshots')
  check(new Set(allDates).size === 66, 'history cursor pages have no duplicates')
  check(allDates[0] === today && allDates.at(-1) === '2026-08-25', 'history pages are strictly descending with no omissions')
  await assert.rejects(handlers.intelDigestHistory({ cursor: 'not-a-date' }, A), error => error && error.code === 'bad_request')
  checks++
  await assert.rejects(handlers.intelDigestHistory({ limit: 31 }, A), error => error && error.code === 'bad_request')
  checks++
  const isolatedHistory = await handlers.intelDigestHistory({ cursor: '2026-08-20', openid: A }, B)
  check(isolatedHistory.digests.length === 0, 'cursor cannot bypass account-scoped history query')

  const corruptDb = createDb()
  corruptDb.put('intel_preferences', A, preference())
  const damaged = snapshot(A, '2026-10-10')
  damaged._id = 'corrupt-snapshot-key'
  corruptDb.put('intel_digests', damaged._id, damaged)
  const olderValid = snapshot(A, '2026-10-09')
  corruptDb.put('intel_digests', olderValid._id, olderValid)
  await assert.rejects(createDigestHandlers({ db: corruptDb, now: () => now }).intelDigestHistory({ limit: 1 }, A), error => error && error.code === 'server_error')
  checks++

  const malformedHistoryDb = malformedQueryResultDb(db, 'intel_digests', { data: undefined })
  await assert.rejects(createDigestHandlers({ db: malformedHistoryDb, now: () => now }).intelDigestHistory({}, A), error => error && error.code === 'server_error')
  checks++
  const malformedItemsDb = malformedQueryResultDb(db, 'intel_items', null)
  await assert.rejects(createDigestHandlers({ db: malformedItemsDb, now: () => now }).intelDigestToday({}, A), error => error && error.code === 'server_error')
  checks++

  db.put('intel_items', 'item-2', item('item-2', { status: 'draft' }))
  const filtered = await handlers.intelDigestToday({}, A)
  check(filtered.digest.items.length === 1 && filtered.digest.items[0].itemId === 'item-1', 'unpublished saved item is excluded')
  db.put('intel_items', 'item-2', item('item-2', { sourceIds: ['unapproved-source'] }))
  check((await handlers.intelDigestToday({}, A)).digest.items.length === 1, 'unapproved source is excluded')
  db.put('intel_items', 'item-2', item('item-2', { publishedAt: '2026-02-30T01:00:00.000Z' }))
  check((await handlers.intelDigestToday({}, A)).digest.items.length === 1, 'invalid publication date is excluded')

  db.put('intel_preferences', A, preference({ dailyDigestEnabled: false }))
  check((await handlers.intelDigestToday({}, A)).digest === null, 'disabled digest returns no content')
  const previousCalls = jobLoadCalls
  check((await handlers.intelDigestToday({}, A)).digest === null && jobLoadCalls === previousCalls, 'disabled digest never reads jobs')
  check((await handlers.intelDigestHistory({}, A)).digests.length === 0, 'disabled digest hides history')
  const originalCollection = db.collection.bind(db)
  db.collection = name => {
    if (name === 'intel_digests') throw new Error('disabled reads must not touch digest storage')
    return originalCollection(name)
  }
  check((await handlers.intelDigestByDate({ localDate: today }, A)).digest === null, 'disabled by-date read skips digest storage')
  db.collection = originalCollection
  db.put('intel_preferences', A, preference({ deleted: true }))
  check((await handlers.intelDigestToday({}, A)).digest === null, 'deleted user has no digest')
  check((await handlers.intelDigestByDate({ localDate: today }, A)).digest === null, 'deleted user cannot read historical digest')

  await assert.rejects(handlers.intelDigestToday({}, ''), /server identity/)
  checks++
  const errorDb = createDb()
  errorDb.put('intel_preferences', A, preference())
  errorDb.fail('intel_digests', digestId(A, today, 2, 1, ZONE), Object.assign(new Error('permission denied'), { errCode: -502005 }))
  await assert.rejects(createDigestHandlers({ db: errorDb, now: () => now }).intelDigestToday({}, A), /permission denied/)
  checks++
  const feedbackErrorDb = createDb()
  feedbackErrorDb.put('intel_preferences', A, preference())
  feedbackErrorDb.put('intel_digests', snapA._id, { ...snapA, jobCompanyIds: [] })
  feedbackErrorDb.put('intel_items', 'item-1', item('item-1'))
  feedbackErrorDb.failQuery('intel_feedback', Object.assign(new Error('feedback read denied'), { errCode: -502005 }))
  await assert.rejects(createDigestHandlers({ db: feedbackErrorDb, now: () => now }).intelDigestToday({}, A), /feedback read denied/)
  checks++
  const missingCollectionDb = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('database collection not exist') } }) }) }
  await assert.rejects(createDigestHandlers({ db: missingCollectionDb, now: () => now }).intelDigestToday({}, A), /collection not exist/)
  checks++

  console.log(`intel-digest-api: ${checks} assertions passed`)
}

run().catch(error => { console.error(error); process.exitCode = 1 })
