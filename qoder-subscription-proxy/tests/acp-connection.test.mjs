import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpConnection } from "../server/acp-connection.mjs";

function fixture(runtime, env = {}) {
  let options;
  const sent = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 123; child.exitCode = null; child.signalCode = null;
  child.stdin.on("finish", () => { child.exitCode = 0; child.emit("exit", 0); });
  child.stdin.on("data", data => {
    const message = JSON.parse(data.toString()); sent.push(message);
    if (message.method === "initialize") child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.5.0" }, agentCapabilities: { mcpCapabilities: { http: true } },
    } }) + "\n");
  });
  const connection = new AcpConnection(runtime, { env, spawnProcess: (_path, _args, opts) => { options = opts; return child; } });
  return { connection, child, sent, options };
}

test("官方子进程隔离配置但如实报告客户端，不继承无关密钥", async () => {
  const runtime = { path: join(tmpdir(), "official", "agent.exe"), profilePath: join(tmpdir(), "plugin-profile") };
  const f = fixture(runtime, { PATH: "system-path", GEMINI_HOME: "unrelated-profile", GEMINI_API_KEY: "synthetic-google-key",
    ANTHROPIC_API_KEY: "synthetic-other-key", QODER_PERSONAL_ACCESS_TOKEN: "synthetic-host-token", NO_PROXY: "internal.invalid" });
  await f.connection.initialize();
  assert.equal(f.options.env.GEMINI_HOME, runtime.profilePath);
  assert.equal(f.options.env.GEMINI_API_KEY, undefined);
  assert.equal(f.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(f.options.env.QODER_PERSONAL_ACCESS_TOKEN, undefined);
  assert.match(f.options.env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(f.options.env.NO_PROXY, /internal\.invalid/);
  assert.equal(f.sent[0].params.clientInfo.name, "qoder-subscription-proxy");
  assert.deepEqual(f.sent[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  await f.connection.close();
});

test("只有显式 API Key 认证才向官方程序提供对应环境密钥", async () => {
  const f = fixture({ path: join(tmpdir(), "agent.exe"), profilePath: join(tmpdir(), "profile"), authMethod: "gemini-api-key", proxyUrl: "direct" },
    { GEMINI_API_KEY: "synthetic-key", HTTP_PROXY: "http://proxy.invalid", https_proxy: "http://proxy.invalid" });
  await f.connection.initialize();
  assert.equal(f.options.env.GEMINI_API_KEY, "synthetic-key");
  assert.equal(f.options.env.HTTP_PROXY, ""); assert.equal(f.options.env.https_proxy, "");
  assert.doesNotMatch(JSON.stringify(f.sent), /synthetic-key/);
  await f.connection.close();
});

test("连接超时和关闭释放等待，不传出原始上游错误正文", async () => {
  const f = fixture({ path: join(tmpdir(), "agent.exe"), profilePath: join(tmpdir(), "profile") });
  await f.connection.initialize();
  await assert.rejects(f.connection.call("stall", {}, { timeoutMs: 5 }), { code: "ACP_TIMEOUT" });
  const denied = f.connection.call("denied", {});
  const id = f.sent.at(-1).id;
  f.child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "SYNTHETIC_SECRET_RESPONSE" } }) + "\n");
  await assert.rejects(denied, error => error.code === "ACP_REQUEST_FAILED" && !error.message.includes("SYNTHETIC_SECRET_RESPONSE"));
  const pending = f.connection.call("pending", {});
  const rejection = assert.rejects(pending, { code: "ACP_CLOSED" });
  await f.connection.close(); await rejection;
});

test("缺少专属配置目录时不启动任何官方进程", () => {
  let spawned = false;
  assert.throws(() => new AcpConnection({ path: "fake" }, { spawnProcess: () => { spawned = true; } }), { code: "ACP_CONFIG" });
  assert.equal(spawned, false);
});
