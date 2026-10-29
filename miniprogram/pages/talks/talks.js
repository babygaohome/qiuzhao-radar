const { api, parse, copyLink } = require('../../utils/util.js')

const DAYS = [{ k: 'today', t: '今天' }, { k: 'tomorrow', t: '明天' }, { k: 'week', t: '7 天内' }, { k: 'all', t: '全部' }]
const WEEK = '日一二三四五六'

function view (t) {
  const d = parse(t.date)
  return Object.assign({}, t, {
    day: d ? `${d.getMonth() + 1}/${d.getDate()}` : t.date, week: d ? '周' + WEEK[d.getDay()] : '',
    place: [t.city, t.school, t.venue].filter(Boolean).join(' · ')
  })
}

Page({
  data: { days: DAYS, day: 'week', cities: [], cityOn: {}, mine: false, q: '', items: [], total: null, loading: false, done: false, error: '' },

  async onLoad () {
    // 城市默认用 AI 挑选里填的意向城市
    try {
      const r = await api('getProfile')
      const cs = String((r.profile && r.profile.city) || '').split(/[\s,，、]+/).filter(Boolean).slice(0, 5)
      this.setData({ cities: cs, cityOn: cs.reduce((m, c) => { m[c] = true; return m }, {}) })
    } catch (e) {}
    this.reload()
  },
  onPullDownRefresh () { this.reload().then(() => wx.stopPullDownRefresh()) },
  onReachBottom () { this.more() },

  query (page) {
    const d = this.data
    return { day: d.day, cities: d.cities.filter(c => d.cityOn[c]), mine: d.mine, q: d.q.trim(), page }
  },
  reload () { this.page = 0; this.setData({ items: [], done: false }); return this.more(true) },
  async more (first) {
    if (this.data.loading || this.data.done) return
    this.setData({ loading: true, error: '' })
    try {
      const r = await api('talks', this.query(this.page))
      const upd = { items: this.data.items.concat(r.items.map(view)), loading: false, done: r.items.length < r.pageSize }
      if (first) upd.total = r.total
      this.page += 1
      this.setData(upd)
    } catch (e) { this.setData({ loading: false, error: e.message }) }
  },

  onDay (e) { this.setData({ day: e.currentTarget.dataset.k }); this.reload() },
  onCity (e) { const c = e.currentTarget.dataset.c; this.setData({ [`cityOn.${c}`]: !this.data.cityOn[c] }); this.reload() },
  onMine () { this.setData({ mine: !this.data.mine }); this.reload() },
  onQ (e) { this.setData({ q: e.detail.value }); clearTimeout(this.qt); this.qt = setTimeout(() => this.reload(), 400) },

  // 加到这家公司的日程（公司在库里时），否则提示加到手机日历
  async addEvent (e) {
    const t = this.data.items[e.currentTarget.dataset.i]
    const at = t.date + (/^\d{2}:\d{2}/.test(t.time) ? ' ' + t.time.slice(0, 5) : '')
    try {
      const g = await api('get', { id: t.cid })
      const events = ((g.app && g.app.events) || []).concat({ type: '宣讲会', at, note: [t.school, t.venue].filter(Boolean).join(' ').slice(0, 30) })
      await api('saveApp', { id: t.cid, events, status: (g.app && g.app.status) || 'want', company: t.company })
      wx.showToast({ title: '已加到「我的投递」的待办', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: '这家公司不在列表里，可以加到手机日历', icon: 'none' })
    }
  },
  addCalendar (e) {
    const t = this.data.items[e.currentTarget.dataset.i]
    if (!wx.addPhoneCalendar) { wx.showToast({ title: '微信版本太旧，不支持加日历', icon: 'none' }); return }
    const hm = /^\d{2}:\d{2}/.test(t.time) ? t.time.slice(0, 5) : ''
    const start = new Date(`${t.date}T${hm || '09:00'}:00+08:00`).getTime() / 1000
    wx.addPhoneCalendar({
      title: `${t.company} 宣讲会`, startTime: start, endTime: start + (hm ? 5400 : 0), allDay: !hm,
      description: [t.title, t.school, t.venue, '来自秋招雷达，以学校和企业通知为准'].filter(Boolean).join(' · '), alarm: true, alarmOffset: hm ? 1800 : 0,
      success: () => wx.showToast({ title: '已加到手机日历', icon: 'none' })
    })
  },
  copy (e) { copyLink(e.currentTarget.dataset.url, '已复制，去浏览器打开看详情和报名方式') }
})
