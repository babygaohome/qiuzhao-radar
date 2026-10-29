const { api, decorate, cn } = require('../../utils/util.js')

const SCOPES = ['', 'curated', 'auto', 'manual']
const SORTS = ['deadline', 'added', 'updated', 'name']

Page({
  data: {
    q: '', industry: '', scopeIdx: 0, ctypeIdx: 0, batchIdx: 0, sortIdx: 0, official: false, showClosed: false, fresh: false, tab: 'verified', recentKind: '', filtersOpen: false,
    scopes: ['全部来源', '精选大厂', '自动收集', '我添加的'],
    ctypes: ['全部性质', '央国企', '民企', '外企/合资', '事业单位'],
    batches: ['全部批次', '秋招', '提前批', '补录', '春招'],
    sorts: ['按截止时间', '按最新收录', '按最近更新', '按名称'],
    facets: [], items: [], total: null, page: 0, loading: false, refreshing: false, done: false, error: '',
    stats: {}, metaText: '招聘目录更新时间暂不可用', todo: [], todoMore: 0
  },

  onLoad () { this.seq = 0; this.statsAt = 0; this.reload({ force: true, stats: true }) },
  onShow () {
    // 从详情页回来时，刷新可能改过的状态
    const g = getApp().globalData
    if (this.shown && (g.listDirty || Date.now() - (this.listAt || 0) >= 60000)) { g.listDirty = false; this.reload({ force: true, stats: true }) } else if (this.shown) { this.refreshStatuses(); this.loadStats(false) }
    this.loadTodo()
    this.shown = true
  },
  onPullDownRefresh () { this.reload({ force: true, stats: true }).then(() => wx.stopPullDownRefresh()) },
  onReachBottom () { if (!this.data.refreshing) this.loadMore() },

  filters () {
    const d = this.data
    return {
      q: d.q.trim(), industry: d.industry, ctype: d.ctypeIdx ? d.ctypes[d.ctypeIdx] : '',
      scope: SCOPES[d.scopeIdx], batchType: d.batchIdx ? d.batches[d.batchIdx] : '', official: d.official, showClosed: d.showClosed, fresh: d.fresh, tab: d.tab, recentKind: d.recentKind, sort: SORTS[d.sortIdx]
    }
  },

  reload (options) {
    options = options || {}
    this.seq += 1
    const seq = this.seq
    const filters = this.filters()
    const key = JSON.stringify(filters)
    const sameFilter = this.listKey === key
    const keepItems = sameFilter && this.data.items.length > 0
    const previousPage = this.data.page
    const previousDone = this.data.done
    this.listKey = key
    this.setData({
      items: keepItems ? this.data.items : [], total: keepItems ? this.data.total : null,
      facets: keepItems ? this.data.facets : [], page: keepItems ? previousPage : 0, done: keepItems && previousDone,
      loading: !keepItems, refreshing: true, error: ''
    })
    if (options.stats || Date.now() - (this.statsAt || 0) > 30000) this.loadStats(true)
    // Summary has independent requests and must never delay the first page of companies.
    this.loadSummary(seq, filters)
    return this.loadMore(true, { seq, filters, replace: true, keepItems, previousPage, previousDone })
  },

  loadSummary (seq, filters) {
    return api('listSummary', filters).then(r => {
      if (seq !== this.seq) return
      const m = r.meta || {}
      this.setData({
        total: r.total == null ? this.data.total : r.total,
        facets: Array.isArray(r.facets) ? r.facets : this.data.facets,
        metaText: this.summaryText(m)
      })
    }).catch(() => {})
  },

  summaryText (meta) {
    const sync = meta && meta.syncStatus
    const crawler = sync && sync.crawler
    const maintain = sync && sync.maintain
    const formatTime = value => {
      if (!value) return ''
      const d = new Date(value)
      if (Number.isNaN(d.getTime())) return ''
      const beijing = new Date(d.getTime() + 8 * 3600000)
      return `${beijing.getUTCMonth() + 1}月${beijing.getUTCDate()}日 ${String(beijing.getUTCHours()).padStart(2, '0')}:${String(beijing.getUTCMinutes()).padStart(2, '0')} 北京时间`
    }
    if (crawler) {
      const last = formatTime(crawler.lastSuccessAt)
      const attempt = formatTime(crawler.lastAttemptAt)
      if (crawler.status === 'running') return `招聘目录更新中${last ? ` · 上次成功 ${last}` : ''}`
      if (crawler.status === 'failed' || crawler.status === 'error' || crawler.status === 'partial' || (crawler.failedSources || []).length) return `招聘目录更新异常${attempt ? ` · 最近尝试 ${attempt}` : ''}${last ? ` · 上次成功 ${last}` : ''}`
      const successMs = crawler.lastSuccessAt ? new Date(crawler.lastSuccessAt).getTime() : 0
      if (successMs && Date.now() - successMs > 3 * 3600000) return `目录数据可能较旧 · 最近成功 ${last}`
      if (last) return `招聘目录更新于 ${last}`
      if (attempt) return `尚无成功记录 · 最近尝试 ${attempt}`
    }
    const legacy = meta && meta.updatedAt ? `目录更新于 ${cn(meta.updatedAt)}` : ''
    if (legacy) return legacy
    const maintainAt = formatTime(maintain && maintain.lastSuccessAt)
    return maintainAt ? `核实任务运行于 ${maintainAt} · 目录采集时间暂不可用` : '招聘目录更新时间暂不可用'
  },

  // 今日待办：只读自己的标记，失败就不显示
  loadTodo () {
    return api('todo', {}).then(r => this.setData({ todo: r.items || [], todoMore: r.more || 0 })).catch(() => {})
  },
  goMine () { wx.switchTab({ url: '/pages/mine/mine' }) },
  loadStats (force) {
    if (!force && Date.now() - (this.statsAt || 0) < 30000) return Promise.resolve()
    if (!force && this.statsRequest) return this.statsRequest
    const seq = this.seq
    this.statsAt = Date.now()
    // Keep personal counters and the visible list, but never present an old
    // catalog verification count as current while a refresh is in flight.
    this.setData({ stats: Object.assign({}, this.data.stats, { verified: null, leads: null }) })
    const request = api('stats', { tab: this.data.tab, withProgress: false, withRecent: true }).then(stats => {
      if (seq === this.seq) this.setData({ stats })
    }).catch(() => { if (seq === this.seq) this.statsAt = 0 }).finally(() => { if (this.statsRequest === request) this.statsRequest = null })
    this.statsRequest = request
    return request
  },

  async loadMore (first, options) {
    options = options || {}
    if (options.seq == null && (this.data.loading || this.data.done || this.data.refreshing)) return
    const seq = options.seq == null ? this.seq : options.seq
    const filters = options.filters || this.filters()
    const page = options.replace ? 0 : this.data.page
    if (options.replace) this.setData({ loading: !options.keepItems, refreshing: true, error: '' })
    else this.setData({ loading: true, error: '' })
    try {
      const r = await api('list', Object.assign({}, filters, { page, withFacets: false }))
      if (seq !== this.seq) return
      const items = r.items.map(c => decorate(c, r.apps[c._id]))
      if (options.replace) this.listAt = Date.now()
      const upd = { items: options.replace ? items : this.data.items.concat(items), page: page + 1,
        done: r.items.length < r.pageSize, loading: false, refreshing: false, error: '' }
      if (options.replace && !this.data.metaText) upd.metaText = '招聘目录更新时间暂不可用'
      this.setData(upd)
    } catch (e) {
      if (seq === this.seq) this.setData(Object.assign({
        loading: false, refreshing: false, error: e.message
      }, options.keepItems ? { page: options.previousPage, done: options.previousDone } : {}))
    }
  },

  async refreshStatuses () {
    const seq = this.seq
    const ids = this.data.items.map(x => x.id).slice(0, 100)
    if (!ids.length) return
    try {
      const { apps } = await api('statuses', { ids })
      if (seq === this.seq) this.setData({ items: this.data.items.map(c => decorate(c, apps[c.id])) })
    } catch (e) {}
  },

  onSearch (e) {
    this.setData({ q: e.detail.value })
    clearTimeout(this.qTimer)
    this.qTimer = setTimeout(() => this.reload(), 450)
  },
  onSearchNow () { clearTimeout(this.qTimer); this.reload() },
  toggleFilters () { this.setData({ filtersOpen: !this.data.filtersOpen }) },
  onIndustry (e) { this.setData({ industry: e.currentTarget.dataset.ind }); this.reload() },
  onScope (e) { this.setData({ scopeIdx: +e.detail.value, industry: '' }); this.reload() },
  onCtype (e) { this.setData({ ctypeIdx: +e.detail.value, industry: '' }); this.reload() },
  onBatch (e) { this.setData({ batchIdx: +e.detail.value }); this.reload() },
  onSort (e) { this.setData({ sortIdx: +e.detail.value }); this.reload() },
  onOfficial (e) { this.setData({ official: e.detail.value, industry: '' }); this.reload() },
  onClosed (e) { this.setData({ showClosed: e.detail.value }); this.reload() },
  onFresh (e) { this.setData(Object.assign({ fresh: e.detail.value, industry: '' }, !e.detail.value ? { recentKind: '', tab: this.data.tab === 'recent' ? 'verified' : this.data.tab } : {})); this.reload() },
  tgOfficial () { this.onOfficial({ detail: { value: !this.data.official } }) },
  tgFresh () { this.onFresh({ detail: { value: !this.data.fresh } }) },
  onTab (e) { const tab = e.currentTarget.dataset.k; if (tab === this.data.tab) return; this.setData(Object.assign({ tab, industry: '', recentKind: '' }, this.data.tab === 'recent' || tab === 'public' ? { fresh: false } : {})); this.reload() },
  tgClosed () { this.onClosed({ detail: { value: !this.data.showClosed } }) },
  showRecent (e) {
    const kind = e.currentTarget.dataset.kind
    if (!['new', 'updated'].includes(kind)) return
    this.setData({ tab: 'recent', recentKind: kind, fresh: true, q: '', industry: '', scopeIdx: 0, ctypeIdx: 0, official: false, showClosed: false, sortIdx: kind === 'new' ? 1 : 2 })
    this.reload()
  },

  goTalks () { wx.navigateTo({ url: '/pages/talks/talks' }) },
  goPickup () { wx.navigateTo({ url: '/pages/pickup/pickup' }) },
  open (e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },
  add () { wx.navigateTo({ url: '/pages/edit/edit' }) },
  onShareAppMessage () { return { title: '秋招雷达：2027届在招公司和投递进度', path: '/pages/index/index' } }
})
