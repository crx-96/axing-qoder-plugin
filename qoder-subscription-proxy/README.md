# qoder订阅代理 · 0.2.2

基于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的 Qoder Desktop 第三方插件，将本人合法授权的订阅接入本机 OpenAI 兼容 API，提供代理管理和图片生成 MCP 工具。不赠送订阅、额度或账号权限，不是 Qoder、CLIProxyAPI、OpenAI 或 Google 官方产品。

> 使用前阅读[免责声明](DISCLAIMER.md)和[第三方软件与许可证](THIRD_PARTY_NOTICES.md)。固定管理密码 **`123456`** 仅适用于可信单机回环服务，不可暴露到局域网或公网。

## 安装与兼容范围

从 [GitHub Releases](https://github.com/crx-96/axing-qoder-plugin/releases/latest) 的 **Assets** 下载带版本号的安装包，按[仓库下载与安装说明](../README.md#下载与安装)在 Desktop **扩展 → 插件 → 添加插件 → 上传插件 ZIP** 导入，无需自行打包或解压。当前 Windows 包为 `qoder-subscription-proxy-v0.2.2-windows.zip`，macOS/Linux 包为 `qoder-subscription-proxy-v0.2.2-posix.zip`；不要下载自动生成的源码归档作为安装包。POSIX ZIP 已替换为对应 `.mcp.json`，源码默认 Windows 清单不能直接用于 POSIX。

| 项目 | 范围与验证边界 |
| --- | --- |
| Qoder | 当前核对 Desktop CN `0.4.11`；程序为 `Qoder CN.exe`，国际版为 `Qoder.exe` |
| 内置运行时 | 已实测 Electron `43.1.1` / Node `24.18.0` Node mode；本机独立开发命令 `node` 为 `26.4.0` |
| Windows | Windows 10 22H2 x64 / Windows 11 x64 为兼容目标；依赖 PowerShell 5.1、.NET Framework、Job Object；Windows 10 尚未单独验收 |
| macOS / Linux | x64 / ARM64；依赖 `/bin/sh`、系统进程工具和可用的 Qoder Node mode 或已有 Node 22+；尚未实机验证，不保证所有发行版及 musl/Alpine 兼容 |
| 核心 | 固定 CLIProxyAPI `v8.0.38`，仅下载当前平台；下载需系统 `curl` 支持 HTTPS |
| 不支持 | Windows 32 位、原生 Windows ARM64及其他平台/架构；ARM64 上 x64 仿真未验证 |

插件使用 `.qoder-plugin/plugin.json`、`${QODER_PLUGIN_ROOT}` 和 MCP `timeout: 660000`（11 分钟），与 Desktop 自带 `recordAndReplay` 资源契约一致，但不代表真实 ZIP 安装已通过，也不保证宿主实际请求时限。

仓库根 `.qoder-plugin/marketplace.json` 保留市场元数据。`prepare-posix-marketplace.sh` 仅用于支持本地市场的高级兼容客户端；尚未确认 Desktop 自定义市场 UI，不将其作为 Desktop 安装步骤。高级客户端可在仓库根执行：

```sh
sh qoder-subscription-proxy/scripts/prepare-posix-marketplace.sh "$HOME/qoder-subscription-marketplace"
```

脚本创建新分发副本，拒绝覆盖目标，不修改源码或安装缓存。POSIX 启动器探测 Qoder 祖先进程、已有 Node 和常见安装位置，验证 Node 22+ 后运行，不静默安装工具。企业策略禁止 PowerShell、`Add-Type` 或 Job Object 时会报错，不要求关闭安全策略；`-ExecutionPolicy Bypass` 仅作用于当前脚本进程。

## 首次使用

1. 安装、启用并确认宿主已连接插件 MCP。握手只等待本地配置，核心后台准备并自动启动代理，**无需先有聊天模型或调用工具**。尚未确认 Desktop 空白窗口会拉起 MCP，插件不能自行触发宿主连接。
2. 代理就绪后打开 **<http://127.0.0.1:19787/management.html>**。如要求服务地址，填 `http://127.0.0.1:19787`；管理密码为 **`123456`**。
3. 在管理页 OAuth / 账号授权区域选择服务商，由本人登录并同意授权，再检查授权状态。菜单以实际页面为准。
4. 在 Qoder 模型/供应商设置中添加 OpenAI 兼容服务，具体入口以当前客户端为准：
   - **Base URL**：`http://127.0.0.1:19787/v1`
   - **API Key**：数据目录 `launcher-secrets.json` 中的 `apiKey`，不是管理密码。
   - **协议和模型**：按模型选择 Chat Completions 或 Responses，使用管理页或 `bridge_status` 实际列出的聊天模型，不将 `gpt-image-*` 作为聊天主模型。
5. 有可用聊天模型后，可让 AI“调用 qoder订阅代理的 `bridge_status`，只查状态，不生成图片”。`ready: true` 仅表示本机代理和模型列表接口可用，不保证订阅权限；未授权时模型列表可以为空。

API Key 首次随机生成并持久保存，升级不自动轮换或清空授权。不要将密钥、账号 token 或授权 URL 发给 AI、公开截图或提交仓库。

## 轻量包与后台准备

ZIP 不带五平台核心二进制，仅保留来源清单、文档和许可证。轻量包用于减少安装体积和网络耗时，**不是 Qoder 已确认禁止大包**；未确认官方 ZIP 大小上限。

- 缺少有效缓存时，从固定官方 HTTPS 发布地址下载当前平台 `v8.0.38` 归档，先校验归档 SHA256，安全解压后再校验二进制 SHA256，成功后发布缓存并启动代理。不自动换版本或下载其他平台。
- 后台准备独立预算 **10 分钟（600 秒）**，覆盖等待锁、下载、校验和解压；curl 连接最多 60 秒、单次传输最多 540 秒，各阶段受剩余总预算约束，不阻塞 MCP 握手。
- 下载期间 MCP 仍可用，状态可显示 `ready: false`、`core.state: "downloading"`；图片请求立即返回未就绪。准备失败保留连接，以 `startupError` 或 `core.reason` 报告原因。修复后显式 `bridge_start` 或重连重试，不自动重试；状态查询与 watchdog 不下载核心。
- `bridge_stop` 取消本会话在途准备并持久暂停，重连仍可握手和查状态，但需显式 `bridge_start` 才恢复下载与启动。EOF、断管和退出信号也会取消准备并清理本次拥有的资源。本地配置错误仍可能导致 MCP 初始化失败。
- 缓存位于 `dataDir/runtimes/v8.0.38/<platform-arch>/<basename(platforms.json.path)>`。离线准备需通过 `BRIDGE_BIN` 自行提供可信兼容核心，不承诺一键离线包；远程登录及模型服务仍需要网络。

管理页固定随包提供上游 `v1.26.7` 资产，校验后生成带 Antigravity 兼容补丁的独立副本，不直接修改原资产。管理页自动更新被禁用，后续更新随插件维护；首次打开无需另行下载页面。

## Antigravity 与 OAuth 回调

上游 Antigravity 网页流程原本监听 `http://localhost:51121/oauth-callback`，Windows 端口保留或冲突可能导致 `failed to start antigravity callback forwarder`。这不等于账号失效，无需删除系统端口保留范围、禁用 Hyper-V/WSL 或关闭防火墙。

本插件仅对 Antigravity 使用 `is_webui=false` 手动回填，**不监听 51121**，保留原管理页按钮和回调表单：

1. 在管理页 OAuth 登录 → Antigravity 开始授权并打开链接。
2. 本人在 Google 页面完成登录与同意授权。
3. 跳回 `http://localhost:51121/oauth-callback?...` 后显示无法访问是预期行为，复制地址栏的**完整 URL**。
4. 回到原授权弹窗粘贴并提交；页面检查固定回调地址与本次 `state`。
5. 在 5 分钟内完成，等待明确“认证成功”；“回调已提交”不等于成功。不要公开含短期授权码的回调 URL。

Windows 可选用 [Antigravity授权.cmd](Antigravity授权.cmd)：保持代理运行，双击后按提示登录，将完整回调 URL 粘贴到本机隐藏输入处。助手仅向本机提交回调，也不监听 51121。自定义代理端口时，在插件目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\antigravity-login.ps1 -Port 你的端口
```

各 provider 的 OAuth 回调地址由上游固定，不能随代理 API 端口任意修改。其他供应商仍使用上游临时回调监听，可能绑定 `0.0.0.0`，且与其他实例共享固定端口；**不要并行授权同一 provider**，包括在 Zcode 或其他代理中同时授权。正常代理 API 并行使用不因此冲突。手动回填不绕过网络、地区、账号或订阅权限限制。

## 自动启动与退出清理

- 自动启动以 **宿主已拉起 MCP** 为前提，不注册系统服务、计划任务或开机启动项，不修改 Qoder 安装目录，不能承诺打开空白窗口即启动代理。
- Windows 启动器查找实际 `Qoder.exe` / `Qoder CN.exe` 祖先根进程，`ProxyJob` 持有宿主进程句柄并等待其退出，无需依赖 EOF。包装器被强杀时 Job 回收 MCP 与核心，正常 EOF 也清理。无 Qoder 祖先的开发环境仍使用 Node 加 EOF/Job 托管。
- 关闭任务、关闭窗口和真正退出 App 不是同一事件；关闭窗口后宿主可能仍存活，不承诺固定空闲回收时间。
- POSIX 沿用独立 Node supervisor 与 stdin/EOF 租约，MCP 结束后先 TERM，超时再 KILL。supervisor 自身被 `SIGKILL` 时无法清理，不具备 Windows Job 的内核级保证。控制端点失联但记录 PID 仍存在时拒绝接管或重复启动，应人工核实实例；尚未在 macOS/Linux 实机验证。
- 多任务可复用代理，非创建者结束不主动杀共享代理；创建者 MCP 回收可能关闭代理并中断其他任务请求，不自动重放。
- 启停验证归属，不按进程名批量杀进程。Windows 使用命名管道锁，POSIX 使用数据目录真实路径哈希对应的回环锁端口；冲突时等待并报错，不抢占服务。

## MCP 工具与图片

| 工具 | 用途 |
| --- | --- |
| `bridge_status` | 查询就绪、核心准备及失败原因、管理地址、凭据数量和模型，不返回 token 或 API Key |
| `bridge_start` | 解除暂停，必要时准备核心，启动或复用代理 |
| `bridge_stop` | 停止可确认归属的代理，取消本会话准备并持久暂停 |
| `bridge_generate_image` | 使用已授权订阅生成一张图片，可能消耗额度或产生费用 |

例如：“调用 qoder订阅代理的 `bridge_generate_image`，用 `gpt-image-2.5` 生成一张白底绿色三角形。”

支持 `prompt`、`model`、`size`、`quality`、`background`、`output_format`，默认模型 `gpt-image-2.5`，以账号权限为准。仅文生图，每次一张，不接收参考图，不改变聊天主模型。MCP 不自动换模型或重新提交，但**上游核心可能轮换凭据、刷新授权或重试，单次调用不保证只消耗一次额度**。

原图保存在 `generated/`，不会被压缩替换。小图可预览，Windows 大 PNG/JPEG 可附小预览，POSIX 大图和大 WebP 返回原图本地链接。保存前检查 PNG、常见 Huffman DCT JPEG（含渐进式）及静态 WebP 的结构和尺寸，像素上限 4000 万；不支持动画 WebP，结构检查不等于完整像素解码。上游不一定严格遵守尺寸和质量参数。

## 数据与安全

默认端口 **`19787`**，数据目录 **`~/.qoder/qoder-subscription-proxy/data`**，Windows 对应 `%USERPROFILE%\.qoder\qoder-subscription-proxy\data`。**CN 版也用此插件专属稳定目录，不是 Qoder App 设置目录**。数据不在安装缓存内，不随版本变化；管道、缓存、锁与兄弟 Zcode 插件隔离，不复制真实账号或旧运行数据。

| 路径 | 内容 |
| --- | --- |
| `launcher-secrets.json` | 随机模型 API Key |
| `config.yaml`、`auths/` | 运行配置及敏感授权凭据 |
| `bridge.log` | 日志可能包含上游账号或请求信息，分享前须脱敏 |
| `bridge.pid`、`bridge.paused` | 归属记录与持久暂停状态；POSIX 控制令牌也是敏感信息，陈旧 PID 文件不代表进程仍存活 |
| `runtimes/` | 经校验的固定版本、当前平台核心 |
| `management-panel/`、`generated/` | 生成的管理页与原始图片 |

固定管理密码 `123456` **不能隔离本机其他用户或恶意软件**。服务只允许 `127.0.0.1`，强制 `management.allow-remote: false`；禁止用端口转发、反向代理、共享隧道或容器映射公开。模型 API Key 与管理密码不同。

Windows 权限由用户目录 ACL 决定；POSIX 新建私有目录用 `0700`，敏感文件及图片用 `0600`，既有自定义目录需自行保证私密性。不要把数据放入共享盘或仓库。卸载不自动删除授权、密钥、日志和图片，也不等于撤销服务商授权；撤销需在服务商账号安全页面操作，再按需删除本地凭据。

### 高级环境变量

| 变量 | 说明 |
| --- | --- |
| `BRIDGE_DATA_DIR` | 自定义独立数据目录，不自动迁移数据 |
| `BRIDGE_PORT` | 十进制 `1–65535`，默认 `19787`；变更需同步既有 YAML 和客户端地址 |
| `BRIDGE_HOST` | 只允许 `127.0.0.1` |
| `BRIDGE_API_KEY` | 覆盖运行时 API Key，须与既有 YAML 一致，不能等于管理密码 |
| `BRIDGE_MGMT_KEY` | 不设置或精确为 `123456`，其他值拒绝 |
| `BRIDGE_BIN` | 可信兼容的 CLIProxyAPI v8 可执行文件；不下载、替换或改权限，不扩展支持平台范围 |
| `QODER_HTTP_PROXY` | 核心 HTTPS 下载优先代理，否则沿用 curl 常见代理环境变量；仅设置 `HTTP_PROXY` 不保证用于 HTTPS |

不要把安装缓存中的 `.mcp.json` 改动当作长期配置。高级覆盖应通过宿主支持的 MCP 环境配置管理，保持各任务一致；不要公开含密码的代理 URL。配置核对器支持常见 v8 YAML 标量、块映射和列表，不支持任意锚点、多行或复杂流式集合。

## 故障排查与开发验证

- **管理页打不开**：确认 MCP 连接，等待后台准备并检查 `bridge_status`；修复失败原因后重连或 `bridge_start`。主动暂停后必须 `bridge_start`。
- **端口冲突**：停止已确认不需要的程序，或同步修改代理端口及配置；插件不抢端口、不杀其他代理。OAuth 固定回调端口不能这样任意改动。
- **密码错误 / API 401**：确认访问 `19787`；管理密码为 `123456`，模型 API 使用 `launcher-secrets.json` 的随机 `apiKey`。
- **403 / 429 / 5xx**：先检查权限、配额、网络和上游异常，不反复重启本机进程。
- **POSIX 找不到 PowerShell**：装错 Windows 清单，重新生成并上传 POSIX ZIP，不编辑安装缓存。
- **下载失败**：检查 curl、HTTPS、代理与目录权限，修复后手动重试或重连；哈希不匹配不得跳过校验。
- **核心不能执行**：检查架构、执行权限及 noexec/只读限制；不自动关闭 Gatekeeper、移除隔离属性或绕过企业策略。

开发者在仓库根目录使用 Node 22+ 运行：

```sh
node --test qoder-subscription-proxy/tests/*.test.mjs
```

普通测试不自动联网下载核心。原生核心测试需显式设置 `BRIDGE_TEST_BIN`，指向匹配当前平台固定 SHA256 的核心绝对路径，未设置时跳过。测试使用隔离临时目录和端口，不读取正式账号，不执行真实 OAuth 或付费生成。Windows Job 和 POSIX 生命周期测试须在对应系统执行。

验证 Windows 内置运行时还需将 `QODER_TEST_RUNTIME` 设置为实际 `Qoder CN.exe` 或 `Qoder.exe` 的绝对路径；对应测试通过 Node mode 启动隔离 harness，不关闭当前 Qoder App，也不修改其设置。

Windows 已完成 260 项测试中的 245 项，15 项按平台条件跳过，0 失败；Windows ZIP 解包后的 MCP 初始化、自动启动、管理页 HTTP 访问和 EOF 退出检查通过。**这不等于 Desktop 界面导入、真实账号登录或 macOS/Linux 实机验收通过。** 云端 CI 结果以仓库 Actions 页面为准，自动化测试不能替代真实服务端到端验收。
