# qoder订阅代理 · 1.0.11

面向 Qoder Desktop 的第三方本机代理，使用 CLIProxyAPI `v8.0.74` 与官方 Antigravity ACP `1.5.0`。Google 模型通过 ACP 接入，Qoder 继续负责工具校验、审批和执行；非 Google 渠道保留原有接入方式。

本项目不是 Qoder、Google 或其他服务商的官方产品，不提供订阅或账号权限。[免责声明](DISCLAIMER.md) · [第三方软件与许可证](THIRD_PARTY_NOTICES.md)

## 安装与升级

在 Qoder Desktop 的 **扩展 → 插件 → 添加插件 → 上传插件 ZIP** 导入对应平台安装包，启用并连接 MCP。不要选择 GitHub 自动生成的源码 ZIP。

| 平台 | 包名 |
| --- | --- |
| Windows x64 | `qoder-subscription-proxy-v1.0.11-win32-x64.zip` |
| macOS x64 / arm64 | 对应 `darwin-x64` / `darwin-arm64` 后缀 |
| Linux x64 / arm64 | 对应 `linux-x64` / `linux-arm64` 后缀 |

这是源码支持范围，不代表所有平台已通过实机验收。Windows ARM64、32 位系统不在插件支持范围。每个包内置本平台核心与 Codex 审批扩展；官方 ACP 不随包再分发，首次需要时下载。

升级前等待当前任务结束，调用 `bridge_stop`，再导入新版本、重连 MCP 并调用 `bridge_start`。不会自动热替换正在服务旧请求的程序。不要自动降级恢复旧 Google 通道。

旧 Google 账号会被停用但保留数据；首次需在独立 ACP 配置中完成官方认证，并将 Qoder 的旧 Google Model ID 改为目录中的 `acp/…` ID。模型入口和客户端 API Key 不变。已成功连接的 ACP 模型目录会保留，桥重启后在首次模型请求时惰性重连；主动停用 ACP 会清空活动目录，不会被模型请求自动恢复。

## 固定端口与数据

| 端口 | 用途 |
| --- | --- |
| `19787` | 模型入口 `http://127.0.0.1:19787/v1`，以及核心原生管理接口 |
| `19788` | 本机浏览器管理网关 |

默认数据目录：`~/.qoder/qoder-subscription-proxy/data`。CN 版与国际版共用该插件专属目录，它不是 Qoder 应用设置目录。升级保留用户数据，不复制兄弟插件数据。

- `launcher-secrets.json`：独立的模型 `apiKey` 与管理 `mgmtKey`。
- `config.yaml`、`auths/`：敏感配置及授权。旧 Google 授权停用但不删除。
- `runtimes/`：固定核心及 ACP 私有运行时，按版本、平台隔离。
- `approval-router/`：经验证的 Codex 原生扩展。
- `management-panel/`、`generated/`：管理页副本及 GPT 生图结果。
- `bridge.pid`、`bridge.paused`、`bridge.proxy`：进程归属、持久暂停与系统代理归属。

不要公开回环端口、上传数据目录或分享密钥。卸载不会自动删除凭据，也不等于撤销服务商授权。

## 管理入口

点击 **更多 → 订阅代理管理**，或调用 `bridge_open_management`，在系统默认浏览器打开一次性登录入口。票据 1 分钟内有效且只能使用一次，浏览器管理会话最长 30 分钟；过期后从 Qoder 重新打开。

打开管理入口不会自动解除 `bridge_stop` 的暂停。网关端口占用或核心未就绪会明确报错。MCP Apps 页面只负责浏览器交接；发送打开请求后保留居中的浏览器操作提示，不主动销毁页面。返回入口时可点击“再次打开管理页”，只有真实调用失败才显示错误原因。管理网关与 ACP 即使属于不同 MCP 会话，也能通过独立控制密钥及进程、连接归属校验查询和操作同一个 ACP 服务；模型请求密钥不能用于管理。

非 Google 授权继续在原管理面板完成。Google 用户点击面板中的 **Antigravity ACP 管理**。不要在旧 Google OAuth 卡片中登录或重新启用旧账号。

