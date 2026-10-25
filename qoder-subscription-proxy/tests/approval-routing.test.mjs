import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ensureApprovalRouting } from "../bridge/approval-routing.mjs";
import { parseConfigYaml } from "../bridge/config-yaml.mjs";
import { loadConfig, renderConfigYaml, validateExistingConfig } from "../bridge/config.mjs";
import { ensureDataDir } from "../bridge/bridge-process.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const prefix = "You are a security classifier for auto permission mode.";
const config = { host: "127.0.0.1", port: 1, apiKey: "isolated-api", mgmtKey: "123456", authDir: join(tmpdir(), "isolated-approval-auths") };
const base = renderConfigYaml(config);
const overrideKey = JSON.stringify(["requests", "payload", "override"]);

for (const suffix of [
  "",
  "requests: {}\n",
  "requests: null\n",
  "requests:\n  payload: {} # retain this comment\n",
  "requests:\n  payload:\n    override: []\n",
  "requests:\n    timeout: 20\n    payload:\n        override: []\n",
  "requests:\n  proxy-url: direct\nobservability:\n  logs:\n    request-log: true\n",
  "requests:\n  payload:\n    default:\n      - models:\n          - name: other\n        params:\n          temperature: 1\n",
  "requests:\n  payload:\n    override:\n    - models:\n      - name: other\n      params:\n        model: retained\nobservability:\n  logs:\n    logs-max-total-size-mb: 256\n",
]) {
  test(`审批规则迁移保留既有配置并幂等：${JSON.stringify(suffix)}`, () => {
    const original = base + suffix;
    const before = parseConfigYaml(original).values;
    const updated = ensureApprovalRouting(original);
    validateExistingConfig(config, updated);
    const after = parseConfigYaml(updated).values;
    for (const [key, value] of before) {
      if (key === overrideKey || value === null) continue;
      assert.deepEqual(after.get(key), value, key);
    }
    assert.equal(after.get(overrideKey).length, (Array.isArray(before.get(overrideKey)) ? before.get(overrideKey).length : 0) + 1);
    assert.equal(ensureApprovalRouting(updated), updated);
    const savedByCore = updated.replaceAll('"reasoning.effort"', "reasoning.effort").replaceAll("\n", "\r\n");
    assert.equal(ensureApprovalRouting(savedByCore), savedByCore);
    if (suffix.includes("# retain")) assert.ok(updated.includes("# retain this comment"));
  });
}

test("配置节点合并保留 CRLF、BOM 和既有同级段", () => {
  const original = "\uFEFF" + (base + "requests:\n  payload:\n    override: []\nother:\n  enabled: true\n").replaceAll("\n", "\r\n");
  const updated = ensureApprovalRouting(original);
  assert.ok(updated.startsWith("\uFEFF"));
  assert.equal(updated.replaceAll("\r\n", "").includes("\n"), false);
  assert.equal(parseConfigYaml(updated).values.get(JSON.stringify(["other", "enabled"])), true);
  validateExistingConfig(config, updated);
});

test("不把已有错误结构或含敏感值的字段静默覆盖", () => {
  for (const suffix of ["requests: private-value\n", "requests: []\n", "requests:\n  payload: private-value\n", "requests:\n  payload:\n    override: {}\n"]) {
    assert.throws(() => ensureApprovalRouting(base + suffix), (error) => {
      assert.match(error.message, /必须为标准映射/);
      assert.ok(!error.message.includes("private-value"));
      return true;
    });
  }
});

test("已有数据目录启动时仅追加审批规则，保留日志设置与 API 密钥", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qoder-approval-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { BRIDGE_DATA_DIR: root, BRIDGE_PORT: "1", BRIDGE_API_KEY: "isolated-api" };
  const current = await loadConfig({ pluginRoot, env });
  const original = renderConfigYaml(current) + "observability:\n  logs:\n    request-log: true\n    logging-to-file: true\n    logs-max-total-size-mb: 256\n";
  await writeFile(current.configPath, original);
  const secrets = await readFile(join(root, "launcher-secrets.json"));
  await ensureDataDir(current);
  const updated = await readFile(current.configPath, "utf8");
  assert.ok(updated.startsWith(original));
  assert.deepEqual(await readFile(join(root, "launcher-secrets.json")), secrets);
  await ensureDataDir(current);
  assert.equal(await readFile(current.configPath, "utf8"), updated);
  await loadConfig({ pluginRoot, env });
});

