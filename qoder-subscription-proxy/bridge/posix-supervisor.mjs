import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** 请求、响应及首次身份公告的 UTF-8 上限，包含末尾换行。 */
export const CONTROL_MESSAGE_LIMIT = 8 * 1024;
/** 尚未收到完整请求的连接最多保留两秒，不能靠零散字节续租。 */
export const CONTROL_REQUEST_TIMEOUT_MS = 2000;
/** stop 最多五秒 TERM 加一秒 KILL 确认，余量用于控制消息传输。 */
const CONTROL_STOP_TIMEOUT_MS = 8000;
/** 入口不依赖 cwd；argv 只传路径，绝不序列化含密钥的完整 config。 */
const supervisorScript = fileURLToPath(new URL("../scripts/proxy-supervisor.mjs", import.meta.url));

/** 错误使用固定安全文案，不把令牌、命令行或底层网络正文带入 MCP。 */
export function posixSupervisorError(message = "POSIX 托管器身份或控制响应无法确认；未视为离线") {
  return Object.assign(new Error(message), { code: "BRIDGE_NOT_READY", safeMessage: message });
}

/** 只接受绝对路径，不读取配置正文、凭据或二进制内容。 */
export function validatePosixPaths(config, panelDirectory) {
  if (!config || typeof config !== "object") throw posixSupervisorError("POSIX 托管路径配置无效");
  for (const path of [config.binPath, config.configPath, ...(arguments.length > 1 ? [config.dataDir, panelDirectory] : [])]) {
    if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path)) {
      throw posixSupervisorError("POSIX 托管路径必须为不含 NUL 的绝对路径");
    }
  }
}

/**
 * 校验并提取六个身份字段；路径精确区分大小写，不用 PID 探测替代实例身份。
 * creationDate 是随机 UUID，而不是 OS 创建时间；controlToken 是每实例随机 32 字节密钥。
 */
export function validatePosixIdentity(value, config) {
  validatePosixPaths(config);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0x7fffffff ||
      typeof value.creationDate !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.creationDate) ||
      typeof value.controlToken !== "string" || !/^[0-9a-f]{64}$/.test(value.controlToken) ||
      !Number.isInteger(value.controlPort) || value.controlPort < 1 || value.controlPort > 65535 ||
      value.executablePath !== config.binPath ||
      value.commandLine !== JSON.stringify([config.binPath, "-config", config.configPath])) {
    throw posixSupervisorError();
  }
  return {
    pid: value.pid, creationDate: value.creationDate, commandLine: value.commandLine,
    executablePath: value.executablePath, controlPort: value.controlPort, controlToken: value.controlToken,
  };
}

/** 磁盘记录必须显式绑定两条路径，不接受仅有可复用 PID 和端口的不完整记录。 */
export function validatePosixEnvelope(value, config) {
  if (!value || value.binPath !== config.binPath || value.configPath !== config.configPath) {
    throw posixSupervisorError();
  }
  return validatePosixIdentity(value, config);
}

/** 固定字段顺序和方向域隔离，令牌只用于本地 HMAC，绝不发给可能被复用的控制端口。 */
function controlMac(value, token) {
  return createHmac("sha256", Buffer.from(token, "hex")).update(JSON.stringify([
    "qoder-posix-supervisor-v1", value.direction, value.nonce, value.operation, value.state ?? null,
    value.pid, value.creationDate, value.commandLine, value.executablePath,
    value.controlPort, value.binPath, value.configPath,
  ])).digest("hex");
}

/** 创建认证帧；nonce 绑定单次交换，response 的 state 也纳入签名，不能把 running 改成 stopped。 */
export function createPosixControlMessage(identity, config, { direction, nonce, operation, state }) {
  const { controlToken, ...publicIdentity } = identity;
  const message = { ...publicIdentity, binPath: config.binPath, configPath: config.configPath, direction, nonce, operation };
  if (state !== undefined) message.state = state;
  return { ...message, mac: controlMac(message, controlToken) };
}

/** 先验证方向、挑战和固定身份，再用 timingSafeEqual 验证 HMAC；成功身份只取本地已校验记录。 */
export function validatePosixControlMessage(value, config, expected, { direction, nonce, operation }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.hasOwn(value, "controlToken") ||
      value.direction !== direction || typeof value.nonce !== "string" || !/^[0-9a-f]{64}$/.test(value.nonce) ||
      (nonce !== undefined && value.nonce !== nonce) || (operation !== undefined && value.operation !== operation) ||
      (value.operation !== "status" && value.operation !== "stop") ||
      (direction === "request" ? value.state !== undefined : !["running", "stopped"].includes(value.state)) ||
      value.pid !== expected.pid || value.creationDate !== expected.creationDate ||
      value.controlPort !== expected.controlPort || value.commandLine !== expected.commandLine ||
      value.executablePath !== expected.executablePath || value.binPath !== config.binPath || value.configPath !== config.configPath ||
      typeof value.mac !== "string" || !/^[0-9a-f]{64}$/.test(value.mac) ||
      !timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(controlMac(value, expected.controlToken), "hex"))) {
    throw posixSupervisorError();
  }
  return expected;
}