为防止重新启用旧 Google 路由，网关检查供应商及授权修改，不接受 JSON/YAML 完整配置覆盖；非 Google 配置使用各供应商的独立设置入口。不应通过核心原生管理接口或手工修改绕过该策略。管理接口仍是持有管理密钥的本机管理员能力，不是对恶意本机管理员的安全沙箱。

## Antigravity ACP 首次连接

1. 打开 ACP 管理页，点击 **检测并连接**。
2. 插件优先检查显式 `BRIDGE_ACP_BIN`，再检查 PATH 中的官方 ACP 程序，最后使用私有缓存。
3. 候选程序及伴随文件必须匹配固定官方发行并通过 ACP 握手。仅存在 Antigravity 桌面应用不代表提供 ACP 可执行入口。
4. 自动发现的运行时缺失或不兼容时，下载官方版本到私有缓存；不覆盖宿主安装、不修改全局 PATH、不修改宿主程序执行权限。显式配置错误不静默回退。
5. 需要认证时选择官方认证方式并点击 **启动官方认证**，本人完成官方交互。连接或安装不等于已登录；插件不解析、复制其他客户端 token。
6. 获取模型目录后，在 Qoder 添加 **OpenAI Compatible → Chat Completions API**，Base URL 使用现有模型入口，API Key 使用本机 `apiKey`，Model ID 使用管理页列出的完整 `acp/…` ID。

官方程序由 Google 提供并受其条款约束。个人订阅支持某个编辑器不等于允许全部第三方主模型用途；请确认当前用途及认证方式适用。插件如实标识客户端，不伪装官方身份、不规避识别或风控。

首次下载可能较大：Windows/macOS 约 100 MiB，Linux 约 260 MiB，Linux 解压约 820 MiB。安装使用跨进程锁、摘要校验和临时目录原子发布；失败保留已有版本，不无限重试。下载和登录状态分开显示。

宿主程序更新或移除后需重新检测。未支持的参数、模型和认证交互明确报错，不宣称已经生效。

## ACP 行为与限制

- 每个主对话回合独立创建官方会话；工具回传阶段保留原 prompt，校验请求历史、模型、工具目录及工具 ID。
- Qoder 执行工具，适配器不代替 Qoder 自动执行。官方内置文件/终端能力不开放；仅挂载当前请求的受控工具桥。
- 独立审批请求不强制改投 Gemini Flash，不降低其思考档位，也不与等待工具的主对话共用会话。
- 流式输出文本；工具结果回填后继续原生成。拒绝、取消、超时、会话失效不会触发旧 Google 通道回退或自动重放副作用工具。
- 有界并发与等待时间。等待工具结果超过 15 分钟会回收会话；客户端取消将结束对应活动请求。
- 使用官方 `GEMINI_HOME` 将配置及认证状态隔离到 `dataDir/acp-profile`，不自动合并其他客户端的 MCP、Hooks 或 Skills；宿主程序复用不等于导入宿主登录数据。
- system/developer 约束通过官方 `systemPrompt.append` 追加，不降级为用户历史，也不替换官方系统指令。不全局删改 Qoder 字样，不额外注入界面状态、无关环境变量或完整日志。
- 图片理解仅接受内嵌 PNG/JPEG/WebP/GIF，不自动抓取外部图片 URL。
- 当前不支持任意采样参数、输出 token 上限、多个候选及强制工具选择；收到不支持的参数会明确拒绝。思考档位必须由官方会话声明支持。
- 使用中若 Qoder 为某个模型默认附加上述不支持参数，需要匹配客户端能力设置，不能通过静默忽略参数假称兼容。
- 真实账号、真实模型及具体 Qoder 版本的端到端效果须实测；模拟测试和握手不能替代该验收。

## Google 迁移与原生审批路由

冷启动在核心接受请求前停用旧 Google OAuth 文件，并保留全部凭据字段。Google 原生 API Key 配置加入模型排除规则；OpenAI 兼容供应商不支持该字段，纯 Google 供应商设为 disabled，混合供应商将已识别的 Gemini 定义保存至私有 `acp-disabled-models.json` 后从活动模型列表移出，保留凭据和非 Google 模型。已有自定义别名应核对真实上游，无法识别的来源不能假定属于某个模型家族。

