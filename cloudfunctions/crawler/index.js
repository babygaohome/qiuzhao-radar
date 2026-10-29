// 秋招雷达 · 定时采集云函数
// 每 30 分钟由定时触发器运行一次（见 config.json），抓公开校招列表的首页和轮换的后续页，
// 新公司写入 companies 集合，已有公司合并截止日期、来源和官方链接。
// 采集最多约 30 秒；牛企直聘按行业轮换，每 2 小时轮完 27 个行业首页。
const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')
const zlib = require('zlib')
const { invalidationPatch } = require('./audit-coverage')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const BUDGET_MS = 30000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 qiuzhao-radar/1.0'
const QZW_PAGES = 4
const GMO_PAGES = 6
const NIUQI_PER_RUN = 7
const DETAILS_PER_RUN = 10
const QZW_DEEP_MAX = 19
const GMO_DEEP_MAX = 31
const JOBUP_DEEP_MAX = 16
const HUST_DEEP_MAX = 8

const NIUQI_INDUSTRIES = [
  ['internet', '互联网'], ['computersoftwarehardwareservices', '计算机软件/硬件/服务'],
  ['telecomnetworkequipment', '通信/电信/网络设备'], ['electronicscircuitsemiconductor', '电子/电路/半导体'],
  ['financesecuritiesinvestment', '金融/证券/投资'], ['banking', '银行'], ['insurance', '保险'], ['fmcg', '快速消费品'],
  ['tradeimportexport', '贸易/进出口'], ['governmentinstitutionngofarming', '政府/事业/组织/农林牧渔'],
  ['culturemediaadvertisingpaper', '文化/广告/传媒/造纸'], ['automotivemotorcycleparts', '汽车/摩托车/零配件'],
  ['pharmaceuticalmedicalequipment', '制药/医疗/医疗设备'], ['energyminingmetallurgy', '能源/采掘/冶炼'],
  ['constructionmaterialsengineering', '建筑/建材/工程'], ['chemicalelectrical', '化工/电气'],
  ['machineryequipmentheavyindustry', '机械/设备/重工'], ['transportationlogisticswarehousing', '交通/物流/仓储'],
  ['realestateproperty', '房地产/物业'], ['clothingtextile', '服装/纺织'], ['homeappliances', '家电'],
  ['wholesaleretail', '批发/零售'], ['hoteltourism', '酒店/旅游'], ['cateringrestaurant', '餐饮'],
  ['entertainmentleisuresportlife', '娱乐/休闲/体育/生活服务'], ['educationtrainingconsultinglaw', '专业服务/教育/培训/咨询/法律'],
  ['other', '其他']
]

// ---------------------------------------------------------------- 与 tools/collect.py 保持一致的规则

const INDUSTRY_RULES = [
  [/游戏/, '游戏'], [/半导体|芯片|集成电路|晶圆/, '芯片/半导体'], [/互联网|电商|电子商务/, '互联网'],
  [/计算机|软件|IT|信息技术|人工智能|大数据|云计算/, '软件/IT'], [/通信|电信|网络设备|移动|联通|铁塔/, '通信'],
  [/电子|电路|智能硬件|家电|消费电子/, '电子/硬件'], [/汽车|摩托车|新能源车|整车/, '汽车'],
  [/证券|基金|期货|资管|信托/, '证券/基金'], [/银行|农商|农信|信用社/, '银行'], [/投资/, '证券/基金'],
  [/保险|人寿|财险|再保/, '保险'], [/金融/, '其他金融'], [/咨询|会计|审计|律师|法律|专业服务|四大/, '咨询/四大'],
  [/医|药|生物|健康/, '医药/医疗'], [/能源|电力|电网|采掘|冶炼|石油|石化|煤|核电|水电|光伏|环保|燃气/, '能源/电力'],
  [/化工|材料|电气/, '化工/材料'], [/机械|制造|重工|设备|装备|航天|航空工业|商飞|兵器|船舶|中车/, '机械/制造'],
  [/快速消费|快消|食品|饮料|零售|批发|贸易|服装|纺织|餐饮|酒店|旅游|日化/, '快消/零售'],
  [/建筑|房地产|物业|建材|工程|建工|基建|中铁|中建|铁建|交建|城建/, '建筑/地产'],
  [/交通|物流|仓储|航空|铁路|港口|航运|快递|机场/, '交通/物流'], [/传媒|广告|文化|出版|娱乐|影视|体育/, '传媒/文化'],
  [/教育|培训|科研|研究院|研究所|高校|大学/, '教育/科研'], [/政府|事业|组织|农林|烟草/, '政府/事业']
]
const CTYPE_RULES = [[/央|国企|国有/, '央国企'], [/外企|外资|合资/, '外企/合资'], [/事业|高校|科研院所|政府|机关/, '事业单位'], [/民企|民营/, '民企']]
const NOT_OFFICIAL = /niuqizp\.com|qiuzhaowang\.com|givemeoc\.com|yingjiesheng\.com|dajie\.com|offershow|job592|91job|haitou|kanzhun|jobui|tianyancha|qcc\.com|baidu\.com/
const AGENCY = /猎头|人力资源|劳务|派遣|外包|人才服务|人力科技|招聘服务/

