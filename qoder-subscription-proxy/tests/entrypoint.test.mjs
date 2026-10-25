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

const entry = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "bridge-prepare-entry-"));
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const dataDir = join(directory, "data");
  if (extra.paused) {
    await mkdir(dataDir);
    await writeFile(join(dataDir, "bridge.paused"), "user stopped\n");
  }
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, BRIDGE_DATA_DIR: dataDir, BRIDGE_PORT: String(port),
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

test("配置错误不得返回MCP初始化成功，非零退出并且不泄露密钥", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { env: { BRIDGE_PORT: "invalid" } });
  const pending = f.request("initialize", { protocolVersion: "2025-06-18" });
  const response = await Promise.race([pending, f.exited.then(() => null)]);
  if (response) {
    assert.equal(response.error.code, -32001);
    assert.equal(response.result, undefined);
  }
  assert.ok(!f.messages.some((message) => message.result?.serverInfo));
  assert.equal((await f.exited)[0], 1);
  assert.doesNotMatch(JSON.stringify(f.messages) + f.errors(), /test-secret-do-not-return/);
  assert.match(f.errors(), /配置/);
  await assert.rejects(access(f.dataDir), { code: "ENOENT" });
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
  assert.ok(status.startupError);
  assert.equal(f.child.exitCode, null);
  assert.deepEqual((await f.request("ping")).result, {});
  assert.doesNotMatch(JSON.stringify(f.messages) + f.errors(), /test-secret-do-not-return/);
  f.child.stdin.end();
  assert.equal((await f.exited)[0], 0);
});

test("已暂停时允许管理MCP连接，不启动或下载核心", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { paused: true, env: { BRIDGE_BIN: process.execPath } });
  assert.equal((await f.request("initialize", { protocolVersion: "2025-06-18" })).result.serverInfo.version, "0.2.3");
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
