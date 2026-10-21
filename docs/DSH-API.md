# DeepSeek Harness 自定义中转/API

在“设置与连接 → 连接与版本 → DeepSeek Harness”中，将“DSH 连接方式”选为“自定义中转/API”。如果尚未安装执行端，先从清单下载并自动配置 DeepSeek Harness。

1. “模型”填写服务提供方支持的模型 ID，例如其文档提供的模型名。这里不会自动把官方账号模型替换成中转模型。
2. 接口格式默认是 **OpenAI Chat Completions**（DSH 原生协议名 `openai-completions`）。也可以明确选择 OpenAI Responses 或 Anthropic Messages。
3. API 服务地址填写提供方给出的根地址，例如 `https://relay.example/v1` 或本地服务 `http://127.0.0.1:8000/v1`。不要附加 `/chat/completions` 等具体请求路径；AIROOM 不自动猜测或补齐 `/v1`。
4. 填写该服务自己的 API Key，点击“加密保存 DSH API Key”。保存密钥时同时保存连接配置；留空不会覆盖已保存的密钥，清除使用单独按钮。本地无鉴权服务可使用它接受的占位密钥。
5. 点击执行端的“检查”。此操作验证配置、密钥是否已保存、原生 DSH 启动与 ACP 会话控制；不调用模型，不证明远端密钥或模型可用。新建话题发送短消息，确认真实请求正常。

Chat Completions 模式会向 `{API 服务地址}/chat/completions` 发送原生模型请求，并保留 DSH 的工具调用循环、工作目录和权限控制。中转需支持流式 Chat Completions；需要使用工具时，还须支持 `tools`、`tool_calls` 和工具结果消息。当前自定义 API 配置按文字和工具使用，不宣称图片输入已经验证。

“思考程度”可选择模型默认、off、minimal、low、medium、high、xhigh、max。这里只列出 DSH 客户端可配置的参数，并非远端模型能力检测；请按中转服务支持的档位选择。模型默认不额外声明推理档位，显式选择会通过原生 DSH 的 `reasoningEfforts` 和 ACP 选择传入请求，不用提示词模拟思考强度。

Chat Completions 下，选择档位后可设置“思考参数格式”：OpenAI 兼容格式发送相应 `reasoning_effort`；DeepSeek 格式还会发送 `thinking.type` 开关，off 对应关闭。Responses 和 Anthropic 接口由 DSH 原生适配器按协议转换。点击底部“保存设置”后从下一轮生效；首次加密保存 API Key 也会同时保存这些设置。官方账号模式与自定义 API 模式分别记住各自的模型及思考程度。

实际验证使用本机模拟中转，覆盖 OpenAI high、DeepSeek max 与 off 的真实请求字段和桌面重启恢复；不证明真实中转一定接受这些参数或模型推理效果随档位变化。

API 密钥由 Electron 的系统凭据保护加密保存，不进入普通设置数据库、渲染器快照或 DSH 配置补丁。原生补丁仅引用环境变量名称，启动时单独传入该密钥。自定义 API 使用独立的 DSH 数据子目录，不读取或发送 AIROOM 官方账号模式的登录记录，也不查询官方账号余额。官方账号模式和 API 模式之间切换后，请新建话题。

修改连接配置前需要停止当前任务。切换地址、接口、模型或密钥后，会回收旧的空闲运行实例，下一次请求使用新配置。鉴权或服务错误会按实际错误报告，不自动改投官方账号或其他服务。

本功能沿用已安装的 DSH，不升级全局或项目运行时，也不修改普通终端的 DSH 配置。

## `unknown prompt variable "{{cwd}}"` 的处理

DSH 0.2.1 不再提供 `cwd` 提示词变量，当前工作目录由原生运行时上下文提供。旧 AIROOM 注入的 `Your working directory is {{cwd}}.` 会在模型请求前使人设模板组装失败。这个错误不表示 API Key 无效或额度耗尽。

AIROOM 已移除后缀中的旧变量，并使用关闭插值的原生提示词段传入任务工作区，兼容旧版运行时，也保留目录名中的双花括号。DSH 0.2.1 继续通过自己的上下文提供当前目录；人物卡仍按普通文本处理，不将其中的双花括号当作原生变量。

更新源码后，从托盘退出旧 AIROOM，运行 `Start-AIROOM-Dev.cmd` 重新编译并启动即可，无需重新登录或重填 API Key。已有失败记录不会自动重发，由用户主动发起下一轮。
