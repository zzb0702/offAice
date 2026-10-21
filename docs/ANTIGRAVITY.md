# Antigravity CLI 适配

本实现将官方 `agy` 原生程序接入执行端清单，提供与其他执行端一致的“下载并自动配置”。`AcpExecutor.adapter` 为 `antigravity` 时由专用适配器处理；字段缺失的旧连接继续走原有 ACP/ZCode 分发。执行端编号仍保留 `acp-` 前缀以兼容现有任务、人物卡和历史记录；前缀不代表底层协议。已有连接和历史记录保留。

## 用户入口

1. 设置与连接 → 连接与版本 → 从清单添加 → Antigravity CLI。
2. 阅读厂商条款，勾选同意后点击“下载并自动配置”。页面不再提供手动添加或选择本机程序入口。
3. 下载并校验成功后，打开登录终端。完成原生交互授权并关闭终端后，AIROOM 自动检查；也可点击检查连接。检查使用官方原生 `--print /usage` 读取账号额度，不发送模型消息。只有收到可识别且成功的账号额度报告才显示“已连接”；明确未登录显示“需要登录”，网络异常或未知输出保持未确认。AIROOM 不将“已打开终端”或“读到模型列表”记作“已登录”。
4. 创建人物卡，在成员/话题模型选项中设置模型及思考程度，随后开展文字任务。

Windows x64 下载使用官方 PowerShell 安装脚本所声明的发布源，但不执行该安装脚本，不修改 PATH。原生程序保存于 AIROOM 数据目录的 `members/antigravity/<版本>/agy.exe`，与设置和会话目录分开；按官方 SHA-512 校验后才运行版本检查并启用。当前支持本版推荐的 1.4.3、官方清单最新版本及已安装版本的切换；不猜测任意历史版本的下载地址。版本、下载、启动或连接检查失败时保留原连接。

## 协议与生命周期

- 使用 `--input-format stream-json --output-format stream-json`，通过 stdin 发送一个 `{event:"user",message:{content:"..."}}` 后关闭输入。任务文本不进入 Windows 命令行。
- 输出按官方 `init`、`step_update`、`result` 解析。文字增量和工具输出分开，最终完整正文不重复显示，缺少最终回执、坏 JSON、重复终结或会话错配不会被算作成功。
- 恢复时仅传当前 AIROOM 会话保存的 `--conversation`，不使用 `--continue`。只有收到成功终结且进程成功退出后才保存原生会话。
- 通过现有进程所有权组件启动和中止。取消会停止本次进程；输出不确定时交由用户核对，不自动重试或降级模型。
- `init.model` 是 CLI 对参数的确认，不能独立证明远端模型身份。思考程度按原生参数发送；初始化事件未回报生效值，因此保持“未回报”。用量回执按原生会话累计保留，不直接计入每轮新增费用。工具活动保留原始载荷和命令；仅有 DONE 事件而没有明确退出码时，不补造命令成功记录。

## 账号与权限

- 每个连接使用 AIROOM 数据目录下独立的 HOME、USERPROFILE、APPDATA、LOCALAPPDATA 和 XDG 目录；移除宿主注入的 Antigravity/AGY/Google 及其他执行端账号环境变量。
- 上述目录隔离只证明文件路径独立。当前官方认证文档说明 CLI 可能使用 Windows Credential Manager 等系统钥匙串并共享本机登录，不能仅凭独立 HOME 宣称账号完全隔离；原生系统凭据隔离尚未验收，使用前须核对实际登录账号。
- 官方设置位置为该独立 HOME 下 `.gemini/antigravity-cli/settings.json`。单次任务临时映射 `permissions.allow/deny/ask`，同一连接的任务串行持有设置文件，完成后仅在内容仍为本次写入值时恢复原设置，避免覆盖外部改动。
- 只读任务禁止写文件和命令；普通房间发言不开放工具，绑定项目的会议发言仅开放项目读取。MCP 和脱离沙箱执行默认拒绝，不使用全局跳过权限参数。
- 无界面协议不支持交互权限控制响应；Ask 操作会被原生程序拒绝。网络及文件范围依赖原生权限引擎和沙箱，属于应用/执行端层限制，不能宣传为经本项目验证的 OS 安全边界。
- 独立登录终端为用户主动打开的交互窗口。AIROOM 不自动发送模型提示；用户完成登录后自行关闭。终端打开期间该连接保持登录占用，阻止任务和连接修改与登录同时进行。

## 当前能力边界

文字输入、最终回复、流式活动、显式选模、显式会话恢复、进程中止、原生账号额度检查与额度展示已实现。图片输入、运行中 steer 和进程复用未实现，能力声明保持关闭。模型清单本身不能证明登录状态；原生 `/usage` 是 CLI 直接处理的账号命令，检查不发送模型消息，也不读取或展示原始令牌。

### 额度展示

- 检查连接时保存原生 `/usage` 的模型组、剩余百分比和恢复时间；“用量与额度”提供独立的“刷新额度”按钮，成员卡和侧栏同步显示最近回报。
- 本机 1.4.4 的原生输出为四列 TSV：模型组、额度类型、剩余百分比、带时区的恢复时间。只接收这些字段，不从会话 token 数推算账号限额。已识别的 Weekly、Five Hour 周期分别显示“每周”“5 小时”，其它周期保留为“剩余额度”，不推测周期长度。
- 按原生模型组展示，不补造 Codex 的两个固定窗口。某组用完不代表其它组用完；未核实模型组与可执行模型 ID 的映射前，仅展示，不依据这份报告自动暂停成员。
- 单独刷新失败、未登录或输出不可识别时清空本次可用额度，显示“未提供”；超过十五分钟或已到恢复时点的样本显示“待更新”。不把未知值解释为零，也不将旧缓存重新标记为新结果。

本仓库公开快照没有附带原作者完整测试目录；新增测试覆盖适配器、权限和界面，不能据此声称已经跑过原作者全部回归。普通验证使用模拟 CLI、临时未登录目录；实际账号端到端验证须另行明确授权。

## 验证

```text
npm run typecheck
node scripts/build-job.mjs
node --import ./scripts/test-bootstrap.mjs --import tsx --test tests/antigravity-*.test.ts
node --import ./scripts/test-bootstrap.mjs --import tsx tests/ui/antigravity-smoke.mjs
npm run build
npm run verify
```

原生 CLI 的本地版本和帮助检查不等于真实模型任务通过。测试结果与未验证项以交付记录为准。

## 官方依据

- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/permissions?tab=cli
- https://antigravity.google/docs/settings?tab=cli
- https://antigravity.google/docs/getting-started/
- https://antigravity.google/cli/install.ps1
- https://antigravity.google/docs/install?tab=cli

实现时核对的本机 CLI 为 1.4.3。主分支文档可能比本机版本新，版本不支持所需选项时应拒绝运行，不能静默换协议或账户。
