// Public government tables; no model calls, login, cookies, or private user data.
const crypto = require('crypto'), zlib = require('zlib')
const { updateWithCoverageGuard } = require('./audit-coverage')
const FEED = 'https://www.bjmy.gov.cn/zwgk/jy1/', HOSTS = ['www.bjmy.gov.cn']
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0,24)
const text = s => String(s||'').replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v>0&&v<=0x10ffff?String.fromCodePoint(v):''}).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/\s+/g,' ').trim()
const dateOK = s => /^20\d{2}-\d{2}-\d{2}$/.test(s||'') && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s
function safeUrl(s,base=FEED) {try{const u=new URL(s.replace(/&amp;/g,'&'),base);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&HOSTS.includes(u.hostname)?u.href.split('#')[0]:''}catch(_){return ''}}
function pageDate(html,marker) {const m=text(html).replace(/\s/g,'').match(new RegExp(`(?:${marker})[：:]?(20\\d{2})[-/.年](\\d{1,2})[-/.月](\\d{1,2})`));const v=m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:'';return dateOK(v)?v:''}
function eventDate(html) {const m=text(html).replace(/\s/g,'').match(/(20\d{2})年(\d{1,2})月(\d{1,2})日(?:现场|网络)?招聘会/);const v=m?`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`:'';return dateOK(v)?v:''}
function htmlGrids(html) {
 const grids=[]
 for(const table of String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
  const rows=[],carry=new Map()
  for(const tr of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
   if(rows.length>=500)throw Error('too_many_rows');const row=[];let col=0
   const fill=()=>{while(carry.has(col)){const c=carry.get(col);row[col++]=c.value;if(--c.left<=0)carry.delete(col-1)}}
   for(const cell of tr[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
    fill();if(col>=50)throw Error('too_many_columns');const value=text(cell[2]).slice(0,2000)
    const span=a=>{const m=cell[1].match(new RegExp(`${a}=["']?(\\d+)`,'i'));return m?Math.max(1,Math.min(50,Number(m[1]))):1}
    const rs=span('rowspan'),cs=span('colspan')
    for(let i=0;i<cs;i++){row[col]=value;if(rs>1)carry.set(col,{value,left:rs-1});col++}
   }
   fill();if(row.length)rows.push(row)
  }
  grids.push(rows)
 }
 return grids
}
function unzip(buf) {
 if(!Buffer.isBuffer(buf)||buf.length>4e6)throw Error('xlsx_size');let end=-1
 for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50){end=i;break}
 if(end<0)throw Error('xlsx_zip');const n=buf.readUInt16LE(end+10),size=buf.readUInt32LE(end+12),offset=buf.readUInt32LE(end+16)
 if(n>256||offset+size>end)throw Error('xlsx_zip_limits');const files={};let p=offset,expanded=0
 for(let i=0;i<n;i++) {
  if(p+46>buf.length||buf.readUInt32LE(p)!==0x02014b50)throw Error('xlsx_directory')
  const flags=buf.readUInt16LE(p+8),method=buf.readUInt16LE(p+10),compressed=buf.readUInt32LE(p+20),len=buf.readUInt32LE(p+24),nl=buf.readUInt16LE(p+28),el=buf.readUInt16LE(p+30),cl=buf.readUInt16LE(p+32),local=buf.readUInt32LE(p+42)
  if(p+46+nl+el+cl>offset+size)throw Error('xlsx_directory');const name=buf.subarray(p+46,p+46+nl).toString('utf8');p+=46+nl+el+cl
  if(flags&1||name.includes('..')||name.includes('\\')||name.startsWith('/'))throw Error('xlsx_unsafe')
  if(!/^xl\/(?:sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name))continue
  expanded+=len;if(len>4e6||expanded>12e6||compressed>4e6||local+30>buf.length||buf.readUInt32LE(local)!==0x04034b50)throw Error('xlsx_expansion')
  const start=local+30+buf.readUInt16LE(local+26)+buf.readUInt16LE(local+28);if(start+compressed>buf.length)throw Error('xlsx_bounds')
  const raw=buf.subarray(start,start+compressed),out=method===0?raw:method===8?zlib.inflateRawSync(raw,{maxOutputLength:4000000}):null
  if(!out||out.length!==len)throw Error('xlsx_compression');files[name]=out.toString('utf8');if(/<!DOCTYPE|<!ENTITY/i.test(files[name]))throw Error('xlsx_entities')
 }
 return files
}
const column = cell => [...cell.match(/^[A-Z]+/)[0]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1
function xlsxGrids(buf) {
 const files=unzip(buf),strings=[...(files['xl/sharedStrings.xml']||'').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>[...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>text(x[1])).join('')),grids=[]
 for(const [name,xml] of Object.entries(files))if(name.startsWith('xl/worksheets/')){
  const rows=[]
  for(const row of xml.matchAll(/<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
   const ri=Number(row[1])-1;if(ri>=500)throw Error('too_many_rows');const cells=[]
   for(const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
    const ref=(c[1].match(/\br="([A-Z]+\d+)"/)||[])[1];if(!ref)continue;const ci=column(ref);if(ci>=50)throw Error('too_many_columns')
    const type=(c[1].match(/\bt="([^"]+)"/)||[])[1],body=c[2]||'',v=(body.match(/<v[^>]*>([\s\S]*?)<\/v>/)||[])[1]||''
    cells[ci]=type==='s'?strings[Number(v)]||'':type==='inlineStr'?[...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>text(x[1])).join(''):text(v)
   }
   rows[ri]=cells
  }
  let merged=0
  for(const m of xml.matchAll(/<mergeCell\b[^>]*ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/g)){
   if(++merged>256)throw Error('xlsx_merge_limits');const x=column(m[1]),y=Number(m[2])-1,xx=column(m[3]),yy=Number(m[4])-1
   if(xx>=50||yy>=500||xx<x||yy<y)throw Error('xlsx_merge_limits');const value=(rows[y]||[])[x]||''
   for(let r=y;r<=yy;r++){rows[r]=rows[r]||[];for(let c=x;c<=xx;c++)if(!rows[r][c])rows[r][c]=value}
  }
  grids.push(rows)
 }
 return grids
}
function classification(title,qualifications,cohort) {
 const s=title+' '+qualifications,year=new RegExp(`${cohort}(?:年|届)|(?:^|[、,，\\s])${String(cohort).slice(-2)}年`).test(s)&&/应届|应往届|毕业生|毕业/.test(s)
 const type=/实习/.test(title)?'internship':/校园招聘|校招/.test(s)?'campus':/应届|应往届/.test(s)?'graduate':/工作经验|有[^。；，]{0,30}经验|具有[^。；，]{0,30}经验|[\d一二三四五六七八九十]+年以上?经验/.test(s)&&!/无需.{0,8}经验|无工作经验要求|经验不限/.test(s)?'social':'unknown'
 return {type,typeLabel:({campus:'校招',graduate:'应届招聘',internship:'实习',social:'社招',unknown:'招聘对象未明确'})[type],cohort:year?String(cohort):'',eligibilityKnown:year&&['campus','graduate'].includes(type)}
}
function companiesFromGrids(grids,source,cohort=2027) {
 const groups=new Map()
 for(const rows of grids){let head=null,company='',companyRow=0
  for(let i=0;i<rows.length;i++){
   const cells=(rows[i]||[]).map(v=>String(v||'').trim()),norm=cells.map(v=>v.replace(/\s/g,'')),c=norm.findIndex(v=>/^(企业名称|单位名称|招聘单位|用人单位)$/.test(v)),t=norm.findIndex(v=>/^(职位名称|岗位名称|招聘岗位|岗位)$/.test(v))
   if(c>=0&&t>=0){head={company:c,title:t,qual:norm.findIndex(v=>/^(学历要求|招聘条件|岗位要求|任职要求|资格条件)$/.test(v)),salary:norm.findIndex(v=>/薪资|工资|待遇/.test(v))};company='';continue}
   if(!head||head.qual<0)continue
   if(cells[head.company]&&cells[head.company]!==company){company=cells[head.company];companyRow=i+1}const title=cells[head.title]||'',qualifications=cells[head.qual]||''
   if(!company||company.length>100||!/公司|集团|事务所|学校|医院|研究院|中心/.test(company)||!title||title.length>80||!qualifications)continue
   if(groups.size>=30&&!groups.has(company))throw Error('too_many_companies')
   const kind=classification(title,qualifications,cohort),education=(qualifications.match(/(?:大学|全日制)?(?:大专|专科|本科|硕士|博士|高中|中专)(?:及以上学历|以上学历|及以上|以上)?/)||[])[0]||''
   const job={title,qualifications,education,salary:cells[head.salary]||'',...kind,sourceUrl:source.attachmentUrl||source.url,sourcePageUrl:source.url,row:i+1,companyRow,evidence:{name:title,education:qualifications,company}}
   const list=groups.get(company)||[];if(!list.some(j=>j.title===title&&j.qualifications===qualifications))list.push(job);groups.set(company,list.slice(0,40))
  }
 }
 return [...groups].map(([company,jobs])=>({company,jobs,source}))
}
function pageLinks(html,base=FEED){const results=[];for(const m of String(html).matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){const url=safeUrl(m[1],base),title=text(m[2]);if(url&&/招聘会岗位信息/.test(title)&&!results.some(x=>x.url===url))results.push({url,title})}return results.slice(0,6)}
function parsePage(html,url,day,cohort=2027){const published=pageDate(html,'发布时间|发布日期'),fairDate=eventDate(html);if(!published||published>day)return {reason:'publication_unknown'};if(fairDate&&fairDate<day)return {reason:'expired_fair'};if(!fairDate&&published<new Date(Date.parse(day)-45*86400e3).toISOString().slice(0,10))return {reason:'stale'};const source={url,published,fairDate,sourceName:'密云人社公开岗位表',scope:'government_job_table'},companies=companiesFromGrids(htmlGrids(html),source,cohort),attachments=[...String(html).matchAll(/href=["']([^"']+\.xlsx(?:\?[^"']*)?)["']/gi)].map(m=>safeUrl(m[1],url)).filter(Boolean).slice(0,2);return {companies,attachments,source,reason:!companies.length&&!attachments.length?'no_job_table':''}}
function companyKey(name){let s=name.replace(/[（(][^）)]*[）)]/g,'').replace(/\s/g,'').toLowerCase().replace(/(股份有限公司|有限责任公司|集团有限公司|有限公司|集团|控股|股份|公司)$/,'');return s.startsWith('中国')&&s.length>=6?s.slice(2):s}
function create({db,command:_,readDoc,fetchRaw,fetchBytes,today}) {
 const meta=db.collection('meta')
 let feedDidQueue=false
 async function step(){const day=today(),stat={at:new Date().toISOString(),feed:0,processed:0,added:0,enriched:0,skipped:0},queue=(await meta.where({kind:'governmentTable',status:'pending'}).orderBy('at','asc').limit(1).get()).data[0]
  if(!queue){feedDidQueue=false;const state=await readDoc('meta','publicJobsFeed')||{};if(state.day===day&&(state.reads||0)>=4)return {...stat,reason:'feed_daily_limit'};await meta.doc('publicJobsFeed').set({data:{day,reads:state.day===day?(state.reads||0)+1:1}});const html=await fetchRaw(FEED);stat.feed=1;if(!html)return {...stat,reason:'feed_unreachable'};for(const x of pageLinks(html)){if(eventDate(x.title)&&eventDate(x.title)<day)continue;const id='gov_'+hash(x.url);const old=await readDoc('meta',id);if(old){if(old.status==='imported' && old.fairDate>=day && old.checkedAt<new Date(Date.now()-3*86400e3).toISOString()){await meta.doc(id).update({data:{status:'pending',cursor:0}});feedDidQueue=true;}continue}try{await meta.add({data:{_id:id,kind:'governmentTable',status:'pending',...x,at:stat.at,cursor:0}});feedDidQueue=true}catch(e){if(!(await readDoc('meta',id)))throw e}}await meta.doc('publicJobsFeed').set({data:{day,reads:state.day===day?(state.reads||0)+1:1,last:stat}});return stat}
  stat.processed=1;if(!safeUrl(queue.url))return {...stat,reason:'host_not_allowed'};const html=await fetchRaw(queue.url);if(!html){const attempts=(queue.attempts||0)+1;await meta.doc(queue._id).update({data:{attempts,status:attempts>=3?'review':'pending',reason:'page_unreachable'}});return {...stat,reason:'page_unreachable'}};const parsed=parsePage(html,queue.url,day)
  if(parsed.reason){await meta.doc(queue._id).update({data:{status:'review',reason:parsed.reason,checkedAt:stat.at}});return {...stat,reason:parsed.reason}}
  for(const url of parsed.attachments){const bytes=await fetchBytes(url);if(!bytes){await meta.doc(queue._id).update({data:{status:'review',reason:'attachment_unreachable'}});return {...stat,reason:'attachment_unreachable'}}try{parsed.companies.push(...companiesFromGrids(xlsxGrids(bytes),{...parsed.source,attachmentUrl:url},2027))}catch(e){await meta.doc(queue._id).update({data:{status:'review',reason:'unsupported_attachment'}});return {...stat,reason:'unsupported_attachment'}}}
  const merged=new Map();for(const item of parsed.companies){const old=merged.get(item.company);if(!old)merged.set(item.company,item);else for(const j of item.jobs)if(!old.jobs.some(x=>x.title===j.title&&x.qualifications===j.qualifications))old.jobs.push(j)}parsed.companies=[...merged.values()];
  const signatureFinal=hash(JSON.stringify(parsed.companies));
  if(queue.signature&&queue.signature!==signatureFinal){await meta.doc(queue._id).update({data:{cursor:0,signature:signatureFinal}});return {...stat,reason:'source_changed_restart'}}
  const cursor=queue.cursor||0,batch=parsed.companies.slice(cursor,cursor+3)
  for(const item of batch){const key=companyKey(item.company),id='a'+crypto.createHash('sha1').update(key).digest('hex').slice(0,10),old=await readDoc('companies',id),campus=item.jobs.filter(j=>j.eligibilityKnown),publicOnly=!campus.length,patch={publicJobs:_.set(item.jobs),publicSource:_.set(item.source),publicUpdatedAt:day}
   if(old){if(!old.owner&&old.key===key){await updateWithCoverageGuard({db,command:_,id,patch,nextTitleFields:{publicJobs:item.jobs}});stat.enriched++}else stat.skipped++}
   else{const degree=j=>(j.education.match(/大专|专科|本科|硕士|博士/)||[])[0]||'';const rank={大专:0,专科:0,本科:1,硕士:2,博士:3};const minEdu=campus.length&&campus.every(j=>degree(j))?campus.map(degree).sort((a,b)=>rank[a]-rank[b])[0].replace('专科','大专'):'';const positions=(publicOnly?item.jobs:campus).map(j=>j.title),type=publicOnly?(new Set(item.jobs.map(j=>j.type)).size===1?item.jobs[0].type:'mixed'):'graduate',labels={social:'社招',unknown:'招聘对象未明确',internship:'实习',mixed:'多类公开岗位',graduate:'应届招聘'},doc={_id:id,key,company:item.company,source:'auto',industry:'其他',url:'',agg:queue.url,srcs:['密云人社公开岗位表'],group:item.company,publicOnly,...(minEdu?{minEdu}:{}),recruitmentType:type,positions,note:positions.slice(0,6).join('、'),cities:'',batch:(publicOnly?'':'2027届')+labels[type],tags:[labels[type]],deadline:'',dl:item.source.fairDate||'9999-12-31',deadlineText:item.source.fairDate?'招聘会 '+item.source.fairDate:'未公布',openDate:'',updated:item.source.published,addedAt:day,seen:day,v:'single',syncId:'publicJobs',publicJobs:item.jobs,publicSource:item.source,search:(item.company+' '+positions.join(' ')+' 北京').toLowerCase()};try{await db.collection('companies').add({data:doc});stat.added++}catch(e){if(!(await readDoc('companies',id)))throw e}}
  }
  await meta.doc(queue._id).update({data:{cursor:cursor+batch.length,signature:signatureFinal,status:cursor+batch.length>=parsed.companies.length?'imported':'pending',fairDate:parsed.source.fairDate,companies:parsed.companies.length,checkedAt:stat.at}});await meta.doc('publicJobsLast').set({data:stat});return stat
 }
 async function run(){
  const now=Date.now(),token=crypto.randomBytes(12).toString('hex'),id='publicJobsLease'
  const got=await meta.where({_id:id,until:_.lt(now)}).update({data:{until:now+55000,token}})
  if(!got.stats.updated){if(await readDoc('meta',id))return {busy:true};try{await meta.add({data:{_id:id,until:now+55000,token}})}catch(e){if(await readDoc('meta',id))return {busy:true};throw e}}
  try{let result=await step();if(result.feed===1&&feedDidQueue){const next=await step();result={...next,feed:1}}await meta.doc('publicJobsLast').set({data:result});return result}
  catch(e){await meta.doc('publicJobsLast').set({data:{at:new Date().toISOString(),error:e.code||'public_jobs_failed'}});throw e}
  finally{await meta.where({_id:id,token}).update({data:{until:Date.now()-1}})}
 }
 return {run}
}
module.exports={create,htmlGrids,xlsxGrids,companiesFromGrids,classification,parsePage,pageLinks,safeUrl}
