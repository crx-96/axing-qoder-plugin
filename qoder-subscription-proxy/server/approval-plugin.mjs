import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, mkdir, readdir, writeFile, link, unlink, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendConfigBlock, parseConfigYaml, replaceConfigScalar } from "./config-yaml.mjs";
import { withLifecycleLock } from "./lifecycle-lock.mjs";

/** 原生扩展身份固定，不允许 manifest 指定其他动态库。 */
export const APPROVAL_PLUGIN_ID = "qoder-approval-router";
/** 只接受发布流程支持的五种平台及固定 basename。 */
const libraryFiles = Object.freeze({
  "win32-x64": "qoder-approval-router.dll",
  "darwin-x64": "qoder-approval-router.dylib",
  "darwin-arm64": "qoder-approval-router.dylib",
  "linux-x64": "qoder-approval-router.so",
  "linux-arm64": "qoder-approval-router.so",
});
/** 根路径来自模块本身，不受 cwd、BRIDGE_BIN 或用户运行目录影响。 */
const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
/** 内容寻址目录和 manifest 均只接受规范小写摘要。 */
const digestPattern = /^[a-f0-9]{64}$/;

/** 错误不回显 manifest、配置或任意用户文件的内容。 */
function pluginError(message) {
  return Object.assign(new Error(message), { code: "BRIDGE_NOT_READY", safeMessage: message });
}

/** 仅不存在可返回 null；权限、链接及其他异常不能触发源码回退。 */
async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** 验证本模块涉及的目录不是符号链接或其他特殊文件。 */
async function requireDirectory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw pluginError("审批扩展目录不是普通目录，拒绝符号链接或异常文件。");
}

/** 通过文件句柄读取单链接普通文件，并在打开前后核对身份，避免追随替换后的链接。 */
async function readRegular(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) {
    throw pluginError("审批扩展文件异常，拒绝符号链接、硬链接、空文件或超限文件。");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size) {
      throw pluginError("审批扩展文件在校验期间变化。");
    }
    const bytes = await handle.readFile();
    const after = await lstat(path);
    if (bytes.length !== before.size || after.isSymbolicLink() || after.ino !== current.ino || after.dev !== current.dev || after.nlink !== 1) {
      throw pluginError("审批扩展文件在校验期间变化。");
    }
    return bytes;
  } finally { await handle.close(); }
}

/** 计算动态库内容身份；安装前后均使用同一算法。 */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 随包目录存在时绝不回退；仅源码 checkout 可使用本平台预构建产物。 */
async function readArtifact(root, platform) {
  const file = libraryFiles[platform];
  if (!file) throw pluginError("审批扩展不支持当前平台。");
  await requireDirectory(root);
  await requireDirectory(join(root, "server"));
  let directory = join(root, "server", "approval-router");
  if (await optionalStat(directory) === null) {
    const buildRoot = join(root, ".approval-build");
    if (await optionalStat(buildRoot) === null) {
      throw pluginError("缺少审批扩展；源码请先运行 node scripts/build-approval-router.mjs，正式安装请重新安装完整发布包。");
    }
    await requireDirectory(buildRoot);
    directory = join(buildRoot, platform);
    if (await optionalStat(directory) === null) throw pluginError("缺少本平台审批扩展；请先运行 node scripts/build-approval-router.mjs。");
  }
  await requireDirectory(directory);
  const names = await readdir(directory);
  if (names.length !== 2 || !names.includes("manifest.json") || !names.includes(file)) {
    throw pluginError("审批扩展发布目录必须仅包含 manifest.json 和指定动态库；文件缺失或混入，拒绝回退。");
  }
  let manifest;
  try { manifest = JSON.parse((await readRegular(join(directory, "manifest.json"), 16384)).toString("utf8")); }
  catch (error) {
    if (error.code === "BRIDGE_NOT_READY") throw error;
    throw pluginError("审批扩展 manifest 无效。");
  }
  if (!manifest || Array.isArray(manifest) || Object.keys(manifest).sort().join(",") !== "abiVersion,file,platform,sha256" ||
      manifest.abiVersion !== 1 || manifest.platform !== platform || manifest.file !== file ||
      typeof manifest.sha256 !== "string" || !digestPattern.test(manifest.sha256)) {
    throw pluginError("审批扩展 manifest 的 ABI、平台、文件名或 SHA256 无效。");
  }
  const bytes = await readRegular(join(directory, file), 128 * 1024 * 1024);
  if (sha256(bytes) !== manifest.sha256) throw pluginError("审批扩展 SHA256 校验失败。");
  return { bytes, file, sha256: manifest.sha256 };
}

/** 核对已安装目录的唯一文件及内容，不修复、覆盖或移除用户改动。 */
async function verifyInstalled(directory, artifact) {
  await requireDirectory(directory);
  const names = await readdir(directory);
  if (!names.includes(artifact.file) || names.some(name => name !== artifact.file && name !== ".shadow")) {
    throw pluginError("审批扩展独立目录混入文件或缺失动态库；未覆盖用户文件。");
  }
  // 核心只从该保留目录加载自行校验摘要的影子副本，不将其视为新插件目录。
  if (names.includes(".shadow")) await requireDirectory(join(directory, ".shadow"));
  if (sha256(await readRegular(join(directory, artifact.file), 128 * 1024 * 1024)) !== artifact.sha256) {
    throw pluginError("已安装审批扩展 SHA256 不匹配；未覆盖用户文件。");
  }
}