核心就绪前还通过其管理 API 停用旧 Google 授权；管理网关阻止旧 Google 登录、导入和重新启用。直接调用旧模型应报错，不能作为 ACP 故障时的备选。

Gemini 固定审批分流及旧 Antigravity 空补全续写已移除。Rust 扩展仅保留 **Codex 独立审批**：来源明确为 Codex、`gpt-*`、Responses、推理档位 `none`/`low` 且符合原分类器结构时转给 `codex-auto-review(low)`。普通对话与来源不唯一的请求不匹配。Qoder 原生审批不被移除或伪造。

扩展仍必须通过平台、ABI、SHA256 和真实注册检查。已有用户扩展目录冲突时不覆盖；普通安装者无需 Rust。上游核心的路由插件失败可能继续原路由，因此旧 Google 通道的停用不依赖路由异常。

## MCP 工具与生图

| 工具 | 用途 |
| --- | --- |
| `bridge_status` | 本机桥、核心和共享 ACP 状态，不返回密钥 |
| `bridge_start` / `bridge_stop` | 启动或持久暂停，只处理插件拥有的进程 |
| `bridge_open_management` | 打开浏览器管理入口 |
| `bridge_management_app` | 仅应用可见的更多菜单入口 |
| `image_gen_gpt` | GPT 生图，保存到 `generated/`，返回文件路径 |

Gemini 生图尚未验证 ACP 支持，工具列表不公开该能力；旧调用会明确返回不可用，不触及旧 Google 接口。GPT 省略 model 且候选不唯一时仍由用户选择，不由插件擅自选模型。

## 核心配置策略

非 ACP 渠道的重试、冷却和流式参数沿用上游默认值；ACP 专用上游设置零额外重试，避免对有状态 prompt 盲目重放。Google 模型排除、受控管理页、Codex 审批指引及运行时注册是显式受管配置。

Windows 冷启动按原约定同步系统 HTTP(S) 代理到 `requests.proxy-url`，仅修改插件自己管理的值，用户自定义非空值不被覆盖。系统代理关闭时空值仍可使用环境代理；只有路由证据确认隧道承载出口才使用显式 direct。PAC 和仅 SOCKS 配置不自动转换。macOS/Linux 沿用环境代理。

| 变量 | 用途 |
| --- | --- |
| `BRIDGE_DATA_DIR` | 独立数据目录，不自动迁移 |
| `BRIDGE_PORT` / `BRIDGE_HOST` | 默认 19787；Host 仅允许 127.0.0.1 |
| `BRIDGE_API_KEY` | 模型客户端密钥覆盖，须与已有配置一致 |
| `BRIDGE_BIN` | 自定义兼容核心，不自动下载替换 |
| `BRIDGE_ACP_BIN` | 官方 ACP 可执行文件绝对路径，仍校验固定发行与伴随程序 |
| `GEMINI_API_KEY` | 仅在主动选择 API Key 认证时传给官方程序，不写入提示词或日志 |
| `QODER_HTTP_PROXY` | 下载代理优先值；否则沿用 HTTPS/ALL/NO_PROXY 或系统代理 |

## 开发验证

从仓库根目录运行：

```sh
node qoder-subscription-proxy/scripts/build-approval-router.mjs
cargo test --locked --manifest-path qoder-subscription-proxy/native/approval-router/Cargo.toml
node --test --test-concurrency=1 qoder-subscription-proxy/tests/*.test.mjs
```

`BRIDGE_TEST_BIN` 指向校验匹配的核心可启用原生核心集成测试。普通测试不联网或使用真实账号；真实 ACP 测试须显式提供官方测试程序/归档，并在隔离账号目录运行。不要使用生产凭据进行自动回归。

打包方式见[仓库说明](../README.md#从源码打包)。安装包不包含账号、缓存、测试材料及旧 Google 授权助手；发布与安装需独立执行和验收。
