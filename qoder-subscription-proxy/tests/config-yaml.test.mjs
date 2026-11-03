import assert from "node:assert/strict";
import test from "node:test";
import { appendConfigBlock, parseConfigYaml, replaceConfigScalar } from "../bridge/config-yaml.mjs";
import { ensureStreamingDefaults } from "../bridge/config.mjs";
import { disablePanelAutoUpdate } from "../bridge/management-panel.mjs";

test("核心保存的裸通配符和 |- 文字块在读取及插入相邻字段后保持语义", () => {
  const text = [
    "section:", "  model: gpt-*", "  prompt: |- # saved", "    line one", "",
    "      nested", "    # part of the prompt", "# next section", "next: null", "",
  ].join("\r\n");
  const parsed = parseConfigYaml(text);
  assert.equal(parsed.values.get('["section","model"]'), "gpt-*");
  const expected = "line one\n\n  nested\n# part of the prompt";
  assert.equal(parsed.values.get('["section","prompt"]'), expected);
  const updated = appendConfigBlock(parsed, ["section"], "map", indent => " ".repeat(indent) + "new-field: true");
  assert.ok(updated.includes("    # part of the prompt\r\n  new-field: true\r\n# next section"));
  assert.equal(parseConfigYaml(updated).values.get('["section","prompt"]'), expected);
  assert.throws(() => parseConfigYaml("model: *alias"), /结构不受支持/);
  assert.throws(() => parseConfigYaml("server:\n\u00a0\u00a0host: localhost"), /结构不受支持/);
});

test("定点管理配置支持引号键、原行尾注释和 CRLF，并拒绝集合或多行凭据", () => {
  const path = ["management", "secret-key"];
  const from = "'old # key'";
  const to = 'new "quoted" # key';
  const original = '\uFEFF"management":\r\n    "secret-key":   ' + from + "  # keep  \r\n    'disable-auto-update-panel': false # retain\r\n";
  const result = replaceConfigScalar(original, path, to);
  assert.equal(result, original.replace(from, JSON.stringify(to)));
  assert.equal(disablePanelAutoUpdate(result), result.replace("false # retain", "true # retain"));
  assert.equal(replaceConfigScalar(result, path, to), result);
  assert.throws(() => replaceConfigScalar("management:\n  secret-key: |-\n    first\n", path, to));
  assert.throws(() => replaceConfigScalar("management:\n  secret-key:\n    - bad\n", path, to));
  assert.throws(() => replaceConfigScalar("management: {}", path, to));
});

test("v8 旧路径的显式重试、冷却、流式整段和 Codex 配置保留优先级", () => {
  const original = [
    "request-retry: 4", "max-retry-interval: 0", "transient-error-cooldown-seconds: -1",
    "streaming:", "  keepalive-seconds: 45", "  custom-setting: true",
    "oauth:", "  providers:", "    codex:", "      stream-bootstrap-timeout: 30s",
    "codex:", "  stream-bootstrap-buffering: false", "",
  ].join("\n");
  const updated = ensureStreamingDefaults(original);
  const { values, nodes } = parseConfigYaml(updated);
  assert.equal(values.get('["request-retry"]'), 4);
  assert.equal(values.get('["max-retry-interval"]'), 0);
  assert.equal(values.get('["streaming","bootstrap-retries"]'), 1);
  assert.equal(values.get('["streaming","keepalive-seconds"]'), 45);
  for (const path of ['["routing"]', '["requests","streaming"]', '["upstream","codex"]']) assert.equal(nodes.has(path), false);
  assert.equal(ensureStreamingDefaults(updated), updated);
  // 旧段已被新段遮蔽时，按上游优先级只向当前段补项。
  const mixed = ensureStreamingDefaults(original + "requests:\n  streaming:\n    keepalive-seconds: 30\n");
  assert.equal(parseConfigYaml(mixed).values.get('["requests","streaming","bootstrap-retries"]'), 1);
});
