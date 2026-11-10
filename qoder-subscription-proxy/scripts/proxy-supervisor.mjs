import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_MESSAGE_LIMIT, CONTROL_REQUEST_TIMEOUT_MS, encodePosixMessage,
  createPosixControlMessage, posixSupervisorError, validatePosixControlMessage, validatePosixIdentity, validatePosixPaths,
} from "../server/posix-supervisor.mjs";

/** 优先给核心五秒完成正常退出；SIGKILL 后仍须观察 exit，不能凭 kill 返回值宣称成功。 */
const TERMINATE_GRACE_MS = 5000;
/** 核心无法在强制终止后一秒确认退出时保留 supervisor，不虚构 stopped。 */
const KILL_CONFIRM_MS = 1000;

/** 等待已有退出 Promise；计时器在提前退出时释放，避免所有 stop 都额外存活五秒。 */
async function waitForExit(exited, timeoutMs) {
  let timer;
  try {
    return await Promise.race([exited.then(() => true), new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// 私有租约让存活 guardian 回收被强杀的外层 supervisor 的核心，不承诺全进程强杀回收。
export async function runCoreGuardian(config, panelDirectory, { spawnChild = spawn } = {}) {
  validatePosixPaths(config, panelDirectory);
  let child;
  let childExited = true;
  let childExit = Promise.resolve();
  let identity;
  let log;
  let server;
  let starting = true;
  let closing = false;
  let exitCode = 0;
  let stopPromise;
  let shutdownPromise;
  const sockets = new Set();
  let finishRun;
  const finished = new Promise((resolve) => { finishRun = resolve; });

  /** 多个 stop/EOF/信号共享一次停止过程，且只作用于尚未 exit 的持有句柄。 */
  async function stopChild() {
    if (!child || childExited) return;
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (childExited) return;
      if (!child.kill("SIGTERM") && !childExited) throw posixSupervisorError();
      if (await waitForExit(childExit, TERMINATE_GRACE_MS)) return;
      if (!childExited && !child.kill("SIGKILL")) throw posixSupervisorError();
      if (!await waitForExit(childExit, KILL_CONFIRM_MS)) throw posixSupervisorError();
    })();
    try { await stopPromise; }
    finally { stopPromise = undefined; }
  }

  /** 先确认核心退出，再释放控制通道及租约；无法确认退出时保持持有关系而不是遗留孤儿。 */
  function requestShutdown(failed = false) {
    closing = true;
    if (failed) exitCode = 1;
    if (starting || shutdownPromise) return;
    shutdownPromise = (async () => {
      try { await stopChild(); }
      catch {
        exitCode = 1;
        process.stderr.write("POSIX supervisor could not confirm child exit.\n");
        // 等待真实 exit；不可退出 supervisor 后把仍存活核心留给 PID 猜测清理。
        await childExit;
      }
      for (const socket of sockets) socket.destroy();
      try {
        if (server?.listening) await new Promise((resolve) => server.close(resolve));
        if (log) await log.close();
      } catch { exitCode = 1; }
      finally {
        // 日志关闭失败也必须解除 stdin 读引用；否则启动回滚会永远等待仍存活的 owner。
        process.stdin.pause();
        process.stdin.off("end", onOwnerGone);
        process.stdin.off("error", onOwnerGone);
        for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, onSignal);
        process.stdout.off("error", onOutputError);
        process.stdout.off("close", onOutputError);
        finishRun(exitCode);
      }
    })();
  }

  /** owner 正常 EOF 与异常退出造成的 pipe 关闭使用完全相同的清理流程。 */
  function onOwnerGone() { requestShutdown(); }
  /** 可捕获的 Unix 终止信号不会直接退出，先回收真实持有的 child。 */
  function onSignal() { requestShutdown(); }
  /** 创建者关闭公告管道也视为启动失败，禁止未登记的核心继续运行。 */
  function onOutputError() { requestShutdown(true); }

  /** 先验证完整身份再执行唯一允许的 status/stop；拒绝响应不回传令牌或输入正文。 */
  function acceptConnection(socket) {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let received = false;
    let deadline = setTimeout(() => socket.destroy(), CONTROL_REQUEST_TIMEOUT_MS);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(deadline); sockets.delete(socket); });
    if (socket.remoteAddress !== "127.0.0.1" || closing || !identity) {
      socket.destroy();
      return;
    }
    socket.on("data", async (chunk) => {
      if (received || buffer.length + chunk.length > CONTROL_MESSAGE_LIMIT) return socket.destroy();
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      received = true;
      clearTimeout(deadline);
      // stop 的等待有独立上限；不能沿用两秒请求接收期限误杀正常退出流程。
      deadline = setTimeout(() => socket.destroy(), TERMINATE_GRACE_MS + KILL_CONFIRM_MS + 1000);
      try {
        if (newline !== buffer.length - 1) throw posixSupervisorError();
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        validatePosixControlMessage(request, config, identity, { direction: "request" });
        if (request.operation === "stop") await stopChild();
        socket.end(encodePosixMessage(createPosixControlMessage(identity, config, {
          direction: "response", nonce: request.nonce, operation: request.operation,
          state: childExited ? "stopped" : "running",
        })));
      } catch {
        // 不写日志或回显请求，错误 token/实例/PID/路径不得泄露当前有效身份。
        socket.end('{"error":"CONTROL_REJECTED"}\n');
      }
    });
  }

  // 在任何异步准备前订阅 owner 租约和信号，覆盖创建与公告之间的关闭窗口。
  process.stdin.once("end", onOwnerGone);
  process.stdin.once("error", onOwnerGone);
  process.stdin.resume();
  if (process.stdin.readableEnded || process.stdin.destroyed) closing = true;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, onSignal);
  process.stdout.on("error", onOutputError);
  process.stdout.on("close", onOutputError);

  try {
    // 文件描述符直接传给核心，stdout/stderr 不可能混进 supervisor 的单行协议。
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0);
    log = await open(join(config.dataDir, "bridge.log"), flags, 0o600);
    if (!(await log.stat()).isFile()) throw posixSupervisorError();
    await log.chmod(0o600);
    if (!closing) {
      server = createServer(acceptConnection);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
      });
      server.on("error", () => requestShutdown(true));
    }
    if (!closing) {
      child = spawnChild(config.binPath, ["-config", config.configPath], {
        cwd: config.dataDir, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "MANAGEMENT_PASSWORD")), MANAGEMENT_STATIC_PATH: panelDirectory },
        stdio: ["ignore", log.fd, log.fd], windowsHide: true,
      });
      childExited = false;
      childExit = new Promise((resolve) => {
        // spawn 失败没有 exit；error 在没有 pid 时也结束持有状态并触发启动回滚。
        child.once("exit", () => { childExited = true; resolve(); });
        child.on("error", () => {
          if (!child.pid) { childExited = true; resolve(); }
        });
      });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      if (!closing && !childExited) {
        identity = {
          pid: child.pid, creationDate: randomUUID(),
          commandLine: JSON.stringify([config.binPath, "-config", config.configPath]),
          executablePath: config.binPath, controlPort: server.address().port,
          controlToken: randomBytes(32).toString("hex"),
        };
        // 公告前验证完整响应也能落在 8 KiB 内；超长路径不能发布一个不可控制的实例。
        const probe = { nonce: "0".repeat(64), operation: "status" };
        encodePosixMessage(createPosixControlMessage(identity, config, { ...probe, direction: "request" }));
        encodePosixMessage(createPosixControlMessage(identity, config, { ...probe, direction: "response", state: "running" }));
        process.stdout.write(encodePosixMessage(identity));
      } else if (!closing) {
        throw posixSupervisorError();
      }
    }
  } catch {
    process.stderr.write("POSIX supervisor initialization failed.\n");
    requestShutdown(true);
  } finally {
    starting = false;
    if (closing) requestShutdown();
  }
  // 核心自然退出后保留认证端点，直到 owner 关闭租约；status 能证明离线，stop 可幂等重试。
  return finished;
}

