'use strict'

const assert = require('node:assert/strict')
const { createLeaseStore, createPreferencePager, SCHEDULER_STATE_ID } = require('../cloudfunctions/intelDigest/cloudbase-adapters')

const missing = id => Object.assign(new Error(`document.get:fail document with _id ${id} does not exist`), { errCode: -1 })

function database (initial = {}) {
  const state = structuredClone(initial)
  let transactionQueue = Promise.resolve()
  const command = { gt: value => ({ $gt: value }) }

  function makeDb (tables) {
    const api = {
      command,
      async runTransaction (fn) {
        let unlock
        const next = new Promise(resolve => { unlock = resolve })
        const previous = transactionQueue
        transactionQueue = previous.then(() => next)
        await previous
        const working = structuredClone(tables)
        try {
          const result = await fn(makeDb(working))
          for (const key of Object.keys(tables)) delete tables[key]
          Object.assign(tables, working)
          return result
        } finally { unlock() }
      },
      collection (name) {
        if (!tables[name]) tables[name] = {}
        const rows = tables[name]
        const collection = {
          doc (id) {
            return {
              async get () {
                if (!Object.prototype.hasOwnProperty.call(rows, id)) throw missing(id)
                return { data: structuredClone(rows[id]) }
              },
              async set ({ data }) {
                assert.equal(Object.hasOwn(data, '_id'), false, 'doc.set payload must not include _id')
                rows[id] = Object.assign({}, structuredClone(data), { _id: id })
                return { stats: { updated: 1 } }
              },
              async update ({ data }) {
                if (!Object.prototype.hasOwnProperty.call(rows, id)) throw missing(id)
                Object.assign(rows[id], structuredClone(data))
                return { stats: { updated: 1 } }
              }
            }
          },
          where (query) {
            let sortKey = null
            let sortDirection = 'asc'
            let max = Infinity
            return {
              field () { return this },
              orderBy (key, direction) { sortKey = key; sortDirection = direction; return this },
              limit (n) { max = n; return this },
              async get () {
                let values = Object.entries(rows).filter(([id, row]) => {
                  const idCondition = query._id
                  const matchId = idCondition && typeof idCondition === 'object' && '$gt' in idCondition
                    ? id > idCondition.$gt
                    : idCondition === undefined || id === idCondition
                  return matchId && Object.entries(query).filter(([key]) => key !== '_id').every(([key, value]) => row[key] === value)
                }).map(([, row]) => structuredClone(row))
                if (sortKey) values.sort((a, b) => String(a[sortKey]).localeCompare(String(b[sortKey])) * (sortDirection === 'desc' ? -1 : 1))
                return { data: values.slice(0, max) }
              }
            }
          }
        }
        return collection
      }
    }
    return api
  }
  return { db: makeDb(state), state }
}

