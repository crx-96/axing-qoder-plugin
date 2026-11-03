import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { requestLocal } from "../server/local-http.mjs";
import { connectOwned } from "../server/owned-http.mjs";

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
