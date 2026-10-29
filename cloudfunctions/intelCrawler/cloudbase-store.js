'use strict'

const LEASE_ID = '__intel_ingestion_lease__'
const LEASE_MS = 5 * 60 * 1000

function documentData (result) {
  if (!result || !result.data || Array.isArray(result.data)) return null
  return result.data
}

function isMissingDocument (error) {
  return Boolean(error && (error.code === 'DATABASE_DOCUMENT_NOT_EXIST' || error.errCode === -502005 || /document.*not exist|not found/i.test(String(error.message || ''))))
}

function createCloudBaseStore (db, { now = Date.now, leaseMs = LEASE_MS } = {}) {
  const ref = (tx, collection, id) => tx.collection(collection).doc(id)
  async function withTransaction (fn) { return db.runTransaction(fn) }

  async function readLease (tx) {
    try { return documentData(await ref(tx, 'intel_runs', LEASE_ID).get()) } catch (error) {
      if (isMissingDocument(error)) return null
      throw error
    }
  }

  async function assertLease (tx, token) {
    const lease = await readLease(tx)
    if (!lease || lease.token !== token || Number(lease.expiresAt) <= now()) throw Object.assign(new Error('lease_lost'), { code: 'lease_lost' })
    return lease
  }

  return {
    async acquireLease (token) {
      return withTransaction(async tx => {
        const current = await readLease(tx)
        const at = now()
        if (current && Number(current.expiresAt) > at) return false
        await ref(tx, 'intel_runs', LEASE_ID).set({ data: { token, acquiredAt: at, expiresAt: at + leaseMs } })
        return true
      })
    },
    async releaseLease (token) {
      return withTransaction(async tx => {
        const lease = await readLease(tx)
        if (!lease || lease.token !== token) return false
        await ref(tx, 'intel_runs', LEASE_ID).update({ data: { expiresAt: now() } })
        return true
      })
    },
    async createRun (token, metadata) {
      return withTransaction(async tx => {
        await assertLease(tx, token)
        await ref(tx, 'intel_runs', token).set({ data: { ...metadata, runId: token } })
      })
    },
    async updateRun (token, metadata) {
      return withTransaction(async tx => {
        await assertLease(tx, token)
        await ref(tx, 'intel_runs', token).update({ data: metadata })
      })
    },
    async upsert (item, token) {
      return withTransaction(async tx => {
        await assertLease(tx, token)
        const { _id, ...data } = item
        await ref(tx, 'intel_items', _id).set({ data })
      })
    },
    async getCheckpoint (sourceId) {
      try { return documentData(await db.collection('intel_sources').doc(sourceId).get()) } catch (error) {
        if (isMissingDocument(error)) return null
        throw error
      }
    },
    async setCheckpoint (sourceId, checkpoint, token) {
      return withTransaction(async tx => {
        await assertLease(tx, token)
        await ref(tx, 'intel_sources', sourceId).set({ data: { ...checkpoint, sourceId } })
      })
    }
  }
}

module.exports = { createCloudBaseStore, LEASE_ID, LEASE_MS, _test: { isMissingDocument, documentData } }
