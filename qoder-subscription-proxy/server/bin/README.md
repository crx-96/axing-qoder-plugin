# Bundled Magpie CLI

The plugin pins [yetone/magpie v0.1.4582](https://github.com/yetone/magpie/releases/tag/v0.1.4582).
The upstream CLI assets are raw executables, not archives. `platforms.json` retains the `archive` and `archiveSha256` field names for compatibility; the download and binary hashes are identical and pinned to the upstream `SHA256SUMS`.

Each platform plugin ZIP must include its own verified core at the manifest's `path`: `magpie.exe` for Windows x64, or `<platform-key>/magpie` for macOS/Linux x64 and arm64. Source checkouts do not contain these binaries; `scripts/fetch-core.mjs` prepares them under `.core-build` for packaging without executing them.

Runtime installation prefers the bundled executable. A missing bundle in a source checkout can fall back to the pinned HTTPS download. Invalid bundled content is rejected, never silently replaced with a network download. The runtime verifies SHA256, installs atomically into its isolated runtime cache, and does not modify account data.

Magpie is licensed under MIT. See `LICENSE`. These are plugin distribution notes, not the upstream README or a CLIProxyAPI configuration guide.
