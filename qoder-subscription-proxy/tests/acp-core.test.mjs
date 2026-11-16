import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../server/config.mjs";
import { ensureRunning, stopBridge } from "../server/supervisor.mjs";
import { createAcpService, getAcpService } from "../server/acp-service.mjs";
import { AcpTurn } from "../server/acp-turn.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

class MockAgent {
  constructor(_runtime, handlers = {}) { this.handlers = handlers; this.session = randomUUID(); }
  async initialize() { return {}; }
  async call(method, params) {
    if (method === "session/new") {
      this.servers = params.mcpServers;
      return { sessionId: this.session, configOptions: [{ category: "model", id: "model", options: [{ value: "gemini-fixture", name: "Fixture" }] }] };
    }
    if (method === "session/set_config_option") return {};
    assert.equal(method, "session/prompt");
    const emit = text => this.handlers.onUpdate({ sessionId: this.session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    if (!this.servers.length) { emit("fixture complete"); return { stopReason: "end_turn" }; }
    if (!params.prompt[0].text.includes("no prefix")) emit("need a file");
    const server = this.servers[0];
    const headers = Object.fromEntries(server.headers.map(item => [item.name, item.value]));
    const response = await fetch(server.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "中文路径.txt" } } }) });
    const result = await response.json();
    emit("received " + result.result.content[0].text);
    return { stopReason: "end_turn" };
  }
  notify() {}
  async close() {}
}

test("真实核心完整转接 ACP 模型、流式文本和跨请求工具结果", { skip: nativeCoreSkip, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "qoder-acp-core-"));
  const binary = await copyTestCore(join(root, process.platform === "win32" ? "core.exe" : "core"));
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = await loadConfig({ pluginRoot, env: { BRIDGE_DATA_DIR: root, BRIDGE_PORT: String(port), BRIDGE_BIN: binary } });
  let adapter;
  t.after(async () => { await adapter?.close(); await stopBridge(config); await rm(root, { recursive: true, force: true }); });
  await ensureRunning(config);
  await getAcpService(config).close();
  adapter = createAcpService(config, {
    prepareRuntime: async () => ({ path: "fixture", version: "1.5.0", source: "host" }), verifyRuntime: async () => {}, Connection: MockAgent,
    Turn: class extends AcpTurn { constructor(runtime, request, cwd, options) { super(runtime, request, cwd, { ...options, Connection: MockAgent }); } },
    onModels: async () => writeFile(config.configPath, adapter.configure(await readFile(config.configPath, "utf8"))),
  });
  await adapter.listen(); await adapter.connect();
  const headers = { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json" };
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(config.endpoint + "/models", { headers });
    const data = await response.json();
    if (data.data?.some(model => model.id === "acp/gemini-fixture")) { ready = true; break; }
    await delay(100);
  }
  assert.equal(ready, true, "core must publish the managed ACP model");
  const send = async body => {
    const response = await fetch(config.endpoint + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return body.stream ? text : JSON.parse(text);
  };
  const stream = await send({ model: "acp/gemini-fixture", stream: true, messages: [{ role: "user", content: "text only" }] });
  assert.match(stream, /fixture complete/); assert.match(stream, /\[DONE\]/);
  for (const streaming of [false, true]) for (const text of ["read with prefix", "no prefix"]) {
    const input = { model: "acp/gemini-fixture", stream: streaming, messages: [{ role: "user", content: text }], tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] };
    const first = await send(input);
    let message;
    if (streaming) {
      const chunks = first.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      assert.ok(chunks.some(chunk => chunk.choices[0].finish_reason === "tool_calls"));
      message = { role: "assistant", content: "", tool_calls: [] };
      for (const chunk of chunks) {
        const delta = chunk.choices[0].delta;
        message.content += delta.content ?? "";
        for (const call of delta.tool_calls ?? []) {
          const target = message.tool_calls[call.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
          if (call.id) target.id = call.id;
          target.function.name += call.function?.name ?? "";
          target.function.arguments += call.function?.arguments ?? "";
        }
      }
    } else {
      assert.equal(first.choices[0].finish_reason, "tool_calls");
      message = first.choices[0].message;
    }
    const tool = message.tool_calls[0];
    assert.equal(JSON.parse(tool.function.arguments).path, "中文路径.txt");
    const second = await send({ ...input, messages: [...input.messages, message, { role: "tool", tool_call_id: tool.id, content: "synthetic tool result" }] });
    if (streaming) { assert.match(second, /received synthetic tool result/); assert.match(second, /\[DONE\]/); }
    else assert.equal(second.choices[0].message.content, "received synthetic tool result");
  }
  await adapter.stop();
  const response = await fetch(config.endpoint + "/chat/completions", { method: "POST", headers, body: JSON.stringify({ model: "acp/gemini-fixture", messages: [{ role: "user", content: "no fallback" }] }) });
  assert.notEqual(response.status, 200); await response.text();
});

