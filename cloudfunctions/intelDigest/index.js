'use strict'

const TRIGGER_NAME = 'intelDigestHourly'
const READ_BATCH = 100
const MAX_WINDOW_ITEMS = 300
const INTERNAL_USER = Symbol('trusted_scheduler_user')

function validTimerEnvelope (event, runtimeEnv, wxContext) {
  if (!runtimeEnv || runtimeEnv.TRIGGER_SRC !== 'timer') return false
  if (!isTrustedRuntimeContext(runtimeEnv) || !isTrustedRuntimeContext(wxContext)) return false
  return !!(event && typeof event === 'object' && event.Type === 'timer' &&
    event.TriggerName === TRIGGER_NAME && typeof event.Time === 'string' &&
    Number.isFinite(Date.parse(event.Time)))
}

function isTrustedRuntimeContext (context) {
  if (!context || typeof context !== 'object') return false
  for (const key of ['OPENID', 'WX_OPENID', 'UID', 'WX_UID']) if (context[key]) return false
  for (const key of ['SOURCE', 'TCB_SOURCE']) {
    const value = context[key]
    if (value && !['scf', 'wx_trigger'].includes(value)) return false
  }
  return true
}

function safeTimerResult (result) {
  const source = result && typeof result === 'object' ? result : {}
  return {
    status: ['disabled', 'rejected', 'locked', 'partial', 'retry_pending', 'partial_with_failures', 'complete'].includes(source.status) ? source.status : 'failed',
    processed: Number.isSafeInteger(source.processed) && source.processed >= 0 ? source.processed : 0,
    skipped: Number.isSafeInteger(source.skipped) && source.skipped >= 0 ? source.skipped : 0,
    failed: Number.isSafeInteger(source.failed) && source.failed >= 0
      ? source.failed
      : (Number.isSafeInteger(source.failedCount) && source.failedCount >= 0 ? source.failedCount : 0)
  }
}

function createMain ({
  processEnv = process.env,
  loadCloud = () => require('wx-server-sdk'),
  getRuntimeEnv = context => require('@cloudbase/node-sdk').getCloudbaseContext(context),
  makeScheduler
} = {}) {
  return async function main (event, runtimeContext) {
    if (processEnv.INTEL_DIGEST_ENABLED !== 'true') return { status: 'disabled', processed: 0, skipped: 0, failed: 0 }
    let cloud
    let runtimeEnv
    let wxContext
    try {
      cloud = loadCloud()
      cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
      runtimeEnv = getRuntimeEnv(runtimeContext)
      wxContext = cloud.getWXContext() || {}
    } catch (_) {
      return { status: 'failed', processed: 0, skipped: 0, failed: 0 }
    }
    if (!validTimerEnvelope(event, runtimeEnv, wxContext)) return { status: 'rejected', processed: 0, skipped: 0, failed: 0 }

    let db
    try { db = cloud.database({ throwOnNotFound: false }) } catch (_) {
      return { status: 'failed', processed: 0, skipped: 0, failed: 0 }
    }
    const { createLeaseStore, createPreferencePager } = require('./cloudbase-adapters')
    const { createSnapshotStore } = require('./snapshot-store')
    const { createDigestService } = require('./service')
    const { createDigestScheduler } = require('./scheduler')

    const readPreferences = async openid => {
      const result = await db.collection('intel_preferences').doc(openid).get()
      return result && result.data || null
    }
    const readItems = async ({ start, end }) => readPublicWindow(db, { start, end })
    const snapshots = createSnapshotStore({ db })
    const service = createDigestService({
      resolveIdentity: context => context && context[INTERNAL_USER] === true && typeof context.openid === 'string' ? context.openid : '',
      readPreferences,
      readItems,
      snapshotStore: snapshots
    })
    const scheduler = (makeScheduler || createDigestScheduler)({
      enabled: true,
      isTrustedTimer: (candidateEvent, candidateContext) => validTimerEnvelope(candidateEvent, runtimeEnv, candidateContext),
      leaseStore: createLeaseStore(db),
      preferencePager: createPreferencePager(db),
      runUser: openid => service.generate({}, { [INTERNAL_USER]: true, openid })
    })
    try {
      return safeTimerResult(await scheduler.run(event, wxContext))
    } catch (_) {
      return { status: 'failed', processed: 0, skipped: 0, failed: 0 }
    }
  }
}

async function readPublicWindow (db, { start, end }) {
  if (!db || !db.command || typeof db.command.and !== 'function' || typeof db.command.gt !== 'function') throw safeError('feed_unavailable')
  const items = []
  let cursor = ''
  for (let page = 0; page < 3; page++) {
    const conditions = [
      { status: 'published', dateStatus: 'confirmed' },
      { publishedAt: db.command.gte(start) },
      { publishedAt: db.command.lte(end) }
    ]
    if (cursor) conditions.push({ _id: db.command.gt(cursor) })
    const result = await db.collection('intel_items')
      .where(db.command.and(conditions))
      .field({ _id: true, id: true, status: true, dateStatus: true, category: true, title: true, sourceName: true, sourceKind: true, sourceIds: true, originalUrl: true, publishedAt: true, summaryZh: true, topicTags: true, tags: true, subtopics: true })
      .orderBy('_id', 'asc')
      .limit(READ_BATCH)
      .get()
    const rows = requireRows(result)
    if (items.length + rows.length > MAX_WINDOW_ITEMS) throw safeError('feed_window_overflow')
    items.push(...rows)
    if (rows.length < READ_BATCH) return items
    const lastId = rows[rows.length - 1] && rows[rows.length - 1]._id
    if (typeof lastId !== 'string' || !lastId || lastId === cursor) throw safeError('feed_unavailable')
    cursor = lastId
  }

  // A fourth bounded query detects truncation. Never silently generate a digest
  // from only the first 300 records in a dense window.
  const result = await db.collection('intel_items')
    .where(db.command.and([
      { status: 'published', dateStatus: 'confirmed' },
      { publishedAt: db.command.gte(start) },
      { publishedAt: db.command.lte(end) },
      { _id: db.command.gt(cursor) }
    ]))
    .field({ _id: true })
    .orderBy('_id', 'asc')
    .limit(1)
    .get()
  const probeRows = requireRows(result)
  if (probeRows.length) throw safeError('feed_window_overflow')
  return items
}

function requireRows (result) {
  if (!result || !Array.isArray(result.data)) throw safeError('feed_unavailable')
  return result.data
}

function safeError (code) { return Object.assign(new Error(code), { code }) }

exports.main = createMain()
exports._test = { TRIGGER_NAME, READ_BATCH, MAX_WINDOW_ITEMS, INTERNAL_USER, validTimerEnvelope, isTrustedRuntimeContext, safeTimerResult, createMain, readPublicWindow, requireRows }
exports.createMain = createMain
exports.validTimerEnvelope = validTimerEnvelope
exports.safeTimerResult = safeTimerResult
exports.TRIGGER_NAME = TRIGGER_NAME
exports.readPublicWindow = readPublicWindow
exports.MAX_WINDOW_ITEMS = MAX_WINDOW_ITEMS
exports.requireRows = requireRows
