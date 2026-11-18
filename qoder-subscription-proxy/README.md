# qoder订阅代理 · 1.1.4

面向 Qoder Desktop 的第三方本机代理，固定使用 **Magpie CLI v0.1.4403**。模型 API、服务商适配、原生 Web 管理和模型组路由来自 Magpie；插件负责 MCP、生命周期、私有数据隔离与本地生图交付。

本项目不是 Qoder、Magpie、Google 或其他服务商的官方产品，不提供订阅或账号权限。[免责声明](DISCLAIMER.md) · [第三方软件与许可证](THIRD_PARTY_NOTICES.md)

## 安装与升级

在 Qoder Desktop 的 **扩展 → 插件 → 添加插件 → 上传插件 ZIP** 导入对应平台包，启用并连接 MCP。不要选择 GitHub 自动生成的源码 ZIP。

| 平台 | 包名 |
| --- | --- |
| Windows x64 | `qoder-subscription-proxy-v1.1.4-win32-x64.zip` |
| macOS x64 / arm64 | 对应 `darwin-x64` / `darwin-arm64` 后缀 |
| Linux x64 / arm64 | 对应 `linux-x64` / `linux-arm64` 后缀 |

每个 ZIP 内置当前平台的原始 Magpie CLI 核心，校验 SHA256 后安装到私有运行时缓存，准备核心无需联网。源码未随包时才可下载固定版本；随包核心无效时明确失败，不以下载掩盖损坏。无需 Rust。这是源码支持范围，不代表已发布、安装验收或五平台实机通过。

升级前等待请求结束并调用 `bridge_stop`。macOS 和 Linux 从旧版升级时，先关闭共享该数据目录的旧 MCP 会话，待旧托管器退出后再导入新版。macOS 的新版会话通过文件锁协调启停。重连后调用 `bridge_start`。不会热替换正在服务旧请求的程序。暂停状态跨重连保留；管理按钮不自动解除暂停。MCP 连接不等于核心就绪，以 `bridge_status.ready` 为准。

**需要在 Magpie 中本人重新登录。** 插件不读取、迁移或删除旧配置与授权数据，不复制其他客户端账号。旧数据保留不代表新版可直接使用旧授权；其他 Magpie 桌面配置也不自动接管，用户主动在原生管理页操作另行决定。

已有原生模型组不会因升级自动删除。若曾在 Qoder 使用 `group/…` ID，可自行改回原始模型 ID，并在 Magpie 原生管理页管理旧组；插件不会自动修改 Qoder 设置。

## 重构后快速使用

1. **安装或升级**：在 Qoder Desktop 导入本平台 ZIP；从旧版升级时先等待请求结束并调用 `bridge_stop`，再导入新版并重连 MCP。不要在仍通过旧代理进行的任务中途停止代理。
2. **启动并确认就绪**：调用 `bridge_start`，然后调用 `bridge_status`，确认 `ready: true`。MCP 显示已连接不代表核心已启动；旧的暂停状态需要显式启动才能解除。
3. **打开管理页**：点击 **更多 → 订阅代理管理** 查看核心状态、显式启动、刷新状态或打开原生管理页。页面初始化仅调用 `bridge_status`，不自动启动核心或打开浏览器。账号登录或服务商设置请点击页面的 **打开原生管理页（浏览器）**，也可调用 `bridge_open_management`，无需手工拼接或分享密钥链接。
4. **配置服务商或本人登录**：API-key 服务商直接在原生页面配置。使用订阅账号时，先了解并接受隐私开关也会启用本机其他客户端账号发现，再开启 **设置 → 隐私 → 订阅账号** 并本人登录；旧版授权不会自动迁移。不接受账号发现则保持关闭。
5. **配置 Qoder 模型**：选择 OpenAI 兼容接入，Base URL 填 `http://127.0.0.1:19787/v1`，模型 ID 从 Magpie 实际模型目录复制完整值；客户端要求 API Key 时可填一个非空本地标识（例如 `qoder-local`），它不是强制认证密钥，切勿填管理密钥。保存后先进行一次简单文本调用，确认当前账号和模型实际可用。
6. **可选服务商插件**：在 Magpie 原生管理页面自行安装和管理所需插件，再按所选插件的说明配置和本人登录；安装插件和登录是两个独立步骤。
7. **生图与停用**：GPT 生图使用 `image_gen_gpt`，多候选时先选择实际图片模型；旧 Gemini 生图已移除。停用时调用 `bridge_stop`，该暂停跨 MCP 重连保持，恢复时调用 `bridge_start`。

