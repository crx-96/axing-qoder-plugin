import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpTurn, validateAcpRequest } from "../server/acp-turn.mjs";
import { createAcpService } from "../server/acp-service.mjs";
import { configureAcpProvider } from "../server/acp-provider.mjs";
import { disableGoogleAuthFiles, disableGoogleCredentials, blockedGoogleManagement } from "../server/google-policy.mjs";
import { parseConfigYaml } from "../server/config-yaml.mjs";

const request = () => ({ model: "acp/gemini-test", messages: [{ role: "system", content: "User constraints remain binding." }, { role: "user", content: "Inspect two files." }],
  tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] });
class FakeConnection {
  static instances = [];
  constructor(_runtime, handlers) { this.handlers = handlers; FakeConnection.instances.push(this); }
  async initialize() { return { agentInfo: { name: "antigravity-acp", version: "1.5.0" }, authMethods: [{ id: "oauth-personal" }] }; }
  async call(method, params) {
    if (method === "session/new") {
      this.session = "s-" + FakeConnection.instances.indexOf(this); this.servers = params.mcpServers;
      assert.deepEqual(params._meta.antigravity.enabledTools, []);
      this.instructions = params._meta.antigravity.systemPrompt?.append;
      return { sessionId: this.session, configOptions: [{ id: "model", category: "model", options: [{ value: "gemini-test", name: "Gemini test" }] }] };
    }
    if (method === "session/set_config_option" || method === "authenticate") return {};
    assert.equal(method, "session/prompt");
    assert.match(this.instructions, /User constraints remain binding/);
    assert.doesNotMatch(params.prompt[0].text, /User constraints remain binding/);
    if (!this.servers.length) {
      this.handlers.onUpdate?.({ sessionId: this.session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } });
      return { stopReason: "end_turn" };
    }
    const server = this.servers[0];
    const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]));
    const permission = this.handlers.onPermission({ sessionId: this.session, toolCall: { title: "Run read_file?" }, options: [{ kind: "allow_once", optionId: "once" }] });
    assert.equal(permission.outcome.optionId, "once");
    assert.equal(this.handlers.onPermission({ sessionId: this.session, toolCall: { title: "Run terminal?" }, options: [{ kind: "allow_once", optionId: "once" }] }).outcome.outcome, "cancelled");
    const results = await Promise.all(["a", "b"].map(async (path, index) => {
      const response = await fetch(server.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params: { name: "read_file", arguments: { path } } }) });
      return response.json();
    }));
    this.results = results;
    this.handlers.onUpdate({ sessionId: this.session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } });
    return { stopReason: "end_turn" };
  }
  notify() {}
  async close() { this.closed = true; }
}

test("ACP tools suspend the same prompt and resume once with unordered results", async t => {
  const input = request();
  const turn = new AcpTurn({}, input, tmpdir(), { Connection: FakeConnection });
  t.after(() => turn.close());
  await turn.start();
  const first = await turn.round(AbortSignal.timeout(5000));
  assert.equal(first.finish_reason, "tool_calls");
  assert.equal(first.message.tool_calls.length, 2);
  const results = [...first.message.tool_calls].reverse().map(call => ({ role: "tool", tool_call_id: call.id, content: "approved result" }));
  const follow = { ...input, messages: [...input.messages, first.message, ...results] };
  assert.equal(turn.accepts(follow), true);
  const emptyContentFollow = { ...follow, messages: [...input.messages, { ...first.message, content: "" }, ...results] };
  assert.equal(turn.accepts(emptyContentFollow), true, "流式客户端将无文本工具消息拼成空字符串时仍可续接");
  assert.equal(turn.accepts({ ...follow, messages: [...input.messages, { ...first.message, content: "changed" }, ...results] }), false);
  assert.equal(turn.accepts({ ...follow, model: "acp/other" }), false);
  assert.equal(turn.accepts({ ...follow, messages: [...input.messages, first.message, results[0], results[0]] }), false);
  turn.resume(emptyContentFollow);
  assert.equal(turn.accepts(emptyContentFollow), false);
  const final = await turn.round(AbortSignal.timeout(5000));
  assert.equal(final.message.content, "done");
  assert.equal(final.finish_reason, "stop");
  assert.equal(FakeConnection.instances.at(-1).results[0].result.content[0].text, "approved result");
});

test("identical conversations do not share parked tool IDs", async t => {
  const a = new AcpTurn({}, request(), tmpdir(), { Connection: FakeConnection });
  const b = new AcpTurn({}, request(), tmpdir(), { Connection: FakeConnection });
  t.after(async () => { await a.close(); await b.close(); });
  await Promise.all([a.start(), b.start()]);
  const [one, two] = await Promise.all([a.round(AbortSignal.timeout(5000)), b.round(AbortSignal.timeout(5000))]);
  assert.notEqual(one.message.tool_calls[0].id, two.message.tool_calls[0].id);
  const result = { ...request(), messages: [...request().messages, one.message, ...one.message.tool_calls.map(call => ({ role: "tool", tool_call_id: call.id, content: "denied" }))] };
  assert.equal(b.accepts(result), false);
});

