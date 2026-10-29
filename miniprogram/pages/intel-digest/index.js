'use strict'

const { api } = require('../../utils/util.js')

function formatDate (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '日期未知'
  return value.replace(/-/g, '.')
}

function presentDigestItem (item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const itemId = typeof item.itemId === 'string' ? item.itemId : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(itemId)) return null
  const originalUrl = typeof item.originalUrl === 'string' && /^https:\/\//i.test(item.originalUrl) ? item.originalUrl : ''
  return {
    itemId,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : '标题暂不可用',
    sourceName: typeof item.sourceName === 'string' && item.sourceName.trim() ? item.sourceName.trim() : '来源信息暂不可用',
    publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : '',
    reason: typeof item.reason === 'string' ? item.reason : '',
    originalUrl
  }
}

const pageDefinition = {
  data: {
    tab: 'today',
    loading: false,
    error: '',
    empty: false,
    digest: null,
    items: [],
    histories: [],
    historyError: '',
    historyLoading: false,
    historyCursor: '',
    historyHasMore: false,
    historyMoreLoading: false,
    historyMoreError: '',
    historyLocalDate: '',
    historyDigest: null,
    historyItems: [],
    historyDetailLoading: false,
    historyDetailError: '',
    historyDetailEmpty: false,
    contractNotice: '每日简报功能正在逐步开放。'
  },

  onLoad () {
    this.alive = true
    this.todaySeq = 0
    this.historySeq = 0
    this.historyDetailSeq = 0
    this.loadToday()
  },

  onUnload () {
    this.alive = false
    this.todaySeq = (this.todaySeq || 0) + 1
    this.historySeq = (this.historySeq || 0) + 1
    this.historyDetailSeq = (this.historyDetailSeq || 0) + 1
  },

  onShow () {
    if (this.alive && this.data.tab === 'today' && !this.data.loading) this.loadToday()
  },

  onSelectTab (event) {
    const tab = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.tab
    if (!['today', 'history'].includes(tab) || tab === this.data.tab) return
    if (tab === 'today') {
      this.historySeq = (this.historySeq || 0) + 1
      this.historyDetailSeq = (this.historyDetailSeq || 0) + 1
    } else this.todaySeq = (this.todaySeq || 0) + 1
    // A request invalidated by leaving a tab will not clear its own loading
    // flag when it resolves. Reset both flags here so returning can fetch again.
    this.setData({ tab, loading: false, historyLoading: false, historyMoreLoading: false, historyDetailLoading: false })
    if (tab === 'today' && !this.data.digest && !this.data.loading) this.loadToday()
    if (tab === 'history' && !this.data.histories.length && !this.data.historyLoading) this.loadHistory()
  },

  async loadToday () {
    if (!this.alive || this.data.loading) return
    const seq = ++this.todaySeq
    this.setData({ loading: true, error: '', empty: false })
    try {
      const result = await api('intelDigestToday', {})
      if (!this.alive || seq !== this.todaySeq) return
      const raw = result && result.digest
      const items = raw && Array.isArray(raw.items) ? raw.items.map(presentDigestItem).filter(Boolean) : []
      const digest = raw && typeof raw.localDate === 'string'
        ? { localDate: formatDate(raw.localDate), generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '' }
        : null
      this.setData({ digest, items, empty: !digest || items.length === 0, loading: false, error: '' })
    } catch (error) {
      if (!this.alive || seq !== this.todaySeq) return
      this.setData({ loading: false, error: (error && error.message) || '暂时无法加载今日简报' })
    }
  },

  async loadHistory () {
    if (!this.alive || this.data.historyLoading) return
    const seq = ++this.historySeq
    this.setData({ historyLoading: true, historyError: '' })
    try {
      const result = await api('intelDigestHistory', { limit: 30 })
      if (!this.alive || seq !== this.historySeq) return
      const histories = normalizeHistoryRows(result && result.digests)
      const cursor = typeof (result && result.nextCursor) === 'string' && result.nextCursor ? result.nextCursor : ''
      this.setData({ histories, historyCursor: cursor, historyHasMore: !!cursor, historyLoading: false, historyError: '', historyMoreError: '' })
    } catch (error) {
      if (!this.alive || seq !== this.historySeq) return
      this.setData({ historyLoading: false, historyError: (error && error.message) || '暂时无法加载历史简报' })
    }
  },

  async loadMoreHistory () {
    if (!this.alive || this.data.tab !== 'history' || this.data.historyLocalDate || !this.data.historyHasMore || !this.data.historyCursor || this.data.historyMoreLoading) return
    const seq = this.historySeq
    const cursor = this.data.historyCursor
    this.setData({ historyMoreLoading: true, historyMoreError: '' })
    try {
      const result = await api('intelDigestHistory', { limit: 30, cursor })
      if (!this.alive || this.data.tab !== 'history' || this.data.historyLocalDate || seq !== this.historySeq || cursor !== this.data.historyCursor) return
      const incoming = normalizeHistoryRows(result && result.digests)
      const byDate = new Map(this.data.histories.map(row => [row.localDate, row]))
      incoming.forEach(row => { if (!byDate.has(row.localDate)) byDate.set(row.localDate, row) })
      const nextCursor = typeof (result && result.nextCursor) === 'string' && result.nextCursor && result.nextCursor !== cursor ? result.nextCursor : ''
      this.setData({ histories: [...byDate.values()], historyCursor: nextCursor, historyHasMore: !!nextCursor, historyMoreLoading: false, historyMoreError: '' })
    } catch (error) {
      if (!this.alive || this.data.tab !== 'history' || this.data.historyLocalDate || seq !== this.historySeq || cursor !== this.data.historyCursor) return
      this.setData({ historyMoreLoading: false, historyMoreError: (error && error.message) || '暂时无法加载更多记录' })
    }
  },

  onOpenHistoryDate (event) {
    const localDate = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.date
    if (!this.alive || typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate) || this.data.historyDetailLoading) return
    this.historySeq = (this.historySeq || 0) + 1
    this.setData({ historyMoreLoading: false, historyMoreError: '', historyLocalDate: localDate, historyDigest: null, historyItems: [], historyDetailError: '', historyDetailEmpty: false })
    this.loadHistoryDate(localDate)
  },

  onBackToHistory () {
    this.historyDetailSeq = (this.historyDetailSeq || 0) + 1
    this.setData({ historyLocalDate: '', historyDigest: null, historyItems: [], historyDetailLoading: false, historyDetailError: '', historyDetailEmpty: false })
  },

  async loadHistoryDate (localDate) {
    if (!this.alive || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return
    const seq = ++this.historyDetailSeq
    this.setData({ historyDetailLoading: true, historyDetailError: '', historyDetailEmpty: false })
    try {
      const result = await api('intelDigestByDate', { localDate })
      if (!this.alive || seq !== this.historyDetailSeq || this.data.historyLocalDate !== localDate) return
      const raw = result && result.digest
      const items = raw && Array.isArray(raw.items) ? raw.items.map(presentDigestItem).filter(Boolean) : []
      const digest = raw && raw.localDate === localDate
        ? { localDate: formatDate(raw.localDate), generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '' }
        : null
      this.setData({ historyDigest: digest, historyItems: items, historyDetailEmpty: !digest || !items.length, historyDetailLoading: false, historyDetailError: '' })
    } catch (error) {
      if (!this.alive || seq !== this.historyDetailSeq || this.data.historyLocalDate !== localDate) return
      this.setData({ historyDetailLoading: false, historyDetailError: (error && error.message) || '暂时无法加载这一天的简报' })
    }
  },

  onRetry () {
    if (this.data.tab === 'history') {
      if (this.data.historyLocalDate) return this.onRetryHistoryDate()
      if (this.data.historyMoreError) return this.loadMoreHistory()
      return this.loadHistory()
    }
    return this.loadToday()
  },

  onLoadMoreHistory () { return this.loadMoreHistory() },

  onRetryHistoryDate () {
    if (this.data.tab !== 'history' || !this.data.historyLocalDate) return
    return this.loadHistoryDate(this.data.historyLocalDate)
  },

  onOpenItem (event) {
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return
    wx.navigateTo({ url: `/pages/intel-detail/detail?id=${encodeURIComponent(id)}` })
  }
}

function normalizeHistoryRows (rows) {
  if (!Array.isArray(rows)) return []
  return rows.filter(row => row && typeof row.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.localDate))
    .map(row => ({ localDate: row.localDate, dateLabel: formatDate(row.localDate), itemCount: Number.isInteger(row.itemCount) && row.itemCount >= 0 ? row.itemCount : 0, generatedAt: typeof row.generatedAt === 'string' ? row.generatedAt : '' }))
}

Page(pageDefinition)

module.exports = { pageDefinition, presentDigestItem, formatDate, normalizeHistoryRows }
