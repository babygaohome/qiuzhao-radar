// 秋招雷达 · 前端公用：调用云函数、日期倒计时、状态与核实标记的显示文字

const INDUSTRIES = ['互联网', '游戏', '软件/IT', '通信', '电子/硬件', '芯片/半导体', '汽车', '机械/制造', '能源/电力', '化工/材料', '银行', '证券/基金', '保险', '其他金融', '咨询/四大', '医药/医疗', '快消/零售', '建筑/地产', '交通/物流', '传媒/文化', '教育/科研', '政府/事业', '其他']
const CTYPES = ['央国企', '民企', '外企/合资', '事业单位']
const STATUS = [
  { k: 'want', label: '想投' },
  { k: 'applied', label: '已投递' },
  { k: 'test', label: '笔试测评' },
  { k: 'interview', label: '面试中' },
  { k: 'offer', label: 'Offer' },
  { k: 'rejected', label: '未通过' },
  { k: 'dropped', label: '放弃' }
]
const STATUS_LABEL = STATUS.reduce((m, s) => { m[s.k] = s.label; return m }, {})
const APPLIED = ['applied', 'test', 'interview', 'offer', 'rejected']
const EVENT_TYPES = ['笔试', '测评', '一面', '二面', '三面', 'HR面', '群面', '宣讲会', '其他']

const ERR = {
  no_ai_config: '还没有配置 AI 服务，按 README 在云函数里填好 AI 接口后再试',
  ai_auth: 'AI 服务的密钥无效或没有权限，检查云函数环境变量',
  ai_rate: 'AI 服务调用太频繁或余额不足，稍后再试',
  ai_timeout: 'AI 回答超时了，再试一次，或换一个更快的模型',
  ai_error: 'AI 服务出错了，稍后再试',
  bad_answer: 'AI 这次的回答格式不对，再试一次',
  not_found: '这家公司已不在列表里',
  forbidden: '只能修改自己添加的公司'
}

// 调用云函数 api；业务错误和网络错误都转成 {code, message}
function api (action, data) {
  return wx.cloud.callFunction({ name: 'api', data: Object.assign({ action }, data || {}) })
    .then(r => {
      const res = r.result || {}
      if (res.error) throw { code: res.error, message: ERR[res.error] || res.message || '出错了，稍后再试' }
      return res
    }, e => {
      const msg = String((e && (e.errMsg || e.message)) || '')
      if (/timeout|-504003/i.test(msg)) throw { code: 'timeout', message: '请求超时了，稍后再试' }
      if (/env|-501000|-404011/i.test(msg)) throw { code: 'no_cloud', message: '连不上云开发环境，检查 config.js 里的环境 ID 和云函数是否已部署' }
      throw { code: 'network', message: '网络不太好，稍后再试' }
    })
}

