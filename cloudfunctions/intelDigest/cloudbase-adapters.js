'use strict'

const crypto = require('crypto')

const SCHEDULER_STATE_ID = '__intel_digest_scheduler__'
const MAX_BATCH = 50
const MAX_PAGE_FAILURE_ATTEMPTS = 10

function fail (code) { return Object.assign(new Error(code), { code }) }

function pageCursorHash (cursor) {
  return crypto.createHash('sha256').update(cursor === null ? 'digest-page:start' : `digest-page:${cursor}`).digest('hex')
}

function missingDocument (error) {
  const message = String(error && (error.message || error.errMsg || error))
  if (/permission|denied|collection.*(?:not exist|not found)|database collection not exist/i.test(message)) return false
  const code = error && (error.errCode !== undefined ? error.errCode : error.code)
  return code === 'DATABASE_DOCUMENT_NOT_EXIST' || (code === -1 && /document with _id .+ does not exist/i.test(message))
}

async function optionalDoc (db, collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get()
    return result && result.data && !Array.isArray(result.data) ? result.data : null
  } catch (error) {
    if (missingDocument(error)) return null
    throw error
  }
}

function createLeaseStore (db, { now = () => Date.now(), makeToken = () => crypto.randomBytes(24).toString('hex') } = {}) {
  if (!db || typeof db.runTransaction !== 'function' || typeof db.collection !== 'function') throw new TypeError('CloudBase database is required')

  async function readState (tx) { return optionalDoc(tx, 'intel_runs', SCHEDULER_STATE_ID) }
  function assertOwner (state, token) {
    const expiresAt = state && Number(state.expiresAt)
    if (!state || typeof token !== 'string' || state.token !== token ||
      !Number.isFinite(expiresAt) || expiresAt <= now()) throw fail('lease_lost')
  }

  return {
    async acquire ({ now: at = now(), leaseMs } = {}) {
      if (!Number.isFinite(at) || !Number.isFinite(leaseMs) || leaseMs < 1000) throw fail('invalid_lease')
      const token = makeToken()
      if (typeof token !== 'string' || token.length < 24 || token.length > 128) throw fail('invalid_lease_token')
      return db.runTransaction(async tx => {
        const current = await readState(tx)
        if (current && Number(current.expiresAt) > at) return { acquired: false }
        const cursor = current && typeof current.cursor === 'string' ? current.cursor : null
        const data = {
          token, acquiredAt: at, expiresAt: at + leaseMs, cursor,
          failureCursorHash: current && typeof current.failureCursorHash === 'string' ? current.failureCursorHash : null,
          failureAttempts: Number.isSafeInteger(current && current.failureAttempts) ? Math.min(current.failureAttempts, MAX_PAGE_FAILURE_ATTEMPTS) : 0
        }
        await tx.collection('intel_runs').doc(SCHEDULER_STATE_ID).set({ data })
        return { acquired: true, token, cursor, failureAttempts: data.failureAttempts }
      })
    },

    async recordPageFailure ({ token, cursor } = {}) {
      if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 1024)) throw fail('invalid_cursor')
      return db.runTransaction(async tx => {
        const current = await readState(tx)
        assertOwner(current, token)
        const stateCursor = typeof current.cursor === 'string' ? current.cursor : null
        if (stateCursor !== cursor) throw fail('cursor_mismatch')
        const failureCursorHash = pageCursorHash(cursor)
        const previousAttempts = current.failureCursorHash === failureCursorHash && Number.isSafeInteger(current.failureAttempts)
          ? Math.max(0, current.failureAttempts)
          : 0
        const attempts = Math.min(previousAttempts + 1, MAX_PAGE_FAILURE_ATTEMPTS)
        await tx.collection('intel_runs').doc(SCHEDULER_STATE_ID).update({ data: {
          failureCursorHash,
          failureAttempts: attempts
        } })
        return { attempts }
      })
    },

    async commitCursor ({ token, cursor, done = false } = {}) {
      if (!done && (typeof cursor !== 'string' || !cursor || cursor.length > 1024)) throw fail('invalid_cursor')
      return db.runTransaction(async tx => {
        const current = await readState(tx)
        assertOwner(current, token)
        const data = {
          cursor: done ? null : cursor,
          completedAt: done ? now() : null,
          expiresAt: current.expiresAt,
          token: current.token,
          acquiredAt: current.acquiredAt,
          failureCursorHash: null,
          failureAttempts: 0
        }
        await tx.collection('intel_runs').doc(SCHEDULER_STATE_ID).update({ data })
        return { committed: true, cursor: data.cursor }
      })
    },

    async release ({ token, completed = false, cursorCommitted = false } = {}) {
      return db.runTransaction(async tx => {
        const current = await readState(tx)
        assertOwner(current, token)
        await tx.collection('intel_runs').doc(SCHEDULER_STATE_ID).update({ data: {
          expiresAt: now(),
          lastCompleted: completed === true && cursorCommitted === true,
          releasedAt: now()
        } })
        return { released: true }
      })
    }
  }
}

function createPreferencePager (db) {
  if (!db || typeof db.collection !== 'function' || !db.command || typeof db.command.gt !== 'function') throw new TypeError('CloudBase database commands are required')
  return {
    async listEnabled ({ cursor = null, limit = 25 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) throw fail('invalid_batch')
      if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 128)) throw fail('invalid_cursor')
      const after = cursor || ''
      const result = await db.collection('intel_preferences')
        .where({ _id: db.command.gt(after), dailyDigestEnabled: true })
        .field({ _id: true, deleted: true, dailyDigestEnabled: true })
        .orderBy('_id', 'asc')
        .limit(limit + 1)
        .get()
      if (!result || !Array.isArray(result.data)) throw fail('database_unavailable')
      const rows = result.data
      const done = rows.length <= limit
      const page = rows.slice(0, limit)
      const users = page
        .filter(row => row && row.deleted !== true && row.dailyDigestEnabled === true &&
          typeof row._id === 'string' && row._id.length > 0 && row._id.length <= 128)
        .map(row => ({ openid: row._id }))
      return {
        users,
        done,
        nextCursor: done || !page.length ? null : page[page.length - 1]._id
      }
    }
  }
}

module.exports = { createLeaseStore, createPreferencePager, SCHEDULER_STATE_ID, MAX_BATCH, MAX_PAGE_FAILURE_ATTEMPTS, missingDocument }
