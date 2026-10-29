# Node 16 运行时迁移待办

2026-09-30 已在现网确认：api、crawler、remind 的配置页面把运行环境显示为不可修改文本。腾讯 SCF 的 UpdateFunctionConfiguration 文档也说明 Runtime 创建后不能修改：https://cloud.tencent.com/document/api/583/18580 。因此本次没有删除旧函数或改变现有 AI 密钥。

代码及依赖已兼容测试并部署：wx-server-sdk 4.0.2、固定依赖与安全适配器；真实小程序 health 返回 SDK 4.0.2 / Node 16.13.1。依赖升级不等于 Node 运行时升级，Node 16 的平台风险仍在。

可执行迁移路径：

1. 在同一云环境新建 api_v3、crawler_v3、remind_v3，选择平台可用的 Node 24.11 或 Node 22.21。
2. 上传这次的完整函数包，管理端将现有 api 环境变量复制到 api_v3；不把密钥发到聊天或写进前端/仓库。
3. 新函数只读 smoke：health、本人资料读取、私有记录权限拒绝。用两位真实微信体验成员交叉验收。
4. 前端 utils/util.js 的云函数名切到 api_v3，上传新版体验包；将 api_v3 设为仅登录可调用，crawler_v3/remind_v3 设为 invoke:false。
5. 在新函数上上传原定时触发器，确认至少一轮成功，再停旧定时器及旧函数的客户端调用。不要在验证前删除旧函数。
6. 保留回滚版本与环境变量，逐步退役旧函数。提醒模板仍为空，迁移不启用微信提醒。

参考运行环境支持：https://docs.cloudbase.net/cloud-function/runtime-support 。该迁移需要管理员完成新函数的密钥配置和体验版本切换，尚未执行。
