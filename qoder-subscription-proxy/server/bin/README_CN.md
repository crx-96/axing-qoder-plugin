# 随包 Magpie CLI

固定上游：[yetone/magpie v0.1.4330](https://github.com/yetone/magpie/releases/tag/v0.1.4330)。
上游 CLI 资产是原始可执行文件，不需要解压。清单保留 `archive` 与 `archiveSha256` 字段以兼容既有调用；下载摘要与二进制摘要相同，均固定为该 Release 的 `SHA256SUMS`。

每个平台插件 ZIP 必须内置该平台已经校验的核心：Windows x64 使用 `magpie.exe`；macOS/Linux x64、arm64 使用 `<平台键>/magpie`。源码目录不保存二进制，`scripts/fetch-core.mjs` 将构建期核心准备到 `.core-build`，仅下载和校验，不执行。

运行时优先从随包核心安装；源码运行等缺少随包文件的场景才回退到固定 HTTPS 下载。随包文件损坏会直接报错，不自动改走网络。安装保留 SHA256 校验、独立缓存、原子发布和取消清理，不操作用户账号数据。

Magpie 使用 MIT 许可证，完整原文见 `LICENSE`。本文件是插件分发说明，不是上游 README；旧 CLIProxyAPI 的 YAML 配置示例不适用于 Magpie，已移除。
