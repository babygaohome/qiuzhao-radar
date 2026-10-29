const { api, decorate, verifyView, dlCheck, short, INDUSTRIES, CTYPES } = require('../../utils/util.js')

const EDUS = ['本科', '硕士', '博士', '大专']
const IND_CHOICES = INDUSTRIES.filter(i => i !== '其他')
// 快捷标签按方向分组，默认展示跨行业选项；手动输入仍可填写任意专业/岗位。
const MAJOR_GROUPS = [
  { k: 'popular', t: '跨行业', items: ['会计学', '法学', '汉语言文学', '市场营销', '机械工程', '护理学', '计算机科学与技术'] },
  { k: 'engineering', t: '工科', items: ['机械工程', '电气工程', '自动化', '土木工程', '化学工程与工艺', '材料科学与工程', '车辆工程', '能源与动力工程'] },
  { k: 'business', t: '经管财会', items: ['会计学', '财务管理', '审计学', '税收学', '金融学', '经济学', '市场营销', '工商管理', '物流管理', '人力资源管理'] },
  { k: 'medical', t: '医药', items: ['临床医学', '护理学', '药学', '医学检验技术', '生物工程', '食品科学与工程'] },
  { k: 'humanities', t: '文法教育', items: ['法学', '知识产权', '汉语言文学', '英语', '翻译', '新闻学', '教育学', '社会工作', '公共事业管理', '视觉传达设计'] },
  { k: 'tech', t: '计算机通信', items: ['计算机科学与技术', '软件工程', '电子信息工程', '通信工程', '数据科学与大数据技术', '网络工程'] }
]
const ROLE_GROUPS = [
  { k: 'popular', t: '跨行业', items: ['管培生', '会计', '法务', '行政', '运营', '机械工程师', '教师', '护理', '软件开发'] },
  { k: 'engineering', t: '制造工程', items: ['机械工程师', '电气工程师', '工艺工程师', '质量工程师', '设备工程师', '生产管理', '土木工程师'] },
  { k: 'energy', t: '能源化工', items: ['电力工程师', '新能源工程师', '化工工艺', '安全环保', '储能工程师', '材料研发'] },
  { k: 'finance', t: '金融财会', items: ['会计', '财务', '审计', '税务', '出纳', '风控', '客户经理', '银行柜员', '精算'] },
  { k: 'legal', t: '法律合规', items: ['法务', '合规', '法律事务', '律师助理', '知识产权', '合同管理', '风控'] },
  { k: 'commerce', t: '商贸运营', items: ['运营', '市场营销', '销售', '采购', '供应链', '人力资源', '客服'] },
  { k: 'admin', t: '行政人力', items: ['行政', '人力资源', '招聘', '员工关系', '培训', '文秘', '档案管理', '项目助理'] },
  { k: 'medical', t: '医药医疗', items: ['临床研究', '药物研发', '医药代表', '护理', '医学检验', '医疗器械'] },
  { k: 'humanities', t: '教育传媒', items: ['教师', '教研', '编辑', '记者', '新媒体运营', '文案策划', '翻译', '平面设计'] },
  { k: 'tech', t: '互联网技术', items: ['后端开发', '前端开发', '算法工程师', '测试开发', '数据分析', '产品经理', '硬件工程师', '软件开发'] }
]
const QUICK = {
  city: ['北京', '上海', '深圳', '杭州', '广州', '成都', '南京', '武汉', '苏州', '西安']
}
const splitSel = v => String(v || '').split(/[\s,，、]+/).filter(Boolean)
const PAGE = 30 // 每次多显示这么多家
const VERIFY_TOP = 5 // 排名前几家自动联网核实（联网搜索有每日免费额度）
const FILTERS = [{ k: 'all', t: '全部' }, { k: 'direct', t: '岗位直接匹配' }, { k: 'hi', t: '75 分以上' }, { k: 'ai', t: 'AI 重点推荐' }]
const SORTS = [{ k: 'score', t: '按匹配分' }, { k: 'dl', t: '按截止时间' }]

