/** 固定版本核心的按需缓存：优先安装随包核心，缺失时回退下载；不执行核心、不接触授权数据，准备与生命周期锁相互独立。 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { readEffectiveProxyUrl } from "./system-proxy.mjs";

/** 只从插件固定清单选择版本、官方 URL 与两级 SHA256，不接收环境变量覆盖来源。 */
const MANIFEST = JSON.parse(await readFile(new URL("./bin/platforms.json", import.meta.url), "utf-8"));
/** 禁止把用户缓存写回插件安装目录。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 下载资产最大 128 MiB，独立于服务端 Content-Length 强制限制实际接收量。 */
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/** 核心普通文件最大 160 MiB；Magpie 固定版本约 81–91 MiB。 */
const MAX_BINARY_BYTES = 160 * 1024 * 1024;
/** 从等待锁到发布的总预算，包含网络、校验和发布，不自动重试。 */
const OPERATION_TIMEOUT_MS = 600_000;
/** 核心下载锁协议，不复用桥的生命周期锁、端口或 PID 文件。 */
const LOCK_PROTOCOL = "qoder-core-download-v1";
/** 所有可展示失败均出自固定映射，原始路径、代理凭据、URL、响应正文不进入异常。 */
const MESSAGES = Object.freeze({
  CORE_CONFIG: "核心下载配置无效；请更新插件并检查缓存目录配置。",
  CORE_CANCELLED: "核心下载已取消；可在需要时重新启动订阅桥。",
  CORE_TIMEOUT: `核心准备超过 ${OPERATION_TIMEOUT_MS / 60_000} 分钟；请检查网络或代理后手动重试。`,
  CORE_CURL: "无法运行系统 curl；请确认系统 curl 可用后重新启动订阅桥。",
  CORE_DOWNLOAD: "核心下载失败；请检查网络、QODER_HTTP_PROXY 或 HTTPS_PROXY/NO_PROXY 后手动重试。",
  CORE_SIZE: "核心下载内容超过安全大小限制；请更新插件或检查下载来源。",
  CORE_ARCHIVE_HASH: "核心下载 SHA256 不匹配，未安装；请检查代理或网络后手动重试。",
  CORE_BINARY_HASH: "核心文件 SHA256 不匹配，未安装；请更新插件或检查下载来源。",
  CORE_BUNDLE: "随包核心文件无效或不可读，未安装；请重新安装对应平台的官方插件 ZIP。",
  CORE_ARCHIVE: "核心下载文件类型不受支持或不安全，未安装；请更新插件，不要手工绕过校验。",
  CORE_PATH: "核心缓存路径包含链接、特殊文件或插件安装目录；请改用独立的用户缓存目录。",
  CORE_CACHE: "无法读取核心缓存；请检查缓存目录权限后手动重试。",
  CORE_PUBLISH: "无法安全发布核心缓存，原有文件未主动删除；请检查目录权限或程序占用后手动重试。",
  CORE_CLEANUP: "无法清理本次核心下载的临时目录；请检查缓存目录权限后手动重试。",
  CORE_LOCK: "核心下载互斥不可用或被其他程序占用；请稍后手动重试，不要删除桥生命周期锁。",
});

/** 创建只能包含插件固定文案的错误；不附带原始异常 cause。 */
function coreError(code) {
  const safeCode = Object.hasOwn(MESSAGES, code) ? code : "CORE_DOWNLOAD";
  return Object.assign(new Error(MESSAGES[safeCode]), { code: safeCode, safeMessage: MESSAGES[safeCode] });
}

/** 取消原因仅保留本模块生成的取消/超时码，不传播调用者提供的敏感 reason。 */
function checkCancelled(signal) {
  if (signal?.aborted) throw coreError(signal.reason?.code === "CORE_TIMEOUT" ? "CORE_TIMEOUT" : "CORE_CANCELLED");
}

/** 校验平台参数，拒绝类型错误、空白、控制字符和路径；错误不回显不安全值。 */
function platformToken(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]+$/.test(value)) {
    throw new Error(`${name} 必须是非空的平台标识字符串；不支持的平台/架构不能通过 BRIDGE_BIN 扩展。`);
  }
  return value;
}

/** SHA256 统一用于下载校验和不包含明文路径的跨进程锁标识。 */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 不含链接的普通文件指纹；纳秒时间、inode、权限和链接数共同使旧校验失效。 */
function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.nlink].join(":");
}

