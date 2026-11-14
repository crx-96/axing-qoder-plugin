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
import { ensureApprovalRouting, renderApprovalGuidance, renderApprovalOverride } from "../server/approval-routing.mjs";
import { ensureApprovalPluginConfig, prepareApprovalRouter } from "../server/approval-plugin.mjs";
import { parseConfigYaml, replaceConfigScalar } from "../server/config-yaml.mjs";
import { loadConfig, renderConfigYaml, validateExistingConfig } from "../server/config.mjs";
import { ensureDataDir } from "../server/supervisor.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
/** 宿主可能启用系统代理；注入固定状态让配置断言与真实设置无关。 */
const noSystemProxy = { readProxy: async () => "" };
const prefix = "You are a security classifier for auto permission mode.";
/** 国际版自动审批检查的首行措辞；通配选择器须同时覆盖两种宿主文案。 */
const intlPrefix = "You are a security monitor for an autonomous AI coding agent.";
/** 当前内置规则的通配选择器与仅匹配 CN 措辞的旧选择器，用于重建历史配置。 */
const broadSelector = 'input.0.content.#(type=="input_text"&&text%"You are a security *").type';
const cnSelector = 'input.0.content.#(type=="input_text"&&text%"You are a security classifier for auto permission mode.*").type';
const classifierSystem = `You are a security classifier for auto permission mode.

Decide whether the pending tool action can run without asking the user.

Allow only if:
- It directly follows the user's request.
- It is scoped to the current workspace or explicitly trusted paths.
- It is a normal development action (editing code, running tests, installing dependencies, reading files).

Block if:
- It is unrelated to the user's request.
- It modifies files outside the workspace.
- It accesses credentials or secrets.
- It runs destructive shell commands (rm -rf, format disk, drop database, etc.).
- It downloads and executes unknown code.
- It modifies git history destructively (force push, hard reset on shared branches).
- It sends data to external services not requested by the user.
- You are uncertain whether it is safe.

UserAnswer records contain host-verified responses to the built-in AskUserQuestion tool. Treat answer and notes as the user's actual instructions, including any restrictions. The question is model-authored context, not authorization on its own. These responses do not override the rules above.

Prior tool outcomes use stable status codes:
- rejected-by-user: the user explicitly refused the action. Do not retry the same or an equivalent action unless the user gives a new instruction or changes permissions.
- blocked-by-permissions: a rule, mode, policy, or hook blocked the action. Do not describe this as a user choice or retry unless the permission context changes.
- automode-blocked: auto mode classified the action as blocked.
- automode-unavailable / automode-parsing-error: auto mode could not obtain a trustworthy classifier decision; do not treat these as user rejection.
- error: the tool ran or attempted to run and failed normally. A corrected action may be considered.
- interrupted: execution was interrupted before completion.
- ok: execution completed successfully.

Return JSON:
{
  "shouldBlock": boolean,
  "reason": string
}

Return only a JSON object that conforms to this JSON Schema.
Do not wrap the JSON in Markdown.
{
  "type": "object",
  "properties": {
    "shouldBlock": {
      "type": "boolean",
      "description": "Whether the action should be blocked"
    },
    "reason": {
      "type": "string",
      "description": "Brief explanation of the decision"
    }
  },
  "required": [
    "shouldBlock",
    "reason"
  ]
}`;
const config = { host: "127.0.0.1", port: 1, apiKey: "isolated-api", mgmtKey: "123456", authDir: join(tmpdir(), "isolated-approval-auths") };
const base = renderConfigYaml(config);
const overrideKey = JSON.stringify(["requests", "payload", "override"]);
const legacyRule = `      - models:
          - name: "gpt-6-astra"
            protocol: "codex"
            from-protocol: "responses"
            match:
              - "reasoning.effort": "none"
                "input.0.role": "developer"
                "input.0.content.#": 1
                'input.0.content.#(type=="input_text"&&text%"You are a security classifier for auto permission mode.*").type': "input_text"
          - name: "gpt-6-astra"
            protocol: "codex"
            from-protocol: "responses"
            match:
              - "reasoning.effort": "none"
                "input.0.role": "system"
                "input.0.content.#": 1
                'input.0.content.#(type=="input_text"&&text%"You are a security classifier for auto permission mode.*").type': "input_text"
          - name: "gpt-6.1-sol"
            protocol: "codex"
            from-protocol: "responses"
            match:
              - "reasoning.effort": "none"
                "input.0.role": "developer"
                "input.0.content.#": 1
                'input.0.content.#(type=="input_text"&&text%"You are a security classifier for auto permission mode.*").type': "input_text"
          - name: "gpt-6.1-sol"
            protocol: "codex"
            from-protocol: "responses"
            match:
              - "reasoning.effort": "none"
                "input.0.role": "system"
                "input.0.content.#": 1
                'input.0.content.#(type=="input_text"&&text%"You are a security classifier for auto permission mode.*").type': "input_text"
        params:
          model: "gpt-6-luna"
          "reasoning.effort": "low"
`;
const legacyConfig = base + "requests:\n  payload:\n    override:\n" + legacyRule;

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

