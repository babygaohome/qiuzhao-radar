'use strict'

const assert = require('node:assert/strict')
const { createMain, validTimerEnvelope, safeTimerResult, readPublicWindow, TRIGGER_NAME, MAX_WINDOW_ITEMS } = require('../cloudfunctions/intelDigest')

function fakeCloud ({ context = {}, db } = {}) {
  const calls = { init: 0, database: 0, getWXContext: 0 }
  return {
    calls,
    DYNAMIC_CURRENT_ENV: Symbol('dynamic'),
    init () { calls.init++ },
    getWXContext () { calls.getWXContext++; return context },
    database () { calls.database++; return db }
  }
}
function fakeDb () {
  return {
    command: { gt: () => ({}) },
    runTransaction: async fn => fn({ collection: () => ({}) }),
    collection: () => ({})
  }
}
function timer () { return { Type: 'timer', TriggerName: TRIGGER_NAME, Time: '2026-10-29T00:00:00.000Z' } }

async function main () {
  let loads = 0
  const disabled = createMain({ processEnv: {}, loadCloud: () => { loads++; throw new Error('must not load SDK') } })
  assert.deepEqual(await disabled(timer(), {}), { status: 'disabled', processed: 0, skipped: 0, failed: 0 })
  assert.equal(loads, 0)

  assert.deepEqual(safeTimerResult({ status: 'partial_with_failures', processed: 4, skipped: 2, failedCount: 3, openid: 'private-user', details: ['secret'] }), {
    status: 'partial_with_failures', processed: 4, skipped: 2, failed: 3
  })
  assert.deepEqual(safeTimerResult({ status: 'partial_with_failures', processed: 1, skipped: 0, failed: 2 }), {
    status: 'partial_with_failures', processed: 1, skipped: 0, failed: 2
  })
  assert.deepEqual(safeTimerResult({ status: 'retry_pending', processed: 1, skipped: 0, failedCount: 1 }), {
    status: 'retry_pending', processed: 1, skipped: 0, failed: 1
  })
  assert.deepEqual(safeTimerResult({ status: 'partial_with_failures', processed: -1, skipped: NaN, failedCount: -7, openid: 'secret' }), {
    status: 'partial_with_failures', processed: 0, skipped: 0, failed: 0
  })

  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer' }, { SOURCE: 'scf' }), true)
  assert.equal(validTimerEnvelope({ ...timer(), source: 'timer' }, {}, {}), false, 'event cannot create a trusted runtime marker')
  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer' }, { OPENID: 'person', SOURCE: 'wx_devtools' }), false)
  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer' }, { SOURCE: 'tcbgw' }), false)
  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer', WX_OPENID: 'person' }, { SOURCE: 'scf' }), false)
  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer', UID: 'person' }, { SOURCE: 'scf' }), false)
  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer', SOURCE: 'tcbgw' }, {}), false)
  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer', TCB_SOURCE: 'unknown' }, {}), false)
  assert.equal(validTimerEnvelope(timer(), { TRIGGER_SRC: 'timer' }, { TCB_SOURCE: 'tcbgw' }), false)
  assert.equal(validTimerEnvelope({ ...timer(), TriggerName: 'other' }, { TRIGGER_SRC: 'timer' }, { SOURCE: 'scf' }), false)

  const db = fakeDb()
  const cloud = fakeCloud({ context: { SOURCE: 'scf' }, db })
  const enabled = createMain({
    processEnv: { INTEL_DIGEST_ENABLED: 'true' },
    loadCloud: () => cloud,
    getRuntimeEnv: () => ({ TRIGGER_SRC: 'timer' }),
    makeScheduler: options => ({ run: async (event, context) => {
      assert.equal(event.TriggerName, TRIGGER_NAME)
      assert.equal(context.SOURCE, 'scf')
      assert.equal(typeof options.runUser, 'function')
      return { status: 'partial', processed: 2, skipped: 1, privateData: 'never return' }
    } })
  })
  assert.deepEqual(await enabled(timer(), {}), { status: 'partial', processed: 2, skipped: 1, failed: 0 })
  assert.equal(cloud.calls.database, 1)

  const identity = fakeCloud({ context: { OPENID: 'person', SOURCE: 'wx_client' }, db })
  const rejectIdentity = createMain({ processEnv: { INTEL_DIGEST_ENABLED: 'true' }, loadCloud: () => identity, getRuntimeEnv: () => ({ TRIGGER_SRC: 'timer' }) })
  assert.equal((await rejectIdentity(timer(), {})).status, 'rejected')
  assert.equal(identity.calls.database, 0)

  const untrusted = fakeCloud({ context: { SOURCE: 'scf' }, db })
  const rejectRuntime = createMain({ processEnv: { INTEL_DIGEST_ENABLED: 'true' }, loadCloud: () => untrusted, getRuntimeEnv: () => ({}) })
  assert.equal((await rejectRuntime(timer(), {})).status, 'rejected')
  assert.equal(untrusted.calls.database, 0)

  const runtimeError = fakeCloud({ context: { SOURCE: 'scf' }, db })
  const failRuntime = createMain({ processEnv: { INTEL_DIGEST_ENABLED: 'true' }, loadCloud: () => runtimeError, getRuntimeEnv: () => { throw new Error('secret') } })
  assert.deepEqual(await failRuntime(timer(), {}), { status: 'failed', processed: 0, skipped: 0, failed: 0 })
  assert.equal(runtimeError.calls.database, 0)
  const initFailure = createMain({ processEnv: { INTEL_DIGEST_ENABLED: 'true' }, loadCloud: () => ({ init () { throw new Error('private runtime error') } }) })
  assert.deepEqual(await initFailure(timer(), {}), { status: 'failed', processed: 0, skipped: 0, failed: 0 })

  const publicRows = Array.from({ length: MAX_WINDOW_ITEMS }, (_, index) => ({ _id: `item-${String(index).padStart(3, '0')}`, status: 'published', privateNote: 'must not be selected' }))
  const projections = []
  const queryDb = {
    malformedResult: false,
    command: { and: conditions => conditions, gt: value => ({ gt: value }), gte: value => ({ gte: value }), lte: value => ({ lte: value }) },
    collection (name) {
      assert.equal(name, 'intel_items')
      return {
        where (condition) {
          return {
            field (projection) {
              projections.push(projection)
              return {
                orderBy () {
                  return {
                    limit (n) {
                      return { get: async () => {
                        if (queryDb.malformedResult) return { unexpected: true }
                        const cursor = condition.find(entry => entry && entry._id && entry._id.gt)
                        const eligible = publicRows.filter(row => !cursor || row._id > cursor._id.gt)
                        return { data: eligible.slice(0, n) }
                      } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  const loaded = await readPublicWindow(queryDb, { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' })
  assert.equal(loaded.length, MAX_WINDOW_ITEMS)
  assert.equal(projections.some(projection => Object.hasOwn(projection, 'privateNote')), false)
  publicRows.push({ _id: 'item-overflow', status: 'published' })
  await assert.rejects(readPublicWindow(queryDb, { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' }), error => error.code === 'feed_window_overflow')
  queryDb.malformedResult = true
  await assert.rejects(readPublicWindow(queryDb, { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' }), error => error.code === 'feed_unavailable')

  console.log('intel-digest-entry: all assertions passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
