'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { create, resolveCaller, fingerprint, ACCESS_DOC, REQUEST_PREFIX } = require('../cloudfunctions/api/web-access')

function harness (options = {}) {
  const rows = new Map()
  Object.entries(options.seed || {}).forEach(([id, value]) => rows.set(id, structuredClone({ _id: id, ...value })))
  const command = { exists: value => ({ __op: 'exists', value }) }
  const getPath = (row, key) => key.split('.').reduce((x, part) => x && x[part], row)
  const match = (row, condition) => Object.entries(condition || {}).every(([key, expected]) => {
    const actual = getPath(row, key)
    return expected && expected.__op === 'exists' ? (actual !== undefined) === expected.value : actual === expected
  })
  const collection = name => {
    const query = (condition = {}, limit = Infinity) => ({
      where: next => query(next, limit),
      limit: amount => query(condition, amount),
      async get () {
        if (options.readFailure) throw new Error('database offline')
        return { data: [...rows.values()].filter(row => row.collection === name && match(row, condition)).slice(0, limit).map(row => structuredClone(row)) }
      },
      async update ({ data }) {
        const found = [...rows.values()].filter(row => row.collection === name && match(row, condition))
        found.forEach(row => Object.entries(data).forEach(([key, value]) => { row[key] = structuredClone(value) }))
        return { stats: { updated: found.length } }
      }
    })
    return Object.assign(query(), {
      where: condition => query(condition),
      doc (id) {
        return {
          async update ({ data }) {
            const row = rows.get(name + ':' + id)
            if (!row) return { stats: { updated: 0 } }
            Object.assign(row, structuredClone(data))
            return { stats: { updated: 1 } }
          }
        }
      },
      async add ({ data }) {
        const id = data._id
        if (rows.has(name + ':' + id)) throw new Error('duplicate document id')
        rows.set(name + ':' + id, structuredClone({ ...data, collection: name }))
        return { _id: id }
      }
    })
  }
  return {
    rows,
    db: { command, collection },
    readDoc: async (name, id) => {
      if (options.readFailure) throw new Error('database offline')
      const row = rows.get(name + ':' + id)
      return row ? structuredClone(row) : null
    }
  }
}

const origin = 'https://qiuzhao-radar-web.oakenbear128.chatgpt.site'
const cloudBaseOrigin = 'https://cloud1-d5g4idwry1a351b71-1495091041.tcloudbaseapp.com'
const web = uid => resolveCaller({}, { uid })
const userA = web('cloudbase-uid-A')
const userB = web('cloudbase-uid-B')
const admin = resolveCaller({}, null)

