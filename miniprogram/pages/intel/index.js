const { api } = require('../../utils/util.js')
const config = require('../../config.js')
const demoItems = require('./demo-fixtures.js')

const CATEGORY_LABELS = { jobs: '求职', ai: 'AI', semiconductor: '半导体', electronics: '电子' }
const KIND_LABELS = { open_source_release: '开源项目版本发布', developer_release: '开发工具版本发布' }

function dateLabel (value) {
  if (typeof value !== 'string' || !value) return '发布时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '发布时间未知'
  const pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function presentItem (item) {
  const status = item && item.summaryStatus
  const statusLabels = { grounded: '有来源依据', reviewed: '已核对', unavailable: '未提供中文摘要', unknown: '摘要状态未知' }
  const displayType = KIND_LABELS[item && item.sourceKind] || '公开信息条目'
  return Object.assign({}, item, {
    categoryLabel: CATEGORY_LABELS[item && item.category] || '分类未知',
    displayDate: dateLabel(item && item.publishedAt),
    displaySource: item && item.sourceName || '来源未知',
    displaySummary: item && item.summaryZh || '该条目未提供中文摘要，请查看原始发布说明。',
    displaySummaryStatus: statusLabels[status] || '摘要状态未知',
    displayType,
    displayTitle: item && item.title || (item && item.version ? `${displayType} ${item.version}` : '标题未知'),
    feedback: Object.assign({ liked: false, bookmarked: false, disliked: false }, item && item.feedback || {})
  })
}

function filteredDemo (category) {
  return demoItems.filter(item => category === 'all' || item.category === category).map(presentItem)
}

Page({
  data: {
    items: [], loading: false, loadingMore: false, error: '', moreError: '',
    enabled: false, demo: false, digestEnabled: false, nextCursor: null, digestAtLabel: '', windowNotice: '', feedbackBusyId: '', cursorConflict: false, refreshing: false,
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
    this.setData({ demo, enabled, digestEnabled: config.intelDigestEnabled === true, items: demo ? filteredDemo(this.data.category) : [] })
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
      loading: true, loadingMore: false, error: '', moreError: '', cursorConflict: false, refreshing: keepItems, nextCursor: null,
      items: keepItems ? this.data.items : [], digestAtLabel: '', windowNotice: ''
    })
    try {
      const result = await api('intelFeed', { category, limit: 20 })
      if (!this.alive || seq !== this.seq) return
      const items = Array.isArray(result && result.items) ? result.items.map(presentItem) : []
      this.setData({
        items, nextCursor: result && result.nextCursor || null,
        windowNotice: result && result.windowLimited ? '当前仅展示按记录编号排序的最多 300 条已发布条目。' : '',
        digestAtLabel: result && result.digestAt ? `更新于 ${dateLabel(result.digestAt)}` : '',
        loading: false, refreshing: false, error: '', moreError: ''
      })
    } catch (error) {
      if (!this.alive || seq !== this.seq) return
      const message = error && error.message
      if (error && error.code === 'feature_disabled') {
        this.setData({ enabled: false, loading: false, refreshing: false, error: '', items: [], nextCursor: null })
        return
      }
      this.setData({ loading: false, refreshing: false, error: message === '情报功能暂未开启' ? message : (message || '暂时无法加载情报') })
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
      if (error && error.code === 'conflict') {
        this.setData({ loadingMore: false, cursorConflict: true, moreError: '资讯排序或反馈状态已更新，请刷新列表后继续。' })
        return
      }
      this.setData({ loadingMore: false, cursorConflict: false, moreError: (error && error.message) || '暂时无法加载更多' })
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

  onOpenPreferences () { wx.navigateTo({ url: '/pages/intel-preferences/index' }) },

  onOpenDigest () {
    if (!this.data.digestEnabled) return
    wx.navigateTo({ url: '/pages/intel-digest/index' })
  },

  async onFeedback (event) {
    const id = event.currentTarget.dataset.id
    const action = event.currentTarget.dataset.action
    if (!this.data.enabled || this.data.demo || this.data.feedbackBusyId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id || '') || !['like', 'unlike', 'bookmark', 'unbookmark', 'dislike', 'undislike'].includes(action)) return
    const previous = this.data.items.find(item => item.id === id)
    if (!previous) return
    this.setData({ feedbackBusyId: id, items: this.data.items.map(item => item.id === id ? Object.assign({}, item, { feedbackError: '' }) : item) })
    try {
      const result = await api('intelFeedback', { itemId: id, feedbackAction: action })
      if (!this.alive) return
      const state = result && result.state || {}
      this.setData({ items: this.data.items.map(item => item.id === id ? Object.assign({}, item, { feedback: Object.assign({}, item.feedback, { liked: !!state.liked, bookmarked: !!state.bookmarked, disliked: !!state.disliked }), feedbackError: '' }) : item) })
    } catch (error) {
      if (!this.alive) return
      this.setData({ items: this.data.items.map(item => item.id === id ? Object.assign({}, item, { feedbackError: (error && error.message) || '操作失败，请重试' }) : item) })
    } finally {
      if (this.alive) this.setData({ feedbackBusyId: '' })
    }
  },

  noop () {},

  onRetry () {
    if (this.data.enabled && !this.data.demo) this.loadFeed({ keepItems: this.data.items.length > 0 })
  },

  onRetryMore () { this.loadMore() },

  onRefreshFeed () {
    if (this.data.enabled && !this.data.demo) this.loadFeed({ keepItems: true })
  }
})