function pad (n) { return String(n).padStart(2, '0') }
function todayISO () { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function parse (iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null
}
function short (iso) { const d = parse(iso); return d ? `${d.getMonth() + 1}/${pad(d.getDate())}` : '' }
function cn (iso) { const d = parse(iso); return d ? `${d.getMonth() + 1}月${d.getDate()}日` : '' }
function daysLeft (c) {
  const d = parse(c.deadline)
  if (!d) return null
  return Math.round((d - parse(todayISO())) / 86400000)
}
// 没有截止日期、超过 60 天没更新的自动收集公司，可能已经招满结束
function isStale (c) {
  if (c.deadline || c.source !== 'auto') return false
  const fresh = [c.updated, c.seen].filter(Boolean).sort().pop() || ''
  const cutoff = new Date(Date.now() - 60 * 86400000)
  const pad = n => String(n).padStart(2, '0')
  return fresh < `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`
}
function phase (c) {
  if (c.manualReview && c.manualReview.status === 'expired') return 'closed'
  if (c.closed || isStale(c)) return 'closed'
  const dl = daysLeft(c)
  if (dl !== null && dl < 0) return 'closed'
  const o = parse(c.openDate)
  if (o && o > parse(todayISO())) return 'soon'
  return 'open'
}
function countdown (c) {
  const p = phase(c); const dl = daysLeft(c)
  if (c.manualReview && c.manualReview.status === 'expired') return { text: '官网复核已结束', cls: 'closed' }
  if (p === 'closed') return { text: c.deadlineText === '已下线' ? '已下线' : isStale(c) ? '可能已结束' : '已截止', cls: 'closed' }
  if (p === 'soon') return { text: `${cn(c.openDate)}开启`, cls: 'soon' }
  if (dl === null) return { text: c.deadlineText || '未公布', cls: 'txt' }
  if (dl === 0) return { text: '今天截止', cls: 'urgent' }
  return { text: `D-${dl}`, cls: dl <= 7 ? 'urgent' : '' }
}
function datesLine (c) {
  if (c.manualReview && c.manualReview.status === 'expired') return '企业官网人工复核：该招聘已结束' + (c.cities ? ` · ${c.cities}` : '')
  if (c.manualReview && c.manualReview.status === 'open') {
    const checked = short(String(c.manualReview.at || '').slice(0, 10))
    const deadline = c.manualReview.deadline ? ' · 官网截止 ' + short(c.manualReview.deadline) : ' · 官网未显示截止'
    const catalog = c.deadline && c.deadline !== c.manualReview.deadline ? ' · 收录数据截止 ' + short(c.deadline) : ''
    return `官网 ${checked ? checked + ' ' : ''}核查时仍在招${deadline}${catalog}${c.cities ? ' · ' + c.cities : ''}`
  }
  if(c.publicSource && (c.publicOnly || c.batch === '人社公开招聘')) return c.publicSource.fairDate ? '招聘会 '+short(c.publicSource.fairDate)+' · 岗位截止未明确' : '公开招聘 · 截止见原公告'
  const o = c.openDate ? short(c.openDate) : (c.openText || '')
  const d = c.deadline ? short(c.deadline) : (c.deadlineText || '未公布')
  const city = c.cities ? ` · ${c.cities}` : ''
  return (o ? `网申 ${o} → ${d}` : `截止 ${d}`) + city
}
function hasCompleteCatalogAudit (c) {
  const a = c && c.catalogAudit
  return !!a && a.state === 'verified' && a.coverageComplete === true &&
    typeof a.coverageFingerprint === 'string' && !!a.coverageFingerprint &&
    ['browser_official', 'official_structured'].includes(a.proofMethod) && c.disputed !== true
}
function legacySourceLabel (c) {
  if (c.source === 'curated') return '精选目录收录'
  if (c.publicSource && c.publicSource.scope === 'government_job_table') return '人社公开表来源'
  if (c.hasOrig || c.origUrl) return '原文链接记录'
  if (c.v === 'official' || c.url) return '招聘入口记录'
  if (c.instOk) return '就业平台来源'
  if (c.srcFrom || (c.srcs || []).length) return '招聘来源记录'
  return c.source === 'manual' ? '自己添加' : '待核实'
}
function badge (c) {
  if (c.source === 'manual') return { text: '自己添加', cls: 'single' }
  if (c.agency) return { text: '疑似中介', cls: 'agency' }
  if (c.disputed) return { text: '复核中', cls: 'single' }
  if (hasCompleteCatalogAudit(c)) return { text: '逐岗已核实', cls: 'official' }
  if (c.catalogAudit) return { text: '逐岗待核', cls: 'mid' }
  if (c.manualReview && c.manualReview.status) return { text: c.manualReview.status === 'unconfirmed' ? '公司级复核待确认' : '公司级复核记录', cls: 'mid' }
  const v = c.v || ((c.srcs || []).length >= 2 ? 'multi' : (c.source === 'auto' ? 'single' : ''))
  if (c.publicSource && c.publicSource.scope === 'government_job_table') return { text: '人社来源', cls: 'multi' }
  if (c.instOk) return { text: '就业平台来源', cls: 'multi' }
  if (c.hasOrig || c.origUrl) return { text: '原文链接记录', cls: 'multi' }
  if (v === 'official' || c.source === 'curated') return { text: '招聘入口记录', cls: 'multi' }
  if (v === 'multi') return { text: '多源收录', cls: 'multi' }
  if (v === 'single' && c.traced) return { text: '注明来源', cls: 'multi' }
  return v ? { text: '单源收录', cls: 'single' } : null
}
function vExplain (c) {
  if (c.source === 'manual') return '这是你自己添加的记录；招聘真实性和当前状态请自行确认。'
  if (c.agency) return '该记录可能来自中介或外包机构，请确认实际用人单位。'
  if (c.disputed) return '这条记录正在复核；请到企业官方渠道确认。'
  if (hasCompleteCatalogAudit(c)) {
    const n = Object.keys(c.catalogAudit.jobs || {}).length
    return `目录中的 ${n} 个岗位均已按企业官方来源逐岗核验${c.catalogAudit.checkedAt ? `（${String(c.catalogAudit.checkedAt).slice(0, 10)}）` : ''}。`
  }
  const auditNote = c.catalogAudit ? '逐岗核验尚未完成。' : ''
  const manualNote = c.manualReview && c.manualReview.status ? `公司级人工复核记录：${c.manualReview.status === 'open' ? '曾标记在招' : c.manualReview.status === 'expired' ? '曾标记结束' : '待确认'}。` : ''
  const sources = []
  if (c.source === 'curated') sources.push('精选目录收录')
  if (c.publicSource && c.publicSource.scope === 'government_job_table') sources.push('人社公开表来源')
  if (c.hasOrig || c.origUrl) sources.push('原文链接记录')
  if (c.v === 'official' || c.url) sources.push('招聘入口记录')
  if (c.instOk) sources.push('就业平台来源记录')
  if (c.srcFrom) sources.push(`注明来源「${c.srcFrom}」`)
  if ((c.srcs || []).length) sources.push(`${c.srcs.length} 个来源站记录`)
  const sourceNote = sources.length ? `来源信息：${[...new Set(sources)].join('、')}；这些记录本身不证明每个岗位真实或仍在招。` : '尚无逐岗核验结论，请到企业官方渠道确认。'
  return `${auditNote}${manualNote}${sourceNote}`
}
const VERIFY = {
  verified: { text: '已核实', cls: 'ok' },
  partial: { text: '部分核实', cls: 'mid' },
  doubtful: { text: '存疑', cls: 'bad' }
}
// 招聘核实结果的显示文字；7 天内的结果才算数
function verifyView (c) {
  const v = c && c.verify
  if (!v || Date.now() - new Date(v.at).getTime() > 7 * 86400e3) return null
  const m = VERIFY[v.status] || VERIFY.partial
  return { text: m.text, cls: m.cls, reason: v.reason + (v.risk ? `；风险：${v.risk}` : '') }
}
// 日程时间显示：「10月12日 周六 19:00」
function eventTime (at) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/.exec(at || '')
  if (!m) return at
  const d = new Date(+m[1], +m[2] - 1, +m[3])
  return `${+m[2]}月${+m[3]}日 周${'日一二三四五六'[d.getDay()]}${m[4] ? ' ' + m[4] : ''}`
}
function daysUntil (at) {
  const d = parse((at || '').slice(0, 10))
  return d ? Math.round((d - parse(todayISO())) / 86400000) : null
}
function examView (c) {
  const e = c && c.exam
  if (!e) return null
  const head = e.has === '有' ? '有笔试/测评' : e.has === '无' ? '一般没有笔试' : '暂未查到'
  return { head, note: e.note || '', by: e.by }
}
function fullUrl (u) { return !u ? '' : (/^https?:\/\//i.test(u) ? u : 'https://' + u) }

// 截止日期最近 14 天内有变动
function deadlineChange (c) {
  if (!c.deadlineChangedAt || !c.prevDeadline) return ''
  const d = parse(c.deadlineChangedAt)
  if (!d || (parse(todayISO()) - d) / 86400000 > 14) return ''
  return `截止日期有变：${short(c.prevDeadline)} → ${short(c.deadline)}`
}

// 把岗位按大类分组；越具体的类别越靠前匹配（比如「工艺工程师」先归到制造，而不是研发）
const JOB_CATS = [
  { name: '产品 / 设计', re: /产品|设计师|UI|UX|交互|视觉|美术|策划|原画|动画/i },
  { name: '技术支持 / 实施', re: /技术支持|应用工程师|售前|售后|实施|FAE|客户成功|交付/i },
  { name: '生产 / 制造 / 工程', re: /工艺|制造|生产|质量|品质|质检|设备|机械|电气|自动化|施工|土建|结构工程|工程管理|造价|供应链|物流|仓储|现场|运行|检修|化工|材料|能源|电力/ },
  { name: '金融 / 投研', re: /投资|投行|研究员|分析师|交易|金融|银行|柜员|理财|保险|精算|资管|信贷|风险管理/ },
  { name: '职能 / 管培', re: /人力|HR|招聘|财务|会计|审计|法务|律师|行政|采购|管培|管理培训|储备|综合|秘书|文员|风控|合规|党|管理/i },
  { name: '运营 / 市场 / 销售', re: /运营|市场|销售|营销|品牌|客户|商务|渠道|电商|新媒体|内容|公关|广告|业务/ },
  { name: '研发 / 技术', re: /开发|工程师|研发|算法|软件|硬件|测试|架构|前端|后端|Java|C\+\+|Python|Go|数据|运维|嵌入式|芯片|IC|验证|电路|FPGA|射频|网络|安全|AI|人工智能|机器学习|视觉|通信|CAE|仿真|计算|技术|电子|半导体|光学/i }
]
function classifyJobs (list) {
  const groups = JOB_CATS.map(c => ({ name: c.name, items: [] })).concat({ name: '其他', items: [] })
  ;(list || []).forEach(j => {
    const i = JOB_CATS.findIndex(c => c.re.test(j))
    groups[i < 0 ? groups.length - 1 : i].items.push(j)
  })
  // 研发类一般最多，放最前面；其余按数量排
  return groups.filter(g => g.items.length).sort((a, b) => (b.name === '研发 / 技术') - (a.name === '研发 / 技术') || b.items.length - a.items.length)
}

// 核对依据：这家公司的信息核对过哪些原始页面、什么时候核对的
function evidenceView (c) {
  const lines = []
  const d = t => { const x = typeof t === 'number' ? new Date(t + 8 * 3600e3).toISOString().slice(0, 10) : String(t || '').slice(0, 10); return x ? short(x) : '' }
  const host = u => { const m = /^https?:\/\/([^/?#]+)/i.exec(u || ''); return m ? m[1].replace(/^www\./, '') : '' }
  if (c.source === 'manual') return { verified: false, level: '自己添加 · 待逐岗核验', summary: '这是你自己添加的记录；真实性和当前招聘状态请自行确认。', lines: [{ k: '来源', v: '你自己添加的记录；真实性和招聘状态请自行确认' }] }
  const completeAudit = hasCompleteCatalogAudit(c)
  if (c.publicSource && c.publicSource.scope === 'government_job_table') lines.push({ k: '人社来源记录', v: '目录记录了公开岗位表来源；不能替代企业官方逐岗核验', url: c.publicSource.url })
  const review = c.manualReview
  if (c.url) lines.push({ k: c.source === 'curated' ? '精选目录招聘入口' : '招聘入口记录', v: host(c.url), url: c.url })
  if (c.origUrl) lines.push({ k: '原文链接记录', v: `${host(c.origUrl)}${c.origAt ? ` · ${d(c.origAt)} 收录` : ''}`, url: c.origUrl })
  else if (c.srcFrom) lines.push({ k: '注明来源', v: `目录记录的来源为「${c.srcFrom}」` })
  if (c.ncss && c.ncss.n) lines.push({ k: '就业平台来源记录', v: `目录记录 ${c.ncss.n} 个相关职位来源；需逐岗核对企业和招聘状态${c.ncss.at ? ` · ${d(c.ncss.at)} 记录` : ''}`, url: c.ncss.url })
  if (c.verify && c.verify.at) lines.push({ k: '历史核查记录', v: `${d(c.verify.at)} · 原标记「${c.verify.status || '未知'}」；不代表当前全部岗位已核实`, url: c.verify.url })
  if (review && review.status) lines.push({ k: '公司级复核记录', v: `${d(review.at)} · ${review.status === 'open' ? '曾标记在招' : review.status === 'expired' ? '曾标记结束' : '待确认'}${review.reason ? ` · ${review.reason}` : ''}` })
  if (review && review.deadline) lines.push({ k: '公司级截止记录', v: short(review.deadline) })
  ;(review && review.evidenceUrls || []).forEach(url => lines.push({ k: '复核依据链接', v: host(url), url }))
  if ((c.srcs || []).length) lines.push({ k: '收录来源站', v: c.srcs.join('、') })
  if (c.disputed) lines.push({ k: '状态', v: `有反馈待复核：${c.disputeType || '信息有误'}` })
  if (c.catalogAudit) {
    const n = Object.keys(c.catalogAudit.jobs || {}).length
    lines.push({ k: '逐岗核验', v: completeAudit ? `已覆盖目录中的 ${n} 个岗位${c.catalogAudit.checkedAt ? ` · ${d(c.catalogAudit.checkedAt)}` : ''}` : `未完成目录岗位覆盖${n ? ` · 当前有 ${n} 条岗位核验记录` : ''}` })
  }
  const source = legacySourceLabel(c)
  const summary = completeAudit
    ? '目录中的岗位已按企业官方招聘来源逐岗核验；具体岗位结论见下方记录。'
    : `${source}，尚未完成当前目录岗位的逐条核验；请到企业官方渠道查看具体职位和招聘状态。`
  return { verified: completeAudit, level: completeAudit ? '企业官方 · 目录岗位逐岗已核实' : `${source} · 岗位待逐岗核验`, summary, lines }
}

// 牛企直聘的页面嵌了第三方弹窗广告（会跳到博彩、贷款等页面），复制它的链接前提醒一次（每次打开小程序提醒一次）
const AD_HOST = /(^|\.)niuqizp\.com$/
function hasPopupAds (url) { const m = /^https?:\/\/([^/?#]+)/i.exec(url || ''); return !!m && AD_HOST.test(m[1]) }
let adWarned = false
function copyLink (url, okTitle) {
  const doCopy = () => wx.setClipboardData({ data: url, success: () => wx.showToast({ title: okTitle || '已复制，去浏览器打开', icon: 'none' }) })
  if (!hasPopupAds(url) || adWarned) return doCopy()
  wx.showModal({
    title: '这个页面有弹窗广告',
    content: '牛企直聘的页面会弹出第三方广告，可能跳到博彩、贷款等网站。弹出的页面不要填写任何信息；看完直接关掉那个标签页（按「回退」可能回不到原页面）。',
    confirmText: '仍然复制', cancelText: '取消',
    success: r => { if (r.confirm) { adWarned = true; doCopy() } }
  })
}

// 第一次把用户自己的内容（材料、JD、公告）发给 AI 服务商前说明一下；同意后这台手机上不再提示
function aiNotice () {
  let ok = false
  try { ok = !!wx.getStorageSync('aiNoticeOk') } catch (e) {}
  if (ok) return Promise.resolve(true)
  return new Promise(resolve => wx.showModal({
    title: '内容会发给 AI 服务商',
    content: '这个功能会把你输入或粘贴的文字（材料、JD、公告）发给 AI 服务商（智谱）处理，用来生成结果。不要粘贴身份证号、手机号等敏感信息。',
    confirmText: '知道了', cancelText: '先不用',
    success: r => { if (r.confirm) { try { wx.setStorageSync('aiNoticeOk', 1) } catch (e) {} } resolve(r.confirm) }
  }))
}

// 资格三态：确认可投 / 明确不符合 / 要求未知。学历向下兼容；专业由 JD 识别时判断；没写不能当成可以投
const EDU_ORDER = { 大专: 0, 本科: 1, 硕士: 2, 博士: 3 }
function judgeElig (me, edu, eduQuote, majorFit, majorQuote) {
  const u = EDU_ORDER[(me && me.edu) || '本科']
  const parts = []
  let state = 'ok'
  if (!edu) { state = 'unknown'; parts.push('没写学历要求') } else if (u < EDU_ORDER[edu]) { state = 'no'; parts.push(`要求${edu}及以上`) } else parts.push(`学历符合（${edu}及以上）`)
  if (majorFit === 'no') { state = 'no'; parts.push('专业不在要求范围内') } else if (majorFit === 'ok') parts.push('专业符合')
  else { if (state === 'ok') state = 'unknown'; parts.push('专业要求未写明或无法判断') }
  return { state, reason: parts.join('；'), quote: [eduQuote, majorQuote].filter(Boolean).join(' / ') }
}
const ELIG_VIEW = { ok: { text: '确认可投', cls: 'ok' }, no: { text: '明确不符合', cls: 'bad' }, unknown: { text: '要求未知', cls: 'mid' } }

// 截止日期核对：各来源写的、公告正文里写的、联网核实查到的；相差 3 天以上算有出入
function dlCheck (c) {
  const lines = []
  const today = todayISO()
  const src = Object.assign({}, c.dlBySrc || {})
  // _legacy 是采集器给「还没分来源的旧数据」留的记号，显示时换成能看懂的说法
  if (src._legacy) { src['汇总站（早先记录）'] = src._legacy; delete src._legacy }
  if (c.srcDl && !src['牛企直聘']) src['牛企直聘'] = c.srcDl
  const srcs = Object.keys(src).filter(k => src[k])
  const parts = srcs.map(k => `${k} ${short(src[k])}`)
  // 列表显示的截止日期来自还没单独记录的汇总站（以前采集的数据没分来源）
  if (c.deadline && !srcs.some(k => src[k] === c.deadline)) {
    const others = (c.srcs || []).filter(k => !src[k])
    parts.unshift(`${others.length ? others.join('、') : '汇总站'} ${short(c.deadline)}`)
  }
  if (parts.length) lines.push('各来源：' + parts.join(' · '))
  if ((c.dlNotes || []).length) lines.push('公告写明：' + c.dlNotes.map(n => `${n.label || '截止'} ${short(n.date)}`).join('；'))
  if (c.verify && (c.verify.deadline || c.verify.deadlineNote)) lines.push(`联网核实：${c.verify.deadline ? short(c.verify.deadline) + ' ' : ''}${c.verify.deadlineNote || ''}`.trim())
  const dates = [c.deadline, ...Object.values(src), ...(c.dlNotes || []).map(n => n.date), c.verify && c.verify.deadline].filter(Boolean).sort()
  const conflict = dates.length > 1 && (parse(dates[dates.length - 1]) - parse(dates[0])) / 86400000 > 3
  // 还没过去的日期里最早的一个，比列表显示的截止早好几天时提醒
  const upcoming = dates.filter(d => d >= today)
  const earliest = upcoming.length && c.deadline && (parse(c.deadline) - parse(upcoming[0])) / 86400000 > 3 ? upcoming[0] : ''
  return { lines, conflict, earliest }
}

// 给列表项补上显示用的字段
function decorate (c, app) {
  const cd = countdown(c)
  const s = app && STATUS_LABEL[app.status] ? app.status : ''
  return Object.assign({}, c, {
    id: c._id,
    cdText: cd.text, cdCls: cd.cls, closedCls: phase(c) === 'closed' ? 'closed' : '',
    datesText: datesLine(c) + (app && app.appliedAt ? ` · 投于 ${short(app.appliedAt)}` : ''),
    badge: badge(c),
    dlChange: deadlineChange(c),
    dlEarly: (dlCheck(c).earliest && short(dlCheck(c).earliest)) || '',
    isNew: [c.addedAt, c.updated].some(d => d && daysUntil(d) !== null && daysUntil(d) >= -1),
    // 秋招以外的批次标出来；已截止的公司又开了新批次，7 天内标「新批次」
    btText: ['提前批', '补录', '春招'].includes(c.batchType) ? c.batchType : '',
    reopened: !!c.reopenedAt && daysUntil(c.reopenedAt) !== null && daysUntil(c.reopenedAt) >= -7,
    status: s, statusLabel: s ? STATUS_LABEL[s] : '未标记'
  })
}

module.exports = {
  hasPopupAds, copyLink, aiNotice, judgeElig, ELIG_VIEW, dlCheck, classifyJobs, INDUSTRIES, CTYPES, STATUS, STATUS_LABEL, APPLIED, EVENT_TYPES, eventTime, daysUntil, examView,
  api, verifyView, isStale, deadlineChange, todayISO, parse, short, cn, daysLeft, phase, countdown, datesLine, badge, vExplain, evidenceView, hasCompleteCatalogAudit, fullUrl, decorate
}