/** 配置契约按字面路径比较，不用真实路径放宽链接或目标路径校验。 */
function pathKey(path) {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

/** 最近现存祖先的真实路径统一长短路径别名；不替换用于安全检查和写入的原始路径。 */
function cacheKey(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (true) {
    try { return pathKey(join(realpathSync.native(ancestor), ...suffix)); }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw coreError("CORE_CACHE");
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}

/** 检查路径位于安装目录内；只读取路径，不扫描用户目录。 */
function insidePlugin(path) {
  const child = relative(PLUGIN_ROOT, path);
  return child === "" || (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && child !== ".." && !isAbsolute(child));
}

/** 将尚未创建的后缀接在最近现存祖先的真实路径上，防止父目录别名把缓存导向插件内部。 */
function checkCacheLocation(path) {
  if (insidePlugin(cacheKey(path))) throw coreError("CORE_PATH");
}

/**
 * 检查数据目录及其 runtime 子目录，拒绝符号链接/Windows junction；create=false 纯只读。
 * 不 chmod 用户已有目录，只为新建目录声明私有权限。
 */
async function checkDirectories(config, create = false) {
  if (insidePlugin(config.binPath)) throw coreError("CORE_PATH");
  await checkCacheLocation(config.binPath);
  const paths = [config.dataDir, join(config.dataDir, "runtimes"), join(config.dataDir, "runtimes", config.core.version), dirname(config.binPath)];
  for (const path of paths) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || insidePlugin(await realpath(path))) throw coreError("CORE_PATH");
    } catch (error) {
      if (!create && error.code === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * 使用系统 curl 下载到调用方的独占临时文件。
 * stdout 经字节计数管道写盘，stderr 丢弃；不使用 shell、不读取 curlrc、不自动重试。
 * spawnProcess/env 只供独立测试注入，生产调用沿用系统环境。
 */
export async function downloadWithCurl({ url, destination, signal, maxBytes }, spawnProcess = spawn, env = process.env, readProxy = readEffectiveProxyUrl) {
  checkCancelled(signal);
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  if (process.platform === "win32" && !win32.isAbsolute(windowsRoot)) throw coreError("CORE_CURL");
  const executable = process.platform === "win32" ? win32.join(windowsRoot, "System32", "curl.exe") : "curl";
  // curl 对大小写环境变量的优先级不完全一致，显式统一 HTTPS 代理，同时保留 NO_PROXY 例外。
  const childEnv = { ...env };
  const proxy = env.QODER_HTTP_PROXY ?? env.https_proxy ?? env.HTTPS_PROXY;
  if (proxy !== undefined) childEnv.https_proxy = childEnv.HTTPS_PROXY = proxy;
  // 显式空值也属于用户选择；只有未配置 HTTPS/ALL 代理时才回退到系统检测。
  if ([env.QODER_HTTP_PROXY, env.https_proxy, env.HTTPS_PROXY, env.all_proxy, env.ALL_PROXY].every((value) => value === undefined)) {
    const systemProxy = await readProxy();
    checkCancelled(signal);
    if (systemProxy === "direct") {
      // 隧道路由已确认：仅让本次 curl 直连，不改宿主环境或 NO_PROXY 例外。
      childEnv.https_proxy = childEnv.HTTPS_PROXY = childEnv.all_proxy = childEnv.ALL_PROXY = "";
    } else if (typeof systemProxy === "string" && /^https?:\/\//i.test(systemProxy)) {
      childEnv.https_proxy = childEnv.HTTPS_PROXY = systemProxy;
    }
  }
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  if (noProxy !== undefined) childEnv.no_proxy = childEnv.NO_PROXY = noProxy;
  // 传输限时比总预算少一分钟，给校验和发布留出余量；等待锁也会消耗总预算。
  const args = ["--disable", "--silent", "--fail", "--location", "--proto", "=https", "--proto-redir", "=https",
    "--max-redirs", "5", "--connect-timeout", "60", "--max-time", String(OPERATION_TIMEOUT_MS / 1000 - 60), "--max-filesize", String(maxBytes), "--retry", "0", "--output", "-", url];
  let child;
  try { child = spawnProcess(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: childEnv }); }
  catch { throw coreError("CORE_CURL"); }
  let spawnFailed = false;
  // 先登记退出事件再建立管道，避免快速退出或启动失败造成未处理拒绝。
  const exited = new Promise((resolveExit) => {
    child.once("error", () => { spawnFailed = true; resolveExit(null); });
    child.once("close", resolveExit);
  });
  /** 中止只作用于本次 curl 子进程；不终止任何用户进程。 */
  const stop = () => child.kill();
  signal.addEventListener("abort", stop, { once: true });
  let received = 0;
  const limiter = new Transform({
    /** 在写盘前限制实际下载字节数，缺少 Content-Length 也不能绕过上限。 */
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes ? coreError("CORE_SIZE") : null, chunk);
    },
  });
  try {
    await pipeline(child.stdout, limiter, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
    const exitCode = await exited;
    checkCancelled(signal);
    if (spawnFailed) throw coreError("CORE_CURL");
    if (exitCode !== 0) throw coreError("CORE_DOWNLOAD");
  } catch (error) {
    stop();
    await exited;
    checkCancelled(signal);
    if (spawnFailed) throw coreError("CORE_CURL");
    throw coreError(error.code === "CORE_SIZE" ? "CORE_SIZE" : "CORE_DOWNLOAD");
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** 官方资产为原始二进制，不解压、不解释成员路径；调用方仍核验下载及发布两级摘要。 */
function readRawBinary(bytes, signal) {
  checkCancelled(signal);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BINARY_BYTES) throw coreError("CORE_SIZE");
  return bytes;
}

/** Windows 命名管道、Linux 抽象 socket 避免 TCP 端口竞争；macOS 保留回环锁，均由 OS 在退出时释放。 */
async function acquireDownloadLock(cacheIdentity, signal) {
  checkCancelled(signal);
  const key = sha256(cacheIdentity);
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\qoder-core-download-${key}`
    : process.platform === "linux"
      ? `\0qoder-core-download-${key}`
      : { host: "127.0.0.1", port: 20_000 + (Number.parseInt(key.slice(0, 8), 16) % 40_000), exclusive: true };
  const sockets = new Set();
  let outcome;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    // 连接一经接受就先公布锁身份；完成通知不能抢在握手帧之前到达等待者。
    socket.write(JSON.stringify({ protocol: LOCK_PROTOCOL, key, state: "downloading" }) + "\n");
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (request.length > 256) { socket.destroy(); return; }
      if (!request.includes("\n")) return;
      if (request !== `${LOCK_PROTOCOL}:${key}\n`) { socket.destroy(); return; }
      socket.removeAllListeners("data");
      socket.setTimeout(OPERATION_TIMEOUT_MS + 2_000);
      if (outcome && !socket.writableEnded) socket.end(JSON.stringify(outcome) + "\n");
    });
  });
  let leader = false;
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(address, () => { server.removeListener("error", rejectListen); resolveListen(); });
    });
    leader = true;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw coreError("CORE_LOCK");
  }
  if (leader) {
    server.on("error", () => {});
    return {
      /** 持锁者负责下载；等待者只接收结果。 */
      leader: true,
      /** 停止监听后发布固定结果并关闭连接，保证取消接续可以重新获取锁。 */
      async finish(errorCode) {
        outcome = { protocol: LOCK_PROTOCOL, key, state: errorCode ? "error" : "ready", code: errorCode };
        // 先停止接受连接再广播，接续者不能重新连上已取消的领导者。
        const closing = new Promise((resolveClose) => server.close(resolveClose));
        for (const socket of sockets) socket.end(JSON.stringify(outcome) + "\n");
        for (const socket of sockets) socket.destroySoon();
        await closing;
      },
    };
  }
  // 连接现有持有者，仅与当前路径的相同协议实例共享下载；无响应/不相关服务立即失败。
  let cancelledLeader = false;
  await new Promise((resolveWait, rejectWait) => {
    const socket = createConnection(address);
    let buffer = "";
    let confirmed = false;
    let settled = false;
    /** 每条失败/完成路径统一清理 socket 与取消监听。 */
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      socket.destroy();
      error ? rejectWait(error) : resolveWait();
    };
    /** 等待者取消不影响其他进程正在进行的下载。 */
    const cancel = () => finish(coreError(signal.reason?.code === "CORE_TIMEOUT" ? "CORE_TIMEOUT" : "CORE_CANCELLED"));
    signal.addEventListener("abort", cancel, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () => finish(coreError("CORE_LOCK")));
    socket.on("connect", () => socket.write(`${LOCK_PROTOCOL}:${key}\n`));
    socket.on("error", () => finish(coreError("CORE_LOCK")));
    socket.on("close", () => finish(cancelledLeader ? undefined : coreError("CORE_LOCK")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 2048) { finish(coreError("CORE_LOCK")); return; }
      while (buffer.includes("\n")) {
        const position = buffer.indexOf("\n");
        let message;
        try { message = JSON.parse(buffer.slice(0, position)); } catch { finish(coreError("CORE_LOCK")); return; }
        buffer = buffer.slice(position + 1);
        if (message?.protocol !== LOCK_PROTOCOL || message.key !== key) { finish(coreError("CORE_LOCK")); return; }
        if (message.state === "downloading") { confirmed = true; socket.setTimeout(OPERATION_TIMEOUT_MS); }
        else if (confirmed && message.state === "ready") finish();
        else if (confirmed && message.state === "error" && message.code === "CORE_CANCELLED") {
          cancelledLeader = true;
          // Windows 管道的已连接句柄也持有名字，等双向关闭后再竞争。
          socket.end();
        }
        else if (confirmed && message.state === "error") finish(coreError(message.code));
        else finish(coreError("CORE_LOCK"));
      }
    });
    if (signal.aborted) cancel();
  });
  return { leader: false, cancelledLeader };
}

/**
 * 构造隔离运行时；生产使用下方默认实例，测试可注入合成清单、下载函数及 curl 进程替身。
 * @param {object} [options] 仅程序化依赖注入，不从环境变量加载下载代码或替代清单。
 * @param {object} [options.manifest] 同官方清单结构；所有 URL 仍必须精确对应官方固定 Release。
 * @param {string} [options.bundleDir] 随包核心所在目录，默认插件内 server/bin；仅供测试注入隔离目录。
 * @param {Function} [options.download] 接收 {url,destination,signal,maxBytes}，向独占临时路径写入原始二进制。
 * @param {Function} [options.spawnProcess] 系统 curl 的 spawn 实现，用于无网络测试命令/环境传递。
 * @param {NodeJS.ProcessEnv} [options.env] curl 子进程环境；不用于决定核心版本、URL 或平台。
 * @param {Function} [options.readProxy] 异步读取系统代理；返回 HTTP(S) URL、direct、空字符串或 null。
 */
export function createCoreRuntime({ manifest = MANIFEST, bundleDir = join(PLUGIN_ROOT, "server", "bin"), download, spawnProcess = spawn, env = process.env, readProxy = readEffectiveProxyUrl } = {}) {
  // 复制并冻结依赖清单，调用者后续修改对象不能绕过下载来源和摘要约束。
  const catalog = structuredClone(manifest);
  const releases = new Map();
  if (catalog.upstream !== "yetone/magpie" || !/^v\d+\.\d+\.\d+$/.test(catalog.version)) throw coreError("CORE_CONFIG");
  for (const [key, entry] of Object.entries(catalog.platforms ?? {})) {
    if (!["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"].includes(key)) throw coreError("CORE_CONFIG");
    const [platform, arch] = key.split("-");
    const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
    const archive = `magpie-cli-${os}-${arch === "x64" ? "amd64" : "arm64"}${platform === "win32" ? ".exe" : ""}`;
    if (entry.archive !== archive || entry.url !== `https://github.com/yetone/magpie/releases/download/${catalog.version}/${archive}` ||
        !/^[a-f0-9]{64}$/.test(entry.archiveSha256) || !/^[a-f0-9]{64}$/.test(entry.binarySha256) ||
        entry.archiveSha256 !== entry.binarySha256 ||
        entry.path !== (platform === "win32" ? "magpie.exe" : `${key}/magpie`)) throw coreError("CORE_CONFIG");
    releases.set(key, Object.freeze({ ...entry, version: catalog.version, key, platform, arch }));
  }
  /** 已校验文件的 stat 指纹与结果；watchdog 只 lstat，不重复读取约 90 MiB 核心。 */
  const verified = new Map();
  /** 当前实例的下载任务；同一缓存目标并发调用共享一次尝试。 */
  const jobs = new Map();
  /** 最近下载失败的安全原因，只用于可显示状态，不将失败自动重试。 */
  const failures = new Map();
  /** 默认下载依赖绑定环境和进程创建器，不改变公网 URL 约束。 */
  const fetchArchive = download ?? ((options) => downloadWithCurl(options, spawnProcess, env, readProxy));

  /** 返回冻结的版本/平台元数据；自定义 BRIDGE_BIN 也不能扩展生命周期支持平台。 */
  function getCoreRelease({ platform = process.platform, arch = process.arch } = {}) {
    platformToken(platform, "platform");
    platformToken(arch, "arch");
    const release = releases.get(`${platform}-${arch}`);
    if (!release) throw new Error(`不支持的平台/架构 ${platform}/${arch}；仅支持 Windows x64、macOS x64/arm64、Linux x64/arm64，BRIDGE_BIN 不能扩展平台支持。`);
    return release;
  }

  /** 目标固定为用户 dataDir/runtimes/version/platform-arch/发行路径的文件名；不读取或创建目录。 */
  function resolveCoreBinaryPath({ dataDir, platform, arch }) {
    if (typeof dataDir !== "string" || !dataDir.trim() || dataDir.includes("\0")) throw coreError("CORE_CONFIG");
    const release = getCoreRelease({ platform, arch });
    return resolve(dataDir, "runtimes", release.version, release.key, basename(release.path));
  }

  /** 检查集成方没有改写 URL、摘要、版本或目标路径；仅自定义 BRIDGE_BIN 跳过。 */
  function validateConfig(config) {
    if (!config || typeof config !== "object") throw coreError("CORE_CONFIG");
    if (config.core == null) return;
    const release = getCoreRelease({ platform: config.core.platform, arch: config.core.arch });
    for (const field of Object.keys(release)) if (config.core[field] !== release[field]) throw coreError("CORE_CONFIG");
    if (typeof config.binPath !== "string" || pathKey(config.binPath) !== pathKey(resolveCoreBinaryPath({ dataDir: config.dataDir, ...release }))) throw coreError("CORE_CONFIG");
  }

  /** 读取并校验文件描述符前后指纹，拒绝链接、并发改写和过大缓存。绝不修权限或删除缓存。 */
  async function inspect(config, signal) {
    try {
      await checkDirectories(config);
      const stat = await lstat(config.binPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return { state: "invalid", reason: MESSAGES.CORE_PATH, replaceable: false };
      if (stat.size <= 0n || stat.size > BigInt(MAX_BINARY_BYTES)) return { state: "invalid", reason: MESSAGES.CORE_BINARY_HASH, replaceable: true };
      const key = cacheKey(config.binPath);
      const stamp = fingerprint(stat);
      const cached = verified.get(key);
      if (cached?.fingerprint === stamp && cached.hash === config.core.binarySha256) return { state: "ready", reason: "核心缓存已通过 SHA256 校验。" };
      checkCancelled(signal);
      const file = await open(config.binPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let digest;
      try {
        if (fingerprint(await file.stat({ bigint: true })) !== stamp) throw coreError("CORE_CACHE");
        const hash = createHash("sha256");
        for await (const chunk of file.createReadStream({ autoClose: false })) { checkCancelled(signal); hash.update(chunk); }
        digest = hash.digest("hex");
        if (fingerprint(await file.stat({ bigint: true })) !== stamp || fingerprint(await lstat(config.binPath, { bigint: true })) !== stamp) throw coreError("CORE_CACHE");
      } finally { await file.close(); }
      if (digest !== config.core.binarySha256) return { state: "invalid", reason: MESSAGES.CORE_BINARY_HASH, replaceable: true };
      verified.set(key, { fingerprint: stamp, hash: digest });
      return { state: "ready", reason: "核心缓存已通过 SHA256 校验。" };
    } catch (error) {
      checkCancelled(signal);
      if (error.code === "ENOENT") return { state: "missing", reason: "核心尚未安装；首次启动订阅桥时优先从随包核心安装，未随包时下载。" };
      return { state: "error", reason: MESSAGES[error.code] ?? MESSAGES.CORE_CACHE, replaceable: false };
    }
  }

  /** 只读状态：不下载、不创建目录、不改权限、不连接网络；校验结果按 stat 指纹复用。 */
  async function getCoreStatus(config) {
    validateConfig(config);
    if (config.core == null) return { state: "custom", version: null, platform: null, reason: "使用自定义 BRIDGE_BIN；不下载、不校验发行摘要、不修改权限。" };
    let status = await inspect(config);
    if (status.replaceable !== false) {
      const key = cacheKey(config.binPath);
      if (jobs.has(key)) status = { state: "downloading", reason: "正在准备当前平台核心，请稍候。" };
      else if (status.state !== "ready" && failures.has(key)) status = { state: "error", reason: failures.get(key) };
    }
    return { state: status.state, version: config.core.version, platform: config.core.key, reason: status.reason };
  }

  /**
   * 读取随包核心并按固定清单校验 SHA256；文件不存在返回 null 交由下载回退。
   * 链接、特殊文件、超限或读取失败一律报 CORE_BUNDLE，哈希不符报 CORE_BINARY_HASH，均不回退网络。
   */
  async function readBundledBinary(core, signal) {
    const path = join(bundleDir, core.path);
    let stat;
    try { stat = await lstat(path, { bigint: true }); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw coreError("CORE_BUNDLE");
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n || stat.size > BigInt(MAX_BINARY_BYTES)) throw coreError("CORE_BUNDLE");
    checkCancelled(signal);
    let bytes;
    try { bytes = await readFile(path); } catch { throw coreError("CORE_BUNDLE"); }
    checkCancelled(signal);
    if (sha256(bytes) !== core.binarySha256) throw coreError("CORE_BINARY_HASH");
    return bytes;
  }

  /** 完成一次安装事务：锁内重检、随包优先、两级摘要、有界原始字节、权限、原子 rename，失败保留已有核心。 */
  async function install(config, signal, key) {
    let lock;
    let temporary;
    let failure;
    try {
      // 只接续远端正常取消；共用原有总预算，本地取消和其他失败不重试。
      do {
        lock = await acquireDownloadLock(key, signal);
        checkCancelled(signal);
      } while (lock.cancelledLeader);
      checkCancelled(signal);
      const current = await inspect(config, signal);
      if (current.state === "ready") return;
      if (!lock.leader) throw coreError("CORE_CACHE");
      if (current.replaceable === false) throw coreError(current.reason === MESSAGES.CORE_PATH ? "CORE_PATH" : "CORE_CACHE");
      await checkDirectories(config, true);
      temporary = await mkdtemp(join(dirname(config.binPath), ".core-download-"));
      // 随包核心优先：官方 ZIP 已内置当前平台二进制，安装后无需联网；源码运行等未随包场景才回退下载。
      let binary = await readBundledBinary(config.core, signal);
      if (!binary) {
        const archivePath = join(temporary, "archive");
        await fetchArchive({ url: config.core.url, destination: archivePath, signal, maxBytes: MAX_ARCHIVE_BYTES });
        checkCancelled(signal);
        const archiveStat = await lstat(archivePath);
        if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.nlink !== 1) throw coreError("CORE_ARCHIVE");
        if (!archiveStat.size || archiveStat.size > MAX_ARCHIVE_BYTES) throw coreError("CORE_SIZE");
        const archive = await readFile(archivePath);
        if (archive.length > MAX_ARCHIVE_BYTES) throw coreError("CORE_SIZE");
        if (sha256(archive) !== config.core.archiveSha256) throw coreError("CORE_ARCHIVE_HASH");
        binary = readRawBinary(archive, signal);
        if (sha256(binary) !== config.core.binarySha256) throw coreError("CORE_BINARY_HASH");
      }
      const staged = join(temporary, "core");
      const file = await open(staged, "wx", 0o600);
      try { await file.writeFile(binary); await file.sync(); } finally { await file.close(); }
      if (config.core.platform !== "win32") await chmod(staged, 0o755);
      checkCancelled(signal);
      // 发布前再检查目标类型和父目录；绝不删除损坏目标来规避 Windows 占用/权限失败。
      await checkDirectories(config);
      const previous = await inspect(config, signal);
      if (previous.replaceable === false) throw coreError("CORE_PATH");
      try { await rename(staged, config.binPath); } catch { throw coreError("CORE_PUBLISH"); }
      verified.delete(key);
      const published = await inspect(config, signal);
      if (published.state !== "ready") throw coreError("CORE_CACHE");
    } catch (error) {
      failure = signal.aborted
        ? coreError(signal.reason?.code === "CORE_TIMEOUT" ? "CORE_TIMEOUT" : "CORE_CANCELLED")
        : coreError(Object.hasOwn(MESSAGES, error.code) ? error.code : "CORE_DOWNLOAD");
      throw failure;
    } finally {
      // 清理只覆盖本任务 mkdtemp 目录；清理失败必须对外可见，同时始终释放 OS 锁。
      let cleanupError;
      if (temporary) {
        try { await rm(temporary, { recursive: true, force: true }); } catch { cleanupError = coreError("CORE_CLEANUP"); }
      }
      if (lock?.leader) await lock.finish((cleanupError ?? failure)?.code);
      if (cleanupError && !failure) throw cleanupError;
    }
  }

  /** 订阅共享任务；单个等待者取消不影响其他等待者，最后一个取消才中止实际下载。 */
  function joinJob(job, signal, config) {
    checkCancelled(signal);
    job.waiters++;
    return new Promise((resolveResult, rejectResult) => {
      let done = false;
      let cancelled = false;
      /** 各完成路径统一减计数及移除监听，避免 watchdog 重复调用累积资源。 */
      const finish = (error, value) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", cancel);
        job.waiters--;
        if (cancelled) rejectResult(coreError("CORE_CANCELLED"));
        else if (error) rejectResult(error);
        else resolveResult(value);
      };
      /** 最后订阅者先取消执行，待 curl/目录/锁清理完成才拒绝，防止退出或立即重试撞上旧任务。 */
      const cancel = () => {
        if (done || cancelled) return;
        cancelled = true;
        if (job.waiters === 1 && !job.finished) job.controller.abort(coreError("CORE_CANCELLED"));
        else finish(coreError("CORE_CANCELLED"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      // 先登记订阅再异步检查原始路径，避免其他订阅者此时取消误杀共享任务。
      const checked = config ? checkDirectories(config).catch((error) => {
        throw coreError(error.code === "CORE_PATH" ? "CORE_PATH" : "CORE_CACHE");
      }) : Promise.resolve();
      Promise.all([job.promise, checked]).then(([value]) => finish(null, value), (error) => finish(error));
      if (signal?.aborted) cancel();
    });
  }

  /**
   * 检查默认核心或按需安装；allowDownload=false 对缺失/损坏只返回 unavailable，不抛恢复异常。
   * 自定义 BRIDGE_BIN 原样返回 available=true，由生命周期层检查存在性和执行权限。
   * 显式下载失败抛含固定 safeMessage/code 的错误；无隐式下载重试。
   */
  async function ensureCore(config, { allowDownload = true, signal } = {}) {
    validateConfig(config);
    if (config.core == null) return { available: true, state: "custom", reason: "使用自定义 BRIDGE_BIN，由生命周期检查权限。" };
    checkCancelled(signal);
    let key;
    try { key = cacheKey(config.binPath); }
    catch (error) {
      if (!allowDownload) return { available: false, state: "error", reason: error.safeMessage };
      throw error;
    }
    if (jobs.has(key)) {
      if (!allowDownload) {
        const status = await getCoreStatus(config);
        return { available: status.state === "ready", state: status.state, reason: status.reason };
      }
      return joinJob(jobs.get(key), signal, config);
    }
    const current = await inspect(config, signal);
    if (current.state === "ready") return { available: true, state: "ready", reason: current.reason };
    if (!allowDownload) return { available: false, state: current.state, reason: failures.get(key) ?? current.reason };
    checkCancelled(signal);
    // inspect 是异步边界，必须再次检查单飞任务，防止同时缺失时启动两个下载。
    if (jobs.has(key)) return joinJob(jobs.get(key), signal, config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(coreError("CORE_TIMEOUT")), OPERATION_TIMEOUT_MS);
    const job = {
      /** 所有订阅者共享的执行取消器。 */
      controller,
      /** 当前尚未结束的订阅者数量。 */
      waiters: 0,
      /** 安装完成后禁止订阅者清理再次取消。 */
      finished: false,
      /** 本次尝试的唯一结果 Promise，失败不会自动重建。 */
      promise: null,
    };
    failures.delete(key);
    jobs.set(key, job);
    job.promise = install(config, controller.signal, key).then(() => ({ available: true, state: "ready", reason: "核心缓存已通过 SHA256 校验。" }), (error) => {
      failures.set(key, error.safeMessage);
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      job.finished = true;
      jobs.delete(key);
    });
    return joinJob(job, signal);
  }

  return { getCoreRelease, resolveCoreBinaryPath, getCoreStatus, ensureCore };
}

/** 默认生产实例，读取固定发行清单；导出的四个接口与配置/生命周期集成约定一致。 */
const runtime = createCoreRuntime();
export const { getCoreRelease, resolveCoreBinaryPath, getCoreStatus, ensureCore } = runtime;