// 外层只转发身份并持有私有租约，guardian 保留真实核心句柄和既有认证控制端点。
export async function runPosixSupervisor(config, panelDirectory, { spawnGuardian = spawn } = {}) {
  validatePosixPaths(config, panelDirectory);
  let guardian;
  let closing = false;
  let failed = false;
  let announced = false;
  let buffer = Buffer.alloc(0);
  let deadline;

  /** 所有取消/失败只关闭租约，绝不杀 guardian；其 exit 才证明托管清理已结束。 */
  function closeLease(error = false) {
    closing = true;
    failed ||= error;
    clearTimeout(deadline);
    guardian?.stdin.end();
  }
  /** owner 租约断开或可捕获信号都先等待 guardian 回收核心。 */
  function onOwnerGone() { closeLease(); }
  /** 公告输出失败意味着实例不能交付，仍必须等待真实回收。 */
  function onOutputError() { closeLease(true); }
  /** 始终消费输出，但只允许一个受字节上限和固定身份约束的公告。 */
  function onAnnouncement(chunk) {
    if (closing) return;
    if (announced || buffer.length + chunk.length > CONTROL_MESSAGE_LIMIT) return closeLease(true);
    buffer = Buffer.concat([buffer, chunk]);
    const newline = buffer.indexOf(10);
    if (newline < 0) return;
    try {
      if (newline !== buffer.length - 1) throw posixSupervisorError();
      const identity = validatePosixIdentity(JSON.parse(buffer.subarray(0, newline).toString("utf8")), config);
      announced = true;
      buffer = Buffer.alloc(0);
      clearTimeout(deadline);
      process.stdout.write(encodePosixMessage(identity), (error) => { if (error) onOutputError(); });
    } catch { closeLease(true); }
  }

  // 在首次异步让步前监听关闭，避免 owner 在准备窗口退出后仍启动新 guardian。
  process.stdin.once("end", onOwnerGone);
  process.stdin.once("error", onOwnerGone);
  process.stdin.resume();
  if (process.stdin.readableEnded || process.stdin.destroyed) closing = true;
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, onOwnerGone);
  process.stdout.on("error", onOutputError);
  process.stdout.on("close", onOutputError);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    if (!closing) {
      guardian = spawnGuardian(process.execPath, [fileURLToPath(import.meta.url), "--core-guardian",
        config.binPath, config.configPath, config.dataDir, panelDirectory], {
        cwd: config.dataDir, env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      guardian.stdin.on("error", onOutputError);
      guardian.stdout.on("data", onAnnouncement);
      guardian.stdout.on("error", onOutputError);
      guardian.stdout.once("end", () => { if (!closing) closeLease(!announced); });
      // guardian 仅有固定诊断；不把其输出当作可公开的认证或身份数据。
      guardian.stderr.resume();
      guardian.stderr.on("error", onOutputError);
      deadline = setTimeout(() => closeLease(true), 8000);
      await new Promise((resolve) => {
        guardian.once("exit", (code) => { failed ||= code !== 0 || !announced && !closing; resolve(); });
        guardian.on("error", () => {
          closeLease(true);
          // spawn 失败无 exit；已启动的进程即使报错也必须等待 exit。
          if (!guardian.pid) resolve();
        });
      });
    }
  } catch { closeLease(true); }
  finally {
    clearTimeout(deadline);
    process.stdin.pause();
    process.stdin.off("end", onOwnerGone);
    process.stdin.off("error", onOwnerGone);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, onOwnerGone);
    process.stdout.off("error", onOutputError);
    process.stdout.off("close", onOutputError);
  }
  if (failed) process.stderr.write("POSIX supervisor initialization failed.\n");
  return failed ? 1 : 0;
}

// 仅直接执行时读 argv；内部模式不再 spawn guardian，导入测试不读取用户配置正文。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const guardianMode = args[0] === "--core-guardian";
  if (guardianMode) args.shift();
  const [binPath, configPath, dataDir, panelDirectory, ...extra] = args;
  try {
    if (extra.length) throw posixSupervisorError();
    process.exitCode = await (guardianMode ? runCoreGuardian : runPosixSupervisor)({ binPath, configPath, dataDir }, panelDirectory);
  } catch {
    process.stderr.write("POSIX supervisor initialization failed.\n");
    process.exitCode = 1;
  }
}
