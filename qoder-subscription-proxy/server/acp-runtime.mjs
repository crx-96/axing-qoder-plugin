import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, delimiter, isAbsolute, join, resolve, basename } from "node:path";
import { downloadWithCurl, extractZip } from "./core-runtime.mjs";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
import { AcpConnection, acpError } from "./acp-connection.mjs";
import { parseConfigYaml } from "./config-yaml.mjs";

const manifest = JSON.parse(await readFile(new URL("./acp-platforms.json", import.meta.url), "utf8"));
const jobs = new Map();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function regular(path, maxBytes = 768 * 1024 * 1024) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw acpError("ACP_RUNTIME_INVALID", "ACP 运行时文件不安全或无效。");
  return stat;
}

async function privateDirectory(path) {
  const parent = dirname(path);
  if (parent !== path) {
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw acpError("ACP_RUNTIME_INVALID", "ACP 缓存目录不能是链接或普通文件。");
      const actual = resolve(await realpath(path)), expected = resolve(path);
      if (process.platform === "win32" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) throw acpError("ACP_RUNTIME_INVALID", "ACP 缓存目录不能经过链接。");
      return;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await privateDirectory(parent);
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw acpError("ACP_RUNTIME_INVALID", "ACP 缓存目录无效。");
}

export async function probeAcpRuntime(runtime, { signal, env, Connection = AcpConnection } = {}) {
  await regular(runtime.path);
  const release = manifest.platforms[`${process.platform}-${process.arch}`];
  if (!release || basename(runtime.path) !== release.executable) throw acpError("ACP_INCOMPATIBLE", "ACP 启动入口必须是固定发行中经过校验的官方程序。");
  const fingerprints = [];
  for (const [name, digest] of Object.entries(release.files)) {
    const path = join(dirname(runtime.path), name);
    let before;
    try { before = await regular(path); } catch (error) {
      if (error.code === "ENOENT") throw acpError("ACP_INCOMPATIBLE", "宿主 ACP 缺少官方伴随程序；原安装保持不变。");
      throw error;
    }
    if (sha256(await readFile(path)) !== digest) throw acpError("ACP_INCOMPATIBLE", "宿主 ACP 或伴随程序不匹配已验证的官方发行，未执行；原安装保持不变。");
    const stat = await regular(path);
    if (["size", "mtimeMs", "ino"].some(key => stat[key] !== before[key])) throw acpError("ACP_RUNTIME_CHANGED", "ACP 程序在校验期间发生变化，未执行。");
    fingerprints.push({ name, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
  }
  const link = new Connection(runtime, { env });
  try {
    const info = await link.initialize(signal);
    if (info.agentInfo.version !== manifest.version) throw acpError("ACP_INCOMPATIBLE", "宿主 ACP 版本尚未通过本插件兼容验证；原安装保持不变。");
    return { ...runtime, version: info.agentInfo.version, fingerprints };
  } finally { await link.close(); }
}

export async function assertAcpRuntimeUnchanged(runtime) {
  if (!runtime.fingerprints?.length) throw acpError("ACP_RUNTIME_CHANGED", "ACP 运行时缺少验证记录，请重新连接。");
  for (const expected of runtime.fingerprints) {
    const current = await regular(join(dirname(runtime.path), expected.name));
    if (["size", "mtimeMs", "ino"].some(key => current[key] !== expected[key])) throw acpError("ACP_RUNTIME_CHANGED", "ACP 运行时已更新或被修改，请重新检测连接；不会继续使用旧验证结果。");
  }
}

export function hostAcpCandidates({ env = process.env, platform = process.platform } = {}) {
  const names = platform === "win32" ? ["agy_acp_server.exe"] : ["agy_acp_server.par", "agy_acp_server"];
  const roots = platform === "win32"
    ? [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "antigravity"), env.ProgramFiles && join(env.ProgramFiles, "Antigravity")].filter(Boolean)
    : env.HOME ? [join(env.HOME, ".local", "bin"), ...(platform === "darwin" ? ["/Applications/Antigravity.app/Contents/MacOS"] : ["/opt/antigravity"])] : [];
  const directories = [...(env.PATH ?? env.Path ?? "").split(delimiter), ...roots.flatMap(root => [root, join(root, "bin")])]
    .filter(path => path && isAbsolute(path) && resolve(path) !== resolve(process.cwd()));
  return [...new Set(directories.flatMap(directory => names.map(name => join(directory, name))))];
}

async function cachedRuntime(directory, release) {
  try { const stat = await lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw acpError("ACP_CACHE_INVALID", "ACP 缓存目录无效。"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let receipt;
  try { await regular(join(directory, "receipt.json"), 16384); receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8")); }
  catch { throw acpError("ACP_CACHE_INVALID", "ACP 缓存校验记录损坏或缺失；未覆盖已有安装。"); }
  if (receipt.archiveSha256 !== release.sha256 || !receipt.files || typeof receipt.files !== "object" ||
      !Object.hasOwn(receipt.files, release.executable)) throw acpError("ACP_CACHE_INVALID", "ACP 缓存版本或校验记录不匹配。");
  const expected = Object.keys(release.files);
  if (Object.keys(receipt.files).length !== expected.length || expected.some(name => receipt.files[name] !== release.files[name])) {
    throw acpError("ACP_CACHE_INVALID", "ACP 缓存校验记录与固定发行不匹配。");
  }
  if (expected.length < 1 || expected.length > 128 || expected.some(name => name !== basename(name) || /[\\/:]|^\./.test(name))) {
    throw acpError("ACP_CACHE_INVALID", "ACP 缓存文件清单无效。");
  }
  const names = await readdir(directory);
  if (names.length !== expected.length + 1 || names.some(name => name !== "receipt.json" && !expected.includes(name))) throw acpError("ACP_CACHE_INVALID", "ACP 缓存中有未知文件，未自动执行。");
  for (const name of expected) {
    await regular(join(directory, name));
    if (sha256(await readFile(join(directory, name))) !== receipt.files[name]) throw acpError("ACP_CACHE_INVALID", "ACP 缓存内容校验失败，未执行或覆盖。");
  }
  return { path: join(directory, release.executable), args: release.args, source: "cache", version: manifest.version };
}

async function profileAuthMethod(profilePath) {
  let method;
  for (const path of [join(profilePath, "settings.json"), join(profilePath, "antigravity-acp", "settings.json")]) {
    try {
      await regular(path, 1024 * 1024);
      const value = JSON.parse(await readFile(path, "utf8"))?.auth?.type;
      if (typeof value === "string") method = value;
    } catch (error) {
      if (error.code !== "ENOENT") throw acpError("ACP_CONFIG", "专属 ACP 认证设置无法读取，请检查官方配置；不会读取其他客户端凭据。");
    }
  }
  return method;
}

export async function ensureAcpRuntime(config, { signal, allowDownload = false, env = process.env, platform = process.platform,
  arch = process.arch, probe = probeAcpRuntime, download = downloadWithCurl, onState = () => {} } = {}) {
  const key = `${platform}-${arch}`;
  const release = manifest.platforms[key];
  if (!release) throw acpError("ACP_PLATFORM", "此平台尚无经过验证的 ACP 发行配置。");
  const scopedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000);
  scopedSignal.throwIfAborted();
  const profilePath = join(config.dataDir, "acp-profile");
  await privateDirectory(profilePath);
  const proxyUrl = config.configPath ? parseConfigYaml(await readFile(config.configPath, "utf8")).values.get('["requests","proxy-url"]') : undefined;
  const authMethod = await profileAuthMethod(profilePath);
  const inspect = (runtime, options) => probe({ ...runtime, profilePath, proxyUrl, authMethod }, options);
  const explicit = env.BRIDGE_ACP_BIN;
  if (explicit !== undefined && (!explicit.trim() || !isAbsolute(explicit))) throw acpError("ACP_CONFIG", "BRIDGE_ACP_BIN 必须是官方程序的绝对路径。");
  onState("detecting");
  if (explicit) return inspect({ path: await realpath(explicit), args: release.args, source: "host" }, { signal: scopedSignal, env });
  for (let path of hostAcpCandidates({ env, platform })) {
    scopedSignal.throwIfAborted();
    try { path = await realpath(path); await regular(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    try { return await inspect({ path, args: release.args, source: "host" }, { signal: scopedSignal, env }); }
    catch (error) {
      scopedSignal.throwIfAborted();
      if (!["ACP_INCOMPATIBLE", "ACP_START_FAILED", "ACP_CLOSED", "ACP_TIMEOUT"].includes(error.code)) throw error;
    }
  }
  const parent = join(config.dataDir, "runtimes", "antigravity-acp", manifest.version);
  const directory = join(parent, key);
  await privateDirectory(parent);
  const existing = await cachedRuntime(directory, release);
  if (existing) return inspect(existing, { signal: scopedSignal, env });
  if (!allowDownload) throw acpError("ACP_NOT_INSTALLED", "未发现可用 ACP；请在 ACP 管理入口连接以安装官方运行时。");
  if (jobs.has(directory)) {
    await jobs.get(directory);
    scopedSignal.throwIfAborted();
    return inspect(await cachedRuntime(directory, release), { signal: scopedSignal, env });
  }
  const work = withLifecycleLock({ dataDir: parent, port: config.port }, async () => {
    const winner = await cachedRuntime(directory, release);
    if (winner) return inspect(winner, { signal: scopedSignal, env });
    const staging = await mkdtemp(join(parent, ".install-"));
    try {
      const archivePath = join(staging, "official.zip");
      const url = new URL(release.url);
      if (url.protocol !== "https:" || url.hostname !== "dl.google.com" || !/^[a-f0-9]{64}$/.test(release.sha256)) throw acpError("ACP_SOURCE", "ACP 官方发行清单无效。");
      onState("downloading");
      await download({ url: release.url, destination: archivePath, signal: scopedSignal, maxBytes: 320 * 1024 * 1024 });
      const bytes = await readFile(archivePath);
      if (sha256(bytes) !== release.sha256) throw acpError("ACP_HASH", "ACP 官方归档 SHA256 不匹配，未安装。");
      onState("verifying");
      const files = await extractZip(bytes, null, scopedSignal, { maxExpandedBytes: 1024 * 1024 * 1024, maxBinaryBytes: 768 * 1024 * 1024 });
      if (!files.has(release.executable) || files.size !== Object.keys(release.files).length || [...files.keys()].some(name => basename(name) !== name)) {
        throw acpError("ACP_ARCHIVE", "ACP 官方归档布局发生变化，未执行未知文件。");
      }
      const target = join(staging, "runtime");
      await mkdir(target, { mode: 0o700 });
      const hashes = {};
      for (const [name, content] of files) {
        const path = join(target, name);
        await writeFile(path, content, { flag: "wx", mode: platform === "win32" ? 0o600 : 0o700 });
        hashes[name] = sha256(content);
        if (hashes[name] !== release.files[name]) throw acpError("ACP_HASH", "ACP 官方伴随文件摘要不匹配，未安装。");
      }
      await writeFile(join(target, "receipt.json"), JSON.stringify({ archiveSha256: release.sha256, files: hashes }), { flag: "wx", mode: 0o600 });
      scopedSignal.throwIfAborted();
      const checked = await inspect({ path: join(target, release.executable), args: release.args, source: "download" }, { signal: scopedSignal, env });
      await rename(target, directory);
      return { ...checked, path: join(directory, release.executable) };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }, 600000, scopedSignal);
  jobs.set(directory, work);
  try { return await work; } finally { if (jobs.get(directory) === work) jobs.delete(directory); }
}
