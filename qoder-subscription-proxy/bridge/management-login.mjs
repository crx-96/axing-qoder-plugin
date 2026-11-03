import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { patchManagementPanel } from "./management-panel.mjs";
import { openCoreConnection, requestOwned } from "./bridge-process.mjs";

/** 票据只用于一次浏览器交接，兑换后的会话限定于此进程、此端口和管理 API。 */
const TICKET_MS = 60_000;
/** 会话到期后从宿主指令重新登录，标签页刷新可沿用其剩余期限。 */
const SESSION_MS = 30 * 60_000;
/** 只把管理界面所需的元数据带过边界，不透传 Cookie、Origin、Host 或上游 CORS。 */
const RESPONSE_HEADERS = ["content-type", "content-disposition", "content-encoding", "x-cpa-version",
  "x-cpa-commit", "x-cpa-build-date", "x-cpa-support-plugin", "x-server-version"];
/** 固定发行页面的挂载点，仅在确认该锚点唯一时注入本机登录。 */
const MOUNT = "(0,b.createRoot)(document.getElementById(`root`))";
/** 先兑换 fragment 票据，再清除地址中的票据并进入面板的 OAuth 路由。 */
const LANDING = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权与账号管理</title>
<p id="state">正在打开授权与账号管理…</p><script>
(async () => {
  const ticket = location.hash.slice(1);
  history.replaceState(null, "", "/open");
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw Error();
  const res = await fetch("/exchange", {method:"POST", headers:{"X-Login-Ticket":ticket}, credentials:"omit"});
  if (!res.ok) throw Error();
  sessionStorage.setItem("bridge-panel-session", (await res.json()).session);
  location.replace("/management.html#/oauth");
})().catch(() => { document.getElementById("state").textContent = "登录链接无效或已过期，请重新运行插件的授权与账号管理指令。"; });
</script></html>`;

/** 只在受控面板副本中引导上游认证，长期管理密钥不会出现在网址、页面或会话存储中。 */
function sessionPanel(bytes) {
  const html = patchManagementPanel(bytes);
  if (html.split(MOUNT).length !== 2) throw Error("管理页面登录挂载点与固定版本不匹配。");
  const init = `const bridgeSession=sessionStorage.getItem("bridge-panel-session");try {
    if (!bridgeSession) throw Error();
    await Nm.getState().login({apiBase:location.origin,managementKey:bridgeSession,rememberPassword:false});
  } catch { document.getElementById("root").textContent="登录已过期，请从插件重新打开授权与账号管理。"; throw Error("expired"); }
  `;
  // 在页面主动登出时撤销服务端会话，刷新不会恢复已退出的登录。
  const logout = "logout:()=>{Mm=null,";
  if (html.split(logout).length !== 2) throw Error("管理页登出挂载点与固定版本不匹配。");
  const revoke = 'const key=sessionStorage.getItem("bridge-panel-session");sessionStorage.removeItem("bridge-panel-session");' +
    'if(key)void fetch("/logout",{method:"POST",headers:{Authorization:"Bearer "+key},keepalive:true}).catch(()=>{});';
  return html.replace(MOUNT, () => init + MOUNT).replace(logout, () => "logout:()=>{" + revoke + "Mm=null,");
}

/** 固定本地程序和参数打开默认浏览器；仅传播可展示的固定错误，不记录票据地址。 */
async function openSystemBrowser(url) {
  const windows = process.platform === "win32";
  const program = windows ? join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe")
    : process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  const child = spawn(program, windows ? ["url.dll,FileProtocolHandler", url] : [url],
    { windowsHide: true, detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("error", () => reject(Error("无法打开默认浏览器。")));
    child.once("spawn", resolve);
  });
  child.unref();
}

/** 代理通过同一条已核验的连接向核心发送管理请求；不接受任意目标地址或外部重定向。 */
async function relay(config, incoming, outgoing) {
  // 已允许的路径仍须拒绝编码分隔符、点段及代理形式，防止越过管理 API 前缀。
  const target = new URL(incoming.url, "http://127.0.0.1");
  if (!incoming.url.startsWith("/") || incoming.url.startsWith("//") ||
      !/^\/v(?:8|0)\/management(?:\/|$)/.test(target.pathname) ||
      /%(?:2f|5c|2e|25)|\\/i.test(target.pathname) ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(incoming.method)) {
    outgoing.writeHead(404).end(); return;
  }
  const controller = new AbortController();
  outgoing.once("close", () => controller.abort());
  const socket = await openCoreConnection(config, controller.signal);
  if (controller.signal.aborted) { socket.destroy(); return; }
  const headers = { Authorization: "Bearer " + config.mgmtKey, Connection: "close" };
  for (const name of ["content-type", "content-length", "accept"]) {
    if (incoming.headers[name] !== undefined) headers[name] = incoming.headers[name];
  }
  // 上传、下载和流式响应都保留背压；断开网页同时取消服务端请求。
  const upstream = http.request({ hostname: config.host, port: config.port, path: target.pathname + target.search,
    method: incoming.method, headers, createConnection: () => socket, signal: controller.signal }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400) {
      response.destroy(); outgoing.writeHead(502).end(); return;
    }
    for (const name of RESPONSE_HEADERS) if (response.headers[name] !== undefined) outgoing.setHeader(name, response.headers[name]);
    outgoing.writeHead(response.statusCode);
    pipeline(response, outgoing, () => {});
  });
  upstream.setTimeout(120_000, () => upstream.destroy());
  upstream.on("error", () => {
    if (outgoing.headersSent) outgoing.destroy();
    else if (!outgoing.destroyed) outgoing.writeHead(502).end();
  });
  incoming.once("aborted", () => upstream.destroy());
  incoming.on("error", () => upstream.destroy());
  incoming.pipe(upstream);
}

/** 创建一个按 MCP 会话回收的回环登录服务；open/close 分别由用户指令和宿主生命周期调用。 */
export function createManagementLogin(config, { launchBrowser = openSystemBrowser } = {}) {
  const tickets = new Map();
  const sessions = new Map();
  let server, starting, origin, panel, closed = false;

  /** 回收过期值，并限制每个进程保留的标签页和未兑换票据数。 */
  function issue(map, lifetime) {
    for (const [key, expiry] of map) if (expiry <= Date.now()) map.delete(key);
    if (map.size >= 32) map.delete(map.keys().next().value);
    const token = randomBytes(32).toString("hex");
    map.set(token, Date.now() + lifetime);
    return token;
  }

  /** 只允许本服务的 Host 与来源。跨站预检、未知路径及无效凭据都不会触及核心。 */
  async function handle(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    if (!origin || req.headers.host !== origin.slice(7) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site" || req.method === "OPTIONS" ||
        (!["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    if (req.method === "GET" && ["/open", "/management.html"].includes(req.url)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(req.url === "/open" ? LANDING : panel); return;
    }
    if (req.method === "POST" && req.url === "/exchange") {
      const key = req.headers["x-login-ticket"];
      const expires = tickets.get(key);
      tickets.delete(key);
      if (!expires || expires <= Date.now() || req.headers.origin !== origin) { res.writeHead(403).end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ session: issue(sessions, SESSION_MS) })); return;
    }
    const session = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "")?.[1];
    if ((sessions.get(session) || 0) <= Date.now()) { res.writeHead(401).end(); return; }
    if (req.method === "POST" && req.url === "/logout") {
      sessions.delete(session);
      res.writeHead(204).end();
      return;
    }
    await relay(config, req, res);
  }

  /** 惰性读取并验证面板资产；只绑定 OS 分配的 IPv4 回环端口。 */
  async function start() {
    panel = sessionPanel(await readFile(new URL("./panel/management.upstream.html", import.meta.url)));
    if (closed) throw Error("MCP 会话已关闭。");
    server = http.createServer((req, res) => {
      handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    if (closed) { server.close(); throw Error("MCP 会话已关闭。"); }
    origin = "http://127.0.0.1:" + server.address().port;
    server.unref();
  }

  return {
    /** 先验证核心管理接口，成功才签发票据。URL 仅交给本机浏览器，不作为工具结果。 */
    async open(signal) {
      const ready = await requestOwned(config, "/v8/management/config",
        { management: true, signal, statusOnly: true });
      if (ready.status !== 200) throw Object.assign(Error(), { safeMessage: "管理接口未就绪，请先检查桥状态。" });
      if (!starting) starting = start().catch(error => { starting = undefined; throw error; });
      await starting;
      signal?.throwIfAborted();
      if (closed) throw Error("MCP 会话已关闭。");
      const ticket = issue(tickets, TICKET_MS);
      try { await launchBrowser(origin + "/open#" + ticket); }
      catch { tickets.delete(ticket); throw Object.assign(Error(), { safeMessage: "无法打开系统默认浏览器。" }); }
    },
    /** MCP 断开后撤销所有本会话凭据，断开已有浏览器流并停止接受新连接。 */
    close() {
      closed = true;
      tickets.clear(); sessions.clear();
      if (server) { server.close(); server.closeAllConnections(); }
    },
  };
}