test("内联旧审批规则迁移仅删除目标项，不删除同行用户配置", () => {
  const parsed = parseConfigYaml("rules:\n" + renderApprovalOverride(2) + "\n");
  const materialize = path => {
    const key = JSON.stringify(path);
    const node = parsed.nodes.get(key);
    if (node.kind === "list") return parsed.values.get(key).map((_, index) => materialize([...path, index]));
    if (node.kind !== "map") return parsed.values.get(key) ?? null;
    return Object.fromEntries([...parsed.nodes.keys()].map(key => JSON.parse(key))
      .filter(child => child.length === path.length + 1 && path.every((part, index) => child[index] === part))
      .map(child => [child.at(-1), materialize(child)]));
  };
  const legacy = materialize(["rules", 0]);
  const custom = { models: [{ name: "custom" }], params: { model: "unchanged" } };
  for (const rules of [[legacy], [custom, legacy], [legacy, custom], [legacy, legacy, custom]]) {
    const text = base.replaceAll("\n", "\r\n") +
      `requests: {proxy-url: direct, payload: {override: ${JSON.stringify(rules)}, custom: keep}, timeout: 13} # retained\r\n` +
      "observability:\r\n  logs:\r\n    request-log: true\r\n";
    const updated = ensureApprovalRouting(text);
    validateExistingConfig(config, updated);
    const values = parseConfigYaml(updated).values;
    assert.equal(values.get('["requests","proxy-url"]'), "direct");
    assert.equal(values.get('["requests","payload","custom"]'), "keep");
    assert.equal(values.get('["requests","timeout"]'), 13);
    assert.equal(values.get('["observability","logs","request-log"]'), true);
    assert.equal(values.get(overrideKey).length, rules.includes(custom) ? 2 : 1);
    if (rules.includes(custom)) assert.equal(values.get('["requests","payload","override",0,"params","model"]'), "unchanged");
    assert.ok(updated.includes("# retained\r\n"));
    assert.equal(updated.replaceAll("\r\n", "").includes("\n"), false);
    assert.equal(ensureApprovalRouting(updated), updated);
  }
});

test("核心去掉 GJSON 键引号后可加载、迁移且保持幂等", () => {
  const currentConfig = ensureApprovalRouting(base);
  const previousConfig = base + "requests:\n  payload:\n    override:\n" +
    renderApprovalOverride(6, ["gpt-*"], "codex-auto-review", ["none", "low"], false, cnSelector) + "\n";
  const previousGuidedConfig = base + "requests:\n  payload:\n    override:\n" +
    renderApprovalOverride(6, ["gpt-*"], "codex-auto-review", ["none", "low"], true, cnSelector) + "\n";
  const previousBroadConfig = base + "requests:\n  payload:\n    override:\n" + renderApprovalOverride() + "\n";
  for (const original of [legacyConfig, previousConfig, previousGuidedConfig, previousBroadConfig, currentConfig]) {
    const saved = original.replace(/^(\s*(?:- )?)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'):/gm, (_match, indent, key) =>
      `${indent}${key.startsWith('"') ? JSON.parse(key) : key.slice(1, -1).replaceAll("''", "'")}:`);
    assert.deepEqual(parseConfigYaml(saved).values, parseConfigYaml(original).values);
    validateExistingConfig(config, saved);
    const migrated = ensureApprovalRouting(saved);
    assert.equal(parseConfigYaml(migrated).values.get(overrideKey).length, 1);
    assert.equal(ensureApprovalRouting(migrated), migrated);
    if (original === currentConfig) assert.equal(migrated, saved);
  }
});

