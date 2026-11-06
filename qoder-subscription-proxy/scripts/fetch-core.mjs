/** 构建期核心获取：复用生产下载与 SHA256 校验，把指定平台核心写入 .core-build 供 package-plugin.mjs 内置打包。 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCore, getCoreRelease, resolveCoreBinaryPath } from "../server/core-runtime.mjs";

/** 与平台清单和打包脚本一致的五种平台键；all 依次准备全部平台。 */
const PLATFORMS = ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
/** 插件源码根目录；构建缓存固定放在其下 .core-build，已被 .gitignore 排除。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 构建核心缓存根目录，按平台键分子目录存放已校验二进制。 */
const BUILD_ROOT = join(ROOT, ".core-build");

/** 计算文件 SHA256；只用于构建期完整性核对，不执行任何核心。 */
async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * 准备单个平台核心：已有且校验通过则跳过；否则在临时数据目录走生产 ensureCore
 * 下载（归档与二进制两级 SHA256），再原子复制到构建缓存并复核哈希。
 */
async function fetchOne(key) {
  const [platform, arch] = key.split("-");
  const release = getCoreRelease({ platform, arch });
  const target = join(BUILD_ROOT, key, basename(release.path));
  // 复用已校验缓存，避免重复下载；符号链接或损坏文件不作为可用缓存。
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`构建核心是符号链接，拒绝使用：${target}`);
    if (stat.isFile() && await sha256File(target) === release.binarySha256) {
      process.stdout.write(`${key} 构建核心已存在且校验通过，跳过下载。\n`);
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // 临时缓存独立于用户数据目录与插件目录；结束后整体清理。
  const dataDir = await mkdtemp(join(tmpdir(), "qoder-core-build-"));
  try {
    const config = { dataDir, core: release, binPath: resolveCoreBinaryPath({ dataDir, platform, arch }) };
    // 跨平台获取也走同一下载器：归档成员与权限按目标平台处理，不依赖宿主平台。
    const result = await ensureCore(config, { allowDownload: true });
    if (!result.available) throw new Error(result.reason || `${key} 核心准备失败。`);
    await mkdir(dirname(target), { recursive: true });
    // 先写同目录临时文件再 rename，避免中断留下半个核心被后续打包误用。
    const temporary = `${target}.${process.pid}.tmp`;
    await copyFile(config.binPath, temporary);
    if (await sha256File(temporary) !== release.binarySha256) {
      await rm(temporary, { force: true });
      throw new Error(`${key} 构建核心复制后 SHA256 不一致，已丢弃。`);
    }
    await rename(temporary, target);
    process.stdout.write(`${key} 构建核心已下载并校验：${target}\n`);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

// 入口只接受固定平台键或 all；顺序执行，任一平台失败即终止并保留已成功的缓存。
const requested = process.argv[2];
if (process.argv.length !== 3 || (!PLATFORMS.includes(requested) && requested !== "all")) {
  console.error(`用法：node fetch-core.mjs ${PLATFORMS.join("|")} | all`);
  process.exitCode = 1;
} else {
  try {
    for (const key of requested === "all" ? PLATFORMS : [requested]) await fetchOne(key);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}