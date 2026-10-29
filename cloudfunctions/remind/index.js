// 秋招雷达 · 订阅消息提醒
// 每天 9:00 和 20:00 运行，把到期的提醒（网申截止、笔试、面试）用订阅消息推送到微信。
// 模板 ID 和字段对应关系写在 template.json 里（小程序后台 → 订阅消息 → 我的模板）。
const cloud = require('wx-server-sdk')
const tpl = require('./template.json')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function todayCN () { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) }
const cut = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…' }
// 订阅消息 time 类型要求「2026年10月8日 09:00」，date 类型要求「2026年10月8日」
function fmt (when, type) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(when || '')
  if (!m) return when
  const d = `${m[1]}年${+m[2]}月${+m[3]}日`
  if (type === 'date') return d
  return `${d} ${m[4] || '23'}:${m[5] || '59'}`
}

function buildData (r) {
  const values = {
    title: cut(`${r.company} ${r.title}`, 20),
    company: cut(r.company, 20),
    event: cut(r.title, 20),
    time: r.when,
    note: cut(r.kind === 'deadline' ? '网申快截止了，别忘了投递' : '记得提前准备，祝顺利', 20)
  }
  const data = {}
  for (const [key, spec] of Object.entries(tpl.fields)) {
    const [source, type] = spec.split(':')
    const v = source === 'time' ? fmt(values.time, type || (key.startsWith('date') ? 'date' : 'time')) : values[source]
    data[key] = { value: v || '-' }
  }
  return data
}

exports.main = async () => {
  const ctx = cloud.getWXContext()
  if (ctx.OPENID || ctx.UID) return { error: 'forbidden', message: '提醒任务只允许定时器或管理端调用' }
  if (!tpl.templateId) return { skipped: '还没有填模板 ID' }
  const today = todayCN()
  const due = (await db.collection('reminders').where({ sent: false, sendOn: _.lte(today) }).limit(100).get()).data
  let sent = 0; let failed = 0; let expired = 0
  for (const r of due) {
    if (r.when.slice(0, 10) < today) { // 事情已经过去了，不再提醒
      await db.collection('reminders').doc(r._id).update({ data: { sent: true, result: 'expired' } })
      expired++
      continue
    }
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: r.openid,
        templateId: tpl.templateId,
        page: `pages/detail/detail?id=${encodeURIComponent(r.cid)}`,
        data: buildData(r),
        miniprogramState: tpl.miniprogramState || 'trial'
      })
      await db.collection('reminders').doc(r._id).update({ data: { sent: true, result: 'ok', sentAt: db.serverDate() } })
      sent++
    } catch (e) {
      // 43101：用户没有订阅或次数已用完；其他错误下次再试，最多重试到事情当天
      const code = e.errCode || e.code
      if (code === 43101 || r.when.slice(0, 10) === today) {
        await db.collection('reminders').doc(r._id).update({ data: { sent: true, result: `fail ${code}` } })
      }
      console.error({ action: 'sendReminder', record: crypto.createHash('sha256').update(r._id).digest('hex').slice(0, 16), code: code || 'send_failed' })
      failed++
    }
  }
  const stats = { at: new Date().toISOString(), due: due.length, sent, failed, expired }
  console.log(JSON.stringify(stats))
  return stats
}
