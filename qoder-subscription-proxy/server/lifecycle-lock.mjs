import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Darwin <sys/fcntl.h> 的 O_EXLOCK。Node 支持数值 open 标志，但未公开这个 BSD 常量。 */
const DARWIN_O_EXLOCK = 0x0020;

/** 将锁冲突转换为可向本机用户报告的固定诊断。 */
function lockError(message) {
  return Object.assign(new Error(message), { code: "BRIDGE_NOT_READY", safeMessage: message });
}

/** macOS 在 open 时原子取得 flock 排他锁。返回释放函数，争用时返回 null，其他错误直接上报。 */
async function tryDarwinLock(directory) {
  // 所有会话始终打开同一 inode。保留文件及其内容，避免 unlink 后等待者和新来者锁住不同文件。
  const path = join(directory, ".bridge-lifecycle.lock");
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | DARWIN_O_EXLOCK;
  let handle;
  try {
    handle = await open(path, flags, 0o600);
  } catch (error) {
    if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") return null;
    throw error;
  }

  // 核对已打开的对象，拒绝异常文件类型。失败也要关闭描述符，以便内核释放锁。
  try {
    if (!(await handle.stat()).isFile()) throw lockError("生命周期锁路径必须是普通文件");
    return () => handle.close();
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Windows 命名管道、Linux 抽象 socket 沿用规范路径哈希作为锁名。绑定冲突时交由调用方重试。 */
async function trySocketLock(directory) {
  const windows = process.platform === "win32";
  const hash = createHash("sha256").update(windows ? directory.toLowerCase() : directory).digest("hex").slice(0, 32);
  const address = windows ? `\\\\.\\pipe\\qoder-subscription-bridge-${hash}` : `\0qoder-subscription-bridge-${hash}`;
  // 锁只利用监听地址的唯一性，丢弃连接，持有者关闭 server 即可让下一会话接手。
  const candidate = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      candidate.once("error", reject);
      candidate.listen(address, resolve);
    });
    return () => new Promise((resolve) => candidate.close(resolve));
  } catch (error) {
    candidate.close();
    if (error.code === "EADDRINUSE") return null;
    throw error;
  }
}

/**
 * 在同一数据目录上串行执行启停与凭据迁移。timeoutMs 和 signal 控制等待，进入后一直持锁到 action 结束。
 * macOS 更换了锁协议，升级前须先退出共享此目录的旧版会话并等其在途操作结束。
 */
export async function withLifecycleLock(config, action, timeoutMs = 25000, signal) {
  if (!["win32", "darwin", "linux"].includes(process.platform)) throw lockError("不支持此操作系统");
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(config.dataDir);
  const tryLock = process.platform === "darwin" ? tryDarwinLock : trySocketLock;
  const deadline = Date.now() + timeoutMs;
  // 非阻塞尝试允许多个进程同时排队，也使取消无需等待其他会话完成操作。
  let release;
  while (!release) {
    signal?.throwIfAborted();
    release = await tryLock(directory);
    if (!release) {
      if (Date.now() >= deadline) throw lockError("另一会话正在启动或停止订阅桥，请稍后重试");
      await delay(100, undefined, { signal });
    }
  }
  // 检查异步取锁期间发生的取消，保证取消、成功和异常均经过同一释放路径。
  try { signal?.throwIfAborted(); return await action(); }
  finally { await release(); }
}
