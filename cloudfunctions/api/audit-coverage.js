'use strict'
const crypto = require('node:crypto')
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
function titleKeys (record = {}) {
  const titles = new Set()
  const add = value => {
    const raw = typeof value === 'string' ? value : value && typeof value.title === 'string' ? value.title : ''
    const key = norm(raw)
    if (key) titles.add(key)
  }
  for (const name of ['positions', 'fullJobs', 'publicJobs']) if (Array.isArray(record[name])) record[name].forEach(add)
  for (const jobs of Object.values(record.posBySrc || {})) if (Array.isArray(jobs)) jobs.forEach(add)
  if (record.discoveryEvidence && Array.isArray(record.discoveryEvidence.jobs)) record.discoveryEvidence.jobs.forEach(add)
  return [...titles].sort()
}
function coverageFingerprint (record) {
  return crypto.createHash('sha256').update(JSON.stringify({ company: norm(record.company), titles: titleKeys(record) })).digest('hex')
}
function coverageIsCurrent (record) {
  const review = record && record.catalogAudit
  const keys = titleKeys(record)
  const evidenced = new Set(Object.entries(review && review.jobs || {}).filter(([, result]) => result && result.exists === true && result.cohort === 'matched' && typeof result.open === 'boolean' && result.officialSource === 'confirmed').map(([title]) => norm(title)))
  return !!(review && review.coverageComplete === true && keys.length && keys.every(key => evidenced.has(key)) && review.coverageFingerprint === coverageFingerprint(record))
}
function invalidationPatch (before, nextFields) {
  if (!before || !before.catalogAudit || !before.catalogAudit.coverageComplete) return {}
  const after = { ...before, ...nextFields }
  if (coverageFingerprint(before) === coverageFingerprint(after)) return {}
  return { 'catalogAudit.coverageComplete': false, 'catalogAudit.state': 'partial',
    'catalogAudit.invalidatedAt': new Date().toISOString(), 'catalogAudit.invalidatedReason': 'stored_titles_changed' }
}
async function updateWithCoverageGuard ({ db, command, id, patch, nextTitleFields = patch, allowPrivate = false }) {
  const fields = ['company', 'positions', 'fullJobs', 'posBySrc', 'publicJobs', 'discoveryEvidence']
  const collection = db.collection('companies')
  if (!fields.some(field => Object.prototype.hasOwnProperty.call(nextTitleFields, field))) return collection.doc(id).update({ data: patch })
  const read = await collection.where({ _id: id }).limit(1).get()
  const before = read.data && read.data[0]
  if (!before || (!allowPrivate && (before.owner !== undefined || before.source === 'manual'))) throw Error('company_visibility_changed')
  const condition = { _id: id }
  for (const field of [...fields, 'catalogAudit', 'updated', 'owner', 'source']) condition[field] = before[field] === undefined ? command.exists(false) : command.eq(before[field])
  const result = await collection.where(condition).update({ data: { ...patch, ...invalidationPatch(before, nextTitleFields) } })
  if (!result || !result.stats || result.stats.updated !== 1) throw Error('company_evidence_write_conflict')
  return result
}
module.exports = { titleKeys, coverageFingerprint, coverageIsCurrent, invalidationPatch, updateWithCoverageGuard }
