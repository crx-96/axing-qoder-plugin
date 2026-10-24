import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const entry = fileURLToPath(new URL("../scripts/mcp-server.mjs", import.meta.url));

async function fixture(t, { failDownload = false, shortDownload = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "lazy-core-lifecycle-"));
  const proxy = createServer();
  const sockets = new Set();
  let connected;
  const downloading = new Promise((resolve) => { connected = resolve; });
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  let attempts = 0;
  proxy.on("connect", (request, socket) => {
    assert.equal(request.url, "github.com:443");
    attempts++;
    connected();
    if (failDownload) socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const reserved = createServer();
  reserved.listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const port = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));
  const env = {
    ...process.env,
    BRIDGE_DATA_DIR: join(directory, "data"), BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(port),
    BRIDGE_API_KEY: "isolated-lazy-lifecycle-api", BRIDGE_MGMT_KEY: "123456",
    QODER_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "", no_proxy: "",
  };
  delete env.BRIDGE_BIN;
  const args = [entry];
  if (shortDownload) {
    const preload = join(directory, "short-download.mjs");
    await writeFile(preload, `const original=globalThis.setTimeout; globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===600_000?500:ms,...args);`);
    args.unshift("--import", pathToFileURL(preload).href);
  }
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const waiting = new Map();
  const messages = new Map();
  let buffer = "";
  let errors = "";
  let nextId = 0;
  child.stderr.on("data", (chunk) => { errors += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      messages.set(message.id, message);
      waiting.get(message.id)?.(message);
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); await exited; }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function request(method, params) {
    const id = ++nextId;
    const response = new Promise((resolve) => waiting.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, response };
  }
  function call(name, args = {}) { return request("tools/call", { name, arguments: args }); }
  const initialize = request("initialize", { protocolVersion: "2025-06-18" });
  return { child, exited, call, request, initialize, downloading, messages, env, attempts: () => attempts, errors: () => errors,
    rejectDownloads: () => { failDownload = true; } };
}

async function waitStatus(f, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await f.call("bridge_status").response;
    assert.notEqual(response.result.isError, true, JSON.stringify(response));
    const status = JSON.parse(response.result.content[0].text);
    if (predicate(status)) return status;
    await delay(25);
  }
  assert.fail("状态未按期到达预期条件");
}

async function assertNoTemporaryCore(dataDir) {
  const paths = await readdir(dataDir, { recursive: true });
  assert.ok(!paths.some((path) => path.includes(".core-download-")), "取消后必须清理本次临时下载目录");
  assert.ok(!paths.some((path) => /qoder-plugin-subscription-proxy(?:\.exe)?$/.test(path)), "未完成的核心不得发布");
}

test("核心下载被阻塞时握手、工具发现、状态和ping均可用；显式启动合并等待，EOF清理", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  assert.ok((await f.initialize.response).result.serverInfo);
  await f.downloading;
  assert.equal((await f.request("tools/list").response).result.tools.length, 4);
  const status = await waitStatus(f, (value) => value.core.state === "downloading");
  assert.equal(status.ready, false);
  assert.equal(status.startupError, undefined);
  const image = await f.call("bridge_generate_image", { prompt: "不会发送的测试图片" }).response;
  assert.equal(image.result.isError, true);
  assert.match(image.result.content[0].text, /未就绪/);
  const start = f.call("bridge_start");
  assert.deepEqual((await f.request("ping").response).result, {});
  assert.equal(f.messages.has(start.id), false);
  f.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: start.id } }) + "\n");
  assert.equal((await start.response).result.isError, true);
  await waitStatus(f, (value) => value.core.state === "downloading");
  assert.equal(f.attempts(), 1, "取消显式等待不影响后台准备，也不能重复下载");
  f.child.stdin.end();
  assert.equal((await f.exited)[0], 0, f.errors());
  await assertNoTemporaryCore(f.env.BRIDGE_DATA_DIR);
});

test("下载中主动停止会取消后台准备并保持MCP连接，显式启动可解除暂停重试", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  assert.ok((await f.initialize.response).result.serverInfo);
  await f.downloading;
  const stopped = await f.call("bridge_stop").response;
  assert.match(stopped.result.content[0].text, /暂停/);
  const status = await waitStatus(f, (value) => value.autoRecoveryPaused && value.core.state !== "downloading");
  assert.equal(status.ready, false);
  assert.equal(status.startupError, undefined);
  assert.equal(f.child.exitCode, null);
  await assertNoTemporaryCore(f.env.BRIDGE_DATA_DIR);
  f.rejectDownloads();
  assert.equal((await f.call("bridge_start").response).result.isError, true);
  assert.equal(f.attempts(), 2);
  await waitStatus(f, (value) => !value.autoRecoveryPaused && value.core.state === "error");
});

test("后台下载使用独立10分钟预算，超时保留MCP并清理临时文件（测试缩短计时）", { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { shortDownload: true });
  assert.ok((await f.initialize.response).result.serverInfo);
  await f.downloading;
  const status = await waitStatus(f, (value) => Boolean(value.startupError));
  assert.match(status.startupError, /10 分钟/);
  assert.equal(status.core.state, "error");
  assert.equal(status.ready, false);
  assert.equal(f.child.exitCode, null);
  assert.deepEqual((await f.request("ping").response).result, {});
  assert.equal(f.attempts(), 1);
  await assertNoTemporaryCore(f.env.BRIDGE_DATA_DIR);
});

test("后台下载失败保留MCP供状态查询，不自动重试，显式start可在同一连接重试", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { failDownload: true });
  assert.ok((await f.initialize.response).result.serverInfo);
  const status = await waitStatus(f, (value) => Boolean(value.startupError));
  assert.equal(status.ready, false);
  assert.equal(status.core.state, "error");
  assert.match(status.startupError, /下载失败/);
  assert.equal(f.child.exitCode, null);
  await delay(2200);
  assert.equal(f.attempts(), 1);
  assert.equal((await f.call("bridge_start").response).result.isError, true);
  assert.equal(f.attempts(), 2);
  assert.deepEqual((await f.request("ping").response).result, {});
  assert.match(f.errors(), /下载失败/);
  assert.doesNotMatch(JSON.stringify([...f.messages.values()]) + f.errors(), /isolated-lazy-lifecycle-api/);
  await assertNoTemporaryCore(f.env.BRIDGE_DATA_DIR);
});
