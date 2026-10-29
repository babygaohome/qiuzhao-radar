'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createDigestVisibility } = require('../cloudfunctions/intelDigest/job-visibility')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/api/index.js'), 'utf8')
const command = new Proxy({}, { get: (_, op) => (...args) => ({ __op: op, value: args[0] }) })
const quiet = { and: true, or: true, neq: true, gte: true, exists: true, in: true, nin: true }
for (const op of Object.keys(quiet)) assert.equal(typeof command[op], 'function')

function sourceBlock (marker) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing production function ${marker}`)
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unterminated ${marker}`)
}

function actualApiVisibility (epoch) {
  const declarations = [
    'const STALE_DAYS = 60',
    'const BATCH_TYPES = [\'秋招\', \'提前批\', \'补录\', \'春招\']',
    sourceBlock('function todayCN ()'),
    sourceBlock('function daysAgo (n)'),
    sourceBlock('function freshCond ()'),
    sourceBlock('function recentCond (kind)'),
    sourceBlock('function escapeRe (s)'),
    sourceBlock('function str (v, n)'),
    sourceBlock('function aliveCond ()'),
    sourceBlock('function verifiedCond ()'),
    sourceBlock('function leadsCond ()'),
    sourceBlock('function buildWhere (ev, openid, hidden, noIndustry)')
  ].join('\n')
  class FixedDate extends Date { static now () { return epoch } }
  const context = {
    db: { RegExp: () => ({}) }, Date: FixedDate,
    industries: [], command,
    module: { exports: {} }
  }
  context._ = command
  vm.createContext(context)
  vm.runInContext(`${declarations}\nmodule.exports = { buildWhere, aliveCond }`, context)
  return { where: context.module.exports.buildWhere({ tab: 'all' }, 'account-a', ['hidden-x']), alive: context.module.exports.aliveCond() }
}

function get (row, path) { return path.split('.').reduce((x, key) => x == null ? undefined : x[key], row) }
function matches (row, query) {
  if (query && query.__op === 'and') return query.value.every(q => matches(row, q))
  if (query && query.__op === 'or') return query.value.some(q => matches(row, q))
  return Object.entries(query || {}).every(([key, expected]) => {
    const actual = get(row, key)
    if (!expected || !expected.__op) return actual === expected
    const value = expected.value
    switch (expected.__op) {
      case 'neq': return actual !== value
      case 'gte': return actual >= value
      case 'exists': return (actual !== undefined) === value
      case 'in': return value.includes(actual)
      case 'nin': return !value.includes(actual)
      default: throw new Error(`unsupported operation ${expected.__op}`)
    }
  })
}

const now = Date.parse('2026-10-29T04:00:00.000Z')
const hidden = ['hidden-x']
const digestVisibility = createDigestVisibility({ command, now: () => now })
const policy = { build: digestVisibility.build({ openid: 'account-a', hidden }), alive: digestVisibility.alive }
const actual = actualApiVisibility(now)
const day = '2026-10-29'
const fixtures = [
  { _id: 'verified', source: 'auto', owner: undefined, publicOnly: false, dl: day, updated: day, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'official_structured' } },
  { _id: 'manual-owner', source: 'manual', owner: 'account-a', dl: day, updated: day, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'manual-other', source: 'manual', owner: 'account-b', dl: day, updated: day, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'public-only', source: 'auto', publicOnly: true, dl: day, updated: day, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'disputed', source: 'auto', dl: day, updated: day, disputed: true, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'partial', source: 'auto', dl: day, updated: day, catalogAudit: { state: 'verified', coverageComplete: false, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'expired-review', source: 'auto', dl: day, updated: day, manualReview: { status: 'expired' }, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'stale-auto', source: 'auto', deadline: '', dl: '', updated: '2026-08-01', seen: '2026-08-01', catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'expired-deadline', source: 'curated', dl: '2026-10-28', catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } },
  { _id: 'hidden-x', source: 'auto', dl: day, updated: day, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: 'f', proofMethod: 'browser_official' } }
]
for (const fixture of fixtures) assert.equal(matches(fixture, policy.build), matches(fixture, actual.where), fixture._id)
assert.equal(matches(fixtures[0], policy.build), true)
assert.equal(matches(fixtures[1], policy.build), true)
assert.equal(matches(fixtures[2], policy.build), false)
assert.equal(matches(fixtures[3], policy.build), false)
assert.equal(matches(fixtures[4], policy.build), false)
assert.equal(matches(fixtures[5], policy.build), false)
assert.equal(matches(fixtures[6], policy.build), false)
assert.equal(matches(fixtures[7], policy.build), false)
assert.equal(matches(fixtures[7], policy.alive()), matches(fixtures[7], actual.alive))
assert.equal(matches(fixtures[7], policy.alive()), false)
assert.equal(matches(fixtures[8], policy.build), false)
assert.equal(matches(fixtures[9], policy.build), false)
assert.throws(() => createDigestVisibility({ command, now: () => now }).build({ openid: 'account-a', hidden: 'bad' }), /hidden IDs/)
console.log(`intel-digest-job-visibility: ${fixtures.length} production policy parity fixtures passed`)
