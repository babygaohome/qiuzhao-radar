'use strict'

const assert = require('node:assert/strict')
const { createDigestScheduler, MAX_BATCH } = require('../cloudfunctions/intelDigest/scheduler')

function fixture (options = {}) {
  const state = { cursor: null, busy: false, commits: [], releases: [], runs: [], pages: [], failures: new Map() }
  const scheduler = createDigestScheduler({
    enabled: options.enabled !== false,
    batchSize: options.batchSize || 2,
    isTrustedTimer: async (event, context) => {
      state.trustedCalls = (state.trustedCalls || 0) + 1
      return context && context.trusted === true && !(event && event.trusted === true)
    },
    leaseStore: {
      acquire: async ({ now, leaseMs }) => {
        state.acquireCalls = (state.acquireCalls || 0) + 1
        assert(Number.isFinite(now) && leaseMs > 0)
        if (state.busy) return { acquired: false }
        state.busy = true
        return { acquired: true, token: 'opaque-lease', cursor: state.cursor }
      },
      commitCursor: async record => {
        state.commits.push(record)
        state.cursor = record.cursor
        state.failures.delete(record.cursor ?? null)
      },
      recordPageFailure: async record => {
        if (options.failureCounterFails) throw new Error('private page counter backend failure')
        const key = record.cursor ?? null
        const attempts = (state.failures.get(key) || 0) + 1
        state.failures.set(key, attempts)
        state.recordedFailurePages = (state.recordedFailurePages || []).concat([{ token: record.token, cursor: key }])
        return { attempts }
      },
      release: async record => {
        state.releases.push(record)
        state.busy = false
        if (options.releaseFails) throw new Error('contains sensitive backend text')
      }
    },
    preferencePager: {
      listEnabled: async ({ cursor, limit }) => {
        assert(limit <= MAX_BATCH)
        state.pages.push({ cursor, limit })
        return options.page(cursor, limit)
      }
    },
    runUser: async openid => {
      state.runs.push(openid)
      if (options.userError) throw options.userError(openid)
      if (options.userFails && options.userFails(openid)) throw Object.assign(new Error(`PII ${openid}`), { code: 'database_unavailable' })
      if (options.disabledUser === openid) throw Object.assign(new Error('disabled'), { code: 'digest_disabled' })
    },
    now: () => 1234
  })
  return { scheduler, state }
}

