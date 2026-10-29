const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '..')
const utils = require(path.join(root, 'miniprogram/utils/util.js'))
let definition, company
vm.runInNewContext(fs.readFileSync(path.join(root, 'miniprogram/pages/detail/detail.js'), 'utf8'), {
  require: name => name.includes('util') ? Object.assign({}, utils, { api: async () => ({ company, app: {}, me: {} }) }) : { remindTmplId: '' },
  Page: page => { definition = page }, wx: { setNavigationBarTitle() {} }, getApp: () => ({ globalData: {} }),
  setTimeout, clearTimeout, console
})
async function check(status, text) {
  company = { _id: 'public', company: 'Sample', source: 'auto', dl: '9999-12-31', deadline: '', deadlineText: '未公布', positions: [], manualReview: { status, at: '2026-10-22T05:00:00.000Z', reason: 'Evidence scoped to checked job', evidenceUrls: [] } }
  const page = Object.assign({}, definition, { id: 'public', data: {}, setData(data) { Object.assign(this.data, data) }, loadJobs() {}, loadTalks() {}, loadSiblings() {} })
  await page.load()
  assert.equal(page.data.error, undefined)
  assert.match(page.data.phaseText, text)
  assert(!page.data.phaseText.includes('进行中'), 'manual unknown/scoped status must not fall back to unqualified ongoing')
}
;(async () => {
  await check('unconfirmed', /当前是否在招待确认/)
  await check('open', /10月22日核查时在招/)
  await check('expired', /官网复核已结束/)
  console.log('PASS real detail-page load uses review-aware status without asserting unverified recruitment is ongoing')
})().catch(e => { console.error(e); process.exitCode=1 })