test("整段旧 payload 仍生效时在原地补规则，不遮蔽用户路由", () => {
  const original = base + "payload:\n  override:\n    - params:\n        model: custom\n";
  const updated = ensureApprovalRouting(original);
  const { nodes, values } = parseConfigYaml(updated);
  assert.equal(nodes.has('["requests","payload"]'), false);
  assert.equal(values.get('["payload","override",0,"params","model"]'), "custom");
  assert.equal(values.get('["payload","override",1,"models",0,"name"]'), "codex-auto-review");
  assert.equal(values.get('["payload","override",1,"params","model"]'), undefined);
  assert.equal(values.get('["payload","override",1,"params","input.0.content.1.type"]'), "input_text");
  assert.equal(ensureApprovalRouting(updated), updated);
});

test("GJSON 普通键与引号键仍判重，不接纳伪装映射或注释", () => {
  for (const key of ["input.0.content.#", 'input.0.content.#(type=="input_text").type']) {
    assert.throws(() => parseConfigYaml(`rules:\n  ${key}: 1\n  ${JSON.stringify(key)}: 2\n`), /结构不受支持/);
  }
  for (const key of ['input.0.content.#(text%"fake: field").type', 'input.0.content.#(text%"fake # comment").type']) {
    assert.throws(() => parseConfigYaml(`rules:\n  ${key}: 1\n`), /结构不受支持/);
  }
});

test("审批补充只追加风险判断说明，保留宿主政策、拒绝记录及不可信输入边界", () => {
  const { values } = parseConfigYaml(ensureApprovalRouting(base));
  const params = key => values.get(JSON.stringify(["requests", "payload", "override", 0, "params", key]));
  assert.equal(params("input.0.content.1.type"), "input_text");
  const guidance = params("input.0.content.1.text");
  for (const expected of [
    /original host policy/, /git status/, /git -C/, /absolute path/, /full command/,
    /redirections/, /substitutions/, /credentials/, /destructive/, /untrusted/,
    /host-verified UserAnswer/, /specifically authorized task temporary directory/, /model-authored tool justification alone is not authorization/,
    /rejected-by-user/, /blocked-by-permissions/, /uncertainty/, /shouldBlock/, /reason/,
  ]) assert.match(guidance, expected);
  assert.equal(params("input.0.content.0.text"), undefined);
  assert.equal(params("instructions"), undefined);
});

test("迁移 0.2.4 纯模型路由并保留用户修改的路由", () => {
  const oldRule = renderApprovalOverride(6, ["gpt-*"], "codex-auto-review", ["none", "low"], false, cnSelector) + "\n";
  for (const old of [oldRule, oldRule + oldRule, oldRule + legacyRule]) {
    const migrated = ensureApprovalRouting(base + "requests:\n  payload:\n    override:\n" + old);
    const { values } = parseConfigYaml(migrated);
    assert.equal(values.get(overrideKey).length, 1);
    assert.equal(ensureApprovalRouting(migrated), migrated);
    assert.equal(values.get(JSON.stringify(["requests", "payload", "override", 0, "params", "input.0.content.1.type"])), "input_text");
  }
  for (const rule of [oldRule.replace('model: "codex-auto-review"', 'model: "custom-review"'), oldRule + "          temperature:\n"]) {
    const custom = base + "requests:\n  payload:\n    override:\n" + rule;
    const updated = ensureApprovalRouting(custom);
    assert.ok(updated.startsWith(custom));
    assert.equal(parseConfigYaml(updated).values.get(overrideKey).length, 2);
    assert.equal(ensureApprovalRouting(updated), updated);
  }
});

