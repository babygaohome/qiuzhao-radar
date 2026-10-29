const { api, copyLink } = require('../../utils/util.js')
const config = require('../../config.js')
const demoItems = require('../intel/demo-fixtures.js')

Page({
  data: { item: null, loading: true, error: '', demo: false, enabled: false },
  onLoad (options) {
    const id = options && options.id || ''
    const demo = options && options.demo === '1' && config.intelDemoMode === true
    this.setData({ demo, enabled: config.intelEnabled === true })
    if (demo) {
      const item = demoItems.find(row => row.id === id)
      this.setData({ item: item || null, loading: false, error: item ? '' : '这条演示内容不存在' })
      return
    }
    if (!this.data.enabled) {
      this.setData({ loading: false, error: '情报功能暂未开启' })
      return
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
      this.setData({ loading: false, error: '资讯编号无效' })
      return
    }
    this.loadItem(id)
  },
  async loadItem (id) {
    try {
      const result = await api('intelItem', { id })
      this.setData({ item: result.item, loading: false, error: '' })
    } catch (error) {
      this.setData({ loading: false, error: (error && error.message) || '暂时无法加载详情' })
    }
  },
  onCopyLink () {
    const url = this.data.item && this.data.item.originalUrl
    if (typeof url === 'string' && /^https:\/\//i.test(url)) copyLink(url)
  }
})