可直接对 Qoder 说“调用 bridge_status 查看订阅代理状态”“打开订阅代理管理页”；是否执行及可用工具以当前插件连接和宿主权限为准。下文列出数据边界、可选组件和详细限制。

## 固定端口与数据

| 端口 | 用途 |
| --- | --- |
| `19787` | 模型入口 `http://127.0.0.1:19787/v1` |
| `19788` | Magpie 原生 Web 管理 |

默认 `dataDir`：`~/.qoder/qoder-subscription-proxy/data`。CN 版与国际版使用这个插件专属稳定目录，它不是 Qoder 应用设置目录。

- `launcher-secrets.json`：`apiKey` 用作客户端标识，`mgmtKey` 用于派生每次核心启动的管理登录密钥。
- `magpie/`：Magpie 私有配置、授权；XDG cache/state 也隔离在插件自己的目录。
- `runtimes/`：按版本与平台隔离的固定核心缓存。
- `generated/`：GPT 生图结果。
- `bridge.pid`、`bridge.paused`：托管进程与持久暂停；旧代理归属记录不再使用。

客户端可填写 `apiKey`，但它仅用于客户端标识：固定 Magpie 的回环模型 API 接受任意 key，**不提供强制 API key 认证边界**。只允许 loopback 使用，禁止共享、端口映射、公开隧道或反向代理。新启动的核心 stdout/stderr 在写入 `bridge.log` 前过滤管理密钥；不会自动改写旧日志，旧版启动日志可能已包含登录密钥。保护本机目录权限，不要分享密钥、完整登录链接、cookie 或未脱敏日志。

## 管理入口

**更多 → 订阅代理管理** 通过 `bridge_management_app` 打开插件管理页，只显示核心状态，并提供显式启动、刷新状态与打开原生管理页按钮。初始化仅调用 `bridge_status`，不自动启动核心或打开浏览器；不支持 MCP Apps 的宿主不显示这个入口。

点击 **打开原生管理页（浏览器）** 或调用 `bridge_open_management`，插件会核验当前核心，再用默认浏览器打开 `19788` 上的原生登录入口。链接只携带本次核心的实例密钥，Magpie 将它换为 HttpOnly cookie 并清理 URL。链接和 cookie 在该实例运行期间可重复使用，请妥善保护。核心每次启动都会轮换密钥，重启后重新点击管理按钮即可登录。

授权、配置和模型目录以原生管理页为准。首次启动默认关闭 **设置 → 隐私 → 订阅账号**；Magpie 的该开关同时控制本机账号发现、手动登录和订阅调用，并非只关闭外部发现。使用订阅前，需用户确认后在此开启，再本人登录；开启也允许 Magpie 读取本机其他客户端的登录信息，私有 XDG 目录不等于账号沙箱。不接受这一行为时保持关闭，只使用 API-key 服务商。插件不会用环境变量强制锁死此开关，核心自动更新仍关闭。不要把管理页可打开、插件安装成功或模型出现在目录中等同于真实模型调用通过。

## 自行管理插件

通过 **打开原生管理页（浏览器）** 或 `bridge_open_management` 进入 Magpie，在其插件管理页面自行选择、安装和管理所需插件。本插件不代装服务商插件，不固定社区插件版本，也不提供专用安装工具。

