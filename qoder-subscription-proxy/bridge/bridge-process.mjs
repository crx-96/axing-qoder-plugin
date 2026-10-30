import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, unlink, rename, link, realpath, access, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { renderConfigYaml, validateExistingConfig } from "./config.mjs";
import { ensureCore, getCoreStatus } from "./core-runtime.mjs";
import { isRoutableImageModel } from "./image-models.mjs";
import { spawnPosixSupervisor, queryPosixSupervisor } from "./posix-supervisor.mjs";
import { requestLocal, httpFailure } from "./local-http.mjs";
import { prepareManagementPanel, PANEL_REVISION } from "./management-panel.mjs";
import { ensureApprovalRouting } from "./approval-routing.mjs";

const execFileAsync = promisify(execFile);
const inFlight = new Map();
/** 仅取消本会话发起的启动任务；跨会话停止意图由 pausedPath 保留。 */
const startControllers = new Map();
// 只保存当前 MCP 创建的 supervisor 句柄；退出时不能结束别的会话所拥有的代理。
const supervisors = new Map();
const supervisorScript = fileURLToPath(new URL("../scripts/proxy-supervisor.ps1", import.meta.url));
let closing = false;
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function bridgeError(message) {
  return Object.assign(new Error(message), { code: "BRIDGE_NOT_READY", safeMessage: message });
}

async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** 先用不带凭据的应用签名识别桥；HTTP 存活不代表它属于此版本。 */
export async function probeBridge(config) {
  let response;
  try { response = await requestLocal(config, "/"); }
  catch (error) {
    if (error.code === "ECONNREFUSED") return { state: "offline" };
    return { state: "unreachable", reason: "本机端点无响应；不会据此重复启动或终止进程" };
  }
  let body;
  try { body = JSON.parse(response.text); } catch { /* 非 JSON 服务不属于本桥。 */ }
  if (response.status !== 200 || body?.message !== "CLI Proxy API Server" ||
      !Array.isArray(body.endpoints) || !body.endpoints.includes("GET /v1/models")) {
    return { state: "foreign", reason: "端口由非 CLIProxyAPI 服务占用" };
  }
  return { state: "bridge" };
}

/** 每次带密钥请求前确认回环端点类型，且认证/响应错误与离线分开报告。 */
async function probeModels(config) {
  const response = await requestLocal(config, "/v1/models", { authenticated: true });
  if (response.status !== 200) throw httpFailure(response.status, "模型查询");
  let body;
  try { body = JSON.parse(response.text); } catch { throw bridgeError("桥返回的模型清单不是 JSON"); }
  if (!Array.isArray(body.data) || body.data.some((model) => typeof model?.id !== "string")) {
    throw bridgeError("桥返回的模型清单结构无效");
  }
  return body.data.map((model) => model.id);
}