test("另一进程的管理网关可以查询和停止 ACP，拒绝失效归属与配置绕过", { skip: nativeCoreSkip, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "qoder-acp-shared-"));
  const binary = await copyTestCore(join(root, process.platform === "win32" ? "core.exe" : "core"));
  const reserve = async () => {
    const server = http.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
  };
  const port = await reserve(), managementPort = await reserve();
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const env = { ...process.env, BRIDGE_DATA_DIR: root, BRIDGE_PORT: String(port), BRIDGE_BIN: binary };
  const config = await loadConfig({ pluginRoot, env });
  t.after(async () => { await stopBridge(config); await rm(root, { recursive: true, force: true }); });
  await ensureRunning(config);
  const script = `
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    import { loadConfig } from ${JSON.stringify(new URL("../server/config.mjs", import.meta.url).href)};
    import { getAcpService } from ${JSON.stringify(new URL("../server/acp-service.mjs", import.meta.url).href)};
    import { requestAcpControl } from ${JSON.stringify(new URL("../server/supervisor.mjs", import.meta.url).href)};
    import { createManagementLogin } from ${JSON.stringify(new URL("../server/management-gateway.mjs", import.meta.url).href)};
    const config = await loadConfig({ pluginRoot: ${JSON.stringify(pluginRoot)} });
    assert.equal(getAcpService(config), undefined);
    let opened;
    const gateway = createManagementLogin(config, { port: ${managementPort}, launchBrowser: async url => { opened = url; } });
    const original = await readFile(config.pidPath, 'utf8');
    try {
      await gateway.open();
      const url = new URL(opened);
      const exchange = await fetch(url.origin + '/exchange', { method: 'POST', headers: { Origin: url.origin, 'X-Login-Ticket': url.hash.slice(1) } });
      const { session } = await exchange.json();
      const headers = { Origin: url.origin, Authorization: 'Bearer ' + session, 'Content-Type': 'application/json' };
      const status = await fetch(url.origin + '/acp/status', { headers });
      assert.equal(status.status, 200); assert.equal((await status.json()).state, 'not_connected');
      for (const path of ['/v8/management/config', '/v0/management/config.yaml', '/v8/management/%63onfig/yaml']) {
        const denied = await fetch(url.origin + path, { method: 'PUT', headers, body: '{}' });
        assert.equal(denied.status, 409); await denied.text();
      }
      const legacy = await fetch(url.origin + '/v8/management/openai-compatibility', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: 'legacy', models: [{ name: 'gemini-test' }] }) });
      assert.equal(legacy.status, 409); await legacy.text();
      const stopped = await fetch(url.origin + '/acp/stop', { method: 'POST', headers, body: '{}' });
      assert.equal(stopped.status, 200); assert.equal((await stopped.json()).state, 'stopped');
      const record = JSON.parse(original);
      record.acp.owner.creationDate = 'stale';
      await writeFile(config.pidPath, JSON.stringify(record));
      await assert.rejects(requestAcpControl(config, 'status'), { code: 'BRIDGE_NOT_READY' });
      process.stdout.write('shared-acp-ok');
    } finally { await writeFile(config.pidPath, original); gateway.close(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], { env, windowsHide: true, timeout: 60000, maxBuffer: 65536 });
  assert.equal(stdout, "shared-acp-ok");
  assert.equal(getAcpService(config).status().state, "stopped");
});
