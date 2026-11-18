# axing-qoder-plugin

面向 **Qoder Desktop** 的第三方插件集，当前包含 [qoder订阅代理](qoder-subscription-proxy/README.md)：将本人合法授权的订阅接入本机 OpenAI 兼容 API，提供代理管理 MCP 工具。

仓库地址：[crx-96/axing-qoder-plugin](https://github.com/crx-96/axing-qoder-plugin)。本项目不是 Qoder、Magpie 或订阅服务商的官方产品。

## 下载与安装

当前源码版本为 **1.1.4**，固定使用 **Magpie CLI v0.1.4403**。本地构建产物位于 `dist/`；已发布资产以 [GitHub Releases](https://github.com/crx-96/axing-qoder-plugin/releases) 实际列表为准。以下说明不代表本版本已发布、已安装验收或已通过五平台实机测试。

| 系统 | 安装包 |
| --- | --- |
| Windows x64 | `qoder-subscription-proxy-v1.1.4-win32-x64.zip` |
| macOS x64 | `qoder-subscription-proxy-v1.1.4-darwin-x64.zip` |
| macOS ARM64（Apple Silicon） | `qoder-subscription-proxy-v1.1.4-darwin-arm64.zip` |
| Linux x64 | `qoder-subscription-proxy-v1.1.4-linux-x64.zip` |
| Linux ARM64 | `qoder-subscription-proxy-v1.1.4-linux-arm64.zip` |

每个平台 ZIP 内置本平台的原始 Magpie CLI 核心；安装核心无需联网，不编译 Rust。授权、模型调用及用户主动安装的可选依赖仍可能需要网络。

**不要选择 GitHub 自动生成的 `Source code (zip)` 或 `Source code (tar.gz)`**：它们不是可直接导入的单插件安装包。按 [Qoder 插件文档](https://docs.qoder.com/qoder/plugins)，在 Desktop 的 **扩展 → 插件 → 添加插件 → 上传插件 ZIP** 选择对应文件，无需先解压。启用并连接 MCP 后，通过 `bridge_status.ready` 确认代理就绪，而不是仅看 MCP 已连接。

点击 **更多 → 订阅代理管理** 进入管理页，查看核心状态、显式启动、刷新状态或打开原生管理页。页面初始化仅调用 `bridge_status`，不自动启动核心或打开浏览器。账号登录通过页面的 **打开原生管理页（浏览器）** 按钮或 `bridge_open_management` 完成。

模型入口仍为 `http://127.0.0.1:19787/v1`，Magpie 原生管理页使用 `19788`。打开原生管理页时，浏览器用本次核心启动的密钥换取 HttpOnly cookie。核心重启后旧链接与 cookie 都会失效，重新点击管理按钮即可登录。请保护登录链接、cookie 和本机凭据。

升级前等待请求结束并调用 `bridge_stop`。macOS 和 Linux 用户还需关闭共享该数据目录的旧版 MCP 会话，随后导入新版、重连并调用 `bridge_start`。需要在 Magpie 中本人重新登录；插件不读取、迁移或删除旧配置与授权数据，也不复制其他客户端账号或接管其他 Magpie 桌面配置。

## 从源码打包

开发者需要 Node.js 22+ 和下载工具；无需 Rust/Cargo。从仓库根目录执行，以下以 Windows x64 为例（`dist` 已存在则省略创建）：

```sh
mkdir dist
node qoder-subscription-proxy/scripts/fetch-core.mjs win32-x64
node qoder-subscription-proxy/scripts/package-plugin.mjs win32-x64 dist/qoder-subscription-proxy-v1.1.4-win32-x64.zip
```

其他平台使用 `darwin-x64`、`darwin-arm64`、`linux-x64`、`linux-arm64`。`fetch-core.mjs all` 可准备五平台固定原始 CLI 资产；来源、路径与 SHA256 以 [`server/bin/platforms.json`](qoder-subscription-proxy/server/bin/platforms.json) 为准。核心缓存位于 `qoder-subscription-proxy/.core-build/<platform>/`，不要提交缓存或安装 ZIP。

打包脚本按白名单分发，校验核心摘要，拒绝覆盖已有 ZIP；目标父目录须已存在。ZIP 根目录直接为插件内容，非 Windows 包将 `mcp.posix.json` 发布为 `mcp.json` 并保留核心执行位。源码直接运行且没有随包核心时可下载固定核心；随包核心损坏不会以下载静默替换。

`prepare-posix-marketplace.sh` 仅用于支持本地市场的高级兼容客户端：先用 `fetch-core.mjs` 准备当前平台核心，再生成一个新的独立目录。脚本只复制并校验当前平台 `.core-build` 中的核心，不下载、不注册市场、不安装插件、不修改已有缓存。Desktop 用户仍应使用 ZIP。

## 发布 Release

Release workflow 核对版本、准备固定核心、运行测试并打包，将五个平台的 ZIP 上传到草稿，核对远端资产后公开 Release。重跑已公开的版本只校验资产。实际发布须独立执行并核验结果，源码说明与本地测试不等于已发布。分发清单、插件清单和 workflow 是构建事实来源。

## 分发与安全边界

- 默认数据目录为 `~/.qoder/qoder-subscription-proxy/data`，Magpie 私有配置和授权放在 `dataDir/magpie`，XDG cache/state 独立隔离。这不是 Qoder 应用设置目录。
- `launcher-secrets.json` 保留 `apiKey` 与 `mgmtKey`。`apiKey` 用作客户端标识；固定 Magpie 回环 API 接受任意 key，**不能把它当作强制 API 认证**。服务仅限 loopback，禁止共享、端口映射或对外反向代理。
- 订阅账号默认关闭；使用前须用户在 Magpie 隐私设置显式开启，这也会允许发现本机其他客户端账号，并非仅开放手动登录。核心自动更新关闭。所需服务商插件由用户在 Magpie 原生管理页面自行安装和管理；本插件不提供代装工具，第三方插件及其运行依赖不随本插件 ZIP 打包。
- GPT 生图走 Magpie 原生 `/v1/images/generations`，插件只做本地交付薄适配；旧 Gemini 生图工具已移除。
- 安装、真实账号、模型调用及五平台运行需要分别验收。自定义 `BRIDGE_BIN` 不自动下载或替换。

[重构后快速使用](qoder-subscription-proxy/README.md#重构后快速使用) · [插件完整说明](qoder-subscription-proxy/README.md) · [免责声明](qoder-subscription-proxy/DISCLAIMER.md) · [第三方软件与许可证](qoder-subscription-proxy/THIRD_PARTY_NOTICES.md)