/** 单连接只交换一行 JSON；发送前按字节限制，避免中文路径绕过长度约束。 */
export function encodePosixMessage(value) {
  const message = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(message) > CONTROL_MESSAGE_LIMIT) throw posixSupervisorError("POSIX 控制消息超过 8 KiB 上限");
  return message;
}

/**
 * 同步返回 Node ChildProcess。stdin 必须保持打开，结束租约请调用 stdin.end()，不要 kill 托管器。
 * env 原样继承 ELECTRON_RUN_AS_NODE，防止 Electron 宿主的 execPath 被当作 GUI 应用启动。
 */
export function spawnPosixSupervisor(config, panelDirectory) {
  validatePosixPaths(config, panelDirectory);
  return spawn(process.execPath, [supervisorScript, config.binPath, config.configPath, config.dataDir, panelDirectory], {
    cwd: config.dataDir,
    env: { ...process.env, MANAGEMENT_STATIC_PATH: panelDirectory },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * status 返回身份；受认证的 stopped 响应返回 null。stop 返回 {...identity, stopped:true}。
 * 仅连接拒绝且 signal 0 探测明确 ESRCH 时也返回 null；PID 存在、EPERM、超时或认证失败均抛错。
 * signal 0 只用于证明陈旧记录已离线，不据此认领或向记录的 PID 发送终止信号。重复 stop 幂等。
 * record 必须含首次身份的全部字段，以及持久化的 binPath/configPath；不接受自定义连接地址。
 */
export async function queryPosixSupervisor(record, config, { stop = false } = {}) {
  validatePosixPaths(config);
  if (typeof stop !== "boolean" || (record?.controlHost !== undefined && record.controlHost !== "127.0.0.1")) {
    throw posixSupervisorError();
  }
  const identity = validatePosixEnvelope(record, config);
  const nonce = randomBytes(32).toString("hex");
  const operation = stop ? "stop" : "status";
  const request = encodePosixMessage(createPosixControlMessage(identity, config, {
    direction: "request", nonce, operation,
  }));
  return new Promise((resolve, reject) => {
    // 地址写死为 IPv4 回环，不解析 PID 文件中的主机名，也不使用 HTTP 代理环境变量。
    const socket = createConnection({ host: "127.0.0.1", port: identity.controlPort, family: 4 });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(posixSupervisorError("POSIX 托管器控制请求超时；未视为离线")),
      stop ? CONTROL_STOP_TIMEOUT_MS : CONTROL_REQUEST_TIMEOUT_MS + 500);

    /** 所有完成路径都关闭连接和定时器；失败不回显服务端提供的任意正文。 */
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    }

    socket.once("connect", () => socket.write(request));
    socket.once("error", (error) => {
      // 控制端点已关闭后，只接受明确不存在的旧 PID；不能把 PID 复用或权限拒绝当离线。
      if (error.code === "ECONNREFUSED") {
        try { process.kill(identity.pid, 0); }
        catch (probeError) { if (probeError.code === "ESRCH") return finish(null, null); }
      }
      finish(posixSupervisorError("无法连接 POSIX 托管器；归属未知，未视为离线"));
    });
    socket.once("end", () => finish(posixSupervisorError("POSIX 托管器未返回完整控制响应")));
    socket.once("close", () => finish(posixSupervisorError("POSIX 托管器控制连接已关闭，归属未知")));
    socket.on("data", (chunk) => {
      if (settled) return;
      if (buffer.length + chunk.length > CONTROL_MESSAGE_LIMIT) return finish(posixSupervisorError());
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        // 不接受附带第二条消息或尾随字节的帧，避免前后两个身份解释不一致。
        if (newline !== buffer.length - 1) throw posixSupervisorError();
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        const verified = validatePosixControlMessage(response, config, identity, { direction: "response", nonce, operation });
        if (stop && response.state !== "stopped") throw posixSupervisorError("POSIX 托管器尚未确认核心退出");
        finish(null, stop ? { ...verified, stopped: true } : response.state === "stopped" ? null : verified);
      } catch { finish(posixSupervisorError()); }
    });
  });
}
