import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

/** 使用系统工具时限制运行时间和输出，失败一律禁止认证。 */
const execute = promisify(execFile);

/** 固定错误不包含命令行、端口表或凭据。 */
function unverified(stage = "连接校验") {
  const safeMessage = `本机代理未就绪或无法确认本次回环连接由插件核心接收，未发送凭据。（${stage}）`;
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
    const endpoints = stdout.split("\n");
    if (endpoints.includes(`n${local}->${peer}`)) return true;
    // TCP 握手先于 accept；仅目标 PID 仍持有本地端点时等待，监听端点本身不能授权。
    return endpoints.includes(`n${local}`) ? null : false;
  }
  return process.platform === "linux" && await linuxOwns(pid, port, clientPort);
}

/** 在不发送 HTTP 数据的情况下连接本机端口；只有内核连接归属和托管身份都验证成功才交给调用方。 */
export async function connectOwned(config, identify, signal) {
  if (config.host !== "127.0.0.1") throw unverified();
  // Windows 依次运行两次 CIM（各限五秒）及一次 netstat（限四秒）；总预算须容纳三次核验。
  const deadline = AbortSignal.timeout(process.platform === "win32" ? 15000 : 7000);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  active.throwIfAborted();
  const socket = createConnection({ host: config.host, port: config.port, family: 4 });
  let stage = "TCP 连接建立";
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
      stage = "托管进程身份";
      const id = await identify();
      active.throwIfAborted();
      if (!Number.isSafeInteger(id?.pid) || id.pid <= 0 || id.pid > 0x7fffffff) throw unverified();
      const original = { ...id };
      stage = "内核连接归属";
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
      stage = "托管身份复核";
      if (!isDeepStrictEqual(original, await identify())) throw unverified();
      active.throwIfAborted();
      if (socket.destroyed) throw unverified();
    };
    await Promise.race([new Promise((_, reject) => { rejectVerification = reject; }), verify()]);
    active.throwIfAborted();
    return socket;
  } catch {
    socket.destroy();
    signal?.throwIfAborted();
    throw unverified(deadline.aborted ? `校验超时：${stage}` : stage);
  } finally {
    active.removeEventListener("abort", cancel);
  }
}
