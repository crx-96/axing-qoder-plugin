/** 只读识别本插件 1.1.x 安装过的 Magpie 缓存，供没有 active/pending 记录的调用方迁移。 */
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createCoreRuntime } from "./core-runtime.mjs";

/** 历史 PID 记录仅提供 binPath 排序提示，读取量与其中的 PID 值无关。 */
const MAX_PID_BYTES = 16 * 1024;

/** 缓存或提示不可读时跳过该项；lstat 不解引用最后一级链接或 junction。 */
async function optionalStat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch { return null; }
}

/** 从根到指定目录逐级确认普通目录，遇到链接时不再访问其任何子路径。 */
async function plainDirectoryChain(path) {
  const parent = dirname(path);
  if (parent !== path && !await plainDirectoryChain(parent)) return false;
  const stat = await optionalStat(path);
  if (stat?.isDirectory()) return true;
  // 仅接受 macOS 系统提供并指向固定 /private 目录的两个根级别名。
  return process.platform === "darwin" && (path === "/var" || path === "/tmp") && stat?.isSymbolicLink() === true &&
    await realpath(path) === `/private${path}`;
}

/** 新版下载先原子发布 offer 才发布二进制。只有两种标记均确认缺失才能认作历史缓存。 */
async function hasReleaseRecord(root, core) {
  for (const kind of ["offer", "stage"]) {
    try { await lstat(join(root, `${kind}-${core.key}-${core.version}.json`)); return true; }
    catch (error) { if (error.code !== "ENOENT") return true; }
  }
  return false;
}

/** 只读取 dataDir 内固定位置的短小普通文件；即使调用方提供了 pidPath 也不跟随。 */
async function readPidHint(dataDir) {
  const path = join(dataDir, "bridge.pid");
  const before = await optionalStat(path);
  if (!before?.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > MAX_PID_BYTES) return null;
  let file;
  try {
    // 打开后复核同一普通文件，避免对被替换的文件、FIFO 或链接读取内容。
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const actual = await file.stat({ bigint: true });
    if (!actual.isFile() || actual.nlink !== 1n || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) return null;
    const bytes = Buffer.alloc(Number(actual.size));
    const { bytesRead } = await file.read(bytes);
    if (bytesRead !== bytes.length) return null;
    return JSON.parse(bytes.toString("utf8"))?.binPath ?? null;
  } catch { return null; }
  finally { await file?.close(); }
}

/** 只比较已知目标的绝对路径，不解析提示中的链接、相对路径或父目录跳转。 */
function pathHint(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  return process.platform === "win32" ? path.replaceAll("/", "\\").toLowerCase() : path;
}

/**
 * 用包内平台清单和历史资产表构建独立只读查找器；测试可使用相同结构的小文件清单。
 * releases 的摘要和大小来自 1.1.x 插件标签及官方历史 Release；平台清单提供共享布局和已知基线条目。
 */