function normIndustry (raw, company) {
  for (const hay of [raw || '', company || '']) for (const [re, v] of INDUSTRY_RULES) if (re.test(hay)) return v
  return '其他'
}
function normCtype (s) { for (const [re, v] of CTYPE_RULES) if (re.test(s || '')) return v; return '' }
function cleanCompany (name) {
  return unescape(name || '').trim()
    .replace(/(20\d\d|\d\d)届.*$/, '').replace(/(校园招聘|校招|秋招|春招|招聘简章|招聘公告|简章).*$/, '')
    .replace(/^[\s,，|\-·]+|[\s,，|\-·]+$/g, '')
}
function companyKey (name) {
  let s = name.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').toLowerCase()
    .replace(/(股份有限公司|有限责任公司|集团有限公司|有限公司|集团|控股|股份|公司)$/, '')
  if (s.startsWith('中国') && s.length >= 6) s = s.slice(2)
  return s
}
const idOf = key => 'a' + crypto.createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 10)
function todayCN () { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) }
function parseDeadline (s) {
  s = (s || '').trim()
  let m = s.match(/(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (m) return [`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, '']
  m = s.match(/(\d{1,2})月(\d{1,2})日/)
  if (m) {
    const now = new Date(Date.now() + 8 * 3600e3)
    const mon = +m[1]
    const y = now.getUTCFullYear() + (mon < now.getUTCMonth() + 1 - 3 ? 1 : 0)
    return [`${y}-${String(mon).padStart(2, '0')}-${m[2].padStart(2, '0')}`, '']
  }
  if (/招满|额满|滚动/.test(s)) return ['', '招满即止']
  return ['', '未公布']
}
function short (s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1) + '…' }
function unescape (s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39|apos|nbsp);/gi, (all, e) => {
    const t = e.toLowerCase()
    if (t[0] === '#') return String.fromCodePoint(t[1] === 'x' ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[t] || all
  })
}
function text (s) { return unescape(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() }
function cleanJob (s) {
  return text(String(s || '').replace(/(?:<span\b[^>]*>)?class=["']job-postion["']\s*>/gi, '').replace(/<\/span>/gi, '')).trim()
}
function rotatedPages (cursor, count, max) {
  const start = Number.isInteger(cursor) && cursor >= 2 && cursor <= max ? cursor : 2
  const pages = [1]
  let page = start
  for (let i = 1; i < count; i++) { pages.push(page); page = page >= max ? 2 : page + 1 }
  return { pages, next: page }
}
function shortDate (raw) {
  const m = String(raw || '').match(/^(\d{1,2})[-/.](\d{1,2})$/)
  if (!m) return ''
  const t = todayCN()
  const md = `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  return `${md > t.slice(5) ? +t.slice(0, 4) - 1 : t.slice(0, 4)}-${md}`
}

// ---------------------------------------------------------------- 抓取

let started = Date.now()
const timeLeft = () => BUDGET_MS - (Date.now() - started)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let sourceRun = null

async function forEachLimit (items, limit, fn) {
  let next = 0
  let firstError = null
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!firstError && next < items.length) {
      const item = items[next++]
      try { await fn(item) } catch (e) { firstError = firstError || e }
    }
  })
  // Drain all already-started writes before propagating an error so the caller cannot
  // release the crawl lease while sibling workers are still writing to the database.
  await Promise.all(workers)
  if (firstError) throw firstError
}

function withoutDocumentId (doc) {
  const { _id, ...data } = doc || {}
  return data
}

function changedFields (old, doc) {
  const patch = {}
  for (const key of new Set([...Object.keys(old), ...Object.keys(doc)])) {
    if (key === '_id' || key === 'v') continue
    if (JSON.stringify(old[key]) === JSON.stringify(doc[key])) continue
    // The SDK flattens plain objects: {} becomes an empty update and removed map
    // keys survive. Explicit field replacement preserves the actual merged map.
    patch[key] = !(key in doc) ? _.remove() : doc[key] && typeof doc[key] === 'object' && !Array.isArray(doc[key]) ? _.set(doc[key]) : doc[key]
  }
  return patch
}

function companyAuditSnapshotCondition (id, old) {
  const expected = old && Object.prototype.hasOwnProperty.call(old, 'catalogAudit') ? _.eq(old.catalogAudit) : _.exists(false)
  return { _id: id, catalogAudit: expected }
}

async function updateCompanyWithAuditGuard (col, id, old, patch) {
  const result = await col.where(companyAuditSnapshotCondition(id, old)).update({ data: patch })
  if (!result || !result.stats || !result.stats.updated) {
    const error = Error(`company ${id} catalog audit changed during crawler merge`)
    error.code = 'catalog_audit_conflict'
    throw error
  }
  return result
}

function summarizeSources (plans, metrics) {
  const out = {}
  for (const [name, planned] of Object.entries(plans)) {
    const m = metrics[name] || { requests: 0, failed: true, ms: 0 }
    out[name] = { status: !m.failed && m.requests === planned ? 'ok' : 'failed', requests: m.requests, planned, ms: m.ms }
  }
  return out
}

function cursorAfter (sources, name, current, next) {
  return sources[name] && sources[name].status === 'ok' ? next : (current || 0)
}

function sourceMetric (name) {
  if (!sourceRun) return null
  return sourceRun[name] || (sourceRun[name] = { requests: 0, failed: false, ms: 0 })
}

function get (url) {
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', 'Accept-Encoding': 'gzip' }, timeout: 10000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null) }
      const chunks = []
      let size = 0
      res.on('error', () => resolve(null))
      res.on('data', c => { size += c.length; if (size > 1e6) { resolve(null); req.destroy() } else chunks.push(c) })
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks)
          resolve(/gzip/i.test(res.headers['content-encoding'] || '') ? zlib.gunzipSync(raw, { maxOutputLength: 3e6 }).toString('utf8') : raw.toString('utf8'))
        } catch (e) { resolve(null) }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
    const totalTimer = setTimeout(() => { resolve(null); req.destroy() }, 10000)
    req.on('close', () => clearTimeout(totalTimer))
  })
}
// 同一站点依次请求，每次间隔约 1 秒；时间不够就停
async function politeGet (url, source) {
  const metric = sourceMetric(source)
  if (metric) metric.requests++
  if (timeLeft() < 4000) { if (metric) metric.failed = true; return null }
  const at = Date.now()
  const body = await get(url)
  if (metric) {
    metric.ms += Date.now() - at
    if (body === null) metric.failed = true
  }
  await sleep(900)
  return body
}

async function srcQiuzhaowang (pages) {
  const out = []
  for (const page of pages) {
    const body = await politeGet(`https://qiuzhaowang.com/?year=2027&page=${page}`, 'qiuzhaowang')
    if (body === null) break
    const rows = body.match(/<article class="job-row"[^>]*>/g) || []
    for (const attrs of rows) {
      const a = {}
      attrs.replace(/data-job-([a-z-]+)="([^"]*)"/g, (m, k, v) => { a[k] = unescape(v) })
      if (!a.company) continue
      const mm = /(\d{1,2})月(\d{1,2})日/.exec(a.update || '')
      const updated = mm ? shortDate(`${mm[1]}-${mm[2]}`) : ''
      out.push({ company: a.company, industryRaw: a.industry, ctypeRaw: a['company-type'], batch: a.batch || '', openDate: '',
        deadlineRaw: a.deadline, url: a.href ? 'https://qiuzhaowang.com' + a.href.split('?')[0] : '', positions: a.title,
        cities: a.city || '', updated, src: '秋招网', deep: page > 1 })
    }
  }
  return out
}

