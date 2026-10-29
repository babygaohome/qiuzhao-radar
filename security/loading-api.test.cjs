const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
// Reuse the established isolated SDK harness; do not execute its regression runner.
const file = path.join(__dirname, 'isolation.test.cjs')
const source = fs.readFileSync(file, 'utf8').split('let passed = 0')[0]
  .replace("get: (_, k) => (...xs)", "get: (_, k) => k === 'aggregate' ? { sum: x => op('sum', x) } : (...xs)")
const box = { require, __dirname, console, Buffer, URL, setTimeout, clearTimeout }
vm.runInNewContext(source + '\nthis.harness = harness', box)
async function main () {
  const h = box.harness()
  assert.equal(h.box.exports._test.maintenancePartial({error:'ai_timeout'}), true)
  assert.equal(h.box.exports._test.maintenancePartial({officialWatch:{ok:false}}), true)
  assert.equal(h.box.exports._test.maintenancePartial({audit:{failed:2},campaign:{orig:3}}), false)
  const put = (col, id, data) => h.table(col).set(id, { _id: id, ...data })
  put('companies', 'public', { company: 'Public', industry: '银行', source: 'curated', dl: '9999-12-31' })
  put('companies', 'privateB', { company: 'B only', industry: '银行', source: 'manual', owner: 'B', dl: '9999-12-31' })
  const original = h.db.collection.bind(h.db)
  let aggregates = 0, counts = 0
  h.db.collection = name => {
    const col = original(name)
    function wrap (query) {
      for (const method of ['where', 'field', 'orderBy', 'skip', 'limit']) {
        const next = query[method]
        if (next) query[method] = (...args) => wrap(next(...args))
      }
      const count = query.count
      if (count) query.count = (...args) => { counts++; return count(...args) }
      return query
    }
    wrap(col)
    col.aggregate = () => {
      aggregates++
      let condition
      const a = { match(q) { condition = q; return a }, group() { return a }, sort() { return a }, limit() { return a }, async end() {
        const rows = await original(name).where(condition).get()
        const map = new Map()
        for (const r of rows.data) map.set(r.industry, (map.get(r.industry) || 0) + 1)
        return { list: [...map].map(([_id,n]) => ({_id,n})) }
      } }
      return a
    }
    return col
  }
  const list = await h.call('A', 'list', { withFacets: false })
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0]._id, 'public')
  assert.equal(counts, 0, 'fast list must not run collection counts')
  assert.equal(aggregates, 0, 'fast list must not wait for facets')
  const summary = await h.call('A', 'listSummary', {})
  assert.equal(summary.total, 1, 'summary must preserve owner isolation')
  assert.deepEqual(JSON.parse(JSON.stringify(summary.facets)), [{ name: '银行', n: 1 }])
  assert.equal(summary.meta.syncStatus.crawler.status, 'unknown')
  assert.equal((await h.call('', 'listSummary')).error, 'unauthenticated')
  put('meta','crawler',{ lastSuccessAt:'2026-10-22T04:00:00Z',lastAttemptAt:'2026-10-22T04:30:00Z',status:'partial',last:{sources:{niuqi:{status:'error'},hust:{status:'ok'}}},secret:'DO_NOT_RETURN' })
  put('meta','maintainStart',{at:'2026-10-22T04:40:00Z'})
  put('meta','maintain',{at:'2026-10-22T04:40:00Z',finishedAt:'2026-10-22T04:40:45Z',status:'partial',lastSuccessAt:'2026-10-22T04:30:45Z',timeout:true,private:'DO_NOT_RETURN'})
  const status = await h.call('A','syncStatus')
  assert.equal(status.crawler.status,'partial')
  assert.deepEqual(Array.from(status.crawler.failedSources),['niuqi'])
  assert.equal(status.maintain.status,'partial')
  assert.equal(status.maintain.lastSuccessAt,'2026-10-22T04:30:45Z')
  assert(!JSON.stringify(status).includes('DO_NOT_RETURN'))
  // A persisted audit record includes _id when read; CloudBase rejects writing it back.
  put('meta', 'audit', { day: new Date(Date.now()+8*3600000).toISOString().slice(0,10), queue: [], items: [], alarms: [], hist: [] })
  const auditedCollection = h.db.collection
  h.db.collection = name => {
    const col = auditedCollection(name), doc = col.doc
    col.doc = id => {
      const d = doc(id), set = d.set
      d.set = args => { assert(!Object.hasOwn(args.data,'_id'), 'CloudBase rejects reserved _id'); return set(args) }
      return d
    }
    return col
  }
  await h.box.exports._test.auditStep(Date.now()+20000)
  assert.equal(h.table('meta').get('audit').day, new Date(Date.now()+8*3600000).toISOString().slice(0,10))
  console.log('PASS fast-list query isolation, owner-aware summaries, auth and sanitized sync health')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
