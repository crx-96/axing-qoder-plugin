# axing-qoder-plugin

面向 **Qoder Desktop** 的第三方插件集，当前包含 [qoder订阅代理](qoder-subscription-proxy/README.md)：将本人合法授权的订阅接入本机 OpenAI 兼容 API，提供代理管理 MCP 工具。

仓库地址：[crx-96/axing-qoder-plugin](https://github.com/crx-96/axing-qoder-plugin)。本项目不是 Qoder 或订阅服务商的官方产品。

## 下载与安装

本地构建的安装包位于 `dist/`。也可从 [GitHub Releases](https://github.com/crx-96/axing-qoder-plugin/releases) 下载已发布版本的同名资产。当前源码版本为 **1.0.6**。

| 系统 | 安装包 |
| --- | --- |
| Windows x64 | `qoder-subscription-proxy-v1.0.6-win32-x64.zip` |
| macOS x64 | `qoder-subscription-proxy-v1.0.6-darwin-x64.zip` |
| macOS ARM64（Apple Silicon） | `qoder-subscription-proxy-v1.0.6-darwin-arm64.zip` |
| Linux x64 | `qoder-subscription-proxy-v1.0.6-linux-x64.zip` |
| Linux ARM64 | `qoder-subscription-proxy-v1.0.6-linux-arm64.zip` |

每个安装包只内置对应平台的 CLIProxyAPI 核心，安装后无需再下载核心即可使用；请按本机系统与架构选择，不要混用。

**不要选择 GitHub 自动生成的 `Source code (zip)` 或 `Source code (tar.gz)`**，它们是整个仓库的源码，不是可直接导入的单插件安装包。用户无需克隆仓库或自行打包。

按 [Qoder 插件文档](https://docs.qoder.com/qoder/plugins) 和 [扩展发布文档](https://docs.qoder.com/qoder/extension-publishing)，在 Qoder Desktop 中进入 **扩展 → 插件 → 添加插件 → 上传插件 ZIP**，选择下载的文件；无需先解压。

安装后启用插件并连接 MCP。待代理就绪，在插件详情页点击 `management-page` 连接器的 **授权** 按钮，浏览器即通过固定回环端口 `19788` 打开免密管理登录页；首次接入订阅时在该页选择服务商完成授权。模型 API 固定使用端口 `19787`。[插件使用说明](qoder-subscription-proxy/README.md)

从旧版升级时，先等请求结束并调用 `bridge_stop`。导入新版、重连 MCP 后调用 `bridge_start`，即可使用新版工具；重试、流式等请求参数沿用核心上游默认值，插件不再写入或迁移，只按 Windows 系统代理同步 `requests.proxy-url`，详见[插件核心配置策略](qoder-subscription-proxy/README.md#核心配置策略)。

## 从源码打包

开发者在仓库根目录使用已有 Node.js 22+ 执行：

```sh
mkdir dist
# 先获取并校验各平台核心（复用生产下载与两级 SHA256 校验，产物在 .core-build，可重复运行跳过已校验缓存）
node qoder-subscription-proxy/scripts/fetch-core.mjs all
node qoder-subscription-proxy/scripts/package-plugin.mjs win32-x64 dist/qoder-subscription-proxy-v1.0.6-win32-x64.zip
node qoder-subscription-proxy/scripts/package-plugin.mjs darwin-x64 dist/qoder-subscription-proxy-v1.0.6-darwin-x64.zip
node qoder-subscription-proxy/scripts/package-plugin.mjs darwin-arm64 dist/qoder-subscription-proxy-v1.0.6-darwin-arm64.zip
node qoder-subscription-proxy/scripts/package-plugin.mjs linux-x64 dist/qoder-subscription-proxy-v1.0.6-linux-x64.zip
node qoder-subscription-proxy/scripts/package-plugin.mjs linux-arm64 dist/qoder-subscription-proxy-v1.0.6-linux-arm64.zip
```

若 `dist` 已存在，无需再次创建。目标父目录必须先存在；脚本拒绝覆盖已有 ZIP，并会核对构建核心 SHA256 与平台清单一致。重建前将旧产物移出待发布目录，尤其不要混入同版本的 `-windows.zip` / `-posix.zip` 旧包，它们不包含核心。正式发布由下方 Release workflow 完成；手动构建时文件名中的版本也须与插件清单一致，不要将二进制安装包或 `.core-build` 缓存提交到源码仓库。

ZIP 根目录直接是插件内容，不再套一层仓库或插件目录。非 Windows 包会使用对应的 `mcp.posix.json` 内容发布为 `mcp.json`，并为内置核心保留执行位；源码默认 Windows 清单不能直接用于 macOS/Linux。

## 发布 Release

推送 `v*` 标签，或在 GitHub Actions 手动触发 `Release` workflow。workflow 会校验标签与 `qoder-subscription-proxy/.qoder-plugin/plugin.json` 版本一致，获取并校验五个平台核心，运行测试，打包五个 ZIP，并在 Release 不存在时创建、逐个上传资产；单个资产上传失败会重试。正式发布不需要在本地手动上传大文件。

## 分发与兼容边界

- 插件清单为 `qoder-subscription-proxy/.qoder-plugin/plugin.json`；MCP 使用 `${QODER_PLUGIN_ROOT}` 和 `timeout: 660000`，与 Desktop 自带 `recordAndReplay` 资源一致，但不等于安装已验收。仓库 `.qoder-plugin/marketplace.json` 另按 Qoder CLI 市场规范保留，不据此承诺 Desktop 市场导入。
- 已核对的桌面版本为 **Qoder Desktop 0.5.7**；CN 版程序名为 `Qoder CN.exe`，国际版为 `Qoder.exe`。入口可复用桌面内置 Node mode 或系统 Node.js 22+。
- 安装包按平台拆分，各自内置固定 `v8.0.63` 的当前平台 CLIProxyAPI 核心；首次 MCP 启动把随包核心校验 SHA256 后安装到本机缓存，无需联网下载。仅从源码直接运行（未随包）时才回退到官方 Release 下载，同样校验归档与二进制 SHA256。
- 安装后即可离线准备核心；远程授权与模型服务仍需要网络。自定义 `BRIDGE_BIN` 仍不下载、不替换。
- `prepare-posix-marketplace.sh` 仅保留给支持本地市场的高级兼容客户端；尚未确认 Qoder Desktop 提供自定义市场 UI，不将其作为 Desktop 安装步骤。
- 默认端口 `19787`，数据位于 `~/.qoder/qoder-subscription-proxy/data`。CN 版也使用这个插件专属稳定目录，**不是 Qoder App 设置目录**。管道、缓存和锁与兄弟 Zcode 插件隔离，不复制真实账号或旧运行数据。

模型客户端使用本机数据目录 `launcher-secrets.json` 中的 `apiKey`。管理页另用 `mgmtKey`，平时可通过插件指令免输密码。请将两项凭据仅留在本机。[免责声明](qoder-subscription-proxy/DISCLAIMER.md) · [第三方软件与许可证](qoder-subscription-proxy/THIRD_PARTY_NOTICES.md)