async function run () {
  const off = fixture({ enabled: false, page: () => { throw new Error('must not scan') } })
  assert.deepEqual(await off.scheduler.run({}, { trusted: true }), { status: 'disabled', processed: 0, skipped: 0 })
  assert.equal(off.state.acquireCalls, undefined)

  const rejected = fixture({ page: () => { throw new Error('must not scan') } })
  assert.deepEqual(await rejected.scheduler.run({ trusted: true }, {}), { status: 'rejected', processed: 0, skipped: 0 })
  assert.equal(rejected.state.acquireCalls, undefined)

  const locked = fixture({ page: () => { throw new Error('must not scan') } })
  locked.state.busy = true
  assert.deepEqual(await locked.scheduler.run({}, { trusted: true }), { status: 'locked', processed: 0, skipped: 0 })

  const first = fixture({ page: (cursor, limit) => {
    assert.equal(cursor, null); assert.equal(limit, 2)
    return { users: [{ openid: 'a' }, { openid: 'b' }], nextCursor: 'cursor-2', done: false }
  }, disabledUser: 'b' })
  assert.deepEqual(await first.scheduler.run({}, { trusted: true }), { status: 'partial', processed: 1, skipped: 1 })
  assert.deepEqual(first.state.commits, [{ token: 'opaque-lease', cursor: 'cursor-2', done: false }])
  assert.deepEqual(first.state.releases, [{ token: 'opaque-lease', completed: false, cursorCommitted: true }])
  assert.deepEqual(first.state.runs, ['a', 'b'])

  const second = fixture({ page: cursor => {
    assert.equal(cursor, 'cursor-2')
    return { users: [{ openid: 'c' }], nextCursor: null, done: true }
  } })
  second.state.cursor = 'cursor-2'
  assert.deepEqual(await second.scheduler.run({}, { trusted: true }), { status: 'complete', processed: 1, skipped: 0 })
  assert.equal(second.state.cursor, null)
  assert.deepEqual(second.state.commits[0], { token: 'opaque-lease', cursor: null, done: true })

  // One bad user does not stop other users in the page. Persistent failures
  // hold the cursor for two runs; the third run advances it so later pages run.
  const retry = fixture({ page: cursor => cursor === 'cursor-next'
    ? ({ users: [{ openid: 'later-user' }], done: true })
    : ({ users: [{ openid: 'retry-me' }, { openid: 'already-saved' }], nextCursor: 'cursor-next', done: false }),
  userFails: id => id === 'retry-me' })
  for (let attempt = 1; attempt <= 2; attempt++) {
    assert.deepEqual(await retry.scheduler.run({}, { trusted: true }), { status: 'retry_pending', processed: 1, skipped: 0, failedCount: 1 })
    assert.equal(retry.state.commits.length, 0)
    assert.equal(retry.state.cursor, null)
    assert.deepEqual(retry.state.runs.slice(-2), ['retry-me', 'already-saved'])
  }
  assert.deepEqual(await retry.scheduler.run({}, { trusted: true }), { status: 'partial_with_failures', processed: 1, skipped: 0, failedCount: 1 })
  assert.equal(retry.state.cursor, 'cursor-next')
  assert.deepEqual(await retry.scheduler.run({}, { trusted: true }), { status: 'complete', processed: 1, skipped: 0 })
  assert.equal(retry.state.cursor, null)
  assert.deepEqual(retry.state.runs.slice(-3), ['retry-me', 'already-saved', 'later-user'])

  // Completion clears the failed page's counter. A later full scan retries the
  // previously failed user instead of permanently dropping it.
  const restart = fixture({ page: () => ({ users: [{ openid: 'retry-next-cycle' }], done: true }), userFails: () => true })
  for (let attempt = 1; attempt <= 3; attempt++) await restart.scheduler.run({}, { trusted: true })
  assert.equal(restart.state.cursor, null)
  assert.equal(restart.state.failures.get(null), undefined)
  assert.deepEqual(await restart.scheduler.run({}, { trusted: true }), { status: 'retry_pending', processed: 0, skipped: 0, failedCount: 1 })
  assert.equal(restart.state.runs.length, 4)

  const counterFailure = fixture({ page: () => ({ users: [{ openid: 'user' }], done: true }), userFails: () => true, failureCounterFails: true })
  await assert.rejects(counterFailure.scheduler.run({}, { trusted: true }), error => error.code === 'digest_user_failed' && !error.message.includes('private'))
  assert.equal(counterFailure.state.commits.length, 0)
  assert.equal(counterFailure.state.cursor, null)

  // Only the exact nonexistent local digest time is a per-user skip.
  const dstSkip = fixture({ page: () => ({ users: [{ openid: 'dst-user' }], done: true }), userError: () => new RangeError('nonexistent_local_time') })
  assert.deepEqual(await dstSkip.scheduler.run({}, { trusted: true }), { status: 'complete', processed: 0, skipped: 1 })
  assert.equal(dstSkip.state.commits.length, 1)

  const dstLookalike = fixture({ page: () => ({ users: [{ openid: 'dst-user' }], done: true }), userError: () => new RangeError('nonexistent_local_time ' + 'sensitive') })
  assert.deepEqual(await dstLookalike.scheduler.run({}, { trusted: true }), { status: 'retry_pending', processed: 0, skipped: 0, failedCount: 1 })
  assert.equal(dstLookalike.state.commits.length, 0)

  const codeLeak = fixture({ page: () => ({ users: [{ openid: 'private-id' }], done: true }), userError: id => Object.assign(new Error('private data'), { code: `oops_${id}` }) })
  assert.deepEqual(await codeLeak.scheduler.run({}, { trusted: true }), { status: 'retry_pending', processed: 0, skipped: 0, failedCount: 1 })
  assert.equal(codeLeak.state.commits.length, 0)

  const invalidPage = fixture({ page: () => ({ users: Array.from({ length: 51 }, (_, i) => ({ openid: `u${i}` })), nextCursor: 'x', done: false }) })
  await assert.rejects(invalidPage.scheduler.run({}, { trusted: true }), error => error.code === 'invalid_preference_page')
  assert.equal(invalidPage.state.commits.length, 0)

  const releaseFail = fixture({ page: () => ({ users: [], done: true }), releaseFails: true })
  await assert.rejects(releaseFail.scheduler.run({}, { trusted: true }), error => error.code === 'lease_release_failed' && !error.message.includes('sensitive'))

  const duplicate = fixture({ page: () => ({ users: [{ openid: 'same' }, { openid: 'same' }], done: true }) })
  await assert.rejects(duplicate.scheduler.run({}, { trusted: true }), error => error.code === 'invalid_preference_identity')
  assert.equal(duplicate.state.commits.length, 0)

  assert.throws(() => createDigestScheduler({ batchSize: 51, isTrustedTimer: async () => true, leaseStore: { acquire: async () => ({}), recordPageFailure: async () => ({ attempts: 1 }), commitCursor: async () => {}, release: async () => {} }, preferencePager: { listEnabled: async () => ({ users: [], done: true }) }, runUser: async () => {} }), /batchSize/)
  assert.throws(() => createDigestScheduler({ isTrustedTimer: async () => true, leaseStore: { acquire: async () => ({}), commitCursor: async () => {}, release: async () => {} }, preferencePager: { listEnabled: async () => ({ users: [], done: true }) }, runUser: async () => {} }), /recordPageFailure/)
  console.log('intel-digest-scheduler: all assertions passed')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
