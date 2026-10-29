const { api, decorate, verifyView, STATUS, STATUS_LABEL, APPLIED, daysLeft, phase, eventTime, daysUntil, todayISO, parse, short, isStale, deadlineChange } = require('../../utils/util.js')

const TRACKED = ['want', 'applied', 'test', 'interview']
// 服务器时间转成北京时间的日期
const dayOf = t => { const d = new Date(t); return isNaN(d) ? '' : new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10) }

// 关注公司（想投 / 投递中）的新动态；已点过「知道了」的不再出现
function buildNews (raw, acked) {
  const ack = new Set(acked || [])
  const news = []
  raw.forEach(({ company: c, app: a }) => {
    if (!TRACKED.includes(a.status) || c.closed) return
    const touched = dayOf(a.updatedAt)
    const add = (key, text, cls) => { if (!ack.has(key)) news.push({ key, id: c._id, company: c.company, text, cls: cls || '' }) }
    if (c.dlExtendedAt && c.prevDeadline && daysUntil(c.dlExtendedAt) >= -14) add(`${c._id}:dl:${c.deadline}`, `截止延后了：${short(c.prevDeadline)} → ${short(c.deadline)}`, 'ok')
    else if (deadlineChange(c)) add(`${c._id}:dl:${c.deadline}`, deadlineChange(c))
    if (c.updated && daysUntil(c.updated) >= -7 && c.updated > touched) add(`${c._id}:up:${c.updated}`, `${short(c.updated)} 招聘信息有更新${c.batch ? `（${c.batch}）` : ''}`)
    if (c.exam && c.exam.has === '有' && dayOf(c.exam.at) > touched) add(`${c._id}:exam`, `查到了笔试 / 测评信息${c.exam.note ? '：' + c.exam.note : ''}`)
    if (a.status === 'want' && isStale(c)) add(`${c._id}:stale`, '很久没有更新，可能已经招满', 'bad')
  })
  return news
}

// 待办：想投还没投的网申截止（14 天内）+ 笔试面试日程（30 天内），按天分组；同一天多场、两小时内挨着的标出撞车
const WEEK = '日一二三四五六'
function buildTodo (raw) {
  const today = todayISO()
  const list = []
  raw.forEach(({ company: c, app: a }) => {
    // 岗位卡有自己的截止日期时按岗位提醒（同一家公司不同岗位截止可能不同）
    const wantCards = (a.tracks || []).filter(t => t.status === 'want' && t.deadline)
    wantCards.forEach(t => {
      if (t.deadline >= today && daysUntil(t.deadline) <= 14) list.push({ key: c._id + ':dl:' + t.id, id: c._id, company: c.company, date: t.deadline, time: '', kind: 'dl', what: '网申截止', note: t.name + '，还没投' })
    })
    if (!wantCards.length && a.status === 'want' && c.deadline && !c.closed && c.deadline >= today && daysUntil(c.deadline) <= 14) {
      list.push({ key: c._id + ':dl', id: c._id, company: c.company, date: c.deadline, time: '', kind: 'dl', what: '网申截止', note: '还没投' })
    }
    ;(a.events || []).forEach(e => {
      const d = e.at.slice(0, 10)
      if (d >= today && daysUntil(d) <= 30) list.push({ key: c._id + ':' + e.at, id: c._id, company: c.company, date: d, time: e.at.slice(11, 16), kind: 'ev', what: e.type, note: e.note || '' })
    })
  })
  const byDay = {}
  list.forEach(x => { (byDay[x.date] = byDay[x.date] || []).push(x) })
  const mins = t => t ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null
  return Object.keys(byDay).sort().slice(0, 12).map(date => {
    const xs = byDay[date].sort((a, b) => (a.kind === 'dl') - (b.kind === 'dl') || (a.time || '99').localeCompare(b.time || '99'))
    const evs = xs.filter(x => x.kind === 'ev')
    evs.forEach((x, i) => {
      const m = mins(x.time)
      x.clash = m !== null && evs.some((y, j) => j !== i && mins(y.time) !== null && Math.abs(mins(y.time) - m) < 120)
    })
    const n = daysUntil(date); const d = parse(date)
    return {
      date, items: xs, hot: n <= 1,
      head: n === 0 ? '今天' : n === 1 ? '明天' : n === 2 ? '后天' : `${d.getMonth() + 1}月${d.getDate()}日`,
      sub: `周${WEEK[d.getDay()]}`,
      warn: evs.length >= 2 ? `当天有 ${evs.length} 场笔试/面试${evs.some(x => x.clash) ? '，时间挨得很近' : ''}` : ''
    }
  })
}

