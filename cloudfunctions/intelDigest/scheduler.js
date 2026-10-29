'use strict'

const MAX_BATCH = 50
const DEFAULT_BATCH = 25
const DEFAULT_LEASE_MS = 4 * 60 * 1000
const SKIPPABLE_USER_ERRORS = new Set(['digest_disabled', 'digest_not_due', 'digest_date_not_current'])
const SAFE_ERROR_CODES = new Set([
  'database_unavailable', 'digest_user_failed', 'feed_unavailable', 'invalid_cursor',
  'invalid_preference_identity', 'invalid_preference_page', 'stale_digest_generation',
  'stale_generation', 'stale_timezone'
])

function safeError (error) {
  const code = error && SAFE_ERROR_CODES.has(error.code) ? error.code : 'digest_user_failed'
  return Object.assign(new Error(code), { code })
}

function createDigestScheduler ({
  enabled = false,
  isTrustedTimer,
  leaseStore,
  preferencePager,
  runUser,
  now = () => Date.now(),
  batchSize = DEFAULT_BATCH,
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  if (typeof isTrustedTimer !== 'function') throw new TypeError('isTrustedTimer must be a function')
  if (!leaseStore || typeof leaseStore.acquire !== 'function' || typeof leaseStore.commitCursor !== 'function' || typeof leaseStore.release !== 'function') throw new TypeError('leaseStore is required')
  if (typeof leaseStore.recordPageFailure !== 'function') throw new TypeError('leaseStore.recordPageFailure is required')
  if (!preferencePager || typeof preferencePager.listEnabled !== 'function') throw new TypeError('preferencePager is required')
  if (typeof runUser !== 'function') throw new TypeError('runUser must be a function')
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) throw new TypeError('batchSize must be between 1 and 50')
  if (!Number.isFinite(leaseMs) || leaseMs < 1000 || leaseMs > 15 * 60 * 1000) throw new TypeError('leaseMs is invalid')

  async function run (event, runtimeContext) {
    if (!enabled) return { status: 'disabled', processed: 0, skipped: 0 }
    if (!await isTrustedTimer(event, runtimeContext)) return { status: 'rejected', processed: 0, skipped: 0 }

    const acquiredAt = now()
    const lease = await leaseStore.acquire({ now: acquiredAt, leaseMs })
    if (!lease || lease.acquired !== true || typeof lease.token !== 'string' || !lease.token) {
      return { status: 'locked', processed: 0, skipped: 0 }
    }

    let processed = 0
    let skipped = 0
    let failed = 0
    let completed = false
    let cursorCommitted = false
    try {
      const page = await preferencePager.listEnabled({ cursor: lease.cursor ?? null, limit: batchSize })
      if (!page || !Array.isArray(page.users) || page.users.length > batchSize || typeof page.done !== 'boolean') {
        throw Object.assign(new Error('invalid preference page'), { code: 'invalid_preference_page' })
      }
      const seen = new Set()
      for (const user of page.users) {
        if (!user || typeof user.openid !== 'string' || !user.openid.trim() || user.openid.length > 128 || seen.has(user.openid)) {
          throw Object.assign(new Error('invalid preference identity'), { code: 'invalid_preference_identity' })
        }
        seen.add(user.openid)
        try {
          // This adapter is a trusted server-side bridge to the generator. User
          // IDs never come from the timer event and are never returned or logged.
          await runUser(user.openid)
          processed++
        } catch (error) {
          if (SKIPPABLE_USER_ERRORS.has(error && error.code) ||
            (error instanceof RangeError && error.message === 'nonexistent_local_time')) {
            skipped++
            continue
          }
          failed++
        }
      }

      const nextCursor = page.done ? null : page.nextCursor
      if (!page.done && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 1024)) {
        throw Object.assign(new Error('invalid cursor'), { code: 'invalid_cursor' })
      }
      if (failed > 0) {
        const retry = await leaseStore.recordPageFailure({ token: lease.token, cursor: lease.cursor ?? null })
        if (!retry || !Number.isSafeInteger(retry.attempts) || retry.attempts < 1) {
          throw Object.assign(new Error('invalid page failure count'), { code: 'invalid_page_failure_count' })
        }
        if (retry.attempts < 3) {
          return { status: 'retry_pending', processed, skipped, failedCount: failed }
        }
        await leaseStore.commitCursor({ token: lease.token, cursor: nextCursor, done: page.done === true })
        cursorCommitted = true
        completed = page.done === true
        return { status: 'partial_with_failures', processed, skipped, failedCount: failed }
      }

      await leaseStore.commitCursor({ token: lease.token, cursor: nextCursor, done: page.done === true })
      cursorCommitted = true
      completed = page.done === true
      return { status: completed ? 'complete' : 'partial', processed, skipped }
    } catch (error) {
      // Never advance the durable cursor on a failed page. Successful per-user
      // saves are idempotent, so retrying this page cannot duplicate snapshots.
      throw safeError(error)
    } finally {
      try {
        await leaseStore.release({ token: lease.token, completed, cursorCommitted })
      } catch (_) {
        throw Object.assign(new Error('lease_release_failed'), { code: 'lease_release_failed' })
      }
    }
  }

  return { run }
}

module.exports = { createDigestScheduler, MAX_BATCH, DEFAULT_BATCH, DEFAULT_LEASE_MS, SKIPPABLE_USER_ERRORS, SAFE_ERROR_CODES }
