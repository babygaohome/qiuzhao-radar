'use strict'

const { runIngestion } = require('./core')
const { createCloudBaseStore } = require('./cloudbase-store')
const TRIGGER_NAME = 'intelCrawlerSixHours'

function validTimerEnvelope (event, context, env = process.env) {
  // TRIGGER_SRC is populated by the CloudBase runtime. Event fields alone are
  // caller-controlled and therefore cannot authorize ingestion.
  if (env.TRIGGER_SRC !== 'timer') return false
  if (!context || context.OPENID || context.UID || context.SOURCE === 'tcbgw') return false
  return Boolean(event && event.Type === 'timer' && event.TriggerName === TRIGGER_NAME &&
    typeof event.Time === 'string' && Number.isFinite(Date.parse(event.Time)))
}

exports.main = async function main (event, runtimeContext) {
  if (process.env.INFOFLOW_INGESTION_ENABLED !== 'true') {
    return { ok: false, code: 'INGESTION_DISABLED', message: 'This function is not configured for deployment.' }
  }
  const cloud = require('wx-server-sdk')
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
  const context = cloud.getWXContext()
  if (context.OPENID || context.UID) return { ok: false, code: 'FORBIDDEN' }
  if (!validTimerEnvelope(event, context)) return { ok: false, code: 'INVALID_TRIGGER' }
  const db = cloud.database()
  const store = createCloudBaseStore(db)
  const now = new Date().toISOString()
  // Collections must be provisioned with client-deny rules before enabling ingestion.
  try {
    const result = await runIngestion({ store })
    return { ...result, at: now }
  } catch (_) {
    // Do not return platform errors, URLs, response bodies, or credentials.
    return { status: 'failed', code: 'INGESTION_FAILED', at: now }
  }
}

exports._test = { validTimerEnvelope, TRIGGER_NAME }