// 导出用的表格：每行一家公司
function tableRows (raw) {
  const now = todayISO()
  const head = ['公司', '行业', '企业性质', '状态', '投递日期', '网申截止', '城市', '在招岗位', '下一个日程', '投递链接', '内推码', '投递记录', '复盘', '备注']
  const rows = raw.slice().sort((a, b) => (STATUS.findIndex(s => s.k === a.app.status) - STATUS.findIndex(s => s.k === b.app.status)))
    .map(({ company: c, app: a }) => {
      const next = (a.events || []).filter(e => e.at.slice(0, 10) >= now).sort((x, y) => x.at.localeCompare(y.at))[0]
      return [c.company, c.industry || '', c.ctype || '', STATUS_LABEL[a.status] || '', a.appliedAt || '',
        c.deadline || c.deadlineText || '', c.cities || '', c.note || '', next ? `${next.type} ${next.at}` : '', c.url || c.origUrl || c.agg || '', a.referral || '', (a.tracks || []).map(t => `${t.name}(${STATUS_LABEL[t.status] || ''}${t.failStage ? '·' + t.failStage : ''})`).join('；'), [a.failStage, a.lesson].filter(Boolean).join('：'), a.note || '']
    })
  return [head, ...rows]
}

const pct = (a, b) => (b ? Math.round(a * 100 / b) + '%' : '–')
// 投递统计：漏斗、行业分布、最近 6 周每周投递数
function buildStats (raw) {
  const applied = raw.filter(x => APPLIED.includes(x.app.status))
  const evHas = (x, re) => (x.app.events || []).some(e => re.test(e.type))
  const test = applied.filter(x => ['test', 'interview', 'offer'].includes(x.app.status) || evHas(x, /笔试|测评/)).length
  const interview = applied.filter(x => ['interview', 'offer'].includes(x.app.status) || evHas(x, /面/)).length
  const offer = applied.filter(x => x.app.status === 'offer').length
  const rejected = applied.filter(x => x.app.status === 'rejected').length
  const n = applied.length
  const funnel = [
    { label: '已投递', n, rate: '' },
    { label: '笔试/测评', n: test, rate: pct(test, n) },
    { label: '面试', n: interview, rate: pct(interview, n) },
    { label: 'Offer', n: offer, rate: pct(offer, n) }
  ].map(f => Object.assign(f, { w: n ? Math.max(4, Math.round(f.n * 100 / n)) : 0 }))
  const byInd = {}
  applied.forEach(x => { const k = x.company.industry || '其他'; byInd[k] = (byInd[k] || 0) + 1 })
  const inds = Object.keys(byInd).map(k => ({ name: k, n: byInd[k] })).sort((a, b) => b.n - a.n).slice(0, 6)
  const maxInd = inds.length ? inds[0].n : 1
  inds.forEach(i => { i.w = Math.round(i.n * 100 / maxInd) })
  // 最近 6 周（周一为一周开始）
  const today = parse(todayISO())
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const weeks = []
  for (let i = 5; i >= 0; i--) {
    const s = new Date(monday); s.setDate(monday.getDate() - i * 7)
    const e = new Date(s); e.setDate(s.getDate() + 6)
    const cnt = applied.filter(x => { const d = parse(x.app.appliedAt); return d && d >= s && d <= e }).length
    weeks.push({ label: `${s.getMonth() + 1}/${s.getDate()}`, n: cnt })
  }
  const maxW = Math.max(1, ...weeks.map(w => w.n))
  weeks.forEach(w => { w.h = Math.round(w.n * 100 / maxW) })
  // 复盘：挂在哪一步（公司整体 + 各条投递记录）
  const stages = {}
  raw.forEach(x => {
    if (x.app.status === 'rejected' && x.app.failStage) stages[x.app.failStage] = (stages[x.app.failStage] || 0) + 1
    ;(x.app.tracks || []).forEach(t => { if (t.status === 'rejected' && t.failStage) stages[t.failStage] = (stages[t.failStage] || 0) + 1 })
  })
  const fails = Object.keys(stages).map(k => ({ name: k, n: stages[k] })).sort((a, b) => b.n - a.n)
  const maxF = fails.length ? fails[0].n : 1
  fails.forEach(f => { f.w = Math.round(f.n * 100 / maxF) })
  return { n, rejected, funnel, inds, weeks, fails }
}

