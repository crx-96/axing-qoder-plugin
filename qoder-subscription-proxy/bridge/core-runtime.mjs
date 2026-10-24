/** 固定版本核心的按需缓存：不执行核心、不接触授权数据，下载与生命周期锁相互独立。 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip, inflateRaw } from "node:zlib";

/** 只从插件固定清单选择版本、官方 URL 与两级 SHA256，不接收环境变量覆盖来源。 */
const MANIFEST = JSON.parse(await readFile(new URL("./bin/platforms.json", import.meta.url), "utf-8"));
/** 禁止把用户缓存写回插件安装目录。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 压缩包最大 128 MiB，独立于服务端 Content-Length 强制限制实际接收量。 */
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/** 解压后的整个 tar 最大 256 MiB，限制压缩炸弹及内存使用。 */
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
/** 核心普通文件最大 160 MiB；固定版本实际约 70 MiB。 */
const MAX_BINARY_BYTES = 160 * 1024 * 1024;
/** 从等待锁到发布的总预算，包含网络、校验和解压，不自动重试。 */
const OPERATION_TIMEOUT_MS = 600_000;
/** 核心下载锁协议，不复用桥的生命周期锁、端口或 PID 文件。 */
const LOCK_PROTOCOL = "qoder-core-download-v1";
/** 异步 zlib 避免阻塞事件循环；输出上限在原生解压层生效。 */
const unzipGzip = promisify(gunzip);
/** ZIP 只解压经过目录核对的目标成员，且限制输出大小。 */
const unzipDeflate = promisify(inflateRaw);
/** 所有可展示失败均出自固定映射，原始路径、代理凭据、URL、响应正文不进入异常。 */
const MESSAGES = Object.freeze({
  CORE_CONFIG: "核心下载配置无效；请更新插件并检查缓存目录配置。",
  CORE_CANCELLED: "核心下载已取消；可在需要时重新启动订阅桥。",
  CORE_TIMEOUT: `核心准备超过 ${OPERATION_TIMEOUT_MS / 60_000} 分钟；请检查网络或代理后手动重试。`,
  CORE_CURL: "无法运行系统 curl；请确认系统 curl 可用后重新启动订阅桥。",
  CORE_DOWNLOAD: "核心下载失败；请检查网络、QODER_HTTP_PROXY 或 HTTPS_PROXY/NO_PROXY 后手动重试。",
  CORE_SIZE: "核心归档或解压内容超过安全大小限制；请更新插件或检查下载来源。",
  CORE_ARCHIVE_HASH: "核心归档 SHA256 不匹配，未安装；请检查代理或网络后手动重试。",
  CORE_BINARY_HASH: "核心文件 SHA256 不匹配，未安装；请更新插件或检查下载来源。",
  CORE_ARCHIVE: "核心归档结构不受支持或不安全，未安装；请更新插件，不要手工绕过校验。",
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

/** 规范化同一 Windows 路径的大小写，确保进程间及进程内锁使用相同键。 */
function cacheKey(path) {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

/** 检查路径位于安装目录内；只读取路径，不扫描用户目录。 */
function insidePlugin(path) {
  const child = relative(PLUGIN_ROOT, path);
  return child === "" || (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && child !== ".." && !isAbsolute(child));
}

/** 将尚未创建的后缀接在最近现存祖先的真实路径上，防止父目录别名把缓存导向插件内部。 */
async function checkCacheLocation(path) {
  let ancestor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      if (insidePlugin(join(await realpath(ancestor), ...suffix))) throw coreError("CORE_PATH");
      return;
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
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
async function downloadWithCurl({ url, destination, signal, maxBytes }, spawnProcess, env) {
  checkCancelled(signal);
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  if (process.platform === "win32" && !win32.isAbsolute(windowsRoot)) throw coreError("CORE_CURL");
  const executable = process.platform === "win32" ? win32.join(windowsRoot, "System32", "curl.exe") : "curl";
  // curl 对大小写环境变量的优先级不完全一致，显式统一 HTTPS 代理，同时保留 NO_PROXY 例外。
  const childEnv = { ...env };
  const proxy = env.QODER_HTTP_PROXY ?? env.https_proxy ?? env.HTTPS_PROXY;
  if (proxy !== undefined) childEnv.https_proxy = childEnv.HTTPS_PROXY = proxy;
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  if (noProxy !== undefined) childEnv.no_proxy = childEnv.NO_PROXY = noProxy;
  // 传输限时比总预算少一分钟，给校验和解压留出余量；等待锁也会消耗总预算。
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

/** 校验每个归档名称，而不仅目标名称；拒绝 Windows 盘符、路径穿越、替代数据流和非 ASCII 歧义。 */
function safeArchiveName(name, directory = false) {
  const clean = directory && name.endsWith("/") ? name.slice(0, -1) : name;
  if (!clean || !/^[\x20-\x7e]+$/.test(clean) || /[\\:\x00]/.test(clean) || clean.startsWith("/") ||
      clean.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) {
    throw coreError("CORE_ARCHIVE");
  }
  return clean;
}

/** tar 字符串只接受 NUL 终止且尾部为空的字段，避免不同解压器对名称产生分歧。 */
function tarText(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((byte) => byte !== 0)) throw coreError("CORE_ARCHIVE");
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("latin1");
}

/** tar 数字字段仅接受八进制，不支持带符号或 GNU base-256 大尺寸扩展。 */
function tarNumber(bytes) {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(text)) throw coreError("CORE_ARCHIVE");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw coreError("CORE_ARCHIVE");
  return value;
}

/** 只容许 PAX 的时间/属主辅助元数据；路径、链接、稀疏文件和尺寸覆盖一律拒绝。 */
function checkPax(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 8) throw coreError("CORE_ARCHIVE");
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    const length = Number(lengthText);
    if (!/^[1-9][0-9]*$/.test(lengthText) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw coreError("CORE_ARCHIVE");
    const field = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    if (!/^(mtime|atime|ctime|uid|gid|uname|gname)=/.test(field)) throw coreError("CORE_ARCHIVE");
    offset += length;
  }
}

/** 检查完整 tar 后返回唯一根级普通核心文件；不把归档路径用于文件系统写入。 */
function extractTar(bytes, expected) {
  let offset = 0;
  let count = 0;
  let selected;
  const names = new Set();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some((byte) => byte !== 0) || !selected) throw coreError("CORE_ARCHIVE");
      return selected;
    }
    if (++count > 1024) throw coreError("CORE_ARCHIVE");
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== tarNumber(header.subarray(148, 156))) throw coreError("CORE_ARCHIVE");
    const type = header[156];
    const directory = type === 53;
    // 标准普通文件、目录和安全 PAX 元数据之外的类型（含软/硬链接）全部拒绝。
    if (![0, 48, 53, 120].includes(type) || tarText(header.subarray(157, 257))) throw coreError("CORE_ARCHIVE");
    const prefix = tarText(header.subarray(345, 500));
    const name = safeArchiveName((prefix ? `${prefix}/` : "") + tarText(header.subarray(0, 100)), directory);
    const size = tarNumber(header.subarray(124, 136));
    const start = offset + 512;
    const end = start + size;
    offset = start + Math.ceil(size / 512) * 512;
    if (end > bytes.length || offset > bytes.length || (directory && size !== 0)) throw coreError("CORE_ARCHIVE");
    if (type === 120) { checkPax(bytes.subarray(start, end)); continue; }
    if (names.has(name)) throw coreError("CORE_ARCHIVE");
    names.add(name);
    if (name === expected) {
      if (directory || size === 0 || size > MAX_BINARY_BYTES || selected) throw coreError("CORE_ARCHIVE");
      selected = bytes.subarray(start, end);
    }
  }
  throw coreError("CORE_ARCHIVE");
}

