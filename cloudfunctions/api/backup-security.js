const crypto = require('crypto')
const MAX_BYTES = 750000
const ITERATIONS = 600000
const object = v => v && typeof v === 'object' && !Array.isArray(v)
function validate (d) {
  if (!object(d) || d.app !== '秋招雷达' || ![1, 2].includes(d.v) || !Array.isArray(d.apps)) throw new Error('这不是秋招雷达的备份文件')
  for (const key of ['apps', 'companies', 'plans', 'materials', 'offers', 'hidden']) {
    if (d[key] !== undefined && !Array.isArray(d[key])) throw new Error('备份字段格式不正确：' + key)
  }
  if (d.apps.length > 1000 || (d.companies || []).length > 1000 || (d.materials || []).length > 40 || (d.offers || []).length > 10 || (d.plans || []).length > 5 || (d.hidden || []).length > 1000) throw new Error('备份记录数超出上限')
  for (const key of ['apps', 'companies', 'plans', 'materials', 'offers']) if ((d[key] || []).some(x => !object(x))) throw new Error('备份中包含无效记录')
  const encoded = JSON.stringify(d)
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('备份超过750KB，请拆分后恢复')
  return { data: d, hash: crypto.createHash('sha256').update(encoded).digest('hex') }
}
function password (p) {
  if (typeof p !== 'string' || p.length < 8 || p.length > 128) throw new Error('备份密码需为8–128个字符')
  return p
}
function encrypt (data, p) {
  validate(data)
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12)
  const key = crypto.pbkdf2Sync(password(p), salt, ITERATIONS, 32, 'sha256')
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
  return { format: 'qiuzhao-encrypted-backup', v: 1, kdf: 'pbkdf2-sha256', iterations: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}
function decrypt (e, p) {
  password(p)
  if (!object(e) || e.format !== 'qiuzhao-encrypted-backup' || e.v !== 1 || e.kdf !== 'pbkdf2-sha256' || e.iterations !== ITERATIONS) throw new Error('加密备份格式不正确')
  const decode = (name, length) => {
    const s = e[name]
    if (typeof s !== 'string' || s.length > 1000000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('加密备份内容不正确')
    const b = Buffer.from(s, 'base64')
    if (length && b.length !== length) throw new Error('加密备份内容不正确')
    return b
  }
  const salt = decode('salt', 16), iv = decode('iv', 12), tag = decode('tag', 16), ciphertext = decode('ciphertext')
  if (ciphertext.length > MAX_BYTES) throw new Error('加密备份超出大小上限')
  let data
  try {
    const key = crypto.pbkdf2Sync(p, salt, ITERATIONS, 32, 'sha256'), cipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    cipher.setAuthTag(tag)
    data = JSON.parse(Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8'))
  } catch (err) { throw new Error('密码不正确，或备份已损坏') }
  return validate(data).data
}
const manualId = (openid, session, id) => 'mimport_' + crypto.createHash('sha256').update(JSON.stringify([openid, session, String(id)])).digest('hex').slice(0, 32)
module.exports = { validate, encrypt, decrypt, manualId }
