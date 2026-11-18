# 第三方软件与许可证

## Magpie CLI

插件使用 Magpie 原生 CLI 提供模型 API、服务商适配、Web 管理与模型组路由。这些能力归上游，插件负责 MCP 接入、进程托管、私有数据隔离和本地交付，不应被理解为协议及管理系统的原创实现。

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/yetone/magpie |
| 固定核心版本 | `v0.1.4403` |
| 参考源码 | https://github.com/yetone/magpie/tree/v0.1.4403 （已核对固定源码标签） |
| 发布页 | https://github.com/yetone/magpie/releases/tag/v0.1.4403 |
| 许可证 | MIT，原文保存在 `server/bin/LICENSE` |
| 版权 | `Copyright (c) 2026 yetone` |
| 修改情况 | 使用原始 CLI 二进制，不修改其内容；分发路径按插件平台清单组织 |

插件 **1.1.3** 的每个平台 ZIP 只内置对应平台核心。固定资产、下载 URL、分发路径与完整 SHA256 以 [`server/bin/platforms.json`](server/bin/platforms.json) 为单一清单：

| 平台 | 随包路径（相对 server/bin） | 上游资产 |
| --- | --- | --- |
| Windows x64 | `magpie.exe` | `magpie-cli-windows-amd64.exe` |
| macOS x64 | `darwin-x64/magpie` | `magpie-cli-darwin-amd64` |
| macOS arm64 | `darwin-arm64/magpie` | `magpie-cli-darwin-arm64` |
| Linux x64 | `linux-x64/magpie` | `magpie-cli-linux-amd64` |
| Linux arm64 | `linux-arm64/magpie` | `magpie-cli-linux-arm64` |

这些资产为原始可执行文件，清单保留下载资产和二进制两个摘要字段。构建通过 `scripts/fetch-core.mjs` 下载、校验，运行时校验随包核心后安装到私有缓存；源码未随包才允许下载回退。摘要不等于数字签名、安全审计或五平台运行验收。

随包 [`server/magpie-third-party-notices.txt`](server/magpie-third-party-notices.txt) 已于 2026-11-18 与固定源码标签的 [`THIRD_PARTY_NOTICES`](https://github.com/yetone/magpie/blob/v0.1.4403/THIRD_PARTY_NOTICES) 逐字节核对一致，与 Magpie MIT 许可证一并保留。本说明不重写其依赖清单。MIT 不意味着远程服务、商标及全部依赖由本仓库重新许可。

## 用户自行安装的第三方插件

所需服务商插件由用户在 Magpie 原生管理页面自行选择、安装和管理，本插件不提供代装工具，也不固定社区插件版本。第三方插件及其运行依赖不随本插件 ZIP 分发，安装时可能联网下载；许可证、依赖与服务条款以用户实际选择的发行物为准，不能将 Magpie 的 MIT 许可扩展到这些组件。

GPT 生图由 Magpie 原生 `/v1/images/generations` 实现，插件只负责本地交付适配。

## 已移除组件

当前分发不再包含 CLIProxyAPI、自定义 Rust 审批路由扩展及其依赖、旧管理页面及补丁。历史用户数据不读取、迁移或删除，历史缓存忽略规则仅用于防止误提交。

## 系统与本仓库许可

插件使用宿主 Windows PowerShell、.NET/Win32、macOS/Linux、Qoder 和 Node.js 能力，不重新分发这些产品或运行时，其许可分别适用。本仓库不是 Qoder、Magpie、Google 或其他服务商的官方扩展。

插件原创代码许可见 `LICENSE`，使用风险及责任边界见 `DISCLAIMER.md`。再分发须保留所有适用版权及许可声明；本说明不代表已经发布或完成真实账号及安装验收。