test("原生 Codex 仅将两个指定模型的审批 none 请求改为 Luna low", { skip: nativeCoreSkip, timeout: 45000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qoder-approval-native-"));
  const captured = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured.push({ model: body.model, effort: body.reasoning?.effort });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_mock", object: "response", status: "completed", model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
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
  const current = await loadConfig({ pluginRoot, env: { BRIDGE_DATA_DIR: root, BRIDGE_PORT: String(port), BRIDGE_API_KEY: "isolated-api" } });
  const modelNames = ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-luna"];
  const provider = [
    "api-keys:", "  codex:", "    - name: isolated-mock",
    `      base-url: "http://127.0.0.1:${upstream.address().port}"`,
    "      proxy-url: direct", "      models:",
    ...modelNames.flatMap(model => [
      `        - name: ${model}`, `          alias: ${model}`, "          support-configuration-update: true",
      "          thinking:", "            levels:",
      "              - low", "              - medium", "              - high", "              - xhigh", "              - max",
    ]),
    "      keys:", "        - api-key: isolated-upstream", "          disable-codex-cloaking: true", "",
  ].join("\n");
  const original = renderConfigYaml(current).replace("  disable-control-panel: false", "  disable-control-panel: true") + provider;
  const text = ensureApprovalRouting(original);
  validateExistingConfig(current, text);
  await writeFile(current.configPath, text);
  const binary = await copyTestCore(join(root, process.platform === "win32" ? "core.exe" : "core"));
  child = spawn(binary, ["-config", current.configPath], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  exited = once(child, "exit");
  child.stdout.on("data", data => { output = (output + data).slice(-12000); });
  child.stderr.on("data", data => { output = (output + data).slice(-12000); });
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = { Authorization: "Bearer isolated-api", "Content-Type": "application/json" };
  let ready = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`${endpoint}/v1/models`, { headers, signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch (error) {
      if (child.exitCode !== null) throw error;
    }
    await delay(100);
  }
  assert.ok(ready, output);
  const cases = [
    ["gpt-6-astra", "none", "system", prefix, "gpt-6-luna", "low"],
    ["gpt-6.1-sol", "none", "system", prefix, "gpt-6-luna", "low"],
    ["gpt-6-astra", "none", "developer", prefix, "gpt-6-luna", "low"],
    ["gpt-6-astra", "xhigh", "system", prefix, "gpt-6-astra", "xhigh"],
    ["gpt-6-astra", "low", "system", prefix, "gpt-6-astra", "low"],
    ["gpt-6-astra", "none", "user", prefix, "gpt-6-astra", "none"],
    ["gpt-6-astra", "none", "system", "Ordinary coding task", "gpt-6-astra", "none"],
    ["gpt-6-astra", "none", "system", ["Ordinary coding task", prefix], "gpt-6-astra", "none"],
    ["gpt-6.1-sol", "none", "system", [prefix, "Additional system content"], "gpt-6.1-sol", "none"],
    ["gpt-6.1-sol", "xhigh", "system", "Ordinary subagent", "gpt-6.1-sol", "xhigh"],
    ["gpt-5.6-luna", "none", "system", prefix, "gpt-5.6-luna", "none"],
  ];
  for (const [model, effort, role, instruction, expectedModel, expectedEffort] of cases) {
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST", headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ model, input: [{ role, content: (Array.isArray(instruction) ? instruction : [instruction]).map(text => ({ type: "input_text", text: text + "\nFixture only." })) }], stream: true, reasoning: { effort } }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, /response\.completed/);
    assert.deepEqual(captured.at(-1), { model: expectedModel, effort: expectedEffort }, JSON.stringify({ model, effort, role, instruction }));
  }
});
