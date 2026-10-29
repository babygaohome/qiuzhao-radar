const { api, copyLink } = require('../../utils/util.js')
Page({
  data: { loading: true, company: '', role: '', jd: '', resume: '', materials: [], evidence: null, result: null, recommendation: '', busy: false, error: '' },
  async onLoad (o) {
    this.id = decodeURIComponent(o.id || '')
    try {
      const r = await api('getMatchContext', { id: this.id, role: decodeURIComponent(o.role || '') })
      this.setData({ loading: false, company: r.company, role: r.role, evidence: r.evidence, recommendation: r.recommendation,
        materials: r.materials.map(x => Object.assign({}, x, { selected: false })), result: r.previous || null })
    } catch (e) { this.setData({ loading: false, error: e.message }) }
  },
  onText (e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }) },
  toggleMaterial (e) { const i = e.currentTarget.dataset.i; this.setData({ ['materials[' + i + '].selected']: !this.data.materials[i].selected }) },
  async analyze () {
    if (this.data.busy) return
    const ids = this.data.materials.filter(x => x.selected).map(x => x.id)
    if (!this.data.jd.trim() || (!this.data.resume.trim() && !ids.length)) { this.setData({ error: '请填写该岗位JD，并粘贴个人经历或选择网申材料' }); return }
    const consent = await new Promise(resolve => wx.showModal({ title: '发送内容给AI分析？', content: '本次JD、个人经历和选中的网申材料会发给智谱AI处理。请先移除身份证号、手机号等敏感信息。结果仅保存在你的账号下。', confirmText: '开始分析', success: r => resolve(r.confirm), fail: () => resolve(false) }))
    if (!consent) return
    this.setData({ busy: true, error: '' })
    try { this.setData({ result: await api('matchJob', { id: this.id, role: this.data.role, jd: this.data.jd.trim(), resume: this.data.resume.trim(), materialIds: ids }) }); wx.pageScrollTo({ selector: '#match-result', duration: 250 }) }
    catch (e) { this.setData({ error: e.message }) }
    this.setData({ busy: false })
  },
  copySource (e) { const url = e.currentTarget.dataset.url; if (url) copyLink(url) },
  goMaterials () { wx.navigateTo({ url: '/pages/materials/materials?cid=' + encodeURIComponent(this.id) + '&company=' + encodeURIComponent(this.data.company) }) }
})
