import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_MESSAGE_LIMIT, CONTROL_REQUEST_TIMEOUT_MS, encodePosixMessage,
  createPosixControlMessage, posixSupervisorError, validatePosixControlMessage, validatePosixPaths,
} from "../bridge/posix-supervisor.mjs";

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

/**
 * 只持有本实例创建的 ChildProcess，不枚举进程或按记录 PID 发终止信号。
 * spawnChild 注入点仅用于隔离测试：测试仍必须返回真实 ChildProcess，不启动真实代理。
 * stdin 是创建者存活租约；supervisor 自身被 SIGKILL 时无法执行清理，不具有 Job 的内核保证。
 */
export async function runPosixSupervisor(config, panelDirectory, { spawnChild = spawn } = {}) {
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
        cwd: config.dataDir, env: { ...process.env, MANAGEMENT_STATIC_PATH: panelDirectory },
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

// 仅直接执行时读 argv；导入测试不启动托管器，不读取用户配置正文。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binPath, configPath, dataDir, panelDirectory, ...extra] = process.argv.slice(2);
  try {
    if (extra.length) throw posixSupervisorError();
    process.exitCode = await runPosixSupervisor({ binPath, configPath, dataDir }, panelDirectory);
  } catch {
    process.stderr.write("POSIX supervisor initialization failed.\n");
    process.exitCode = 1;
  }
}
