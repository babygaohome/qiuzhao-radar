'use strict'

const crypto = require('crypto')

const ACCESS_DOC = 'webAccess'
const REQUEST_PREFIX = 'webRequest_'
const APPROVAL_LIMIT = 1
const ALLOWED_ORIGINS = new Set([
  'https://qiuzhao-radar-web.oakenbear128.chatgpt.site',
  'https://cloud1-d5g4idwry1a351b71-1495091041.tcloudbaseapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
])

function fingerprint (uid) {
  return crypto.createHash('sha256').update(uid, 'utf8').digest('hex')
}

// wxContext comes from the Cloud Function runtime; web UID must be extracted
// separately by the server SDK. Never accept identity data from an event/body.
function resolveCaller (wxContext, trustedSdkUser) {
  const openid = wxContext && typeof wxContext.OPENID === 'string' ? wxContext.OPENID.trim() : ''
  const isGateway = !!(wxContext && wxContext.SOURCE === 'tcbgw')
  if (!isGateway && openid) return { kind: 'wechat', openid, actor: openid }

  const uid = trustedSdkUser && typeof trustedSdkUser.uid === 'string' ? trustedSdkUser.uid.trim() : ''
  if (!uid || uid.length > 256) return { kind: 'anonymous', openid: '', actor: '' }
  const uidHash = fingerprint(uid)
  return { kind: 'web', openid: '', uidHash, actor: 'web_' + uidHash.slice(0, 40) }
}

