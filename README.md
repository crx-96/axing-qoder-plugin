# 订阅代理管理 · Qoder 插件

在 Qoder 里使用自己已获授权的模型服务。插件负责启动本机代理，Magpie 负责账号登录、模型选择和客户端配置。

**只在 Qoder 里用模型，选这个插件。** 安装并启用后，打开 Qoder、连接插件时，代理会自动启动；完全退出 Qoder 后，它托管的代理也会停止。关闭「订阅代理管理」标签页可以继续使用模型。若想让 Qoder 和其他工具长期共用一个代理，推荐单独运行 [Magpie](https://github.com/yetone/magpie)，这样退出 Qoder 后，其他工具仍可连接独立运行的服务。

## 安装和第一次使用

1. 在 Qoder 安装并启用插件。如果使用本地文件，打开 **扩展 → 插件 → 添加插件 → 上传插件 ZIP**，选择 `qoder-subscription-proxy-v2.0.0.zip`。Windows x64、macOS x64 / ARM64、Linux x64 / ARM64 共用一个包。GitHub 自动生成的 `Source code` 是开发源码。
2. 打开 **更多 → 订阅代理管理**。首次连接插件时，已有可用核心会直接复用。全新安装会下载并校验当前平台的官方最新稳定版，页面会显示实际进度或失败原因。
3. 代理就绪后，点击打开 **Magpie 原生管理页**，配置自己的服务商或登录自己的订阅账号，然后选择能用的模型。
4. **在 Qoder 添加自定义模型**，填写插件页面显示的模型端点和原生管理页中的 Model ID。如果希望用 Magpie 的 Agent 页面写入 Qoder 设置，请先启用客户端配置写回。两种方法及字段示例见 [插件使用指南](qoder-subscription-proxy/README.md)。

当前插件版本为 **2.0.0**。已有核心会继续使用；全新安装才按平台下载 Magpie 最新稳定版。后续升级由用户在管理页决定。下载已发布版本请查看 [GitHub Releases](https://github.com/crx-96/axing-qoder-plugin/releases)。本项目是独立开发的第三方插件，请仅使用本人拥有或已获授权的服务。详见[免责声明](qoder-subscription-proxy/DISCLAIMER.md)和[第三方软件许可](qoder-subscription-proxy/THIRD_PARTY_NOTICES.md)。

## 开发者打包

在仓库根目录使用 Node.js 22 或更高版本运行以下命令。先准备输出目录，已有 `dist` 时可跳过第一行。

```sh
mkdir dist
node qoder-subscription-proxy/scripts/package-plugin.mjs dist/qoder-subscription-proxy-v2.0.0.zip
```

打包按白名单收集插件代码、图标、说明和许可，生成一个小于 20 MB 的通用 ZIP。输出文件已存在时脚本会拒绝覆盖。打包只使用本地文件。用户安装后的下载和升级会核对 Magpie 官方 Release 中对应资产的地址、大小与 SHA256。仓库保留的历史核心清单用于识别旧缓存和开发测试。

```sh
node --test --test-concurrency=1 qoder-subscription-proxy/tests/*.test.mjs
```

原生核心集成测试需要 `BRIDGE_TEST_BIN` 指向对应平台且摘要匹配的核心；真实浏览器测试使用 `BRIDGE_TEST_BROWSER` 指向 Chrome 或 Edge。GitHub Release 流程运行平台测试、生成通用 ZIP、在草稿中核对资产后再公开。Qoder 插件市场的上架需要单独操作。
