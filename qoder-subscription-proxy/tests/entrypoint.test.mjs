import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, access, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const entry = fileURLToPath(new URL("../server/mcp-server.mjs", import.meta.url));

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-prepare-entry-"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const managementPort = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const dataDir = join(directory, "data");
  if (extra.paused) {
    await mkdir(dataDir);
    await writeFile(join(dataDir, "bridge.paused"), "user stopped\n");
  }
  if (extra.invalidSettings) {
    await mkdir(join(dataDir, "magpie"), { recursive: true });
    await writeFile(join(dataDir, "magpie", "settings.json"), "{private-invalid-settings");
    // 已使用过的插件目录同时存在受管凭据；不能因为配置文件损坏就当成独立 Magpie。
    await writeFile(join(dataDir, "launcher-secrets.json"), JSON.stringify({ apiKey: "test-secret-do-not-return" }));
  }
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_PORT: String(port), BRIDGE_MANAGEMENT_PORT: String(managementPort),
      BRIDGE_HOST: "127.0.0.1", BRIDGE_MGMT_KEY: "123456", BRIDGE_API_KEY: "test-secret-do-not-return",
      BRIDGE_BIN: join(directory, "missing-core"), ...extra.env },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const exited = once(child, "exit");
  let buffer = "";
  let errors = "";
  let id = 0;
  const waiting = new Map();
  const messages = [];
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      messages.push(message);
      waiting.get(message.id)?.(message);
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  function request(method, params) {
    const next = ++id;
    const response = new Promise((resolve) => waiting.set(next, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) + "\n");
    return response;
  }
  return { child, exited, dataDir, request, messages, errors: () => errors };
}

test("配置错误时管理页仍可读取具体原因，核心操作受限且不泄露配置值", { timeout: 10000 }, async t => {
  const f = await fixture(t, { env: { BRIDGE_PORT: "secret-invalid-port" } });
  const capabilities = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };
  assert.ok((await f.request("initialize", { protocolVersion: "2025-06-18", capabilities })).result.serverInfo);
  for (const name of ["bridge_management_app", "bridge_status"]) {
    const status = JSON.parse((await f.request("tools/call", { name })).result.content[0].text);
    assert.equal(status.ready, false);
    assert.equal(status.preparing, false);
    assert.match(status.startupError, /BRIDGE_PORT.*65535/);
  }
  for (const name of ["bridge_start", "bridge_open_management", "bridge_stop", "subscription_generate_image"]) {
    const args = name === "subscription_generate_image" ? { prompt: "test" } : {};
    const response = await f.request("tools/call", { name, arguments: args });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /BRIDGE_PORT/);
  }
  assert.doesNotMatch(JSON.stringify(f.messages) + f.errors(), /test-secret-do-not-return|secret-invalid-port/);
  await assert.rejects(access(f.dataDir), { code: "ENOENT" });
});

test("修复本地配置后可在原连接重试，页面随后显示最新的启动原因", { timeout: 10000 }, async t => {
  const f = await fixture(t, { invalidSettings: true });
  await f.request("initialize", { protocolVersion: "2025-06-18" });
  const call = async name => (await f.request("tools/call", { name })).result.content[0].text;
  assert.match(JSON.parse(await call("bridge_status")).startupError, /settings.json.*JSON/);
  await rm(join(f.dataDir, "magpie", "settings.json"));
  assert.match(await call("bridge_start"), /BRIDGE_BIN/);
  const status = JSON.parse(await call("bridge_status"));
  assert.equal(status.core.state, "custom");
  assert.match(status.startupError, /BRIDGE_BIN/);
  assert.doesNotMatch(JSON.stringify(f.messages) + f.errors(), /private-invalid-settings/);
});

test("缺失自定义核心只导致后台启动失败，MCP仍可查询状态且不泄露密钥", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  assert.ok((await f.request("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo);
  let status;
  const deadline = Date.now() + 5000;
  do {
    status = JSON.parse((await f.request("tools/call", { name: "bridge_status" })).result.content[0].text);
    if (status.startupError) break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(status.ready, false);
  assert.match(status.startupError, /BRIDGE_BIN.*执行权限/);
  assert.equal(status.preparing, false);
  await f.request("tools/call", { name: "bridge_start" });
  const retried = JSON.parse((await f.request("tools/call", { name: "bridge_status" })).result.content[0].text);
  assert.match(retried.startupError, /BRIDGE_BIN.*执行权限/);
  assert.equal(f.child.exitCode, null);
  assert.deepEqual((await f.request("ping")).result, {});
  assert.doesNotMatch(JSON.stringify(f.messages) + f.errors(), /test-secret-do-not-return/);
  f.child.stdin.end();
  assert.equal((await f.exited)[0], 0);
});

test("已暂停时允许管理MCP连接，不启动或下载核心", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { paused: true, env: { BRIDGE_BIN: process.execPath } });
  assert.equal((await f.request("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.version, "2.0.3");
  const status = JSON.parse((await f.request("tools/call", { name: "bridge_status", arguments: {} })).result.content[0].text);
  assert.equal(status.ready, false);
  assert.equal(status.autoRecoveryPaused, true);
  assert.equal(status.core.state, "custom");
  await assert.rejects(access(join(f.dataDir, "config.yaml")), { code: "ENOENT" });
  await assert.rejects(access(join(f.dataDir, "runtimes")), { code: "ENOENT" });
  f.child.stdin.end();
  assert.equal((await f.exited)[0], 0, f.errors());
});

test("已暂停且自定义核心缺失时仍可连接MCP，不尝试自动启动", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { paused: true });
  assert.ok((await f.request("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo);
  const status = JSON.parse((await f.request("tools/call", { name: "bridge_status" })).result.content[0].text);
  assert.equal(status.autoRecoveryPaused, true);
  assert.equal(status.startupError, undefined);
  await assert.rejects(access(join(f.dataDir, "config.yaml")), { code: "ENOENT" });
});
