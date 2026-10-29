'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Use the existing in-memory production-API harness. Only swap the two
// server context providers; do not emulate the authorization decisions.
const isolation = path.join(__dirname, 'isolation.test.cjs')
const source = fs.readFileSync(isolation, 'utf8').split('let passed = 0')[0]
  .replace('getWXContext: () => ({ OPENID: identity })', 'getWXContext: () => contextProvider()')
const root = path.resolve(__dirname, '..')
let serverContext = { OPENID: 'wechat-A' }
let sdkUser = null
let sdkFailure = false
let sdkCalls = 0
let activeRuntimeContext = null
let runtimeAuthContext = null
let runtimeAuthFailure = false

const box = {
  require (name) {
    if (name === '@cloudbase/node-sdk') return {
      SYMBOL_CURRENT_ENV: 'test-env',
      init (options) {
        assert.deepEqual(JSON.parse(JSON.stringify(options)), { env: 'test-env' })
        return { auth: () => ({
          getUserInfo () { sdkCalls++; if (sdkFailure) throw Error('SDK identity unavailable'); return sdkUser },
          getAuthContext (runtimeContext) {
            if (runtimeAuthFailure) throw Error('runtime identity parsing failed')
            if (runtimeContext !== activeRuntimeContext || !runtimeContext) throw Error('untrusted runtime context')
            return runtimeAuthContext
          }
        }) }
      }
    }
    if (name === 'wx-server-sdk') throw Error('loaded through injected harness')
    return name.startsWith('.') ? require(path.resolve(root, 'cloudfunctions/api', name)) : require(name)
  },
  contextProvider: () => serverContext,
  __dirname: path.dirname(isolation), Page () {}, console, Buffer, URL, setTimeout, clearTimeout
}
vm.createContext(box)
vm.runInContext(source + '\nthis.makeHarness = harness', box)

