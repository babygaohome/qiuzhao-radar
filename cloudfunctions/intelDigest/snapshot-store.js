'use strict'

const crypto = require('crypto')
const { readOptionalDocument } = require('../api/intel/preferences')

const TOPICS = new Set(['jobs', 'ai', 'semiconductor', 'electronics', 'explore'])
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const COMPANY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SNAPSHOT_FIELDS = new Set(['localDate', 'timezone', 'algorithmVersion', 'itemIds', 'jobCompanyIds', 'generatedAt', 'status', 'generation'])

function fail (code, message) { return Object.assign(new Error(message), { code }) }

function digestId (openid, localDate, generation, digestGeneration) {
  if (!Number.isSafeInteger(generation) || generation < 0) throw fail('bad_request', 'generation invalid')
  if (!Number.isSafeInteger(digestGeneration) || digestGeneration < 0) throw fail('bad_request', 'digest generation invalid')
  return crypto.createHash('sha256').update(`${openid}\0${localDate}\0${generation}\0${digestGeneration}`).digest('hex')
}

function validateSnapshot (value, openid, localDate, timezone, generation, digestGeneration) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('bad_request', 'digest snapshot invalid')
  if (Object.keys(value).some(key => !SNAPSHOT_FIELDS.has(key))) throw fail('bad_request', 'digest snapshot contains unsupported fields')
  if (value.localDate !== localDate || value.timezone !== timezone) throw fail('bad_request', 'digest date or timezone mismatch')
  if (value.generation !== undefined && value.generation !== generation) throw fail('bad_request', 'digest generation mismatch')
  if (value.status !== undefined && value.status !== 'ready') throw fail('bad_request', 'digest status invalid')
  if (value.algorithmVersion !== undefined && (typeof value.algorithmVersion !== 'string' || value.algorithmVersion.length > 32)) throw fail('bad_request', 'digest version invalid')
  if (value.generatedAt !== undefined && (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)))) throw fail('bad_request', 'digest timestamp invalid')
  const itemIds = value.itemIds || []
  const jobCompanyIds = value.jobCompanyIds || []
  if (!Array.isArray(itemIds) || itemIds.length > 12 || itemIds.some(id => typeof id !== 'string' || !ITEM_ID.test(id))) throw fail('bad_request', 'digest items invalid')
  if (!Array.isArray(jobCompanyIds) || jobCompanyIds.length > 12 || jobCompanyIds.some(id => typeof id !== 'string' || !COMPANY_ID.test(id))) throw fail('bad_request', 'digest jobs invalid')
  if (itemIds.length + jobCompanyIds.length > 12) throw fail('bad_request', 'digest exceeds item limit')
  return {
    _id: digestId(openid, localDate, generation, digestGeneration), openid, localDate, timezone,
    algorithmVersion: value.algorithmVersion || 'v1',
    itemIds: [...new Set(itemIds)], jobCompanyIds: [...new Set(jobCompanyIds)],
    generatedAt: value.generatedAt || new Date().toISOString(),
    status: 'ready', generation, digestGeneration
  }
}

function safeView (record) {
  if (!record || typeof record !== 'object') return null
  const out = {}
  for (const key of ['localDate', 'timezone', 'algorithmVersion', 'itemIds', 'jobCompanyIds', 'generatedAt', 'status']) {
    if (record[key] !== undefined) out[key] = record[key]
  }
  return out
}

function createSnapshotStore ({ db, now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.runTransaction !== 'function' || typeof db.collection !== 'function') throw new TypeError('CloudBase database is required')

  async function currentPreference (reader, openid, expectedGeneration, expectedDigestGeneration) {
    const pref = await readOptionalDocument(reader, 'intel_preferences', openid)
    if (!pref || pref.deleted === true || pref.dailyDigestEnabled !== true) throw fail('digest_disabled', 'digest is disabled for this user')
    const generation = Number.isSafeInteger(pref.generation) ? pref.generation : 0
    if (generation !== expectedGeneration) throw fail('stale_generation', 'digest generation changed')
    const digestGeneration = Number.isSafeInteger(pref.digestGeneration) ? pref.digestGeneration : 0
    if (digestGeneration !== expectedDigestGeneration) throw fail('stale_digest_generation', 'digest generation changed')
    return pref
  }

  async function getMine ({ openid, localDate }) {
    validateIdentity(openid, localDate)
    return db.runTransaction(async tx => {
      const pref = await readOptionalDocument(tx, 'intel_preferences', openid)
      if (!pref || pref.deleted === true || pref.dailyDigestEnabled !== true) throw fail('digest_disabled', 'digest is disabled for this user')
      const generation = Number.isSafeInteger(pref.generation) ? pref.generation : 0
      const digestGeneration = Number.isSafeInteger(pref.digestGeneration) ? pref.digestGeneration : 0
      const id = digestId(openid, localDate, generation, digestGeneration)
      const record = await readOptionalDocument(tx, 'intel_digests', id)
      if (!record || record.openid !== openid || record.localDate !== localDate || record.generation !== generation || record.digestGeneration !== digestGeneration) return null
      return safeView(record)
    })
  }

  async function saveIfAbsent ({ openid, localDate, timezone, generation, digestGeneration, snapshot }) {
    validateIdentity(openid, localDate)
    if (typeof timezone !== 'string' || timezone.length > 64) throw fail('bad_request', 'timezone invalid')
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch (_) { throw fail('bad_request', 'timezone invalid') }
    if (!Number.isSafeInteger(generation) || generation < 0) throw fail('bad_request', 'generation invalid')
    if (!Number.isSafeInteger(digestGeneration) || digestGeneration < 0) throw fail('bad_request', 'digest generation invalid')
    const record = validateSnapshot(snapshot, openid, localDate, timezone, generation, digestGeneration)

    const transactionResult = await db.runTransaction(async tx => {
      const pref = await currentPreference(tx, openid, generation, digestGeneration)
      if (pref.timezone !== timezone) throw fail('stale_timezone', 'digest timezone changed')
      const old = await readOptionalDocument(tx, 'intel_digests', record._id)
      if (old) {
        if (old.openid !== openid || old.localDate !== localDate) throw fail('digest_collision', 'digest identity mismatch')
        return { created: false, record: safeView(old) }
      }
      record.generatedAt = snapshot.generatedAt || now()
      await tx.collection('intel_digests').doc(record._id).set({ data: record })
      return { created: true, record: safeView(record) }
    })

    // Deletion generation fences markIntelDeleted; digestGeneration fences a
    // disable/re-enable cycle. Clean only the exact old pair so a refreshed
    // snapshot for the same date survives a stale writer's cleanup.
    try {
      const latest = await currentPreference(db, openid, generation, digestGeneration)
      if (latest.timezone !== timezone) throw fail('stale_timezone', 'digest timezone changed')
    } catch (error) {
      if (transactionResult.created && error && ['digest_disabled', 'stale_generation', 'stale_digest_generation', 'stale_timezone'].includes(error.code)) {
        await db.collection('intel_digests').where({
          _id: record._id, openid, generation, digestGeneration
        }).remove()
      }
      throw error
    }
    return transactionResult
  }

  return { saveIfAbsent, getMine }
}

function validateIdentity (openid, localDate) {
  if (typeof openid !== 'string' || !openid || openid.length > 128) throw fail('unauthenticated', 'server identity required')
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw fail('bad_request', 'local date invalid')
  const date = new Date(`${localDate}T00:00:00Z`)
  if (date.toISOString().slice(0, 10) !== localDate) throw fail('bad_request', 'local date invalid')
}

module.exports = { createSnapshotStore, digestId, validateSnapshot, safeView }