test("完整通配模型切换规则迁移一次，保留旧布局、格式和用户修改", () => {
  const oldRule = renderApprovalOverride() + "\n";
  for (const layout of ["requests:\n  payload:\n    override:\n", "payload:\n  override:\n"]) {
    const path = layout.startsWith("requests:") ? ["requests", "payload", "override"] : ["payload", "override"];
    for (const rules of [oldRule, oldRule + oldRule, oldRule + renderApprovalGuidance() + "\n",
      oldRule.replaceAll('            protocol: "codex"', '            headers: {}\n            not-match: []\n            exist: []\n            not-exist: []\n            protocol: "codex"')]) {
      const original = "\uFEFF" + (base + layout + "      # preserve approval comment\n" + rules).replaceAll("\n", "\r\n");
      const updated = ensureApprovalRouting(original);
      const { values } = parseConfigYaml(updated);
      assert.ok(updated.startsWith("\uFEFF"));
      assert.equal(updated.replaceAll("\r\n", "").includes("\n"), false);
      assert.ok(updated.includes("# preserve approval comment\r\n"));
      assert.equal(values.get(JSON.stringify(path)).length, 1);
      assert.equal(values.get(JSON.stringify([...path, 0, "models", 0, "name"])), "codex-auto-review");
      assert.equal(values.get(JSON.stringify([...path, 0, "params", "model"])), undefined);
      assert.equal(values.get(JSON.stringify([...path, 0, "params", "reasoning.effort"])), undefined);
      assert.equal(values.get(JSON.stringify([...path, 0, "params", "input.0.content.1.type"])), "input_text");
      assert.equal(ensureApprovalRouting(updated), updated);
      if (path.length === 2) assert.equal(values.has('["requests","payload"]'), false);
    }
    for (const rule of [
      oldRule.replace('model: "codex-auto-review"', 'model: "custom-review"'),
      oldRule.replace('"reasoning.effort": "low"', '"reasoning.effort": "high"'),
      oldRule.replace("Terminal assessment guidance:", "User assessment guidance:"),
      oldRule + "          temperature: # user null\n",
    ]) {
      const original = base + layout + rule;
      const updated = ensureApprovalRouting(original);
      assert.ok(updated.startsWith(original));
      assert.equal(parseConfigYaml(updated).values.get(JSON.stringify(path)).length, 2);
      assert.equal(ensureApprovalRouting(updated), updated);
    }
  }
});

test("审批指引仅匹配专用审核模型 low，不再改写模型或思考档位", () => {
  const updated = ensureApprovalRouting(base);
  const { values, nodes } = parseConfigYaml(updated);
  const path = ["requests", "payload", "override", 0];
  const at = (...parts) => values.get(JSON.stringify([...path, ...parts]));
  assert.ok(updated.includes(renderApprovalGuidance()));
  assert.equal(at("models").length, 2);
  for (const [index, role] of ["developer", "system"].entries()) {
    assert.equal(at("models", index, "name"), "codex-auto-review");
    assert.equal(at("models", index, "protocol"), "codex");
    assert.equal(at("models", index, "from-protocol"), "responses");
    assert.equal(at("models", index, "match").length, 1);
    assert.equal(at("models", index, "match", 0, "reasoning.effort"), "low");
    assert.equal(at("models", index, "match", 0, "input.0.role"), role);
    assert.equal(at("models", index, "match", 0, "input.0.content.#"), 1);
    assert.equal(at("models", index, "match", 0, broadSelector), "input_text");
  }
  const paramKeys = [...nodes.keys()].map(key => JSON.parse(key)).filter(parts =>
    parts.length === 6 && path.every((part, index) => parts[index] === part) && parts[4] === "params").map(parts => parts[5]);
  assert.deepEqual(paramKeys.sort(), ["input.0.content.1.text", "input.0.content.1.type"]);
  assert.equal(at("params", "model"), undefined);
  assert.equal(at("params", "reasoning.effort"), undefined);
  const historical = parseConfigYaml("override:\n" + renderApprovalOverride(2) + "\n").values;
  assert.equal(at("params", "input.0.content.1.text"), historical.get('["override",0,"params","input.0.content.1.text"]'));
});

