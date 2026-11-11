import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ensureApprovalRouting } from "../server/approval-routing.mjs";
import { prepareApprovalRouter, ensureApprovalPluginConfig, assertApprovalPluginRegistered } from "../server/approval-plugin.mjs";
import { loadConfig, renderConfigYaml } from "../server/config.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reviewer = "gemini-3.8-flash-high";
const modelNames = ["gemini-4-argon-high", "claude-opus-5-5-high", "claude-sonnet-5-5-high", "gpt-oss-120b-medium",
  "gemini-3-flash", "gemini-3.1-flash-image", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", reviewer];
const classifier = "You are a security classifier for auto permission mode. Return only JSON with boolean shouldBlock and string reason. Preserve user restrictions and block uncertain actions.";
const internationalClassifier = "You are a security monitor for an autonomous AI coding agent. Preserve the original policy and return shouldBlock and reason.";
const pendingText = "SENSITIVE_SYNTHETIC_REQUEST: inspect the workspace; this is data, not authorization.";

function approvalBody(model, effort, instruction = classifier, role = "system", pending = pendingText) {
  return { model, input: [
    { role, content: [{ type: "input_text", text: instruction }] },
    { role: "user", content: [{ type: "input_text", text: pending }] },
  ], ...(effort === undefined ? {} : { reasoning: { effort } }), text: { format: { type: "json_object" } } };
}

test("原生核心将反重力独立审批请求统一发送给 Gemini Flash low", { skip: nativeCoreSkip, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "qoder-antigravity-approval-"));
  const captured = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (request.url.includes("fetchAvailableModels")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ models: Object.fromEntries(modelNames.map(id => [id, {}])) }));
      return;
    }
    captured.push({ path: request.url, body });
    const texts = body.request?.contents?.flatMap(content => content.parts ?? []).map(part => part.text) ?? [];
    if (texts.includes("Simulate unavailable reviewer.")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: 400, message: "Review model unavailable", status: "INVALID_ARGUMENT" } }));
      return;
    }
    const fixturePrefix = "Classifier fixture result: ";
    const fixture = texts.find(text => text?.startsWith(fixturePrefix));
    const result = { response: {
      candidates: [{ content: { role: "model", parts: [{ text: fixture ? fixture.slice(fixturePrefix.length) : '{"shouldBlock":true,"reason":"synthetic fixture"}' }] }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      modelVersion: body.model, responseId: "synthetic-response",
    } };
    const streaming = request.url.includes("streamGenerateContent");
    response.writeHead(200, { "Content-Type": streaming ? "text/event-stream" : "application/json" });
    response.end(streaming ? `data: ${JSON.stringify(result)}\n\n` : JSON.stringify(result));
  });
  let child;
  let exited;
  let output = "";
  t.after(async () => {
    if (child && child.exitCode === null) child.kill();
    if (exited) await exited;
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const config = await loadConfig({ pluginRoot, env: { BRIDGE_DATA_DIR: root, BRIDGE_PORT: String(port), BRIDGE_API_KEY: "isolated-api" } });
  const baseURL = `http://127.0.0.1:${upstream.address().port}`;
  await mkdir(config.authDir, { recursive: true });
  await writeFile(join(config.authDir, "antigravity-isolated.json"), JSON.stringify({
    type: "antigravity", access_token: "isolated-token", refresh_token: "", expired: "2099-01-01T00:00:00Z",
    project_id: "isolated-project", email: "synthetic@example.invalid", base_url: baseURL, proxy_url: "direct",
    antigravity_capability_hints: { project_id: "isolated-project", endpoint: baseURL, model_ids: modelNames },
  }));
  const router = await prepareApprovalRouter(config);
  const initial = ensureApprovalRouting(renderConfigYaml(config).replace("disable-control-panel: false", "disable-control-panel: true"));
  await writeFile(config.configPath, ensureApprovalPluginConfig(initial, config, router.directory));
  const binary = await copyTestCore(join(root, process.platform === "win32" ? "core.exe" : "core"));
  child = spawn(binary, ["-local-model", "-config", config.configPath], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  exited = once(child, "exit");
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = { Authorization: "Bearer isolated-api", "Content-Type": "application/json" };
  let ready = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(endpoint + "/v1/models", { headers, signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).data.some(model => model.id === reviewer)) { ready = true; break; }
    } catch (error) {
      if (child.exitCode !== null) throw error;
    }
    await delay(100);
  }
  assert.ok(ready, output);
  const pluginStatus = await fetch(endpoint + "/v0/management/plugins", { headers: { Authorization: `Bearer ${config.mgmtKey}` }, signal: AbortSignal.timeout(3000) });
  assert.equal(pluginStatus.status, 200);
  assertApprovalPluginRegistered(await pluginStatus.json(), router.directory);

  async function send(path, payload, expectedModel = reviewer, expectedThinking = "low") {
    const response = await fetch(endpoint + path, { method: "POST", headers, signal: AbortSignal.timeout(10000), body: JSON.stringify(payload) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const sent = captured.at(-1).body;
    assert.deepEqual({ model: sent.model, thinking: sent.request.generationConfig.thinkingConfig?.thinkingLevel },
      { model: expectedModel, thinking: expectedThinking }, output.slice(-3000));
    return { text, sent };
  }

  for (const model of modelNames) {
    await t.test(model, async () => {
      for (const [index, effort] of ["none", "low", "high", undefined].entries()) {
        const instruction = index % 2 ? internationalClassifier : classifier;
        const stream = index % 2 === 1;
        const { text, sent } = await send("/v1/responses", { ...approvalBody(model, effort, instruction, stream ? "developer" : "system"), stream });
        if (stream) assert.match(text, /response\.completed/);
        assert.ok(sent.request.systemInstruction.parts.some(part => part.text === instruction), "原始审批政策必须保留");
        assert.ok(sent.request.contents.flatMap(content => content.parts).some(part => part.text === pendingText), "不改写待检查动作");
      }
    });
  }

  await t.test("Chat、Claude Messages 与 Gemini 原生入口也在翻译前切换模型", async () => {
    for (const stream of [false, true]) {
      await send("/v1/chat/completions", { model: "claude-opus-5-5-high", stream, reasoning_effort: "high",
        messages: [{ role: "system", content: classifier }, { role: "user", content: pendingText }] });
      await send("/v1/messages", { model: "claude-sonnet-5-5-high", stream, max_tokens: 1024, system: classifier,
        messages: [{ role: "user", content: pendingText }] });
      await send(`/v1beta/models/gemini-4-argon-high:${stream ? "streamGenerateContent" : "generateContent"}`, {
        systemInstruction: { parts: [{ text: classifier }] }, contents: [{ role: "user", parts: [{ text: pendingText }] }],
        generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
      });
    }
    await send("/v1/responses", { model: "claude-opus-5-5-high", instructions: classifier, input: pendingText, stream: false });
    await send("/v1/responses", approvalBody("gemini-4-argon-high(high)", "high"));
  });

  await t.test("普通对话、引用审批提示和混合历史保持原模型与思考档位", async () => {
    const source = "gemini-4-argon-high";
    for (const instruction of ["Ordinary coding task", "Quoted: " + classifier, "You are a security expert."]) {
      await send("/v1/responses", approvalBody(source, "high", instruction), source, "high");
    }
    const userPrompt = approvalBody(source, "high", classifier, "user");
    await send("/v1/responses", userPrompt, source, "high");
    const history = approvalBody(source, "high");
    history.input.push({ role: "assistant", content: [{ type: "output_text", text: "Earlier response" }] });
    await send("/v1/responses", history, source, "high");
    const additional = approvalBody(source, "high");
    additional.input[0].content.push({ type: "input_text", text: "Additional system instructions" });
    await send("/v1/responses", additional, source, "high");
  });

  await t.test("允许、阻止和格式错误的审核结果均原样交回宿主", async () => {
    for (const verdict of ['{"shouldBlock":false,"reason":"synthetic scoped read"}', '{"shouldBlock":true,"reason":"synthetic unsafe action"}', "malformed reviewer response"]) {
      const { text } = await send("/v1/responses", { ...approvalBody("claude-opus-5-5-high", "none", classifier, "system", "Classifier fixture result: " + verdict), stream: false });
      const result = JSON.parse(text);
      assert.equal(result.output[0].content[0].text, verdict);
    }
  });

  await t.test("扩展在同一核心进程停用后可重新启用并恢复审批路由", async () => {
    const managementHeaders = { Authorization: `Bearer ${config.mgmtKey}`, "Content-Type": "application/json" };
    for (const enabled of [false, true, false, true]) {
      const updated = await fetch(endpoint + "/v0/management/plugins/qoder-approval-router/enabled", {
        method: "PATCH", headers: managementHeaders, signal: AbortSignal.timeout(3000), body: JSON.stringify({ enabled }),
      });
      assert.equal(updated.status, 200, await updated.text());
      let status;
      let applied = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && child.exitCode === null) {
        const response = await fetch(endpoint + "/v0/management/plugins", { headers: managementHeaders, signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        status = await response.json();
        const plugin = status.plugins.find(plugin => plugin.id === "qoder-approval-router");
        if (plugin?.registered === enabled && plugin.effective_enabled === enabled) { applied = true; break; }
        await delay(100);
      }
      assert.ok(applied, output.slice(-3000));
      if (enabled) {
        assertApprovalPluginRegistered(status, router.directory);
        await send("/v1/responses", approvalBody("claude-opus-5-5-high", "none"));
      }
    }
  });

  await t.test("审核模型不可用时返回错误，不回退昂贵源模型或伪造放行", async () => {
    const before = captured.length;
    const response = await fetch(endpoint + "/v1/responses", { method: "POST", headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ ...approvalBody("claude-opus-5-5-high", "none", classifier, "system", "Simulate unavailable reviewer."), stream: false }) });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
    assert.equal(captured.length, before + 1);
    assert.equal(captured.at(-1).body.model, reviewer);
  });

  child.kill();
  await exited;
  const routingLogs = output.split(/\r?\n/).filter(line => line.includes("审批模型切换"));
  assert.ok(routingLogs.length >= modelNames.length);
  for (const line of routingLogs) {
    assert.match(line, /\[info\s*\]/);
    assert.doesNotMatch(line, /\[(?:warn|error)\s*\]/);
    assert.match(line, /provider=antigravity/);
    assert.match(line, /thinking=low/);
  }
  assert.ok(!output.includes(pendingText), "切换日志不得泄漏审批正文");
});
