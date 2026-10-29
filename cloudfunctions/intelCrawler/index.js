'use strict'

// Staging core only. No CloudBase SDK, trigger config, or event-controlled enable switch.
exports.main = async function main () {
  return { ok: false, code: 'INGESTION_DISABLED', message: 'This function is not configured for deployment.' }
}

