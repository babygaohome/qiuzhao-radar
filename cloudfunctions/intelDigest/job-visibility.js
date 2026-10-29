'use strict'

const STALE_DAYS = 60

function createDigestVisibility ({ command, now = () => Date.now() } = {}) {
  if (!command || typeof command.and !== 'function' || typeof command.or !== 'function' ||
      typeof command.neq !== 'function' || typeof command.gte !== 'function' ||
      typeof command.exists !== 'function' || typeof command.in !== 'function' ||
      typeof command.nin !== 'function') throw new TypeError('database command is required')
  if (typeof now !== 'function') throw new TypeError('clock must be a function')

  function beijingDate (epoch) {
    if (!Number.isFinite(epoch)) throw new TypeError('clock returned an invalid timestamp')
    return new Date(epoch + 8 * 3600e3).toISOString().slice(0, 10)
  }
  function daysAgo (count) {
    return beijingDate(now() - count * 86400e3)
  }
  function aliveCond () {
    const cutoff = beijingDate(now() - STALE_DAYS * 86400e3)
    return command.and([
      command.or([
        { deadline: command.neq('') },
        { source: command.neq('auto') },
        { updated: command.gte(cutoff) },
        { seen: command.gte(cutoff) }
      ]),
      { 'manualReview.status': command.neq('expired') }
    ])
  }
  function verifiedCond () {
    return command.and([
      { 'catalogAudit.state': 'verified' },
      { 'catalogAudit.coverageComplete': true },
      { 'catalogAudit.coverageFingerprint': command.exists(true) },
      { 'catalogAudit.proofMethod': command.in(['browser_official', 'official_structured']) },
      { disputed: command.neq(true) }
    ])
  }
  function build ({ openid, hidden }) {
    if (typeof openid !== 'string' || !openid.trim() || openid.length > 128) throw new TypeError('server identity required')
    if (!Array.isArray(hidden) || hidden.some(id => typeof id !== 'string')) throw new TypeError('hidden IDs are required')
    const today = beijingDate(now())
    const clauses = [
      command.or([{ source: command.neq('manual') }, { owner: openid }]),
      { publicOnly: command.neq(true) },
      { dl: command.gte(today) },
      aliveCond(),
      { 'manualReview.status': command.neq('expired') },
      verifiedCond()
    ]
    if (hidden.length) clauses.push({ _id: command.nin(hidden.slice(-500)) })
    return command.and(clauses)
  }

  return { build, alive: aliveCond }
}

module.exports = { createDigestVisibility, STALE_DAYS }
