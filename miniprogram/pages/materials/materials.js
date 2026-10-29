const { aiNotice, api } = require('../../utils/util.js')

const STYLES = ['通顺自然', '更简洁', '更正式', '突出亮点']
const LIMITS = ['不限字数', '200 字以内', '300 字以内', '500 字以内', '800 字以内']
const LIMIT_N = [0, 200, 300, 500, 800]
const TEMPLATES = ['自我介绍', '职业规划', '项目经历', '实习经历', '优点和不足', '为什么选择我们', '最有成就感的事', '遇到的挫折', '期望薪资与城市']
const newId = () => Math.random().toString(36).slice(2, 10)

Page({
  data: { materials: [], loaded: false, templates: TEMPLATES, editing: false, draft: { title: '', content: '' }, editIdx: -1, saving: false,
    open: {}, cid: '', company: '', role: '', tailoring: -1, result: null,
    styles: STYLES, styleIdx: 0, limits: LIMITS, limitIdx: 0, polishing: -1 },

  async onLoad (o) {
    this.setData({ cid: decodeURIComponent(o.cid || ''), company: decodeURIComponent(o.company || ''), role: decodeURIComponent(o.role || '') })
    try {
      const { materials } = await api('getMaterials')
      this.setData({ materials, loaded: true })
    } catch (e) { this.setData({ loaded: true }); wx.showToast({ title: e.message, icon: 'none' }) }
  },

  async persist (materials) {
    const r = await api('saveMaterials', { materials })
    this.setData({ materials: r.materials })
  },

  newFrom (e) { this.setData({ editing: true, editIdx: -1, draft: { title: e.currentTarget.dataset.t, content: '' } }) },
  edit (e) { const i = e.currentTarget.dataset.i; const m = this.data.materials[i]; this.setData({ editing: true, editIdx: i, draft: { title: m.title, content: m.content } }) },
  cancelEdit () { this.setData({ editing: false }) },
  onTitle (e) { this.setData({ 'draft.title': e.detail.value }) },
  onContent (e) { this.setData({ 'draft.content': e.detail.value }) },
  async saveDraft () {
    const d = this.data.draft
    if (!d.title.trim() && !d.content.trim()) { this.setData({ editing: false }); return }
    this.setData({ saving: true })
    const list = this.data.materials.slice()
    const item = { title: d.title.trim() || '未命名', content: d.content, updatedAt: new Date().toISOString() }
    if (this.data.editIdx >= 0) list[this.data.editIdx] = Object.assign({}, list[this.data.editIdx], item)
    else list.unshift(Object.assign({ id: newId() }, item))
    try { await this.persist(list); this.setData({ editing: false }); wx.showToast({ title: '已保存' }) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
    this.setData({ saving: false })
  },
  remove (e) {
    const i = e.currentTarget.dataset.i
    wx.showModal({ title: `删除「${this.data.materials[i].title}」？`, confirmText: '删除', confirmColor: '#C62F2A', success: async r => {
      if (!r.confirm) return
      const list = this.data.materials.slice(); list.splice(i, 1)
      try { await this.persist(list) } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
    } })
  },
  toggle (e) { const id = e.currentTarget.dataset.id; this.setData({ [`open.${id}`]: !this.data.open[id] }) },
  copy (e) { wx.setClipboardData({ data: this.data.materials[e.currentTarget.dataset.i].content }) },

  onStyle (e) { this.setData({ styleIdx: +e.detail.value }) },
  onLimit (e) { this.setData({ limitIdx: +e.detail.value }) },
  async polish (e) {
    if (!(await aiNotice())) return
    if (this.data.polishing >= 0 || this.data.tailoring >= 0) return
    const i = e.currentTarget.dataset.i
    const m = this.data.materials[i]
    this.setData({ polishing: i, result: null })
    try {
      const r = await api('polishMaterial', { title: m.title, content: m.content, style: STYLES[this.data.styleIdx], limit: LIMIT_N[this.data.limitIdx] })
      this.setData({ result: { i, kind: 'polish', text: r.text, changes: r.changes, style: r.style, length: r.length, saveTitle: `${m.title}-${r.style}`.slice(0, 30) } })
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
    this.setData({ polishing: -1 })
  },
  async replaceResult () {
    const r = this.data.result
    const list = this.data.materials.slice()
    list[r.i] = Object.assign({}, list[r.i], { content: r.text, updatedAt: new Date().toISOString() })
    try { await this.persist(list); this.setData({ result: null }); wx.showToast({ title: '已替换' }) } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
  },
  dropResult () { this.setData({ result: null }) },

  async tailor (e) {
    if (!(await aiNotice())) return
    if (this.data.tailoring >= 0 || this.data.polishing >= 0) return
    const i = e.currentTarget.dataset.i
    const m = this.data.materials[i]
    this.setData({ tailoring: i, result: null })
    try {
      const r = await api('tailorMaterial', { id: this.data.cid, title: m.title, content: m.content, role: this.data.role })
      this.setData({ result: { i, kind: 'tailor', text: r.text, changes: r.changes, length: r.text.length, saveTitle: `${m.title}-${this.data.company}版`.slice(0, 30) } })
    } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
    this.setData({ tailoring: -1 })
  },
  copyResult () { wx.setClipboardData({ data: this.data.result.text }) },
  async saveResult () {
    const r = this.data.result
    const list = [Object.assign({ id: newId(), title: r.saveTitle, content: r.text, forCompany: r.kind === 'tailor' ? this.data.company : '', updatedAt: new Date().toISOString() })].concat(this.data.materials)
    try { await this.persist(list); this.setData({ result: null }); wx.showToast({ title: '已另存' }) } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
  }
})