async function main () {
  const h = box.makeHarness()
  const actualRequire = h.box.require
  h.box.require = name => name === '@cloudbase/node-sdk' ? box.require(name) : actualRequire(name)
  h.sdk.getWXContext = () => serverContext
  const originalMain = h.box.exports.main
  h.box.exports.main = event => originalMain(event, activeRuntimeContext)

  // WeChat users continue using OPENID-backed documents. Event-provided UID
  // and OPENID values have no authority.
  serverContext = { OPENID: 'wechat-A', UID: 'fake-web-uid' }
  h.table('profiles').set('wechat-A', { _id: 'wechat-A', profile: { role: 'WECHAT_PRIVATE' } })
  h.table('profiles').set('attacker-openid', { _id: 'attacker-openid', profile: { role: 'ATTACKER_PRIVATE' } })
  let wx = await h.call('', 'getProfile', { openid: 'attacker-openid', UID: 'web-spoof', userInfo: { uid: 'fake-web-uid' } })
  assert.equal(wx.profile.role, 'WECHAT_PRIVATE')

  const origin = 'https://qiuzhao-radar-web.oakenbear128.chatgpt.site'
  serverContext = { OPENID: 'wechat-A', APPID: 'wxapp-A', UID: '', SOURCE: 'tcbgw' }
  sdkUser = { uid: 'legacy-sdk-uid' }
  activeRuntimeContext = { requestId: 'runtime-context-A' }
  runtimeAuthContext = { uid: 'uid-browser-A' }
  let request = await h.call('', 'requestWebAccess', { origin, SOURCE: 'wx_mp', context: { uid: 'event-spoof' }, UID: 'event-spoof' })
  assert.equal(request.needsApproval, true)
  assert.equal(request.fingerprint, require('node:crypto').createHash('sha256').update('uid-browser-A').digest('hex'))
  const webActor = 'web_' + require('node:crypto').createHash('sha256').update('uid-browser-A').digest('hex').slice(0, 40)
  h.table('profiles').set(webActor, { _id: webActor, profile: { role: 'WEB_PRIVATE' } })
  h.table('profiles').set('fake-web-uid', { _id: 'fake-web-uid', profile: { role: 'SPOOFED_PRIVATE' } })

  // Fake event fields cannot resolve to an OPENID or UID, and pending web
  // access cannot read either another profile or the profile at its own actor.
  const beforePending = await h.call('', 'getProfile', { openid: 'wechat-A', UID: sdkUser.uid, userInfo: sdkUser })
  assert.equal(beforePending.error, 'web_access_pending')
  assert.equal(JSON.stringify(beforePending).includes('WECHAT_PRIVATE'), false)
  assert.equal(h.table('meta').has('timerSeen'), false)

  // A signed-in browser cannot invoke any of the console's timer-only tasks
  // by forging Type, UID, TriggerName or Task fields in a normal invocation.
  for (const Task of ['webAccess', 'manualReview', 'catalogAudit', 'catalogCorrections']) {
    const result = await h.call('', 'getProfile', {
      Type: 'timer', Task, TriggerName: 'catalogAudit', Mode: 'approve', Fingerprint: 'f'.repeat(64),
      UID: sdkUser.uid, OPENID: 'wechat-A', userInfo: { uid: sdkUser.uid }
    })
    assert.equal(result.error, 'web_access_pending', `web user reached timer task ${Task}`)
  }
  assert.equal(h.table('meta').has('manualReview20261022'), false)

  // A gateway invocation without a trusted SDK UID stays anonymous even when
  // it carries WeChat fields and forges the timer shape in the event.
  serverContext = { OPENID: 'wechat-A', APPID: 'wxapp-A', UID: '', SOURCE: 'tcbgw' }
  activeRuntimeContext = null
  runtimeAuthContext = null
  sdkUser = null
  sdkFailure = true
  for (const Task of ['webAccess', 'manualReview', 'catalogAudit', 'catalogCorrections']) {
    const result = await h.call('', 'getProfile', {
      Type: 'timer', Task, TriggerName: 'catalogAudit', Mode: 'approve', Fingerprint: 'f'.repeat(64),
      SOURCE: 'wx_trigger', OPENID: '', UID: ''
    })
    assert.equal(result.error, 'unauthenticated', `UID-less tcbgw context reached timer task ${Task}`)
  }
  assert.equal(h.table('meta').has('manualReview20261022'), false)
  assert.equal(h.table('meta').has('timerSeen'), false)
  sdkFailure = false

  // A partially successful legacy SDK read must not survive a trusted
  // runtime-context parser failure on a web gateway invocation.
  activeRuntimeContext = { requestId: 'runtime-partial-failure' }
  sdkUser = { uid: 'uid-browser-A' }
  runtimeAuthFailure = true
  const partialFailure = await h.call('', 'getProfile', { Type: 'timer', Task: 'webAccess', Mode: 'status' })
  assert.equal(partialFailure.error, 'unauthenticated')
  assert.equal(partialFailure.profile, undefined)
  runtimeAuthFailure = false

  // A genuinely anonymous timer context may request admin status, but its
  // untrusted event cannot choose identity. It cannot overwrite review data.
  serverContext = { OPENID: '', UID: '', SOURCE: 'wx_trigger' }
  activeRuntimeContext = null
  runtimeAuthContext = null
  sdkUser = null
  const status = await h.call('', 'getProfile', { Type: 'timer', Task: 'webAccess', Mode: 'status', Fingerprint: 'f'.repeat(64) })
  assert.equal(status.pendingCount, 1)
  assert.equal(h.table('meta').has('manualReview20261022'), false)
  const beforePausedTasks = JSON.stringify([...h.table('meta').entries()])
  for (const Mode of ['verify', 'inventory', 'start']) {
    const paused = await h.call('', 'getProfile', { Type: 'timer', Task: 'catalogAudit', Mode })
    assert.equal(paused.paused, true)
  }
  const pausedCorrections = await h.call('', 'getProfile', { Type: 'timer', Task: 'catalogCorrections' })
  assert.equal(pausedCorrections.length, 2)
  assert(pausedCorrections.every(x => x.catalogCorrections.paused === true))
  assert.equal(JSON.stringify([...h.table('meta').entries()]), beforePausedTasks, 'paused catalog jobs cannot enqueue, verify, or apply pending corrections')

  // Recreate the fixed request after switching the isolated harness context,
  // then approve only through the privileged, no-user timer branch.
  serverContext = { OPENID: 'wechat-A', APPID: 'wxapp-A', UID: '', SOURCE: 'tcbgw' }
  activeRuntimeContext = { requestId: 'runtime-context-A' }
  runtimeAuthContext = { uid: 'uid-browser-A' }
  sdkUser = { uid: 'legacy-sdk-uid' }
  await h.call('', 'requestWebAccess', { origin })
  serverContext = { OPENID: '', UID: '', SOURCE: 'wx_trigger' }
  activeRuntimeContext = null
  runtimeAuthContext = null
  sdkUser = null
  const approved = await h.call('', 'getProfile', { Type: 'timer', Task: 'webAccess', Mode: 'approve', Fingerprint: request.fingerprint })
  assert.equal(approved.approved, true)
  serverContext = { OPENID: 'wechat-A', APPID: 'wxapp-A', UID: '', SOURCE: 'tcbgw' }
  activeRuntimeContext = { requestId: 'runtime-context-A' }
  runtimeAuthContext = { uid: 'uid-browser-A' }
  sdkUser = { uid: 'legacy-sdk-uid' }
  const web = await h.call('', 'getProfile', { openid: 'attacker-openid', uid: 'fake-web-uid', userInfo: { uid: 'fake-web-uid' } })
  assert.equal(web.profile.role, 'WEB_PRIVATE')
  assert.equal(JSON.stringify(web).includes('WECHAT_PRIVATE'), false)
  assert.equal(JSON.stringify(web).includes('ATTACKER_PRIVATE'), false)

  // A second CloudBase UID is never mapped to the first browser actor.
  runtimeAuthContext = { uid: 'uid-browser-B' }
  sdkUser = { uid: 'legacy-sdk-uid' }
  const second = await h.call('', 'getProfile', {})
  assert.equal(second.error, 'web_access_pending')
  assert.equal(JSON.stringify(second).includes('WEB_PRIVATE'), false)

  // A browser identity that collides with ADMIN_OPENIDS still cannot sweep.
  h.box.process.env.ADMIN_OPENIDS = webActor
  runtimeAuthContext = { uid: 'uid-browser-A' }
  sdkUser = { uid: 'uid-browser-A' }
  assert.equal((await h.call('', 'sweep')).error, 'forbidden')

  // Older WeChat authentication remains OPENID-bound and does not depend on
  // successful web SDK identity lookup.
  serverContext = { OPENID: 'wechat-A', UID: '' }
  sdkFailure = true
  const oldWx = await h.call('', 'getProfile', { uid: 'uid-browser-A' })
  assert.equal(oldWx.profile.role, 'WECHAT_PRIVATE')

  serverContext = { OPENID: '', UID: '' }
  activeRuntimeContext = null
  runtimeAuthContext = null
  const callsBeforeFailure = sdkCalls
  sdkFailure = true
  const unavailable = await h.call('', 'getProfile', { OPENID: 'wechat-A', UID: 'uid-browser-A', userInfo: sdkUser })
  assert.equal(unavailable.error, 'unauthenticated')
  assert.equal(sdkCalls, callsBeforeFailure + 1)
  assert.equal(h.table('profiles').get(webActor).profile.role, 'WEB_PRIVATE')

  // The two web access actions return a safe diagnosis when the gateway did
  // not provide a trusted SDK UID. Event-supplied context is not considered.
  sdkFailure = false
  sdkUser = null
  const noIdentity = await h.call('', 'requestWebAccess', { origin, context: { uid: 'spoofed-context-uid' }, headers: { uid: 'spoofed-header-uid' } })
  assert.equal(noIdentity.error, 'unauthenticated')
  assert.deepEqual(JSON.parse(JSON.stringify(noIdentity.diagnostic)), {
    callerKind: 'anonymous', hasWxOpenid: false, hasWxAppid: false,
    hasSdkUid: false, hasRuntimeEnvironment: false, source: ''
  })
  assert.equal(JSON.stringify(noIdentity).includes('spoofed-context-uid'), false)
  assert.equal(JSON.stringify(noIdentity).includes('spoofed-header-uid'), false)

  const unknown = await h.call('', 'notAnAction', {
    body: { private: 'must-not-echo' }, request_data: { private: 'must-not-echo' },
    data: { action: 'nested-action' }, query: { action: 'query-action' }
  })
  assert.equal(unknown.error, 'unknown_action')
  assert.deepEqual(JSON.parse(JSON.stringify(unknown.diagnostic)), {
    hasTopAction: true, hasHttpBody: true, hasRequestData: true,
    hasDataAction: true, hasQueryAction: true, callerKind: 'anonymous',
    hasWxOpenid: false, hasSdkUid: false
  })
  assert.equal(JSON.stringify(unknown).includes('must-not-echo'), false)

  console.log('PASS integrated auth entrypoint: trusted runtime UID, event spoof rejection, safe diagnostics, web approval, timer protection, WeChat continuity and fail-closed SDK errors')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