async function run () {
  let now = 10000
  const { db, state } = database()
  const leases = createLeaseStore(db, { now: () => now, makeToken: (() => { let n = 0; return () => `fixed-token-${++n}-abcdefghijklmnop` })() })

  const [first, contested] = await Promise.all([
    leases.acquire({ now, leaseMs: 5000 }),
    leases.acquire({ now, leaseMs: 5000 })
  ])
  assert.equal([first, contested].filter(x => x.acquired).length, 1, 'only one concurrent lease acquisition succeeds')
  const owner = first.acquired ? first : contested
  assert.equal(typeof owner.token, 'string')
  assert.equal(owner.cursor, null)
  assert.equal(state.intel_runs[SCHEDULER_STATE_ID]._id, SCHEDULER_STATE_ID)
  assert.equal(state.intel_runs[SCHEDULER_STATE_ID].cursor, null)

  await assert.rejects(leases.commitCursor({ token: 'wrong-token', cursor: 'a' }), error => error.code === 'lease_lost')
  await assert.rejects(leases.recordPageFailure({ token: owner.token, cursor: 'unexpected-user' }), error => error.code === 'cursor_mismatch')
  assert.deepEqual(await leases.recordPageFailure({ token: owner.token, cursor: null }), { attempts: 1 })
  assert.deepEqual(await leases.recordPageFailure({ token: owner.token, cursor: null }), { attempts: 2 })
  assert.notEqual(state.intel_runs[SCHEDULER_STATE_ID].failureCursorHash, null)
  assert.equal(Object.hasOwn(state.intel_runs[SCHEDULER_STATE_ID], 'lastError'), false, 'raw failures are never persisted')
  await leases.commitCursor({ token: owner.token, cursor: 'user-b' })
  assert.equal(state.intel_runs[SCHEDULER_STATE_ID].failureAttempts, 0, 'successful page commit clears failure counter')
  await assert.rejects(leases.release({ token: 'wrong-token' }), error => error.code === 'lease_lost')
  await leases.release({ token: owner.token, completed: false, cursorCommitted: true })

  const resumed = await leases.acquire({ now, leaseMs: 5000 })
  assert.equal(resumed.cursor, 'user-b', 'durable cursor is resumed')
  now += 6000
  await assert.rejects(leases.commitCursor({ token: resumed.token, cursor: 'user-c' }), error => error.code === 'lease_lost')
  const afterExpiry = await leases.acquire({ now, leaseMs: 5000 })
  assert.equal(afterExpiry.acquired, true, 'expired lease can be taken over')
  assert.notEqual(afterExpiry.token, resumed.token)
  await leases.commitCursor({ token: afterExpiry.token, cursor: null, done: true })
  await leases.release({ token: afterExpiry.token, completed: true, cursorCommitted: true })
  assert.equal(state.intel_runs[SCHEDULER_STATE_ID].cursor, null, 'completed cycle resets cursor')
  assert.equal(state.intel_runs[SCHEDULER_STATE_ID].lastCompleted, true)

  for (const malformedExpiry of [undefined, Number.NaN]) {
    const broken = database()
    const brokenLeases = createLeaseStore(broken.db, { now: () => now, makeToken: () => 'malformed-expiry-token-1234567890' })
    const held = await brokenLeases.acquire({ now, leaseMs: 5000 })
    broken.state.intel_runs[SCHEDULER_STATE_ID].expiresAt = malformedExpiry
    await assert.rejects(brokenLeases.commitCursor({ token: held.token, cursor: 'next-user' }), error => error.code === 'lease_lost')
    await assert.rejects(brokenLeases.release({ token: held.token }), error => error.code === 'lease_lost', 'release also rejects malformed expiry')
    assert.equal(broken.state.intel_runs[SCHEDULER_STATE_ID].releasedAt, undefined, 'malformed lease is not modified by release')
  }

  {
    const failureDb = database()
    const failureLeases = createLeaseStore(failureDb.db, { now: () => now, makeToken: () => 'page-failure-token-123456789012' })
    const firstLease = await failureLeases.acquire({ now, leaseMs: 5000 })
    for (let attempts = 1; attempts <= 10; attempts++) {
      assert.deepEqual(await failureLeases.recordPageFailure({ token: firstLease.token, cursor: null }), { attempts })
    }
    assert.deepEqual(await failureLeases.recordPageFailure({ token: firstLease.token, cursor: null }), { attempts: 10 }, 'same failing page has a finite retry counter')
    await failureLeases.release({ token: firstLease.token })
    const retryLease = await failureLeases.acquire({ now, leaseMs: 5000 })
    assert.equal(retryLease.failureAttempts, 10, 'failure count and cursor survive lease reacquisition')
    assert.equal(retryLease.cursor, null)
    await failureLeases.commitCursor({ token: retryLease.token, cursor: 'user-z' })
    assert.equal(failureDb.state.intel_runs[SCHEDULER_STATE_ID].failureAttempts, 0, 'new successful page clears the previous counter')
  }

  const prefs = database({ intel_preferences: {
    user_a: { _id: 'user_a', dailyDigestEnabled: true },
    user_b: { _id: 'user_b', dailyDigestEnabled: true },
    user_c: { _id: 'user_c', dailyDigestEnabled: false },
    user_d: { _id: 'user_d', dailyDigestEnabled: true, deleted: true },
    user_e: { _id: 'user_e', dailyDigestEnabled: true }
  } })
  const pager = createPreferencePager(prefs.db)
  const page1 = await pager.listEnabled({ cursor: null, limit: 2 })
  const page2 = await pager.listEnabled({ cursor: page1.nextCursor, limit: 2 })
  assert.deepEqual(page1.users, [{ openid: 'user_a' }, { openid: 'user_b' }])
  assert.equal(page1.done, false)
  assert.deepEqual(page2.users, [{ openid: 'user_e' }])
  assert.equal(page2.done, true)
  assert.equal(page2.nextCursor, null)
  assert.equal(prefs.state.intel_preferences.user_c.dailyDigestEnabled, false)
  assert.equal(prefs.state.intel_preferences.user_d.deleted, true)
  await assert.rejects(pager.listEnabled({ cursor: { malicious: true }, limit: 2 }), error => error.code === 'invalid_cursor')
  await assert.rejects(pager.listEnabled({ cursor: null, limit: 51 }), error => error.code === 'invalid_batch')

  for (const invalidResult of [undefined, {}, { data: null }, { data: {} }]) {
    const invalidDb = {
      command: { gt: value => ({ $gt: value }) },
      collection: () => ({
        where () { return this },
        field () { return this },
        orderBy () { return this },
        limit () { return this },
        async get () { return invalidResult }
      })
    }
    const invalidPager = createPreferencePager(invalidDb)
    await assert.rejects(invalidPager.listEnabled({ cursor: null, limit: 10 }), error => error.code === 'database_unavailable', 'invalid query response must not signal a completed empty scan')
  }

  process.stdout.write('intel-digest-adapters: all assertions passed\n')
}

run().catch(error => { console.error(error); process.exitCode = 1 })
