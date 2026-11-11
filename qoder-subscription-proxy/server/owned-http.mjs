import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

/** 使用系统工具时限制运行时间和输出，失败一律禁止认证。 */
const execute = promisify(execFile);

/** 固定错误不包含命令行、端口表或凭据。 */
function unverified() {
  const safeMessage = "本机代理未就绪或无法确认本次回环连接由插件核心接收，未发送凭据。";
  return Object.assign(new Error(safeMessage), { code: "BRIDGE_NOT_READY", safeMessage });
}

/** Linux 依据服务端已建立连接的四元组查 inode，再检查目标 PID 的描述符。 */
async function linuxOwns(pid, serverPort, clientPort) {
  const endpoint = port => "0100007F:" + port.toString(16).toUpperCase().padStart(4, "0");
  const rows = await readFile("/proc/net/tcp", "utf8");
  const peer = rows.split("\n").map(row => row.trim().split(/\s+/)).find(fields =>
    fields[1] === endpoint(serverPort) && fields[2] === endpoint(clientPort) && fields[3] === "01");
  const directory = `/proc/${pid}/fd`;
  const entries = await readdir(directory);
  // 握手完成而 accept 尚未执行时 inode 为 0；只有这一窗口允许等待。
  if (!peer || peer[9] === "0") return null;
  if (!/^[1-9]\d*$/.test(peer[9])) return false;
  for (const entry of entries) {
    try { if (await readlink(join(directory, entry)) === `socket:[${peer[9]}]`) return true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return false;
}

/** 验证已建立连接的服务端口、客户端临时端口和服务端 PID，避免再次连接时换了监听者。 */
async function ownsSocket(pid, port, clientPort, signal) {
  const local = "127.0.0.1:" + port;
  const peer = "127.0.0.1:" + clientPort;
  const options = { windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024, signal };
  if (process.platform === "win32") {
    const program = join(process.env.SystemRoot || "C:\\Windows", "System32", "netstat.exe");
    const { stdout } = await execute(program, ["-ano", "-p", "TCP"], options);
    return stdout.split(/\r?\n/).some(row => {
      const fields = row.trim().split(/\s+/);
      return fields[0] === "TCP" && fields[1] === local && fields[2] === peer && fields[4] === String(pid);
    });
  }
  if (process.platform === "darwin") {
    const { stdout } = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-F", "n"], options);
    return stdout.split("\n").includes(`n${local}->${peer}`);
  }
  return process.platform === "linux" && await linuxOwns(pid, port, clientPort);
}

/** 在不发送 HTTP 数据的情况下连接本机端口；只有内核连接归属和托管身份都验证成功才交给调用方。 */
export async function connectOwned(config, identify, signal) {
  if (config.host !== "127.0.0.1") throw unverified();
  const deadline = AbortSignal.timeout(7000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  active.throwIfAborted();
  const socket = createConnection({ host: config.host, port: config.port, family: 4 });
  // net 的 signal 会在之后到期并销毁长请求；仅在建连和验证阶段挂自己的取消监听。
  let rejectVerification;
  const cancel = () => { socket.destroy(); rejectVerification?.(unverified()); };
  active.addEventListener("abort", cancel, { once: true });
  socket.on("error", () => { /* 在异步归属查询期间由 destroyed 检查统一失败。 */ });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("close", () => reject(unverified()));
      socket.once("error", reject);
    });
    const verify = async () => {
      active.throwIfAborted();
      const id = await identify();
      active.throwIfAborted();
      if (!Number.isSafeInteger(id?.pid) || id.pid <= 0 || id.pid > 0x7fffffff) throw unverified();
      const original = { ...id };
      let owned;
      do {
        active.throwIfAborted();
        if (socket.destroyed) throw unverified();
        owned = await ownsSocket(original.pid, config.port, socket.localPort, active);
        if (owned === null) await delay(25, undefined, { signal: active });
      } while (owned === null);
      active.throwIfAborted();
      if (!owned || socket.destroyed) throw unverified();
      // 等待期间记录可能被另一会话替换；同 PID 不能代替完整实例身份。
      if (process.platform === "linux" && !isDeepStrictEqual(original, await identify())) throw unverified();
      active.throwIfAborted();
      if (socket.destroyed) throw unverified();
    };
    await Promise.race([new Promise((_, reject) => { rejectVerification = reject; }), verify()]);
    active.throwIfAborted();
    return socket;
  } catch {
    socket.destroy();
    signal?.throwIfAborted();
    throw unverified();
  } finally {
    active.removeEventListener("abort", cancel);
  }
}
