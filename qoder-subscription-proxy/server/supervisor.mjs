import { connectOwned } from "./owned-http.mjs";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, readlink, unlink, rename, access, chmod } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
export { withLifecycleLock };
import { createHmac, randomUUID } from "node:crypto";
import { promisify, isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ensureMagpieConfig, magpieEnvironment } from "./config.mjs";
import { ensureCore, getCoreStatus } from "./core-runtime.mjs";
import { spawnPosixSupervisor, queryPosixSupervisor } from "./posix-supervisor.mjs";
import { requestLocal, httpFailure } from "./local-http.mjs";
/** POSIX v2 的已认证 stop 同时释放托管链。v1 guardian 只停止核心，须由其 owner 关闭租约。 */
const RUNTIME_REVISION = process.platform === "win32" ? "magpie-win32-v2" : "magpie-posix-v2";

const execFileAsync = promisify(execFile);
/** 每个数据目录只登记一个启动任务，由本会话内的显式调用和首次后台准备共同持有。 */
const inFlight = new Map();
/** 区分最后一个等待者离开与主动 stop：只有前者允许新到的调用在回滚完成后接续。 */
const abandonedStart = new DOMException("所有启动请求均已取消", "AbortError");
// 只保存当前 MCP 创建的 supervisor 句柄；退出时不能结束别的会话所拥有的代理。
const supervisors = new Map();
const supervisorScript = fileURLToPath(new URL("../scripts/proxy-supervisor.ps1", import.meta.url));
let closing = false;
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** 构造可向宿主报告的本机代理诊断，不携带配置或凭据。 */
function bridgeError(message) {
  return Object.assign(new Error(message), { code: "BRIDGE_NOT_READY", safeMessage: message });
}

/** 读取本地状态；文件不存在时返回 null，其余错误交给调用方。 */
async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** 在模型端口用无凭据 /api/hello 识别 Magpie；管理端需登录，签名本身不证明进程归属。 */
export async function probeBridge(config) {
  let response;
  try { response = await requestLocal(config, "/api/hello"); }
  catch (error) {
    if (error.code === "ECONNREFUSED") return { state: "offline" };
    return { state: "unreachable", reason: "本机端点无响应；不会据此重复启动或终止进程" };
  }
  let body;
  try { body = JSON.parse(response.text); } catch { /* 非 JSON 服务不属于本桥。 */ }
  if (response.status !== 200 || body?.name !== "magpie" || typeof body.version !== "string") {
    return { state: "foreign", reason: "端口由非 Magpie 服务占用" };
  }
  return { state: "bridge" };
}

/** 在同一核心 PID 已验证的连接上查询模型；认证或响应错误不当作离线。 */
async function probeModels(config) {
  const response = await requestOwned(config, "/v1/models", { authenticated: true });
  if (response.status !== 200) throw httpFailure(response.status, "模型查询");
  let body;
  try { body = JSON.parse(response.text); } catch { throw bridgeError("桥返回的模型清单不是 JSON"); }
  if (!Array.isArray(body.data) || body.data.some((model) => typeof model?.id !== "string")) {
    throw bridgeError("桥返回的模型清单结构无效");
  }
  return body.data.map((model) => model.id);
}

/** 生命周期锁内原子发布完整私有 PID 状态；失败时清理本次临时文件。 */
async function replacePrivateFile(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        // Windows 上并发状态读取可能短暂占用目标；保留原文件，仅有界重试原子替换。
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt === 5) throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** 只创建和校验隔离的 Magpie JSON 设置，不读取或迁移旧核心配置。 */
export async function ensureDataDir(config) {
  await ensureMagpieConfig(config);
}