/** ZIP 扩展只允许不会改变路径、链接或尺寸语义的时间戳/UID 元数据。 */
function checkZipExtra(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw coreError("CORE_ARCHIVE");
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    offset += 4 + size;
    if (![0x5455, 0x7875, 0x000a].includes(id) || offset > bytes.length) throw coreError("CORE_ARCHIVE");
  }
}

/** ZIP CRC32 查表仅计算一次；最终安全信任仍来自固定二进制 SHA256。 */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

/** 校验 ZIP 解压数据与中心目录 CRC 一致，识别截断或结构歧义。 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/** 校验 ZIP 全部目录/本地头，拒绝链接、重叠、重复、加密和 ZIP64，只返回目标普通文件。 */
async function extractZip(bytes, expected, signal) {
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50 && position + 22 + bytes.readUInt16LE(position + 20) === bytes.length) { end = position; break; }
  }
  if (end < 0) throw coreError("CORE_ARCHIVE");
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count ||
      !count || count > 1024 || directoryOffset + directorySize !== end) throw coreError("CORE_ARCHIVE");
  let offset = directoryOffset;
  let expanded = 0;
  let selected;
  const names = new Set();
  const ranges = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw coreError("CORE_ARCHIVE");
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    const kind = mode & 0xf000;
    const local = bytes.readUInt32LE(offset + 42);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = nameBytes.toString("latin1");
    const directory = rawName.endsWith("/");
    const name = safeArchiveName(rawName, directory);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    expanded += size;
    if (next > end || bytes.readUInt16LE(offset + 34) || flags & ~0x080e || ![0, 8].includes(method) ||
        ![0, 0x8000, 0x4000].includes(kind) || (kind === 0x4000 && !directory) ||
        (directory && (size !== 0 || kind === 0x8000)) || names.has(name) || expanded > MAX_EXPANDED_BYTES) throw coreError("CORE_ARCHIVE");
    names.add(name);
    checkZipExtra(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    // 本地名称、标志、压缩方法须与中心目录逐字相同，不能借第二套名称绕过检查。
    if (local + 30 > directoryOffset || bytes.readUInt32LE(local) !== 0x04034b50 ||
        bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameLength) throw coreError("CORE_ARCHIVE");
    const localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + nameLength + localExtra;
    let finish = start + compressed;
    if (finish > directoryOffset || !bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)) throw coreError("CORE_ARCHIVE");
    checkZipExtra(bytes.subarray(local + 30 + nameLength, start));
    for (const [position, wanted] of [[14, crc], [18, compressed], [22, size]]) {
      const actual = bytes.readUInt32LE(local + position);
      if (actual !== wanted && (!(flags & 8) || actual !== 0)) throw coreError("CORE_ARCHIVE");
    }
    if (flags & 8) {
      if (finish + 12 > directoryOffset) throw coreError("CORE_ARCHIVE");
      if (bytes.readUInt32LE(finish) === 0x08074b50) finish += 4;
      if (finish + 12 > directoryOffset || bytes.readUInt32LE(finish) !== crc || bytes.readUInt32LE(finish + 4) !== compressed || bytes.readUInt32LE(finish + 8) !== size) throw coreError("CORE_ARCHIVE");
      finish += 12;
    }
    if (ranges.some(([begin, stop]) => local < stop && finish > begin)) throw coreError("CORE_ARCHIVE");
    ranges.push([local, finish]);
    if (name === expected) {
      if (directory || !size || size > MAX_BINARY_BYTES || selected) throw coreError("CORE_ARCHIVE");
      selected = { start, compressed, size, method, crc };
    }
    offset = next;
  }
  if (offset !== end || !selected) throw coreError("CORE_ARCHIVE");
  const packed = bytes.subarray(selected.start, selected.start + selected.compressed);
  const binary = selected.method === 0 ? packed : await unzipDeflate(packed, { maxOutputLength: MAX_BINARY_BYTES });
  checkCancelled(signal);
  if (binary.length !== selected.size || crc32(binary) !== selected.crc) throw coreError("CORE_ARCHIVE");
  return binary;
}

