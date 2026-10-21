# ZCode 选择 Flash 却请求 GLM-5.3

2026-10-21 本地问题复核：成员请求记录是 `GLM-5.3-Flash / max`，原生请求记录却是 `GLM-5.3`。两个名称在安装的原生清单中是独立模型。

原因是 AIROOM 的 BigModel 官方登录只写入了 `schemaVersion` 和 `config.defaultModelSelection`，漏掉了原生 v1 配置必需的 `providerConfigRules.providerRules`、`modelConfigRules.providerModelRules`、`modelConfigRules.manualProviderModelRules`。原生解码失败后恢复为空配置，丢弃整份文件中的默认模型。内置清单回退模型因此替代了成员所选模型。准备会话中的 `session/setModel` 可以成功，但新任务使用另一个 CLI 进程，无法靠准备会话的内存设置阻止这个回退。

修复覆盖两个入口：

- 新的官方登录生成完整的原生 v1 配置。
- 每轮生成私有模型配置时补齐旧配置遗漏的空规则容器，再写入本轮模型和思考档位；保留已有供应商与模型规则，不修改现有账号的共享配置。无需重新登录。

不受支持的配置版本或明显错误的规则容器会在发送任务前报错。实际请求的供应商和模型仍须与本轮选择完全一致；不一致时错误会同时列出所选与实际模型，本轮不会自动重发。

从托盘退出旧 AIROOM，再运行仓库的 `Start-AIROOM-Dev.cmd` 加载重新构建的版本。已保存的失败记录不会变成成功，也不会因此重新发送；下一轮由用户主动发起。

验证见 `tests/zcode-model-selection.test.ts`：真实原生进程在未修复时复现“选择 Flash，另一个进程读回 GLM-5.3”；修复后读回 Flash/max。该账号配置测试仅使用独立未登录目录与协议中的套餐覆盖，不发送模型请求。另以真实 CLI、自定义双模型配置和本地模拟 OpenAI 接口核对新会话的 Flash/max 请求、已有会话显式切换和默认配置不变。协议模拟测试另核对真实不一致仍失败且不自动重发。这些检查不代表真实官方服务端推理已复测。