/** PID 必须连同启动身份核对，不能仅凭仍存活或同名程序判断归属。 */
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return null;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const [executablePath, commandLine] = await Promise.all([readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`, "utf8")]);
      return { pid, executablePath, commandLine, creationDate: fields[19] };
    } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { timeout: 5000, maxBuffer: 32768, env: { ...process.env, LC_ALL: "C" } });
      return stdout.trim() ? { pid, signature: stdout.trim() } : null;
    } catch (error) { if (error.code === 1) return null; throw error; }
  }
  if (process.platform !== "win32") return null;
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){ [pscustomobject]@{pid=[int]$p.ProcessId; executablePath=$p.ExecutablePath; commandLine=$p.CommandLine; creationDate=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`;
  const { stdout } = await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 5000, maxBuffer: 32768,
  });
  if (!stdout.trim()) return null;
  const identity = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  if (!identity.executablePath || !identity.commandLine || !identity.creationDate) {
    throw bridgeError("无法读取进程归属信息，拒绝接管或停止");
  }
  return identity;
}

const canonical = (path) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

function sameExecutablePath(actual, expected) {
  if (canonical(actual) === canonical(expected)) return true;
  if (process.platform !== "win32") return false;
  // .NET Framework 会展开 8.3 短路径；比较实际文件路径，不能把同名文件或未知路径当作同一核心。
  try { return canonical(realpathSync.native(actual)) === canonical(realpathSync.native(expected)); }
  catch { return false; }
}

/** 同时核对 OS 实例、安装路径、隔离设置路径及管理端口，不把同名核心当作当前实例。 */
export function sameProcess(record, identity, config) {
  return Boolean(record && identity && record.pid === identity.pid &&
    record.creationDate === identity.creationDate && record.commandLine === identity.commandLine &&
    typeof record.binPath === "string" && typeof record.configPath === "string" &&
    canonical(record.binPath) === canonical(config.binPath) &&
    canonical(record.configPath) === canonical(config.configPath) &&
    record.managementPort === config.managementPort &&
    sameExecutablePath(identity.executablePath, config.binPath));
}

/** 读取私有 PID 记录并验证实际托管身份；升级后的路径差异仅影响归属，不允许误杀旧实例。 */
async function trackedProcess(config) {
  const text = await readOptional(config.pidPath);
  if (text === null) return null;
  let record;
  try { record = JSON.parse(text); } catch { throw bridgeError("PID 记录损坏，拒绝自动接管"); }
  if (process.platform !== "win32" && (record?.runtimeRevision !== RUNTIME_REVISION || record?.managementPort == null)) {
    // 旧协议不能认证；signal 0 只有 ESRCH 能证明不存在，存活或 PID 复用均不得接管。
    if (Number.isSafeInteger(record?.pid) && record.pid > 0 && record.pid <= 0x7fffffff) {
      try { process.kill(record.pid, 0); }
      catch (error) {
        if (error.code === "ESRCH") return { record, identity: null, owned: false };
      }
    }
    throw bridgeError("旧版本进程仍存在或无法确认已退出；请手动停止旧版本并关闭其 MCP 会话后重试，新版不会接管或按 PID 停止");
  }
  const identity = process.platform === "win32"
    ? await processIdentity(record.pid)
    // 升级会改变安装目录；先按记录自身路径认证同协议实例，再单独判定是否属于当前配置。
    : await queryPosixSupervisor(record, { binPath: record?.binPath, configPath: record?.configPath, managementPort: record?.managementPort });
  return { record, identity, owned: sameProcess(record, identity, config) };
}

function instanceWebKey(config, nonce) {
  return createHmac("sha256", config.mgmtKey).update(`magpie-web:${nonce}`).digest("hex");
}

async function verifiedCoreSocket(config, signal, targetPort) {
  if (targetPort !== config.port && targetPort !== config.managementPort) throw bridgeError("目标端口不属于订阅桥");
  let managementNonce;
  const socket = await connectOwned({ ...config, port: targetPort }, async () => {
    const tracked = await trackedProcess(config);
    if (!tracked?.owned || tracked.record.runtimeRevision !== RUNTIME_REVISION) return null;
    managementNonce = tracked.record.managementNonce;
    return { ...tracked.identity, managementNonce };
  }, signal);
  return { socket, managementNonce };
}

