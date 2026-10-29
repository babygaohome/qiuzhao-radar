const { aiNotice, api, INDUSTRIES, CTYPES } = require('../../utils/util.js')

const CT = ['未注明'].concat(CTYPES)

Page({
  data: {
    id: '', industries: INDUSTRIES, ctypes: CT, indIdx: 0, ctypeIdx: 0, saving: false,
    pasteText: '', parsing: false, parseMsg: '', existing: null, exam: null,
    f: { company: '', batch: '', openDate: '', deadline: '', rolling: false, cities: '', url: '', note: '' }
  },

  async onLoad (o) {
    const id = decodeURIComponent(o.id || '')
    if (!id) return
    wx.setNavigationBarTitle({ title: '编辑公司' })
    this.setData({ id })
    try {
      const { company: c } = await api('get', { id })
      this.setData({
        indIdx: Math.max(0, INDUSTRIES.indexOf(c.industry)),
        ctypeIdx: Math.max(0, CT.indexOf(c.ctype)),
        f: { company: c.company || '', batch: c.batch || '', openDate: c.openDate || '', deadline: c.deadline || '',
          rolling: !c.deadline && c.deadlineText === '招满即止', cities: c.cities || '', url: c.url || '', note: c.note || '' }
      })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    }
  },

  onPaste (e) { this.setData({ pasteText: e.detail.value }) },
  async parse () {
    if (!(await aiNotice())) return
    const text = this.data.pasteText.trim()
    if (!text) { wx.showToast({ title: '先粘贴公告内容', icon: 'none' }); return }
    this.setData({ parsing: true, parseMsg: '', existing: null })
    try {
      const { result: r, existing } = await api('parsePosting', { text })
      this.setData({
        indIdx: Math.max(0, INDUSTRIES.indexOf(r.industry)),
        ctypeIdx: Math.max(0, CT.indexOf(r.ctype)),
        f: { company: r.company, batch: r.batch, openDate: r.openDate, deadline: r.deadline, rolling: r.rolling && !r.deadline,
          cities: r.cities, url: r.url, note: r.note },
        exam: r.exam, existing,
        parseMsg: '已经填好了，请核对一下再点「添加」。' + (r.url ? '' : '公告里没找到投递链接。')
      })
    } catch (e) {
      this.setData({ parseMsg: e.message })
    }
    this.setData({ parsing: false })
  },
  openExisting () { wx.redirectTo({ url: `/pages/detail/detail?id=${encodeURIComponent(this.data.existing.id)}` }) },

  onText (e) { this.setData({ [`f.${e.currentTarget.dataset.f}`]: e.detail.value }) },
  onDate (e) { this.setData({ [`f.${e.currentTarget.dataset.f}`]: e.detail.value }) },
  onRolling (e) { this.setData({ 'f.rolling': e.detail.value }) },
  onInd (e) { this.setData({ indIdx: +e.detail.value }) },
  onCtype (e) { this.setData({ ctypeIdx: +e.detail.value }) },

  async save () {
    const f = this.data.f
    if (!f.company.trim()) { wx.showToast({ title: '请填写公司名称', icon: 'none' }); return }
    this.setData({ saving: true })
    try {
      const data = Object.assign({}, f, {
        company: f.company.trim(),
        exam: this.data.exam,
        industry: INDUSTRIES[this.data.indIdx],
        ctype: this.data.ctypeIdx ? CT[this.data.ctypeIdx] : ''
      })
      await api('saveJob', { id: this.data.id, data })
      getApp().globalData.listDirty = true
      wx.showToast({ title: this.data.id ? '已保存' : '已添加' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
      this.setData({ saving: false })
    }
  }
})
