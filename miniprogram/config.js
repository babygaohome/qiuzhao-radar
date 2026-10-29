// 云开发环境 ID：微信开发者工具 → 云开发 → 设置 → 环境 ID，复制过来填在这里
module.exports = {
  envId: 'cloud1-d5g4idwry1a351b71',
  // 订阅消息模板 ID：小程序后台 → 功能 → 订阅消息 → 我的模板。留空则不显示提醒按钮
  remindTmplId: '',
  // Both flags are off in shipped builds. Demo rows are synthetic and local only.
  // The page calls the live API by default. The cloud API stays fail-closed until
  // INTEL_ENABLED and the collection are configured; feature_disabled is shown kindly.
  intelEnabled: true,
  intelDemoMode: false,
  // Daily digest stays hidden until the read APIs and scheduler are deployed.
  intelDigestEnabled: false
}
