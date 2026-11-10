import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.mjs";
import { ensureRunning, shutdownOwnedBridges } from "../server/supervisor.mjs";
import { createManagementLogin } from "../server/management-gateway.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("原生核心与管理页经同源一次性票据交接、代理认证、到期和关闭撤销", {
  skip: nativeCoreSkip, timeout: 100_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "bridge-management-login-"));
  let login;
  t.after(async () => {
    login?.close();
    await shutdownOwnedBridges();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const binary = await copyTestCore(join(root, process.platform === "win32" ? "isolated.exe" : "isolated"));
  const config = await loadConfig({
    pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { BRIDGE_DATA_DIR: join(root, "data"), BRIDGE_BIN: binary, BRIDGE_PORT: String(await unusedPort()) },
  });
  const ready = await ensureRunning(config);
  assert.equal(ready.ready, true);
  let launch;
  const port = await unusedPort();
  const createLogin = () => createManagementLogin(config, { port, launchBrowser: async raw => { launch = new URL(raw); } });
  login = createLogin();
  const open = async () => {
    launch = undefined;
    assert.ok(await login.open() === undefined, "入口只应向操作系统交付票据");
    assert.ok(launch && launch.protocol === "http:" && launch.hostname === "127.0.0.1");
    assert.ok(launch.pathname === "/open" && !launch.search && /^[a-f0-9]{64}$/.test(launch.hash.slice(1)));
    assert.ok(!launch.href.includes(config.mgmtKey) && !launch.href.includes(config.apiKey));
    return launch.hash.slice(1);
  };
  // 冲突时不签发票据、不更换端口；占用解除后同一入口可恢复。
  const occupied = createServer();
  occupied.listen(port, "127.0.0.1");
  await once(occupied, "listening");
  try {
    await assert.rejects(login.open(), error => error.safeMessage?.includes(String(port)));
    assert.equal(launch, undefined);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  await Promise.all([login.listen(), login.listen(), login.listen()]);
  const ticket = await open();
  assert.equal(launch.port, String(port));
  const { origin } = launch;
  const request = (path, options = {}) => fetch(origin + path, { redirect: "manual", signal: AbortSignal.timeout(10_000), ...options });
  const exchange = (key, headers = {}) => request("/exchange", {
    method: "POST", headers: { "X-Login-Ticket": key, ...headers },
  });
  const landing = await request("/open");
  assert.equal(landing.status, 200);
  assert.equal(landing.headers.get("cache-control"), "no-store");
  assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
  assert.equal(landing.headers.get("x-frame-options"), "DENY");
  const html = await landing.text();
  assert.ok(!html.includes(ticket) && !html.includes(config.mgmtKey));
  const route = "/v0/management/request-log";
  const remote = "https://example.invalid";
  assert.equal((await request(route)).status, 401);
  assert.equal((await request("/exchange", { method: "OPTIONS", headers: {
    Origin: remote, "Access-Control-Request-Method": "POST",
  } })).status, 403);
  assert.equal((await exchange(ticket, { Origin: remote })).status, 403);
  assert.equal((await exchange(await open())).status, 403);
  const accepted = await exchange(ticket, { Origin: origin });
  assert.equal(accepted.status, 200);
  const { session } = await accepted.json();
  assert.ok(/^[a-f0-9]{64}$/.test(session) && ![ticket, config.mgmtKey, config.apiKey].includes(session));
  assert.equal((await exchange(ticket, { Origin: origin })).status, 403);

  const headers = { Authorization: "Bearer " + session };
  assert.equal((await request(route, { headers: { ...headers, Origin: remote } })).status, 403);
  assert.equal((await request(route, { method: "PUT", headers })).status, 403);
  assert.equal((await request("/v1/models", { headers })).status, 404);
  const coreUrl = `http://127.0.0.1:${config.port}${route}`;
  assert.equal((await fetch(coreUrl, { headers })).status, 401);
  const relay = await request(route, { headers });
  assert.equal(relay.status, 200);
  assert.equal(relay.headers.get("access-control-allow-origin"), null);
  const direct = await fetch(coreUrl, { headers: { Authorization: "Bearer " + config.mgmtKey } });
  assert.equal(direct.status, 200);
  assert.deepEqual(await relay.json(), await direct.json());
  const updated = await request("/v8/management/config/observability/logs/request-log", {
    method: "PUT", headers: { ...headers, Origin: origin, "Content-Type": "application/json" }, body: "true",
  });
  assert.equal(updated.status, 200);
  assert.equal((await (await request(route, { headers })).json())["request-log"], true);
  const panel = await request("/management.html");
  const panelHtml = await panel.text();
  assert.equal(panel.status, 200);
  assert.ok(![ticket, session, config.mgmtKey, config.apiKey].some(value => panelHtml.includes(value)));

  const expiring = await open();
  const now = Date.now();
  const clock = t.mock.method(Date, "now", () => now + 61_000);
  try {
    assert.equal((await exchange(expiring, { Origin: origin })).status, 403);
    clock.mock.mockImplementation(() => now + 31 * 60_000);
    assert.equal((await request(route, { headers })).status, 401);
  } finally { clock.mock.restore(); }
  const second = await exchange(await open(), { Origin: origin });
  const other = { Authorization: "Bearer " + (await second.json()).session };
  assert.equal((await request("/logout", { method: "POST", headers: other })).status, 403);
  assert.equal((await request("/logout", { method: "POST", headers: { ...other, Origin: remote } })).status, 403);
  assert.equal((await request("/logout", { method: "POST", headers: { ...other, Origin: origin } })).status, 204);
  assert.equal((await request(route, { headers: other })).status, 401);
  assert.equal((await request(route, { headers })).status, 200, "其他标签页的独立会话仍然有效");
  login.close();
  await assert.rejects(login.listen(), /会话已关闭/);
  await assert.rejects(request(route, { headers }), TypeError);
  login = createLogin();
  await open();
  assert.equal(launch.origin, origin);
  assert.equal((await request(route, { headers })).status, 401);
});

test("连接器授权元数据端点使按钮常驻并指向免密管理页", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-connector-oauth-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const config = await loadConfig({
    pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))),
    env: { BRIDGE_DATA_DIR: join(root, "data"), BRIDGE_PORT: String(await unusedPort()) },
  });
  const port = await unusedPort();
  const login = createManagementLogin(config, { port, launchBrowser: async () => {} });
  t.after(() => login.close());
  await login.listen();
  const origin = `http://127.0.0.1:${port}`;
  // 宿主探测收到 401 与受保护资源元数据，连接器进入待授权，按钮常驻。
  const probe = await fetch(origin + "/mcp", { method: "POST" });
  assert.equal(probe.status, 401);
  assert.match(probe.headers.get("www-authenticate"), /resource_metadata="[^"]+oauth-protected-resource"$/);
  const resource = await (await fetch(origin + "/.well-known/oauth-protected-resource")).json();
  assert.equal(resource.resource, origin + "/mcp");
  assert.deepEqual(resource.authorization_servers, [origin]);
  // 宿主按 RFC 9728 以资源路径后缀构造元数据地址，后缀拼法必须同答。
  const suffixed = await fetch(origin + "/.well-known/oauth-protected-resource/mcp");
  assert.equal(suffixed.status, 200);
  assert.equal((await suffixed.json()).resource, origin + "/mcp");
  const serverMeta = await (await fetch(origin + "/.well-known/oauth-authorization-server")).json();
  assert.equal(serverMeta.authorization_endpoint, origin + "/oauth/authorize");
  assert.equal(serverMeta.token_endpoint, origin + "/oauth/token");
  // 授权端点只重定向到免密落地页，不在浏览器内完成回调。
  const redirect = new URL(origin + "/callback");
  redirect.port = String(await unusedPort());
  const authorize = await fetch(serverMeta.authorization_endpoint + `?redirect_uri=${encodeURIComponent(redirect)}&state=abc`, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const location = new URL(authorize.headers.get("location"));
  assert.equal(location.origin, origin);
  assert.equal(location.pathname, "/open");
  assert.match(location.hash, /^#[a-f0-9]{64}$/);
  // 外部重定向地址被拒绝，防止票据落地页被导向外部站点。
  const external = await fetch(serverMeta.authorization_endpoint + "?redirect_uri=https://example.com/cb", { redirect: "manual" });
  assert.equal(external.status, 400);
  // 令牌端点按无效授权统一拒绝，连接器维持待授权。
  const token = await fetch(serverMeta.token_endpoint, { method: "POST", body: "grant_type=authorization_code" });
  assert.equal(token.status, 400);
  assert.equal((await token.json()).error, "invalid_grant");
  // 动态注册响应回显 redirect_uris，宿主 SDK 据此完成客户端登记。
  const registered = await fetch(serverMeta.registration_endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect.href], token_endpoint_auth_method: "none" }),
  });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  assert.match(client.client_id, /^qoder-connector-[a-f0-9]{16}$/);
  assert.deepEqual(client.redirect_uris, [redirect.href]);
});