// 综合分：AI 精评过的按 AI 60% + 规则 40%，没评过的只看规则分
function finalScore (e) { return e.ai ? Math.round(e.ai.score * 0.6 + e.s * 0.4) : e.s }
// 先按分档（岗位直接匹配 > 相关岗位 > 只是行业相关），档内确认收大专的优先，再按综合分
// 分档 → 岗位有公告原文 → 确认收大专 → 综合分
const byRank = (a, b) => (b.tier || 0) - (a.tier || 0) || (b.evid || 0) - (a.evid || 0) || (b.eduOk || 0) - (a.eduOk || 0) || finalScore(b) - finalScore(a)

// 每家公司的依据一行：截止（各来源有出入时写最早）、学历要求出处、最后核对时间
function evLine (c) {
  const parts = []
  if (c.deadline) { const d = dlCheck(c); parts.push(`截止 ${short(c.deadline)}${d.earliest ? '（最早 ' + short(d.earliest) + '）' : ''}`) }
  parts.push(c.minEdu ? `学历 ${c.minEdu}及以上（公告）` : '学历要求未写')
  const t = c.dlChecked || c.infoChecked
  parts.push(t ? `${short(new Date(t + 8 * 3600e3).toISOString().slice(0, 10))} 核对公告` : '未核对原公告')
  return parts.join(' · ')
}

// 旧版结果只有十几家 picks，转成新格式
function fromOld (ai) {
  return Object.assign({}, ai, {
    v: 2, batches: 0, matched: ai.pool,
    ranked: (ai.picks || []).map(pk => ({ id: pk.id, company: pk.company, s: pk.fit === '高' ? 85 : 70, tags: [], dl: '', ai: { score: pk.fit === '高' ? 85 : 70, fit: pk.fit, reason: pk.reason, tip: pk.tip } }))
  })
}