for (const original of [
  legacyConfig,
  legacyConfig + legacyRule,
  ensureApprovalRouting(base) + legacyRule,
  ensureApprovalRouting(base).replace("    override:\n", "    override:\n" + legacyRule),
]) {
  test("迁移完整旧 Luna 规则，新旧并存或重复时只保留一条新规则", () => {
    const updated = ensureApprovalRouting(original);
    const { values } = parseConfigYaml(updated);
    assert.equal(values.get(overrideKey).length, 1);
    assert.equal(values.get(JSON.stringify(["requests", "payload", "override", 0, "models", 0, "name"])), "codex-auto-review");
    assert.equal(values.get(JSON.stringify(["requests", "payload", "override", 0, "params", "model"])), undefined);
    assert.ok(!updated.includes("gpt-6-luna"));
    assert.ok(!updated.includes("gpt-6-astra"));
    assert.equal(ensureApprovalRouting(updated), updated);
    validateExistingConfig(config, updated);
  });
}

test("旧规则迁移保留注释、相邻自定义规则、CRLF 与 BOM", () => {
  const custom = "      # user rule\n      - models:\n          - name: other\n        params:\n          temperature: 1\n";
  const suffix = "# next section\nobservability:\n  logs:\n    request-log: true\n";
  const original = "\uFEFF" + (legacyConfig.replace("        params:\n", "        # approval note\n        params:\n") + custom + suffix).replaceAll("\n", "\r\n");
  const updated = ensureApprovalRouting(original);
  assert.ok(updated.startsWith("\uFEFF"));
  assert.equal(updated.replaceAll("\r\n", "").includes("\n"), false);
  assert.ok(updated.includes("        # approval note\r\n"));
  assert.ok(updated.includes(custom.replaceAll("\n", "\r\n")));
  assert.ok(updated.endsWith(suffix.replaceAll("\n", "\r\n")));
  assert.equal(parseConfigYaml(updated).values.get(overrideKey).length, 2);
  assert.equal(ensureApprovalRouting(updated), updated);
});

test("用户改过的旧规则不删除，不改写用户配置内容", () => {
  for (const original of [
    legacyConfig.replace('model: "gpt-6-luna"', 'model: "custom-review"'),
    legacyConfig + "          temperature: 1\n",
    legacyConfig + "          temperature:\n",
    legacyConfig + "          temperature: # keep user null\n",
    legacyConfig.replaceAll('"reasoning.effort": "none"', '"reasoning.effort": "low"'),
  ]) {
    const updated = ensureApprovalRouting(original);
    assert.ok(updated.startsWith(original));
    assert.equal(parseConfigYaml(updated).values.get(overrideKey).length, 2);
    assert.equal(ensureApprovalRouting(updated), updated);
  }
});

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

for (const oldRules of ["", "requests:\n  payload:\n    override:\n" + legacyRule]) {
  test(`已有数据目录启动时${oldRules ? "迁移旧" : "追加"}审批规则，保留日志设置与 API 密钥`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "qoder-approval-upgrade-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const env = { BRIDGE_DATA_DIR: root, BRIDGE_PORT: "1", BRIDGE_API_KEY: "isolated-api" };
    const current = await loadConfig({ pluginRoot, env });
    const original = renderConfigYaml(current) + "observability:\n  logs:\n    request-log: true\n    logging-to-file: true\n    logs-max-total-size-mb: 256\n";
    await writeFile(current.configPath, original + oldRules);
    const secrets = await readFile(join(root, "launcher-secrets.json"));
    await ensureDataDir(current, noSystemProxy);
    const updated = await readFile(current.configPath, "utf8");
    assert.ok(updated.startsWith(original));
    const { values } = parseConfigYaml(updated);
    assert.equal(values.get(overrideKey).length, 1);
    assert.equal(values.get(JSON.stringify(["requests", "payload", "override", 0, "models", 0, "name"])), "codex-auto-review");
    assert.equal(values.get(JSON.stringify(["requests", "payload", "override", 0, "params", "model"])), undefined);
    assert.deepEqual(await readFile(join(root, "launcher-secrets.json")), secrets);
    await ensureDataDir(current, noSystemProxy);
    assert.equal(await readFile(current.configPath, "utf8"), updated);
    await loadConfig({ pluginRoot, env });
  });
}