export async function openCoreConnection(config, signal, targetPort = config.port) {
  return (await verifiedCoreSocket(config, signal, targetPort)).socket;
}

export async function getManagementLoginKey(config, signal) {
  const { socket, managementNonce } = await verifiedCoreSocket(config, signal, config.managementPort);
  socket.destroy();
  if (typeof managementNonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(managementNonce)) {
    throw bridgeError("当前核心缺少本次启动的管理凭据，请先停止并重新启动核心，再打开管理页。");
  }
  return instanceWebKey(config, managementNonce);
}

/** 只在认证过的同一条 socket 上发送模型请求，HTTP 层不得重连。 */
export async function requestOwned(config, path, options = {}) {
  const socket = await openCoreConnection(config, options.signal);
  try { return await requestLocal(config, path, { ...options, socket }); }
  finally { socket.destroy(); }
}

/** 原子发布本次启动的进程归属记录，避免并发会话读取到部分 PID 数据。 */
async function savePid(config, value) {
  await replacePrivateFile(config.pidPath, JSON.stringify(value, null, 2));
}

async function closeSupervisor(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(bridgeError("代理托管进程未在停止时限内退出")), 10000);
    const onExit = () => finish();
    function finish(error) {
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error) reject(error); else resolve();
    }
    child.once("exit", onExit);
    if (process.platform === "win32") {
      if (!child.kill()) finish(bridgeError("无法停止本会话的代理托管进程"));
    } else {
      // 通过 EOF 等待 guardian 回收确认，不把外层托管器退出当作核心已经退出。
      child.stdin.end();
    }
  });
}

async function prepareExecutable(config) {
  try { await access(config.binPath, process.platform === "win32" ? constants.F_OK : constants.X_OK); }
  catch {
    if (!config.core) {
      throw bridgeError("BRIDGE_BIN 不存在或没有执行权限；请检查自定义程序，不会修改其权限");
    }
    // 仅恢复已通过固定摘要校验的缓存核心，不修改用户指定的程序。
    try { await chmod(config.binPath, 0o755); await access(config.binPath, constants.X_OK); }
    catch { throw bridgeError("缓存代理无法执行；请检查文件权限与文件系统限制"); }
  }
}

