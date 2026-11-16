import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AcpTurn } from "../server/acp-turn.mjs";
import { createAcpService } from "../server/acp-service.mjs";
import { readAcpModels } from "../server/acp-provider.mjs";
import { parseConfigYaml } from "../server/config-yaml.mjs";

const input = tools => ({ model: "acp/fixture", messages: [{ role: "user", content: "test" }], ...(tools ? { tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] } : {}) });
class Agent {
  static constructed = 0;
  static hold = false;
  constructor(_runtime, handlers = {}) { Agent.constructed++; this.handlers = handlers; this.id = randomUUID(); }
  async initialize() { return {}; }
  async call(method) {
    if (method === "session/new") return { sessionId: this.id, configOptions: [{ id: "model", category: "model", options: [{ value: "fixture", name: "Fixture" }] }] };
    if (method === "session/set_config_option") return {};
    assert.equal(method, "session/prompt");
    if (Agent.hold) return new Promise((_resolve, reject) => { this.reject = reject; });
    this.handlers.onUpdate({ sessionId: this.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ready" } } });
    return { stopReason: "end_turn" };
  }
  notify() {}
  async close() { this.reject?.(Error("closed")); }
}
const Turn = class extends AcpTurn { constructor(runtime, request, cwd, options) { super(runtime, request, cwd, { ...options, Connection: Agent }); } };

async function serviceFixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "qoder-acp-lifecycle-"));
  const service = createAcpService({ dataDir }, { prepareRuntime: async () => ({ path: "mock", version: "1.5.0", source: "host" }), verifyRuntime: async () => {}, Connection: Agent, Turn, ...options });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); Agent.hold = false; });
  await service.listen();
  const parsed = parseConfigYaml(service.configure("config-version: 8\n"));
  const key = parsed.values.get('["api-keys","openai-compatibility",0,"keys",0,"api-key"]');
  const send = body => fetch(service.endpoint + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { service, send };
}

test("关闭正在启动的工具桥，不会随后启动官方程序", { timeout: 5000 }, async () => {
  const before = Agent.constructed;
  const turn = new AcpTurn({}, input(true), tmpdir(), { Connection: Agent });
  const starting = turn.start();
  const rejected = assert.rejects(starting);
  await turn.close(); await rejected;
  assert.equal(Agent.constructed, before);
});

test("已保存目录在首次请求时惰性重连，主动停用后不自动恢复", { timeout: 15000 }, async t => {
  let preparations = 0;
  const { service, send } = await serviceFixture(t, { initialModels: [{ id: "fixture", name: "Fixture" }],
    prepareRuntime: async () => { preparations++; return { path: "mock", source: "host" }; } });
  assert.equal(service.status().state, "not_connected");
  assert.equal(preparations, 0);
  assert.deepEqual(readAcpModels(service.configure("config-version: 8\n")), [{ id: "fixture", name: "Fixture" }]);
  const response = await send(input(false));
  assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, "ready");
  assert.equal(preparations, 1);
  await service.stop();
  assert.deepEqual(readAcpModels(service.configure("config-version: 8\n")), []);
  const stopped = await send(input(false)); await stopped.text();
  assert.equal(stopped.status, 503); assert.equal(preparations, 1);
});

test("运行时校验尚未结束时停用，不得创建迟到回合", { timeout: 15000 }, async t => {
  let release, observed;
  const checking = new Promise(resolve => { observed = resolve; });
  const { service, send } = await serviceFixture(t, { verifyRuntime: () => new Promise(resolve => { release = resolve; observed(); }) });
  await service.connect();
  const before = Agent.constructed;
  const response = send(input(false));
  await checking; await service.stop(); release();
  const result = await response; await result.text();
  assert.equal(result.status, 503); assert.equal(Agent.constructed, before);
  assert.equal(service.status().activeTurns, 0);
});

test("并发校验完成后仍按容量原子准入，停止回收所有活动请求", { timeout: 15000 }, async t => {
  const releases = []; let checked;
  const checking = new Promise(resolve => { checked = resolve; });
  const { service, send } = await serviceFixture(t, { verifyRuntime: () => new Promise(resolve => { releases.push(resolve); if (releases.length === 5) checked(); }) });
  await service.connect(); Agent.hold = true;
  const pending = Array.from({ length: 5 }, () => send(input(true)));
  await checking; for (const release of releases) release();
  const rejected = await Promise.race(pending);
  assert.equal(rejected.status, 503);
  assert.equal(service.status().activeTurns, 4);
  await service.stop();
  for (const response of await Promise.all(pending)) await response.text();
  assert.equal(service.status().activeTurns, 0);
  assert.equal(service.status().state, "stopped");
});

test("停用会取消在途准备，旧准备完成也不会恢复 ready", { timeout: 15000 }, async t => {
  let entered;
  const preparing = new Promise(resolve => { entered = resolve; });
  const { service } = await serviceFixture(t, { prepareRuntime: (_config, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }); entered();
  }) });
  const connecting = service.connect(); const rejected = assert.rejects(connecting);
  await preparing; await service.stop(); await rejected;
  assert.equal(service.status().state, "stopped");
});
