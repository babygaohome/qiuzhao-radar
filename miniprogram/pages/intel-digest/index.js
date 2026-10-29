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
    originalUrl,
    feedback: { bookmarked: !!(item.feedback && item.feedback.bookmarked) },
    feedbackBusy: false,
    feedbackError: ''
  }
}

function presentDigestJob (item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const companyId = typeof item.companyId === 'string' ? item.companyId : ''
  const company = typeof item.company === 'string' ? item.company.trim() : ''
  const title = typeof item.title === 'string' ? item.title.trim() : ''
  const deadline = typeof item.deadline === 'string' ? item.deadline.trim() : ''
  const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(companyId) || !company || company.length > 180 || !title || title.length > 180 || !reason || reason.length > 160) return null
  if (!deadline || deadline === '9999-12-31' || /未公布|未知|不详|无明确|滚动|招满/i.test(deadline)) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return null
  const [year, month, day] = deadline.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  return { companyId, company, title, deadline, reason }
}

const pageDefinition = {
  data: {
    tab: 'today',
    loading: false,
    error: '',
    empty: false,
    digest: null,
    items: [],
    jobItems: [],
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
    historyJobItems: [],
    historyDetailLoading: false,
    historyDetailError: '',
    historyDetailEmpty: false,
    readErrorDate: '',
    readBusyDate: '',
    feedbackBusyId: '',
    contractNotice: '每日简报功能正在逐步开放。'
  },

  onLoad () {
    this.alive = true
    this.todaySeq = 0
    this.historySeq = 0
    this.historyDetailSeq = 0
    this.readingSnapshots = new Set()
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
      const jobItems = raw && Array.isArray(raw.jobItems) ? raw.jobItems.map(presentDigestJob).filter(Boolean) : []
      const digest = raw && typeof raw.localDate === 'string'
        ? { localDate: formatDate(raw.localDate), localDateRaw: raw.localDate, snapshotToken: typeof raw.snapshotToken === 'string' ? raw.snapshotToken : '', generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '', readAt: typeof raw.readAt === 'string' ? raw.readAt : '' }
        : null
      this.setData({ digest, items, jobItems, empty: !digest || items.length + jobItems.length === 0, loading: false, error: '', readErrorDate: '' })
      if (digest && digest.snapshotToken && Object.prototype.hasOwnProperty.call(raw, 'readAt') && !digest.readAt) this.markDigestRead(raw.localDate, 'today', digest.snapshotToken)
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
    this.setData({ historyMoreLoading: false, historyMoreError: '', historyLocalDate: localDate, historyDigest: null, historyItems: [], historyJobItems: [], historyDetailError: '', historyDetailEmpty: false })
    this.loadHistoryDate(localDate)
  },

  onBackToHistory () {
    this.historyDetailSeq = (this.historyDetailSeq || 0) + 1
    this.setData({ historyLocalDate: '', historyDigest: null, historyItems: [], historyJobItems: [], historyDetailLoading: false, historyDetailError: '', historyDetailEmpty: false })
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
      const jobItems = raw && Array.isArray(raw.jobItems) ? raw.jobItems.map(presentDigestJob).filter(Boolean) : []
      const digest = raw && raw.localDate === localDate
        ? { localDate: formatDate(raw.localDate), snapshotToken: typeof raw.snapshotToken === 'string' ? raw.snapshotToken : '', generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '' }
        : null
      if (digest) {
        digest.localDateRaw = raw.localDate
        digest.snapshotToken = typeof raw.snapshotToken === 'string' ? raw.snapshotToken : ''
        digest.readAt = typeof raw.readAt === 'string' ? raw.readAt : ''
      }
      this.setData({ historyDigest: digest, historyItems: items, historyJobItems: jobItems, historyDetailEmpty: !digest || items.length + jobItems.length === 0, historyDetailLoading: false, historyDetailError: '', readErrorDate: '' })
      if (digest && digest.snapshotToken && Object.prototype.hasOwnProperty.call(raw, 'readAt') && !digest.readAt) this.markDigestRead(localDate, 'history', digest.snapshotToken)
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

  async markDigestRead (localDate, context, snapshotToken) {
    if (!this.alive || typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate) ||
      typeof snapshotToken !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotToken) || this.readingSnapshots.has(snapshotToken)) return
    this.readingSnapshots.add(snapshotToken)
    const currentDigest = () => context === 'today' ? this.data.digest : this.data.historyDigest
    const isCurrentView = () => this.alive && this.data.tab === context &&
      (context === 'today' || this.data.historyLocalDate === localDate) &&
      currentDigest() && currentDigest().localDateRaw === localDate && currentDigest().snapshotToken === snapshotToken
    if (isCurrentView()) this.setData({ readBusyDate: localDate, readErrorDate: '' })
    try {
      const result = await api('intelMarkDigestRead', { localDate, snapshotToken })
      if (!this.alive) return
      if (!result || typeof result.readAt !== 'string' || !Number.isFinite(Date.parse(result.readAt))) throw new Error('read_stamp_missing')
      const readAt = result.readAt
      const histories = this.data.histories.map(row => row.localDate === localDate && row.snapshotToken === snapshotToken ? Object.assign({}, row, { readAt }) : row)
      const digest = this.data.digest && this.data.digest.localDateRaw === localDate && this.data.digest.snapshotToken === snapshotToken ? Object.assign({}, this.data.digest, { readAt }) : this.data.digest
      const historyDigest = this.data.historyDigest && this.data.historyDigest.localDateRaw === localDate && this.data.historyDigest.snapshotToken === snapshotToken ? Object.assign({}, this.data.historyDigest, { readAt }) : this.data.historyDigest
      this.setData({ histories, digest, historyDigest, readBusyDate: this.data.readBusyDate === localDate && isCurrentView() ? '' : this.data.readBusyDate, readErrorDate: this.data.readErrorDate === localDate && isCurrentView() ? '' : this.data.readErrorDate })
    } catch (_) {
      if (this.alive && isCurrentView()) this.setData({ readBusyDate: this.data.readBusyDate === localDate ? '' : this.data.readBusyDate, readErrorDate: localDate })
    } finally {
      this.readingSnapshots.delete(snapshotToken)
      if (this.alive && this.data.readBusyDate === localDate && isCurrentView()) this.setData({ readBusyDate: '' })
    }
  },

  onRetryMarkRead () {
    const context = this.data.tab === 'history' ? 'history' : 'today'
    const digest = context === 'history' ? this.data.historyDigest : this.data.digest
    const localDate = digest && digest.localDateRaw
    if (localDate && digest && digest.snapshotToken) return this.markDigestRead(localDate, context, digest.snapshotToken)
  },

  async onToggleBookmark (event) {
    const itemId = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id
    const context = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.context
    if (!['today', 'history'].includes(context) || typeof itemId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(itemId) || this.data.feedbackBusyId) return
    const collection = context === 'history' ? 'historyItems' : 'items'
    const previous = this.data[collection].find(item => item.itemId === itemId)
    if (!previous) return
    const action = previous.feedback.bookmarked ? 'unbookmark' : 'bookmark'
    this.setData({ feedbackBusyId: itemId, [collection]: this.data[collection].map(item => item.itemId === itemId ? Object.assign({}, item, { feedbackError: '' }) : item) })
    try {
      const result = await api('intelFeedback', { itemId, feedbackAction: action })
      if (!this.alive) return
      const bookmarked = !!(result && result.state && result.state.bookmarked)
      const updateList = rows => rows.map(item => item.itemId === itemId
        ? Object.assign({}, item, { feedback: Object.assign({}, item.feedback, { bookmarked }), feedbackError: '' })
        : item)
      this.setData({ items: updateList(this.data.items), historyItems: updateList(this.data.historyItems) })
    } catch (error) {
      if (this.alive) this.setData({ [collection]: this.data[collection].map(item => item.itemId === itemId ? Object.assign({}, item, { feedbackError: (error && error.message) || '收藏操作失败，请重试' }) : item) })
    } finally {
      if (this.alive) this.setData({ feedbackBusyId: '' })
    }
  },

  onOpenItem (event) {
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return
    wx.navigateTo({ url: `/pages/intel-detail/detail?id=${encodeURIComponent(id)}` })
  },

  onOpenJob (event) {
    const id = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return
    wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(id)}` })
  }
}

function normalizeHistoryRows (rows) {
  if (!Array.isArray(rows)) return []
  return rows.filter(row => row && typeof row.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.localDate))
    .map(row => ({ localDate: row.localDate, dateLabel: formatDate(row.localDate), itemCount: Number.isInteger(row.itemCount) && row.itemCount >= 0 ? row.itemCount : 0, generatedAt: typeof row.generatedAt === 'string' ? row.generatedAt : '', readAt: typeof row.readAt === 'string' ? row.readAt : '', snapshotToken: typeof row.snapshotToken === 'string' ? row.snapshotToken : '' }))
}

Page(pageDefinition)

module.exports = { pageDefinition, presentDigestItem, presentDigestJob, formatDate, normalizeHistoryRows }
