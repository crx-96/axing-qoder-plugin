import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** 将锁冲突转换为可向本机用户报告的固定诊断。 */
function lockError(message) {
  return Object.assign(new Error(message), { code: "BRIDGE_NOT_READY", safeMessage: message });
}

/** 同目录启停与迁移必须串行；Linux 抽象 socket 避免 TCP 竞争，所有平台均由 OS 在进程退出时释放锁。 */
export async function withLifecycleLock(config, action, timeoutMs = 25000, signal) {
  if (!["win32", "darwin", "linux"].includes(process.platform)) throw lockError("不支持此操作系统");
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(config.dataDir);
  const hash = createHash("sha256").update(process.platform === "win32" ? directory.toLowerCase() : directory).digest("hex").slice(0, 32);
  const lockPort = 20000 + Number.parseInt(hash.slice(0, 8), 16) % 20000;
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\qoder-subscription-bridge-${hash}`
    : process.platform === "linux"
      ? `\0qoder-subscription-bridge-${hash}`
      : { host: "127.0.0.1", port: lockPort, exclusive: true };
  if (process.platform === "darwin" && lockPort === config.port) {
    throw lockError("BRIDGE_PORT 与本数据目录的生命周期锁端口冲突；请使用其他代理端口");
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
      if (Date.now() >= deadline) throw lockError("另一会话正在启动或停止订阅桥，请稍后重试");
      await delay(100, undefined, { signal });
    }
  }
  try { signal?.throwIfAborted(); return await action(); }
  finally { await new Promise((resolve) => owner.close(resolve)); }
}