async function main () {
  // User-controlled WeChat event fields must never become authenticated identity.
  assert.deepEqual(resolveCaller({ OPENID: '', UID: 'forged-uid' }, {}).kind, 'anonymous')
  assert.equal(resolveCaller({ OPENID: 'trusted-wechat-openid' }, { uid: 'also-present' }).openid, 'trusted-wechat-openid')
  assert.equal(resolveCaller({ SOURCE: 'tcbgw', OPENID: 'gateway-wx-openid', APPID: 'gateway-wx-appid' }, { uid: 'gateway-web-uid' }).kind, 'web')
  assert.equal(resolveCaller({ SOURCE: 'tcbgw', OPENID: 'gateway-wx-openid', APPID: 'gateway-wx-appid' }, null).kind, 'anonymous')
  assert.equal(resolveCaller({ SOURCE: 'http', OPENID: 'trusted-wechat-openid' }, { uid: 'unrelated' }).kind, 'wechat')
  assert.equal(userA.actor, 'web_' + fingerprint('cloudbase-uid-A').slice(0, 40))
  assert.notEqual(userA.actor, userB.actor)
  assert.equal(userA.openid, '')

  const h = harness()
  const access = create({ db: h.db, command: h.db.command, readDoc: h.readDoc, now: () => '2026-10-22T00:00:00.000Z' })
  await assert.rejects(access.requestWebAccess({ kind: 'anonymous' }, { origin }), /无法验证网页账号身份/)
  await assert.rejects(access.requestWebAccess(userA, { origin: 'https://attacker.example' }), /未获准/)
  for (const disallowedOrigin of [
    'https://evil.cloud1-d5g4idwry1a351b71-1495091041.tcloudbaseapp.com',
    'http://cloud1-d5g4idwry1a351b71-1495091041.tcloudbaseapp.com',
    'https://cloud2-d5g4idwry1a351b71-1495091041.tcloudbaseapp.com'
  ]) {
    await assert.rejects(access.requestWebAccess(userB, { origin: disallowedOrigin }), /未获准/)
  }

  const cloudRequest = await access.requestWebAccess(userB, { origin: cloudBaseOrigin })
  assert.equal(cloudRequest.connected, false)
  assert.equal(cloudRequest.needsApproval, true)
  assert.equal(cloudRequest.status, 'pending')
  assert.equal(h.rows.has('meta:' + ACCESS_DOC), false, 'CloudBase origin requests must not auto-authorize')
  assert.equal(h.rows.get('meta:' + REQUEST_PREFIX + userB.uidHash).origin, cloudBaseOrigin)
  await assert.rejects(access.requestWebAccess(userB, { origin }), /另一个获准网页来源/)
  assert.equal(h.rows.get('meta:' + REQUEST_PREFIX + userB.uidHash).origin, cloudBaseOrigin, 'cross-origin retry must preserve the first origin')

  const request = await access.requestWebAccess(userA, { origin })
  assert.equal(request.connected, false)
  assert.equal(request.needsApproval, true)
  assert.equal(request.fingerprint, userA.uidHash)
  assert.equal(h.rows.has('meta:' + ACCESS_DOC), false, 'requesting access must not grant it')
  const requestDoc = h.rows.get('meta:' + REQUEST_PREFIX + userA.uidHash)
  assert.equal(requestDoc.status, 'pending')
  assert.equal(Object.hasOwn(requestDoc, 'uid'), false, 'raw SDK UID must never be persisted')

  // The same signed-in account is stable and its original request remains intact.
  const repeated = await access.requestWebAccess(userA, { origin })
  assert.equal(h.rows.get('meta:' + REQUEST_PREFIX + userA.uidHash).createdAt, requestDoc.createdAt)
  await assert.rejects(access.requestWebAccess(userA, { origin: 'http://localhost:5173' }), /另一个获准网页来源/)
  assert.equal(await access.authorize(userA), '', 'pending users receive no cross-user owner id')

  await assert.rejects(access.runAdmin(userA, { mode: 'approve', fingerprint: userA.uidHash }), /只允许云函数管理调用/)
  const approval = await access.runAdmin(admin, { mode: 'approve', fingerprint: userA.uidHash })
  assert.equal(approval.approved, true)
  assert.equal(approval.alreadyApproved, false)
  assert.equal(await access.authorize(userA), userA.actor)
  assert.equal(await access.authorize(userB), '')
  assert.equal((await access.status(userA, { origin })).connected, true)
  assert.equal((await access.status(userB, { origin: cloudBaseOrigin })).status, 'pending')
  assert.deepEqual(Object.keys(h.rows.get('meta:' + ACCESS_DOC).approved).sort(), ['approvedAt', 'fingerprint', 'origin'])

  assert.equal((await access.runAdmin(admin, { mode: 'approve', fingerprint: userA.uidHash })).alreadyApproved, true)
  await assert.rejects(access.runAdmin(admin, { mode: 'approve', fingerprint: userB.uidHash }), /另一个网页账号/)
  assert.equal((await access.runAdmin(admin, { mode: 'status' })).pendingCount, 1)

  const raceHarness = harness()
  const raceAccess = create({ db: raceHarness.db, command: raceHarness.db.command, readDoc: raceHarness.readDoc })
  await Promise.all([raceAccess.requestWebAccess(userA, { origin }), raceAccess.requestWebAccess(userB, { origin })])
  const approvals = await Promise.allSettled([
    raceAccess.runAdmin(admin, { mode: 'approve', fingerprint: userA.uidHash }),
    raceAccess.runAdmin(admin, { mode: 'approve', fingerprint: userB.uidHash })
  ])
  assert.equal(approvals.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(approvals.filter(x => x.status === 'rejected').length, 1)
  assert.ok([userA.uidHash, userB.uidHash].includes(raceHarness.rows.get('meta:' + ACCESS_DOC).approved.fingerprint))

  const broken = create({ db: h.db, command: h.db.command, readDoc: async () => { throw new Error('database offline') } })
  await assert.rejects(broken.requestWebAccess(web('uid-db-error'), { origin }), /database offline/)
  const requestBefore = h.rows.get('meta:' + REQUEST_PREFIX + userA.uidHash)
  assert.equal(requestBefore.status, 'approved')
  assert.equal(requestBefore.uid, undefined)

  console.log('PASS trusted caller binding, request-only flow, identity isolation, origin allowlist, single-UID approval race safety, idempotence and DB error handling')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
