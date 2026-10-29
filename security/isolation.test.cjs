// Run: node qiuzhao-mp/security/isolation.test.cjs
// Exercises production handlers with an in-memory wx-server-sdk. No cloud writes or API calls.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x))
const op = (kind, value) => ({ __op: kind, value })
const command = new Proxy({}, { get: (_, k) => (...xs) => op(k, ['and', 'or'].includes(k) ? xs[0] : xs[0]) })
const get = (o, key) => key.split('.').reduce((v, k) => v && v[k], o)
function matchValue (v, q) {
  if (!q || !q.__op) return v === q
  const x = q.value
  switch (q.__op) {
    case 'eq': return v === x
    case 'neq': return v !== x
    case 'exists': return (v !== undefined) === x
    case 'in': return x.includes(v)
    case 'nin': return !x.includes(v)
    case 'gte': return v >= x
    case 'lte': return v <= x
    case 'lt': return v < x
    case 'regex': return new RegExp(x.regexp, x.options).test(v || '')
    default: throw Error('unsupported query ' + q.__op)
  }
}
function matches (row, q = {}) {
  if (q.__op === 'and') return q.value.every(x => matches(row, x))
  if (q.__op === 'or') return q.value.some(x => matches(row, x))
  return Object.entries(q).every(([k, v]) => matchValue(get(row, k), v))
}
function patch (row, data) {
  for (const [key, raw] of Object.entries(data)) {
    const parts = key.split('.'); const leaf = parts.pop()
    let parent = row
    for (const part of parts) parent = parent[part] || (parent[part] = {})
    if (raw && raw.__op === 'remove') delete parent[leaf]
    else if (raw && raw.__op === 'inc') parent[leaf] = (parent[leaf] || 0) + raw.value
    else if (raw && raw.__op === 'addToSet') parent[leaf] = [...new Set([...(parent[leaf] || []), raw.value])]
    else parent[leaf] = clone(raw && raw.__op === 'set' ? raw.value : raw)
  }
}
function harness () {
  const tables = {}; let seq = 0; let identity = 'A'; let fetchBody = ''; let evidence = ''; let chatCalls = 0; let modelAnswer = {}; let modelCalls = 0
  const table = n => tables[n] || (tables[n] = new Map())
  const db = { command, RegExp: q => op('regex', q), serverDate: () => new Date().toISOString(), createCollection: async () => ({}),
    collection (name) {
      const data = table(name)
      function query (condition = {}, projection = null, cap = Infinity, skip = 0) {
        const rows = () => [...data.values()].filter(r => matches(r, condition)).slice(skip, skip + cap)
        return {
          where: q => query(q, projection, cap, skip), limit: n => query(condition, projection, n, skip),
          skip: n => query(condition, projection, cap, n), orderBy: () => query(condition, projection, cap, skip),
          field: p => query(condition, p, cap, skip),
          async get () { return { data: rows().map(r => {
            if (!projection) return clone(r)
            const inclusive = Object.values(projection).some(Boolean)
            const out = inclusive ? { _id: r._id } : clone(r)
            for (const [k, v] of Object.entries(projection)) { if (v && r[k] !== undefined) out[k] = clone(r[k]); else if (!v) delete out[k] }
            return out
          }) } },
          async count () { return { total: rows().length } },
          async update ({ data: p }) { const r = rows(); r.forEach(x => patch(x, p)); return { stats: { updated: r.length } } },
          async remove () { const r = rows(); r.forEach(x => data.delete(x._id)); return { stats: { removed: r.length } } }
        }
      }
      return Object.assign(query(), {
        doc (id) { return {
          async get () { if (!data.has(id)) throw Error('not found'); return { data: clone(data.get(id)) } },
          async set ({ data: p }) { data.set(id, { ...clone(p), _id: id }); return {} },
          async update ({ data: p }) { const r = data.get(id); if (r) patch(r, p); return { stats: { updated: r ? 1 : 0 } } },
          async remove () { return { stats: { removed: data.delete(id) ? 1 : 0 } } }
        } },
        async add ({ data: p }) { const id = p._id || 'new' + ++seq; if (data.has(id)) throw Error('duplicate'); data.set(id, { ...clone(p), _id: id }); return { _id: id } }
      })
    }
  }
  const sdk = { init () {}, DYNAMIC_CURRENT_ENV: 'test', database: () => db, getWXContext: () => ({ OPENID: identity }) }
  const box = { exports: {}, require: n => n === 'wx-server-sdk' ? sdk : n.startsWith('.') ? require(path.resolve(root, 'cloudfunctions/api', n)) : require(n), process: { env: { AI_WEB_SEARCH: 'mock', ADMIN_OPENIDS: 'ADMIN' } }, console: { log () {}, error () {} }, Buffer, URL, setTimeout, clearTimeout }
  vm.createContext(box)
  vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8') + `
    politeText = async url => mockFetch(url);
    fetchText = async () => mockEvidence();
    checkUrl = async () => true;
    chatSearch = async () => mockChat();
    chatJSON = async () => mockModel();
    exports.audit = { extractOriginalLink, recruitmentEvidenceMatches, enrichFromSource, ncssCampusHit, findOnNcss, applyNcss, ncssFeedStep, feedId, feedKey, watchAccept, ncssWatchStep, WATCH_ALIASES, siteAnnouncements, officialWatchStep, atsEdu, COHORT27 };`, Object.assign(box, {
    mockFetch: url => typeof fetchBody === 'function' ? fetchBody(url) : fetchBody,
    mockEvidence: () => evidence,
    mockModel: () => { modelCalls++; return typeof modelAnswer === 'function' ? modelAnswer() : clone(modelAnswer) },
    mockChat: () => { chatCalls++; return { content: JSON.stringify({ questions: [{ cat: '综合', q: 'test question', tip: 'test tip' }] }), refs: [] } }
  }))
  return { tables, db, sdk, box, table, call: (who, action, extra = {}) => { identity = who; return box.exports.main({ action, ...extra }) }, setFetch: s => { fetchBody = s }, setEvidence: s => { evidence = s }, setModel: x => { modelAnswer = x }, chatCalls: () => chatCalls, modelCalls: () => modelCalls }
}
let passed = 0
function check (value, message) { assert.ok(value, message); passed++ }
async function run () {
  const h = harness()
  const put = (col, id, d) => h.table(col).set(id, { ...clone(d), _id: id })
  put('companies', 'public', { company: '公共企业', source: 'auto', v: 'official', dl: '9999-12-31', deadline: '2026-12-31' })
  put('companies', 'govOnly', { company:'公开招聘测试公司',source:'auto',v:'official',publicOnly:true,positions:['交付工程师'],note:'交付工程师',dl:'9999-12-31',deadline:'',seen:'9999-12-31',publicJobs:[{title:'交付工程师',qualifications:'本科及以上，3年工作经验'}],publicSource:{fairDate:'9999-12-31',published:'2026-10-01'} })
  check(!(await h.call('A','list',{tab:'verified'})).items.some(x=>x._id==='govOnly'),'social/unknown public role leaked into default campus list')
  check((await h.call('A','list',{tab:'public'})).items.some(x=>x._id==='govOnly'),'public recruitment tab cannot show public role')
  check(h.box.exports._test.rankAll([h.table('companies').get('govOnly')],{role:'交付',major:'',city:'',edu:'大专',industries:[],ctypes:[]},{keywords:[],industries:[]}).list.length===0,'public-only role leaked into AI ranking')
  h.table('companies').delete('govOnly')
  put('companies', 'privateA', { company: 'A私有企业', source: 'manual', owner: 'A', dl: '9999-12-31', note: 'A_PRIVATE_NOTE' })
  put('companies', 'privateB', { company: 'B私有企业', source: 'manual', owner: 'B', dl: '9999-12-31', note: 'B_PRIVATE_NOTE' })
  for (const who of ['A', 'B']) {
    put('profiles', who, { profile: { role: who + '_ROLE' }, materials: [{ id: 'm', title: '自我介绍', content: who + '_MATERIAL' }], offers: [{ id: 'o', company: who + '_OFFER' }], plans: [{ id: 'p', name: who + '_PLAN', profile: { role: who + '_ROLE' } }], curPlan: 'p' })
    put('apps', who + '_public', { openid: who, cid: 'public', company: '公共企业', status: 'applied', note: who + '_APP_NOTE', events: [{ type: '一面', at: '2026-12-01 12:00', note: who + '_EVENT' }] })
    put('reminders', who, { openid: who, cid: 'public', sent: false, note: who + '_REMINDER' })
  }
  for (const action of ['getProfile', 'getMaterials', 'getOffers', 'getPlans', 'myApps', 'myReminders', 'exportMine']) {
    const a = JSON.stringify(await h.call('A', action, { openid: 'B', owner: 'B' }))
    check(!a.includes('B_ROLE') && !a.includes('B_MATERIAL') && !a.includes('B_OFFER') && !a.includes('B_APP_NOTE') && !a.includes('B_EVENT') && !a.includes('B_PLAN') && !a.includes('B_REMINDER'), action + ' leaked B data')
  }
  for (const who of ['A', 'B']) {
    const other = who === 'A' ? 'B' : 'A'
    const id = 'private' + other
    check((await h.call(who, 'get', { id })).error === 'not_found', 'foreign private detail')
    check(!(await h.call(who, 'many', { ids: [id] })).companies[id], 'foreign private bulk')
    check(!(await h.call(who, 'list', { q: '', tab: 'verified' })).items.some(x => x._id === id), 'foreign private list')
    for (const action of ['saveApp', 'jobs', 'verifyCompany', 'findOfficial', 'findExam', 'aboutCompany', 'interviewPrep', 'tailorMaterial', 'getMatchContext', 'matchJob']) {
      check((await h.call(who, action, { id, status: 'want', content: 'sample' })).error === 'not_found', action + ' foreign private access')
    }
    check((await h.call(who, 'saveJob', { id, data: { company: 'tampered' } })).error === 'forbidden', 'foreign company edit')
    check((await h.call(who, 'deleteJob', { id })).error === 'forbidden', 'foreign company delete')
  }
  await h.call('A', 'saveApp', { id: 'public', status: 'interview', openid: 'B', note: 'A_CHANGED' })
  check(h.table('apps').get('B_public').note === 'B_APP_NOTE', 'forged identity changed B app')
  put('companies', 'unmark', { company: '取消标记示例', source: 'auto', v: 'official', dl: '9999-12-31' })
  await h.call('A', 'saveApp', { id: 'unmark', status: 'want', note: '保留的私人备注' })
  await h.call('A', 'saveApp', { id: 'unmark', status: '' })
  check(h.table('apps').get('A_unmark').status === '' && h.table('apps').get('A_unmark').note === '保留的私人备注', 'unmark lost private note')
  check(!(await h.call('A', 'myApps')).items.some(x => x.company._id === 'unmark'), 'unmarked record still shown in My Applications')
  check((await h.call('A', 'get', { id: 'unmark' })).app.note === '保留的私人备注', 'unmarked note cannot be recovered from company detail')
  await h.call('A', 'saveMaterials', { materials: [{ id: 'm', title: 't', content: 'A_CHANGED_MATERIAL' }], openid: 'B' })
  check(h.table('profiles').get('B').materials[0].content === 'B_MATERIAL', 'forged identity changed B material')
  await h.call('A', 'saveOffers', { offers: [{ id: 'o', company: 'A_CHANGED_OFFER' }], openid: 'B' })
  check(h.table('profiles').get('B').offers[0].company === 'B_OFFER', 'forged identity changed B offers')
  put('companies', 'jdPublic', { company: '公开JD企业', source: 'auto', v: 'official', minEdu: '本科', positions: ['售前工程师'], dl: '9999-12-31', deadline: '2026-11-30' })
  const jd = '交付工程师，2027届，专科及以上，工作城市深圳，截止2026年12月31日。要求Linux，要求SQL。'
  const resume = '我的学历是大专，我部署Linux服务。'
  h.setModel({ evidence: { name: { value: '交付工程师', quote: '交付工程师' }, cohort: { value: '2027', quote: '2027届' }, edu: { value: '大专', quote: '专科及以上' }, city: { value: '深圳', quote: '工作城市深圳' }, deadline: { value: '2026-12-31', quote: '截止2026年12月31日' } },
    matches: [{ requirement: 'Linux', jdQuote: '要求Linux', resumeQuote: '我部署Linux服务', reason: '有部署证据' }, { requirement: '编造技能', jdQuote: '不存在要求', resumeQuote: '我有十年经验' }], gaps: [{ requirement: 'SQL', jdQuote: '要求SQL', reason: '材料没有说明SQL经历' }], unknown: ['薪资尚未说明'] })
  const match = await h.call('A', 'matchJob', { id: 'jdPublic', role: '交付', jd, resume, openid: 'B' })
  check(!match.error && match.evidence.fields.length === 5 && match.evidence.fields.every(x => x.scope === 'job'), 'five quoted job fields not extracted')
  check(match.analysis.matches.length === 1 && match.analysis.gaps.length === 1 && match.analysis.unknown.includes('薪资尚未说明'), 'invented comparison evidence not discarded')
  check(!h.table('profiles').get('B').jdMatches && !h.table('companies').get('jdPublic').jdMatches, 'personal analysis escaped account')
  check(!(await h.call('B', 'getMatchContext', { id: 'jdPublic', role: '交付' })).previous, 'B received A comparison')
  check((await h.call('A', 'getMatchContext', { id: 'jdPublic', role: '交付' })).previous.analysis.matches[0].resumeQuote === '我部署Linux服务', 'own saved comparison unavailable')
  const savedCount = h.table('profiles').get('A').jdMatches.length
  await h.call('A', 'matchJob', { id: 'jdPublic', role: '不保存的演示岗位', jd, resume, previewOnly: true })
  check(h.table('profiles').get('A').jdMatches.length === savedCount, 'preview-only analysis stored in private recommendations')
  h.table('profiles').get('B').materials[0].id = 'Bonly'
  check((await h.call('A', 'matchJob', { id: 'jdPublic', jd, materialIds: ['Bonly'], resume: '' })).error === 'invalid', 'foreign materials selected')
  const aPick = await h.call('A', 'aiPick', { profile: { role: '交付', edu: '大专' } })
  const bPick = await h.call('B', 'aiPick', { profile: { role: '交付', edu: '大专' } })
  check(aPick.ranked.some(x => x.id === 'jdPublic' && x.jobEvidence), 'own specific JD not applied to recommendations')
  check(aPick.ranked.find(x => x.id === 'jdPublic').dl === '2026-12-31', 'deadline sorting used company date instead of individual JD')
  check(!bPick.ranked.some(x => x.id === 'jdPublic'), 'A private JD influenced B recommendation or company degree overrode job degree')
  const jm = require(path.join(root, 'cloudfunctions/api/job-match.js'))
  const badFields = jm.validatedEvidence({ edu: { value: '大专', quote: '本科及以上' }, city: { value: '北京', quote: '工作城市深圳' } }, '本科及以上，工作城市深圳')
  check(badFields.every(x => x.scope === 'unknown'), 'value/quote contradictions accepted')
  check(jm.validatedEvidence({ deadline: { value: '2026-02-31', quote: '截止2026年2月31日' } }, '截止2026年2月31日').find(x => x.key === 'deadline').scope === 'unknown', 'invalid calendar deadline accepted')
  check(!jm.forRole({ _id: 'jdPublic' }, [Object.assign({}, match, { at: '2020-01-01' })], '交付'), 'stale personal evidence reused')
  await h.call('A', 'hide', { id: 'public', openid: 'B' })
  check(!h.table('profiles').get('B').hidden, 'hide affected B preferences')
  put('apps', 'A_privateB', { openid: 'A', cid: 'privateB', company: 'own snapshot', status: 'want' })
  check(!JSON.stringify(await h.call('A', 'myApps')).includes('B_PRIVATE_NOTE'), 'myApps read foreign manual company')
  await h.call('A', 'reportIssue', { id: 'public', type: '其他', note: 'PRIVATE_REPORT_NOTE' })
  for (const action of ['get', 'many', 'list']) {
    check(!JSON.stringify(await h.call('B', action, { id: 'public', ids: ['public'], tab: 'verified' })).includes('PRIVATE_REPORT_NOTE'), 'report note exposed in ' + action)
  }
  {
    const coverage = require(path.join(root, 'cloudfunctions/api/audit-coverage.js'))
    const dispAudit = { company: '反馈测试企业', positions: ['反馈测试岗位'] }
    put('companies', 'disp', { ...dispAudit, source: 'auto', v: 'official', hasOrig: true, dl: '9999-12-31', deadline: '2099-12-31', search: '反馈测试企业', catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: coverage.coverageFingerprint(dispAudit), proofMethod: 'browser_official', checkedAt: '2026-10-22T10:00:00.000Z', jobs: { '反馈测试岗位': { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' } } } })
    const inVerified = async () => (await h.call('A', 'list', { tab: 'verified', q: '' })).items.some(x => x._id === 'disp')
    check(await inVerified(), 'dispute fixture not verified at start')
    await h.call('A', 'reportIssue', { id: 'disp', type: '岗位已下架' })
    await h.call('A', 'reportIssue', { id: 'disp', type: '岗位已下架' })
    check(!h.table('companies').get('disp').disputed, 'same user counted twice for dispute')
    await h.call('B', 'reportIssue', { id: 'disp', type: '岗位已下架' })
    const d = h.table('companies').get('disp')
    check(d.disputed === true && d.disputeType === '岗位已下架' && !(await inVerified()), 'two reports did not move company to leads')
    check((await h.call('A', 'list', { tab: 'leads' })).items.some(x => x._id === 'disp'), 'disputed company missing from leads')
    h.table('companies').delete('disp')
  }
  await h.call('A', 'interviewPrep', { id: 'public', role: '交付' })
  await h.call('B', 'interviewPrep', { id: 'public', role: '交付' })
  check(h.chatCalls() === 2 && h.table('preps').size === 2, 'interview prep cache shared between users')
  await h.call('A', 'interviewPrep', { id: 'public', role: '交付' })
  check(h.chatCalls() === 2, 'own cache not reused')
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  const oldDate = new Date(Date.now() + 8 * 3600e3 - 5 * 86400e3).toISOString().slice(0, 10)
  const day = n => new Date(Date.now() + 8 * 3600e3 + n * 86400e3).toISOString().slice(0, 10)
  put('companies', 'soon', { company: '快截止企业', source: 'auto', v: 'official', dl: day(2), deadline: day(2) })
  put('apps', 'A_soon', { openid: 'A', cid: 'soon', company: '快截止企业', status: 'want', events: [{ type: '笔试', at: day(1) + ' 19:00' }] })
  put('apps', 'A_old', { openid: 'A', cid: 'public', company: '公共企业', status: 'applied', appliedAt: day(-20), events: [] })
  const todoA = await h.call('A', 'todo', {})
  const kinds = todoA.items.map(x => x.kind).sort().join(',')
  check(kinds === 'deadline,event,follow', 'todo kinds wrong: ' + kinds)
  check(todoA.items[0].kind === 'deadline' && /2 天后/.test(todoA.items[0].text), 'todo deadline first')
  check(!(await h.call('B', 'todo', {})).items.some(x => x.id === 'soon'), 'B sees A todo')
  h.table('apps').delete('A_soon'); h.table('apps').delete('A_old')
  const common = { company: 'recent fixture', source: 'auto', dl: '9999-12-31', deadline: '', seen: today }
  const verifiedCatalog = row => {
    const record = { ...row, positions: ['软件工程师'] }
    const coverage = require(path.join(root, 'cloudfunctions/api/audit-coverage.js'))
    return { ...record, catalogAudit: { state: 'verified', coverageComplete: true, coverageFingerprint: coverage.coverageFingerprint(record), proofMethod: 'browser_official', jobs: { 软件工程师: { exists: true, cohort: 'matched', open: true, officialSource: 'confirmed' } } } }
  }
  put('companies', 'newVerified', verifiedCatalog({ ...common, v: 'official', addedAt: today, updated: today }))
  put('companies', 'newLead', { ...common, v: 'single', addedAt: today, updated: today })
  put('companies', 'updateVerified', verifiedCatalog({ ...common, v: 'official', addedAt: oldDate, updated: today }))
  put('companies', 'updateLead', { ...common, v: 'single', addedAt: oldDate, updated: today })
  put('companies', 'legacyUpdate', { ...common, v: 'single', updated: today })
  put('companies', 'observedUpdate', verifiedCatalog({ ...common, v: 'official', addedAt: oldDate, updated: oldDate, catalogChangedAt: today }))
  put('companies', 'hiddenNew', { ...common, v: 'single', addedAt: today })
  put('companies', 'expiredNew', { ...common, dl: oldDate, addedAt: today })
  h.table('companies').get('privateA').addedAt = today
  h.table('companies').get('privateB').addedAt = today
  h.table('profiles').get('A').hidden = ['hiddenNew']
  const summary = (await h.call('A', 'stats', { withRecent: true })).recent
  check(summary.new.total === 3 && summary.new.pending === 2, 'new summary counts own private and legacy pending rows, excludes expired/hidden/foreign records: ' + JSON.stringify(summary.new))
  check(summary.updated.total === 4 && summary.updated.pending === 2, 'updated summary excludes newly added and includes legacy/observed business changes: ' + JSON.stringify(summary.updated))
  const newRows = (await h.call('A', 'list', { tab: 'recent', recentKind: 'new' })).items
  const updatedRows = (await h.call('A', 'list', { tab: 'recent', recentKind: 'updated' })).items
  check(newRows.length === summary.new.total && newRows.some(x => x._id === 'newLead'), 'new entry differs from summary or hides pending')
  check(updatedRows.length === summary.updated.total, 'update entry differs from summary')
  check(!newRows.some(x => updatedRows.some(y => y._id === x._id)), 'new and updated double-counted')
  check(!(await h.call('A', 'list', { tab: 'verified', recentKind: 'new' })).items.some(x => x._id === 'newLead'), 'normal verified tab bypassed')
  let page
  const front = { Page: p => { page = p }, require: () => ({ api: async () => ({}), decorate: x => x, cn: x => x }), Date, setTimeout, clearTimeout }
  vm.createContext(front); vm.runInContext(fs.readFileSync(path.join(root, 'miniprogram/pages/index/index.js'), 'utf8'), front)
  const view = { ...page, data: { ...clone(page.data), q: '旧搜索', industry: '银行', official: true, scopeIdx: 2, ctypeIdx: 1 }, setData (p) { Object.assign(this.data, p) }, reload () {} }
  view.showRecent({ currentTarget: { dataset: { kind: 'new' } } })
  check(view.filters().tab === 'recent' && view.filters().recentKind === 'new' && !view.data.q && !view.data.official && !view.data.scopeIdx, 'new click failed to clear incompatible filters')
  view.showRecent({ currentTarget: { dataset: { kind: 'updated' } } })
  check(view.filters().sort === 'updated' && view.filters().recentKind === 'updated', 'updated click selects wrong order')
  view.onTab({ currentTarget: { dataset: { k: 'verified' } } })
  check(view.data.recentKind === '' && view.data.fresh === false, 'leaving recent view retains hidden filters')
  for (const action of Object.keys(h.box.exports._test.handlers)) {
    check((await h.call(undefined, action, { id: 'public', confirm: '确认删除' })).error === 'unauthenticated', 'missing identity allowed ' + action)
  }
  check((await h.call('A', 'sweep')).error === 'forbidden', 'ordinary member sweep')
  check((await h.call('A', 'constructor')).error === 'unknown_action', 'prototype action dispatch')
  const backup = await h.call('A', 'exportMine')
  check(backup.v === 2 && backup.companies.every(c => c.id !== 'privateB') && backup.plans[0].name === 'A_PLAN', 'backup scope or completeness')
  const restored = await h.call('C', 'importMine', { data: backup })
  check(!restored.error && [...h.table('companies').values()].some(x => x.owner === 'C' && x.company === 'A私有企业'), 'restore manual company into own account')
  check(h.table('companies').get('privateA').owner === 'A', 'restore changed original owner')
  check(h.table('profiles').get('C').plans[0].profile.role === 'A_ROLE', 'restore plan failed')
  check((await h.call('A', 'importMine', { data: { app: '秋招雷达', v: 1, apps: [{ cid: 'privateB', note: 'tamper' }] } })).skipped === 1, 'restore foreign company id')
  await h.call('A', 'deleteAllMine', { confirm: '确认删除', openid: 'B' })
  check(!h.table('profiles').get('A').jdMatches, 'private comparison survives delete all')
  check(h.table('profiles').get('B').materials[0].content === 'B_MATERIAL' && h.table('apps').has('B_public') && h.table('companies').has('privateB'), 'delete-all touched B')
  check([...h.table('preps').values()].every(x => x.openid !== 'A') && [...h.table('preps').values()].some(x => x.openid === 'B'), 'delete prep scope')
  put('companies', 'markup', { company: '测试企业', source: 'auto', v: 'official', dl: '9999-12-31', batch: '补录', positionsFull: true,
    positions: ['研发培训生（客户解决方案方向）', 'class="job-postion">研发培训生（客户解决方案方向）'], note: 'class="job-postion">研发培训生（客户解决方案方向）' })
  const cleanDetail = await h.call('A', 'get', { id: 'markup' })
  const cleanJobs = await h.call('A', 'jobs', { id: 'markup' })
  check(cleanDetail.company.positions.length === 1 && cleanDetail.company.positions[0] === '研发培训生（客户解决方案方向）' && cleanDetail.company.note === '研发培训生（客户解决方案方向）', 'detail returned duplicate job or stored HTML attribute')
  check(cleanJobs.positions.length === 1 && cleanJobs.positions[0] === '研发培训生（客户解决方案方向）', 'jobs handler returned duplicate job or stored HTML attribute')
  const cleanPickup = await h.call('A', 'pickup')
  check(cleanPickup.items.find(x => x._id === 'markup').note === '研发培训生（客户解决方案方向）', 'pickup card returned stored HTML attribute')
  const audit = h.box.exports.audit
  for (const ip of ['127.0.0.1', '169.254.169.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe90::1', 'fd00::1']) {
    check(h.box.exports._test.isPrivateIP(ip), 'internal IP allowed ' + ip)
    check(await h.box.exports._test.safeTarget('http://' + (ip.includes(':') ? '[' + ip + ']' : ip)) === null, 'internal fetch allowed ' + ip)
  }
  check(!h.box.exports._test.isPrivateIP('::ffff:808:808'), 'public mapped IP incorrectly blocked')
  check(audit.recruitmentEvidenceMatches('星河科技2027届校园招聘', '星河科技有限公司'), 'valid origin content rejected')
  check(!audit.recruitmentEvidenceMatches('星河科技2026届校园招聘', '星河科技有限公司'), 'old origin accepted')
  check(!audit.recruitmentEvidenceMatches('另一家企业2027届校园招聘', '星河科技有限公司'), 'wrong employer origin accepted')
  check(audit.extractOriginalLink('<script src="https://assets.example.net/ad.js"></script><a href="https://employer.example.com/campus/2027">公告原文</a>') === 'https://employer.example.com/campus/2027', 'original link picked script')
  check(audit.extractOriginalLink('<script src="https://assets.example.net/ad.js"></script>') === '', 'asset counted as evidence')
  check(audit.extractOriginalLink("<div class=\"message-content\">由原始发布方&#8220;企业公众号&#8221;负责。<span id='JumpUrlTxt'>&#104;ttps://mp.weixin.qq.com/s/u7S6aeK8Vwef9RAEYiKf4A</span><button class=\"copy-btn\">复制</button></div>") === 'https://mp.weixin.qq.com/s/u7S6aeK8Vwef9RAEYiKf4A', 'real niuqi source page (JumpUrlTxt span) not parsed')
  const base = { recName: '星河科技有限公司', publishDate: Date.now(), sourcesNameCh: '某大学就业网', degreeName: '本科', jobId: 'sample' }
  check(!audit.ncssCampusHit({ ...base, jobName: '高级交付工程师（需5年经验）' }, '星河科技有限公司'), 'social job accepted')
  check(!audit.ncssCampusHit({ ...base, jobName: '2026届校园招聘' }, '星河科技有限公司'), 'wrong cohort accepted')
  check(!audit.ncssCampusHit({ ...base, jobName: '2027届校园招聘', endDate: '2026-01-01' }, '星河科技有限公司'), 'expired job accepted')
  check(!audit.ncssCampusHit({ ...base, recName: '星河科技服务有限公司', jobName: '2027届校招' }, '星河科技有限公司'), 'different company accepted')
  check(audit.ncssCampusHit({ ...base, jobName: '2027届校园招聘 交付工程师' }, '星河科技有限公司'), 'valid campus job rejected')
  check(audit.ncssCampusHit({ ...base, recName: '常州星河科技股份有限公司', jobName: '软件研发工程师' }, '星河科技'), 'region-prefixed employer with plain job title rejected')
  check(!audit.ncssCampusHit({ ...base, recName: '浙江省杭州市星河科技有限公司', jobName: '软件研发工程师' }, '星河科技'), 'long prefix employer accepted')
  check(!audit.ncssCampusHit({ ...base, recName: '星河有限公司', jobName: '软件研发工程师' }, '星河'), 'two-character name matched')
  check(audit.recruitmentEvidenceMatches('中信期货2027届校园招聘正式启动', '中信期货前海', '中信期货'), 'group-name origin rejected')
  check(!audit.recruitmentEvidenceMatches('中信期货2027届校园招聘正式启动', '中信期货前海'), 'subsidiary matched without group')
  {
    const job = (recName, extra = {}) => ({ recName, jobName: '研发工程师', publishDate: Date.now(), sourcesType: '12', sourcesNameCh: '南京邮电大学', degreeName: '本科及以上', jobId: 'j' + recName.length, areaCodeName: '江苏', ...extra })
    put('companies', audit.feedId(audit.feedKey('同惠电子')), { company: '同惠电子', source: 'auto', v: 'single', dl: '9999-12-31', positions: ['测试工程师'] })
    h.setFetch(JSON.stringify({ data: { list: [
      job('常州市同惠电子股份有限公司'), job('江苏新星科技有限公司'),
      job('某某人力资源服务有限公司'), job('商业平台转发科技有限公司', { sourcesType: '0', sourcesNameCh: '智联招聘' }),
      job('社招示例科技有限公司', { jobName: '高级工程师（需5年经验）' }), job('北京网聘咨询有限公司'), job('寒假工示例食品有限公司', { jobName: '食品生产寒假工' })
    ] } }))
    const fs = await audit.ncssFeedStep(Date.now() + 9000, {})
    const merged = h.table('companies').get(audit.feedId(audit.feedKey('同惠电子')))
    check(merged.instOk === true && merged.positions.includes('研发工程师') && merged.positions.includes('测试工程师'), 'feed did not enrich region-prefixed existing company: ' + JSON.stringify({ fs, merged }))
    const added = h.table('companies').get(audit.feedId(audit.feedKey('江苏新星科技有限公司')))
    check(added && added.instOk && added.srcs[0] === '国家大学生就业服务平台' && added.minEdu === '本科', 'feed did not add institution-posted company')
    check(!h.table('companies').get(audit.feedId(audit.feedKey('某某人力资源服务有限公司'))), 'agency company added')
    check(!h.table('companies').get(audit.feedId(audit.feedKey('商业平台转发科技有限公司'))), 'commercial-platform job counted')
    check(!h.table('companies').get(audit.feedId(audit.feedKey('社招示例科技有限公司'))), 'social job counted')
    check(fs.added >= 1 && fs.enriched >= 1, 'feed stat wrong ' + JSON.stringify(fs))
    const ann = audit.siteAnnouncements('<li><a href="/zp/2027.html" title="中国示例集团有限公司2027年校园招聘公告">中国示例集团2027年校园招…</a></li><li><a href="https://mp.weixin.qq.com/s/x">2026届高校毕业生拟录用公示（2027）</a></li><li><a href="/zp/old.html">2026年校园招聘公告</a></li>', 'https://www.example.cn/zp/list.html')
    check(ann.length === 1 && ann[0].url === 'https://www.example.cn/zp/2027.html' && /2027年校园招聘公告/.test(ann[0].title), 'official list parsing wrong: ' + JSON.stringify(ann))
    check(audit.atsEdu(['本科及以上', '硕士及以上']) === '本科' && audit.atsEdu(['本科及以上', '']) === '' && audit.atsEdu(['2027届专科及以上学历']) === '大专', 'ats education rule wrong')
    check(audit.COHORT27('2027届校园招聘 研发岗') && !audit.COHORT27('2026届校园招聘') && !audit.COHORT27('社会招聘 2027年度'), 'ats cohort rule wrong')
    const wa = audit.watchAccept
    check(wa('鞍钢')('鞍钢建设集团有限公司') && wa('鞍钢')('辽宁鞍钢冷轧有限公司'), 'two-char alias with place prefix rejected')
    check(!wa('华电')('北京中华电力设备有限公司'), 'two-char alias matched mid-name')
    check(wa('华侨城')('天津华侨城实业有限公司欢乐谷分公司'), 'three-char alias with place prefix rejected')
    check(audit.WATCH_ALIASES.length > 200 && !audit.WATCH_ALIASES.some(w => w.alias === '大华'), 'watchlist aliases not loaded or unsafe alias kept')
    check(!h.table('companies').get(audit.feedId(audit.feedKey('北京网聘咨询有限公司'))), 'proxy recruiter added')
    check(!h.table('companies').get(audit.feedId(audit.feedKey('寒假工示例食品有限公司'))), 'temporary job counted')
  }
  h.setFetch(JSON.stringify({ data: { list: [{ ...base, jobName: '高级交付工程师（需5年经验）' }] } }))
  put('companies', 'ncss', { company: '星河科技有限公司', source: 'auto', instOk: true })
  await audit.applyNcss(h.table('companies').get('ncss'))
  check(h.table('companies').get('ncss').instOk === false, 'legacy false institution verification retained')
  h.setFetch(url => url.includes('out.niuqizp') ? '<a href="https://employer.example.com/2027">公告原文</a>' : '<h1>星河科技2027届校招</h1>')
  h.setEvidence('另一家企业2027届校园招聘')
  put('companies', 'evidence', { company: '星河科技有限公司', agg: 'https://campus.niuqizp.com/schedule-abc123.html', hasOrig: true, origUrl: 'https://old.example.com' })
  await audit.enrichFromSource(h.table('companies').get('evidence'))
  check(!h.table('companies').get('evidence').hasOrig && !h.table('companies').get('evidence').origUrl, 'unrelated linked page counted as official')
  const cb = { exports: {}, require: n => n === 'wx-server-sdk' ? h.sdk : require(n), console, process, Buffer, URL, setTimeout }
  vm.createContext(cb); vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/crawler/index.js'), 'utf8'), cb)
  const old = { company: '示例企业', source: 'auto', srcs: ['牛企直聘'], posBySrc: { 牛企直聘: ['交付工程师'] }, fullJobs: ['交付工程师'], positions: ['交付工程师'], note: '交付工程师', batch: '2027届校招', deadline: '2026-12-01', dlBySrc: { 牛企直聘: '2026-12-01' }, cities: '北京' }
  const next = cb.exports._test.mergeInto(old, 'demo', [{ company: '示例企业', src: '牛企直聘', positions: '', batch: '2027届校招', deadline: '2026-12-01', cities: '上海', updated: '2026-09-27', past: false }])
  check(next.positions.length === 0 && next.note === '' && next.cities === '上海', 'stale positions or cities retained')
  check(next.catalogChangedAt === today, 'crawler business change not counted as recent activity')
  const pages = cb.exports._test.rotatedPages(18, 4, 19)
  check(JSON.stringify([...pages.pages]) === '[1,18,19,2]' && pages.next === 3, 'crawler page rotation skipped or repeated the homepage')
  const row = (year, kind) => `<tr class="ant-table-row"><td>示例企业</td><td>${year}届校园招聘</td><td>${year}届</td><td>09-27</td><td>会计,法务</td><td>北京</td><td>专业服务</td><td>${kind}</td><td>尽快投递</td><td><a href="https://example.com">投递</a></td></tr>`
  const offered = cb.exports._test.offerstarRows(row(2027, '校招') + row(2026, '校招') + row(2027, '实习'))
  check(offered.length === 1 && offered[0].positions === '会计,法务' && offered[0].url === 'https://www.offerstar.cn/recruitment', 'new source admitted wrong cohort or unverified link')
  const partial = [{ src: '秋招网', deep: true, positions: '旧岗位' }, { src: '秋招网', deep: false, positions: '当前岗位' }]
  check(cb.exports._test.rowsForMerge(old, partial).length === 1 && cb.exports._test.rowsForMerge(old, partial)[0].positions === '当前岗位', 'deep page overwrote existing company positions')
  check(cb.exports._test.rowsForMerge(null, partial).length === 2, 'deep page cannot discover an untracked company')
  const jobRow = batch => `<tr><td>260927001</td><td>09-27</td><td>文科企业</td><td>教育</td><td>民营</td><td>英文编辑、法务</td><td>北京</td><td></td><td></td><td></td><td>${batch}</td><td>2026-11-25</td><td></td><td></td></tr>`
  const jobTable = `<table class="job-table"><tbody>${jobRow('27秋招')}${jobRow('26秋招')}</tbody></table>`
  const jobup = cb.exports._test.jobupRows(jobTable, 2)
  check(jobup.length === 1 && jobup[0].company === '文科企业' && jobup[0].url === 'https://jobup.cn/?page=2', 'JOBUP source accepted wrong cohort or failed to preserve source')
  const schoolRow = (title, date) => `<li><h4><a href="/zpinfo1/123.htm">${title}</a></h4><time>[${date}]</time></li>`
  const school = cb.exports._test.hustRows(schoolRow('示例教育2027届校园招聘', today) + schoolRow('示例教育2026届校园招聘', today) + schoolRow('示例教育2027届实习招聘', today), 1)
  check(school.length === 1 && school[0].company === '示例教育' && school[0].url === 'https://job.hust.edu.cn/zpinfo1/123.htm', 'school source accepted wrong cohort or internship')
  const schoolOld = Object.assign({}, old, { deadlineText: '', openDate: '', updated: today })
  const schoolMerged = cb.exports._test.mergeInto(schoolOld, 'demo', [{ company: '示例企业', src: '华科就业网', batch: '2027届校招', positions: '', positionsKnown: false, updated: today }])
  check(schoolMerged.positions.includes('交付工程师') && schoolMerged.fullJobs.includes('交付工程师') && !schoolMerged.catalogChangedAt, 'school listing without jobs erased existing position evidence')
  const schoolWithoutFull = cb.exports._test.mergeInto(Object.assign({}, schoolOld, { fullJobs: undefined }), 'demo', [{ company: '示例企业', src: '华科就业网', batch: '2027届校招', positions: '', positionsKnown: false, updated: today }])
  check(schoolWithoutFull.note === '交付工程师' && !schoolWithoutFull.catalogChangedAt, 'school listing without jobs cleared existing summary')
  const bt = cb.exports._test.batchTypeOf
  check(bt({ batch: '2027届春季校园招聘' }) === '春招' && bt({ batch: '秋招补录' }) === '补录' && bt({ batch: '提前批' }) === '提前批' && bt({ batch: '提前批 + 正式批' }) === '秋招' && bt({ batch: '2027届校招', openDate: '2026-09-01' }) === '秋招' && bt({ batch: '', addedAt: '2027-03-02' }) === '春招' && bt({ publicOnly: true }) === '公开招聘', 'batch type classification wrong')
  const ended = Object.assign({}, old, { deadline: '2026-01-01', dl: '2026-01-01', dlBySrc: { 牛企直聘: '2026-01-01' }, batch: '2027届校招' })
  const reopened = cb.exports._test.mergeInto(ended, 'demo', [{ company: '示例企业', src: '牛企直聘', positions: '交付工程师', batch: '2027届秋招补录', deadline: '2099-12-01', cities: '北京', updated: today, past: false }])
  check(reopened.dl >= today && reopened.batchType === '补录' && reopened.reopenedAt === today && /开启新批次（补录）/.test((reopened.changeLog || [])[0].what), 'ended company reopened without new-batch record: ' + JSON.stringify([reopened.dl, reopened.batchType, reopened.reopenedAt]))
  const nqHtml = '<article class="schedule-card"><span class="schedule-card-tags">校招</span><div class="schedule-card-company"><a href="/schedule-demo.html" title="示例企业">示例企业</a></div><h4 class="schedule-card-title">2027届校园招聘</h4><span class="job-postion">研发培训生（客户解决方案方向）</span></article>'
  const nqJobs = cb.exports._test.niuqiCards(nqHtml)
  check(nqJobs.length === 1 && nqJobs[0].positions === '研发培训生（客户解决方案方向）', 'niuqi position parser leaked HTML attributes')
  check(cb.exports._test.cleanJob('class="job-postion">研发培训生（客户解决方案方向）') === '研发培训生（客户解决方案方向）', 'stored position markup was not cleaned')
  check((await cb.exports.main({ Type: 'timer' })).error === 'forbidden', 'client can spoof crawler timer')
  const rb = { exports: {}, require: n => n === 'wx-server-sdk' ? h.sdk : n === './template.json' ? { templateId: 'test', fields: {} } : require(n), console, process, Buffer, URL, setTimeout }
  vm.createContext(rb); vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/remind/index.js'), 'utf8'), rb)
  check((await rb.exports.main({ Type: 'timer' })).error === 'forbidden', 'client can trigger reminders')
  const ext = h.box.exports._test.cleanPickExtras({ keywords: Array.from({ length: 1000 }, (_, i) => '岗位' + i).concat('<script>'), industries: Array(100).fill('银行') })
  check(ext.keywords.length === 30 && ext.industries.length === 1, 'AI input amplification not bounded')
  check(h.box.exports._test.cleanPickExtras({ keywords: 'wrong-type', industries: {} }).keywords.length === 0, 'malformed keyword input accepted')
  const nc = h.box.exports._test.notNiuqiCond()
  for (const url of ['https://www.offerstar.cn/recruitment', 'https://jobup.cn/?page=1', 'https://job.hust.edu.cn/zpinfo1/123.htm']) check(matches({ agg: url }, nc), 'new source omitted from verification queue')
  const isolated = harness()
  isolated.setEvidence('另一家公司2027届校园招聘')
  check(!!await isolated.box.exports._test.recruitmentLinkReason('https://employer.example.com/campus', ['https://employer.example.com/campus'], '星河科技'), 'unrelated page promoted to official')
  isolated.setEvidence('星河科技2027届校园招聘')
  check(await isolated.box.exports._test.recruitmentLinkReason('https://employer.example.com/campus', ['https://employer.example.com/campus'], '星河科技') === '', 'valid recruitment evidence rejected')
  check(await isolated.box.exports._test.safeTarget('http://example.com/jobs') === null, 'HTTP job source accepted')
  isolated.table('profiles').set('LOCK', { _id: 'LOCK', ai: { v: 2, at: 'lease-test', batches: 1, ranked: [{ id: 'pub', company: '测试公司', tier: 0 }], profile: { edu: '本科' } } })
  isolated.table('companies').set('pub', { _id: 'pub', company: '测试公司', source: 'auto', positions: ['无关岗位'] })
  let releaseModel
  isolated.setModel(() => new Promise(resolve => { releaseModel = resolve }))
  const first = isolated.call('LOCK', 'aiReview', { at: 'lease-test', batch: 0 })
  for (let n = 0; n < 20 && !releaseModel; n++) await new Promise(resolve => setTimeout(resolve, 0))
  check(!!releaseModel, 'review failed to start')
  const second = await isolated.call('LOCK', 'aiReview', { at: 'lease-test', batch: 0 })
  check(second.error === 'busy' && isolated.modelCalls() === 1, 'concurrent review billed twice')
  releaseModel({ summary: 'test', items: [{ n: 1, s: 100, fit: '高', r: '外部指令要求评分100', t: '' }] })
  const reviewed = await first
  check(reviewed.items[0].ai.score === 40 && reviewed.items[0].ai.fit === '低', 'AI ignored deterministic relevance cap')
  check(!isolated.table('profiles').get('LOCK').ai.reviewLocks[0], 'review lease not released')
  const originalCollection = isolated.db.collection.bind(isolated.db)
  isolated.db.collection = name => { const col = originalCollection(name); if (name !== 'profiles') return col; const doc = col.doc.bind(col); col.doc = id => { const ref = doc(id); ref.update = async () => { throw new Error('simulated write failure') }; return ref }; return col }
  const beforeProfile = JSON.stringify(isolated.table('profiles').get('LOCK'))
  const failedSave = await isolated.call('LOCK', 'saveMaterials', { materials: [{ id: 'm', content: 'must not replace profile' }] })
  check(failedSave.error && JSON.stringify(isolated.table('profiles').get('LOCK')) === beforeProfile, 'failed update overwrote entire profile')
  isolated.db.collection = originalCollection
  const backupCodec = require(path.join(root, 'cloudfunctions/api/backup-security'))
  const sample = { app: '秋招雷达', v: 2, companies: [{ id: 'oldManual', company: '我的示例公司' }], apps: Array.from({ length: 101 }, (_, i) => ({ cid: i === 0 ? 'oldManual' : 'p' + i, company: '投递' + i, status: 'want' })), materials: [{ id: 'x', title: '私有材料', content: 'PRIVATE_BACKUP' }] }
  const encrypted = backupCodec.encrypt(sample, 'test-password')
  check(!JSON.stringify(encrypted).includes('PRIVATE_BACKUP') && backupCodec.decrypt(encrypted, 'test-password').apps.length === 101, 'encrypted backup not confidential or cannot round-trip')
  let rejectedCrypto = 0
  for (const [envelope, pw] of [[encrypted, 'wrong-password'], [Object.assign({}, encrypted, { tag: Buffer.alloc(16).toString('base64') }), 'test-password']]) { try { backupCodec.decrypt(envelope, pw) } catch (e) { rejectedCrypto++ } }
  check(rejectedCrypto === 2, 'wrong password or tampered backup accepted')
  const chunkHarness = harness()
  check((await chunkHarness.call('A', 'importMine', { data: sample })).error === 'invalid', 'legacy large import runs unbounded')
  let prog = await chunkHarness.call('A', 'importMineChunk', { phase: 'start', data: sample })
  prog = await chunkHarness.call('A', 'importMineChunk', { phase: prog.phase, session: prog.session, data: sample })
  check(chunkHarness.table('companies').size === 1 && [...chunkHarness.table('companies').values()][0].owner === 'A', 'import manual ownership wrong')
  const replay = await chunkHarness.call('A', 'importMineChunk', { phase: 'companies', session: prog.session, data: sample })
  check(replay.phase === 'apps' && chunkHarness.table('companies').size === 1, 'replay duplicated manual company')
  prog = await chunkHarness.call('A', 'importMineChunk', { phase: prog.phase, session: prog.session, data: sample })
  check(prog.apps === 50 && chunkHarness.table('apps').size === 50, 'import app chunk not bounded')
  prog = await chunkHarness.call('A', 'importMineChunk', { phase: 'start', data: sample })
  check(prog.apps === 50, 'resuming import lost cursor')
  while (!prog.done) prog = await chunkHarness.call('A', 'importMineChunk', { phase: prog.phase, session: prog.session, data: sample })
  check(prog.restored === 101 && chunkHarness.table('apps').size === 101 && chunkHarness.table('profiles').get('A').materials[0].content === 'PRIVATE_BACKUP', 'chunk restore incomplete')
  const foreignImport = await chunkHarness.call('B', 'importMineChunk', { phase: 'apps', session: prog.session, data: sample })
  check(foreignImport.error === 'stale' && !chunkHarness.table('profiles').has('B'), 'import session escaped account')
  const budgetHarness = harness()
  budgetHarness.box.process.env.AI_DAILY_CAP = '2'
  const budgetAttempts = await Promise.allSettled(Array.from({ length: 5 }, () => budgetHarness.box.exports._test.takeModelBudget()))
  check(budgetAttempts.filter(x => x.status === 'fulfilled').length === 2 && budgetHarness.table('meta').get('aiUsage').n === 2, 'cold concurrent model requests exceeded global cap')
  const EventEmitter = require('node:events')
  for (const [status, expected] of [[200, true], [403, false], [302, false]]) {
    const fakeHttps = { request (opts, cb) { const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {}; req.end = () => cb({ statusCode: status, resume () {} }); return req } }
    const netbox = { exports: {}, require: n => n === 'wx-server-sdk' ? h.sdk : n === 'https' ? fakeHttps : n.startsWith('.') ? require(path.resolve(root, 'cloudfunctions/api', n)) : require(n), process: { env: {} }, console, Buffer, URL, setTimeout, clearTimeout }
    vm.createContext(netbox); vm.runInContext(fs.readFileSync(path.join(root, 'cloudfunctions/api/index.js'), 'utf8') + '\nsafeTarget = async url => ({ u: new URL(url), address: "8.8.8.8", family: 4 }); exports.urlCheck = checkUrl;', netbox)
    check(await netbox.exports.urlCheck('https://example.com/campus') === expected, '403 or redirect accepted as reachable official page')
  }
  console.log(`PASS ${passed} assertions: user isolation, authorization, encrypted/chunked backup, evidence, quotas and crawler regressions`)
}
run().catch(e => { console.error(e); process.exitCode = 1 })