Page({
  data: {
    edus: EDUS, eduIdx: 0,
    p: { major: '', role: '', city: '', hobby: '', more: '' },
    industries: IND_CHOICES.map(name => ({ name, on: false })),
    ctypes: CTYPES.map(name => ({ name, on: false })),
    busy: false, status: '', result: null, resultTime: '', aiReady: true, webSearch: false, loaded: false, conditionsOpen: false,
    filters: FILTERS, filter: 'all', sorts: SORTS, sort: 'score',
    items: [], count: 0, more: false, loadingMore: false,
    reviewDone: 0, reviewTotal: 0, reviewing: false, verifying: 0, showRule: false,
    majorGroups: MAJOR_GROUPS.map(x => ({ k: x.k, t: x.t })), majorGroupIdx: 0,
    roleGroups: ROLE_GROUPS.map(x => ({ k: x.k, t: x.t })), roleGroupIdx: 0,
    quick: { major: [], role: [], city: [] }, selectedRoleText: '', withSingle: false,
    plans: [], curPlan: '', fresh: {}, freshOpen: false
  },

  async onLoad () {
    this.all = []; this.details = {}; this.apps = {}; this.vv = {}; this.shown = PAGE
    try {
      const r = await api('getProfile')
      const p = r.profile
      this.setData({ aiReady: r.aiReady, webSearch: !!r.webSearch, loaded: true })
      this.applyProfile(p)
      this.loadPlans()
      if (r.ai) {
        await this.showResult(r.ai.v === 2 ? r.ai : fromOld(r.ai))
        this.reviewAll(true)
      }
    } catch (e) {
      this.setData({ status: e.message, loaded: true })
    }
  },

  // 把一组求职条件填回表单
  applyProfile (p) {
    p = p || {}
    this.setData({
      eduIdx: Math.max(0, EDUS.indexOf(p.edu)),
      p: { major: p.major || '', role: p.role || '', city: p.city || '', hobby: p.hobby || '', more: p.more || '' },
      industries: IND_CHOICES.map(name => ({ name, on: (p.industries || []).includes(name) })),
      ctypes: CTYPES.map(name => ({ name, on: (p.ctypes || []).includes(name) }))
    })
    this.syncQuick()
  },

  // ---------- 多组求职方案：比如「北京交付」「杭州运营」，各自保存条件和挑选结果
  async loadPlans () {
    try {
      const r = await api('getPlans')
      this.setData({ plans: r.plans, curPlan: r.curPlan })
      const f = await api('planFresh')
      this.setData({ fresh: f.fresh })
    } catch (e) {}
  },
  async applyPlan (r) {
    this.setData({ plans: r.plans, curPlan: r.curPlan, freshOpen: false, status: '' })
    this.applyProfile(r.profile)
    this.all = []; this.vv = {}
    if (r.ai) { await this.showResult(r.ai.v === 2 ? r.ai : fromOld(r.ai)); this.reviewAll(true) } else this.setData({ result: null, items: [] })
  },
  async switchPlan (e) {
    const id = e.currentTarget.dataset.id
    if (id === this.data.curPlan || this.data.busy) return
    try { await this.applyPlan(await api('switchPlan', { id })) } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
  },
  newPlan () {
    wx.showModal({
      title: '新建求职方案', editable: true, placeholderText: '起个名字，如 北京交付、杭州运营',
      success: async m => {
        if (!m.confirm) return
        try {
          await this.applyPlan(await api('createPlan', { name: (m.content || '').trim() }))
          wx.showToast({ title: '改好条件后点「开始匹配」', icon: 'none' })
          this.loadPlans()
        } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
      }
    })
  },
  planMenu (e) {
    const id = e.currentTarget.dataset.id
    const pl = this.data.plans.find(x => x.id === id)
    wx.showActionSheet({ itemList: ['重命名', '删除这个方案'], success: r => {
      if (r.tapIndex === 0) {
        wx.showModal({ title: '重命名', editable: true, placeholderText: pl.name, success: async m => {
          if (!m.confirm || !(m.content || '').trim()) return
          const out = await api('renamePlan', { id, name: m.content.trim() }).catch(err => { wx.showToast({ title: err.message, icon: 'none' }) })
          if (out) this.setData({ plans: out.plans })
        } })
      } else {
        wx.showModal({ title: `删除「${pl.name}」？`, content: '这个方案的条件和挑选结果会一起删掉。', confirmText: '删除', confirmColor: '#E5484D', success: async m => {
          if (!m.confirm) return
          try { await this.applyPlan(await api('deletePlan', { id })) } catch (err) { wx.showToast({ title: err.message, icon: 'none' }) }
        } })
      }
    } })
  },
  toggleFresh () { this.setData({ freshOpen: !this.data.freshOpen }) },
  openFresh (e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) },

  onShow () { if (this.data.result) this.refreshStatuses() },
  onReachBottom () { this.showMore() },

  onEdu (e) { this.setData({ eduIdx: +e.detail.value }) },
  tapEdu (e) { this.setData({ eduIdx: +e.currentTarget.dataset.i }) },
  onText (e) { this.setData({ [`p.${e.currentTarget.dataset.f}`]: e.detail.value }); this.syncQuick() },
  // 专业只能选一个，点了就替换；岗位和城市可以多选，再点一次取消
  tapQuick (e) {
    const { f, v } = e.currentTarget.dataset
    let val
    if (f === 'major') val = this.data.p.major === v ? '' : v
    else {
      const cur = splitSel(this.data.p[f])
      val = (cur.includes(v) ? cur.filter(x => x !== v) : cur.concat(v)).join(' ')
    }
    this.setData({ [`p.${f}`]: val })
    this.syncQuick()
  },
  onQuickGroup (e) {
    const { f, i } = e.currentTarget.dataset
    const groups = f === 'major' ? MAJOR_GROUPS : f === 'role' ? ROLE_GROUPS : []
    if (!groups[Number(i)]) return
    this.setData({ [f + 'GroupIdx']: Number(i) })
    this.syncQuick()
  },
  syncQuick () {
    const p = this.data.p
    const roles = splitSel(p.role)
    const groupMajor = MAJOR_GROUPS[this.data.majorGroupIdx] || MAJOR_GROUPS[0]
    const groupRole = ROLE_GROUPS[this.data.roleGroupIdx] || ROLE_GROUPS[0]
    this.setData({
      quick: {
        major: groupMajor.items.map(v => ({ v, on: p.major === v })),
        role: groupRole.items.map(v => ({ v, on: roles.includes(v) })),
        city: QUICK.city.map(v => ({ v, on: splitSel(p.city).includes(v) }))
      },
      selectedRoleText: roles.join('、')
    })
  },
  toggleInd (e) { const i = e.currentTarget.dataset.i; this.setData({ [`industries[${i}].on`]: !this.data.industries[i].on }) },
  toggleCtype (e) { const i = e.currentTarget.dataset.i; this.setData({ [`ctypes[${i}].on`]: !this.data.ctypes[i].on }) },
  toggleSingle () { this.setData({ withSingle: !this.data.withSingle }) },
  toggleRule () { this.setData({ showRule: !this.data.showRule }) },
  toggleConditions () { this.setData({ conditionsOpen: !this.data.conditionsOpen }) },
  goEvidence (e) { wx.navigateTo({ url: '/pages/match/match?id=' + encodeURIComponent(e.currentTarget.dataset.id) + '&role=' + encodeURIComponent(e.currentTarget.dataset.role || '') }) },

  profile () {
    const d = this.data
    return {
      edu: EDUS[d.eduIdx], major: d.p.major.trim(), role: d.p.role.trim(), city: d.p.city.trim(), hobby: d.p.hobby.trim(), more: d.p.more.trim(),
      industries: d.industries.filter(x => x.on).map(x => x.name),
      ctypes: d.ctypes.filter(x => x.on).map(x => x.name)
    }
  },

  async run () {
    const p = this.profile()
    if (!p.role && !p.major && !p.industries.length) { this.setData({ status: '至少填一下专业或想做的岗位方向。' }); return }
    this.setData({ busy: true, status: '第 1 步：理解你的方向…' })
    try {
      let extra = { keywords: [], industries: [] }
      try {
        extra = await api('aiKeywords', { profile: p })
      } catch (e) {
        if (e.code === 'no_ai_config' || e.code === 'ai_auth') throw e // 关键词扩展失败不致命，其他错误照常往下走
      }
      this.setData({ status: '第 2 步：给所有在招公司打分排序，并核对靠前公司的学历要求，约 15 秒…' })
      const ai = await api('aiPick', { profile: p, keywords: extra.keywords, industries: extra.industries, withSingle: this.data.withSingle })
      this.vv = {}
      await this.showResult(ai)
      this.setData({ status: '' })
      wx.pageScrollTo({ selector: '.sum', duration: 300 })
      this.setData({ busy: false })
      this.loadPlans()
      await this.reviewAll(false)
    } catch (e) {
      this.setData({ status: e.message })
    }
    this.setData({ busy: false })
  },

  async showResult (ai) {
    const d = new Date(ai.at)
    const pad = n => String(n).padStart(2, '0')
    this.all = ai.ranked.map(x => Object.assign({}, x))
    this.shown = PAGE
    this.setData({ result: { summary: ai.summary, pool: ai.pool, matched: ai.matched, direct: ai.direct, proven: ai.proven, excluded: ai.excluded || 0, edu: ai.edu || '', roleWords: ai.roleWords || [], keywords: ai.keywords || [], at: ai.at, batches: ai.batches, batchSize: ai.batchSize, count: ai.ranked.length },
      resultTime: isNaN(d) ? '' : `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}` })
    await this.render()
  },

  // 按当前筛选和排序，取出要显示的那一段；缺详情的先拉详情（每次最多 30 家）
  sorted () {
    const f = this.data.filter
    let list = this.all.filter(e => f === 'all' || (f === 'direct' ? e.tier === 2 : f === 'hi' ? finalScore(e) >= 75 : e.ai && e.ai.fit === '高'))
    list = list.slice().sort(byRank)
    if (this.data.sort === 'dl') list.sort((a, b) => (a.dl || '9999') < (b.dl || '9999') ? -1 : (a.dl || '9999') > (b.dl || '9999') ? 1 : 0)
    return list
  },

  async render () {
    const list = this.sorted()
    const vis = list.slice(0, this.shown)
    const need = vis.filter(e => !this.details[e.id]).map(e => e.id)
    for (let i = 0; i < need.length; i += 30) {
      const ids = need.slice(i, i + 30)
      try {
        const got = await api('many', { ids })
        ids.forEach(id => { this.details[id] = got.companies[id] || { gone: true } })
        Object.assign(this.apps, got.apps)
      } catch (e) { break }
    }
    const rankOf = {}
    this.all.slice().sort(byRank).forEach((e, i) => { rankOf[e.id] = i + 1 })
    const r = this.data.result || {}
    const role = (r.roleWords || []).join('」「')
    const SEC = {
      2: role ? `岗位里直接有「${role}」` : '岗位对口',
      1: `可能相关，待核实（只命中相近方向${(r.keywords || []).length ? '：' + r.keywords.slice(0, 4).join('、') : ''}）`,
      0: '行业相关，没找到对应岗位，待核实'
    }
    const grouped = this.data.sort === 'score' && this.all.some(e => e.tier != null)
    let lastTier = null
    const items = vis.map(e => {
      const c = this.details[e.id]
      const jobField = key => e.jobEvidence && (e.jobEvidence.fields.find(f => f.key === key && f.scope === 'job') || {}).value || ''
      const base = !c ? { id: e.id, company: e.company, cdText: '', datesText: '加载中…' }
        : c.gone ? { id: e.id, company: e.company, cdText: '已下线', cdCls: 'closed', closedCls: 'closed', datesText: '', status: '', gone: true }
          : decorate(e.jobEvidence ? Object.assign({}, c, { deadline: jobField('deadline'), deadlineText: jobField('deadline') ? '' : '岗位截止未知' }) : c, this.apps[e.id])
      const sc = finalScore(e)
      return Object.assign(base, {
        rank: rankOf[e.id], score: sc, scoreCls: sc >= 75 ? 'hi' : sc >= 60 ? 'mid' : 'lo',
        rtags: e.tags || [], fit: e.ai ? e.ai.fit : '', reason: e.ai ? e.ai.reason : '', tip: e.ai ? e.ai.tip : '',
        reviewed: !!e.ai, low: !!e.low, vv: this.vv[e.id] || (c && !c.gone ? verifyView(c) : null),
        hit: (e.hit || []).join('、'), hitCls: e.tier === 2 ? 'direct' : 'rel', hitLabel: e.tier === 2 ? '岗位' : '相近岗位',
        // 岗位证据：公告原文列出 / 只在汇总站列表里
        evTag: e.tier === 2 ? (e.evid === 2 ? { t: '公告原文列出', c: 'ok' } : e.evid === 1 ? { t: '汇总站列出 · 待核对原公告', c: 'mid' } : null) : null,
        evLine: c && !c.gone ? evLine(c) : '',
        roleName: (e.hit || [])[0] || '',
        compactMeta: e.jobEvidence ? [jobField('cohort') || '届次未确认', jobField('edu') || '学历未确认', jobField('city') || '城市未确认'].join(' · ') : c && !c.gone ? [(c.batch && /2027|27届/.test(c.batch)) ? '2027届' : '届次未确认', c.minEdu ? c.minEdu + '（公司要求）' : '学历未确认', c.cities ? String(c.cities).slice(0, 18) + '（公司地点）' : '城市未确认'].join(' · ') : '岗位条件未确认',
        compactSource: e.jobEvidence ? '已按本人提供的JD摘录 · 可查看逐项原文' : c && !c.gone && (c.origUrl || c.url) ? '有招聘原文入口 · 岗位具体要求待核对' : '未取得企业岗位原文',
        elig: e.elig ? { text: e.elig.state === 'ok' ? '学历确认可投' : '学历要求未知', cls: e.elig.state === 'ok' ? 'ok' : 'mid', quote: e.elig.quote } : null,
        sec: grouped && e.tier !== lastTier ? SEC[e.tier || 0] + `（${list.filter(x => (x.tier || 0) === (e.tier || 0)).length} 家）` : '',
        _t: (lastTier = e.tier)
      })
    })
    this.setData({ items, count: list.length, more: list.length > vis.length })
  },

  showMore () {
    if (!this.data.more || this.data.loadingMore) return
    this.shown += PAGE
    this.setData({ loadingMore: true })
    this.render().then(() => this.setData({ loadingMore: false }))
  },

  onFilter (e) { this.shown = PAGE; this.setData({ filter: e.currentTarget.dataset.k }); this.render() },
  onSort (e) { this.shown = PAGE; this.setData({ sort: e.currentTarget.dataset.k }); this.render() },

  // AI 分批精评规则分最高的一批公司，同时最多 3 批；resume=true 时只补没评完的批次
  async reviewAll (resume) {
    const r = this.data.result
    if (!r || !r.batches || this.reviewAt === r.at) return
    const per = r.batchSize || 20
    const todo = []
    for (let b = 0; b < r.batches; b++) {
      const seg = this.all.slice(b * per, b * per + per)
      if (!resume || seg.some(e => !e.ai) || (b === 0 && !r.summary)) todo.push(b)
    }
    if (!todo.length) { this.verifyTop(); return }
    const at = r.at
    this.reviewAt = at
    this.setData({ reviewing: true, reviewTotal: r.batches, reviewDone: r.batches - todo.length })
    let failed = 0
    const worker = async () => {
      while (todo.length) {
        const b = todo.shift()
        try {
          const out = await api('aiReview', { at, batch: b })
          if (this.data.result.at !== at) return
          out.items.forEach(x => { if (this.all[x.i]) this.all[x.i].ai = x.ai })
          if (out.summary) this.setData({ 'result.summary': out.summary })
        } catch (e) {
          failed++
          if (/stale|no_ai_config|ai_auth|ai_rate/.test(e.code || '')) todo.length = 0
        }
        this.setData({ reviewDone: this.data.reviewDone + 1 })
        await this.render()
      }
    }
    await Promise.all([worker(), worker(), worker()])
    if (this.reviewAt !== at) return // 期间重新挑选过
    this.reviewAt = null
    this.setData({ reviewing: false, status: failed ? `有 ${failed} 批 AI 精评没成功，下次打开这一页会自动补上。` : '' })
    this.verifyTop()
    this.enrichMine()
  },

  // 后台读一读名单里还没读过公告的公司（学历要求、完整岗位），最多跑 3 轮；下次挑选时就用上
  async enrichMine () {
    if (this.enriching) return
    this.enriching = true
    for (let i = 0; i < 3; i++) {
      try { const r = await api('enrichMine'); if (!r.left || !r.done) break } catch (e) { break }
    }
    this.enriching = false
  },

  // 综合分最高的几家，逐家联网核实招聘是否属实（同时最多 2 家）；已核实过的直接用缓存结果
  async verifyTop () {
    if (!this.data.webSearch || this.verifyRunning) return
    const top = this.all.slice().sort(byRank).slice(0, VERIFY_TOP)
    const queue = top.filter(e => { const c = this.details[e.id]; return c && !c.gone && !c.verify && !this.vv[e.id] }).map(e => e.id)
    if (!queue.length) return
    this.verifyRunning = true
    this.setData({ verifying: queue.length })
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift()
        this.vv[id] = { text: '核实中…', cls: 'wait', reason: '' }
        this.render()
        try {
          const v = await api('verifyCompany', { id })
          this.vv[id] = verifyView({ verify: v })
          const c = this.details[id]
          if (v.url && c && !c.url) Object.assign(c, { url: v.url, v: 'official', linkBy: 'ai' })
        } catch (e) {
          this.vv[id] = { text: '未核实', cls: 'mid', reason: e.message }
          if (/limit|no_web_search|no_search_quota/.test(e.code || '')) queue.length = 0
        }
        this.setData({ verifying: Math.max(0, this.data.verifying - 1) })
        await this.render()
      }
    }
    await Promise.all([worker(), worker()])
    this.verifyRunning = false
  },

  async refreshStatuses () {
    const ids = this.data.items.map(x => x.id).slice(0, 100)
    if (!ids.length) return
    try {
      const { apps } = await api('statuses', { ids })
      ids.forEach(id => { this.apps[id] = apps[id] })
      this.render()
    } catch (e) {}
  },

  // 点一下标为想投，再点一下取消
  async want (e) {
    const { id } = e.currentTarget.dataset
    const on = (this.apps[id] || {}).status === 'want'
    try {
      await api('saveApp', { id, status: on ? '' : 'want' })
      this.apps[id] = Object.assign({}, this.apps[id], { status: on ? '' : 'want' })
      this.render()
      wx.showToast({ title: on ? '已取消想投' : '已标为想投', icon: 'none' })
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' })
    }
  },

  open (e) { wx.navigateTo({ url: `/pages/detail/detail?id=${encodeURIComponent(e.currentTarget.dataset.id)}` }) }
})
