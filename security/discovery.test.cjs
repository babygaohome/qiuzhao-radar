const assert = require('node:assert/strict')
const { canonical, allowed, articleUrl, validate, TOPICS, create, csuFeed, accountQuery, accountIdentity, REGIONS, dateNear, targetCampus, SOURCE_DIRECTORY, mergeSourceDirectory, targetedSource, sourceQuery } = require('../cloudfunctions/api/discovery')
assert.equal(SOURCE_DIRECTORY.length, 11)
const migrationInput = [{accountName:'中国大唐', customNote:'retain me'}, {accountName:'自定义来源', customNote:'retain too'}]
const merged = mergeSourceDirectory(migrationInput)
assert.equal(merged.length, 12)
assert.equal(merged.find(x => x.accountName === '中国大唐').customNote, 'retain me')
assert.equal(mergeSourceDirectory(merged).length, 12)
assert.equal(targetedSource(SOURCE_DIRECTORY, 6).accountName, '国资小新')
assert.equal(targetedSource(SOURCE_DIRECTORY, 14).accountName, '中国大唐')
assert(sourceQuery(targetedSource(SOURCE_DIRECTORY, 6), 2027).includes('国资小新'))
assert(!sourceQuery(targetedSource(SOURCE_DIRECTORY, 6), 2027).includes('undefined'))
assert(SOURCE_DIRECTORY.every(x => !x.verified && !x.biz))
assert.equal(dateNear('发布时间：2026年9月29日', '发布时间'), '2026-09-29')
assert.equal(dateNear('发布时间：2026年2月30日', '发布时间'), '')
assert.equal(targetCampus('2026届校园招聘，须在2027年取得证书', 2027), false)
assert.equal(targetCampus('2027年校园招聘正式启动', 2027), true)
assert.equal(REGIONS.length, 31)
assert(accountQuery(2, 2027).includes('北京'))
assert(accountQuery(6, 2027).includes('天津'))
assert.equal(accountIdentity('https://mp.weixin.qq.com/s/abc', [], '2026-09-30'), null)
assert.equal(accountIdentity('https://mp.weixin.qq.com.evil.com/s?__biz=abc', [], '2026-09-30'), null)
assert.equal(accountIdentity('https://mp.weixin.qq.com/s?__biz=abc', [{biz:'abc',company:'示例公司',verified:true,proofUrl:'https://example.com/about',verifiedAt:'2026-09-29'}], '2026-09-30').company, '示例公司')
assert.equal(articleUrl('https://career.csu.edu.cn/news/index/tag/jcxm'), false)
assert.equal(articleUrl('https://career.csu.edu.cn/campus/view/id/590466'), true)
assert.equal(canonical('http://job.hust.edu.cn/a'), '')
assert.equal(canonical('https://user:pwd@job.hust.edu.cn/a'), '')
assert.equal(canonical('https://job.hust.edu.cn:8443/a'), '')
assert.equal(canonical('https://job.hust.edu.cn/zpinfo1/123.htm?utm_source=x#foo'), 'https://job.hust.edu.cn/zpinfo1/123.htm')
assert.equal(allowed('https://job.hust.edu.cn.evil.com/a', ['job.hust.edu.cn']), false)
assert.equal(allowed('https://www.zhipin.com/a', ['job.hust.edu.cn']), false)
assert.equal(csuFeed('<a href="/campus/view/id/590466">广州港集团有限公司</a><a href="https://evil.com/campus/view/id/2">恶意</a><a href="/campus/view/id/3">行业招聘汇总</a>').length, 1)
assert(TOPICS.some(t => t.includes('会计')) && TOPICS.some(t => t.includes('法务')))
const text = '示例科技有限公司 2027届校园招聘 发布时间：2026-09-29 岗位：法务专员，要求本科，工作地点上海。网申截止：2026-10-15'
const quote = '岗位：法务专员，要求本科，工作地点上海。'
const answer = { company: '示例科技有限公司', published: '2026-09-29', jobs: [{ title: '法务专员', quote, education: '本科', city: '上海', deadline: '2026-10-15' }] }
const check = (a, t = text) => validate(a, t, 'https://job.hust.edu.cn/zpinfo1/123.htm', '2026-09-30', 2027)
assert.equal(check(null).reason, 'invalid_answer')
assert.equal(check({ ...answer, jobs: [null] }).reason, 'jobs_without_original_quote')
const good = check(answer)
assert.equal(good.company, answer.company); assert.equal(good.jobs[0].education, '本科')
assert.equal(good.jobs[0].deadline, undefined) // deadline elsewhere on page must not become job-level requirement
assert.equal(good.jobs[0].cohort, undefined)
assert.equal(check({ ...answer, company: '不存在企业' }).reason, 'company_not_in_original')
assert.equal(check({ ...answer, jobs: [{ title: '交付工程师', quote }] }).reason, 'jobs_without_original_quote')
assert.equal(check(answer, text.replace('2027', '2026')).reason, 'cohort_unknown')
assert.equal(check(answer, text.replace('2026-10-15', '2026-09-15')).reason, 'expired')
assert.equal(check(answer, text.replace('发布时间：2026-09-29', '').replace('网申截止：2026-10-15', '')).reason, 'freshness_unknown')
assert.equal(check({ ...answer, jobs: [{ title: '法务专员', quote, education: '大专' }] }).jobs[0].education, undefined)
assert.equal(check({ ...answer, jobs: [{ title: '法务专员', quote: '法务专员（虚构原文）' }] }).reason, 'jobs_without_original_quote')
// Run the actual two-stage pipeline with deterministic external responses, not a duplicate implementation.
const docs = new Map(), clone = x => JSON.parse(JSON.stringify(x))
const command = { lt: value => ({ lt: value }), set: value => ({ set: value }) }
const matches = (d, q) => Object.entries(q).every(([k,v]) => v && typeof v === 'object' && 'lt' in v ? d[k] < v.lt : d[k] === v)
function collection(name) {
  return { where(q) {
    const query = { orderBy() { return query }, limit(n) { query.n=n; return query }, async get() { return { data: [...docs.values()].filter(d => d.col===name && matches(d,q)).slice(0,query.n || 100).map(d => clone(d)) } }, async update({data}) {
      let updated=0; for(const d of docs.values()) if(d.col===name && matches(d,q)) { for (const [k,v] of Object.entries(data)) d[k] = v && v.set ? clone(v.set) : v; updated++ } return {stats:{updated}}
    } };return query
  }, doc(id) { return { async set({data}) { assert.equal(data._id, undefined, 'reserved _id must not be included in doc.set'); docs.set(name+id, {...clone(data),_id:id,col:name}) }, async update({data}) { const d=docs.get(name+id); if(!d) throw Error('missing'); for(const [k,v] of Object.entries(data)) d[k]=v && v.set ? clone(v.set) : v }, async remove(){docs.delete(name+id)} } }, async add({data}) { if(docs.has(name+data._id)) throw Error('duplicate'); docs.set(name+data._id,{...clone(data),col:name}) } }
}
docs.set('metadiscoverySourceDirectory', {_id:'discoverySourceDirectory', col:'meta', v:1, sources:SOURCE_DIRECTORY.slice(0,6).map((x,i)=>({...x,...(i===0 ? {customNote:'cloud migration retains notes'} : {})}))})
let searches=0, fetches=0
const pipeline=create({ db:{collection}, command, readDoc:async(c,id) => docs.get(c+id) || null,
  search:async() => { searches++;return [{link:'https://job.hust.edu.cn/zpinfo1/123.htm',title:'公告'},{link:'https://www.zhipin.com/a',title:'外部线索'}] },
  fetch:async url => {fetches++;assert(url.startsWith('https://job.hust.edu.cn/'));return text}, extract:async()=>answer, today:()=> '2026-09-30',env:{} })
;(async()=>{
  assert.equal((await pipeline.run()).queued,2)
  assert.equal(docs.get('metadiscoverySourceDirectory').v,2)
  assert.equal(docs.get('metadiscoverySourceDirectory').sources.length,11)
  assert.equal(docs.get('metadiscoverySourceDirectory').sources[0].customNote,'cloud migration retains notes')
  assert.equal((await pipeline.run()).added,1)
  assert.equal(searches,1); assert.equal(fetches,1)
  const company=[...docs.values()].find(d=>d.col==='companies');assert(company)
  assert.equal(company.v,'single');assert.equal(company.url,'');assert.equal(company.owner,undefined)
  assert.equal(company.discoveryEvidence.jobs[0].title,'法务专员')
  assert([...docs.values()].some(d=>d.status==='external'))
  await pipeline.run();assert.equal([...docs.values()].filter(d=>d.col==='companies').length,1)
  console.log('PASS discovery validation and end-to-end staged import, external host exclusion, deduplication')
})().catch(e=>{console.error(e);process.exitCode=1})
