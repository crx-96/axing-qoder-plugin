import assert from "node:assert/strict";
import test from "node:test";
import { appendConfigBlock, parseConfigYaml, replaceConfigScalar } from "../server/config-yaml.mjs";
import { disablePanelAutoUpdate } from "../server/management-panel.mjs";

test("普通键和多词标量保留注释、大小写、下划线与 CRLF", () => {
  const text = "headers:\r\n  X-Custom-Header: Bearer two words  # keep  \r\n  _Request_ID: hello 世界\r\n";
  const parsed = parseConfigYaml(text);
  assert.equal(parsed.values.get('["headers","X-Custom-Header"]'), "Bearer two words");
  assert.equal(parsed.values.get('["headers","_Request_ID"]'), "hello 世界");
  assert.equal(replaceConfigScalar(text, ["headers", "X-Custom-Header"], "new"),
    text.replace("Bearer two words", '"new"'));
});

test("单行 flow 集合展开真实路径、列表类型及物理行号", () => {
  const text = 'access: {api-keys: ["x", \'a,b:c#d\']} # keep\r\nextra: [{Name_ID: hello world, nested: [one, {"a.b": "#,:"}]}]\r\n';
  const parsed = parseConfigYaml(text);
  assert.deepEqual(parsed.values.get('["access","api-keys"]'), ["x", "a,b:c#d"]);
  assert.equal(parsed.values.get('["extra",0,"Name_ID"]'), "hello world");
  assert.equal(parsed.values.get('["extra",0,"nested",1,"a.b"]'), "#,:");
  assert.deepEqual(parsed.values.get('["extra"]'), [null]);
  assert.equal(parsed.nodes.get('["access"]').kind, "map");
  assert.equal(parsed.nodes.get('["access","api-keys",1]').line, 0);
  assert.equal(parsed.lines.join(parsed.newline), text);
});

test("flow 内定点替换和追加不破坏同一行兄弟值、注释或 CRLF", () => {
  const text = 'before: keep\r\nmanagement: {secret-key: old multi word, allow-remote: false, nested: {names: ["a,b", x]}} # retain  \r\nafter: unchanged\r\n';
  const replaced = replaceConfigScalar(text, ["management", "secret-key"], "new key");
  assert.equal(replaced, text.replace("old multi word", '"new key"'));
  assert.equal(replaceConfigScalar(text, ["management", "allow-remote"], true), text.replace("false", "true"));
  let added = appendConfigBlock(parseConfigYaml(text), ["management", "nested", "names"], "list", indent => " ".repeat(indent) + '- "c:d#e"');
  assert.deepEqual(parseConfigYaml(added).values.get('["management","nested","names"]'), ["a,b", "x", "c:d#e"]);
  added = appendConfigBlock(parseConfigYaml(added), ["management", "missing", "child"], "map", indent => " ".repeat(indent) + 'new: hello world');
  const parsed = parseConfigYaml(added);
  assert.equal(parsed.values.get('["management","missing","child","new"]'), "hello world");
  assert.equal(parsed.values.get('["management","secret-key"]'), "old multi word");
  assert.ok(added.includes("# retain  \r\nafter: unchanged\r\n"));
  assert.equal(added.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(replaceConfigScalar('a: {empty: null, other: keep}', ["a", "empty"], true, { allowNull: true }), 'a: {empty: true, other: keep}');
});

test("flow 与等价块式配置保持 values 路径及类型契约", () => {
  const block = 'root:\n  names:\n    - x\n    - y\n  rules:\n    - Name: first rule\n      nested:\n        enabled: true\n  empty: {}\n  keys: []\n';
  const flow = 'root: {names: [x, y], rules: [{Name: first rule, nested: {enabled: true}}], empty: {}, keys: []}\n';
  const old = parseConfigYaml(block);
  const current = parseConfigYaml(flow);
  assert.deepEqual(current.values, old.values);
  assert.deepEqual([...current.nodes.keys()], [...old.nodes.keys()]);
  for (const [path, node] of current.nodes) assert.equal(node.kind, old.nodes.get(path).kind);
  const added = appendConfigBlock(current, ["root"], "map", indent => " ".repeat(indent) + 'escaped: "\\u2028"');
  assert.equal(parseConfigYaml(added).values.get('["root","escaped"]'), "\u2028");
});

test("flow 与块列表混排、空容器、尾逗号及转义引号保持可编辑", () => {
  const text = '\uFEFFitems:\r\n  - {"Name_ID":"a\\\"b,c:#", list:[one,], empty: { }, nil: null}\r\n  - [two, {deep: three words}] # row\r\nnext: keep\r\n';
  const parsed = parseConfigYaml(text);
  assert.equal(parsed.values.get('["items",0,"Name_ID"]'), 'a"b,c:#');
  assert.deepEqual(parsed.values.get('["items",1]'), ["two", null]);
  assert.equal(parsed.values.get('["items",1,1,"deep"]'), "three words");
  assert.equal(replaceConfigScalar(text, ["items", 1, 1, "deep"], "new"), text.replace("three words", '"new"'));
  for (const path of [["items", 0, "empty"], ["items", 0, "nil"]]) {
    const result = appendConfigBlock(parsed, path, "map", indent => " ".repeat(indent) + 'added: "ok"');
    assert.equal(parseConfigYaml(result).values.get(JSON.stringify([...path, "added"])), "ok");
    assert.ok(result.startsWith("\uFEFFitems:\r\n"));
    assert.ok(result.endsWith('  - [two, {deep: three words}] # row\r\nnext: keep\r\n'));
  }
  const result = appendConfigBlock(parsed, ["items", 0, "list"], "list", indent => " ".repeat(indent) + '- {extra: [a, b]}');
  assert.equal(parseConfigYaml(result).values.get('["items",0,"list",1,"extra",1]'), "b");
  assert.throws(() => appendConfigBlock(parsed, ["items", 0, "list"], "map", () => '  wrong: true'));
  assert.throws(() => appendConfigBlock(parsed, ["items", 0], "map", () => '  Name_ID: duplicate'));
  assert.equal(replaceConfigScalar('a: {empty: , other: keep}', ["a", "empty"], 3), 'a: {empty: 3, other: keep}');
  const filled = appendConfigBlock(parseConfigYaml('a: {empty: , other: keep}'), ["a", "empty"], "map", () => '  child: true');
  assert.equal(parseConfigYaml(filled).values.get('["a","empty","child"]'), true);
  assert.equal(replaceConfigScalar('a: {plain: old words#literal}', ["a", "plain"], "new"), 'a: {plain: "new"}');
});

test("flow 嵌套仍拒绝重复键、引用、标签、多文档和畸形结构且不回显值", () => {
  for (const raw of [
    '{a: 1, "a": 2}', '{a: {"\\u0062": 1, b: 2}}', '{"<<": {a: 1}}',
    '[&anchor PRIVATE-FLOW]', '[*PRIVATE-FLOW]', '{a: !tag PRIVATE-FLOW}',
    '[one,, two]', '{a: one b: two}', '[one', '{a: [one}}', '[one] junk',
    '[one # hidden]', '[---]', '[one, ...]',
  ]) assert.throws(() => parseConfigYaml(`extra: ${raw}`), error => {
    assert.match(error.message, /结构不受支持/);
    assert.equal(error.message.includes("PRIVATE-FLOW"), false);
    return true;
  });
});

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
