# 第三方软件与许可证

## CLIProxyAPI

本插件使用 **CLIProxyAPI**，在宿主启动插件 MCP 进程时后台自动校验/准备当前平台核心，缺少有效缓存则下载；MCP 握手只等待本地配置，核心准备完成后自动启动代理，无需先有模型或工具调用。CLIProxyAPI 提供 OpenAI 兼容 API、服务商适配、模型列表、OAuth 管理及图片生成接口。插件自己的代码负责 Qoder MCP 接入、本机进程托管、本地配置和授权辅助，不应被理解为这些上游能力的原创实现。

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/router-for-me/CLIProxyAPI |
| 固定下载版本 | `v8.0.42`；支持 Windows x64、macOS x64/arm64、Linux x64/arm64，每台机器仅下载当前平台 |
| 对应源码 | https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.42 |
| 发布页 | https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.42 |
| 许可证 | MIT，原文保存在 [`bridge/bin/LICENSE`](bridge/bin/LICENSE) |
| 原程序名 | Windows：`cli-proxy-api.exe`；macOS/Linux：`cli-proxy-api` |
| 修改情况 | 仅重命名文件，不修改二进制内容，不隐藏上游身份 |
| 平台与来源清单 | [`bridge/bin/platforms.json`](bridge/bin/platforms.json)，保留原 `path` 字段标识；实际缓存仅使用其 basename |

插件 `0.2.3` 不分发以下二进制，只保留来源清单、上游文档与许可证。默认缓存为 `dataDir/runtimes/v8.0.42/<platform-arch>/<basename(platforms.json.path)>`，`dataDir` 默认为 `~/.qoder/qoder-subscription-proxy/data`。MCP 启动会后台准备核心，watchdog 不下载或自动重试下载；离线可使用 `BRIDGE_BIN` 指向可信当前平台核心。用户 `bridge_stop` 会取消本会话在途准备并持久暂停，重连仍可握手，但不自动下载或启动；显式 `bridge_start` 可恢复。无账号时也可启动管理页，宿主连接 MCP 的时机不由插件控制，不承诺打开空白窗口即触发。

固定二进制的清单标识与 SHA256（上游 `amd64` 对应 Node `x64`，`aarch64` 对应 `arm64`）：

| 平台/架构 | 清单 path（不是随包文件） | 二进制 SHA256 |
| --- | --- | --- |
| Windows x64 | `qoder-plugin-subscription-proxy.exe` | `cbc447b908a63f79c4fd0ca05b7d27381f6ccc24d1e953b190aba6339e0f8db1` |
| macOS x64 | `darwin-x64/qoder-plugin-subscription-proxy` | `e06d2290a8ad288eedf8c29683804dfe086956dafc3f03218f12b75b758a10a8` |
| macOS arm64 | `darwin-arm64/qoder-plugin-subscription-proxy` | `43357542dafc263725dfa675fa5c661964aa8a7a81b818987f97bd50b690d489` |
| Linux x64 | `linux-x64/qoder-plugin-subscription-proxy` | `74661f8cf949977870231359e8bf4344e07946766a673c08fa25a3e5f72fc95e` |
| Linux arm64 | `linux-arm64/qoder-plugin-subscription-proxy` | `cb00ad37a36e5dbe12a40cd6a6a19e77b9d3474a9fcb58e315736a98cf4b0775` |

官方归档与 GitHub Release API `digest` 中的 SHA256：

| 官方发布资产 | 归档 SHA256 |
| --- | --- |
| [CLIProxyAPI_8.0.42_windows_amd64.zip](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.42/CLIProxyAPI_8.0.42_windows_amd64.zip) | `c83881bc1cd0c3b4f1d9ba2d504ee6d8d741ed96d4c45abc7b9ced1c6fb85a64` |
| [CLIProxyAPI_8.0.42_darwin_amd64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.42/CLIProxyAPI_8.0.42_darwin_amd64.tar.gz) | `730bd33a6943bb1fdb011c65120b529516f6e7b4ebad1cc819e3f0eddd48f5a6` |
| [CLIProxyAPI_8.0.42_darwin_aarch64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.42/CLIProxyAPI_8.0.42_darwin_aarch64.tar.gz) | `7d5a78923786dd20a6854e834228d138245142101e8cb02b2614311514a478ff` |
| [CLIProxyAPI_8.0.42_linux_amd64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.42/CLIProxyAPI_8.0.42_linux_amd64.tar.gz) | `1e10566fe0042ed5a9b80306cf296bf86a83de590cd967a8b177988b896c8d31` |
| [CLIProxyAPI_8.0.42_linux_aarch64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.42/CLIProxyAPI_8.0.42_linux_aarch64.tar.gz) | `0fcd48eebaadfaa1ca44109b6e1c05bb14c92ebcc015165d9351ff24e442bf0c` |

