# axing-qoder-plugin

面向 **Qoder Desktop** 的第三方插件集，当前包含 [qoder订阅代理](qoder-subscription-proxy/README.md)：将本人合法授权的订阅接入本机 OpenAI 兼容 API，提供代理管理与图片生成 MCP 工具。

仓库地址：[crx-96/axing-qoder-plugin](https://github.com/crx-96/axing-qoder-plugin)。本项目不是 Qoder 或订阅服务商的官方产品。

## 下载与安装

打开 [GitHub Releases 最新版本](https://github.com/crx-96/axing-qoder-plugin/releases/latest)，在 **Assets** 中下载对应系统的安装包；当前版本为 **0.2.3**：

| 系统 | 安装包 |
| --- | --- |
| Windows x64 | `qoder-subscription-proxy-v0.2.3-windows.zip` |
| macOS / Linux x64、ARM64 | `qoder-subscription-proxy-v0.2.3-posix.zip` |

**不要选择 GitHub 自动生成的 `Source code (zip)` 或 `Source code (tar.gz)`**，它们是整个仓库的源码，不是可直接导入的单插件安装包。用户无需克隆仓库或自行打包。

按 [Qoder 插件文档](https://docs.qoder.com/qoder/plugins) 和 [扩展发布文档](https://docs.qoder.com/qoder/extension-publishing)，在 Qoder Desktop 中进入 **扩展 → 插件 → 添加插件 → 上传插件 ZIP**，选择下载的文件；无需先解压。

安装后启用插件并确认 MCP 连接，再按[插件使用说明](qoder-subscription-proxy/README.md)打开管理页、授权和配置模型。Windows ZIP 已完成解包后的隔离启动与退出检查，但尚未完成 Desktop 界面导入验收；macOS/Linux 尚未实机验证。

## 从源码打包

开发者在仓库根目录使用已有 Node.js 22+ 执行：

```sh
mkdir dist
node qoder-subscription-proxy/scripts/package-plugin.mjs windows dist/qoder-subscription-proxy-v0.2.3-windows.zip
node qoder-subscription-proxy/scripts/package-plugin.mjs posix dist/qoder-subscription-proxy-v0.2.3-posix.zip
```

若 `dist` 已存在，无需再次创建。目标父目录必须先存在；脚本拒绝覆盖已有 ZIP。发布时文件名中的版本须与插件清单一致，并上传两个 ZIP 到对应的 GitHub Release，而不是提交二进制安装包到源码仓库。

ZIP 根目录直接是插件内容，不再套一层仓库或插件目录。POSIX 包会使用对应的 `.mcp.json`；源码默认 Windows 清单不能直接用于 macOS/Linux。

## 分发与兼容边界

- 插件清单为 `qoder-subscription-proxy/.qoder-plugin/plugin.json`；MCP 使用 `${QODER_PLUGIN_ROOT}` 和 `timeout: 660000`，与 Desktop 自带 `recordAndReplay` 资源一致，但不等于安装已验收。仓库 `.qoder-plugin/marketplace.json` 另按 Qoder CLI 市场规范保留，不据此承诺 Desktop 市场导入。
- 当前核对环境为 **Qoder Desktop CN 0.4.11**，实际程序名 `Qoder CN.exe`（国际版为 `Qoder.exe`）；已实测其 Electron `43.1.1` / Node `24.18.0` 的 Node mode。本机独立开发命令 `node` 为 `26.4.0`。
- 使用轻量 ZIP，不附带五平台核心二进制。首次 MCP 启动在后台下载固定 `v8.0.42` 的当前平台核心，校验归档与二进制 SHA256。此设计用于减少安装体积和网络耗时，**不是声称 Qoder 已禁止大包**；未确认官方 ZIP 大小上限。
- 完全离线准备需自行提供可信且兼容的 `BRIDGE_BIN`，不提供一键离线包承诺。远程授权与模型服务仍需要网络。
- `prepare-posix-marketplace.sh` 仅保留给支持本地市场的高级兼容客户端；尚未确认 Qoder Desktop 提供自定义市场 UI，不将其作为 Desktop 安装步骤。
- 默认端口 `19787`，数据位于 `~/.qoder/qoder-subscription-proxy/data`。CN 版也使用这个插件专属稳定目录，**不是 Qoder App 设置目录**。管道、缓存和锁与兄弟 Zcode 插件隔离，不复制真实账号或旧运行数据。

使用前请阅读[免责声明](qoder-subscription-proxy/DISCLAIMER.md)与[第三方软件与许可证](qoder-subscription-proxy/THIRD_PARTY_NOTICES.md)。固定管理密码 `123456` 只适用于可信单机回环服务；模型 API Key 随机生成，切勿公开服务或凭据。