async function srcGivemeoc (pages) {
  const out = []
  for (const page of pages) {
    const q = `target_candidates=2027&deadline_range=exclude_expired&paged=${page}`
    const body = await politeGet(`https://www.givemeoc.com/?${q}`, 'givemeoc')
    if (body === null) break
    const rows = body.match(/<tr data-id="\d+">[\s\S]*?<\/tr>/g) || []
    for (const r of rows) {
      const f = {}
      r.replace(/<td class="crt-col-([a-z-]+)">([\s\S]*?)<\/td>/g, (m, k, v) => { f[k] = text(v) })
      if (!(f.target || '').includes('2027')) continue
      out.push({ company: f.company || '', industryRaw: f.industry, ctypeRaw: f.type, batch: f['recruitment-type'] || '', openDate: '',
        deadlineRaw: f.deadline, url: '', positions: f.position, cities: f.location || '', updated: f['update-time'] || '', src: 'offer多多', deep: page > 1 })
    }
  }
  return out
}

// 公开招聘列表可直接浏览；只采集公司、岗位和日期等摘要，投递链接仍指向来源站。
// 该站的外链可能是第三方公众号，不能据此标记为企业官方入口。
function offerstarRows (body) {
  const out = []
  for (const row of body.match(/<tr\b[^>]*class="[^"]*ant-table-row[^"]*"[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const cells = (row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) || []).map(text)
    if (cells.length < 10) continue
    const [company, title, cohort, published, positions, cities, industry, kind, deadline] = cells
    if (!/2027\s*届/.test(cohort) || !/校招|秋招|春招|校园招聘/.test(kind + ' ' + title) || /实习|博士后/.test(kind)) continue
    const name = cleanCompany(company)
    if (name.length < 2 || !positions) continue
    out.push({ company: name, industryRaw: industry, ctypeRaw: '', batch: '2027届校招', openDate: '',
      deadlineRaw: deadline, url: 'https://www.offerstar.cn/recruitment', positions, cities: cities.replace(/\+\s*\d+$/, ''),
      updated: shortDate(published), src: 'OfferStar' })
  }
  return out
}
async function srcOfferstar () {
  const body = await politeGet('https://www.offerstar.cn/recruitment', 'offerstar')
  return body === null ? [] : offerstarRows(body)
}

// JOBUP 的公开表格每页只完整渲染少量记录；跳过服务端尚未补齐的半行。
function jobupRows (body, page) {
  const table = (body.match(/<table\b[^>]*class="[^"]*job-table[^"]*"[^>]*>[\s\S]*?<\/table>/) || [])[0] || ''
  const out = []
  for (const row of table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const cells = (row.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) || []).map(text)
    if (cells.length !== 14) continue
    const batch = cells[10]
    if (!/2027|27届|27秋招|27春招/.test(batch) || /实习|社招/.test(batch)) continue
    const company = cleanCompany(cells[2])
    if (company.length < 2 || !cells[5]) continue
    out.push({ company, industryRaw: cells[3], ctypeRaw: cells[4], batch: '2027届校招', openDate: '',
      deadlineRaw: cells[11], url: `https://jobup.cn/?page=${page}`, positions: cells[5], cities: cells[6],
      updated: shortDate(cells[1]), src: 'JOBUP', deep: page > 1 })
  }
  return out
}
async function srcJobup (pages) {
  const out = []
  for (const page of pages) {
    const body = await politeGet(`https://jobup.cn/?page=${page}`, 'jobup')
    if (body === null) break
    out.push(...jobupRows(body, page))
  }
  return out
}

// 高校就业网的公开招聘公告。学校发布可提供独立出处，但它不是企业官网。
function hustRows (body, page) {
  const out = []
  const re = /<li>\s*<h4>\s*<a href="(\/zpinfo[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h4>\s*<time>\[(\d{4}-\d{2}-\d{2})\]<\/time>\s*<\/li>/g
  for (const m of body.matchAll(re)) {
    const title = text(m[2])
    if (!/2027\s*(届|年度|年|校招)|27届/.test(title) || !/校园招聘|校招|秋招|秋季招聘|春招|毕业生招聘/.test(title) || /博士后|实习/.test(title)) continue
    let head = title.split(/2027|27届/)[0].split(/[|｜]/).pop().trim()
    head = head.replace(/^.+子公司[—–-]/, '').replace(/^[“"'‘【《][^”"'’】》]{1,20}[”"'’】》]\s*/, '').replace(/[\s—–\-:：]+$/, '')
    const company = cleanCompany(head)
    if (company.length < 2 || company.length > 45 || /招聘|就业|同学|毕业生/.test(company)) continue
    out.push({ company, industryRaw: '', ctypeRaw: '', batch: '2027届校招', openDate: '', deadlineRaw: '',
      url: 'https://job.hust.edu.cn' + m[1], positions: '', positionsKnown: false, cities: '', updated: m[3], src: '华科就业网', deep: page > 1 })
  }
  return out
}
async function srcHust (pages) {
  const out = []
  for (const page of pages) {
    const path = page === 1 ? 'index.htm' : `index_${page}.htm`
    const body = await politeGet(`https://job.hust.edu.cn/zpxx123123/${path}`, 'hust')
    if (body === null) break
    out.push(...hustRows(body, page))
  }
  return out
}

