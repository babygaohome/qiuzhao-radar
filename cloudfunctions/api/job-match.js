// Evidence validation is deterministic; model output never becomes shared company data.
const norm = x => String(x || '').replace(/\s+/g, '').toLowerCase()
const trim = (x, n = 160) => String(x || '').trim().slice(0, n)
const fields = [['name', '岗位'], ['cohort', '届次'], ['edu', '学历'], ['city', '城市'], ['deadline', '截止']]
const degrees = { 大专: 0, 本科: 1, 硕士: 2, 博士: 3 }
const degreeOf = text => /大专|专科|高职/.test(text) ? '大专' : /本科|学士/.test(text) ? '本科' : /硕士/.test(text) ? '硕士' : /博士/.test(text) ? '博士' : ''
function validatedEvidence (raw, jd) {
  return fields.map(([key, label]) => {
    const field = (raw || {})[key] || {}
    let value = trim(field.value, 60); const quote = trim(field.quote)
    let valid = !!value && !!quote && norm(jd).includes(norm(quote))
    if (key === 'edu') valid = valid && value in degrees && degreeOf(quote) === value
    else if (key === 'cohort') valid = valid && norm(quote).includes(norm(value))
    else if (key === 'deadline') valid = valid && /^20\d{2}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && (() => {
      const [y, m, d] = value.split('-').map(Number)
      const numbers = quote.match(/\d+/g) || []
      return new Date(value).toISOString().slice(0, 10) === value && numbers.map(Number).includes(y) && numbers.map(Number).includes(m) && numbers.map(Number).includes(d)
    })()
    else valid = valid && value.split(/[、,，]/).filter(Boolean).every(v => norm(quote).includes(norm(v)))
    return { key, label, value: valid ? value : '未确认', quote: valid ? quote : '', scope: valid ? 'job' : 'unknown' }
  })
}
function comparison (raw, jd, resume) {
  const verified = (text, quote) => !!quote && norm(text).includes(norm(quote))
  const clean = (items, kind) => (Array.isArray(items) ? items : []).slice(0, 8).flatMap(x => {
    if (!x || typeof x !== 'object') return []
    const requirement = trim(x.requirement, 100); const jdQuote = trim(x.jdQuote); const resumeQuote = trim(x.resumeQuote)
    if (!requirement || !verified(jd, jdQuote)) return []
    if (kind === 'matches' && !verified(resume, resumeQuote)) return []
    return [{ requirement, jdQuote, resumeQuote: kind === 'matches' ? resumeQuote : '', reason: trim(x.reason, 180) }]
  })
  const matches = clean(raw.matches, 'matches')
  const gaps = clean(raw.gaps, 'gaps').filter(x => !matches.some(m => norm(m.jdQuote) === norm(x.jdQuote)))
  const unknown = (Array.isArray(raw.unknown) ? raw.unknown : []).map(x => trim(x, 120)).filter(Boolean).slice(0, 8)
  return { matches, gaps, unknown }
}
function companyEvidence (c, role) {
  const url = c.origUrl || c.url || (c.ncss || {}).url || c.agg || ''
  const values = { name: role, cohort: c.batch, edu: c.minEdu ? c.minEdu + '及以上' : '', city: c.cities, deadline: c.deadline }
  return { level: 'company', url, source: c.origUrl || c.url ? '公司招聘渠道' : (c.ncss || {}).url ? '就业平台职位' : '汇总站线索',
    fields: fields.map(([key, label]) => ({ key, label, value: trim(values[key], 60) || '未确认', scope: key === 'name' ? 'unknown' : 'company', quote: '' })),
    note: '这是公司级信息，不能证明该岗位的学历、城市或截止要求。粘贴这个岗位的 JD 后逐项核对。' }
}
function forRole (c, results, role) {
  const words = String(role || '').split(/[\s、,，]+/).filter(Boolean)
  const match = (results || []).find(x => {
    const title = ((x.evidence || {}).fields || []).find(f => f.key === 'name' && f.scope === 'job')
    return x.cid === c._id && Date.now() - Date.parse(x.at || '') < 7 * 86400e3 && title && words.some(w => norm(title.value).includes(norm(w)))
  })
  return match ? { fields: match.evidence.fields, url: match.evidence.url, source: match.evidence.source, at: match.at } : null
}
module.exports = { validatedEvidence, comparison, companyEvidence, forRole, degrees }
