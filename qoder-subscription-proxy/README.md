# qoder订阅代理 · 1.0.4

基于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的 Qoder Desktop 第三方插件：将本人合法授权的订阅接入本机 OpenAI 兼容 API，并在插件连接器上提供一键打开免密管理登录页的按钮。不赠送订阅、额度或账号权限，不是 Qoder、CLIProxyAPI、OpenAI 或 Google 官方产品。

> 管理密码和模型 API Key 都保存在本机用户数据目录。请保护该目录，并让代理仅在本机回环地址提供服务。[免责声明](DISCLAIMER.md) · [第三方软件与许可证](THIRD_PARTY_NOTICES.md)

## 安装与兼容范围

从本地构建目录 `dist/` 或 [GitHub Releases](https://github.com/crx-96/axing-qoder-plugin/releases) 选择安装包，按[仓库下载与安装说明](../README.md#下载与安装)在 Desktop **扩展 → 插件 → 添加插件 → 上传插件 ZIP** 导入。安装包按平台拆分并内置对应核心：Windows x64 为 `qoder-subscription-proxy-v1.0.4-win32-x64.zip`，macOS/Linux 按系统架构选择 `darwin-x64`、`darwin-arm64`、`linux-x64`、`linux-arm64` 同名 ZIP；不要下载自动生成的源码归档作为安装包。

| 项目 | 范围与验证边界 |
| --- | --- |
| Qoder | 本机核对 Desktop CN `0.5.1`；程序为 `Qoder CN.exe`，国际版为 `Qoder.exe` |
| 内置运行时 | Electron 内置 Node mode 或系统 Node 22+；Windows 启动器依赖 PowerShell 5.1、.NET Framework 与 Job Object |
| Windows | Windows 10 22H2 x64 / Windows 11 x64 为兼容目标；Windows 10 尚未单独验收 |
| macOS / Linux | x64 / ARM64；依赖 `/bin/sh` 与系统进程工具；尚未实机验证 |
| 核心 | 固定 CLIProxyAPI `v8.0.57`，安装包内置当前平台核心，校验 SHA256 后安装到本机缓存，无需首启下载 |
| 不支持 | Windows 32 位、原生 Windows ARM64 及其他平台/架构 |

## 连接器与管理页按钮

插件声明两个连接器：

| 连接器 | 类型 | 职责 |
| --- | --- | --- |
| `qoder-subscription-proxy` | stdio | 代理生命周期托管与 MCP 工具（状态、启停、打开管理页） |
| `management-page` | http | 指向本机管理网关 `http://127.0.0.1:19788/mcp` 的授权元数据端点 |

`management-page` 连接器按 RFC 9728 暴露受保护资源与授权服务器元数据，其授权端点就是本机免密管理页：在插件详情页或连接器列表点击该连接器行的 **授权 / 重新授权** 按钮，默认浏览器即打开已登录的授权与账号管理页。该连接器的回调故意不完成，因此连接器保持「待授权」状态、按钮常驻，随时可再次点击跳转；它不提供工具，也不影响 stdio 连接器与模型请求。

网关随 stdio 连接器会话常驻监听 `19788`。票据 1 分钟后失效，兑换后的浏览器会话最长 30 分钟；会话过期后重新点击按钮即可。端口被其他程序占用时网关不监听，按钮点击无效，`bridge_status` 会返回 `gatewayError` 诊断。

## 固定端口

| 端口 | 用途 |
| --- | --- |
| `19787` | 模型 API（OpenAI 兼容 `/v1`）与核心原生管理面板 |
| `19788` | 管理页网关：免密登录入口、连接器授权元数据、管理 API 同源代理 |

两个端口互不相同，作为常量固定，**不随版本更新变动**；模型客户端地址与管理页按钮地址都依赖该约定。仅高级环境变量 `BRIDGE_PORT` 可覆盖模型端口，覆盖后须同步修改供应商 Base URL（连接器地址仍为 19788）。

## 首次使用

1. 安装、启用插件并确认 stdio 连接器已连接。握手只等待本地配置，随包核心在后台校验安装并自动启动代理，无需联网下载，也无需先有聊天模型。
2. 在插件详情页点击 `management-page` 连接器的 **授权** 按钮，浏览器打开免密管理页；首次接入订阅时在该页选择服务商，由本人登录并同意授权。
3. 在 Qoder 模型/供应商设置中添加 OpenAI 兼容服务：
   - **Base URL**：`http://127.0.0.1:19787/v1`
   - **API Key**：数据目录 `launcher-secrets.json` 中的 `apiKey`
   - **协议和模型**：按管理页或 `bridge_status` 实际列出的聊天模型选择 Chat Completions 或 Responses
4. 有可用聊天模型后，可让 AI 调用 `bridge_status` 查看就绪状态、核心准备情况与模型样例。`ready: true` 仅表示本机代理和模型列表接口可用，不保证订阅权限。

**手动登录**　也可在代理就绪后打开 <http://127.0.0.1:19787/management.html>，输入数据目录 `launcher-secrets.json` 中的 `mgmtKey`。只向已确认属于本插件的本机管理页输入凭据。

API Key 与管理密钥首次随机生成并持久保存，升级不自动轮换或清空授权。不要将密钥、账号 token 或授权 URL 发给 AI、公开截图或提交仓库。

**Antigravity（Google 账号）授权**　管理页默认自动接收 `localhost:51121` 回调，无需手动粘贴。只有核心明确报告回调监听启动失败时，页面才自动重试为手动模式，并显示手动回填提示；网络错误、鉴权失败或取消不会触发此重试。手动模式下，完成 Google 授权后复制地址栏完整回调 URL，回到原管理页提交；回调页无法访问不影响手动提交，请勿向占用该端口的其他页面输入授权信息。回调须包含本次授权的 `code` 和匹配的 `state`，请在 5 分钟内完成。独立的 Windows 授权助手仍使用手动回填。

## 核心配置策略

插件生成的 `config.yaml` 只包含本机安全必需字段：回环监听与固定端口、仅本机管理（`allow-remote: false`）、固定随包管理页、客户端 API Key、授权目录。**重试、冷却、流式心跳、启动缓冲等请求参数一律沿用 CLIProxyAPI 上游默认值**，插件不写入、不复位、不迁移；如需调整请在管理页或 `config.yaml` 中自行设置。

第一个功能性例外是终端自动审批兼容：冷启动会在 `requests.payload.override` 补齐定向规则，把宿主自动权限模式的安全分类请求（CN 与国际版两种提示措辞）路由到 `codex-auto-review` 并附加终端风险判断指引。该规则只匹配独立审批检查请求，不影响普通对话；识别条件变化时需重新核对。规则补齐幂等，用户修改过的规则保留。

第二个例外是上游出口代理：核心只读取 `requests.proxy-url` 与 `HTTPS_PROXY` 等环境变量，**不读取 Windows 的「系统代理」设置**。冷启动会读取 `HKCU` 的 Internet Settings，把启用中的 HTTP(S) 系统代理写入 `requests.proxy-url`，包括默认端口 80/443；系统代理关闭时写回空值，**空值仍允许核心使用环境代理，不代表强制直连**。同步只改写插件上次写入的值（记录在数据目录 `bridge.proxy`），或用户已清空/删除的代理字段；你自行设置的非空代理（含 `direct`、`none` 或任意自定义地址）原样保留，没有归属记录时即使与系统代理相同也不接管。清空或删除该字段即可恢复跟随。切换代理模式或端口后需 `bridge_stop` 再 `bridge_start`；只调用 `bridge_start` 会复用正在运行的桥，多会话下重连一个连接器也不保证重启共享桥。

系统代理与 TUN 可以并存。地址可建立 TCP 连接时继续使用显式代理，但这不保证代理协议或上游可用，也不保证实际网络只有一跳。地址不可达时才检查活动网卡及路由表：只有 IPv4 的优选默认路由（或覆盖两半地址空间的 `/1` 路由）均指向已连接隧道网卡，且存在非链路本地 IPv6 地址时 IPv6 也满足对应条件，才写入 **`direct` 显式直连，绕过遗留环境代理**；自动写入的 `direct` 同样登记归属，后续冷启动可恢复系统代理。只连接内网的 Tailscale/企业 VPN、非隧道优先路由、等价混合出口、查询失败或超时都不足以触发回退，此时保留系统代理地址，允许客户端恢复后自行连通。路由证据不等于目标服务可用，更具体的路由、客户端分流和上游故障仍可能影响访问；需要固定出口时自行填写代理字段。

系统代理关闭时不探测地址或网卡，空配置沿用环境代理；要明确禁用环境代理可手填 `direct`/`none`。PAC 自动配置脚本和仅 SOCKS 的系统代理不自动转换为 HTTP(S) 地址，需要固定出口时手工配置。macOS/Linux 不读取 Windows 注册表，沿用核心环境代理。

正常安装无需下载核心；仅从源码直接运行等未随包场景才回退下载，并复用上述系统代理发现。下载优先保留显式 `QODER_HTTP_PROXY`、`https_proxy`、`HTTPS_PROXY`、`all_proxy`、`ALL_PROXY`（含显式空值）；这些变量均未设置时才使用系统代理或已确认的隧道直连策略，`NO_PROXY`/`no_proxy` 例外继续生效。下载代理只注入该次 curl 子进程，不修改宿主环境或 Windows 设置。

## MCP 工具与生图

| 工具 | 用途 |
| --- | --- |
| `bridge_status` | 查询就绪、核心准备及失败原因、管理地址、凭据数量和模型，不返回 token 或 API Key |
| `bridge_start` / `bridge_stop` | 解除暂停并启动 / 持久暂停并停止可确认归属的代理 |
| `bridge_open_management` | 在系统浏览器打开免密管理页 |
| `image_gen_gpt` | 经本机代理 OpenAI 图片接口生图（`gpt-image-*` 系） |
| `image_gen_gemini` | 经本机代理聊天接口生图（`gemini-*-image` 系） |

生图工具省略 `model` 时按族内可用模型自动决策：仅一个直接生成；多个返回 `needsModelChoice` 与候选列表，由宿主弹窗交用户选择后带 `model` 重调。图片 base64 不落对话，统一解码保存到数据目录 `generated/`，工具只返回路径与元数据。说"GPT/OpenAI 生图"或"Gemini/谷歌生图"即触发对应工具；不使用宿主内置 ImageGen 通道。

## 数据与安全

默认数据目录 **`~/.qoder/qoder-subscription-proxy/data`**（Windows 为 `%USERPROFILE%\.qoder\qoder-subscription-proxy\data`），CN 版与国际版共用该插件专属稳定目录，升级保留已有授权。

| 路径 | 内容 |
| --- | --- |
| `launcher-secrets.json` | 随机模型 API Key（`apiKey`）和本安装的管理密码（`mgmtKey`） |
| `config.yaml`、`auths/` | 运行配置及敏感授权凭据 |
| `bridge.log` | 日志可能包含上游账号或请求信息，分享前须脱敏 |
| `bridge.pid`、`bridge.paused` | 归属记录与持久暂停状态 |
| `bridge.proxy` | 插件上次同步进 `requests.proxy-url` 的系统代理值，用于区分用户自管代理 |
| `runtimes/` | 经校验的固定版本、当前平台核心 |
| `management-panel/`、`generated/` | 生成的管理页与生图工具输出 |

保持 `management.allow-remote: false`，仅在可信本机使用；不要通过代理或隧道公开管理服务。Windows 权限由用户目录 ACL 决定，POSIX 新建私有目录用 `0700`、敏感文件用 `0600`。卸载不自动删除授权、密钥、日志和图片，也不等于撤销服务商授权。

### 高级环境变量

| 变量 | 说明 |
| --- | --- |
| `BRIDGE_DATA_DIR` | 自定义独立数据目录，不自动迁移数据 |
| `BRIDGE_PORT` | 模型端口，十进制 `1–65535`，默认 `19787`；变更需同步供应商地址 |
| `BRIDGE_HOST` | 只允许 `127.0.0.1` |
| `BRIDGE_API_KEY` | 覆盖模型客户端密钥，须满足 HTTP 请求头要求并与已有配置一致 |
| `BRIDGE_MGMT_KEY` | 通常留空；管理密码由本机生成，不允许覆盖 |
| `BRIDGE_BIN` | 可信兼容的 CLIProxyAPI v8 可执行文件；不下载、不替换 |
| `QODER_HTTP_PROXY` | 未随包时核心 HTTPS 回退下载的优先代理；只影响下载，模型出口见「核心配置策略」的系统代理同步 |

## 自动启动与退出清理

- 自动启动以宿主已拉起 stdio 连接器为前提，不注册系统服务、计划任务或开机启动项。
- Windows 启动器查找实际 `Qoder.exe` / `Qoder CN.exe` 祖先进程，Job Object 在宿主退出或包装器被强杀时回收 MCP 与核心；POSIX 沿用独立 Node supervisor 与 stdin/EOF 租约，先 TERM 超时再 KILL。
- `bridge_stop` 持久暂停自动恢复；`bridge_start` 解除暂停并重试下载或启动。多任务可复用代理，非创建者结束不主动杀共享代理。
- 启停与凭据发送前验证进程归属，不按进程名批量杀进程。

## 故障排查

- **按钮点击无反应**：确认 stdio 连接器已连接（网关随其监听）；`bridge_status` 的 `gatewayError` 会说明 19788 占用等原因。
- **管理页打不开**：等待后台核心准备完成或检查 `bridge_status`；修复失败原因后重连或 `bridge_start`。
- **模型 API 401**：核对供应商 API Key 与本机 `launcher-secrets.json`。
- **管理页登录失败**：重新点击连接器按钮；手动登录时核对 `mgmtKey` 与端口。
- **403 / 429 / 5xx**：先检查权限、配额、网络和上游异常，不反复重启本机进程。
- **随包核心校验失败**：提示 SHA256 不匹配或随包核心无效时，重新下载对应平台的官方 ZIP 并重装；哈希不匹配不得跳过校验。
- **下载失败（仅未随包的源码运行）**：检查 curl、HTTPS、代理与目录权限后重试。
- **切换 TUN / 系统代理后出口不符合预期**：同步只发生在冷启动，`bridge_stop` 再 `bridge_start`；系统代理不可达且默认路由确认由隧道承载时才写入显式 `direct`。空值仍可能使用环境代理，需要固定出口请自行填写 `requests.proxy-url`，清空或删除可恢复跟随。

## 开发验证

仓库根目录使用 Node 22+ 运行：

```sh
node --test qoder-subscription-proxy/tests/*.test.mjs
```

普通测试不联网下载核心；原生核心测试需显式设置 `BRIDGE_TEST_BIN` 指向匹配固定 SHA256 的核心。设置 `BRIDGE_TEST_BROWSER` 可运行管理页浏览器交接测试。Windows Job 与 POSIX 生命周期测试须在对应系统执行。