/** 在生命周期锁内准备隔离设置，再启动具有租约或 Job 清理责任的 Magpie 核心。 */
async function launch(config, signal) {
  signal?.throwIfAborted();
  if (closing) throw bridgeError("MCP 会话正在关闭，不再启动代理");
  const previous = supervisors.get(config.dataDir);
  if (previous) await closeSupervisor(previous.child);
  await prepareExecutable(config);
  await ensureDataDir(config);
  signal?.throwIfAborted();
  if (closing) throw bridgeError("MCP 会话正在关闭，不再启动代理");
  // 随实例轮换 Web 凭据；私有 PID 记录只需保存随机 nonce，供其他 MCP 会话打开同一实例。
  const managementNonce = randomUUID();
  const coreConfig = { ...config, mgmtKey: instanceWebKey(config, managementNonce) };
  const child = process.platform !== "win32" ? spawnPosixSupervisor(coreConfig) : spawn(powerShell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", supervisorScript,
    "-OwnerPid", String(process.pid), "-BinPath", config.binPath,
    "-ConfigPath", config.configPath, "-WorkingDirectory", config.dataDir,
    "-ManagementPort", String(config.managementPort), "-LogPath", join(config.dataDir, "bridge.log"),
  ], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    // 核心通过环境读取模型监听地址、管理密钥及隔离目录，不继承宿主 Magpie 配置。
    env: magpieEnvironment(coreConfig),
  });
  const owned = { child, config, identity: null };
  supervisors.set(config.dataDir, owned);
  child.once("exit", () => {
    if (supervisors.get(config.dataDir) === owned) supervisors.delete(config.dataDir);
  });
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdin?.on("error", () => { /* 托管器退出会关闭租约；exit 状态才是清理完成的依据。 */ });
  try {
    // 两种托管器均在具备清理责任后才发布身份；控制令牌仅存私有 PID 记录，不进入 MCP。
    const launched = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => finish(bridgeError("代理托管器启动超时")), 15000);
      const onExit = () => finish(bridgeError("代理托管器启动失败，请检查运行依赖与日志"));
      const onError = () => finish(bridgeError("无法启动代理托管器，请检查平台运行时与执行权限"));
      const onAbort = () => finish(signal.reason);
      const onData = (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 8192) return finish(bridgeError("代理托管器响应无效"));
        if (!buffer.includes("\n")) return;
        try {
          const value = JSON.parse(buffer.split("\n", 1)[0]);
          if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error();
          finish(null, value);
        } catch { finish(bridgeError("代理托管器未返回有效 PID")); }
      };
      function finish(error, value) {
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
        child.stdout.off("data", onData);
        signal?.removeEventListener("abort", onAbort);
        child.stdout.resume();
        if (error) reject(error); else resolve(value);
      }
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout.on("data", onData);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    if (process.platform !== "win32" && launched.stopClosesLease !== true) {
      throw bridgeError("托管脚本版本不匹配，已取消启动；请从同一版本重新启动插件");
    }
    const identity = process.platform === "win32"
      ? await processIdentity(launched.pid)
      : await queryPosixSupervisor({ ...launched, binPath: config.binPath, configPath: config.configPath }, config);
    if (!identity) throw bridgeError("代理在启动时退出，请检查 data/bridge.log");
    owned.identity = { ...identity, binPath: config.binPath, configPath: config.configPath,
      managementPort: config.managementPort, runtimeRevision: RUNTIME_REVISION, managementNonce };
    await savePid(config, owned.identity);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (closing || child.exitCode !== null || child.signalCode !== null) throw bridgeError("代理启动已中止");
      const probe = await probeBridge(config);
      if (probe.state === "bridge") {
        await probeModels(config);
        signal?.throwIfAborted();
        return { started: true, ready: true, reason: "qoder 订阅代理已启动并受进程生命周期托管" };
      }
      if (probe.state === "foreign") throw bridgeError(probe.reason);
      await delay(250, undefined, { signal });
    }
    throw bridgeError("代理未在启动时限内就绪，已回收本次启动的进程");
  } catch (error) {
    await closeSupervisor(child);
    throw error;
  }
}

/** 关闭本会话的启动任务和租约；只有已确认回收且记录未被替换时才清理 POSIX PID 文件。 */
export async function shutdownOwnedBridges() {
  closing = true;
  for (const task of inFlight.values()) task.controller.abort();
  await Promise.allSettled(Array.from(inFlight.values(), (task) => task.work));
  // 只关闭本 MCP 持有的 Job 或租约；不按 PID 文件或进程名称清理其他会话。
  await Promise.all([...supervisors.values()].map(async ({ child, config, identity }) => {
    await closeSupervisor(child);
    if (process.platform === "win32" || !identity || child.exitCode !== 0 || child.signalCode !== null) return;
    // 先确认 guardian 回收，再持锁比对完整记录；watchdog 已发布的新实例不能被旧 owner 删除。
    await withLifecycleLock(config, async () => {
      const text = await readOptional(config.pidPath);
      if (text === null) return;
      let record;
      try { record = JSON.parse(text); } catch { return; }
      if (isDeepStrictEqual(record, identity)) await unlink(config.pidPath);
    });
  }));
}

