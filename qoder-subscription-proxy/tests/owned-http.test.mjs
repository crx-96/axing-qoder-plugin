import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { requestLocal } from "../server/local-http.mjs";
import { connectOwned } from "../server/owned-http.mjs";

async function linuxFixture(t, inspect) {
  const key = `ownedHttpTest${Math.random()}`;
  globalThis[key] = inspect;
  t.after(() => { delete globalThis[key]; });
  const source = (await readFile(new URL("../server/owned-http.mjs", import.meta.url), "utf8"))
    .replace('import { readFile, readdir, readlink } from "node:fs/promises";', `
      const readFile = async () => globalThis[${JSON.stringify(key)}].rows();
      const readdir = async () => globalThis[${JSON.stringify(key)}].fds();
      const readlink = async () => globalThis[${JSON.stringify(key)}].link();`);
  return import(`data:text/javascript;base64,${Buffer.from('const process = { platform: "linux" };\n' + source).toString("base64")}`);
}

function procRows(serverPort, clientPort, inode) {
  const endpoint = port => "0100007F:" + port.toString(16).toUpperCase().padStart(4, "0");
  return `0: ${endpoint(serverPort)} ${endpoint(clientPort)} 01 0 0 0 0 0 ${inode}`;
}

async function pendingAccept(t, { readyAfter = 3, wrongOwner = false, unreadable = false } = {}) {
  const f = await fixture(t);
  let reads = 0;
  const module = await linuxFixture(t, {
    async rows() {
      if (!f.connections.length) await once(f.server, "connection");
      reads++;
      if (unreadable) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return procRows(f.config.port, f.connections[0].socket.remotePort, reads >= readyAfter ? 123 : 0);
    },
    fds: () => ["10"],
    link: () => wrongOwner ? "socket:[456]" : "socket:[123]",
  });
  return { ...f, connect: module.connectOwned, reads: () => reads };
}

async function fixture(t) {
  const connections = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ socket: req.socket, port: req.socket.remotePort, authorization: req.headers.authorization, path: req.url });
    res.end("local fixture");
  });
  server.on("connection", (socket) => {
    const connection = { socket, bytes: 0, closed: new Promise(resolve => socket.once("close", resolve)) };
    connections.push(connection);
    socket.on("data", chunk => { connection.bytes += chunk.length; });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { config: { host: "127.0.0.1", port: server.address().port, apiKey: "fixture-only-key" }, server, connections, requests };
}

test("Linux accept 延迟时在同一连接等待 inode，成功前不发送凭据", async (t) => {
  const f = await pendingAccept(t);
  const socket = await f.connect(f.config, async () => { await delay(5); return { pid: process.pid, creationDate: "original" }; });
  t.after(() => socket.destroy());
  assert.ok(f.reads() >= 3);
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].bytes, 0);
  await requestLocal(f.config, "/v1/models", { socket, authenticated: true });
  assert.equal(f.requests.length, 1);
});

for (const mode of ["wrongOwner", "unreadable"]) {
  test(`Linux ${mode} 不允许重试放宽归属`, async (t) => {
    const f = await pendingAccept(t, { readyAfter: 1, [mode]: true });
    await assert.rejects(f.connect(f.config, async () => { await delay(5); return { pid: process.pid }; }), { code: "BRIDGE_NOT_READY" });
    assert.equal(f.reads(), 1);
    await f.connections[0].closed;
    assert.equal(f.connections[0].bytes, 0);
  });
}

for (const mode of ["cancel", "deadline", "identity"]) {
  test(`Linux 等待 accept 时 ${mode} 有界失败且不发送凭据`, { timeout: 12000 }, async (t) => {
    const f = await pendingAccept(t, { readyAfter: mode === "identity" ? 3 : Infinity });
    const controller = new AbortController();
    let identities = 0;
    const started = Date.now();
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 100) : null;
    t.after(() => clearTimeout(timer));
    await assert.rejects(f.connect(f.config, async () => {
      await delay(5);
      return { pid: process.pid, creationDate: ++identities === 1 ? "original" : "replaced" };
    }, controller.signal), mode === "cancel" ? { name: "AbortError" } : { code: "BRIDGE_NOT_READY" });
    assert.ok(f.reads() >= 2);
    const elapsed = Date.now() - started;
    if (mode === "deadline") assert.ok(elapsed >= 6500 && elapsed < 10000, `elapsed=${elapsed}`);
    else assert.ok(elapsed < 2000);
    await f.connections[0].closed;
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].bytes, 0);
  });
}

