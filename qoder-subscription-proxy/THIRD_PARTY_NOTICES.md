# 第三方软件与许可证

## Magpie CLI

插件使用 Magpie 原生 CLI 提供模型 API、服务商适配、Web 管理与模型组路由。这些能力归上游，插件负责 MCP 接入、进程托管、私有数据隔离和本地交付，不应被理解为协议及管理系统的原创实现。

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/yetone/magpie |
| 用户核心版本 | 由本机当前选版决定。首次安装下载官方最新稳定版，也可在管理页下载其他稳定版。 |
| 随包许可对应的参考源码 | https://github.com/yetone/magpie/tree/v0.1.4582 |
| 官方各版本发布页 | https://github.com/yetone/magpie/releases |
| 许可证 | MIT，原文保存在 `server/bin/LICENSE` |
| 版权 | `Copyright (c) 2026 yetone` |
| 修改情况 | 插件通过官方 Release 下载原始 CLI，按清单校验后写入用户缓存 |

插件 **2.0.3** 使用通用安装包。没有可复用的本地核心时，从 Magpie 官方最新稳定 Release 下载对应原始 CLI。用户也可以指定某个已发布的版本。新下载按对应 Release 的资产大小和 SHA256 校验；旧安装的版本、平台及摘要见[历史发行清单](server/bin/legacy-releases.json)。

| 平台 | 清单中的路径标识 | 上游资产 |
| --- | --- | --- |
| Windows x64 | `magpie.exe` | `magpie-cli-windows-amd64.exe` |
| macOS x64 | `darwin-x64/magpie` | `magpie-cli-darwin-amd64` |
| macOS arm64 | `darwin-arm64/magpie` | `magpie-cli-darwin-arm64` |
| Linux x64 | `linux-x64/magpie` | `magpie-cli-linux-amd64` |
| Linux arm64 | `linux-arm64/magpie` | `magpie-cli-linux-arm64` |

2026-11-20 已核对 Git blob 摘要：本次工作树的 [`server/bin/LICENSE`](server/bin/LICENSE) 与 `v0.1.4582` 标签的 [`LICENSE`](https://github.com/yetone/magpie/blob/v0.1.4582/LICENSE) 一致，[`server/magpie-third-party-notices.txt`](server/magpie-third-party-notices.txt) 与同一标签的 [`THIRD_PARTY_NOTICES`](https://github.com/yetone/magpie/blob/v0.1.4582/THIRD_PARTY_NOTICES) 一致。两份原文均随包保留。本说明不重写其依赖清单。MIT 不意味着远程服务、商标及全部依赖由本仓库重新许可。

## 用户自行安装的第三方插件

所需服务商插件由用户在 Magpie 原生管理页面自行选择、安装和管理，本插件不提供代装工具，也不固定社区插件版本。第三方插件及其运行依赖不随本插件 ZIP 分发，安装时可能联网下载；许可证、依赖与服务条款以用户实际选择的发行物为准，不能将 Magpie 的 MIT 许可扩展到这些组件。

GPT 生图由 Magpie 原生 `/v1/images/generations` 实现，插件只负责本地交付适配。

## 已移除组件

当前分发不再包含 CLIProxyAPI、自定义 Rust 审批路由扩展及其依赖、旧管理页面及补丁。历史用户数据不读取、迁移或删除，历史缓存忽略规则仅用于防止误提交。

## 系统与本仓库许可

插件使用宿主 Windows PowerShell、.NET/Win32、macOS/Linux、Qoder 和 Node.js 能力，不重新分发这些产品或运行时，其许可分别适用。本仓库不是 Qoder、Magpie、Google 或其他服务商的官方扩展。

插件原创代码许可见 `LICENSE`，使用风险及责任边界见 `DISCLAIMER.md`。再分发须保留所有适用版权及许可声明；本说明不代表已经发布或完成真实账号及安装验收。
