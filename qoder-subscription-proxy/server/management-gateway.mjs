import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { MANAGEMENT_PORT } from "./config.mjs";
import { patchManagementPanel } from "./management-panel.mjs";
import { openCoreConnection, requestOwned } from "./supervisor.mjs";

/** 票据只用于一次浏览器交接，兑换后的会话限定于此进程、此端口和管理 API。 */
const TICKET_MS = 60_000;
/** 会话到期后从宿主指令重新登录，标签页刷新可沿用其剩余期限。 */
const SESSION_MS = 30 * 60_000;
/** 连接器授权按钮打开的落地页路径；票据放在 fragment，不进入服务端日志。 */
const AUTHORIZE_LANDING = "/open";
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

/**
 * 创建一个按 MCP 会话回收的回环管理网关。
 * listen 由会话初始化调用，使连接器授权按钮与免密管理页常驻固定端口；
 * open/close 分别由管理工具和宿主生命周期调用。
 */
export function createManagementLogin(config, { launchBrowser = openSystemBrowser, port = MANAGEMENT_PORT } = {}) {
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
    const path = req.url.split("?")[0];
    // 连接器协议端点由宿主或授权客户端以无 Origin 的机器请求访问；浏览器敏感路由仍要求同源。
    const machineRoute = req.method === "POST" && ["/mcp", "/oauth/token", "/oauth/register"].includes(path);
    if (!origin || req.headers.host !== origin.slice(7) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        req.headers["sec-fetch-site"] === "cross-site" || req.method === "OPTIONS" ||
        (!machineRoute && !["GET", "HEAD"].includes(req.method) && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    // 连接器按钮机制：宿主探测 HTTP 连接器时按 RFC 9728 发现授权服务器，
    // 授权端点即本网关免密管理页，点击「授权/重新授权」按钮就在浏览器打开管理登录页。
    // 本端点永不颁发可用令牌，连接器保持待授权状态，按钮因此常驻。
    if (path === "/mcp") {
      res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_token", error_description: "Management connector requires browser authorization." }));
      return;
    }
    // RFC 9728 允许在 well-known 路径后附加资源路径；宿主按 /mcp 后缀构造，两种拼法须同答。
    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" ||
        path.startsWith("/.well-known/oauth-protected-resource/"))) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        resource: origin + "/mcp",
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      }));
      return;
    }
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: origin + "/oauth/authorize",
        token_endpoint: origin + "/oauth/token",
        registration_endpoint: origin + "/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }));
      return;
    }
    if (req.method === "GET" && path === "/oauth/authorize") {
      // 只接受回环重定向地址，避免票据落地页被导向外部站点；state 原样不解释。
      const query = new URL(req.url, origin).searchParams;
      const redirect = query.get("redirect_uri") || "";
      let target;
      try { target = new URL(redirect); } catch { target = null; }
      if (!target || target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
          target.username || target.password) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: "redirect_uri must be loopback." }));
        return;
      }
      // 授权流程故意不在浏览器内完成回调：落地页就是管理登录页本身，宿主等待回调超时后按钮恢复可点。
      const ticket = issue(tickets, TICKET_MS);
      res.writeHead(302, { Location: origin + AUTHORIZE_LANDING + "#" + ticket });
      res.end();
      return;
    }
    if (req.method === "POST" && path === "/oauth/token") {
      // 浏览器交接不产生授权码，任何令牌请求都按无效授权拒绝，连接器维持待授权。
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "Authorization completes in the management page, not via callback." }));
      return;
    }
    if (req.method === "POST" && path === "/oauth/register") {
      // RFC 7591 注册响应须回显客户端元数据；宿主 SDK 强制校验 redirect_uris 为数组。
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) { res.writeHead(400).end(); return; }
        chunks.push(chunk);
      }
      let requested = {};
      try { requested = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { requested = {}; }
      const redirectUris = Array.isArray(requested.redirect_uris)
        ? requested.redirect_uris.filter((uri) => typeof uri === "string") : [];
      res.setHeader("Content-Type", "application/json");
      res.writeHead(201);
      res.end(JSON.stringify({
        client_id: "qoder-connector-" + randomBytes(8).toString("hex"),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        redirect_uris: redirectUris,
      }));
      return;
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

  /** 会话期独占监听固定回环端口；占用期间拒绝签发凭证，释放后可重试。 */
  async function start() {
    panel = sessionPanel(await readFile(new URL("./panel/management.upstream.html", import.meta.url)));
    if (closed) throw Error("MCP 会话已关闭。");
    const candidate = http.createServer((req, res) => {
      handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
    });
    // 等待操作系统确认独占绑定后才发布入口，不能向占用同一端口的未知服务交付票据。
    try {
      await new Promise((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
          candidate.off("error", reject);
          resolve();
        });
      });
      if (closed) throw Error("MCP 会话已关闭。");
      server = candidate;
      origin = "http://127.0.0.1:" + port;
      server.unref();
    } catch (error) {
      candidate.close();
      if (error.code === "EADDRINUSE") {
        throw Object.assign(Error(), { safeMessage: `管理端口 ${port} 已被占用；请核对占用来源后重试。` });
      }
      throw error;
    }
  }

  return {
    /** MCP 会话期常驻监听：连接器授权元数据、免密管理入口与管理 API 代理共用固定端口。 */
    listen: start,
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
