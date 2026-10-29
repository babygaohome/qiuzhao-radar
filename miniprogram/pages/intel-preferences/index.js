const { api } = require('../../utils/util.js')
const config = require('../../config.js')

const TOPICS = [
  { key: 'jobs', label: '求职更新' }, { key: 'ai', label: '人工智能' },
  { key: 'semiconductor', label: '半导体' }, { key: 'electronics', label: '电子产业' }
]
const SUBTOPICS = [
  { key: 'rag', label: 'RAG' }, { key: 'ai-agents', label: 'AI Agent' }, { key: 'machine-learning', label: '机器学习' },
  { key: 'research', label: '论文与研究' }, { key: 'open-source', label: '开源项目' }, { key: 'chip-design', label: '芯片设计' },
  { key: 'advanced-packaging', label: '先进封装' }, { key: 'semiconductor-equipment', label: '半导体设备' },
  { key: 'memory', label: '存储' }, { key: 'electronics', label: '电子制造' }
]
const DEFAULTS = { topics: {}, subtopics: [], blockedTopics: [], languages: ['zh', 'en'], timezone: 'Asia/Shanghai', digestLocalTime: '08:00', dailyDigestEnabled: true, behaviorLearningEnabled: false }
Page({
  data: {
    loading: true, saving: false, error: '', saved: false, loaded: false, revision: 0, blockedTopics: [],
    topicChoices: TOPICS.map(item => Object.assign({}, item, { selected: false })),
    subtopicChoices: SUBTOPICS.map(item => Object.assign({}, item, { selected: false })),
    languageZh: true, languageEn: true, timezone: DEFAULTS.timezone, digestLocalTime: DEFAULTS.digestLocalTime,
    dailyDigestEnabled: true, behaviorLearningEnabled: false
  },

  onLoad () {
    this.alive = true
    this.loadPreferences()
  },

  onUnload () { this.alive = false },

  async loadPreferences () {
    if (config.intelEnabled !== true) { this.setData({ loading: false, error: '情报功能暂未开启' }); return }
    this.setData({ loading: true, error: '', saved: false })
    try {
      const result = await api('intelGetPreferences', {})
      if (!this.alive) return
      this.applyPreferences(result && result.preferences || {})
    } catch (error) {
      if (this.alive) this.setData({ error: (error && error.message) || '暂时无法加载偏好设置' })
    } finally {
      if (this.alive) this.setData({ loading: false })
    }
  },

  applyPreferences (preferences) {
    const selectedTopics = preferences.topics && typeof preferences.topics === 'object' ? preferences.topics : {}
    const selectedSubs = Array.isArray(preferences.subtopics) ? preferences.subtopics : []
    this.setData({
      revision: Number.isInteger(preferences.revision) ? preferences.revision : 0,
      loaded: true,
      blockedTopics: Array.isArray(preferences.blockedTopics) ? preferences.blockedTopics.slice() : [],
      topicChoices: TOPICS.map(item => Object.assign({}, item, { selected: Number(selectedTopics[item.key]) > 0 })),
      subtopicChoices: SUBTOPICS.map(item => Object.assign({}, item, { selected: selectedSubs.includes(item.key) })),
      languageZh: !Array.isArray(preferences.languages) || preferences.languages.includes('zh'),
      languageEn: !Array.isArray(preferences.languages) || preferences.languages.includes('en'),
      timezone: preferences.timezone || DEFAULTS.timezone,
      digestLocalTime: preferences.digestLocalTime || DEFAULTS.digestLocalTime,
      dailyDigestEnabled: preferences.dailyDigestEnabled !== false,
      behaviorLearningEnabled: preferences.behaviorLearningEnabled === true
    })
  },

  onToggleTopic (event) {
    const key = event.currentTarget.dataset.key
    if (!TOPICS.some(item => item.key === key)) return
    this.setData({ topicChoices: this.data.topicChoices.map(item => item.key === key ? Object.assign({}, item, { selected: !item.selected }) : item), saved: false })
  },

  onToggleSubtopic (event) {
    const key = event.currentTarget.dataset.key
    if (!SUBTOPICS.some(item => item.key === key)) return
    this.setData({ subtopicChoices: this.data.subtopicChoices.map(item => item.key === key ? Object.assign({}, item, { selected: !item.selected }) : item), saved: false })
  },

  onLanguageChange (event) {
    const key = event.currentTarget.dataset.key
    if (key === 'zh') this.setData({ languageZh: !this.data.languageZh, saved: false })
    if (key === 'en') this.setData({ languageEn: !this.data.languageEn, saved: false })
  },

  onTimezoneChange (event) { this.setData({ timezone: event.detail.value, saved: false }) },
  onTimeChange (event) { this.setData({ digestLocalTime: event.detail.value, saved: false }) },
  onDigestChange (event) { this.setData({ dailyDigestEnabled: !!event.detail.value, saved: false }) },

  onLearningChange (event) {
    // MVP is explicit-only: users can disable older settings, but cannot enable collection here.
    this.setData({ behaviorLearningEnabled: false, saved: false })
    if (event.detail.value) wx.showToast({ title: '当前版本不采集阅读行为', icon: 'none' })
  },

  buildPreferences () {
    const selected = this.data.topicChoices.filter(item => item.selected).map(item => item.key)
    const topics = {}
    if (selected.length) selected.forEach(key => { topics[key] = 1 / selected.length })
    return {
      topics,
      subtopics: this.data.subtopicChoices.filter(item => item.selected).map(item => item.key),
      blockedTopics: this.data.blockedTopics.slice(),
      languages: [this.data.languageZh ? 'zh' : '', this.data.languageEn ? 'en' : ''].filter(Boolean),
      timezone: this.data.timezone.trim(),
      digestLocalTime: this.data.digestLocalTime,
      dailyDigestEnabled: this.data.dailyDigestEnabled,
      behaviorLearningEnabled: false
    }
  },

  async onSave () {
    if (this.data.loading || this.data.saving) return
    const preferences = this.buildPreferences()
    if (!preferences.languages.length) { this.setData({ error: '请至少选择一种资讯语言' }); return }
    if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(preferences.timezone)) { this.setData({ error: '请填写有效的时区，例如 Asia/Shanghai' }); return }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.digestLocalTime)) { this.setData({ error: '简报时间格式应为 HH:mm' }); return }
    this.setData({ saving: true, error: '', saved: false })
    try {
      const result = await api('intelSavePreferences', { preferences, revision: this.data.revision })
      if (!this.alive) return
      const saved = result && result.preferences || Object.assign({}, preferences, { revision: result && result.revision })
      this.applyPreferences(saved)
      this.setData({ saved: true })
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (error) {
      if (!this.alive) return
      if (error && error.code === 'conflict') {
        this.setData({ error: '设置已在其他位置更新，请重新加载后再保存。' })
        if (error.preferences) this.applyPreferences(error.preferences)
      } else this.setData({ error: (error && error.message) || '保存失败，请重试' })
    } finally {
      if (this.alive) this.setData({ saving: false })
    }
  },

  onRetry () { this.loadPreferences() }
})
