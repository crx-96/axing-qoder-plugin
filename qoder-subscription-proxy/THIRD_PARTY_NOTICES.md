# 第三方软件与许可证

## CLIProxyAPI

本插件使用 CLIProxyAPI，负责 MCP 接入、本机进程托管、配置与 ACP 适配；OpenAI 兼容接口、非 Google 服务商适配及管理接口来自上游，不应被理解为插件原创能力。

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/router-for-me/CLIProxyAPI |
| 固定核心版本 | `v8.0.74` |
| 对应源码 | https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.74 |
| 发布页 | https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.74 |
| 许可证 | MIT，原文保存在 `server/bin/LICENSE` |
| 修改情况 | 核心仅重命名，不修改二进制，不隐藏上游身份 |

插件 `1.0.12` 按五个平台打包，各 ZIP 只内置对应核心和原生扩展。核心缓存为 `dataDir/runtimes/v8.0.74/【platform-arch】/【basename】`。源码仓库保留来源清单、文档及许可证，不提交缓存和安装 ZIP。随包核心校验失败时拒绝运行；只有未随包才回退官方 Release 下载。`BRIDGE_BIN` 不扩展平台支持，插件不替换用户指定的核心。

| 平台 | 随包路径（相对 server/bin） | 官方归档 | 归档 SHA256 | 二进制 SHA256 |
| --- | --- | --- | --- | --- |
| Windows x64 | `qoder-plugin-subscription-proxy.exe` | `CLIProxyAPI_8.0.74_windows_amd64.zip` | `d84243f7a67086c2cbea17103ddc0da6f4ab709f3210803a7cf2241a2b492504` | `be9efadefff7e59cb837b47729a22b437d8120a1b5d0676a7f0f45f219fcfb22` |
| macOS x64 | `darwin-x64/qoder-plugin-subscription-proxy` | `CLIProxyAPI_8.0.74_darwin_amd64.tar.gz` | `788eed3efddb18d1bc9df89022201f88a4373e6e53c8711e16ae74fbef97c1b7` | `f468ed2cd7c5819e24de8875c125a6048d1e1b1f7564c92efeb7f41e050a8255` |
| macOS arm64 | `darwin-arm64/qoder-plugin-subscription-proxy` | `CLIProxyAPI_8.0.74_darwin_aarch64.tar.gz` | `22f29feb8646aee6b124ba0b4a974a92fbffd71d4c875da7e21ef36d698635f4` | `318acb3eebac60ecab276e8b5a3044e7b5a5cc1c44cf4cbbda891da5a17aa7d1` |
| Linux x64 | `linux-x64/qoder-plugin-subscription-proxy` | `CLIProxyAPI_8.0.74_linux_amd64.tar.gz` | `94205d5be11464c57fab5e05ebd44d73a89190f9410a13e9e78c67987738c26f` | `810a9f64ecc7f5a704bff666fec4549e262426efd2a0b9202cccfa0b56a73986` |
| Linux arm64 | `linux-arm64/qoder-plugin-subscription-proxy` | `CLIProxyAPI_8.0.74_linux_aarch64.tar.gz` | `f783d366ee4660448e5365be21db82e32dfa1c0f5c5175addf79ee27828649c5` | `b5aa9ae0e1f3e2a2fcb0aa0d9350d016765d96b19e07e2cc739e15a6261ae02c` |

五个平台均使用支持动态插件的发行物，不使用 `no-plugin`。归档 SHA256 已核对官方 `checksums.txt` 和 Release 资产 digest；`checksums.txt` 自身摘要为 `0ef75f553ae75afb536f0afe32a6d7588d7f365a54e1145cdce4514ab4bdace5`。二进制摘要从校验通过的归档计算。这些摘要不是数字签名，也不代表平台运行验收已完成。

运行时下载使用系统 curl，固定 HTTPS 来源，遵循显式代理及 NO_PROXY；下载失败不无限重试。POSIX 核心执行位为 `0755`。配置、凭据和运行数据保持在插件专属目录，停止只针对插件拥有的进程。

上游版权原文保留：

```text
Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME
```

