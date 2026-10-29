'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { _test } = require('../index')

function harness ({ runtimeEnv = {}, wxContext = {}, ingestion = async () => ({ ok: true }), processEnv = {} } = {}) {
  const writes = []
  const documents = new Map()
  const docRef = (name, id) => ({
    async get () {
      if (!documents.has(`${name}/${id}`)) throw Object.assign(new Error('missing'), { code: 'DATABASE_DOCUMENT_NOT_EXIST' })
      return { data: documents.get(`${name}/${id}`) }
    },
    async set (value) {
      writes.push({ id, value })
      documents.set(`${name}/${id}`, value.data)
    }
  })
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'dynamic',
    init (options) { assert.equal(options.env, 'dynamic') },
    getWXContext () { return wxContext },
    database () {
      return {
        collection (name) {
          assert.equal(name, 'intel_runs')
          return { doc (id) { return docRef(name, id) } }
        },
        async runTransaction (fn) { return fn({ collection (name) { return { doc (id) { return docRef(name, id) } } } }) }
      }
    },
  }
  const main = _test.createMain({ cloud, getRuntimeEnv: () => runtimeEnv, ingestion, storeFactory: () => ({}), processEnv })
  return { main, writes }
}

test('caller supplied timer fields cannot create trusted timer status or run ingestion', async () => {
  let calls = 0
  const { main, writes } = harness({
    runtimeEnv: { TRIGGER_SRC: 'http' },
    ingestion: async () => { calls++; return { ok: true } }
  })
  const result = await main({ Type: 'timer', TriggerName: _test.TRIGGER_NAME, Time: new Date().toISOString() })
  assert.equal(result.code, 'INVALID_TRIGGER')
  assert.equal(calls, 0)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].id, '__timer_rejections__')
  assert.equal(writes[0].value.data.trustedTimer, false)
  assert.equal(writes.some(write => write.id === '__timer_status__'), false)
})

test('trusted timer with a rejected envelope stores only boolean checks and a phase', async () => {
  const { main, writes } = harness({ runtimeEnv: { TRIGGER_SRC: 'timer', INFOFLOW_INGESTION_ENABLED: 'true' } })
  const result = await main({ Type: 'http', TriggerName: 'secret-trigger-value', Time: 'not-a-date', token: 'sensitive' })
  assert.equal(result.code, 'INVALID_TRIGGER')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].id, '__timer_status__')
  assert.deepEqual(writes[0].value.data, {
    phase: 'rejected', eventTimer: false, expectedName: false, validTime: false, errorCode: null,
    at: writes[0].value.data.at
  })
  assert.equal(typeof writes[0].value.data.at, 'number')
  assert.equal(JSON.stringify(writes).includes('sensitive'), false)
})

test('authenticated execution failure records accepted then failed without raw errors', async () => {
  const secretMessage = 'password=https://private.example/secret'
  const { main, writes } = harness({
    runtimeEnv: { TRIGGER_SRC: 'timer', INFOFLOW_INGESTION_ENABLED: 'true' },
    ingestion: async () => { throw Object.assign(new Error(secretMessage), { code: -502005 }) }
  })
  const result = await main({ Type: 'Timer', TriggerName: _test.TRIGGER_NAME, Time: new Date().toISOString() })
  assert.equal(result.code, 'INGESTION_FAILED')
  assert.deepEqual(writes.map(({ id, value }) => [id, value.data.phase]), [
    ['__timer_status__', 'accepted'], ['__timer_status__', 'failed']
  ])
  assert.equal(writes[1].value.data.errorCode, -502005)
  assert.equal(JSON.stringify(writes).includes(secretMessage), false)
  assert.deepEqual(Object.keys(writes[1].value.data).sort(), ['at', 'errorCode', 'eventTimer', 'expectedName', 'phase', 'validTime'])
})

test('SDK context flag takes precedence, missing context flag uses process fallback, gateway cannot log', async () => {
  const event = { Type: 'timer', TriggerName: _test.TRIGGER_NAME, Time: new Date().toISOString() }
  const disabled = harness({
    runtimeEnv: { TRIGGER_SRC: 'timer', INFOFLOW_INGESTION_ENABLED: 'false' },
    processEnv: { INFOFLOW_INGESTION_ENABLED: 'true' }
  })
  assert.equal((await disabled.main(event)).code, 'INGESTION_DISABLED')
  assert.equal(disabled.writes[0].value.data.phase, 'rejected')

  const missing = harness({ runtimeEnv: { TRIGGER_SRC: 'timer' }, processEnv: { INFOFLOW_INGESTION_ENABLED: 'true' } })
  assert.equal((await missing.main(event)).ok, true)
  assert.equal(missing.writes.at(-1).value.data.phase, 'completed')

  const gateway = harness({ runtimeEnv: { TRIGGER_SRC: 'timer' }, wxContext: { SOURCE: 'tcbgw' } })
  assert.equal((await gateway.main(event)).code, 'INVALID_TRIGGER')
  assert.equal(gateway.writes.length, 1)
  assert.equal(gateway.writes[0].id, '__timer_rejections__')
  assert.equal(gateway.writes[0].value.data.trustedTimer, false)
})

test('rejected audit is fixed-shape, excludes attacker data, and is throttled', async () => {
  const { main, writes } = harness({ runtimeEnv: { TRIGGER_SRC: 'http' } })
  const event = {
    Type: 'Timer', TriggerName: _test.TRIGGER_NAME, Time: new Date().toISOString(),
    OPENID: 'private-user', token: 'secret-token', message: 'password=secret'
  }
  assert.equal((await main(event)).code, 'INVALID_TRIGGER')
  assert.equal((await main(event)).code, 'INVALID_TRIGGER')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].id, '__timer_rejections__')
  assert.deepEqual(Object.keys(writes[0].value.data).sort(), ['at', 'eventTimer', 'expectedName', 'phase', 'trustedTimer', 'validTime'])
  assert.deepEqual({ ...writes[0].value.data, at: 0 }, {
    trustedTimer: false, phase: 'rejected', eventTimer: true, expectedName: true, validTime: true, at: 0
  })
  assert.equal(JSON.stringify(writes).includes('secret'), false)
  assert.equal(writes.some(write => write.id === '__timer_status__'), false)
})
