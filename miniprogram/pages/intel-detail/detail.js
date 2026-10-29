const { api, copyLink } = require('../../utils/util.js')
const config = require('../../config.js')
const demoItems = require('../intel/demo-fixtures.js')

const CATEGORY_LABELS = { jobs: '求职', ai: 'AI', semiconductor: '半导体', electronics: '电子' }
const STATUS_LABELS = { grounded: '有来源依据', reviewed: '已核对', unavailable: '未提供中文摘要', unknown: '摘要状态未知' }
const KIND_LABELS = { open_source_release: '开源项目版本发布', developer_release: '开发工具版本发布' }

function presentItem (item) {
  const date = item && typeof item.publishedAt === 'string' ? new Date(item.publishedAt) : null
  const displayDate = date && !Number.isNaN(date.getTime())
    ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
    : '发布时间未知'
  const displayType = KIND_LABELS[item && item.sourceKind] || '公开信息条目'
  return Object.assign({}, item, {
    categoryLabel: CATEGORY_LABELS[item && item.category] || '分类未知',
    displayDate,
    displaySource: item && item.sourceName || '来源未知',
    displaySummary: item && item.summaryZh || '该条目未提供中文摘要，请查看原始发布说明。',
    displaySummaryStatus: STATUS_LABELS[item && item.summaryStatus] || '摘要状态未知',
    displayType,
    displayTitle: item && item.title || (item && item.version ? `${displayType} ${item.version}` : '标题未知'),
    displayOriginalUrl: item && typeof item.originalUrl === 'string' && /^https:\/\//i.test(item.originalUrl) ? item.originalUrl : ''
  })
}

Page({
  data: { item: null, itemId: '', loading: true, error: '', demo: false, enabled: false },
  onLoad (options) {
    this.alive = true
    this.seq = 0
    const id = options && options.id || ''
    this.itemId = id
    const demo = options && options.demo === '1' && config.intelDemoMode === true
    const enabled = config.intelEnabled === true
    this.setData({ demo, enabled, itemId: id })
    if (demo) {
      const item = demoItems.find(row => row.id === id)
      this.setData({ item: item ? presentItem(item) : null, loading: false, error: item ? '' : '这条演示内容不存在' })
      return
    }
    if (!enabled) {
      this.setData({ loading: false, error: '情报功能暂未开启' })
      return
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
      this.setData({ loading: false, error: '资讯编号无效' })
      return
    }
    this.loadItem()
  },

  onUnload () {
    this.alive = false
    this.seq = (this.seq || 0) + 1
  },

  async loadItem () {
    if (!this.alive || !this.data.enabled || this.data.demo || !this.itemId) return
    const seq = (this.seq || 0) + 1
    this.seq = seq
    this.setData({ loading: true, error: '' })
    try {
      const result = await api('intelItem', { id: this.itemId })
      if (!this.alive || seq !== this.seq) return
      this.setData({ item: result && result.item ? presentItem(result.item) : null, loading: false, error: result && result.item ? '' : '这条资讯暂不可用' })
    } catch (error) {
      if (!this.alive || seq !== this.seq) return
      if (error && error.code === 'feature_disabled') {
        this.setData({ enabled: false, item: null, loading: false, error: '情报功能暂未开启' })
        return
      }
      this.setData({ loading: false, error: (error && error.message) || '暂时无法加载详情' })
    }
  },

  onRetry () { this.loadItem() },

  onCopyLink () {
    const url = this.data.item && this.data.item.displayOriginalUrl
    if (typeof url === 'string' && /^https:\/\//i.test(url)) copyLink(url)
  }
})