随附 `server/bin/README.md`、`README_CN.md`、`config.example.yaml` 是固定版本上游原文。推广及其他产品内容归上游；普通用户以本插件 README 的本机安全配置为准。MIT 不代表远程服务、商标和所有上游依赖由本仓库重新许可。

## Google Antigravity ACP

- 官方发行注册表：https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
- 固定运行时：`1.5.0`，发行地址、归档及成员摘要保存在 `server/acp-platforms.json`。
- 官方下载域名：`dl.google.com`。插件不修改官方程序，不随安装 ZIP 再分发该程序；缺失时下载到私有缓存。
- 官方程序由 Google LLC 提供，采用 proprietary 许可，适用条款：https://antigravity.google/terms 。插件 MIT 许可不覆盖官方程序。
- 五个平台归档均已核对注册表提供的 SHA256；成员摘要从通过校验的归档计算。宿主程序与伴随文件也须匹配已验证发行，不能只凭文件名执行。
- Windows/macOS 归档约 100 MiB，Linux 归档约 260 MiB、解压约 820 MiB；下载与解压有独立容量限制。
- 使用官方程序不等于第三方主模型集成自动获得个人订阅授权。用户须选择适用于其用途的官方认证方式；插件不承诺避开识别或风控，不复制其他客户端 token。
- 协议参考：https://agentclientprotocol.com/overview/introduction 。工具挂起回传方案参考 DSH 项目 https://github.com/KouzakiUmi/dsh-antigravity-acp ，没有将其作为运行依赖或分发其插件。

## CLI Proxy API Management Center

- 来源：https://github.com/router-for-me/Cli-Proxy-API-Management-Center ，固定 `v1.26.7`。
- 原资产：https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.26.7/management.html ，保存为 `server/panel/management.upstream.html`。
- SHA256：`8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5`。
- MIT 与 `Copyright (c) 2026 Router-For.ME` 原文见 `server/panel/LICENSE`。
- 补丁由 `server/management-panel.mjs` 生成，提供 ACP 管理入口并阻止旧 Google OAuth 操作；不直接修改上游资产。
- 一次性登录票据、本地管理会话和 ACP 管理页由插件实现。生成页面按内容存入专属目录，禁用核心的管理页自动更新。

## 原生审批路由与 Rust 依赖

`native/approval-router` 是独立 Rust cdylib，目前仅保留 Codex 独立审批路由。Gemini 审批降本分流和旧 Antigravity 空补全续写已移除。扩展不修改上游核心，使用插件 MIT 许可。

`Cargo.lock` 固定依赖。各平台须原生构建动态库，运行时验证平台、ABI 与 SHA256。普通安装者无需 Rust；源码构建使用 `scripts/build-approval-router.mjs`。构建或打包不代表已发布或已完成安装验收。

| 依赖 | 版本 | 上游 | 许可 / 分发选择 |
| --- | --- | --- | --- |
| base64 | `0.22.1` | https://github.com/marshallpierce/rust-base64 | MIT OR Apache-2.0 / MIT |
| serde_json | `1.0.154` | https://github.com/serde-rs/json | MIT OR Apache-2.0 / MIT |
| itoa | `1.0.19` | https://github.com/dtolnay/itoa | MIT OR Apache-2.0 / MIT |
| memchr | `2.8.3` | https://github.com/BurntSushi/memchr | Unlicense OR MIT / MIT |
| serde_core | `1.0.229` | https://github.com/serde-rs/serde | MIT OR Apache-2.0 / MIT |
| zmij | `1.0.23` | https://github.com/dtolnay/zmij | MIT |

依赖许可原文集中保存在 `server/approval-router-licenses.txt`，保留 `serde_json/src/lexical/mod.rs` 的 Alexander Huszagh 来源及版权说明。未启用、未链接的可选依赖不列入动态库清单；更新依赖和工具链时需重新核对。

## 系统与本仓库许可

插件使用宿主 Windows PowerShell、.NET/Win32、macOS/Linux、Qoder 和 Node.js 能力，不重新分发这些产品或运行时，其许可分别适用。本仓库不是 Google、Qoder 或上游项目的官方扩展。

插件原创代码许可见 `LICENSE`，使用风险及责任边界见 `DISCLAIMER.md`。再分发须保留所有适用版权及许可声明。
