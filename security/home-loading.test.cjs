const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

const pending = []
const calls = []
const context = {
  require (name) {
    if (name === '../../utils/util.js') return {
      api (action, data) {
        calls.push({ action, data })
        return new Promise((resolve, reject) => pending.push({ action, data, resolve, reject }))
      },
      decorate (company, app) { return { id: company._id, company: company.company, app } },
      cn: x => x
    }
    throw new Error(`Unexpected require: ${name}`)
  },
  Page (page) { context.page = page },
  wx: { stopPullDownRefresh () {} },
  getApp: () => ({ globalData: {} }),
  setTimeout,
  clearTimeout,
  Date,
  Intl,
  encodeURIComponent
}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.js'), 'utf8'), context)

function instance () {
  pending.length = 0
  calls.length = 0
  const p = Object.assign({}, context.page, {
    data: JSON.parse(JSON.stringify(context.page.data)),
    setData (next) { Object.assign(this.data, next) }
  })
  p.seq = 0
  p.statsAt = Date.now()
  return p
}
function take (action) {
  const i = pending.findIndex(x => x.action === action)
  assert.notEqual(i, -1, `Expected pending ${action} call`)
  return pending.splice(i, 1)[0]
}
function result (name, id) {
  const item = { _id: id, company: name }
  return { items: [item], apps: {}, pageSize: 20 }
}
async function tick () { await Promise.resolve(); await Promise.resolve() }

async function main () {
  // The first page must render when the list request finishes, independent of summary and stats.
  {
    const p = instance()
    p.reload({ force: true, stats: true })
    const list = take('list')
    assert.equal(list.data.withFacets, false)
    assert.equal(calls.some(c => c.action === 'listSummary'), true)
    list.resolve(result('First', 'first'))
    await tick()
    assert.deepEqual(p.data.items.map(x => x.company), ['First'])
    assert.equal(p.data.refreshing, false)
    assert.equal(pending.some(x => x.action === 'listSummary'), true)
    assert.equal(pending.some(x => x.action === 'stats'), true)
  }

  // Same-filter refresh keeps visible rows, blocks pagination, and replaces rows on success.
  {
    const p = instance()
    p.data.items = [{ id: 'old', company: 'Old' }]
    p.data.page = 1
    p.listKey = JSON.stringify(p.filters())
    const refresh = p.reload()
    assert.deepEqual(p.data.items.map(x => x.company), ['Old'])
    assert.equal(p.data.refreshing, true)
    const before = calls.filter(c => c.action === 'list').length
    await p.loadMore()
    assert.equal(calls.filter(c => c.action === 'list').length, before)
    take('listSummary').resolve({ total: 2, facets: [], meta: {} })
    take('list').resolve(result('New', 'new'))
    await refresh
    await tick()
    assert.deepEqual(p.data.items.map(x => x.company), ['New'])
    assert.equal(p.data.refreshing, false)
  }

  // A transient refresh failure keeps the last good rows and gives a retry state.
  {
    const p = instance()
    p.data.items = [{ id: 'keep', company: 'Keep' }]
    p.listKey = JSON.stringify(p.filters())
    const refresh = p.reload()
    take('listSummary').reject(new Error('summary unavailable'))
    take('list').reject(new Error('temporary offline'))
    await refresh
    assert.deepEqual(p.data.items.map(x => x.company), ['Keep'])
    assert.equal(p.data.error, 'temporary offline')
    assert.equal(p.data.refreshing, false)
    assert.equal(p.data.page, 0)
    assert.equal(p.data.done, false)

    p.data.page = 3
    p.data.done = true
    const anotherRefresh = p.reload()
    take('listSummary').resolve({ total: 1, facets: [], meta: {} })
    take('list').reject(new Error('offline again'))
    await anotherRefresh
    assert.equal(p.data.page, 3)
    assert.equal(p.data.done, true)
  }

  // An old page response cannot append into a newly selected filter's result set.
  {
    const p = instance()
    const oldPage = p.loadMore()
    const oldList = take('list')
    p.setData({ industry: '软件/IT' })
    const reload = p.reload()
    const newList = take('list')
    take('listSummary').resolve({ total: 1, facets: [], meta: {} })
    oldList.resolve(result('Wrong filter', 'wrong'))
    await oldPage
    newList.resolve(result('Right filter', 'right'))
    await reload
    assert.deepEqual(p.data.items.map(x => x.company), ['Right filter'])
  }

  // Timestamps are explicitly formatted in China Standard Time, including minutes.
  {
    const p = instance()
    assert.match(p.summaryText({ syncStatus: { crawler: { status: 'ok', lastSuccessAt: '2026-10-22T04:07:00.000Z' } } }), /22日 12:07 北京时间/)
    assert.match(p.summaryText({ syncStatus: { crawler: { status: 'error', lastAttemptAt: '2026-10-22T04:07:00.000Z', failedSources: ['source'] } } }), /更新异常/)
  }

  // Status refresh updates the visible rows and cannot overwrite a newer filter's result.
  {
    const p = instance()
    p.data.items = [{ id: 'current', company: 'Current', status: 'old' }]
    const update = p.refreshStatuses()
    const statuses = take('statuses')
    statuses.resolve({ apps: { current: { status: 'applied' } } })
    await update
    assert.equal(p.data.items[0].app.status, 'applied')

    p.data.items = [{ id: 'same', company: 'Old filter' }]
    const staleUpdate = p.refreshStatuses()
    const staleStatuses = take('statuses')
    p.setData({ industry: '软件/IT' })
    const reload = p.reload()
    const newList = take('list')
    take('listSummary').resolve({ total: 1, facets: [], meta: {} })
    newList.resolve(result('New filter', 'same'))
    await reload
    staleStatuses.resolve({ apps: { same: { status: 'stale' } } })
    await staleUpdate
    assert.equal(p.data.items[0].company, 'New filter')
    assert.equal(p.data.items[0].app, undefined)
  }

  // Returning after a minute must check the directory again, while a recent return is lightweight.
  {
    const p = instance()
    p.shown = true
    p.listAt = Date.now() - 61000
    p.onShow()
    const list = take('list')
    assert.equal(list.data.withFacets, false)
    list.resolve(result('Current', 'current'))
    await tick()
    assert(p.listAt > Date.now()-1000)
    const before = calls.filter(c => c.action === 'list').length
    p.onShow()
    assert.equal(calls.filter(c => c.action === 'list').length, before)
  }

  // A failed stats refresh must not leave an old verification count looking current.
  {
    const p = instance()
    p.data.stats = { verified: 9823, leads: 7645, applied: 4 }
    const refresh = p.loadStats(true)
    assert.equal(p.data.stats.verified, null)
    assert.equal(p.data.stats.leads, null)
    assert.equal(p.data.stats.applied, 4)
    take('stats').reject(new Error('stats unavailable'))
    await refresh
    assert.equal(p.data.stats.verified, null)
    assert.equal(p.data.stats.leads, null)
    assert.equal(p.data.stats.applied, 4)
  }
  process.stdout.write('home loading tests passed (8 scenarios)\n')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
