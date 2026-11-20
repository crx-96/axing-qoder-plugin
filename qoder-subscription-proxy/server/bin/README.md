# Magpie CLI release metadata

The universal Qoder plugin ZIP ships the plugin, its icons, these notices, and metadata for recognizing older installations. The executable is downloaded after installation. Existing verified cores can be reused offline. A new installation obtains the latest stable [official Magpie release](https://github.com/yetone/magpie/releases) for the local platform and checks its size and SHA-256 before use.

Updates use separate version directories. The current service stays available while a candidate downloads. The user chooses when to switch or remove an unused version in the management page.

`platforms.json` describes legacy assets and the test fixture. It does not select the version for a fresh user installation. See `LICENSE` for the upstream MIT license.