function niuqiCards (body) {
  const out = []
  for (const c of body.match(/<article class="schedule-card">[\s\S]*?<\/article>/g) || []) {
    const tag = text((c.match(/schedule-card-tags"[^>]*>([\s\S]*?)<\/span>/) || [])[1])
    const m = c.match(/schedule-card-company">\s*<a href="([^"]+)" title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
    if (!m) continue
    const heading = text((c.match(/schedule-card-title">([\s\S]*?)<\/h4>/) || [])[1])
    out.push({
      tag, href: m[1], title: unescape(m[2]), h3: text(m[3]), heading,
      dates: text((c.match(/title="网申日期">([\s\S]*?)<\/span>/) || [])[1]),
      posted: text((c.match(/title="收录日期">([\s\S]*?)<\/span>/) || [])[1]),
      cities: text((c.match(/title="招聘城市">([\s\S]*?)<\/span>/) || [])[1]),
      positions: [...c.matchAll(/<span\b[^>]*class=["'][^"']*\bjob-postion\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)].map(m => text(m[1])).filter(Boolean).join(',')
    })
  }
  return out
}

async function srcNiuqi (cursor, deepCursor) {
  const out = []
  const parsePage = (body, label, deep) => {
    for (const c of niuqiCards(body)) {
      if (/实习|大使|宣讲/.test(c.tag)) continue
      const blob = c.h3 + c.heading
      if (/(2026|26)届/.test(blob) && !/(2027|27)届/.test(blob)) continue
      if (deep && !/(2027|27)\s*(届|年|校招|校园)/.test(blob)) continue
      const name = c.h3.split(' ')[0].split(',')[0].split('，')[0]
      const ds = c.dates.match(/20\d\d-\d\d-\d\d/g) || []
      out.push({ company: cleanCompany(name) || cleanCompany(c.title), industryRaw: label, ctypeRaw: '',
        batch: c.tag === '校招' ? '校招' : c.tag, openDate: ds[0] || '', deadlineRaw: ds[1] || '',
        url: 'https://campus.niuqizp.com' + c.href, positions: c.positions, cities: c.cities, updated: c.posted, src: '牛企直聘', deep })
    }
  }
  for (let i = 0; i < NIUQI_PER_RUN; i++) {
    const [slug, label] = NIUQI_INDUSTRIES[(cursor + i) % NIUQI_INDUSTRIES.length]
    const body = await politeGet(`https://campus.niuqizp.com/schedulenew-${slug}-all-1/`, 'niuqi')
    if (body === null) break
    parsePage(body, label, false)
  }
  // 每轮只补一个行业的第 2 页；不挤占 27 个行业首页的轮转。
  const deepAt = Number.isInteger(deepCursor) ? deepCursor % NIUQI_INDUSTRIES.length : 0
  const [slug, label] = NIUQI_INDUSTRIES[deepAt]
  const body = await politeGet(`https://campus.niuqizp.com/schedulenew-${slug}-all-2/`, 'niuqi')
  if (body !== null) parsePage(body, label, true)
  return { rows: out, next: (cursor + NIUQI_PER_RUN) % NIUQI_INDUSTRIES.length, deepNext: (deepAt + 1) % NIUQI_INDUSTRIES.length }
}

// ---------------------------------------------------------------- 合并入库

const SRC_RANK = { 牛企直聘: 0, 秋招网: 1, offer多多: 2, OfferStar: 3, JOBUP: 4, 华科就业网: 5 }

function group (rows, curatedKeys) {
  const today = todayCN()
  const g = new Map()
  for (const r of rows) {
    r.company = cleanCompany(r.company)
    if (r.company.length < 2) continue
    if (/实习|intern/i.test(r.batch || '')) continue
    const [dl, dlText] = parseDeadline(r.deadlineRaw)
    r.past = !!(dl && dl < today) // 已过截止：只用来更新库里已有公司的截止日期
    r.deadline = dl; r.deadlineText = dlText
    const key = companyKey(r.company)
    if (curatedKeys.has(key)) continue
    if (!g.has(key)) g.set(key, [])
    g.get(key).push(r)
  }
  return g
}
// 后续页只是来源的一个片段，不能拿它覆盖库里该公司已保存的岗位列表。
// 它只用来发现此前完全未收录的企业；已有企业仍以本轮首页数据更新。
function rowsForMerge (old, rows) { return old ? rows.filter(r => !r.deep) : rows }

// 是否校招：批次里只有社招 / 博士后 / 高层次人才、没有任何校招字样的不收录（与 tools/collect.py 一致）
const CAMPUS_RE = /校招|秋招|春招|管培|应届|毕业生|届|提前批|补录|校园|双选会|专场|正式批/
// 批次类型：秋招正式批之外，补录、春招、提前批也要分得出来（全年都有人在招）。
// 先看文字；没写的按月份兜底：2–6 月发布的算春招。crawler 和 api 各有一份，改动要同步
function batchTypeOf (c) {
  if (c.publicOnly) return '公开招聘'
  const t = [c.batch, ...(c.tags || []), c.deadlineText, c.note].join(' ')
  if (/补录|补招|二次招聘|增补|补充招聘/.test(t)) return '补录'
  if (/春招|春季/.test(t)) return '春招'
  if (/提前批/.test(t) && !/正式批/.test(t)) return '提前批' // 「提前批 + 正式批」现在已是正式批
  if (/秋招|秋季/.test(t)) return '秋招'
  const m = Number(String(c.openDate || c.addedAt || '').slice(5, 7))
  return m >= 2 && m <= 6 ? '春招' : '秋招'
}
function campusTags (batchText, company) {
  const t = batchText || ''
  if (/博士后/.test(company || '')) return null
  if (!CAMPUS_RE.test(t) && /社招|博士后|高层次人才/.test(t)) return null
  const tags = []
  if (t.includes('社招')) tags.push('含社招')
  if (/博士|高层次人才/.test(t)) tags.push('博士岗')
  return tags
}

// 分支机构归到所属集团：招商银行深圳分行 → 招商银行，字节跳动-中国交易与广告 → 字节跳动
const PLACES = '北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|内蒙古|广西|西藏|宁夏|新疆|香港|澳门|深圳|广州|杭州|南京|苏州|成都|武汉|西安|宁波|厦门|青岛|大连|长沙|郑州|济南|合肥|福州|昆明|南昌|沈阳|长春|哈尔滨|石家庄|太原|南宁|贵阳|兰州|海口|无锡|东莞|佛山|温州|绍兴|嘉兴|台州|金华|泉州|珠海|烟台|徐州|常州|南通|扬州|总行|总部'
const BRANCH_RE = new RegExp(`^(.{2,12}?)(?:股份有限公司|有限责任公司|有限公司|集团)?(?:${PLACES})(?:省|市|自治区|地区)?(?:分行|分公司|公司|支行|分院|分中心|中心支公司|营业部)$`)
const GROUP_ALIAS = { 招行: '招商银行', 建行: '建设银行', 工行: '工商银行', 农行: '农业银行', 中行: '中国银行', 交行: '交通银行', 邮储: '邮储银行', 中国工商银行: '工商银行', 中国农业银行: '农业银行', 中国建设银行: '建设银行', 中国邮政储蓄银行: '邮储银行', 中国交通银行: '交通银行', 中国平安: '平安', 中国石油天然气: '中国石油', 中石油: '中国石油', 中石化: '中国石化' }
function groupOf (name) {
  const g = rawGroupOf(name)
  return GROUP_ALIAS[g] || g
}
function rawGroupOf (name) {
  const n = String(name || '').replace(/[（(][^）)]*[）)]/g, '').trim()
  let m = n.match(/^([^-－—·]{2,12})[-－—·].+$/)
  if (m) return m[1].trim()
  m = n.match(BRANCH_RE)
  if (m) return m[1]
  m = n.match(/^(.{2,12}?)(?:股份有限公司|有限公司)?.{2,8}(?:分行|分公司|支行)$/)
  return m ? m[1] : ''
}

function mergeInto (old, key, rs) {
  rs.sort((a, b) => (SRC_RANK[a.src] ?? 9) - (SRC_RANK[b.src] ?? 9))
  const c = old ? { ...old } : { company: rs.map(r => r.company).sort((a, b) => a.length - b.length)[0], source: 'auto', url: '', agg: '', srcs: [], note: '', cities: '', batch: '', openDate: '', deadline: '', deadlineText: '', updated: '' }
  if(old && old.publicOnly) {c.publicOnly=false;c.recruitmentType='campus';c.batch='';c.positions=[];c.fullJobs=[]}
  const srcs = new Set([...(c.srcs || []), ...rs.map(r => r.src)])
  c.srcs = [...srcs].sort((a, b) => (SRC_RANK[a] ?? 9) - (SRC_RANK[b] ?? 9))
  // 截止日期按来源分别记：这次抓到的来源用它最新写的日期（可以变早），没抓到的来源保留上次的；
  // 公司截止日取各来源的最晚值。旧数据没分来源时，先把旧日期记在 _legacy，等所有来源都重新抓到再去掉
  const prev = c.deadline
  const bySrc = Object.assign({}, c.dlBySrc || {})
  if (old && !old.dlBySrc && prev && (c.srcs || []).some(sn => !rs.some(r => r.src === sn))) bySrc._legacy = prev
  const seenSrcs = [...new Set(rs.map(r => r.src))]
  seenSrcs.forEach(sn => {
    const ds = rs.filter(r => r.src === sn && r.deadline).map(r => r.deadline).sort()
    if (ds.length) bySrc[sn] = ds[ds.length - 1]; else delete bySrc[sn] // 这个来源现在没写截止日（招满即止等）
  })
  if (bySrc._legacy && (c.srcs || []).every(sn => sn in bySrc)) delete bySrc._legacy
  c.dlBySrc = bySrc
  const vals = Object.values(bySrc).filter(Boolean).sort()
  c.deadline = vals.length ? vals[vals.length - 1] : ''
  if (old && prev && c.deadline && prev !== c.deadline) {
    c.prevDeadline = prev; c.deadlineChangedAt = todayCN()
    if (c.deadline > prev) c.dlExtendedAt = todayCN() // 截止延后，「捡漏」用
  }
  const allDl = [c.deadline, c.srcDl, ...vals, ...(c.dlNotes || []).map(n => n.date), c.verify && c.verify.deadline].filter(Boolean).sort()
  c.dlConflict = allDl.length > 1 && (new Date(allDl[allDl.length - 1]) - new Date(allDl[0])) / 86400e3 > 3
  c.deadlineText = c.deadline ? '' : (rs.some(r => r.deadlineText === '招满即止') || c.deadlineText === '招满即止' ? '招满即止' : '未公布')
  const opens = [c.openDate, ...rs.map(r => r.openDate)].filter(Boolean).sort()
  c.openDate = opens[0] || ''
  if (!c.industry || c.industry === '其他') {
    c.industry = rs.map(r => normIndustry(r.industryRaw, r.company)).find(x => x !== '其他') || c.industry || '其他'
  }
  if (!c.ctype) c.ctype = rs.map(r => normCtype(r.ctypeRaw)).find(Boolean) || ''
  if (!c.agg) {
    const r0 = rs.find(r => r.url)
    c.agg = r0 ? r0.url : (rs.some(r => r.src === 'offer多多') ? 'https://www.givemeoc.com/?company_name=' + encodeURIComponent(c.company) : '')
  }
  // 岗位也按来源分别记，这次抓到的来源用新列表替换旧的（撤掉的岗位会消失）；
  // 公告页读到的完整列表（fullJobs）优先。note 是列表里显示的摘要，跟着更新
  const splitPos = t => { const out = []; String(t || '').split(/[,，、/\\;；]+/).forEach(p => { p = cleanJob(p); if (p && p.length <= 40 && !out.includes(p) && !/届|校园招聘|启动|详见附件/.test(p)) out.push(p) }); return out }
  const posBySrc = Object.assign({}, c.posBySrc || {})
  Object.keys(posBySrc).forEach(sn => { if (Array.isArray(posBySrc[sn])) posBySrc[sn] = [...new Set(posBySrc[sn].map(cleanJob).filter(Boolean))] })
  if (Array.isArray(c.fullJobs)) c.fullJobs = [...new Set(c.fullJobs.map(cleanJob).filter(Boolean))]
  if (old && !old.publicOnly && !old.posBySrc && (old.positions || []).length && (c.srcs || []).some(sn => !seenSrcs.includes(sn))) posBySrc._legacy = old.positions
  seenSrcs.forEach(sn => {
    const sourceRows = rs.filter(r => r.src === sn)
    if (sourceRows.every(r => r.positionsKnown === false)) {
      if (Array.isArray(posBySrc[sn]) && !posBySrc[sn].length) delete posBySrc[sn]
      return // 来源没列岗位，不代表该公司的岗位已经撤下
    }
    const list = []
    sourceRows.filter(r => !r.past && r.positionsKnown !== false).forEach(r => splitPos(r.positions).forEach(p => { if (!list.includes(p)) list.push(p) }))
    // 来源已成功返回这家公司的条目：空列表表示旧岗位不能继续推荐。
    posBySrc[sn] = list.slice(0, 80)
  })
  if (posBySrc._legacy && (c.srcs || []).every(sn => sn in posBySrc)) delete posBySrc._legacy
  const srcJobs = map => [...new Set(Object.values(map || {}).flat().map(cleanJob).filter(Boolean))]
  const sourceJobsChanged = JSON.stringify(srcJobs(posBySrc).sort()) !== JSON.stringify(srcJobs(old && old.posBySrc || {}).sort())
  const knownPositions = rs.some(r => r.positionsKnown !== false)
  c.posBySrc = posBySrc
  const pos = []
  ;[sourceJobsChanged ? [] : (c.fullJobs || []), ...Object.values(posBySrc)].forEach(l => l.forEach(p => { if (!pos.includes(p)) pos.push(p) }))
  c.positions = knownPositions ? pos.slice(0, 80) : [...new Set((old && old.positions || []).map(cleanJob).filter(Boolean))].slice(0, 80)
  const posChanged = JSON.stringify(c.positions) !== JSON.stringify(old && old.positions || [])
  c.note = knownPositions ? short(pos.slice(0, 6).join('、'), 48) : cleanJob(old && old.note || '')
  // 变更记录：截止日期变了、岗位增减（最近 20 条）
  const log = []
  if (old && prev && prev !== c.deadline) log.push(`截止日期 ${prev || '未写'} → ${c.deadline || '未写'}`)
  if (old && (old.positions || []).length) {
    const added = c.positions.filter(p => !old.positions.includes(p)).length
    const removed = old.positions.filter(p => !c.positions.includes(p)).length
    if (added || removed) log.push(`岗位${added ? ' 新增 ' + added + ' 个' : ''}${removed ? ' 撤下 ' + removed + ' 个' : ''}`)
  }
  if (log.length) c.changeLog = [{ at: new Date().toISOString(), what: log.join('；') }, ...(c.changeLog || [])].slice(0, 20)
  // 来源的岗位或截止变了：让公告页重新读一次（完整岗位、学历、截止核对）
  if (old && (sourceJobsChanged && knownPositions && old.posBySrc || (prev && prev !== c.deadline))) {
    delete c.dlChecked; delete c.fullJobs; c.positionsFull = false
  }
  const city = (rs.find(r => r.cities) || {}).cities
  if (city) c.cities = short(city, 36).replace(/ · /g, ',')
  if (!c.batch) c.batch = short([...new Set(rs.map(r => (r.batch || '').replace(/^2027届\s*/, '')).filter(Boolean))].slice(0, 3).join(' / '), 24)
  if (old && (['deadline', 'deadlineText', 'openDate', 'note', 'cities', 'batch'].some(f => old[f] !== c[f]) || posChanged)) c.catalogChangedAt = todayCN()
  c.updated = [c.updated, ...rs.filter(r => !r.past).map(r => r.updated)].filter(Boolean).sort().pop() || ''
  c.seen = todayCN() // 最后一次被采集到，用来判断「招满即止」的公司是否还在招
  const tags = campusTags([c.batch, ...rs.map(r => r.batch)].join(' '), c.company)
  if (tags === null) return null
  c.tags = tags
  c.agency = AGENCY.test(c.company + ' ' + c.note)
  c.v = c.url ? 'official' : (c.srcs.length >= 2 ? 'multi' : 'single')
  c.dl = c.deadline || '9999-12-31'
  // 这一次采集到的批次文字优先（秋招结束后同一家公司常会再开补录 / 春招）
  const nowBatch = [...new Set(rs.map(r => r.batch || '').filter(Boolean))].join(' ')
  c.batchType = batchTypeOf(Object.assign({}, c, { batch: [nowBatch, c.batch].join(' ') }))
  // 已经截止的公司又出现新的截止日期：记一笔「开启新批次」，列表里重新出现
  const today = todayCN()
  if (old && old.dl && old.dl < today && c.dl >= today) {
    c.reopenedAt = today
    c.changeLog = [{ at: new Date().toISOString(), what: `开启新批次（${c.batchType}）` }, ...(c.changeLog || [])].slice(0, 20)
    if (nowBatch) c.batch = short(nowBatch.replace(/^2027届\s*/, ''), 24)
  }
  c.group = groupOf(c.company)
  c.search = `${c.company} ${c.group} ${c.industry} ${c.note} ${c.cities}`.toLowerCase()
  c.key = key
  const coveragePatch = invalidationPatch(old, c)
  if (Object.keys(coveragePatch).length) {
    const audit = { ...old.catalogAudit }
    for (const [path, value] of Object.entries(coveragePatch)) audit[path.slice('catalogAudit.'.length)] = value
    c.catalogAudit = audit
  }
  delete c._id
  return c
}

// 牛企直聘详情页里的「官网投递网址 / 查看公告原文」
async function officialLink (niuqiUrl) {
  const body = await politeGet(niuqiUrl, 'officialLink')
  if (body === null) return null
  const m = body.match(/<a href="(https?:\/\/[^"]+)" class="post-button"/)
  return m && !NOT_OFFICIAL.test(m[1]) ? m[1] : ''
}

// 一次性清理：删掉库里已有的非校招公司，给其余的补上「含社招 / 博士岗」标签
async function migrateCampus (col) {
  const where = { source: 'auto' }
  const { total } = await col.where(where).count()
  const pages = []
  for (let i = 0; i < total; i += 1000) pages.push(col.where(where).skip(i).limit(1000).field({ company: true, batch: true, tags: true }).get())
  const docs = (await Promise.all(pages)).flatMap(r => r.data)
  let removed = 0; let tagged = 0
  const jobs = []
  for (const d of docs) {
    const tags = campusTags(d.batch, d.company)
    if (tags === null) { jobs.push(col.doc(d._id).remove()); removed++ } else if (JSON.stringify(d.tags || []) !== JSON.stringify(tags)) { jobs.push(col.doc(d._id).update({ data: { tags } })); tagged++ }
    if (jobs.length >= 20) await Promise.all(jobs.splice(0))
  }
  await Promise.all(jobs)
  return { scanned: docs.length, removed, tagged }
}

// 一次性整理：给已有公司补上所属集团，并把集团名加进搜索字段
async function migrateGroup (col) {
  const where = { source: 'auto' }
  const { total } = await col.where(where).count()
  const pages = []
  for (let i = 0; i < total; i += 1000) pages.push(col.where(where).skip(i).limit(1000).field({ company: true, group: true, search: true }).get())
  const docs = (await Promise.all(pages)).flatMap(r => r.data)
  let grouped = 0
  const jobs = []
  for (const d of docs) {
    const g = groupOf(d.company)
    if (!g || d.group === g) continue
    jobs.push(col.doc(d._id).update({ data: { group: g, search: `${d.search || ''} ${g}`.toLowerCase() } }))
    grouped++
    if (jobs.length >= 20) await Promise.all(jobs.splice(0))
  }
  await Promise.all(jobs)
  return { scanned: docs.length, grouped }
}

async function runCrawler () {
  started = Date.now()
  sourceRun = Object.create(null)
  const col = db.collection('companies')
  const found = await db.collection('meta').where({ _id: 'crawler' }).limit(1).get()
  const state = found.data[0] || {}
  const lastAttemptAt = new Date().toISOString()
  await db.collection('meta').doc('crawler').set({ data: Object.assign(withoutDocumentId(state), { lastAttemptAt, status: 'running' }) })
  if (state.campusV !== 1) {
    const m = await migrateCampus(col)
    const stats = { at: new Date().toISOString(), migrate: m, ms: Date.now() - started }
    await db.collection('meta').doc('crawler').set({ data: Object.assign(withoutDocumentId(state), { niuqiCursor: state.niuqiCursor || 0, campusV: 1, lastAttemptAt, status: 'partial', last: stats }) })
    console.log(JSON.stringify(stats))
    return stats // 这次只做清理，下次运行再照常采集
  }
  if (state.groupV !== 1) {
    const m = await migrateGroup(col)
    const stats = { at: new Date().toISOString(), migrateGroup: m, ms: Date.now() - started }
    await db.collection('meta').doc('crawler').set({ data: Object.assign(withoutDocumentId(state), { niuqiCursor: state.niuqiCursor || 0, campusV: 1, groupV: 1, lastAttemptAt, status: 'partial', last: stats }) })
    console.log(JSON.stringify(stats))
    return stats
  }

  const curated = (await col.where({ source: 'curated' }).field({ company: true }).limit(200).get()).data
  const curatedKeys = new Set(curated.map(c => companyKey(c.company)))

  // 首页每次都抓；其余请求轮换到更深的页，避免一直重复读取固定的 4/6 页。
  const qzwPlan = rotatedPages(state.qzwCursor, QZW_PAGES, QZW_DEEP_MAX)
  const gmoPlan = rotatedPages(state.gmoCursor, GMO_PAGES, GMO_DEEP_MAX)
  const jobupPlan = rotatedPages(state.jobupCursor, 2, JOBUP_DEEP_MAX)
  const hustPlan = rotatedPages(state.hustCursor, 2, HUST_DEEP_MAX)
  const [qzw, gmo, nq, offerstar, jobup, hust] = await Promise.all([
    srcQiuzhaowang(qzwPlan.pages), srcGivemeoc(gmoPlan.pages),
    srcNiuqi(state.niuqiCursor || 0, state.niuqiDeepCursor || 0), srcOfferstar(), srcJobup(jobupPlan.pages), srcHust(hustPlan.pages)
  ])
  const plans = { qiuzhaowang: qzwPlan.pages.length, givemeoc: gmoPlan.pages.length, niuqi: NIUQI_PER_RUN + 1, offerstar: 1, jobup: jobupPlan.pages.length, hust: hustPlan.pages.length }
  const sourceStatus = summarizeSources(plans, sourceRun)
  const successfulSources = Object.values(sourceStatus).filter(x => x.status === 'ok').length
  const allSourcesOk = successfulSources === Object.keys(plans).length
  const groups = group([...nq.rows, ...qzw, ...gmo, ...offerstar, ...jobup, ...hust], curatedKeys)

  const keys = [...groups.keys()]
  const ids = keys.map(idOf)
  const existing = {}
  for (let i = 0; i < ids.length; i += 100) {
    const r = await col.where({ _id: _.in(ids.slice(i, i + 100)) }).limit(100).get()
    r.data.forEach(d => { existing[d._id] = d })
  }

  let added = 0; let updated = 0; let links = 0; let removed = 0; let skippedStale = 0; let auditConflicts = 0
  const addedBySource = {}
  const weekAgo = new Date(Date.now() + 8 * 3600e3 - 7 * 86400e3).toISOString().slice(0, 10)
  const deepCutoff = new Date(Date.now() + 8 * 3600e3 - 45 * 86400e3).toISOString().slice(0, 10)
  const needLink = []
  const writes = []
  for (const key of keys) {
    const id = idOf(key)
    const old = existing[id]
    const rows = rowsForMerge(old, groups.get(key))
    if (!rows.length) continue
    if (!old && rows.every(r => r.past)) continue // 新公司而且都已截止，不收
    if (!old && rows.every(r => r.deep && !r.deadline && (!r.updated || r.updated < deepCutoff))) { skippedStale++; continue }
    const doc = mergeInto(old, key, rows)
    if (!doc) { // 不是校招
      if (old) { await col.doc(id).remove(); removed++ }
      continue
    }
    const changed = !old || ['deadline', 'deadlineText', 'openDate', 'industry', 'updated', 'v'].some(f => old[f] !== doc[f]) ||
      (old.srcs || []).length !== doc.srcs.length || (old.positions || []).length !== doc.positions.length ||
      old.note !== doc.note || old.cities !== doc.cities || JSON.stringify(old.posBySrc || {}) !== JSON.stringify(doc.posBySrc) ||
      JSON.stringify(old.catalogAudit || {}) !== JSON.stringify(doc.catalogAudit || {}) ||
      JSON.stringify(old.dlBySrc || {}) !== JSON.stringify(doc.dlBySrc) ||
      JSON.stringify(old.tags || []) !== JSON.stringify(doc.tags) ||
      (old.seen || '') < weekAgo // 「最后看到」每周最多写一次
    if (changed) {
      doc.syncId = 'crawler'
      if (!old) doc.addedAt = todayCN() // 新收录，用于「今日新增」
      writes.push(async () => {
        if (!old) await col.doc(id).set({ data: doc })
        else {
        // 只提交采集实际改变的字段，不用旧快照覆盖并行核查新写入的证据。
          const patch = changedFields(old, doc)
          if (Object.keys(patch).length) {
            try { await updateCompanyWithAuditGuard(col, id, old, patch) } catch (e) {
              if (e.code === 'catalog_audit_conflict') { auditConflicts++; return }
              e.message = `company ${id} fields ${Object.keys(patch).join(',')}: ${e.message}`
              throw e
            }
          }
          if (old.v !== doc.v) await col.where({ _id: id, v: old.v }).update({ data: { v: doc.v } })
        }
        if (old) updated++
        else { added++; const src = rows[0].src; addedBySource[src] = (addedBySource[src] || 0) + 1 }
      })
    }
    if (!doc.url && doc.agg.includes('niuqizp.com') && !doc.linkChecked) needLink.push({ id, url: doc.agg })
  }

  // 保持每条公司的快照合并和 patch 顺序，只并发处理不同公司，避免数百次写入逐个等待。
  await forEachLimit(writes, 8, write => write())

  // 剩余时间里给新公司补官方链接
  for (const x of needLink.slice(0, DETAILS_PER_RUN)) {
    const link = await officialLink(x.url)
    if (link === null) break
    const patch = { linkChecked: true }
    if (link) { patch.candidateUrl = link; patch.linkEvidenceV = 0; links++ }
    await col.doc(x.id).update({ data: patch })
  }

  const cutoff = new Date(Date.now() + 8 * 3600e3 - 60 * 86400e3).toISOString().slice(0, 10)
  const alive = _.or([{ deadline: _.neq('') }, { source: _.neq('auto') }, { updated: _.gte(cutoff) }, { seen: _.gte(cutoff) }])
  const total = (await col.where(_.and([{ dl: _.gte(todayCN()) }, alive])).count()).total
  const stats = { at: new Date().toISOString(), fetched: { niuqi: nq.rows.length, qiuzhaowang: qzw.length, givemeoc: gmo.length, offerstar: offerstar.length, jobup: jobup.length, hust: hust.length },
    pages: { qiuzhaowang: qzwPlan.pages, givemeoc: gmoPlan.pages, jobup: jobupPlan.pages, hust: hustPlan.pages, niuqiDeep: NIUQI_INDUSTRIES[state.niuqiDeepCursor || 0][0] },
    companies: keys.length, added, addedBySource, updated, skippedStale, auditConflicts, removed, links, ms: Date.now() - started }
  stats.sources = sourceStatus
  stats.status = allSourcesOk ? 'ok' : successfulSources ? 'partial' : 'error'
  const crawlerPatch = {
    niuqiCursor: cursorAfter(sourceStatus, 'niuqi', state.niuqiCursor, nq.next),
    niuqiDeepCursor: cursorAfter(sourceStatus, 'niuqi', state.niuqiDeepCursor, nq.deepNext),
    qzwCursor: cursorAfter(sourceStatus, 'qiuzhaowang', state.qzwCursor, qzwPlan.next),
    gmoCursor: cursorAfter(sourceStatus, 'givemeoc', state.gmoCursor, gmoPlan.next),
    jobupCursor: cursorAfter(sourceStatus, 'jobup', state.jobupCursor, jobupPlan.next),
    hustCursor: cursorAfter(sourceStatus, 'hust', state.hustCursor, hustPlan.next),
    campusV: 1, groupV: 1, lastAttemptAt, lastSuccessAt: state.lastSuccessAt || '', status: stats.status, sources: sourceStatus, last: Object.assign({}, stats, { sources: sourceStatus })
  }
  if (allSourcesOk) crawlerPatch.lastSuccessAt = stats.at
  await db.collection('meta').doc('crawler').set({ data: crawlerPatch })
  if (successfulSources) {
    const catalogPatch = { updatedAt: todayCN(), companies: total, lastCrawl: stats.at, lastCrawlStatus: stats.status }
    try { await db.collection('meta').doc('catalog').update({ data: catalogPatch }) } catch (e) {
      await db.collection('meta').doc('catalog').set({ data: catalogPatch })
    }
  }
  console.log(JSON.stringify(stats))
  return stats
}

exports.main = async () => {
  const ctx = cloud.getWXContext()
  if (ctx.OPENID || ctx.UID) return { error: 'forbidden', message: '采集任务只允许定时器或管理端调用' }
  const col = db.collection('meta'), now = Date.now(), token = crypto.randomBytes(12).toString('hex')
  const claim = await col.where({ _id: 'crawlerLease', until: _.lt(now) }).update({ data: { until: now + 65000, token } })
  if (!claim.stats.updated) {
    if ((await col.where({ _id: 'crawlerLease' }).limit(1).get()).data.length) return { busy: true }
    try { await col.add({ data: { _id: 'crawlerLease', until: now + 65000, token } }) } catch (e) {
      if ((await col.where({ _id: 'crawlerLease' }).limit(1).get()).data.length) return { busy: true }
      throw e
    }
  }
  try {
    return await runCrawler().catch(async e => {
      const at = new Date().toISOString()
      await col.doc('crawler').update({ data: { lastAttemptAt: at, status: 'error', errorAt: at, error: String(e && e.message || e).slice(0, 300) } }).catch(() => {})
      throw e
    })
  } finally {
    await col.where({ _id: 'crawlerLease', token }).update({ data: { until: Date.now() } })
  }
}

exports._test = { batchTypeOf, mergeInto, rotatedPages, offerstarRows, jobupRows, hustRows, rowsForMerge, niuqiCards, cleanJob, summarizeSources, cursorAfter, forEachLimit, withoutDocumentId, changedFields, companyAuditSnapshotCondition, updateCompanyWithAuditGuard }