const ORDER = STATUS.reduce((m, s, i) => { m[s.k] = i; return m }, {})

Page({
  data: { items: [], shown: [], filters: [], st: 'all', viewLabel: '', agenda: [], stats: null, statsOpen: false, counts: { all: 0, applied: 0, flow: 0, offer: 0 }, due: [], todo: [], news: [], clash: null, exportOpen: false, loaded: false, error: '', backupDialog: null, backupPassword: '', backupBusy: false, importing: false, importProgress: '' },

  onShow () { this.load() },
  onPullDownRefresh () { this.load().then(() => wx.stopPullDownRefresh()) },

  async load () {
    try {
      const r = await api('myApps')
      const marked = r.items.filter(x => STATUS.some(s => s.k === x.app.status))
      this.raw = marked
      const items = marked.map(x => Object.assign(decorate(x.company, x.app), { myNote: x.app.note || '', updatedAt: x.app.updatedAt || '', vv: verifyView(x.company),
        failText: (x.app.status === 'rejected' || x.app.status === 'dropped') && (x.app.failStage || x.app.lesson) ? `${x.app.status === 'rejected' ? '挂在' : '放弃'}${x.app.failStage ? x.app.failStage : ''}${x.app.lesson ? ' · ' + x.app.lesson : ''}` : '',
        trackText: (x.app.tracks || []).length ? `${x.app.tracks.length} 张岗位卡：${x.app.tracks.map(t => t.name).slice(0, 3).join('、')}` : '' }))
      // 近期日程：所有公司未来 30 天内的笔试、面试
      const today = todayISO()
      const agenda = []
      marked.forEach(x => (x.app.events || []).forEach(e => {
        const d = daysUntil(e.at)
        if (e.at.slice(0, 10) >= today && d <= 30) {
          agenda.push({ id: x.company._id, company: x.company.company, type: e.type, at: e.at, label: eventTime(e.at), note: e.note,
            when: d === 0 ? '今天' : d === 1 ? '明天' : `${d} 天后`, soon: d <= 1 })
        }
      }))
      agenda.sort((a, b) => a.at.localeCompare(b.at))
        .sort((a, b) => ORDER[a.status] - ORDER[b.status] || String(b.updatedAt).localeCompare(String(a.updatedAt)))
      const n = k => items.filter(x => x.status === k).length
      const filters = [{ k: 'all', label: '全部', n: items.length }].concat(STATUS.map(s => ({ k: s.k, label: s.label, n: n(s.k) })).filter(f => f.n))
      const due = items.filter(x => x.status === 'want' && phase(x) !== 'closed' && daysLeft(x) !== null && daysLeft(x) <= 14)
        .sort((a, b) => daysLeft(a) - daysLeft(b))
      this.setData({
        items, filters, due, todo: buildTodo(marked), news: buildNews(marked, r.newsAck), agenda: agenda.slice(0, 20), stats: buildStats(marked), loaded: true, error: '',
        counts: {
          all: items.length,
          applied: items.filter(x => APPLIED.includes(x.status)).length,
          flow: n('test') + n('interview'),
          offer: n('offer')
        }
      })
      if (this.data.st !== 'all' && this.data.st !== 'appliedGroup' && this.data.st !== 'flowGroup' && !filters.some(f => f.k === this.data.st)) this.setData({ st: 'all' })
      this.applyFilter()
    } catch (e) {
      this.setData({ error: e.message, loaded: true })
    }
  },

  applyFilter () {
    const st = this.data.st
    const items = this.data.items
    const shown = st === 'all' ? items : st === 'appliedGroup' ? items.filter(x => APPLIED.includes(x.status)) :
      st === 'flowGroup' ? items.filter(x => x.status === 'test' || x.status === 'interview') : items.filter(x => x.status === st)
    const viewLabel = st === 'appliedGroup' ? '已投递' : st === 'flowGroup' ? '笔试/面试' : (this.data.filters.find(x => x.k === st) || {}).label || ''
    this.setData({ shown, viewLabel })
  },
  tapStat (e) {
    this.setData({ st: e.currentTarget.dataset.k })
    this.applyFilter()
    wx.pageScrollTo({ selector: '.list-anchor', duration: 300 })
  },
  resetFilter () { this.setData({ st: 'all' }); this.applyFilter() },
  ackNews (e) {
    const key = e.currentTarget.dataset.key
    const keys = key ? [key] : this.data.news.map(n => n.key)
    this.setData({ news: this.data.news.filter(n => !keys.includes(n.key)) })
    api('ackNews', { keys }).catch(() => {})
  },

  toggleExport () { this.setData({ exportOpen: !this.data.exportOpen }) },

  // CSV 带 BOM，Excel 打开中文不乱码；通过微信发到聊天里，在电脑上打开
  exportFile () {
    if (!this.raw || !this.raw.length) { wx.showToast({ title: '还没有标记任何公司', icon: 'none' }); return }
    const cell = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)
    const csv = '\ufeff' + tableRows(this.raw).map(r => r.map(cell).join(',')).join('\r\n')
    const name = `秋招投递表_${todayISO()}.csv`
    const path = `${wx.env.USER_DATA_PATH}/${name}`
    try {
      wx.getFileSystemManager().writeFileSync(path, csv, 'utf8')
    } catch (e) { wx.showToast({ title: '生成文件失败', icon: 'none' }); return }
    if (!wx.shareFileMessage) { this.copyTable(); return }
    wx.shareFileMessage({
      filePath: path, fileName: name,
      fail: err => { if (!/cancel/.test(err.errMsg || '')) this.copyTable() }
    })
  },

  // 复制成制表符分隔的文本，粘贴到 Excel、WPS、飞书表格会自动分列
  copyTable () {
    if (!this.raw || !this.raw.length) { wx.showToast({ title: '还没有标记任何公司', icon: 'none' }); return }
    const tsv = tableRows(this.raw).map(r => r.map(v => String(v).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
    wx.setClipboardData({ data: tsv, success: () => wx.showToast({ title: '已复制，粘贴到表格里即可', icon: 'none' }) })
  },

  goAI () { wx.switchTab({ url: '/pages/ai/ai' }) },
  goList () { wx.switchTab({ url: '/pages/index/index' }) },
  // 撞车时的改期沟通话术：填好公司、类型、时间，其余留空让自己补
  openClash (e) {
    const { company, what, date, time } = e.currentTarget.dataset
    const d = parse(date)
    const when = d ? `${d.getMonth() + 1}月${d.getDate()}日${time ? ' ' + time : ''}` : date
    const text = `${company} HR 您好：

我是【学校】【专业】的【姓名】，应聘贵公司【岗位】岗位，收到了 ${when} 的${what}安排，非常感谢给我这次机会！

由于该时间段我已有一场提前确定、无法调整的${what.includes('笔') || what.includes('测') ? '笔试' : '面试'}，两边时间冲突，想冒昧询问能否调整到以下任一时间：
1. 【备选时间 1】
2. 【备选时间 2】

如果时间不方便调整，我也会尽量再协调。给您添麻烦了，非常感谢！

【姓名】
【电话】`
    this.setData({ clash: { company, what, when, text } })
  },
  closeClash () { this.setData({ clash: null }) },
  copyClash () { wx.setClipboardData({ data: this.data.clash.text, success: () => wx.showToast({ title: '已复制，把【】里的内容换成自己的', icon: 'none' }) }) },

  // ---------- 备份与恢复：导出全部个人数据（JSON），换账号或误操作后可以恢复
  exportBackup () {
    wx.showActionSheet({ itemList: ['加密备份（推荐）', '普通 JSON 备份'], success: r => {
      if (r.tapIndex === 0) this.setData({ backupDialog: 'export', backupPassword: '' })
      else wx.showModal({ title: '导出普通备份？', content: '文件会包含你的投递、材料和 Offer，任何拿到文件的人都能查看。请只发送给自己，妥善保管。', confirmText: '导出', success: async m => {
        if (!m.confirm) return
        try { this.shareBackup(await api('exportMine')) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
      } })
    } })
  },
  shareBackup (data) {
    const name = `秋招雷达${data.format ? '加密' : ''}备份_${todayISO()}.json`
    const path = `${wx.env.USER_DATA_PATH}/${name}`
    const clean = () => { wx.getFileSystemManager().unlink({ filePath: path, fail: () => {} }) }
    try {
      wx.getFileSystemManager().writeFileSync(path, JSON.stringify(data), 'utf8')
      if (!wx.shareFileMessage) { clean(); wx.showToast({ title: '请更新微信后使用文件备份', icon: 'none' }); return }
      wx.shareFileMessage({ filePath: path, fileName: name, success: clean, fail: err => { clean(); if (!/cancel/.test(err.errMsg || '')) wx.showToast({ title: '文件发送失败，请重试', icon: 'none' }) } })
    } catch (e) { clean(); wx.showToast({ title: '备份文件生成失败', icon: 'none' }) }
  },
  onBackupPassword (e) { this.setData({ backupPassword: e.detail.value }) },
  closeBackupDialog () { if (!this.data.backupBusy) { this.backupBlob = null; this.setData({ backupDialog: null, backupPassword: '' }) } },
  async submitBackupPassword () {
    const password = this.data.backupPassword
    if (password.length < 8) { wx.showToast({ title: '密码至少8个字符', icon: 'none' }); return }
    if (this.data.backupBusy) return
    const mode = this.data.backupDialog
    this.setData({ backupBusy: true, backupPassword: '' })
    try {
      if (mode === 'export') { const r = await api('exportEncryptedBackup', { password }); this.shareBackup(r.encrypted) }
      else { const r = await api('decryptBackup', { password, encrypted: this.backupBlob }); this.confirmImport(r.data) }
      this.backupBlob = null
      this.setData({ backupDialog: null })
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
    this.setData({ backupBusy: false })
  },
  handleBackupData (data) {
    if (data && data.format === 'qiuzhao-encrypted-backup') { this.backupBlob = data; this.setData({ backupDialog: 'import', backupPassword: '' }) }
    else this.confirmImport(data)
  },
  // 从聊天里选之前发出去的备份文件
  importBackup () {
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['json'],
      success: r => {
        if (r.tempFiles[0].size > 1100000) { wx.showToast({ title: '备份文件过大，请拆分', icon: 'none' }); return }
        let data
        try { data = JSON.parse(wx.getFileSystemManager().readFileSync(r.tempFiles[0].path, 'utf8')) } catch (e) { wx.showToast({ title: '文件读不出来', icon: 'none' }); return }
        this.handleBackupData(data)
      }
    })
  },
  importFromClipboard () {
    wx.getClipboardData({ success: r => {
      if (r.data.length > 1100000) { wx.showToast({ title: '备份内容过大', icon: 'none' }); return }
      let data
      try { data = JSON.parse(r.data) } catch (e) { wx.showToast({ title: '剪贴板里不是备份内容', icon: 'none' }); return }
      this.handleBackupData(data)
    } })
  },
  confirmImport (data) {
    if (this.data.importing) return
    const n = (data && Array.isArray(data.apps)) ? data.apps.length : 0
    wx.showModal({
      title: '从备份恢复？', content: `备份里有 ${n} 家公司的投递记录（${(data && data.at || '').slice(0, 10)}）。同一家公司会用备份覆盖现在的记录；网申材料、Offer 会合并，不会删掉现有的。`,
      confirmText: '恢复',
      success: async m => {
        if (!m.confirm) return
        this.setData({ importing: true, importProgress: '正在检查备份…' })
        try {
          let r = await api('importMineChunk', { phase: 'start', data })
          while (!r.done) {
            this.setData({ importProgress: `正在恢复：公司 ${r.companies}/${(data.companies || []).length}，投递 ${r.apps}/${n}` })
            r = await api('importMineChunk', { phase: r.phase, session: r.session, data })
          }
          this.setData({ importProgress: `已恢复 ${r.restored} 家，跳过 ${r.skipped} 条` })
          wx.showToast({ title: `已恢复 ${r.restored} 家`, icon: 'none' }); this.load()
        } catch (e) { this.setData({ importProgress: '恢复中断，重新选择同一文件即可继续。' }); wx.showToast({ title: e.message, icon: 'none' }) }
        this.setData({ importing: false })
      }
    })
  },

  // ---------- 清除 AI 偏好 / 删除全部数据
  clearAi () {
    wx.showModal({ title: '清除 AI 偏好？', content: 'AI 挑选的条件、挑选结果和所有求职方案会被清掉；投递记录、材料、Offer 不受影响。', confirmText: '清除', confirmColor: '#E5484D',
      success: async m => {
        if (!m.confirm) return
        try { await api('clearAiPrefs'); wx.showToast({ title: '已清除', icon: 'none' }) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
      } })
  },
  deleteAll () {
    wx.showModal({
      title: '删除我的全部数据？',
      content: '会删掉投递记录、日程、岗位卡、内推码、网申材料、Offer、AI 偏好和你自己添加的公司，删除后无法恢复。建议先「导出备份文件」。',
      confirmText: '继续', confirmColor: '#E5484D',
      success: m => {
        if (!m.confirm) return
        wx.showModal({
          title: '输入「确认删除」', editable: true, placeholderText: '确认删除', confirmText: '删除', confirmColor: '#E5484D',
          success: async m2 => {
            if (!m2.confirm) return
            if ((m2.content || '').trim() !== '确认删除') { wx.showToast({ title: '输入不对，没有删除', icon: 'none' }); return }
            try {
              const r = await api('deleteAllMine', { confirm: '确认删除' })
              wx.showToast({ title: `已删除 ${r.apps} 条投递记录和全部资料`, icon: 'none' })
              this.load()
            } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
          }
        })
      }
    })
  },

  goPickup () { wx.navigateTo({ url: '/pages/pickup/pickup' }) },
  goMaterials () { wx.navigateTo({ url: '/pages/materials/materials' }) },
  goOffers () { wx.navigateTo({ url: '/pages/offers/offers' }) },
  toggleStats () { this.setData({ statsOpen: !this.data.statsOpen }) },
  onFilter (e) { this.setData({ st: e.currentTarget.dataset.k }); this.applyFilter() },
  open (e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) }
})
