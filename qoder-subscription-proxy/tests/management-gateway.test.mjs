import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.mjs";
import { ensureRunning, shutdownOwnedBridges, stopBridge } from "../server/supervisor.mjs";
import { openManagement } from "../server/management-gateway.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("管理按钮只向已核验原生端口交付登录链接，不返回密钥", async () => {
  const config = { managementPort: 21002, managementUrl: "http://127.0.0.1:21002/", mgmtKey: "a".repeat(64) };
  const calls = [];
  const result = await openManagement(config, {
    loginKey: async value => { assert.equal(value, config); calls.push("verify"); return "instance-only-key"; },
    launchBrowser: async url => { calls.push("browser"); const target = new URL(url); assert.equal(target.origin, "http://127.0.0.1:21002"); assert.equal(target.searchParams.get("k"), "instance-only-key"); },
  });
  assert.equal(result, undefined);
  assert.deepEqual(calls, ["verify", "browser"]);
});

test("身份不可确认或请求取消时不开浏览器", async () => {
  let opened = false;
  const config = { managementPort: 1, managementUrl: "http://127.0.0.1:1/", mgmtKey: "a".repeat(64) };
  await assert.rejects(openManagement(config, { loginKey: async () => { throw Error("not-owned"); }, launchBrowser: async () => { opened = true; } }));
  await assert.rejects(openManagement(config, { signal: AbortSignal.abort(), launchBrowser: async () => { opened = true; } }));
  assert.equal(opened, false);
});

test("真实Magpie原生管理页认证、清除URL、错误密钥及跨来源防护", { skip: nativeCoreSkip, timeout: 100_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "magpie-management-"));
  t.after(async () => {
    await shutdownOwnedBridges();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await mkdir(join(root, "bin"));
  const binary = await copyTestCore(join(root, "bin", process.platform === "win32" ? "isolated.exe" : "isolated"));
  const config = await loadConfig({ pluginRoot: fileURLToPath(new URL("../", import.meta.url)), env: {
    BRIDGE_DATA_DIR: join(root, "data"), BRIDGE_BIN: binary,
    BRIDGE_PORT: String(await unusedPort()), BRIDGE_MANAGEMENT_PORT: String(await unusedPort()),
  } });
  assert.equal((await ensureRunning(config)).ready, true);
  let url;
  await openManagement(config, { launchBrowser: async value => { url = value; } });
  const request = (target, options = {}) => fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10000), ...options });
  assert.equal((await request(config.managementUrl)).status, 401);
  const login = await request(url);
  assert.ok([302, 303].includes(login.status));
  assert.equal(login.headers.get("location"), "/");
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/i);
  const page = await request(config.managementUrl, { headers: { Cookie: cookie.split(";", 1)[0] } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /magpie/i);
  assert.equal((await request(config.managementUrl + "?k=" + "b".repeat(64))).status, 401);
  const cross = await request(config.managementUrl + "api/settings", { method: "POST", headers: {
    Cookie: cookie.split(";", 1)[0], Origin: "https://example.invalid", "Content-Type": "application/json",
  }, body: "{}" });
  assert.equal(cross.status, 403);
  const firstKey = new URL(url).searchParams.get("k");
  assert.ok(firstKey && firstKey !== config.mgmtKey);
  assert.ok(!(await readFile(join(config.dataDir, "bridge.log"), "utf8")).includes(firstKey));
  assert.equal((await stopBridge(config)).stopped, true);
  assert.equal((await ensureRunning(config)).ready, true);
  assert.equal((await request(url)).status, 401);
  assert.equal((await request(config.managementUrl, { headers: { Cookie: cookie.split(";", 1)[0] } })).status, 401);
  await openManagement(config, { launchBrowser: async value => { url = value; } });
  assert.ok(firstKey !== new URL(url).searchParams.get("k"));
  assert.ok([302, 303].includes((await request(url)).status));
});