/** 将有界完整归档解为一个内存成员；任何非预期错误也只转换为固定安全文案。 */
async function extractArchive(bytes, release, signal) {
  try {
    const expected = release.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
    const binary = release.archive.endsWith(".zip")
      ? await extractZip(bytes, expected, signal)
      : extractTar(await unzipGzip(bytes, { maxOutputLength: MAX_EXPANDED_BYTES }), expected);
    checkCancelled(signal);
    return binary;
  } catch (error) {
    checkCancelled(signal);
    throw coreError(error.code === "ERR_BUFFER_TOO_LARGE" ? "CORE_SIZE" : "CORE_ARCHIVE");
  }
}

/**
 * Windows 命名管道避开系统保留端口；POSIX 使用回环独占监听，碰撞明确失败不旁路。
 * 胜者把最终结果发给等待者，失败不会诱发等待者再次下载；进程崩溃由 OS 关闭监听，无僵尸锁文件。
 */
async function acquireDownloadLock(path, signal) {
  checkCancelled(signal);
  const key = sha256(cacheKey(path));
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\qoder-core-download-${key}`
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
      /** 发布固定成功/错误码后关闭所有连接及监听，保证下次可重新获取锁。 */
      async finish(errorCode) {
        outcome = { protocol: LOCK_PROTOCOL, key, state: errorCode ? "error" : "ready", code: errorCode };
        for (const socket of sockets) socket.end(JSON.stringify(outcome) + "\n");
        const closing = new Promise((resolveClose) => server.close(resolveClose));
        for (const socket of sockets) socket.destroySoon();
        await closing;
      },
    };
  }
  // 连接现有持有者，仅与当前路径的相同协议实例共享下载；无响应/不相关服务立即失败。
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
    socket.on("close", () => finish(coreError("CORE_LOCK")));
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
        else if (confirmed && message.state === "error") finish(coreError(message.code));
        else finish(coreError("CORE_LOCK"));
      }
    });
    if (signal.aborted) cancel();
  });
  return { leader: false };
}

/**
 * 构造隔离运行时；生产使用下方默认实例，测试可注入合成清单、下载函数及 curl 进程替身。
 * @param {object} [options] 仅程序化依赖注入，不从环境变量加载下载代码或替代清单。
 * @param {object} [options.manifest] 同官方清单结构；所有 URL 仍必须精确对应官方固定 Release。
 * @param {Function} [options.download] 接收 {url,destination,signal,maxBytes}，向独占临时路径写入归档。
 * @param {Function} [options.spawnProcess] 系统 curl 的 spawn 实现，用于无网络测试命令/环境传递。
 * @param {NodeJS.ProcessEnv} [options.env] curl 子进程环境；不用于决定核心版本、URL 或平台。
 */
export function createCoreRuntime({ manifest = MANIFEST, download, spawnProcess = spawn, env = process.env } = {}) {
  // 复制并冻结依赖清单，调用者后续修改对象不能绕过下载来源和摘要约束。
  const catalog = structuredClone(manifest);
  const releases = new Map();
  if (catalog.upstream !== "router-for-me/CLIProxyAPI" || !/^v\d+\.\d+\.\d+$/.test(catalog.version)) throw coreError("CORE_CONFIG");
  for (const [key, entry] of Object.entries(catalog.platforms ?? {})) {
    if (!["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"].includes(key)) throw coreError("CORE_CONFIG");
    const [platform, arch] = key.split("-");
    const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
    const archive = `CLIProxyAPI_${catalog.version.slice(1)}_${os}_${arch === "x64" ? "amd64" : "aarch64"}.${platform === "win32" ? "zip" : "tar.gz"}`;
    if (entry.archive !== archive || entry.url !== `https://github.com/router-for-me/CLIProxyAPI/releases/download/${catalog.version}/${archive}` ||
        !/^[a-f0-9]{64}$/.test(entry.archiveSha256) || !/^[a-f0-9]{64}$/.test(entry.binarySha256) ||
        typeof entry.path !== "string" || safeArchiveName(entry.path) !== entry.path) throw coreError("CORE_CONFIG");
    releases.set(key, Object.freeze({ ...entry, version: catalog.version, key, platform, arch }));
  }
  /** 已校验文件的 stat 指纹与结果；watchdog 只 lstat，不重复读取约 70 MiB 核心。 */
  const verified = new Map();
  /** 当前实例的下载任务；同一缓存目标并发调用共享一次尝试。 */
  const jobs = new Map();
  /** 最近下载失败的安全原因，只用于可显示状态，不将失败自动重试。 */
  const failures = new Map();
  /** 默认下载依赖绑定环境和进程创建器，不改变公网 URL 约束。 */
  const fetchArchive = download ?? ((options) => downloadWithCurl(options, spawnProcess, env));

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
    if (typeof config.binPath !== "string" || cacheKey(config.binPath) !== cacheKey(resolveCoreBinaryPath({ dataDir: config.dataDir, ...release }))) throw coreError("CORE_CONFIG");
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
      if (error.code === "ENOENT") return { state: "missing", reason: "核心尚未下载；首次启动订阅桥时下载当前平台核心。" };
      return { state: "error", reason: MESSAGES[error.code] ?? MESSAGES.CORE_CACHE, replaceable: false };
    }
  }

  /** 只读状态：不下载、不创建目录、不改权限、不连接网络；校验结果按 stat 指纹复用。 */
  async function getCoreStatus(config) {
    validateConfig(config);
    if (config.core == null) return { state: "custom", version: null, platform: null, reason: "使用自定义 BRIDGE_BIN；不下载、不校验发行摘要、不修改权限。" };
    const key = cacheKey(config.binPath);
    let status;
    if (jobs.has(key)) status = { state: "downloading", reason: "正在准备当前平台核心，请稍候。" };
    else {
      status = await inspect(config);
      if (status.state !== "ready" && failures.has(key)) status = { state: "error", reason: failures.get(key) };
    }
    return { state: status.state, version: config.core.version, platform: config.core.key, reason: status.reason };
  }

  /** 完成一次下载事务：锁内重检、两级摘要、安全解压、权限、原子 rename，失败保留已有核心。 */
  async function install(config, signal) {
    let lock;
    let temporary;
    let failure;
    try {
      lock = await acquireDownloadLock(config.binPath, signal);
      checkCancelled(signal);
      const current = await inspect(config, signal);
      if (current.state === "ready") return;
      if (!lock.leader) throw coreError("CORE_CACHE");
      if (current.replaceable === false) throw coreError(current.reason === MESSAGES.CORE_PATH ? "CORE_PATH" : "CORE_CACHE");
      await checkDirectories(config, true);
      temporary = await mkdtemp(join(dirname(config.binPath), ".core-download-"));
      const archivePath = join(temporary, "archive");
      await fetchArchive({ url: config.core.url, destination: archivePath, signal, maxBytes: MAX_ARCHIVE_BYTES });
      checkCancelled(signal);
      const archiveStat = await lstat(archivePath);
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.nlink !== 1) throw coreError("CORE_ARCHIVE");
      if (!archiveStat.size || archiveStat.size > MAX_ARCHIVE_BYTES) throw coreError("CORE_SIZE");
      const archive = await readFile(archivePath);
      if (archive.length > MAX_ARCHIVE_BYTES) throw coreError("CORE_SIZE");
      if (sha256(archive) !== config.core.archiveSha256) throw coreError("CORE_ARCHIVE_HASH");
      const binary = await extractArchive(archive, config.core, signal);
      if (sha256(binary) !== config.core.binarySha256) throw coreError("CORE_BINARY_HASH");
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
      verified.delete(cacheKey(config.binPath));
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
      if (lock?.leader) await lock.finish((failure ?? cleanupError)?.code);
      if (cleanupError && !failure) throw cleanupError;
    }
  }

  /** 订阅共享任务；单个等待者取消不影响其他等待者，最后一个取消才中止实际下载。 */
  function joinJob(job, signal) {
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
      job.promise.then((value) => finish(null, value), (error) => finish(error));
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
    const key = cacheKey(config.binPath);
    if (jobs.has(key)) {
      if (!allowDownload) return { available: false, state: "downloading", reason: "正在准备当前平台核心，请稍候。" };
      return joinJob(jobs.get(key), signal);
    }
    const current = await inspect(config, signal);
    if (current.state === "ready") return { available: true, state: "ready", reason: current.reason };
    if (!allowDownload) return { available: false, state: current.state, reason: failures.get(key) ?? current.reason };
    checkCancelled(signal);
    // inspect 是异步边界，必须再次检查单飞任务，防止同时缺失时启动两个下载。
    if (jobs.has(key)) return joinJob(jobs.get(key), signal);
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
    job.promise = install(config, controller.signal).then(() => ({ available: true, state: "ready", reason: "核心缓存已通过 SHA256 校验。" }), (error) => {
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