/** 必须在生命周期锁内调用；返回 null 才允许后续准备核心或启动，绝不接管外部进程。 */
async function inspectRunning(config) {
  const probe = await probeBridge(config);
  if (probe.state === "bridge") {
    const tracked = await trackedProcess(config);
    if (!tracked?.owned) throw bridgeError("端口上是旧版或外部 Magpie；请先手动停止，新版不会接管");
    if (tracked.record.runtimeRevision !== RUNTIME_REVISION) {
      throw bridgeError("当前进程不属于本版本托管协议；请先 bridge_stop，再 bridge_start。");
    }
    await probeModels(config);
    return { started: false, ready: true, reason: "复用本版本已验证的桥进程" };
  }
  if (probe.state !== "offline") throw bridgeError(probe.reason);
  const tracked = await trackedProcess(config);
  if (tracked?.owned || (tracked?.identity && tracked.record.creationDate === tracked.identity.creationDate)) {
    throw bridgeError("记录的进程仍存在但服务未就绪，不会重复启动或强制结束");
  }
  return null;
}

/** 同步撤销本调用的持有权。最后一个等待者须等下载、启动回滚和锁释放后才返回。 */
async function waitForStart(task, waiter, signal) {
  task.waiters.add(waiter);
  let onAbort;
  try {
    if (!signal) return await task.work;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => {
        task.waiters.delete(waiter);
        if (task.waiters.size) reject(signal.reason);
        else task.controller.abort(abandonedStart);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([task.work, cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    task.waiters.delete(waiter);
  }
}

/** 在两个锁区间之间准备核心；按实际仍在等待的请求决定能否恢复暂停、能否下载。 */
async function startOnce(config, task) {
  const { signal } = task.controller;
  const existing = await withLifecycleLock(config, async () => {
    if (await readOptional(config.pausedPath) !== null) {
      // 取消的显式调用不能授权后台准备解除暂停。
      if (![...task.waiters].some((waiter) => !waiter.automatic)) {
        task.skipped = "paused";
        return { started: false, ready: false, reason: "用户已停止桥，自动恢复已暂停" };
      }
      await unlink(config.pausedPath);
    }
    return inspectRunning(config);
  }, 25000, signal);
  if (existing) return existing;

  // watchdog 只检查缓存；显式启动或首次后台准备可在同一次工作中授权下载。
  const allowDownload = [...task.waiters].some((waiter) => waiter.allowDownload);
  const core = await ensureCore(config, { allowDownload, signal });
  if (!core.available) {
    if (!allowDownload) task.skipped = "download";
    return { started: false, ready: false, reason: core.reason };
  }
  return withLifecycleLock(config, async () => {
    // 下载中新出现的暂停对所有已在等待的调用生效，不得把它当作启动前的暂停再重试。
    if (await readOptional(config.pausedPath) !== null) {
      return { started: false, ready: false, reason: "准备核心期间用户已停止桥，未启动代理" };
    }
    const running = await inspectRunning(config);
    if (running) return running;
    const checked = await ensureCore(config, { allowDownload: false, signal });
    if (!checked.available) return { started: false, ready: false, reason: checked.reason };
    return launch(config, signal);
  }, 25000, signal);
}

/** 按数据目录串行启动。请求取消只撤销自己的等待；stop 和会话关闭可以取消整个任务。 */
export async function ensureRunning(config, { automatic = false, allowDownload = !automatic, signal } = {}) {
  const key = config.dataDir;
  for (;;) {
    signal?.throwIfAborted();
    if (closing) throw bridgeError("MCP 会话正在关闭，不再启动代理");
    let task = inFlight.get(key);
    if (task && automatic && !allowDownload) return { started: false, ready: false, reason: "另一启动任务正在准备核心或启动代理" };
    // 所有旧请求已撤销时，新调用可以排在清理之后。stop/关闭触发的取消仍传给所有在途调用。
    const draining = task?.controller.signal.reason === abandonedStart ? task.work : null;
    if (!task || draining) {
      task = {
        /** 执行使用单独的信号，不绑定首先到达的请求。 */
        controller: new AbortController(),
        /** 每个活跃调用各持一份启动/下载意图。 */
        waiters: new Set(),
        /** 同目录的不同配置须重新核对，不能直接复用认证结果。 */
        config,
        /** 仅在较弱的启动策略已经跳过操作时允许补做，错误不自动重试。 */
        skipped: null,
        /** 首个仍在等待的调用报告本次实际启动，其他调用报告复用。 */
        reportedStart: false,
        /** 保留到工作和清理均结束，供停止和会话收尾使用。 */
        work: null,
      };
      inFlight.set(key, task);
      task.work = (async () => {
        if (draining) {
          try { await draining; }
          catch (error) {
            // 只接续上一批请求的正常取消，清理失败等真实错误仍交给新调用。
            if (error !== abandonedStart && error.cause !== abandonedStart && error.code !== "CORE_CANCELLED") throw error;
          }
        }
        return startOnce(config, task);
      })().finally(() => { if (inFlight.get(key) === task) inFlight.delete(key); });
    }
    const compatible = task.config === config || isDeepStrictEqual(task.config, config);
    // 不同配置仅排队，不向现有配置授予解除暂停或下载权限。
    const waiter = compatible ? { automatic, allowDownload } : { automatic: true, allowDownload: false };
    const result = await waitForStart(task, waiter, signal);
    task.controller.signal.throwIfAborted();
    if (!compatible || (task.skipped === "paused" && !automatic) || (task.skipped === "download" && allowDownload)) continue;
    if (result.started && task.reportedStart) return { started: false, ready: true, reason: "复用本版本已验证的桥进程" };
    task.reportedStart ||= result.started;
    return result;
  }
}

/** 取消本会话等待锁、下载或启动的任务，暂停自动恢复并在生命周期锁内确认已停止。 */
export async function stopBridge(config) {
  // 启动可能正持有同一把锁等待就绪；先通知它回收资源并释放锁，避免停止在锁外等到超时。
  inFlight.get(config.dataDir)?.controller.abort();
  return withLifecycleLock(config, async () => {
    // 在锁内发布暂停，再取消等待期间新登记的启动；其他会话只能在解锁后检查最新标记。
    await writeFile(config.pausedPath, "Stopped by user\n", { mode: 0o600 });
    inFlight.get(config.dataDir)?.controller.abort();
    const tracked = await trackedProcess(config);
    // 即使核心已自然退出，guardian 仍在提供认证 status。匹配当前协议和配置才发送 stop 释放它的租约。
    if (process.platform !== "win32" && tracked?.record.runtimeRevision === RUNTIME_REVISION &&
        sameProcess(tracked.record, tracked.identity ?? tracked.record, config)) {
      try {
        const result = await queryPosixSupervisor(tracked.record, config, { stop: true });
        // owner EOF 可能抢先关闭端点；此时还须确认模型端口离线才报告幂等成功。
        if ((!result || !tracked.identity) && (await probeBridge(config)).state !== "offline") {
          return { stopped: false, reason: "端口上服务的归属无法确认；已暂停自动恢复，未停止其他进程" };
        }
        const owned = supervisors.get(config.dataDir);
        if (owned?.identity?.creationDate === tracked.record.creationDate) await closeSupervisor(owned.child);
      } catch { return { stopped: false, reason: "停止失败或托管器无法验证；没有按 PID 终止其他进程" }; }
      await unlink(config.pidPath);
      return { stopped: true, reason: "已停止本版本订阅桥，自动恢复暂停；bridge_start 可恢复" };
    }
    if (!tracked?.identity) {
      // 仅在端口确认离线时报告幂等成功；外部服务或无法确定的端点都不接管或终止。
      const probe = await probeBridge(config);
      if (probe.state !== "offline") return { stopped: false, reason: "端口上服务的归属无法确认；已暂停自动恢复，未停止其他进程" };
      // 取消启动可能先回收核心再进入这里；仅清理本路径已确认离线的记录，不动其他版本记录。
      if (tracked && typeof tracked.record.binPath === "string" && typeof tracked.record.configPath === "string" &&
          canonical(tracked.record.binPath) === canonical(config.binPath) && canonical(tracked.record.configPath) === canonical(config.configPath)) {
        await unlink(config.pidPath);
      }
      return { stopped: true, reason: "本版本订阅桥已经停止，自动恢复已暂停" };
    }
    if (!tracked.owned) return { stopped: false, reason: "进程归属校验失败；未停止其他版本或外部进程" };
    // 持有进程句柄再核对身份；CIM 时间只有微秒精度，不能与 FILETIME 的 100ns 位直接比较。
    const expected = Buffer.from(JSON.stringify(tracked.identity)).toString("base64");
    const script = `$ErrorActionPreference='Stop'; $e=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${expected}')) | ConvertFrom-Json); $p=Get-Process -Id $e.pid -ErrorAction Stop; $null=$p.Handle; if($p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ne ([DateTime]::Parse($e.creationDate).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')) -or $p.Path -ne $e.executablePath){throw 'Process identity changed'}; $p.Kill(); if(-not $p.WaitForExit(5000)){throw 'Process did not exit'}`;
    try {
      await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 8000, maxBuffer: 32768 });
    } catch { return { stopped: false, reason: "停止进程失败或归属已变化；没有报告虚假成功" }; }
    const after = await processIdentity(tracked.record.pid);
    if (sameProcess(tracked.record, after, config)) return { stopped: false, reason: "进程仍在运行" };
    await unlink(config.pidPath);
    return { stopped: true, reason: "已停止本版本订阅桥，自动恢复暂停；bridge_start 可恢复" };
  });
}

/** 状态不返回密钥、凭据文件名、命令行或上游错误正文。 */
export async function getStatus(config) {
  const probe = await probeBridge(config);
  let modelState = null;
  let ready = false;
  if (probe.state === "bridge") {
    try {
      const tracked = await trackedProcess(config);
      if (!tracked?.owned) throw bridgeError("端口服务不属于本插件，未向其发送 API Key");
      if (tracked.record.runtimeRevision !== RUNTIME_REVISION) {
        throw bridgeError("当前进程不属于本版本托管协议；请先 bridge_stop，再 bridge_start。");
      }
      const ids = await probeModels(config);
      // 核心可能提供大量模型，状态只返回总数与有限样例。
      modelState = { count: ids.length, sample: ids.slice(0, 40) };
      ready = true;
    } catch (error) { modelState = { count: null, sample: [], note: error.message }; }
  }
  return {
    alive: probe.state === "bridge", ready, state: probe.state, reason: probe.reason,
    endpoint: config.endpoint, managementUrl: config.managementUrl,
    dataDir: config.dataDir, configPath: config.configPath,
    credentialsFile: join(config.dataDir, "launcher-secrets.json"),
    models: modelState, autoRecoveryPaused: await readOptional(config.pausedPath) !== null,
    core: await getCoreStatus(config),
    loginHint: `调用 bridge_open_management 打开 Magpie 原生管理页。首次使用订阅需在设置 → 隐私中显式开启订阅账号，这也允许 Magpie 发现本机其他客户端账号。管理端口 ${config.managementPort} 与模型端口由同一核心提供；管理登录凭据每次启动核心时轮换，重启后请重新打开管理页。模型请求使用独立 apiKey。`,
  };
}

/** 网络切换不重启正常桥；仅对明确离线的本版本做退避恢复。 */
export function startWatchdog(config, onState = () => {}) {
  let stopped = false;
  let timer;
  let failures = 0;
  let active = Promise.resolve();
  const tick = async () => {
    try {
      const probe = await probeBridge(config);
      if (probe.state === "offline") await ensureRunning(config, { automatic: true });
      failures = 0;
      onState(null);
    } catch (error) {
      failures += 1;
      onState(error);
    }
    if (!stopped) {
      timer = setTimeout(() => { active = tick(); }, Math.min(30000, 2000 * 2 ** Math.min(failures, 4)));
      timer.unref();
    }
  };
  timer = setTimeout(() => { active = tick(); }, 2000);
  timer.unref();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
