const { api, evidenceView, aiNotice, judgeElig, ELIG_VIEW, dlCheck, classifyJobs, STATUS, APPLIED, EVENT_TYPES, isStale, deadlineChange, short, todayISO, cn, daysLeft, phase, badge, vExplain, verifyView, examView, eventTime, fullUrl, hasPopupAds, copyLink } = require('../../utils/util.js')
const { remindTmplId } = require('../../config.js')

const REPORT_TYPES = ['岗位已下架', '截止日期不对', '链接打不开', '公司信息有误', '其他']
// 同一类问题 2 位以上同学反馈才提醒别人，避免一个人误报
const reportText = counts => Object.keys(counts || {}).filter(k => counts[k] >= 2).map(k => `${counts[k]} 位同学反馈「${k}」`).join('，')
const labelOf = k => (STATUS.find(s => s.k === k) || {}).label || ''
const FAIL_STAGES = ['简历', '测评/笔试', '一面', '二面', '三面/终面', 'HR 面', '其他']
// 多条投递记录时，公司整体状态取走得最远的那条
const RANK = { offer: 6, interview: 5, test: 4, applied: 3, want: 2, rejected: 1, dropped: 0 }
const bestStatus = tracks => tracks.reduce((b, t) => (RANK[t.status] > RANK[b] ? t.status : b), tracks[0].status)

