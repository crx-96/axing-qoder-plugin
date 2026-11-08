# 第三方软件与许可证

## CLIProxyAPI

本插件使用 **CLIProxyAPI**，每个安装 ZIP 内置对应平台核心，在宿主启动插件 MCP 进程时后台校验并安装到本机缓存，无需首启下载；只有从源码直接运行等未随包场景才回退下载。MCP 握手只等待本地配置，核心准备完成后自动启动代理，无需先有模型或工具调用。CLIProxyAPI 提供 OpenAI 兼容 API、服务商适配、模型列表、OAuth 管理及图片生成接口。插件自己的代码负责 Qoder MCP 接入、本机进程托管、本地配置和授权辅助，不应被理解为这些上游能力的原创实现。

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/router-for-me/CLIProxyAPI |
| 固定核心版本 | `v8.0.60`；支持 Windows x64、macOS x64/arm64、Linux x64/arm64，每个安装 ZIP 只内置对应平台核心 |
| 对应源码 | https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.60 |
| 发布页 | https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.60 |
| 许可证 | MIT，原文保存在 [`server/bin/LICENSE`](server/bin/LICENSE) |
| 原程序名 | Windows：`cli-proxy-api.exe`；macOS/Linux：`cli-proxy-api` |
| 修改情况 | 仅重命名文件，不修改二进制内容，不隐藏上游身份 |
| 平台与来源清单 | [`server/bin/platforms.json`](server/bin/platforms.json)，`path` 为相对 `server/bin/` 的随包路径；用户缓存仅使用其 basename |

插件 `1.0.5` 按五个平台分别分发内置核心的安装 ZIP，源码仓库仅保留来源清单、上游文档与许可证，构建缓存和 ZIP 不提交到源码仓库。默认缓存为 `dataDir/runtimes/v8.0.60/<platform-arch>/<basename(platforms.json.path)>`，`dataDir` 默认为 `~/.qoder/qoder-subscription-proxy/data`。MCP 启动会后台校验随包核心并安装到缓存；随包文件不存在时才下载，文件无效或 SHA256 不符时明确报错，不回退网络。watchdog 不安装、下载或自动重试核心准备；高级用户仍可使用 `BRIDGE_BIN` 指向可信当前平台核心。用户 `bridge_stop` 会取消本会话在途准备并持久暂停，重连仍可握手，但不自动安装、下载或启动；显式 `bridge_start` 可恢复。无账号时也可启动管理页，宿主连接 MCP 的时机不由插件控制，不承诺打开空白窗口即触发。

固定二进制的随包路径与 SHA256（上游 `amd64` 对应 Node `x64`，`aarch64` 对应 `arm64`）：

| 平台/架构 | 随包路径（相对 `server/bin/`） | 二进制 SHA256 |
| --- | --- | --- |
| Windows x64 | `qoder-plugin-subscription-proxy.exe` | `9740e396a97eb7d6b7a7e65bc3ea681cce1114a888e39213cafa0175151cde0f` |
| macOS x64 | `darwin-x64/qoder-plugin-subscription-proxy` | `c2d3379393e983cda72fd52dc363bf066c3de8fde168d9b27599ad56e4635704` |
| macOS arm64 | `darwin-arm64/qoder-plugin-subscription-proxy` | `2a7a43305a0907d9d9959c6d628a6206f2304b6b2069338135300a0442152672` |
| Linux x64 | `linux-x64/qoder-plugin-subscription-proxy` | `bf1b39243401f60086fbee58f36f158d2f84c3ef915e035a0bab13fd174b85aa` |
| Linux arm64 | `linux-arm64/qoder-plugin-subscription-proxy` | `79806c610d8495d6aad6cc147b21e2b67880cf2d8a0c5314d1b7b937f8e7068a` |

官方归档与 `checksums.txt` 中的 SHA256：

| 官方发布资产 | 归档 SHA256 |
| --- | --- |
| [CLIProxyAPI_8.0.60_windows_amd64.zip](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.60/CLIProxyAPI_8.0.60_windows_amd64.zip) | `c81a2c51aeab819c6e4840ad62f8d8f4143706b9fa7682f4a769683e0044fff1` |
| [CLIProxyAPI_8.0.60_darwin_amd64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.60/CLIProxyAPI_8.0.60_darwin_amd64.tar.gz) | `8892224d75f3d29a33efd0e4b8a00bb97505266cf2b9bc80d1adb3a787d89910` |
| [CLIProxyAPI_8.0.60_darwin_aarch64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.60/CLIProxyAPI_8.0.60_darwin_aarch64.tar.gz) | `9be68e64fc614a5474b98d310bb9057d6bdecb619cedec01febbb4073fdb19df` |
| [CLIProxyAPI_8.0.60_linux_amd64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.60/CLIProxyAPI_8.0.60_linux_amd64.tar.gz) | `34720cd10deef235481e80625e0c02dee934eefdd03dc8bc4f327156fa766211` |
| [CLIProxyAPI_8.0.60_linux_aarch64.tar.gz](https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.60/CLIProxyAPI_8.0.60_linux_aarch64.tar.gz) | `1c45a42770b5307a52599a2668645face8fb95c0f2dc6ee610e0992592c643d8` |

