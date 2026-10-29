'use strict'

const { selectDigest, localDateTimeToEpoch, createWindow } = require('./core')

function fail (code) { return Object.assign(new Error(code), { code }) }

function localParts (epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(epochMs))
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
}

function createDigestService ({ resolveIdentity, readPreferences, readItems, readJobs, snapshotStore, now = () => Date.now() } = {}) {
  for (const [name, value] of Object.entries({ resolveIdentity, readPreferences, readItems })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`)
  }
  if (!snapshotStore || typeof snapshotStore.saveIfAbsent !== 'function' || typeof snapshotStore.getMine !== 'function') {
    throw new TypeError('snapshotStore is required')
  }

  async function generate (event, context) {
    const openid = await resolveIdentity(context)
    if (typeof openid !== 'string' || !openid.trim()) throw fail('unauthenticated')
    const preferences = await readPreferences(openid)
    if (!preferences || preferences.deleted === true || preferences.dailyDigestEnabled !== true) throw fail('digest_disabled')
    const timeZone = preferences.timezone
    const localTime = preferences.digestLocalTime || '08:00'
    if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 64) throw fail('invalid_timezone')
    if (typeof localTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw fail('invalid_digest_time')
    // Validate timezone/time before using Intl or scheduling comparisons.
    const parts = localParts(now(), timeZone)
    const localDate = `${parts.year}-${parts.month}-${parts.day}`
    const requestedDate = event && event.localDate
    if (requestedDate !== undefined && requestedDate !== localDate) throw fail('digest_date_not_current')
    const generation = Number.isSafeInteger(preferences.generation) ? preferences.generation : 0
    if (!Number.isSafeInteger(generation) || generation < 0) throw fail('invalid_generation')
    const digestGeneration = Number.isSafeInteger(preferences.digestGeneration) ? preferences.digestGeneration : 0
    if (digestGeneration < 0) throw fail('invalid_digest_generation')
    const cutoff = localDateTimeToEpoch(localDate, localTime, timeZone)
    if (now() < cutoff) throw fail('digest_not_due')

    const window = createWindow({ localDate, localTime, timeZone })
    // Feed items are public normalized records. User identity is intentionally
    // not sent to this reader; no resume, applications or private profile is read.
    const items = await readItems({ start: window.start, end: window.end })
    if (!Array.isArray(items)) throw fail('feed_unavailable')
    const selected = selectDigest({
      localDate, localTime, timeZone, preferences,
      items
    })
    let jobCompanyIds = []
    const jobWeight = preferences.topics && preferences.topics.jobs
    if (typeof jobWeight === 'number' && Number.isFinite(jobWeight) && jobWeight > 0) {
      if (typeof readJobs !== 'function') throw fail('jobs_unavailable')
      const jobs = await readJobs(openid, { start: window.start, end: window.end, limit: 4 })
      if (!Array.isArray(jobs) || jobs.length > 4 || jobs.some(job => !job || typeof job.companyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.companyId))) throw fail('jobs_unavailable')
      jobCompanyIds = [...new Set(jobs.map(job => job.companyId))].slice(0, 4)
    }
    const snapshot = {
      localDate,
      timezone: timeZone,
      algorithmVersion: selected.algorithmVersion,
      itemIds: selected.itemIds,
      jobCompanyIds,
      generatedAt: new Date(now()).toISOString(),
      status: 'ready',
      generation
    }
    const saved = await snapshotStore.saveIfAbsent({ openid, localDate, timezone: timeZone, generation, digestGeneration, snapshot })
    return {
      created: saved.created === true,
      snapshot: saved.record
    }
  }

  async function getMine (context, localDate) {
    const openid = await resolveIdentity(context)
    if (typeof openid !== 'string' || !openid.trim()) throw fail('unauthenticated')
    const preferences = await readPreferences(openid)
    if (!preferences || preferences.deleted === true || preferences.dailyDigestEnabled !== true) throw fail('digest_disabled')
    return snapshotStore.getMine({ openid, localDate })
  }

  return { generate, getMine }
}

module.exports = { createDigestService, localParts }
