const { api } = require('../../utils/util.js')
const config = require('../../config.js')
const demoItems = require('./demo-fixtures.js')

Page({
  data: { items: [], loading: false, error: '', enabled: false, demo: false, filters: [
    { key: 'all', label: '全部' }, { key: 'ai', label: 'AI' },
    { key: 'semiconductor', label: '半导体' }, { key: 'electronics', label: '电子' }
  ], category: 'all' },

  onLoad () {
    const demo = config.intelDemoMode === true
    const enabled = config.intelEnabled === true
    this.seq = 0
    this.setData({ demo, enabled })
    if (demo) this.setData({ items: demoItems })
  },

  onShow () {
    if (config.intelEnabled === true && config.intelDemoMode !== true) this.loadFeed()
  },

  onPullDownRefresh () {
    if (config.intelDemoMode === true || config.intelEnabled !== true) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadFeed().finally(() => wx.stopPullDownRefresh())
  },

  async loadFeed () {
    const seq = (this.seq || 0) + 1
    this.seq = seq
    this.setData({ loading: true, error: '' })
    try {
      const result = await api('intelFeed', { category: this.data.category, limit: 20 })
      if (seq !== this.seq) return
      this.setData({ items: result.items || [], loading: false, error: '' })
    } catch (error) {
      if (seq !== this.seq) return
      this.setData({ loading: false, error: (error && error.message) || '暂时无法加载情报' })
    }
  },

  onSelectCategory (event) {
    const category = event.currentTarget.dataset.category
    if (!['all', 'ai', 'semiconductor', 'electronics'].includes(category) || category === this.data.category) return
    if (this.data.demo) {
      this.setData({ category, items: category === 'all' ? demoItems : demoItems.filter(item => item.category === category) })
      return
    }
    this.setData({ category })
    if (this.data.enabled && !this.data.demo) this.loadFeed()
  },

  onOpenItem (event) {
    const id = event.currentTarget.dataset.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return
    wx.navigateTo({ url: `/pages/intel-detail/detail?id=${encodeURIComponent(id)}${this.data.demo ? '&demo=1' : ''}` })
  },

  onRetry () { if (this.data.enabled && !this.data.demo) this.loadFeed() }
})