上述固定哈希沿用已核对的官方非 `no-plugin` 发布资产；归档 SHA256 对应 GitHub Release API 的 digest，二进制 SHA256 对应其中原始核心内容。运行时下载器使用系统 `curl` 进行 HTTPS 下载，`QODER_HTTP_PROXY` 优先，否则使用常见代理环境变量。核心后台准备使用独立的 **10 分钟（600 秒）**预算，不阻塞 MCP 握手，不自动重试。先核验完整归档 SHA256，再安全提取核心并核验二进制 SHA256，成功后才发布当前平台缓存，不下载其他平台。后台准备失败时保留 MCP 连接，通过状态和安全 stderr 摘要报告原因；修复后可显式 `bridge_start` 或在宿主设置中重连。EOF、断管、退出信号或本会话的 `bridge_stop` 会中止在途准备并清理。临时归档不随插件分发。

POSIX 默认缓存核心使用 `0755`（清单中的 `mode`），已有缓存仅经哈希验证后才恢复缺失执行位；配置解析本身不修改权限。自定义 `BRIDGE_BIN` 由用户负责来源、兼容性和权限，下载器不替换或 chmod 该文件。不提供 Windows ARM64 或其他平台/架构核心，`BRIDGE_BIN` 高级覆盖不扩展平台支持。

这些哈希用于核对固定版本内容和来源，不等于数字签名或对未来上游下载的背书。更新版本时，应重新核对来源、许可和兼容性，同步清单、本说明与测试。

上游版权行按原许可保留（包括原文中的日期格式）：

```text
Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME
```

随附上游 [`README.md`](bridge/bin/README.md)、[`README_CN.md`](bridge/bin/README_CN.md) 和 [`config.example.yaml`](bridge/bin/config.example.yaml) 保留作为来源与维护参考。其中的赞助、推广、其他产品及示例配置属于上游内容，不代表本插件推荐或保证；普通用户应以本插件 [README](README.md) 的本机安全配置为准。上游示例里的空主机或远程管理配置不适用于本插件。

CLIProxyAPI 及其依赖仍受各自许可约束；MIT 不表示所有第三方依赖、商标或远程服务也由本仓库重新许可。本修订管理网页按下节固定分发，不再依赖核心的周期自动下载。

## CLI Proxy API Management Center

- 来源：https://github.com/router-for-me/Cli-Proxy-API-Management-Center ，固定发布 `v1.26.7`。
- 原资产：[management.html](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.26.7/management.html)，随包原样保存在 `bridge/panel/management.upstream.html`。
- SHA256：`8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5`，已与该 release 提供的资产 digest 核对。
- MIT 许可和 `Copyright (c) 2026 Router-For.ME` 声明全文见 [`bridge/panel/LICENSE`](bridge/panel/LICENSE)。
- 修改由 [`bridge/management-panel.mjs`](bridge/management-panel.mjs) 可复现生成：仅 Antigravity 使用 `is_webui=false`、校验回调地址与当前 state、补充中英文手动回填说明。上游原资产和代理二进制不直接修改。
- 生成页位于插件专属数据目录 `management-panel/<SHA256>/`，核心通过进程级 `MANAGEMENT_STATIC_PATH` 读取；周期自动更新被禁用，后续上游更新需同步来源、哈希、补丁和验证。

## 操作系统、Qoder 与 Node.js

插件使用 Windows PowerShell、.NET Framework/Win32 API、macOS/Linux 系统能力和当前 Qoder Desktop 的 Node 运行时，不在仓库中重新分发操作系统、Qoder 或 Node。相关产品和运行时遵循各自许可及使用条款。本仓库不是其官方扩展目录或授权发行方。

## 本仓库许可与免责声明

插件原创代码的 MIT 许可随插件保留在 [`LICENSE`](LICENSE)。打包、转发或修改本插件时须保留适用版权及许可声明；本说明不替代完整许可证。使用风险与责任边界见 [`DISCLAIMER.md`](DISCLAIMER.md)。
