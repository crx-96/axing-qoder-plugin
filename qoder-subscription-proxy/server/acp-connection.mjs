import { spawn, execFile } from "node:child_process";
import { dirname, delimiter, isAbsolute, join } from "node:path";
import { PLUGIN_VERSION } from "./config.mjs";

export function acpError(code, message) {
  return Object.assign(new Error(message), { code, safeMessage: message });
}

export class AcpConnection {
  #child;
  #pending = new Map();
  #next = 0;
  #closed = false;
  #closing;
  #exited;
  #update;
  #permission;
  info;

  constructor(runtime, { env = process.env, onUpdate = () => {}, onPermission, spawnProcess = spawn } = {}) {
    this.#update = onUpdate;
    this.#permission = onPermission;
    if (typeof runtime.profilePath !== "string" || !isAbsolute(runtime.profilePath)) throw acpError("ACP_CONFIG", "ACP 必须使用插件专属的官方配置目录。");
    const allowed = /^(SystemRoot|WINDIR|COMSPEC|PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|ALLUSERSPROFILE|TMP|TEMP|LANG|LC_ALL|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.test(key)));
    childEnv.GEMINI_HOME = runtime.profilePath;
    if (typeof runtime.proxyUrl === "string" && runtime.proxyUrl) {
      const proxy = ["direct", "none"].includes(runtime.proxyUrl) ? "" : runtime.proxyUrl;
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) childEnv[key] = proxy;
    }
    // 回环 MCP 的认证令牌不能经过用户配置的出站代理。
    const noProxy = [...new Set([...(env.no_proxy ?? env.NO_PROXY ?? "").split(",").filter(Boolean), "127.0.0.1", "localhost", "::1"])].join(",");
    childEnv.NO_PROXY = childEnv.no_proxy = noProxy;
    if (runtime.authMethod === "gemini-api-key" && env.GEMINI_API_KEY) childEnv.GEMINI_API_KEY = env.GEMINI_API_KEY;
    childEnv.PATH = dirname(runtime.path) + delimiter + (env.PATH ?? env.Path ?? "");
    this.#child = spawnProcess(runtime.path, runtime.args ?? [], {
      cwd: dirname(runtime.path), env: childEnv, windowsHide: true, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.#child;
    this.#exited = new Promise(resolve => {
      child.once("exit", () => { this.#fail(acpError("ACP_CLOSED", "官方 ACP 程序已退出。")); resolve(); });
      child.once("error", () => { this.#fail(acpError("ACP_START_FAILED", "无法启动官方 ACP 程序，请检查平台和执行权限。")); resolve(); });
    });
    child.stderr.resume();
    child.stdin.on("error", () => this.#fail(acpError("ACP_CLOSED", "ACP 输入通道已关闭。")));
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 64 * 1024 * 1024) {
        this.#fail(acpError("ACP_PROTOCOL", "ACP 消息超过容量限制。"));
        void this.close();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { this.#receive(JSON.parse(line)); }
        catch { this.#fail(acpError("ACP_PROTOCOL", "官方程序返回无效 ACP 消息。")); void this.close(); return; }
      }
    });
  }

  #fail(error) {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #send(message) {
    if (this.#closed || this.#child.stdin.destroyed) throw acpError("ACP_CLOSED", "ACP 连接已关闭。");
    this.#child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  #receive(message) {
    if (!message || message.jsonrpc !== "2.0") throw new Error("invalid rpc");
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        const result = message.method === "session/request_permission"
          ? Promise.resolve().then(() => this.#permission?.(message.params) ?? { outcome: { outcome: "cancelled" } })
          : Promise.reject(acpError("ACP_METHOD_UNSUPPORTED", "未开放该客户端能力。"));
        void result.then(value => this.#send({ id: message.id, result: value }),
          () => this.#send({ id: message.id, error: { code: -32601, message: "Client capability unavailable" } })).catch(() => {});
      } else if (message.method === "session/update") this.#update(message.params);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) {
      const auth = message.error.code === -32000 || message.error.code === -32001;
      pending.reject(acpError(auth ? "ACP_AUTH_REQUIRED" : "ACP_REQUEST_FAILED",
        auth ? "ACP 请求未获授权，请在管理入口检查官方登录状态。" : "官方 ACP 拒绝请求，请检查模型能力或配置。"));
    } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else pending.reject(acpError("ACP_PROTOCOL", "ACP 响应缺少结果。"));
  }

  call(method, params, { signal, timeoutMs = 120000 } = {}) {
    signal?.throwIfAborted();
    if (this.#closed) return Promise.reject(acpError("ACP_CLOSED", "ACP 连接已关闭。"));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(id);
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(acpError("ACP_CANCELLED", "ACP 请求已取消。"));
      const timer = setTimeout(() => finish(acpError("ACP_TIMEOUT", "ACP 请求超时。")), timeoutMs);
      this.#pending.set(id, { resolve: result => finish(null, result), reject: error => finish(error) });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.#send({ id, method, params }); } catch (error) { finish(error); }
    });
  }

  notify(method, params) { this.#send({ method, params }); }

  async initialize(signal) {
    const result = await this.call("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "qoder-subscription-proxy", version: PLUGIN_VERSION },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, { signal });
    if (result?.protocolVersion !== 1 || result.agentInfo?.name !== "antigravity-acp" ||
        !result.agentCapabilities?.mcpCapabilities?.http) {
      throw acpError("ACP_INCOMPATIBLE", "程序不是支持本方案的官方 Antigravity ACP 服务。");
    }
    this.info = result;
    return result;
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      this.#fail(acpError("ACP_CLOSED", "ACP 会话已关闭。"));
      const child = this.#child;
      child.stdin.end();
      let timer;
      await Promise.race([this.#exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
      clearTimeout(timer);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          await new Promise(resolve => execFile(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
        } else {
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        await this.#exited;
      }
    })();
    return this.#closing;
  }
}
