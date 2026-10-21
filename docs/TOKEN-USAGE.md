# 回复下方的 Token 用量与缓存率

茶歇室、个人工位等共用聊天界面，在每条有运行记录的成员回复气泡下显示：

`输入：12.4K　输出：0.8K　缓存率：75.0%`

K 按 1,000 Token、M 按 1,000,000 Token 换算；接近单位边界时避免显示 1000.0K。
缓存率是缓存读取输入 / 全部输入，百分比保留一位小数。缓存写入不是缓存读取命中。
缺失数据为“未提供”，运行中尚未报告为“待回报”，零输入没有可计算的比例。
旧消息未记录的数据不会补造，账号 Credits 和上下文占用不会当作 Token 用量。

## 接入与统计范围

- Codex：原生 `thread/tokenUsage/updated` 的 `tokenUsage.total`，严格核对当前 thread/turn；不把 last 一次请求误当完整轮次，不把额度事件当 Token。使用同一原生会话的已保存起点做差，重复通知替换，不累加累计值。
- Antigravity：官方最终 `result.usage` 是会话累计；按原生会话起点做差。步骤用量不会与最终用量混加。
- 已有 Codex/Antigravity 会话在没有可靠起点的第一次回报上标注“会话累计”；下一轮取得同一原生会话起点后才显示本轮差值。原生计数下降时继续保留累计范围，不编造差值。
- ZCode：原生最终结果的 `usage`，范围为本轮；输入总数已经包含缓存，不再次相加。中转是否返回缓存字段取决于服务本身。
- DSH：AIROOM 既有 Cordis 插件的 session/event 通道仅转发 `assistant/message` 的数值用量元数据；按事件序号去重，标注“已报告请求”。`inputTokens` 是未缓存输入，总输入优先取 totalTokens - outputTokens；缺少精确总数时仅在未缓存、缓存读、缓存写全有值时相加。不会声称包括没有回报用量的失败尝试、子会话和其他后台请求。
- Claude：原生最终 usage 的未缓存输入、缓存读、缓存创建分别归一化后展示。
- Qoder/Qoder CN：当前 ACP 任务接入未取得可核实缓存字段，显示“未提供”；账号 Credits 查询不改变这个结果，也不另启任务查询进程。

用量以小型数值记录保存到运行和对应消息；重启、较早运行离开快照后，聊天记录仍可显示。回复完成、表情更新不能抹去用量，更换为补正运行时不能沿用上一轮用量。旧资料缺少这些可选字段仍可读取。

## 验证与边界

- `tests/token-usage.test.ts`：字段口径、缺失/零/异常、去重、累计起点、会话重建、迟到事件、历史保留和 K/M。
- `tests/dsh-api.test.ts` / `tests/zcode-api.test.ts`：真实已安装 CLI 对接本地模拟 OpenAI 服务，两个工具链请求的输入/输出/缓存字段完整经过适配器。不是远端模型测试。
- `tests/ui/token-usage-smoke.mjs`：真实 Engine 和 React 页面，五个人物回复、实时更新、累计标注、缺失数据、历史与窄窗口；可由 `npm run verify` 自动收集。
- 不发送真实付费模型任务来制造用量样本；界面截图中的数字是测试数据，不代表用户账号的缓存率或费用折扣。

官方协议参考：[Codex App Server](https://developers.openai.com/codex/app-server)、[Antigravity Headless](https://antigravity.google/docs/cli/headless/)。具体 Codex 字段同时以当前安装 CLI 生成的协议 schema 为依据，DSH/ZCode 口径以当前安装运行时与本地模拟服务验证为依据。