function create ({ db, command, readDoc, now = () => new Date().toISOString() }) {
  if (!db || !command || typeof readDoc !== 'function') throw new TypeError('web-access requires db, command and readDoc')
  const meta = db.collection('meta')

  function ensureAllowedOrigin (origin) {
    if (typeof origin !== 'string' || !ALLOWED_ORIGINS.has(origin)) {
      throw Object.assign(new Error('该网页来源未获准使用此账号'), { code: 'origin_not_allowed' })
    }
  }

  function ensureWebCaller (caller) {
    if (!caller || caller.kind !== 'web' || !/^[0-9a-f]{64}$/.test(caller.uidHash || '') ||
      caller.actor !== 'web_' + caller.uidHash.slice(0, 40)) {
      throw Object.assign(new Error('无法验证网页账号身份'), { code: 'unauthenticated' })
    }
  }

  async function requestWebAccess (caller, { origin } = {}) {
    ensureWebCaller(caller)
    ensureAllowedOrigin(origin)
    const access = await readDoc('meta', ACCESS_DOC)
    const approval = access && access.approved
    if (approval && approval.fingerprint === caller.uidHash && approval.origin === origin) {
      return { connected: true, needsApproval: false, openid: caller.actor }
    }

    const id = REQUEST_PREFIX + caller.uidHash
    let request = await readDoc('meta', id)
    if (!request) {
      const data = { _id: id, uidHash: caller.uidHash, origin, createdAt: now(), status: 'pending' }
      try {
        await meta.add({ data })
        request = data
      } catch (e) {
        // A concurrent first request may have inserted this same fingerprint.
        // Re-read to distinguish that duplicate from an actual database error.
        request = await readDoc('meta', id)
        if (!request) throw e
      }
    }
    if (request.uidHash !== caller.uidHash || !ALLOWED_ORIGINS.has(request.origin)) {
      throw Object.assign(new Error('网页访问申请记录无法验证'), { code: 'access_request_invalid' })
    }
    if (request.origin !== origin) {
      throw Object.assign(new Error('此账号已从另一个获准网页来源申请连接'), { code: 'origin_mismatch' })
    }
    return { connected: false, needsApproval: true, fingerprint: caller.uidHash, origin, status: request.status }
  }

  async function status (caller, { origin } = {}) {
    ensureWebCaller(caller)
    ensureAllowedOrigin(origin)
    const [access, request] = await Promise.all([
      readDoc('meta', ACCESS_DOC),
      readDoc('meta', REQUEST_PREFIX + caller.uidHash)
    ])
    const approved = access && access.approved && access.approved.fingerprint === caller.uidHash && access.approved.origin === origin
    return {
      connected: !!approved,
      needsApproval: !approved,
      status: approved ? 'approved' : request && request.status || 'not_requested',
      fingerprint: caller.uidHash
    }
  }

  async function authorize (caller) {
    if (caller && caller.kind === 'wechat' && caller.openid) return caller.openid
    ensureWebCaller(caller)
    const access = await readDoc('meta', ACCESS_DOC)
    const approval = access && access.approved
    if (!approval || approval.fingerprint !== caller.uidHash) return ''
    return caller.actor
  }

  async function runAdmin (caller, { mode = 'status', fingerprint: target } = {}) {
    if (!caller || caller.kind !== 'anonymous' || caller.openid) {
      throw Object.assign(new Error('只允许云函数管理调用'), { code: 'forbidden' })
    }
    if (mode !== 'status' && mode !== 'approve') {
      throw Object.assign(new Error('不支持的访问审批操作'), { code: 'invalid_mode' })
    }
    const access = await readDoc('meta', ACCESS_DOC)
    if (mode === 'status') {
      const all = await meta.where({ uidHash: command.exists(true) }).limit(100).get()
      return {
        pendingCount: all.data.filter(x => x.status === 'pending').length,
        approvedFingerprint: access && access.approved && access.approved.fingerprint || ''
      }
    }

    if (!/^[0-9a-f]{64}$/.test(target || '')) {
      throw Object.assign(new Error('需要完整的SHA-256指纹'), { code: 'invalid_fingerprint' })
    }
    const request = await readDoc('meta', REQUEST_PREFIX + target)
    if (!request || request.uidHash !== target || !ALLOWED_ORIGINS.has(request.origin)) {
      throw Object.assign(new Error('找不到此网页的待审批申请'), { code: 'request_not_found' })
    }
    if (access && access.approved) {
      if (access.approved.fingerprint !== target || access.approved.origin !== request.origin) {
        throw Object.assign(new Error('此账号已绑定另一个网页账号，本次申请未批准'), { code: 'approval_limit_reached' })
      }
      return { approved: true, fingerprint: target, alreadyApproved: true }
    }
    if (request.status !== 'pending') {
      throw Object.assign(new Error('找不到此网页的待审批申请'), { code: 'request_not_found' })
    }

    // Use the unique document id as the first-writer lock. Two different UIDs
    // racing to become the sole web user cannot both replace one another.
    const approval = { fingerprint: target, origin: request.origin, approvedAt: now() }
    try {
      await meta.add({ data: Object.assign({ _id: ACCESS_DOC }, { approved: approval, maxUsers: APPROVAL_LIMIT }) })
    } catch (e) {
      const winner = await readDoc('meta', ACCESS_DOC)
      if (!winner || !winner.approved) throw e
      if (winner.approved.fingerprint !== target || winner.approved.origin !== request.origin) {
        throw Object.assign(new Error('此账号已绑定另一个网页账号，本次申请未批准'), { code: 'approval_limit_reached' })
      }
      return { approved: true, fingerprint: target, alreadyApproved: true }
    }
    const saved = await readDoc('meta', ACCESS_DOC)
    if (!saved || !saved.approved || saved.approved.fingerprint !== target || saved.approved.origin !== request.origin) {
      throw Object.assign(new Error('访问审批读回校验失败'), { code: 'approval_verification_failed' })
    }
    await meta.doc(REQUEST_PREFIX + target).update({ data: { status: 'approved', approvedAt: saved.approved.approvedAt } })
    return { approved: true, fingerprint: target, alreadyApproved: false }
  }

  return { requestWebAccess, status, authorize, runAdmin }
}

module.exports = { create, resolveCaller, fingerprint, ALLOWED_ORIGINS, ACCESS_DOC, REQUEST_PREFIX }