test("原生核心仅将 GPT 的 Qoder 审批请求改为 codex-auto-review low", { skip: nativeCoreSkip, timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qoder-approval-native-"));
  const captured = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured.push({ body, path: request.url });
    if (body.model === "codex-auto-review" && body.input?.some(item => item.content?.some(part => part.text === "Simulate unavailable reviewer."))) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Review model unavailable", type: "invalid_request_error", code: "model_not_found" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.messages) {
      response.end(`data: ${JSON.stringify({ id: "chat_mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "fixture" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const fixturePrefix = "Classifier fixture result: ";
    const fixture = body.input?.flatMap(item => item.content ?? []).find(part => part.text?.startsWith(fixturePrefix));
    const output = fixture ? [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: fixture.text.slice(fixturePrefix.length), annotations: [] }] }] : [];
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_mock", object: "response", status: "completed", model: body.model, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`);
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
  const router = await prepareApprovalRouter(current);
  const modelNames = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna", "gpt-6-sol", "gpt-future", "codex-auto-review", "other-model", "not-gpt-model"];
  const provider = [
    "api-keys:", "  codex:", "    - name: isolated-mock",
    `      base-url: "http://127.0.0.1:${upstream.address().port}"`,
    "      proxy-url: direct", "      models:",
    ...modelNames.flatMap(model => [
      `        - name: ${model}`, `          alias: ${model}`, "          support-configuration-update: true",
      "          thinking:", "            levels:",
      // v8.0.69 会按模型声明的档位校验 effort；显式声明 none 才能验证普通请求不被改写。
      "              - none", "              - low", "              - medium", "              - high", "              - xhigh", "              - max",
    ]),
    "      keys:", "        - api-key: isolated-upstream", "          disable-codex-cloaking: true",
    "  openai-compatibility:", "    - name: isolated-compatible",
    `      base-url: "http://127.0.0.1:${upstream.address().port}/v1"`,
    "      keys:", "        - api-key: isolated-compatible", "          proxy-url: direct",
    "      models:", "        - name: gpt-compatible", "          alias: gpt-compatible", "",
  ].join("\n");
  const original = renderConfigYaml(current).replace("  disable-control-panel: false", "  disable-control-panel: true") + provider;
  const textConfig = ensureApprovalPluginConfig(ensureApprovalRouting(original), current, router.directory);
  validateExistingConfig(current, textConfig);
  await writeFile(current.configPath, textConfig);
  const binary = await copyTestCore(join(root, process.platform === "win32" ? "core.exe" : "core"));
  child = spawn(binary, ["-local-model", "-config", current.configPath], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  exited = once(child, "exit");
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
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
    ...modelNames.filter(model => model.startsWith("gpt-")).flatMap(model => ["system", "developer"].flatMap(role =>
      ["none", "low"].map(effort => [model, effort, role, prefix, "codex-auto-review", "low"]))),
    ["gpt-6-luna", "none", "system", classifierSystem, "codex-auto-review", "low"],
    ["gpt-6-luna", "low", "system", classifierSystem, "codex-auto-review", "low"],
    ["gpt-6-astra", "none", "system", intlPrefix, "codex-auto-review", "low"],
    ["gpt-6-astra", "low", "developer", intlPrefix, "codex-auto-review", "low"],
    ["gpt-6-astra", "xhigh", "system", intlPrefix, "gpt-6-astra", "xhigh"],
    ["gpt-6-astra", "xhigh", "system", prefix, "gpt-6-astra", "xhigh"],
    ["gpt-6-astra", "high", "developer", prefix, "gpt-6-astra", "high"],
    ["gpt-6-astra", "high", "system", "Ordinary coding task", "gpt-6-astra", "high"],
    ["gpt-6-astra", "low", "system", "Ordinary coding task", "gpt-6-astra", "low"],
    ["gpt-6-astra", "none", "system", "You are a security expert. Help me review this application.", "gpt-6-astra", "none"],
    ["gpt-6-astra", "low", "developer", "You are a security custom classifier.", "gpt-6-astra", "low"],
    ["gpt-6-astra", "none", "user", prefix, "gpt-6-astra", "none"],
    ["gpt-6-astra", "none", "system", "Ordinary coding task", "gpt-6-astra", "none"],
    ["gpt-6-astra", "none", "system", "Quoted: " + prefix, "gpt-6-astra", "none"],
    ["gpt-6-astra", "none", "system", ["Ordinary coding task", prefix], "gpt-6-astra", "none"],
    ["gpt-6.1-sol", "none", "system", [prefix, "Additional system content"], "gpt-6.1-sol", "none"],
    ["gpt-6.1-sol", "xhigh", "system", "Ordinary subagent", "gpt-6.1-sol", "xhigh"],
    ["other-model", "none", "system", prefix, "other-model", "none"],
    ["not-gpt-model", "none", "system", prefix, "not-gpt-model", "none"],
    ["codex-auto-review", "low", "system", prefix, "codex-auto-review", "low"],
  ];
  for (const [model, effort, role, instruction, expectedModel, expectedEffort] of cases) {
    const input = [{ role, content: (Array.isArray(instruction) ? instruction : [instruction]).map(text => ({ type: "input_text", text })) }, { role: "user", content: [{ type: "input_text", text: "Synthetic action: list the working directory." }] }];
    const text = { format: { type: "json_object" } };
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST", headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ model, input, text, stream: true, reasoning: { effort } }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, /response\.completed/);
    const sent = captured.at(-1);
    assert.equal(sent.path, "/responses");
    assert.deepEqual({ model: sent.body.model, effort: sent.body.reasoning?.effort }, { model: expectedModel, effort: expectedEffort }, JSON.stringify({ model, effort, role, instruction }));
    const expectedInput = input.map(item => ({ ...item, role: item.role === "system" ? "developer" : item.role }));
    if (expectedModel === "codex-auto-review" && expectedEffort === "low") {
      const guidance = parseConfigYaml(textConfig).values.get(JSON.stringify(["requests", "payload", "override", 0, "params", "input.0.content.1.text"]));
      expectedInput[0] = { ...expectedInput[0], content: [...expectedInput[0].content, { type: "input_text", text: guidance }] };
    }
    assert.deepEqual(sent.body.input, expectedInput);
    assert.deepEqual(sent.body.text, text);
  }
  const chatResponse = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST", headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ model: "gpt-6-astra", messages: [{ role: "system", content: prefix }], stream: true, reasoning_effort: "none" }),
  });
  assert.equal(chatResponse.status, 200, await chatResponse.text());
  assert.equal(captured.at(-1).body.model, "gpt-6-astra");
  const compatibleResponse = await fetch(`${endpoint}/v1/responses`, {
    method: "POST", headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ model: "gpt-compatible", input: [{ role: "system", content: [{ type: "input_text", text: prefix }] }], stream: true, reasoning: { effort: "none" } }),
  });
  assert.equal(compatibleResponse.status, 200, await compatibleResponse.text());
  assert.equal(captured.at(-1).body.model, "gpt-compatible");
  assert.equal(captured.at(-1).path, "/v1/chat/completions");
  const nonstreamResponse = await fetch(`${endpoint}/v1/responses`, {
    method: "POST", headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "system", content: [{ type: "input_text", text: prefix }] }, { role: "user", content: [{ type: "input_text", text: "Synthetic action: list the working directory." }] }], stream: false, reasoning: { effort: "none" } }),
  });
  assert.equal(nonstreamResponse.status, 200);
  assert.equal((await nonstreamResponse.json()).model, "codex-auto-review");
  for (const verdict of [
    JSON.stringify({ shouldBlock: false, reason: "mock: scoped inspection" }),
    JSON.stringify({ shouldBlock: true, reason: "mock: unauthorized side effect" }),
    "malformed reviewer response",
  ]) {
    const pending = { role: "user", content: [{ type: "input_text", text: "Classifier fixture result: " + verdict }] };
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST", headers, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "system", content: [{ type: "input_text", text: classifierSystem }] }, pending], stream: false, reasoning: { effort: "low" } }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.output[0].content[0].text, verdict, "允许、阻止和格式错误均原样交给宿主，不默认放行");
    assert.deepEqual(captured.at(-1).body.input[1], pending, "不改写不可信待检查内容");
    assert.equal(captured.at(-1).body.input[0].content[0].text, classifierSystem, "不覆盖宿主原政策");
  }
  const beforeFailure = captured.length;
  const failureResponse = await fetch(`${endpoint}/v1/responses`, {
    method: "POST", headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ model: "gpt-6-luna", input: [{ role: "system", content: [{ type: "input_text", text: prefix }] }, { role: "user", content: [{ type: "input_text", text: "Simulate unavailable reviewer." }] }], stream: false, reasoning: { effort: "none" } }),
  });
  assert.equal(failureResponse.status, 400);
  assert.equal((await failureResponse.json()).error.code, "model_not_found");
  assert.equal(captured.length, beforeFailure + 1);
  assert.equal(captured.at(-1).body.model, "codex-auto-review");

  await t.test("管理页修改日志设置后审批规则仍可加载且不重复追加", async () => {
    const response = await fetch(`${endpoint}/v8/management/config`, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + current.mgmtKey, "Content-Type": "application/json" },
      body: JSON.stringify({ observability: { logs: { "request-log": true } } }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.text());
    const saved = await readFile(current.configPath, "utf8");
    validateExistingConfig(current, saved);
    assert.ok(ensureApprovalRouting(saved) === saved, "核心回写后应复用现有规则");
    const values = parseConfigYaml(saved).values;
    assert.equal(values.get(JSON.stringify(["observability", "logs", "request-log"])), true);
    assert.equal(values.get(overrideKey).length, 1);
    assert.equal(values.get(JSON.stringify(["requests", "payload", "override", 0, "params", "input.0.content.1.text"])),
      parseConfigYaml(textConfig).values.get(JSON.stringify(["requests", "payload", "override", 0, "params", "input.0.content.1.text"])));
    await loadConfig({ pluginRoot, env: { BRIDGE_DATA_DIR: root, BRIDGE_PORT: String(port), BRIDGE_API_KEY: "isolated-api" } });
  });
  await t.test("兼容管理 API 全量回写后可重新初始化且不重复审批规则", async () => {
    const response = await fetch(endpoint + "/v0/management/request-retry", {
      method: "PUT", headers: { Authorization: "Bearer " + current.mgmtKey, "Content-Type": "application/json" },
      body: JSON.stringify({ value: 0 }), signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.text());
    const saved = await readFile(current.configPath, "utf8");
    assert.ok(/name: codex-auto-review/.test(saved));
    assert.ok(/input\.0\.content\.1\.text: \|-/.test(saved));
    validateExistingConfig(current, saved);
    assert.ok(ensureApprovalRouting(saved) === saved, "核心回写后应复用现有规则");
    // 1.0.0 起插件不再管理重试参数：核心回写的值原样保留，冷启动只同步托管密钥。
    assert.equal(parseConfigYaml(saved).values.get(JSON.stringify(["routing", "retry", "request-retry"])), 0);

    child.kill();
    await exited;
    const routingLogs = output.split(/\r?\n/).filter(line => line.includes("审批模型切换"));
    assert.ok(routingLogs.length > 0, "GPT 审批切换必须有正常日志");
    for (const line of routingLogs) {
      assert.match(line, /\[info\s*\]/);
      assert.doesNotMatch(line, /\[(?:warn|error)\s*\]/);
      assert.match(line, /provider=codex/);
      assert.match(line, /codex-auto-review/);
      assert.match(line, /thinking=low/);
    }
    const env = { BRIDGE_DATA_DIR: root, BRIDGE_PORT: String(port), BRIDGE_API_KEY: "isolated-api" };
    const reloaded = await loadConfig({ pluginRoot, env });
    await ensureDataDir(reloaded, noSystemProxy);
    const readyYaml = await readFile(reloaded.configPath, "utf8");
    assert.ok(readyYaml === replaceConfigScalar(saved, ["management", "secret-key"], reloaded.mgmtKey),
      "冷启动只同步托管密钥，不改写请求参数");

    child = spawn(binary, ["-local-model", "-config", reloaded.configPath], { cwd: root, windowsHide: true, stdio: "ignore" });
    exited = once(child, "exit");
    let status;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        status = await fetch(endpoint + "/v0/management/request-retry", {
          headers: { Authorization: "Bearer " + reloaded.mgmtKey }, signal: AbortSignal.timeout(500),
        });
        break;
      } catch { await delay(50); }
    }
    assert.equal(status?.status, 200, "管理 API 应接受冷启动后同一持久密钥");
    assert.equal((await status.json())["request-retry"], 0);
  });
});
