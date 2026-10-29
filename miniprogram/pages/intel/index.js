const { api } = require('../../utils/util.js')
const config = require('../../config.js')
const demoItems = require('./demo-fixtures.js')

const CATEGORY_LABELS = { jobs: '求职', ai: 'AI', semiconductor: '半导体', electronics: '电子' }

function dateLabel (value) {
  if (typeof value !== 'string' || !value) return '发布时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '发布时间未知'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function presentItem (item) {
  const status = item && item.summaryStatus
  const statusLabels = { grounded: '有来源依据', reviewed: '已核对', unknown: '摘要状态未知' }
  return Object.assign({}, item, {
    categoryLabel: CATEGORY_LABELS[item && item.category] || '分类未知',
    displayDate: dateLabel(item && item.publishedAt),
    displaySource: item && item.sourceName || '来源未知',
    displaySummary: item && item.summaryZh || '暂无可核实摘要',
    displaySummaryStatus: statusLabels[status] || '摘要状态未知'
  })
}

function filteredDemo (category) {
  return demoItems.filter(item => category === 'all' || item.category === category).map(presentItem)
}

Page({
  data: {
    items: [], loading: false, loadingMore: false, error: '', moreError: '',
    enabled: false, demo: false, nextCursor: null, digestAtLabel: '',
    filters: [
      { key: 'all', label: '全部' }, { key: 'ai', label: 'AI' },
      { key: 'semiconductor', label: '半导体' }, { key: 'electronics', label: '电子' }
    ], category: 'all'
  },

  onLoad () {
    this.seq = 0
    this.alive = true
    const demo = config.intelDemoMode === true
    const enabled = config.intelEnabled === true
    this.setData({ demo, enabled, items: demo ? filteredDemo(this.data.category) : [] })
  },

  onShow () {
    if (config.intelEnabled === true && config.intelDemoMode !== true && this.alive !== false && !this.hasLoaded) {
      this.hasLoaded = true
      this.loadFeed()
    }
  },

  onUnload () {
    this.alive = false
    this.seq = (this.seq || 0) + 1
  },

  onPullDownRefresh () {
    if (config.intelDemoMode === true || config.intelEnabled !== true) {
      wx.stopPullDownRefresh()
      return
    }
    this.loadFeed({ keepItems: true }).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom () { this.loadMore() },

  async loadFeed (options) {
    options = options || {}
    if (this.alive === false || !this.data.enabled || this.data.demo) return
    const seq = (this.seq || 0) + 1
    this.seq = seq
    const category = this.data.category
    const keepItems = options.keepItems === true
    this.setData({
      loading: true, loadingMore: false, error: '', moreError: '', nextCursor: null,
      items: keepItems ? this.data.items : [], digestAtLabel: ''
    })
    try {
      const result = await api('intelFeed', { category, limit: 20 })
      if (!this.alive || seq !== this.seq) return
      const items = Array.isArray(result && result.items) ? result.items.map(presentItem) : []
      this.setData({
        items, nextCursor: result && result.nextCursor || null,
        digestAtLabel: result && result.digestAt ? `更新于 ${dateLabel(result.digestAt)}` : '',
        loading: false, error: '', moreError: ''
      })
    } catch (error) {
      if (!this.alive || seq !== this.seq) return
      this.setData({ loading: false, error: (error && error.message) || '暂时无法加载情报' })
    }
  },

  async loadMore () {
    if (!this.alive || !this.data.enabled || this.data.demo || this.data.loading || this.data.loadingMore || !this.data.nextCursor) return
    const seq = this.seq
    const category = this.data.category
    const cursor = this.data.nextCursor
    this.setData({ loadingMore: true, moreError: '' })
    try {
      const result = await api('intelFeed', { category, limit: 20, cursor })
      if (!this.alive || seq !== this.seq || category !== this.data.category) return
      const existing = this.data.items
      const seen = new Set(existing.map(item => item.id))
      const appended = (Array.isArray(result && result.items) ? result.items : []).map(presentItem).filter(item => {
        if (!item.id || seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
      this.setData({ items: existing.concat(appended), nextCursor: result && result.nextCursor || null, loadingMore: false, moreError: '' })
    } catch (error) {
      if (!this.alive || seq !== this.seq) return
      this.setData({ loadingMore: false, moreError: (error && error.message) || '暂时无法加载更多' })
    }
  },

  onSelectCategory (event) {
    const category = event.currentTarget.dataset.category
    if (!['all', 'ai', 'semiconductor', 'electronics'].includes(category) || category === this.data.category) return
    this.seq = (this.seq || 0) + 1
    this.setData({ category, items: [], nextCursor: null, error: '', moreError: '', loading: false, loadingMore: false, digestAtLabel: '' })
    if (this.data.demo) {
      this.setData({ items: filteredDemo(category) })
      return
    }
    if (this.data.enabled) this.loadFeed()
  },

  onOpenItem (event) {
    const id = event.currentTarget.dataset.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return
    wx.navigateTo({ url: `/pages/intel-detail/detail?id=${encodeURIComponent(id)}${this.data.demo ? '&demo=1' : ''}` })
  },

  onRetry () {
    if (this.data.enabled && !this.data.demo) this.loadFeed({ keepItems: this.data.items.length > 0 })
  },

  onRetryMore () { this.loadMore() }
})