export function createLegacyCoreFinder(baseline, history) {
  const manifests = [];
  // 只遍历发布历史。即使 platforms.json 以后移除或改动基线版本，迁移范围仍保持完整。
  for (const [version, assets] of Object.entries(history.releases)) {
    const platforms = {};
    for (const [key, { sizeBytes, sha256 }] of Object.entries(assets)) {
      const entry = baseline.platforms[key];
      // 已发布基线可直接复用完整条目；无版本清单仅提供平台布局，摘要取自独立的历史表。
      if (baseline.version === version && entry.sizeBytes === sizeBytes && entry.archiveSha256 === sha256 && entry.binarySha256 === sha256) {
        platforms[key] = entry;
        continue;
      }
      const { path, archive, mode } = entry;
      platforms[key] = { path, archive, ...(mode ? { mode } : {}), sizeBytes,
        url: `https://github.com/yetone/magpie/releases/download/${version}/${archive}`,
        binarySha256: sha256, archiveSha256: sha256 };
    }
    manifests.push({ upstream: baseline.upstream, version, platforms });
  }

  // 预先建立按平台分组、版本倒序的规范发行。跨次调用复用 runtime 的文件指纹校验。
  manifests.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }));
  const byPlatform = new Map();
  for (const manifest of manifests) {
    const runtime = createCoreRuntime({ manifest });
    for (const key of Object.keys(manifest.platforms)) {
      const [platform, arch] = key.split("-");
      const core = runtime.getCoreRelease({ platform, arch });
      if (!byPlatform.has(key)) byPlatform.set(key, []);
      byPlatform.get(key).push({ runtime, core });
    }
  }

  /** 仅探测历史清单中本平台的确切路径；返回第一个通过 SHA256 校验的完整发行或 null。 */
  async function findLegacyCore(config) {
    const { core } = config;
    const platform = config.platform ?? core?.platform ?? process.platform;
    const arch = config.arch ?? core?.arch ?? process.arch;
    const releases = byPlatform.get(`${platform}-${arch}`);
    if (!releases || typeof config.dataDir !== "string" || !isAbsolute(config.dataDir) || (core === null && config.binPath)) return null;
    const dataDir = resolve(config.dataDir);
    const root = join(dataDir, "runtimes");
    if (!await plainDirectoryChain(root)) return null;

    // 在调用 runtime 的真实路径/指纹检查前，逐级排除链接以及类型、长度不符的目标。
    const candidates = [];
    for (const { runtime, core } of releases) {
      if (!(await optionalStat(join(root, core.version)))?.isDirectory()) continue;
      // 1.1.x 没有发行记录；新版下载的文件即使与历史版相同，也要等用户确认选用。
      if (await hasReleaseRecord(root, core)) continue;
      const binPath = runtime.resolveCoreBinaryPath({ dataDir, ...core });
      if (!(await optionalStat(dirname(binPath)))?.isDirectory()) continue;
      const stat = await optionalStat(binPath);
      if (stat?.isFile() && stat.nlink === 1n && stat.size === BigInt(core.sizeBytes)) candidates.push({ runtime, core, binPath });
    }
    if (candidates.length > 1) {
      // PID 记录优先于会话路径；未知路径不会产生候选。相同优先级保留历史版本倒序。
      const pidHint = pathHint(await readPidHint(dataDir));
      const configHint = pathHint(config.binPath);
      /** 将已知路径分为 PID 提示、会话提示及其余缓存三档，所有档位都必须验摘要。 */
      const rank = ({ binPath }) => {
        const path = pathHint(binPath);
        return path === pidHint ? 0 : path === configHint ? 1 : 2;
      };
      candidates.sort((a, b) => rank(a) - rank(b));
    }
    // 状态查询只读且不执行核心；提示对应文件损坏时继续验证下一项。
    for (const { runtime, core, binPath } of candidates) {
      // 枚举与摘要检查之间下载者可能已发布来源和二进制，确认来源时须读到校验后的状态。
      if ((await runtime.getCoreStatus({ dataDir, core, binPath })).state === "ready" && !await hasReleaseRecord(root, core)) return core;
    }
    return null;
  }
  /** 给显式的版本管理操作提供本平台历史元数据，安装状态仍需由调用方校验。 */
  findLegacyCore.releases = config => (byPlatform.get(config.core?.key) ?? []).map(entry => entry.core);
  return findLegacyCore;
}

/** 按托管配置的平台键查询已发布条目；该内存查询不探测缓存或改变活动核心。 */
export function legacyCoreReleases(config) { return findLegacyCore.releases(config); }

/** 包内历史清单只用于识别现存缓存；空缓存没有默认发行，现行选版记录由调用方处理。 */
export const findLegacyCore = createLegacyCoreFinder(
  JSON.parse(await readFile(new URL("./bin/platforms.json", import.meta.url), "utf8")),
  JSON.parse(await readFile(new URL("./bin/legacy-releases.json", import.meta.url), "utf8")),
);