function host (u) { const m = /^https?:\/\/([^/?#]+)/i.exec(u || ''); return m ? m[1].replace(/^www\./, '') : u }

Page({
  data: { c: null, error: '', statuses: STATUS, status: '', appliedAt: '', note: '', saving: false, isOwner: false, webSearch: false, finding: false, findMsg: '',
    events: [], eventTypes: EVENT_TYPES, evTypeIdx: 0, evDate: '', evTime: '', evNote: '',
    canRemind: !!remindTmplId, reminded: {}, ex: null, examing: false, examMsg: '', siblings: [], dlChange: '',
    prepRole: '', prep: null, prepping: false, prepMsg: '',
    eduReq: '', eduText: '', eduUnknown: false, info: { intro: '', scale: '', welfare: [], srcFrom: '' }, introOpen: false, about: null, abouting: false, aboutMsg: '',
    jobs: [], jobGroups: [], jobsPreview: [], jobsOpen: false, jobsFull: true, jobsLoading: false,
    talks: [], tracks: [], reportTypes: REPORT_TYPES, rpType: '', rpNote: '', reportCounts: {}, reportText: '', logOpen: false, changeLog: [], eduPick: ['不限 / 没写', '大专', '本科', '硕士', '博士'],
    failStage: '', lesson: '', failStages: FAIL_STAGES, hideAfter: false, td: null, trackNames: ['不区分'], evTrackIdx: 0,
    referral: '', statusLabel: '', calOn: true, refEditing: false, refDraft: '', sheet: '', mats: [], matsLoaded: false,
    quickKeys: { want: 1, applied: 1, test: 1, interview: 1 },
    quick: [{ k: 'want', label: '想投' }, { k: 'applied', label: '已投递' }, { k: 'test', label: '笔试' }, { k: 'interview', label: '面试' }] },

  onLoad (o) { this.id = decodeURIComponent(o.id || ''); this.load() },
  goMatch () { wx.navigateTo({ url: '/pages/match/match?id=' + encodeURIComponent(this.id) + '&role=' + encodeURIComponent(this.data.prepRole || '') }) },

  async load () {
    try {
      const r = await api('get', { id: this.id })
      const c = r.company; const app = r.app || {}
      this.me = r.me || { edu: '本科', major: '' }
      const p = phase(c); const dl = daysLeft(c)
      const agg = c.agg || ''
      this.setData({
        c, evid: evidenceView(c), isOwner: r.isOwner, webSearch: !!r.webSearch, reportCounts: c.reportCounts || {}, reportText: reportText(c.reportCounts), changeLog: (c.changeLog || []).map(x => ({ at: cn((x.at || '').slice(0, 10)), what: x.what })), dl: Object.assign(dlCheck(c), { earliestText: dlCheck(c).earliest ? cn(dlCheck(c).earliest) : '' }),
        status: app.status || '', statusLabel: labelOf(app.status), tracks: this.viewTracks(app.tracks || []), failStage: app.failStage || '', lesson: app.lesson || '', appliedAt: app.appliedAt || '', note: app.note || '', referral: app.referral || '',
        events: this.viewEvents(app.events || []), ex: examView(c), dlChange: deadlineChange(c),
        prepRole: (c.note || '').split(/[、,，]/)[0] || '',
        showDeadlineRemind: !!c.deadline && p !== 'closed',
        openText: c.openDate ? cn(c.openDate) : (c.openText || '—'),
        deadlineText: c.deadline ? cn(c.deadline) : (c.deadlineText || '未公布'),
        phaseText: c.manualReview && c.manualReview.status === 'unconfirmed' ? '当前是否在招待确认' : c.manualReview && c.manualReview.status === 'expired' ? '官网复核已结束' : c.manualReview && c.manualReview.status === 'open' ? `${cn(String(c.manualReview.at || '').slice(0, 10))}核查时在招 · 具体岗位请核对原文` : p === 'closed' ? (c.deadlineText === '已下线' ? '已从汇总站下线' : isStale(c) ? '可能已结束（没写截止日期，且超过 60 天没有更新）' : '已截止') : p === 'soon' ? '即将开启' : (dl === null ? '进行中' : dl === 0 ? '进行中 · 今天截止' : `进行中 · 还剩 ${dl} 天`),
        publicPhase: c.publicSource && c.publicSource.fairDate ? (c.publicSource.fairDate < todayISO() ? '已结束，是否继续招聘请确认' : c.publicSource.fairDate === todayISO() ? '招聘会当天' : '尚未举行，岗位状态以原公告为准') : '未明确，需确认',
        badge: badge(c), vText: vExplain(c), vv: verifyView(c),
        srcText: c.source === 'curated' ? '整理的大厂名单' : c.source === 'manual' ? '你手动添加' : `自动收集自 ${(c.srcs || []).join('、') || '汇总站'}${c.updated ? ` · ${cn(c.updated)}更新` : ''}`,
        official: fullUrl(c.url), officialHost: host(fullUrl(c.url)),
        orig: c.origUrl && c.origUrl !== c.url ? c.origUrl : '', origHost: host(c.origUrl || ''), origLabel: c.origKind === 'wechat' ? '企业公众号原文' : '企业发布的原文',
        ncssUrl: (c.ncss && c.ncss.n && c.ncss.url) || '',
        // 已有官网或原文时不再给汇总站链接（牛企直聘页面有弹窗广告）；只有汇总站时才显示，并标出来
        agg: (c.url || c.origUrl) && hasPopupAds(fullUrl(agg)) ? '' : fullUrl(agg), aggHost: host(fullUrl(agg)), aggAds: hasPopupAds(fullUrl(agg)),
        searchWords: `${c.company} 2027届 校园招聘 官网`
      })
      this.savedNote = (app.note || '').trim()
      this.syncTrackNames()
      wx.setNavigationBarTitle({ title: c.company })
      this.showInfo({ intro: c.intro, scale: c.scale, welfare: c.welfare, srcFrom: c.srcFrom }, c.about)
      if (c.source !== 'manual' && !c.closed) this.loadJobs(c)
      if (c.source !== 'manual') this.loadTalks()
      if (remindTmplId) this.loadReminders()
      const g = c.group || (c.source !== 'manual' ? c.company : '')
      if (g) this.loadSiblings(g)
    } catch (e) {
      this.setData({ error: e.message })
    }
  },

  // 完整在招岗位：先用库里已有的，再去后端取一次完整列表
  async loadJobs (c) {
    const initial = Array.isArray(c.positions) && c.positions.length ? c.positions : String(c.note || '').replace(/…$/, '').split(/[、,，]/).map(x => x.trim()).filter(Boolean)
    this.showJobs(initial, !!c.positionsFull || !String(c.note || '').endsWith('…'))
    this.showEdu(c.minEdu, c.eduText, !!c.eduChecked)
    if (c.positionsFull && c.infoChecked) return
    this.setData({ jobsLoading: true })
    try {
      const r = await api('jobs', { id: this.id })
      this.showJobs(r.positions, r.full)
      this.showEdu(r.minEdu, r.eduText, !!r.eduChecked)
      if (r.info) this.showInfo(r.info)
    } catch (e) {}
    this.setData({ jobsLoading: false })
  },
  showJobs (list, full) {
    if (!list || !list.length) return
    this.setData({ jobs: list, jobGroups: classifyJobs(list), jobsPreview: list.slice(0, 6), jobsFull: full })
  },
  showEdu (level, text, checked) { this.setData({ eduReq: level || '', eduText: text || '', eduUnknown: checked && !level }) },
  showInfo (info, about) {
    const upd = { info: { intro: info.intro || '', scale: info.scale || '', welfare: info.welfare || [], srcFrom: info.srcFrom || '' } }
    if (about) upd.about = this.viewAbout(about)
    this.setData(upd)
  },
  viewAbout (a) {
    return Object.assign({}, a, { date: a.at ? cn(a.at.slice(0, 10)) : '', refHosts: (a.refs || []).map(url => ({ url, host: host(url) })) })
  },
  toggleIntro () { this.setData({ introOpen: !this.data.introOpen }) },
  async aboutCompany () {
    if (this.data.abouting) return
    this.setData({ abouting: true, aboutMsg: '' })
    try {
      const a = await api('aboutCompany', { id: this.id })
      this.setData({ about: this.viewAbout(a) })
    } catch (e) { this.setData({ aboutMsg: e.message }) }
    this.setData({ abouting: false })
  },
  toggleJobs () { this.setData({ jobsOpen: !this.data.jobsOpen }) },

  async findOfficial () {
    if (this.data.finding) return
    this.setData({ finding: true, findMsg: '' })
    try {
      const r = await api('findOfficial', { id: this.id })
      if (r.url) {
        const c = Object.assign({}, this.data.c, { url: r.url, v: 'official', linkBy: r.existing ? this.data.c.linkBy : 'ai' })
        this.setData({ c, official: r.url, officialHost: host(r.url), badge: badge(c), vText: vExplain(c),
          findMsg: r.note ? `依据：${r.note}` : '' })
        getApp().globalData.listDirty = true
        wx.showToast({ title: '找到官方链接了', icon: 'none' })
      } else {
        this.setData({ findMsg: `${r.reason}（今天已用 ${r.used}/${r.limit} 次）` })
      }
    } catch (e) {
      this.setData({ findMsg: e.message })
    }
    this.setData({ finding: false })
  },

  // ---------- AI 面试准备
  onPrepRole (e) { this.setData({ prepRole: e.detail.value }) },
  async makePrep () {
    if (this.data.prepping) return
    this.setData({ prepping: true, prepMsg: '' })
    try {
      const prep = await api('interviewPrep', { id: this.id, role: this.data.prepRole.trim() })
      const groups = ['专业', '项目', '综合'].map(cat => ({ cat, items: prep.questions.filter(q => q.cat === cat) })).filter(g => g.items.length)
      this.setData({ prep: Object.assign({}, prep, { groups }) })
    } catch (e) { this.setData({ prepMsg: e.message }) }
    this.setData({ prepping: false })
  },
  copyPrep () {
    const p = this.data.prep
    const text = [`${this.data.c.company} 面试准备`, p.flow && `流程：${p.flow}`, p.focus.length && `重点：${p.focus.join('、')}`,
      ...p.groups.map(g => `【${g.cat}】\n` + g.items.map((q, i) => `${i + 1}. ${q.q}\n   思路：${q.tip}`).join('\n'))].filter(Boolean).join('\n\n')
    wx.setClipboardData({ data: text })
  },
  goMaterials () {
    const c = this.data.c
    wx.navigateTo({ url: `/pages/materials/materials?cid=${encodeURIComponent(this.id)}&company=${encodeURIComponent(c.company)}&role=${encodeURIComponent(this.data.prepRole || '')}` })
  },

  // ---------- 同集团在招
  async loadSiblings (group) {
    try {
      const { items } = await api('siblings', { group, id: this.id })
      this.setData({ siblings: items.map(x => ({ id: x._id, company: x.company, when: x.deadline ? `截止 ${short(x.deadline)}` : (x.deadlineText || ''), cities: x.cities || '' })), groupName: group })
    } catch (e) {}
  },
  openSibling (e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },

  // ---------- 分享给同学（对方需要是体验成员才能打开）
  onShareAppMessage () {
    const c = this.data.c || {}
    return { title: `${c.company || '这家公司'} 2027届校招 · ${this.data.deadlineText ? '截止 ' + this.data.deadlineText : ''}`, path: `/pages/detail/detail?id=${encodeURIComponent(this.id)}` }
  },

  // ---------- 笔试情况
  async findExam () {
    if (this.data.examing) return
    this.setData({ examing: true, examMsg: '' })
    try {
      const exam = await api('findExam', { id: this.id })
      this.setData({ ex: examView({ exam }) })
    } catch (e) {
      this.setData({ examMsg: e.message })
    }
    this.setData({ examing: false })
  },

  // ---------- 日程（笔试 / 面试）
  viewEvents (list) {
    const today = todayISO()
    return list.map(e => Object.assign({}, e, { label: eventTime(e.at), past: e.at.slice(0, 10) < today }))
  },
  rawEvents () { return this.data.events.map(e => ({ type: e.type, at: e.at, note: e.note, track: e.track || '' })) },
  onEvType (e) { this.setData({ evTypeIdx: +e.detail.value }) },
  onEvDate (e) { this.setData({ evDate: e.detail.value }) },
  onEvTime (e) { this.setData({ evTime: e.detail.value }) },
  onEvNote (e) { this.setData({ evNote: e.detail.value }) },
  async addEvent () {
    const d = this.data
    if (!d.evDate) { wx.showToast({ title: '先选日期', icon: 'none' }); return false }
    const ev = { type: EVENT_TYPES[d.evTypeIdx], at: d.evDate + (d.evTime ? ' ' + d.evTime : ''), note: d.evNote.trim(), track: d.evTrackIdx ? d.trackNames[d.evTrackIdx] : '' }
    const list = this.rawEvents().concat(ev).sort((a, b) => a.at.localeCompare(b.at))
    this.setData({ events: this.viewEvents(list), evDate: '', evTime: '', evNote: '' })
    await this.save(true)
    this.afterAdd(ev)
    return true
  },
  afterAdd (ev) {
    if (remindTmplId && ev.at.slice(0, 10) >= todayISO()) {
      wx.showModal({ title: '要提醒你吗？', content: `${ev.type}前一天早上用微信消息提醒你`, confirmText: '提醒我',
        success: r => { if (r.confirm) this.subscribe({ kind: 'event', title: ev.type, when: ev.at }) } })
    }
  },
  removeEvent (e) {
    const i = e.currentTarget.dataset.i
    wx.showModal({ title: '删除这条日程？', confirmText: '删除', confirmColor: '#C62F2A', success: r => {
      if (!r.confirm) return
      const list = this.rawEvents(); list.splice(i, 1)
      this.setData({ events: this.viewEvents(list) })
      this.save(true)
    } })
  },

  // ---------- 订阅消息提醒
  async loadReminders () {
    try {
      const { items } = await api('myReminders')
      const reminded = {}
      items.filter(x => x.cid === this.id).forEach(x => { reminded[x.kind === 'deadline' ? 'deadline' : x.when] = true })
      this.setData({ reminded })
    } catch (e) {}
  },
  remindDeadline () { this.subscribe({ kind: 'deadline', title: '网申截止', when: this.data.c.deadline }) },
  remindEvent (e) {
    const ev = this.data.events[e.currentTarget.dataset.i]
    this.subscribe({ kind: 'event', title: ev.type, when: ev.at })
  },
  // 必须在点击回调里直接调用 requestSubscribeMessage
  subscribe (r) {
    wx.requestSubscribeMessage({
      tmplIds: [remindTmplId],
      success: async res => {
        if (res[remindTmplId] !== 'accept') { wx.showToast({ title: '没有开启提醒', icon: 'none' }); return }
        try {
          const out = await api('addReminder', { id: this.id, kind: r.kind, title: r.title, when: r.when, company: this.data.c.company })
          this.setData({ [`reminded.${r.kind === 'deadline' ? 'deadline' : r.when}`]: true })
          wx.showToast({ title: `会在 ${cn(out.sendOn)} 提醒你`, icon: 'none' })
        } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
      },
      fail: () => wx.showToast({ title: '没有开启提醒', icon: 'none' })
    })
  },

  copy (e) {
    const { url, kind } = e.currentTarget.dataset
    copyLink(url, kind === 'words' ? '已复制，去浏览器搜索' : '已复制，去浏览器打开')
  },

  pick (e) {
    const k = e.currentTarget.dataset.k
    const upd = { status: k, statusLabel: labelOf(k) }
    if (APPLIED.includes(k) && !this.data.appliedAt) upd.appliedAt = todayISO()
    this.setData(upd)
  },
  onDate (e) { this.setData({ appliedAt: e.detail.value }); this.save('投递日期已保存') },
  onNote (e) { this.setData({ note: e.detail.value }) },
  saveNote () {
    if (this.data.note.trim() === (this.savedNote || '')) return
    this.save('备注已保存')
  },

  async save (quiet) {
    this.setData({ saving: true })
    try {
      await api('saveApp', { id: this.id, status: this.data.status, note: this.data.note.trim(), appliedAt: this.data.appliedAt, events: this.rawEvents(), referral: this.data.referral,
        tracks: this.rawTracks(), failStage: this.data.failStage, lesson: this.data.lesson.trim(), company: this.data.c.company })
      getApp().globalData.listDirty = true
      this.savedNote = this.data.note.trim()
      wx.showToast({ title: typeof quiet === 'string' ? quiet : quiet === true ? '日程已保存' : '进度已保存', icon: typeof quiet === 'string' ? 'none' : 'success' })
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' })
    }
    this.setData({ saving: false })
  },

  // ---------- 吸底状态栏：点一下就保存；改成笔试 / 面试时顺手记下时间
  async quickPick (e) {
    let k = e.currentTarget.dataset.k
    // 再点一下当前的状态就取消（备注、日程、岗位卡都保留）
    const cancel = k && k === this.data.status
    if (cancel) k = ''
    else if (k === this.data.status) return
    const label = labelOf(k) || '未标记'
    this.pick({ currentTarget: { dataset: { k } } })
    await this.save(cancel ? `已取消「${labelOf(e.currentTarget.dataset.k)}」` : k ? `已标为「${label}」` : '已取消标记')
    if (cancel) return
    if (k === 'rejected' || k === 'dropped') { this.setData({ sheet: 'fail', hideAfter: false }); return }
    if (k === 'test' || k === 'interview') {
      this.setData({ sheet: 'event', evTypeIdx: EVENT_TYPES.indexOf(k === 'test' ? '笔试' : '一面'), evDate: '', evTime: '', evNote: '' })
    }
  },
  moreStatus () {
    const opts = STATUS.filter(s => !this.data.quick.some(q => q.k === s.k)).concat({ k: '', label: '取消标记' })
    wx.showActionSheet({
      itemList: opts.map(o => (o.k === this.data.status ? '✓ ' : '') + o.label),
      success: r => this.quickPick({ currentTarget: { dataset: { k: opts[r.tapIndex].k } } })
    })
  },
  closeSheet () { this.setData({ sheet: '' }) },
  // ---------- 挂了 / 放弃之后：记一下挂在哪一步、一句话复盘，可以顺手在列表里隐藏
  openFail () { this.setData({ sheet: 'fail', hideAfter: false }) },
  pickStage (e) { const v = e.currentTarget.dataset.v; this.setData({ failStage: this.data.failStage === v ? '' : v }) },
  onLesson (e) { this.setData({ lesson: e.detail.value }) },
  toggleHideAfter () { this.setData({ hideAfter: !this.data.hideAfter }) },
  async saveFail () {
    this.closeSheet()
    await this.save('已记下复盘')
    if (this.data.hideAfter) {
      try { await api('hide', { id: this.id }); getApp().globalData.listDirty = true; wx.showToast({ title: '已记下，并在列表里隐藏这家', icon: 'none' }) } catch (e) {}
    }
  },

  // ---------- 岗位卡：每个岗位单独记要求、截止、链接、资格判断、投的简历版本
  viewTracks (list) {
    return list.map(t => Object.assign({}, t, {
      statusLabel: labelOf(t.status), ev: ELIG_VIEW[(t.elig && t.elig.state) || 'unknown'],
      meta: [t.batch, t.city, t.edu ? t.edu + '及以上' : '', t.deadline ? short(t.deadline) + ' 截止' : ''].filter(Boolean).join(' · '),
      // 证据：最后核对时间、依据什么、哪些要求还不知道
      evid: `${t.checkedAt ? short(t.checkedAt) + ' 核对' : '未核对'} · 依据：${t.src || (t.level === 'job' ? '岗位 JD' : '公司级信息')}`,
      unknown: [!t.city && '城市', !t.edu && '学历要求', !t.major && '专业要求', !t.deadline && '截止日期', !t.url && '职位链接'].filter(Boolean).join('、')
    }))
  },
  rawTracks () {
    return this.data.tracks.map(t => ({ id: t.id, name: t.name, dept: t.dept || '', batch: t.batch || '', city: t.city || '', edu: t.edu || '', major: t.major || '',
      deadline: t.deadline || '', url: t.url || '', level: t.level || 'company', status: t.status, appliedAt: t.appliedAt || '', failStage: t.failStage || '',
      resume: t.resume || '', note: t.note || '', elig: t.elig || { state: 'unknown' }, checkedAt: t.checkedAt || '', src: t.src || '' }))
  },
  syncTrackNames () { this.setData({ trackNames: ['不区分'].concat(this.data.tracks.map(t => t.name)) }) },
  // 公司级信息做底：截止、城市、学历来自公司公告，资格按学历判断（专业未知）
  companyCard (name) {
    const c = this.data.c
    return { idx: -1, id: '', name: name || '', dept: '', batch: '', city: c.cities || '', edu: c.minEdu || '', major: '', deadline: c.deadline || '', url: '',
      level: 'company', statusIdx: 0, appliedAt: '', failStage: '', resume: '', note: '', jd: '', parsing: false, parseMsg: '',
      elig: judgeElig(this.me, c.minEdu || '', this.data.eduText || '', 'unknown', '') }
  },
  addTrack () { this.setData({ sheet: 'track', td: this.companyCard('') }) },
  addTrackFromJob (e) { this.setData({ sheet: 'track', td: this.companyCard(e.currentTarget.dataset.job) }) },
  editTrack (e) {
    const i = e.currentTarget.dataset.i; const t = this.rawTracks()[i]
    this.setData({ sheet: 'track', td: Object.assign({}, t, { idx: i, statusIdx: Math.max(0, STATUS.findIndex(s => s.k === t.status)), jd: '', parsing: false, parseMsg: '' }) })
  },
  onTd (e) { this.setData({ [`td.${e.currentTarget.dataset.f}`]: e.detail.value }) },
  onTdStatus (e) { this.setData({ 'td.statusIdx': +e.detail.value }) },
  onTdDate (e) { this.setData({ [`td.${e.currentTarget.dataset.f}`]: e.detail.value }) },
  onTdEdu (e) {
    const edu = ['', '大专', '本科', '硕士', '博士'][+e.detail.value]
    this.setData({ 'td.edu': edu, 'td.elig': judgeElig(this.me, edu, '', 'unknown', '') })
  },
  pickTdStage (e) { const v = e.currentTarget.dataset.v; this.setData({ 'td.failStage': this.data.td.failStage === v ? '' : v }) },
  // 粘贴这个岗位的 JD（文字或链接），AI 识别出岗位自己的要求，并对照你的学历、专业给出资格判断
  async parseJd () {
    const td = this.data.td
    if (!td.jd.trim() || td.parsing) return
    if (!(await aiNotice())) return
    this.setData({ 'td.parsing': true, 'td.parseMsg': '' })
    try {
      const j = await api('parseJob', { text: td.jd.trim() })
      this.setData({ td: Object.assign({}, td, j, { name: j.name || td.name, jd: '', parsing: false, parseMsg: '已按 JD 填好，核对一下再保存', level: 'job' }) })
    } catch (e) { this.setData({ 'td.parsing': false, 'td.parseMsg': e.message }) }
  },
  async saveTrack () {
    const td = this.data.td
    if (!td.name.trim()) { wx.showToast({ title: '填一下岗位名称', icon: 'none' }); return }
    const list = this.rawTracks()
    const k = STATUS[td.statusIdx].k
    const t = { id: td.id, name: td.name.trim(), dept: td.dept, batch: td.batch, city: td.city, edu: td.edu, major: td.major, deadline: td.deadline, url: td.url,
      level: td.level, status: k, appliedAt: td.appliedAt || (['applied', 'test', 'interview', 'offer'].includes(k) ? todayISO() : ''),
      failStage: k === 'rejected' ? td.failStage : '', resume: td.resume, note: td.note, elig: td.elig,
      checkedAt: td.checkedAt || todayISO(), src: td.src || (td.level === 'job' ? '岗位 JD' : '公司级信息') }
    if (td.idx >= 0) list[td.idx] = t; else list.push(t)
    await this.applyTracks(list, '岗位卡已保存')
  },
  async removeTrack () {
    const list = this.rawTracks(); list.splice(this.data.td.idx, 1)
    await this.applyTracks(list, '已删除这张岗位卡')
  },
  async applyTracks (list, msg) {
    const upd = { tracks: this.viewTracks(list), sheet: '' }
    if (list.length) {
      // 公司状态取岗位卡里走得最远的；卡片都只是「想投」时，不把公司已有的状态往回拉
      const best = bestStatus(list)
      upd.status = best === 'want' && this.data.status && this.data.status !== 'want' ? this.data.status : best
      upd.statusLabel = labelOf(upd.status)
      const dates = list.map(t => t.appliedAt).filter(Boolean).sort()
      if (!this.data.appliedAt && dates.length) upd.appliedAt = dates[0]
    }
    this.setData(upd)
    this.syncTrackNames()
    await this.save(msg)
  },
  copyTrackUrl (e) { wx.setClipboardData({ data: e.currentTarget.dataset.url, success: () => wx.showToast({ title: '已复制岗位链接', icon: 'none' }) }) },

  // ---------- 信息有误反馈
  openReport () { this.setData({ sheet: 'report', rpType: '', rpNote: '' }) },
  pickRp (e) { this.setData({ rpType: e.currentTarget.dataset.v }) },
  onRpNote (e) { this.setData({ rpNote: e.detail.value }) },
  async sendReport () {
    if (!this.data.rpType) { wx.showToast({ title: '选一下是哪类问题', icon: 'none' }); return }
    try {
      const r = await api('reportIssue', { id: this.id, type: this.data.rpType, note: this.data.rpNote.trim() })
      this.setData({ sheet: '', reportCounts: r.counts, reportText: reportText(r.counts) })
      wx.showToast({ title: '谢谢反馈，后台会重新核对', icon: 'none' })
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
  },
  // ---------- 这家公司接下来的宣讲会
  async loadTalks () {
    try {
      const { items } = await api('talksFor', { id: this.id })
      this.setData({ talks: items.slice(0, 8).map(t => Object.assign({}, t, { when: `${short(t.date)} ${t.time || ''}`.trim(), place: [t.city, t.school, t.venue].filter(Boolean).join(' · ') })) })
    } catch (e) {}
  },
  async addTalk (e) {
    const t = this.data.talks[e.currentTarget.dataset.i]
    const at = t.date + (/^\d{2}:\d{2}/.test(t.time) ? ' ' + t.time.slice(0, 5) : '')
    const list = this.rawEvents().concat({ type: '宣讲会', at, note: [t.school, t.venue].filter(Boolean).join(' ').slice(0, 30) }).sort((a, b) => a.at.localeCompare(b.at))
    this.setData({ events: this.viewEvents(list) })
    if (!this.data.status) this.setData({ status: 'want', statusLabel: labelOf('want') })
    await this.save('已加到日程')
  },
  copyEvid (e) { copyLink(e.currentTarget.dataset.url, '已复制原始页面链接') },
  copyTalk (e) { copyLink(e.currentTarget.dataset.url, '已复制，去浏览器看详情和报名方式') },

  toggleLog () { this.setData({ logOpen: !this.data.logOpen }) },

  onEvTrack (e) { this.setData({ evTrackIdx: +e.detail.value }) },

  toggleCal () { this.setData({ calOn: !this.data.calOn }) },
  async addEventFromSheet () {
    const d = this.data
    if (d.evDate && d.calOn) this.toCalendar({ type: EVENT_TYPES[d.evTypeIdx], at: d.evDate + (d.evTime ? ' ' + d.evTime : ''), note: d.evNote.trim() })
    if (await this.addEvent()) this.closeSheet()
  },
  calEvent (e) { this.toCalendar(this.data.events[e.currentTarget.dataset.i]) },
  // 写进手机系统日历：有具体时间的提前 15 分钟提醒，只有日期的按全天事件
  toCalendar (ev) {
    if (!wx.addPhoneCalendar) { wx.showToast({ title: '微信版本太旧，不支持加日历', icon: 'none' }); return }
    const time = ev.at.slice(11, 16)
    const start = new Date(`${ev.at.slice(0, 10)}T${time || '09:00'}:00+08:00`).getTime() / 1000
    wx.addPhoneCalendar({
      title: `${this.data.c.company} ${ev.type}`,
      startTime: start, endTime: start + (time ? 3600 : 0), allDay: !time,
      description: [ev.note, '来自秋招雷达'].filter(Boolean).join(' · '),
      alarm: true, alarmOffset: time ? 900 : 0,
      success: () => wx.showToast({ title: '已加到手机日历', icon: 'none' }),
      fail: err => { if (!/cancel/.test(err.errMsg || '')) wx.showToast({ title: '没能加到日历，请检查微信的日历权限', icon: 'none' }) }
    })
  },
  copyAllMats () {
    const text = this.data.mats.map(m => `【${m.title}】\n${m.content}`).join('\n\n')
    wx.setClipboardData({ data: text, success: () => wx.showToast({ title: `已复制 ${this.data.mats.length} 条材料`, icon: 'none' }) })
  },

  // ---------- 网申材料浮层：填网申时随手复制
  async openMats () {
    this.setData({ sheet: 'mat' })
    if (this.data.matsLoaded) return
    try {
      const { materials } = await api('getMaterials')
      this.setData({ mats: materials, matsLoaded: true })
    } catch (err) { this.setData({ matsLoaded: true }); wx.showToast({ title: err.message, icon: 'none' }) }
  },
  copyMat (e) {
    const m = this.data.mats[e.currentTarget.dataset.i]
    wx.setClipboardData({ data: m.content, success: () => wx.showToast({ title: `已复制「${m.title}」`, icon: 'none' }) })
  },

  // ---------- 自己的内推码 / 内推链接
  editRef () { this.setData({ refEditing: true, refDraft: this.data.referral }) },
  onRefDraft (e) { this.setData({ refDraft: e.detail.value }) },
  cancelRef () { this.setData({ refEditing: false }) },
  async saveRef () {
    this.setData({ referral: this.data.refDraft.trim(), refEditing: false })
    await this.save(this.data.referral ? '内推码已保存' : '已删除内推码')
  },

  edit () { wx.navigateTo({ url: `/pages/edit/edit?id=${encodeURIComponent(this.id)}` }) },

  remove () {
    wx.showModal({
      title: '删除这家公司？', content: '删除后你的投递进度也不会再显示在列表里。', confirmText: '删除', confirmColor: '#C62F2A',
      success: async r => {
        if (!r.confirm) return
        try { await api('deleteJob', { id: this.id }); getApp().globalData.listDirty = true; wx.showToast({ title: '已删除' }); setTimeout(() => wx.navigateBack(), 600) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
      }
    })
  },

  hide () {
    wx.showModal({
      title: '不再显示这家？', content: '只对你自己隐藏，不影响其他人。', confirmText: '隐藏',
      success: async r => {
        if (!r.confirm) return
        try { await api('hide', { id: this.id }); getApp().globalData.listDirty = true; wx.showToast({ title: '已隐藏' }); setTimeout(() => wx.navigateBack(), 600) } catch (e) { wx.showToast({ title: e.message, icon: 'none' }) }
      }
    })
  }
})