第三方插件及其运行依赖不随本插件 ZIP 内置，安装时可能需要联网。安装完成后，按所选插件的说明配置服务商或本人登录；使用订阅账号前，需先按上节说明显式开启订阅账号。安装成功不等于授权或模型调用成功，配置 Qoder 时从实际模型目录复制完整 ID，并验证调用。

## MCP 工具与生图

| 工具 | 用途 |
| --- | --- |
| `bridge_status` | 查看本机桥和核心状态，不返回密钥 |
| `bridge_start` / `bridge_stop` | 启动或持久暂停，只处理插件拥有的进程 |
| `bridge_open_management` | 打开原生浏览器管理入口 |
| `bridge_management_app` | App-only 更多菜单管理入口；初始化仅调用 `bridge_status`，不自动启动核心或打开浏览器 |
| `image_gen_gpt` | GPT 生图并本地保存，返回文件路径 |

不支持 App 的宿主仍可调用 `bridge_status` 查看状态、`bridge_start` 显式启动，或通过 `bridge_open_management` 打开原生管理页。

GPT 生图调用 Magpie 原生 `/v1/images/generations`，采用 `codex/gpt-image-2` 或实际目录中的 `provider/gpt-image-*` 模型。成功时 `size` 来自已保存图片的编码宽高，`requestedSize` 保留发送给模型的尺寸，两个值可能不同。候选来自 Magpie 原生图片 MCP 的能力枚举，不用聊天目录推断图片能力；上游省略枚举时提示在管理页确认并指定 model。省略 model 且候选不唯一时，由用户选择后重调，不擅自替选。旧 Gemini 生图工具完全移除，不回退旧接口。

## 核心配置策略

固定版本和摘要见 [`server/bin/platforms.json`](server/bin/platforms.json)。自动核心更新关闭，订阅账号默认关闭、由用户在隐私设置显式开启；不合并其他 Magpie 配置。模型出口使用 Magpie 原生网络设置，不再修改旧 YAML 的代理字段；核心下载器仍可读取系统代理和环境代理，不改变系统设置。自定义核心旁不能存在 `data` 或 `.portable`，避免 Magpie 便携模式覆盖 XDG 数据隔离。上游模型、授权和路由行为仍受其实际能力约束。

| 变量 | 用途 |
| --- | --- |
| `BRIDGE_DATA_DIR` | 插件独立数据目录，不自动迁移旧数据 |
| `BRIDGE_PORT` / `BRIDGE_HOST` | 模型端口默认 19787；Host 仅允许 127.0.0.1 |
| `BRIDGE_MANAGEMENT_PORT` | 原生管理端口默认 19788，必须与模型端口不同 |
| `BRIDGE_API_KEY` | 可覆盖客户端标识，不是强制 API 认证 |
| `BRIDGE_MGMT_KEY` | 不允许覆盖管理密钥；管理密钥由本机生成，旧值 `123456` 仅作迁移占位 |
| `BRIDGE_BIN` | 自定义兼容核心，不自动下载或替换 |
| `QODER_HTTP_PROXY` | 下载代理优先值，未设置时按下载器代理策略处理 |

## 开发验证

从仓库根目录运行已有测试，不需要 Rust 构建：

```sh
node --test --test-concurrency=1 qoder-subscription-proxy/tests/*.test.mjs
```

原生核心集成测试依赖匹配固定摘要的核心；普通模拟测试不能代替真实账号、真实模型、Desktop 安装或五平台实机验收。不要使用生产凭据进行自动回归。

打包先运行 `scripts/fetch-core.mjs`，再运行 `scripts/package-plugin.mjs`，详见[仓库说明](../README.md#从源码打包)。POSIX 本地市场准备脚本只复制并验证当前平台核心，不下载或安装。分发不包含账号、运行缓存、测试材料和旧授权助手。