test("ACP service exposes authenticated models and never falls back when unavailable", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "qoder-acp-service-"));
  let auth, endpoint;
  const service = createAcpService({ dataDir }, { prepareRuntime: async () => ({ path: "fake", source: "host", version: "1.5.0" }), verifyRuntime: async () => {}, Connection: FakeConnection,
    Turn: class extends AcpTurn { constructor(runtime, input, cwd, options) { super(runtime, input, cwd, { ...options, Connection: FakeConnection }); } },
    onModels: async (_models, url, key) => { endpoint = url; auth = "Bearer " + key; } });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  await service.listen(); await service.connect();
  const headers = { Authorization: auth, "Content-Type": "application/json" };
  const controlUrl = endpoint.replace(/\/v1$/, "/control/");
  assert.equal((await fetch(controlUrl + "stop", { method: "POST", headers, body: "{}" })).status, 401);
  const controlHeaders = { Authorization: "Bearer " + service.controlEndpoint.key, "Content-Type": "application/json" };
  assert.equal((await fetch(endpoint + "/models", { headers: controlHeaders })).status, 401);
  const controlStatus = await fetch(controlUrl + "status", { headers: controlHeaders });
  assert.equal((await controlStatus.json()).state, "ready");
  assert.equal((await fetch(controlUrl + "authenticate", { method: "POST", headers: controlHeaders, body: '{"methodId":"invalid"}' })).status, 400);
  assert.equal((await fetch(controlUrl + "stop", { method: "POST", headers: controlHeaders, body: " ".repeat(4097) })).status, 400);
  assert.equal(service.status().state, "ready");
  assert.equal((await fetch(endpoint + "/models")).status, 401);
  assert.equal((await (await fetch(endpoint + "/models", { headers })).json()).data[0].id, "acp/gemini-test");
  const input = request(); delete input.tools;
  const response = await fetch(endpoint + "/chat/completions", { method: "POST", headers, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "answer");
  await service.stop();
  assert.equal((await fetch(endpoint + "/chat/completions", { method: "POST", headers, body: JSON.stringify(input) })).status, 503);
});

test("provider configuration replaces only the managed entry and supports flow lists", () => {
  for (const before of ["config-version: 8\n", 'api-keys: {openai-compatibility: [{name: other, base-url: "https://example.invalid", keys: []}]}\n']) {
    const first = configureAcpProvider(before, [{ id: "acp/a", name: "A" }], "http://127.0.0.1:1/v1", "private");
    const second = configureAcpProvider(first, [{ id: "acp/b", name: "B" }], "http://127.0.0.1:2/v1", "private");
    assert.equal(second.includes("acp/a"), false); assert.equal(second.includes("acp/b"), true);
    assert.equal((second.match(/antigravity-acp/g) ?? []).length, 1);
    parseConfigYaml(second);
    if (before.includes("other")) assert.match(second, /other/);
  }
});

test("legacy Google credentials are disabled without deleting their data", async t => {
  const authDir = await mkdtemp(join(tmpdir(), "qoder-google-migration-"));
  t.after(() => rm(authDir, { recursive: true, force: true }));
  await writeFile(join(authDir, "google.json"), JSON.stringify({ type: "antigravity", access_token: "synthetic", disabled: false }));
  await writeFile(join(authDir, "codex.json"), JSON.stringify({ type: "codex", access_token: "synthetic" }));
  assert.equal(await disableGoogleAuthFiles({ authDir }, async (path, text) => writeFile(path, text)), 1);
  const google = JSON.parse(await readFile(join(authDir, "google.json")));
  assert.equal(google.disabled, true); assert.equal(google.access_token, "synthetic");
  assert.equal(JSON.parse(await readFile(join(authDir, "codex.json"))).disabled, undefined);
  assert.equal(await disableGoogleAuthFiles({ authDir }, async () => assert.fail("must be idempotent")), 0);
});

test("Google migration uses the documented management disable API", async () => {
  const calls = [];
  await disableGoogleCredentials({}, async (_config, path, options) => {
    calls.push({ path, options });
    if (path.endsWith("auth-files")) return { status: 200, text: JSON.stringify({ files: [{ name: "google", provider: "gemini", disabled: false }, { name: "codex", provider: "codex" }] }) };
    assert.equal(options.body.disabled, true); return { status: 200 };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.body.name, "google");
  assert.equal(blockedGoogleManagement("/v8/management/oauth/auth-url?provider=antigravity", "GET"), true);
  assert.equal(blockedGoogleManagement("/v8/management/oauth/auth-url?provider=codex", "GET"), false);
});

test("unsupported parameters fail explicitly rather than appearing to work", () => {
  for (const field of ["temperature", "max_tokens", "stop"]) assert.throws(() => validateAcpRequest({ ...request(), [field]: 1 }), { code: "ACP_PARAMETER_UNSUPPORTED" });
  assert.throws(() => validateAcpRequest({ ...request(), model: "gemini-test" }), { code: "ACP_INVALID_REQUEST" });
});
