const { api } = require('../../utils/util.js')

const EMPTY = { company: '', role: '', city: '', monthly: 0, months: 12, bonus: 0, signBonus: 0, housing: 0, fundRate: 0, hukou: false, wlb: '', penalty: 0, ddl: '', notes: '' }
const WLB = ['未填', '基本不加班', '偶尔加班', '经常加班', '大小周', '996 / 强度很大']
const FIELDS = [
  { key: 'role', label: '岗位' }, { key: 'city', label: '城市' },
  { key: 'pay', label: '月薪 × 薪数' }, { key: 'bonusTxt', label: '年终奖' },
  { key: 'annual', label: '税前年包' }, { key: 'oneOff', label: '签字费+安家' }, { key: 'firstYear', label: '第一年合计' },
  { key: 'fund', label: '公积金/年' }, { key: 'fundRateTxt', label: '公积金比例' },
  { key: 'wlbTxt', label: '加班强度' }, { key: 'hukouTxt', label: '户口' }, { key: 'penaltyTxt', label: '违约金' },
  { key: 'ddl', label: '答复截止' }, { key: 'notes', label: '备注' }
]
const money = n => (n >= 10000 ? (n / 10000).toFixed(n % 10000 ? 1 : 0) + ' 万' : String(n || 0))

function toRows (offers) {
  const rows = offers.map(o => {
    const annual = o.monthly * o.months + o.bonus
    const oneOff = (o.signBonus || 0) + (o.housing || 0)
    // 公积金：个人 + 单位各缴一份
    const fund = Math.round(o.monthly * o.fundRate / 100 * 2 * 12)
    return Object.assign({}, o, {
      annualN: annual, annual: money(annual), pay: `${o.monthly || 0} × ${o.months}`, bonusTxt: money(o.bonus),
      oneOff: oneOff ? money(oneOff) : '—', firstYear: money(annual + oneOff), fundRateTxt: o.fundRate ? o.fundRate + '%' : '未填',
      wlbTxt: o.wlb || '未填', penaltyTxt: o.penalty ? money(o.penalty) : '未填',
      fund: o.fundRate ? money(fund) : '未填', hukouTxt: o.hukou ? '解决' : '—', ddl: o.ddl || '—', notes: o.notes || '—', role: o.role || '—', city: o.city || '—'
    })
  })
  const max = Math.max(0, ...rows.map(r => r.annualN))
  rows.forEach(r => { r.best = rows.length > 1 && r.annualN === max && max > 0 })
  return rows
}

Page({
  data: { wlbs: WLB, offers: [], rows: [], fields: FIELDS, loaded: false, editing: false, d: EMPTY, idx: -1, priorities: '', analyzing: false, analysis: null, importable: [] },

  async onLoad () {
    try {
      const [{ offers, analysis }, mine] = await Promise.all([api('getOffers'), api('myApps')])
      const have = new Set(offers.map(o => o.company))
      const importable = mine.items.filter(x => x.app.status === 'offer' && !have.has(x.company.company)).map(x => x.company.company)
      this.setData({ offers, rows: toRows(offers), analysis, priorities: (analysis && analysis.priorities) || '', importable, loaded: true })
    } catch (e) { this.setData({ loaded: true }); wx.showToast({ title: e.message, icon: 'none' }) }
  },

  async persist (offers) {
    const r = await api('saveOffers', { offers })
    this.setData({ offers: r.offers, rows: toRows(r.offers) })
  },
  add () { this.setData({ editing: true, idx: -1, d: Object.assign({}, EMPTY) }) },
  edit (e) { const i = e.currentTarget.dataset.i; this.setData({ editing: true, idx: i, d: Object.assign({}, this.data.offers[i]) }) },
  cancel () { this.setData({ editing: false }) },
  onText (e) {
    const f = e.currentTarget.dataset.f
    const v = ['monthly', 'months', 'bonus', 'fundRate', 'signBonus', 'housing', 'penalty'].includes(f) ? Number(e.detail.value) || 0 : e.detail.value
    this.setData({ [`d.${f}`]: v })
  },
  onWlb (e) { const i = +e.detail.value; this.setData({ 'd.wlb': i ? WLB[i] : '' }) },
  onDdl (e) { this.setData({ 'd.ddl': e.detail.value }) },
  onHukou (e) { this.setData({ 'd.hukou': e.detail.value }) },
  async save () {
    if (!this.data.d.company.trim()) { wx.showToast({ title: '填一下公司名', icon: 'none' }); return }
    const list = this.data.offers.slice()
    if (this.data.idx >= 0) list[this.data.idx] = this.data.d; else list.push(this.data.d)
    try { await this.persist(list); this.setData({ editing: false }) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
  },
  remove (e) {
    const i = e.currentTarget.dataset.i
    wx.showModal({ title: `删除「${this.data.offers[i].company}」？`, confirmText: '删除', confirmColor: '#C62F2A', success: async r => {
      if (!r.confirm) return
      const list = this.data.offers.slice(); list.splice(i, 1)
      try { await this.persist(list) } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
    } })
  },
  async importFromApps () {
    const list = this.data.offers.concat(this.data.importable.map(company => Object.assign({}, EMPTY, { company })))
    try { await this.persist(list); this.setData({ importable: [] }); wx.showToast({ title: '已导入，点公司名补充薪资', icon: 'none' }) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
  },
  onPriorities (e) { this.setData({ priorities: e.detail.value }) },
  async analyze () {
    this.setData({ analyzing: true })
    try { this.setData({ analysis: await api('compareOffers', { priorities: this.data.priorities }) }) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
    this.setData({ analyzing: false })
  }
})
