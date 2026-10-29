'use strict'

const MAX_ISSUES = 100

function titleRows (company) {
  const rows = new Map()
  const add = value => {
    const raw = typeof value === 'string' ? value : value && typeof value.title === 'string' ? value.title : ''
    const title = raw.trim()
    if (!title) return
    const key = title.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ')
    if (!rows.has(key)) rows.set(key, title)
  }
  for (const field of ['positions', 'fullJobs', 'publicJobs']) {
    if (Array.isArray(company[field])) company[field].forEach(add)
  }
  for (const jobs of Object.values(company.posBySrc || {})) if (Array.isArray(jobs)) jobs.forEach(add)
  if (company.discoveryEvidence && Array.isArray(company.discoveryEvidence.jobs)) company.discoveryEvidence.jobs.forEach(add)
  return [...rows.values()]
}

function titleIssue (title, companyName = '') {
  if (/(?:\.{2,}|…{1,}|⋯{1,})/.test(title)) return 'truncated_or_ellipsis'
  if (/等\s*[0-9一二三四五六七八九十百千万两]+\s*(?:类岗位|个方向)/.test(title)) return 'counted_roles_placeholder'
  if (/岗位信息待确认/.test(title)) return 'role_information_pending_confirmation'
  if (/详见[^，。；;]{0,12}(?:招聘|官网)/.test(title)) return 'see_recruitment_or_website'
  if (/未在海报中明确列出/.test(title)) return 'not_listed_in_poster'
  if (/^其他$/.test(title)) return 'generic_other'

  // Avoid flagging actual role names such as “算法工程师-2027校招”.
  const roleText = String(title).replace(companyName ? new RegExp(companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : /$^/, ' ')
  const concreteRole = /工程师|专员|助理|岗位|职位|岗(?:位)?|经理|主管|分析师|研究员|管培生|管理培训生|技术培训生|匠培生|开发|设计师|运营|销售|教师|医师|医生|会计|财务|法务|法律事务|人力资源|技术员|顾问|科员|主办|实验员|架构师|程序员|博士后|技师|电焊工|钳工|数控操作工|科研设计员|冷作工|无损检测工|审计员|税审员|硬件研发|软件研发|研发(?:支持|类|岗)|电力电子硬件|培训生|资金类|资产管理类|成本管理类|项目管理类|数字化管理类|行政管理类|综合职能|营销管理|制造技术|供应链|内容策划|品牌策划|策划|编导|主播|媒介|产品研发|产品策划|信息安全|综合采购|采购|海外技术支持|用户增长|市场类|合伙人|客户经理|柜员|热力系统|(?:^|\b)(?:intern(?:ship)?|engineer|manager|analyst|associate|specialist|developer|designer|trainee|researcher|consultant|sales|marketing|finance|accounting|operations|product|sre)(?:\b|$)/i
  const separatedRole = /(?:校招|秋招|春招)\s*[-—:：]\s*[A-Za-z][A-Za-z0-9+./ -]{1,40}$/i.test(roleText)
  const announcement = /(?:校园招聘|校招|招聘公告|招聘简章|招聘计划|招聘信息|招聘通知|公开招聘|应届生招聘|应届招聘|秋招|春招|实习生招聘)/
  if (announcement.test(title) && !concreteRole.test(roleText) && !separatedRole) return 'announcement_title_not_specific_role'
  return ''
}

function analyzeCompany (company) {
  if (!company || !['auto', 'curated'].includes(company.source) || company.owner !== undefined) return null
  const titleIssues = []
  for (const title of titleRows(company)) {
    const reason = titleIssue(title, company.company || company.group || '')
    if (reason) {
      titleIssues.push({ title: title.slice(0, 400), reason })
      if (titleIssues.length >= MAX_ISSUES) break
    }
  }
  if (!titleIssues.length) return null
  return { requiresReview: true, titleIssues, scope: 'field_quality_only' }
}

module.exports = { analyzeCompany, titleRows, titleIssue, MAX_ISSUES }
