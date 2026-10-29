const { api, decorate, short } = require('../../utils/util.js')

const WHY = { extend: '截止延后', extra: '补录 / 新批次', late: '刚发布就快截止' }

// 每家公司为什么算「捡漏」，写成一句话
function whyText (c) {
  const out = []
  if (c.pk.includes('extend')) out.push(`截止从 ${short(c.prevDeadline)} 延到 ${short(c.deadline)}`)
  if (c.pk.includes('extra')) out.push(`批次：${c.batch || '补录'}`)
  if (c.pk.includes('late')) out.push(`${short(c.openDate || c.addedAt)} 才发布，${short(c.deadline)} 就截止`)
  return out.join('；')
}

Page({
  data: { tabs: [], tab: 'all', sort: 'dl', scored: false, items: [], count: 0, loaded: false, error: '' },

  onLoad () { this.load() },
  onShow () { if (this.raw) this.refreshStatuses() },
  onPullDownRefresh () { this.load().then(() => wx.stopPullDownRefresh()) },

  async load () {
    try {
      const r = await api('pickup')
      this.raw = r.items
      this.apps = r.apps || {}
      const n = k => r.items.filter(c => c.pk.includes(k)).length
      const tabs = [{ k: 'all', t: '全部', n: r.items.length }].concat(r.kinds.map(k => ({ k: k.k, t: k.t, n: n(k.k) })))
      this.setData({ tabs, scored: r.scored, sort: r.scored ? 'score' : 'dl', loaded: true, error: '' })
      this.render()
    } catch (e) {
      this.setData({ error: e.message, loaded: true })
    }
  },

  render () {
    const { tab, sort } = this.data
    let list = this.raw.filter(c => tab === 'all' || c.pk.includes(tab))
    list = list.slice().sort(sort === 'score' ? (a, b) => (b.ps || 0) - (a.ps || 0) || a.dl.localeCompare(b.dl) : (a, b) => a.dl.localeCompare(b.dl))
    const items = list.map(c => Object.assign(decorate(c, this.apps[c._id]), {
      why: whyText(c), kinds: c.pk.map(k => WHY[k]), ps: c.ps, psCls: c.ps >= 75 ? 'hi' : c.ps >= 60 ? 'mid' : 'lo'
    }))
    this.setData({ items, count: items.length })
  },

  async refreshStatuses () {
    const ids = this.raw.map(c => c._id).slice(0, 100)
    try {
      const { apps } = await api('statuses', { ids })
      this.apps = apps
      this.render()
    } catch (e) {}
  },

  onTab (e) { this.setData({ tab: e.currentTarget.dataset.k }); this.render() },
  onSort (e) { this.setData({ sort: e.currentTarget.dataset.k }); this.render() },
  goAI () { wx.switchTab({ url: '/pages/ai/ai' }) },
  open (e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) }
})