test("Linux 等待结束后身份复核挂起仍可取消，且复核晚返回不能授权", { timeout: 3000 }, async (t) => {
  const f = await pendingAccept(t);
  const controller = new AbortController();
  const checking = Promise.withResolvers();
  const identity = Promise.withResolvers();
  let calls = 0;
  const result = f.connect(f.config, () => {
    if (++calls === 1) return { pid: process.pid };
    checking.resolve();
    return identity.promise;
  }, controller.signal);
  await checking.promise;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  identity.resolve({ pid: process.pid });
  await f.connections[0].closed;
  assert.equal(f.connections[0].bytes, 0);
  assert.equal(f.connections.length, 1);
});

test("Linux 原生握手先于服务端 accept 仍可验证", { skip: process.platform !== "linux", timeout: 12000 }, async (t) => {
  const child = spawn(process.execPath, ["-e", `
    const net = require('node:net');
    const server = net.createServer(socket => socket.on('data', () => process.exit(2)));
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port) + '\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } });
  const [data] = await once(child.stdout, "data");
  const socket = await connectOwned({ host: "127.0.0.1", port: Number(data.toString().trim()) }, async () => ({ pid: child.pid }));
  socket.destroy();
});

test("端口上的进程与托管 PID 不符时，接收方得到零字节", { timeout: 15000 }, async (t) => {
  const { config, server, connections, requests } = await fixture(t);
  const unrelated = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  const exited = once(unrelated, "exit");
  t.after(async () => { unrelated.stdin.end(); await exited; });
  await once(unrelated, "spawn");
  const accepted = once(server, "connection");
  await assert.rejects(connectOwned(config, async () => ({ pid: unrelated.pid })), { code: "BRIDGE_NOT_READY" });
  await accepted;
  await connections[0].closed;
  assert.equal(connections[0].bytes, 0);
  assert.equal(requests.length, 0);
});

test("已验证 socket 承载唯一认证请求，禁止另建连接", { timeout: 15000 }, async (t) => {
  const { config, connections, requests } = await fixture(t);
  const socket = await connectOwned(config, async () => ({ pid: process.pid }));
  t.after(() => socket.destroy());
  const verifiedPort = socket.localPort;
  const reply = await requestLocal(config, "/v1/models", { socket, authenticated: true });
  assert.equal(reply.text, "local fixture");
  assert.equal(connections.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].socket, connections[0].socket);
  assert.equal(requests[0].port, verifiedPort);
  assert.equal(requests[0].authorization, "Bearer " + config.apiKey);
  assert.equal(requests[0].path, "/v1/models");
});

test("缺少身份、无效 PID 或已退出的 PID 均不得授权连接", { timeout: 15000 }, async (t) => {
  const { config, connections, requests } = await fixture(t);
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
  await once(child, "exit");
  for (const identity of [null, { pid: 0 }, { pid: String(process.pid) }, { pid: child.pid }]) {
    await assert.rejects(connectOwned(config, async () => identity), { code: "BRIDGE_NOT_READY" });
  }
  await Promise.all(connections.map(connection => connection.closed));
  assert.ok(connections.every(connection => connection.bytes === 0));
  assert.equal(requests.length, 0);
});

test("取消校验不会发送请求，校验途中已建立的 socket 随取消关闭", { timeout: 15000 }, async (t) => {
  const { config, server, connections, requests } = await fixture(t);
  const controller = new AbortController();
  const identifying = Promise.withResolvers();
  const identity = Promise.withResolvers();
  const accepted = once(server, "connection");
  const result = connectOwned(config, () => { identifying.resolve(); return identity.promise; }, controller.signal);
  await Promise.all([accepted, identifying.promise]);
  controller.abort();
  identity.resolve({ pid: process.pid });
  await assert.rejects(result, { name: "AbortError" });
  await connections[0].closed;
  await assert.rejects(connectOwned(config, () => assert.fail("预先取消不应查询身份"), controller.signal), { name: "AbortError" });
  assert.equal(connections.length, 1);
  assert.equal(connections[0].bytes, 0);
  assert.equal(requests.length, 0);
});
