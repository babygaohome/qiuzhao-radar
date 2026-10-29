'use strict'

const { runIngestion } = require('./core')
const { createCloudBaseStore } = require('./cloudbase-store')
const TRIGGER_NAME = 'intelCrawlerEvery6Hours'
const TIMER_STATUS_ID = '__timer_status__'
const TIMER_REJECTIONS_ID = '__timer_rejections__'
const REJECTION_AUDIT_INTERVAL_MS = 60 * 1000

function validTimerEnvelope (event, context, env = process.env) {
  if (env.TRIGGER_SRC !== 'timer' && env.INFOFLOW_PLATFORM_ONLY !== 'true') return false
  if (env.INFOFLOW_PLATFORM_ONLY === 'true' && context && context.SOURCE && !['scf','wx_trigger'].includes(context.SOURCE)) return false
  if (!context || context.OPENID || context.UID || context.SOURCE === 'tcbgw' || context.TCB_SOURCE === 'tcbgw') return false
  return Boolean(event && typeof event.Type === 'string' && event.Type.toLowerCase() === 'timer' && event.TriggerName === TRIGGER_NAME &&
    typeof event.Time === 'string' && Number.isFinite(Date.parse(event.Time)))
}

function eventChecks (event) {
  return {
    eventTimer: !!(event && typeof event.Type === 'string' && event.Type.toLowerCase() === 'timer'),
    expectedName: !!(event && event.TriggerName === TRIGGER_NAME),
    validTime: !!(event && typeof event.Time === 'string' && Number.isFinite(Date.parse(event.Time)))
  }
}

function numericErrorCode (error) {
  const code = error && (typeof error.code === 'number' ? error.code : error.errCode)
  return typeof code === 'number' && Number.isFinite(code) ? code : null
}

function createMain ({ cloud, getRuntimeEnv, ingestion = runIngestion, storeFactory = createCloudBaseStore, processEnv = process.env } = {}) {
  return async function main (event, runtimeContext) {
    if (event && event.TriggerName === 'intelCrawlerSixHours') return { ok: false, code: 'RETIRED_TRIGGER' }
    const sdk = cloud || require('wx-server-sdk')
    sdk.init({ env: sdk.DYNAMIC_CURRENT_ENV })
    const runtimeEnv = getRuntimeEnv
      ? getRuntimeEnv(runtimeContext)
      : require('@cloudbase/node-sdk').getCloudbaseContext(runtimeContext)
    const wxContext = sdk.getWXContext() || {}
    const hasIdentity = !!(wxContext.OPENID || wxContext.UID || runtimeEnv.WX_OPENID || runtimeEnv.UID)
    const fromGateway = wxContext.SOURCE === 'tcbgw' || wxContext.TCB_SOURCE === 'tcbgw' || runtimeEnv.SOURCE === 'tcbgw' || runtimeEnv.TCB_SOURCE === 'tcbgw'
    const authEnv = Object.assign({}, runtimeEnv, { INFOFLOW_PLATFORM_ONLY: processEnv.INFOFLOW_PLATFORM_ONLY })
    const trustedTimer = (runtimeEnv.TRIGGER_SRC === 'timer' || (authEnv.INFOFLOW_PLATFORM_ONLY === 'true' && (!wxContext.SOURCE || ['scf','wx_trigger'].includes(wxContext.SOURCE)))) && !hasIdentity && !fromGateway
    const checks = eventChecks(event)
    const writeRejectedAudit = async () => {
      if (trustedTimer) return
      try {
        const db = sdk.database({ throwOnNotFound: false })
        await db.runTransaction(async tx => {
          const doc = tx.collection('intel_runs').doc(TIMER_REJECTIONS_ID)
          let previous = null
          try {
            const result = await doc.get()
            if (result && result.data && !Array.isArray(result.data)) previous = result.data
          } catch (error) {
            if (!(error && (error.code === 'DATABASE_DOCUMENT_NOT_EXIST' || error.errCode === -502005))) throw error
          }
          const at = Date.now()
          if (previous && Number(previous.at) > at - REJECTION_AUDIT_INTERVAL_MS) return
          await doc.set({ data: {
            trustedTimer: false, sourceClass: ['wx_client','wx_devtools','wx_unknown','wx_http','scf','timer','wx_trigger','http',''].includes(wxContext.SOURCE || '') ? (wxContext.SOURCE || 'empty') : 'other', runtimeTimer: runtimeEnv.TRIGGER_SRC === 'timer', hasIdentity, fromGateway,
            phase: 'rejected',
            eventTimer: checks.eventTimer,
            expectedName: checks.expectedName,
            validTime: checks.validTime,
            at
          } })
        })
      } catch (_) {
        // Do not disclose datastore errors or request data in logs.
        try { console.warn(JSON.stringify({ code: 'REJECTION_AUDIT_WRITE_FAILED' })) } catch (_) {}
      }
    }
    const writeStatus = async (phase, errorCode = null) => {
      if (!trustedTimer) return
      try {
        const db = sdk.database({ throwOnNotFound: false })
        await db.collection('intel_runs').doc(TIMER_STATUS_ID).set({
          data: {
            phase,
            scheduledAt: checks.validTime ? new Date(event.Time).toISOString() : null,
            eventTimer: checks.eventTimer,
            expectedName: checks.expectedName,
            validTime: checks.validTime,
            errorCode: typeof errorCode === 'number' && Number.isFinite(errorCode) ? errorCode : null,
            at: Date.now()
          }
        })
      } catch (_) {
        // Status is best-effort and must never expose SDK errors.
      }
    }

    if (!trustedTimer || !validTimerEnvelope(event, wxContext, authEnv)) {
      if (trustedTimer) await writeStatus('rejected')
      else await writeRejectedAudit()
      return { ok: false, code: 'INVALID_TRIGGER' }
    }
    const enabled = runtimeEnv.INFOFLOW_INGESTION_ENABLED === undefined
      ? processEnv.INFOFLOW_INGESTION_ENABLED
      : runtimeEnv.INFOFLOW_INGESTION_ENABLED
    if (enabled !== 'true') {
      await writeStatus('rejected')
      return { ok: false, code: 'INGESTION_DISABLED', message: 'This function is not configured for deployment.' }
    }

    await writeStatus('accepted')
    const now = new Date().toISOString()
    try {
      const db = sdk.database({ throwOnNotFound: false })
      const store = storeFactory(db)
      const result = await ingestion({ store, maxRetries: 1 })
      await writeStatus('completed')
      return { ...result, at: now }
    } catch (error) {
      await writeStatus('failed', numericErrorCode(error))
      return { status: 'failed', code: 'INGESTION_FAILED', at: now }
    }
  }
}

exports.main = createMain()
exports._test = { validTimerEnvelope, TRIGGER_NAME, TIMER_STATUS_ID, TIMER_REJECTIONS_ID, REJECTION_AUDIT_INTERVAL_MS, eventChecks, numericErrorCode, createMain }
