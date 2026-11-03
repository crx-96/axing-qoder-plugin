import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../bridge/config.mjs";
import { ensureRunning, shutdownOwnedBridges } from "../bridge/bridge-process.mjs";
import { createManagementLogin } from "../bridge/management-login.mjs";
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
  login = createManagementLogin(config, { launchBrowser: async raw => { launch = new URL(raw); } });
  const open = async () => {
    launch = undefined;
    assert.ok(await login.open() === undefined, "入口只应向操作系统交付票据");
    assert.ok(launch && launch.protocol === "http:" && launch.hostname === "127.0.0.1");
    assert.ok(launch.pathname === "/open" && !launch.search && /^[a-f0-9]{64}$/.test(launch.hash.slice(1)));
    assert.ok(!launch.href.includes(config.mgmtKey) && !launch.href.includes(config.apiKey));
    return launch.hash.slice(1);
  };
  const ticket = await open();
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
  await assert.rejects(request(route, { headers }), TypeError);
});