上述固定哈希沿用已核对的官方非 `no-plugin` 发布资产；归档 SHA256 对应官方 checksums.txt，二进制 SHA256 对应其中原始核心内容。构建期由 `scripts/fetch-core.mjs` 获取指定平台归档，先核验归档 SHA256，再安全提取核心并核验二进制 SHA256；`scripts/package-plugin.mjs` 再次校验二进制摘要，只将目标平台核心及分发白名单文件写入 ZIP，不打包下载归档或构建缓存。

运行时优先核验随包二进制 SHA256 后安装到当前平台缓存，不连接下载服务。仅未随包时才通过系统 `curl` 回退 HTTPS 下载，沿用相同的归档及二进制两级校验；显式 `QODER_HTTP_PROXY` 优先，否则保留 HTTPS/ALL 代理环境变量（含显式空值），均未设置时才使用系统代理或已确认的隧道直连策略，`NO_PROXY`/`no_proxy` 例外继续生效。核心后台准备使用独立的 **10 分钟（600 秒）**预算，不阻塞 MCP 握手，不自动重试，不下载其他平台。后台准备失败时保留 MCP 连接，通过状态和安全 stderr 摘要报告原因；修复后可显式 `bridge_start` 或在宿主设置中重连。EOF、断管、退出信号或本会话的 `bridge_stop` 会中止在途准备并清理。

POSIX 默认缓存核心使用 `0755`（清单中的 `mode`），已有缓存仅经哈希验证后才恢复缺失执行位；配置解析本身不修改权限。自定义 `BRIDGE_BIN` 由用户负责来源、兼容性和权限，下载器不替换或 chmod 该文件。不提供 Windows ARM64 或其他平台/架构核心，`BRIDGE_BIN` 高级覆盖不扩展平台支持。

这些哈希用于核对固定版本内容和来源，不等于数字签名或对未来上游下载的背书。更新版本时，应重新核对来源、许可和兼容性，同步清单、本说明与测试。

上游版权行按原许可保留（包括原文中的日期格式）：

```text
Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME
```

随附上游 [`README.md`](server/bin/README.md)、[`README_CN.md`](server/bin/README_CN.md) 和 [`config.example.yaml`](server/bin/config.example.yaml) 保留作为来源与维护参考。其中的赞助、推广、其他产品及示例配置属于上游内容，不代表本插件推荐或保证；普通用户应以本插件 [README](README.md) 的本机安全配置为准。上游示例里的空主机或远程管理配置不适用于本插件。

CLIProxyAPI 及其依赖仍受各自许可约束；MIT 不表示所有第三方依赖、商标或远程服务也由本仓库重新许可。本修订管理网页按下节固定分发，不再依赖核心的周期自动下载。

## CLI Proxy API Management Center

- 来源：https://github.com/router-for-me/Cli-Proxy-API-Management-Center ，固定发布 `v1.26.7`。
- 原资产：[management.html](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.26.7/management.html)，随包原样保存在 `server/panel/management.upstream.html`。
- SHA256：`8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5`，已与该 release 提供的资产 digest 核对。
- MIT 许可和 `Copyright (c) 2026 Router-For.ME` 声明全文见 [`server/panel/LICENSE`](server/panel/LICENSE)。
- 修改由 [`server/management-panel.mjs`](server/management-panel.mjs) 可复现生成：Antigravity 优先使用 `is_webui=true` 自动接收回调，仅在核心明确返回回调监听启动失败时重试 `is_webui=false` 手动模式；保留取消信号、回调地址及当前 state 校验，并按实际模式显示中英文回填提示。上游原资产和代理二进制不直接修改。
- 插件指令使用本地一次性票据进入管理页。入口和会话由插件实现，管理 API 和服务商授权由上游核心提供。
- 生成页位于插件专属数据目录 `management-panel/<SHA256>/`，核心通过进程级 `MANAGEMENT_STATIC_PATH` 读取；周期自动更新被禁用，后续上游更新需同步来源、哈希、补丁和验证。

## 操作系统、Qoder 与 Node.js

插件使用 Windows PowerShell、.NET Framework/Win32 API、macOS/Linux 系统能力和当前 Qoder Desktop 的 Node 运行时，不在仓库中重新分发操作系统、Qoder 或 Node。相关产品和运行时遵循各自许可及使用条款。本仓库不是其官方扩展目录或授权发行方。

## 本仓库许可与免责声明

插件原创代码的 MIT 许可随插件保留在 [`LICENSE`](LICENSE)。打包、转发或修改本插件时须保留适用版权及许可声明；本说明不替代完整许可证。使用风险与责任边界见 [`DISCLAIMER.md`](DISCLAIMER.md)。
