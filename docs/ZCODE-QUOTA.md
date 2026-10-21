# ZCode 官方 Coding Plan 额度

从托盘退出旧源码进程后，运行 `Start-AIROOM-Dev.cmd`。在“设置与连接 → 连接与版本 → ZCode CLI”使用 BigModel 中国区或 Z.ai 海外官方账号登录。检查连接会读取一次官方额度；之后可在左侧“团队”旁的“用量与额度”中点击该成员的“刷新额度”。

额度来自官方账号接口，不从本地会话 token 数推算。按服务实际返回显示：

- 5 小时模型调用额度。
- 每周模型调用额度。
- 每月 MCP 工具调用额度。

成员卡与侧栏显示简要状态，完整额度和恢复时间在“用量与额度”查看。接口缺失的窗口不补造。恢复时间仅使用可验证的服务端毫秒时间戳；缺失、已经过去或与窗口明显不相符的恢复时间保持未提供，不猜测倒计时。额度报告超过十五分钟后显示“待更新”，需要刷新。

## 账号与查询边界

查询只读取 AIROOM 当前 ZCode 连接私有目录中的原生 v2 凭据和当前模型供应商选择，要求地区、individual-coding-plan 通道、原生模型和该身份的套餐 key 匹配。不会回退到全局 ZCode、另一个账号、另一个地区、旧配置或宿主环境中的 key。原有凭据仅在后端内存中解密用于当前请求，不修改或复制到新的凭据存储；渲染器及额度记录只收到白名单投影。

按当前地区单次 GET 官方固定地址，authorization 直接使用当前选定的完整 Coding Plan key：

- BigModel：中国区 `https://bigmodel.cn/api/monitor/usage/quota/limit`。
- Z.ai：海外 `https://api.z.ai/api/monitor/usage/quota/limit`。

不接受环境变量重定向额度域名；请求禁止 HTTP 重定向，超时十五秒，响应体上限 256 KiB。查询不发送模型任务，不执行登录、签发套餐 key 或额度重置操作。账号或配置在请求过程中变化时，迟到结果丢弃；账号文件变化也会使持久化的旧额度失效。

查询失败、未登录、套餐 key 不匹配或响应不识别时显示未取得可验证额度，不把它解释成零或百分之百剩余。额度接口鉴权失败不会自行清除账号登录。官方应用内部的 monitor 接口并非本项目控制的稳定协议，结构改变时以不可用状态处理。

模型额度使用现有自动发言规则：已用达到 80% 减少自动点名，100% 暂停自动调用。MCP 工具额度单独标记，不会因 MCP 用完而暂停普通模型发言，也不以 MCP 的恢复时间推算模型额度恢复。

自定义中转/API 模式不查询官方 Coding Plan，不显示官方刷新入口；实际用量和计费按中转服务提供方规则处理。

## 验证与官方依据

- `tests/zcode-quota.test.ts`：选定账号、地区、只读凭据、账号切换、失败响应、窗口解析与 MCP 分离。
- `tests/zcode-quota-desktop.mjs`：真实 Electron、后端、加密模拟凭据及 HTTPS 请求，通过本地 TLS 代理模拟固定官方域名，验证界面刷新、缓存失效、重启及 API 模式。
- `tests/zcode-quota-native.mjs`：显式启用后，只读查询本机当前官方账号；报告不保存真实账号标识、额度数值或原始凭据。

官方资料：

- [ZCode Usage Stats](https://zcode.z.ai/en/docs/usage-stats)
- [官方 monitor 接口及字段说明](https://github.com/zai-org/ZCode/blob/main/docs/bigmodel-coding-plan-usage-quota.md)
- [当前官方额度供应商实现](https://github.com/zai-org/ZCode/blob/main/packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts)
- [原生 CLI 账号身份与 key 绑定](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts)
