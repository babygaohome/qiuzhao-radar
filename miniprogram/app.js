const config = require('./config.js')

App({
  globalData: { listDirty: false },
  onLaunch () {
    if (!wx.cloud) {
      console.error('请把基础库升级到 2.2.3 以上才能使用云开发')
      return
    }
    wx.cloud.init({ env: config.envId || undefined, traceUser: true })
  }
})