// POSIX 用回环端口而不是磁盘 socket 作锁，进程被强杀也不会留下可被误删的锁文件。
// 哈希碰撞只会保守地等待/报错，不抢占监听者；realpath 合并指向同一数据目录的别名。
export async function withLifecycleLock(config, action, timeoutMs = 25000, signal) {
  if (!["win32", "darwin", "linux"].includes(process.platform)) throw bridgeError("不支持此操作系统");
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(config.dataDir);
  const hash = createHash("sha256").update(canonical(directory)).digest("hex").slice(0, 32);
  const lockPort = 20000 + Number.parseInt(hash.slice(0, 8), 16) % 20000;
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\qoder-subscription-bridge-${hash}`
    : { host: "127.0.0.1", port: lockPort, exclusive: true };
  if (process.platform !== "win32" && lockPort === config.port) {
    throw bridgeError("BRIDGE_PORT 与本数据目录的生命周期锁端口冲突；请使用其他代理端口");
  }
  const deadline = Date.now() + timeoutMs;
  let owner;
  while (!owner) {
    signal?.throwIfAborted();
    const candidate = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen(address, resolve);
      });
      owner = candidate;
    } catch (error) {
      candidate.close();
      if (error.code !== "EADDRINUSE") throw error;
      if (Date.now() >= deadline) throw bridgeError("另一会话正在启动或停止订阅桥，请稍后重试");
      await delay(100, undefined, { signal });
    }
  }
  try { signal?.throwIfAborted(); return await action(); }
  finally { await new Promise((resolve) => owner.close(resolve)); }
}

export async function ensureDataDir(config) {
  await mkdir(config.authDir, { recursive: true, mode: 0o700 });
  if (await readOptional(config.configPath) === null) {
    const temporary = `${config.configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, ensureApprovalRouting(renderConfigYaml(config)), { flag: "wx", mode: 0o600 });
      try { await link(temporary, config.configPath); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  const original = await readFile(config.configPath, "utf8");
  validateExistingConfig(config, original);
  const updated = ensureApprovalRouting(original);
  if (updated === original) return;
  validateExistingConfig(config, updated);
  const temporary = `${config.configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
    await rename(temporary, config.configPath);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Windows 创建时间与完整命令行共同防止 PID 回收及同名 exe 误杀。 */
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1 || process.platform !== "win32") return null;
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

export function sameProcess(record, identity, config) {
  return Boolean(record && identity && record.pid === identity.pid &&
    record.creationDate === identity.creationDate && record.commandLine === identity.commandLine &&
    typeof record.binPath === "string" && typeof record.configPath === "string" &&
    canonical(record.binPath) === canonical(config.binPath) &&
    canonical(record.configPath) === canonical(config.configPath) &&
    canonical(identity.executablePath) === canonical(config.binPath));
}

async function trackedProcess(config) {
  const text = await readOptional(config.pidPath);
  if (text === null) return null;
  let record;
  try { record = JSON.parse(text); } catch { throw bridgeError("PID 记录损坏，拒绝自动接管"); }
  const identity = process.platform === "win32"
    ? await processIdentity(record.pid)
    // 升级会改变安装目录；先按记录自身路径认证旧实例，再单独判定是否属于当前配置。
    : await queryPosixSupervisor(record, { binPath: record?.binPath, configPath: record?.configPath });
  return { record, identity, owned: sameProcess(record, identity, config) };
}

async function savePid(config, value) {
  const temporary = `${config.pidPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, config.pidPath);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
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
      // EOF 让托管器先等待代理退出；直接强杀托管器会绕过 POSIX 的清理逻辑。
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

async function launch(config, signal) {
  signal?.throwIfAborted();
  if (closing) throw bridgeError("MCP 会话正在关闭，不再启动代理");
  const previous = supervisors.get(config.dataDir);
  if (previous) await closeSupervisor(previous);
  await prepareExecutable(config);
  await ensureDataDir(config);
  const panelDirectory = await prepareManagementPanel(config);
  signal?.throwIfAborted();
  if (closing) throw bridgeError("MCP 会话正在关闭，不再启动代理");
  const child = process.platform !== "win32" ? spawnPosixSupervisor(config, panelDirectory) : spawn(powerShell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", supervisorScript,
    "-OwnerPid", String(process.pid), "-BinPath", config.binPath,
    "-ConfigPath", config.configPath, "-WorkingDirectory", config.dataDir,
    "-LogPath", join(config.dataDir, "bridge.log"),
  ], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    // 只对子进程指定受控页面，不能让宿主环境把管理端指向外部静态资产。
    env: { ...process.env, MANAGEMENT_STATIC_PATH: panelDirectory },
  });
  supervisors.set(config.dataDir, child);
  child.once("exit", () => {
    if (supervisors.get(config.dataDir) === child) supervisors.delete(config.dataDir);
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
      const onAbort = () => finish(bridgeError("启动已取消，正在回收本次代理"));
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
    const identity = process.platform === "win32"
      ? await processIdentity(launched.pid)
      : await queryPosixSupervisor({ ...launched, binPath: config.binPath, configPath: config.configPath }, config);
    if (!identity) throw bridgeError("代理在启动时退出，请检查 data/bridge.log");
    await savePid(config, { ...identity, binPath: config.binPath, configPath: config.configPath, panelRevision: PANEL_REVISION });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (closing || child.exitCode !== null || child.signalCode !== null) throw bridgeError("代理启动已中止");
      const probe = await probeBridge(config);
      if (probe.state === "bridge") {
        await probeModels(config);
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

export async function shutdownOwnedBridges() {
  closing = true;
  for (const controller of startControllers.values()) controller.abort();
  await Promise.allSettled([...inFlight.values()]);
  // 只关闭本 MCP 持有的 Job 或租约；不按 PID 文件或进程名称清理其他会话。
  await Promise.all([...supervisors.values()].map(closeSupervisor));
}

/** 必须在生命周期锁内调用；返回 null 才允许后续准备核心或启动，绝不接管外部进程。 */
async function inspectRunning(config) {
  const probe = await probeBridge(config);
  if (probe.state === "bridge") {
    const tracked = await trackedProcess(config);
    if (!tracked?.owned) throw bridgeError("端口上是旧版或外部 CLIProxyAPI；请先手动停止旧版，新版不会接管");
    if (tracked.record.panelRevision !== PANEL_REVISION) {
      throw bridgeError("当前进程尚未加载网页授权修复；请先 bridge_stop，再 bridge_start。不会自动中断正在进行的请求。");
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

/** 等待已有启动时只取消本调用的等待，不取消另一调用拥有的下载。 */
async function waitForStart(work, signal) {
  signal?.throwIfAborted();
  if (!signal) return work;
  let onAbort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

/**
 * 启动或复用代理，网络准备不占生命周期锁；暂停和进程归属在下载前后都要核对。
 * automatic=true 保留用户暂停；allowDownload 默认只对显式启动开放，入口的首次后台准备可显式开启。
 * watchdog 沿用 automatic=true 的默认值，不下载或自动重试下载；signal 取消本次拥有的任务。
 */
export async function ensureRunning(config, { automatic = false, allowDownload = !automatic, signal } = {}) {
  // 会话结束后禁止新启动；并发显式调用等待已有任务，自动巡检直接返回处理中。
  signal?.throwIfAborted();
  if (closing) throw bridgeError("MCP 会话正在关闭，不再启动代理");
  const key = config.dataDir;
  while (inFlight.has(key)) {
    if (automatic) return { started: false, ready: false, reason: "另一启动任务正在准备核心或启动代理" };
    await waitForStart(inFlight.get(key), signal);
  }
  // 内部取消器供 bridge_stop 和会话回收使用，与请求取消共同终止下载/启动。
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  startControllers.set(key, controller);
  const work = (async () => {
    // 先在锁内检查持久暂停和既有代理；只有显式启动才清除暂停标记。
    const existing = await withLifecycleLock(config, async () => {
      if (automatic && await readOptional(config.pausedPath) !== null) {
        return { started: false, ready: false, reason: "用户已停止桥，自动恢复已暂停" };
      }
      if (!automatic) await unlink(config.pausedPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
      return inspectRunning(config);
    }, 25000, activeSignal);
    if (existing) return existing;

    // 首次后台准备和显式启动可以安装核心；只读自动恢复不能发起网络下载。
    const core = await ensureCore(config, { allowDownload, signal: activeSignal });
    if (!core.available) return { started: false, ready: false, reason: core.reason };
    activeSignal.throwIfAborted();
    return withLifecycleLock(config, async () => {
      // 下载期间另一会话可以停止或启动桥；发布核心后必须重新核对状态。
      if (await readOptional(config.pausedPath) !== null) {
        return { started: false, ready: false, reason: "准备核心期间用户已停止桥，未启动代理" };
      }
      const running = await inspectRunning(config);
      if (running) return running;
      const checked = await ensureCore(config, { allowDownload: false, signal: activeSignal });
      if (!checked.available) return { started: false, ready: false, reason: checked.reason };
      return launch(config, activeSignal);
    }, 25000, activeSignal);
  })();
  inFlight.set(key, work);
  try { return await work; }
  finally {
    // 成功、失败和取消均释放本任务的登记，不覆盖后续任务的控制器。
    if (inFlight.get(key) === work) inFlight.delete(key);
    if (startControllers.get(key) === controller) startControllers.delete(key);
  }
}

export async function stopBridge(config) {
  return withLifecycleLock(config, async () => {
    // 先持久暂停，其他会话的 watchdog 才不会在停止后立即拉起。
    await writeFile(config.pausedPath, "Stopped by user\n", { mode: 0o600 });
    startControllers.get(config.dataDir)?.abort();
    const tracked = await trackedProcess(config);
    if (!tracked?.identity) return { stopped: false, reason: "未发现本版本运行的进程；自动恢复已暂停" };
    if (!tracked.owned) return { stopped: false, reason: "进程归属校验失败；未停止其他版本或外部进程" };
    if (process.platform !== "win32") {
      try {
        // 只由持有 ChildProcess 的托管器终止它的孩子，不向可被回收的记录 PID 发送信号。
        const result = await queryPosixSupervisor(tracked.record, config, { stop: true });
        if (!result?.stopped) return { stopped: false, reason: "代理已退出或归属发生变化；自动恢复已暂停" };
        const child = supervisors.get(config.dataDir);
        if (child) await closeSupervisor(child);
      } catch { return { stopped: false, reason: "停止失败或托管器无法验证；没有按 PID 终止其他进程" }; }
      await unlink(config.pidPath);
      return { stopped: true, reason: "已停止本版本订阅桥，自动恢复暂停；bridge_start 可恢复" };
    }
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
      if (tracked.record.panelRevision !== PANEL_REVISION) {
        throw bridgeError("当前进程尚未加载网页授权修复；请先 bridge_stop，再 bridge_start。");
      }
      const ids = await probeModels(config);
      // imageModels 是本工具可路由的图片模型全集，不受 sample 的 40 条截断影响。
      modelState = { count: ids.length, sample: ids.slice(0, 40), imageModels: ids.filter(isRoutableImageModel) };
      ready = true;
    } catch (error) { modelState = { count: null, sample: [], note: error.message }; }
  }
  let authCount = 0;
  try { authCount = (await readdir(config.authDir)).filter((name) => name.endsWith(".json")).length; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return {
    alive: probe.state === "bridge", ready, state: probe.state, reason: probe.reason,
    endpoint: config.endpoint, managementUrl: config.managementUrl,
    dataDir: config.dataDir, configPath: config.configPath,
    credentialsFile: join(config.dataDir, "launcher-secrets.json"),
    authCount, models: modelState, autoRecoveryPaused: await readOptional(config.pausedPath) !== null,
    core: await getCoreStatus(config),
    loginHint: "管理网页密码固定为 123456；模型 API Key 在本地 launcher-secrets.json 查看。Antigravity 使用网页手动回填：Google 授权后复制 localhost:51121 完整回调地址，返回管理页粘贴并提交；无需监听该端口。",
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