// 内容寻址的独立目录避免升级覆盖已加载动态库，或让核心扫描其他用户文件。
export async function prepareApprovalRouter(config, { pluginRoot = moduleRoot, platform = `${process.platform}-${process.arch}` } = {}) {
  const artifact = await readArtifact(pluginRoot, platform);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await requireDirectory(config.dataDir);
  const parent = join(config.dataDir, "approval-router");
  await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await requireDirectory(parent);
  const directory = join(parent, artifact.sha256);
  // 使用现有 OS 生命周期锁串行安装；不同于外层 dataDir 锁，避免嵌套自锁。
  return withLifecycleLock({ dataDir: parent, port: config.port }, async () => {
    await requireDirectory(parent);
    if (await optionalStat(directory) !== null) {
      await verifyInstalled(directory, artifact);
      return { directory, sha256: artifact.sha256 };
    }
    const temporary = join(parent, `${artifact.sha256}.${randomUUID()}.tmp`);
    let created = false;
    let published = false;
    try {
      await writeFile(temporary, artifact.bytes, { flag: "wx", mode: 0o600 });
      // mkdir 与 link 均为排他操作：即使外部同时创建目标，也不会覆盖其目录或文件。
      await mkdir(directory, { mode: 0o700 });
      created = true;
      await link(temporary, join(directory, artifact.file));
      published = true;
      await unlink(temporary);
      await verifyInstalled(directory, artifact);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
      // 只删除本次创建且尚未发布的空目录，不递归删除任何外部内容。
      if (created && !published) await rmdir(directory).catch(error => { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; });
    }
    return { directory, sha256: artifact.sha256 };
  });
}

export async function inspectApprovalRouter(config, { pluginRoot = moduleRoot, platform = `${process.platform}-${process.arch}` } = {}) {
  const artifact = await readArtifact(pluginRoot, platform);
  const directory = join(config.dataDir, "approval-router", artifact.sha256);
  if (await optionalStat(directory) === null) {
    throw pluginError("当前进程尚未加载本版本审批扩展；请先 bridge_stop，再 bridge_start。");
  }
  await verifyInstalled(directory, artifact);
  return { directory, sha256: artifact.sha256 };
}

/** 按宿主路径语义比较配置目录；Windows 大小写不改变路径身份。 */
function canonical(path) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** 仅接管 dataDir 下一级小写 64hex 版本目录，不接受相对路径、子目录或目录外路径。 */
function isManagedDirectory(path, config) {
  return typeof path === "string" && isAbsolute(path) && digestPattern.test(basename(path)) &&
    canonical(dirname(path)) === canonical(join(config.dataDir, "approval-router")) &&
    canonical(path) === canonical(join(config.dataDir, "approval-router", basename(path)));
}

/** 在 YAML 真路径写单个标量；缺失祖先由现有 helper 补齐，已有其他字段原样保留。 */
function setScalar(text, path, value) {
  const parsed = parseConfigYaml(text);
  if (parsed.nodes.has(JSON.stringify(path))) return replaceConfigScalar(text, path, value, { allowNull: true });
  return appendConfigBlock(parsed, path.slice(0, -1), "map", indent => `${" ".repeat(indent)}${path.at(-1)}: ${JSON.stringify(value)}`);
}

// 开启核心插件加载之前必须隔离用户原有配置，不能顺带启用其他动态库。
export function ensureApprovalPluginConfig(text, config, directory) {
  if (!isManagedDirectory(directory, config)) throw pluginError("审批扩展目标不属于受管内容寻址目录。");
  const parsed = parseConfigYaml(text);
  const dirPath = JSON.stringify(["plugins", "dir"]);
  const previous = parsed.values.get(dirPath);
  const defaultDir = previous === undefined || previous === null || previous === "" || previous === "plugins" || previous === "./plugins";
  if (!defaultDir && !isManagedDirectory(previous, config)) {
    throw pluginError("plugins.dir 已由用户自定义；审批扩展配置冲突，未覆盖或加载旧目录。");
  }
  for (const key of parsed.nodes.keys()) {
    const path = JSON.parse(key);
    if (path.length === 3 && path[0] === "plugins" && path[1] === "configs" && path[2] !== APPROVAL_PLUGIN_ID) {
      throw pluginError("存在其他用户插件配置；审批扩展配置冲突，未覆盖或启用其他插件。");
    }
  }
  // 全程只计算文本，任何容器类型冲突均在调用方写回之前抛出。
  text = setScalar(text, ["plugins", "enabled"], true);
  text = setScalar(text, ["plugins", "dir"], directory);
  text = setScalar(text, ["plugins", "configs", APPROVAL_PLUGIN_ID, "enabled"], true);
  return setScalar(text, ["plugins", "configs", APPROVAL_PLUGIN_ID, "priority"], 100);
}

// 能力来自已校验的专用动态库；管理接口确认加载的是该隔离目录中的注册实例。
export function assertApprovalPluginRegistered(body, directory) {
  const entries = body?.plugins;
  const entry = Array.isArray(entries) && entries.find(item => item?.id === APPROVAL_PLUGIN_ID);
  if (body?.plugins_enabled !== true || typeof body.plugins_dir !== "string" || canonical(body.plugins_dir) !== canonical(directory) ||
      !Array.isArray(entries) || entries.length !== 1 || !entry || entry.configured !== true || entry.registered !== true || entry.enabled !== true || entry.effective_enabled !== true ||
      entry.metadata?.name !== APPROVAL_PLUGIN_ID ||
      typeof entry.path !== "string" || canonical(dirname(entry.path)) !== canonical(directory) || basename(entry.path) !== libraryFiles[`${process.platform}-${process.arch}`]) {
    throw pluginError("核心未实际注册并启用独立审批扩展；请检查扩展加载日志，执行 bridge_stop 后 bridge_start。");
  }
}
