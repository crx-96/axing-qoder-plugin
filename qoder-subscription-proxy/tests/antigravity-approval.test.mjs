import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig, renderConfigYaml } from "../server/config.mjs";
import { ensureRunning, stopBridge } from "../server/supervisor.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("旧 Google OAuth、API Key 与混合别名被停用，非 Google 模型仍可调用", { skip: nativeCoreSkip, timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "qoder-google-acp-only-"));
  const generated = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url.includes("fetchAvailableModels")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: { "gemini-legacy": {} } })); return;
    }
    generated.push({ path: req.url, model: body.model });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      id: "fixture", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "non-google fixture" }, finish_reason: "stop" }],
    }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const probe = http.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const binary = await copyTestCore(join(root, process.platform === "win32" ? "core.exe" : "core"));
  const config = await loadConfig({ pluginRoot, env: { BRIDGE_DATA_DIR: root, BRIDGE_PORT: String(port), BRIDGE_BIN: binary } });
  t.after(async () => { await stopBridge(config); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await mkdir(config.authDir, { recursive: true });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const auth = { type: "antigravity", access_token: "synthetic-only", refresh_token: "", expired: "2099-01-01T00:00:00Z",
    project_id: "fixture", email: "fixture@example.invalid", base_url: base, proxy_url: "direct",
    antigravity_capability_hints: { project_id: "fixture", endpoint: base, model_ids: ["gemini-legacy"] } };
  await writeFile(join(config.authDir, "google.json"), JSON.stringify(auth));
  await writeFile(config.configPath, renderConfigYaml(config) + `
api-keys:
  gemini:
    - name: google-fixture
      base-url: ${JSON.stringify(base)}
      models: [{name: gemini-api-fixture, alias: opaque-google-api}]
      keys: [{api-key: synthetic, proxy-url: direct, excluded-models: [other-model]}]
  openai-compatibility:
    - name: mixed-fixture
      base-url: ${JSON.stringify(base + "/v1")}
      request-retry: 0
      models: [{name: gemini-mixed-fixture, alias: opaque-google-mixed}, {name: gpt-fixture, alias: gpt-allowed}]
      keys: [{api-key: synthetic, proxy-url: direct}]
`);
  await ensureRunning(config);
  const migrated = JSON.parse(await readFile(join(config.authDir, "google.json"), "utf8"));
  assert.equal(migrated.disabled, true); assert.equal(migrated.access_token, auth.access_token);
  const archived = JSON.parse(await readFile(join(root, "acp-disabled-models.json"), "utf8"));
  assert.equal(archived[0].models[0].name, "gemini-mixed-fixture");
  assert.equal(archived[0].models[0].alias, "opaque-google-mixed");
  const headers = { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json" };
  const listing = await (await fetch(config.endpoint + "/models", { headers })).json();
  const ids = listing.data.map(model => model.id);
  for (const name of ["gemini-legacy", "opaque-google-api", "opaque-google-mixed"]) assert.equal(ids.includes(name), false, name);
  assert.ok(ids.includes("gpt-allowed"));
  for (const model of ["gemini-legacy", "opaque-google-api", "opaque-google-mixed"]) {
    const response = await fetch(config.endpoint + "/chat/completions", { method: "POST", headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "must not reach legacy upstream" }] }), signal: AbortSignal.timeout(10000) });
    await response.text(); assert.notEqual(response.status, 200, model);
  }
  assert.equal(generated.length, 0);
  const normal = await fetch(config.endpoint + "/chat/completions", { method: "POST", headers,
    body: JSON.stringify({ model: "gpt-allowed", messages: [{ role: "user", content: "synthetic" }] }) });
  assert.equal(normal.status, 200, await normal.text());
  assert.deepEqual(generated.map(item => item.model), ["gpt-fixture"]);
  await stopBridge(config);
  await ensureRunning(config);
  const restarted = await (await fetch(config.endpoint + "/models", { headers })).json();
  assert.equal(restarted.data.some(model => model.id === "opaque-google-mixed"), false);
});
