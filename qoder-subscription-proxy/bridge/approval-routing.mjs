import { parseConfigYaml } from "./config-yaml.mjs";

const classifierPath = 'input.0.content.#(type=="input_text"&&text%"You are a security classifier for auto permission mode.*").type';
const overridePath = ["requests", "payload", "override"];

export function renderApprovalOverride(indent = 6, sourceModels = ["gpt-*"], targetModel = "codex-auto-review", efforts = ["none", "low"]) {
  const pad = " ".repeat(indent);
  // match 列表是 AND；快速检查与复核必须使用独立的模型选择器。
  const models = sourceModels.flatMap((model) => ["developer", "system"].flatMap((role) => efforts.flatMap(effort => [
    `${pad}    - name: ${JSON.stringify(model)}`,
    `${pad}      protocol: "codex"`,
    `${pad}      from-protocol: "responses"`,
    `${pad}      match:`,
    `${pad}        - "reasoning.effort": ${JSON.stringify(effort)}`,
    `${pad}          "input.0.role": ${JSON.stringify(role)}`,
    `${pad}          "input.0.content.#": 1`,
    `${pad}          ${JSON.stringify(classifierPath)}: "input_text"`,
  ])));
  return [
    `${pad}- models:`,
    ...models,
    `${pad}  params:`,
    `${pad}    model: ${JSON.stringify(targetModel)}`,
    `${pad}    "reasoning.effort": "low"`,
  ].join("\n");
}

function ruleSignature(values, prefix) {
  return JSON.stringify([...values].flatMap(([key, value]) => {
    const path = JSON.parse(key);
    if (path.length < prefix.length || !prefix.every((part, index) => path[index] === part)) return [];
    return [[JSON.stringify(path.slice(prefix.length)), value]];
  }).sort(([left], [right]) => left.localeCompare(right)));
}

const policyValues = parseConfigYaml(`override:\n${renderApprovalOverride(2)}\n`).values;
const policySignature = ruleSignature(policyValues, ["override", 0]);
const legacyValues = parseConfigYaml(`override:\n${renderApprovalOverride(2, ["gpt-6-astra", "gpt-6.1-sol"], "gpt-6-luna", ["none"])}\n`).values;
const legacySignature = ruleSignature(legacyValues, ["override", 0]);

export function ensureApprovalRouting(text) {
  const parsed = parseConfigYaml(text);
  const rules = parsed.values.get(JSON.stringify(overridePath));
  const signatures = Array.isArray(rules)
    ? rules.map((_, index) => ruleSignature(parsed.values, [...overridePath, index]))
    : [];
  const legacyIndexes = new Set(signatures.flatMap((signature, index) => signature === legacySignature ? [index] : []));
  if (legacyIndexes.size) {
    // 只移除完整匹配旧内置规则的语法行，用户修改过的规则、注释及空行保留。
    const removedLines = new Set();
    for (const [key, node] of parsed.nodes) {
      const path = JSON.parse(key);
      if (overridePath.every((part, index) => path[index] === part) && legacyIndexes.has(path[overridePath.length])) {
        removedLines.add(node.line);
      }
    }
    return ensureApprovalRouting(parsed.lines.filter((_, index) => !removedLines.has(index)).join(parsed.newline));
  }
  if (signatures.includes(policySignature)) return text;

  let parent = parsed.nodes.get("[]");
  let depth = 0;
  for (; depth < overridePath.length; depth++) {
    const node = parsed.nodes.get(JSON.stringify(overridePath.slice(0, depth + 1)));
    if (!node) break;
    const expectedKind = depth === 2 ? "list" : "map";
    const empty = node.raw?.replace(/\s+#.*$/, "").trim();
    const allowedEmpty = [undefined, "null", "~", expectedKind === "list" ? "[]" : "{}"];
    if (node.kind !== expectedKind && !(node.kind === null && allowedEmpty.includes(empty))) {
      throw new Error("config.yaml 的 requests.payload.override 必须为标准映射及规则列表；未修改审批模型配置。");
    }
    parent = node;
  }

  const lines = [...parsed.lines];
  if (parent.raw !== undefined && !parent.raw.startsWith("#")) {
    lines[parent.line] = lines[parent.line].replace(/(?:\{\}|\[\]|null|~)(\s*(?:#.*)?)$/, "$1").trimEnd();
  }
  let indent = parent.childIndent ?? (parent.indent < 0 ? 0 : parent.indent + 2);
  const added = [];
  for (; depth < overridePath.length; depth++) {
    added.push(`${" ".repeat(indent)}${overridePath[depth]}:`);
    indent += 2;
  }
  added.push(...renderApprovalOverride(indent).split("\n"));
  // 将同级段之前的注释留在原段前，不插入到注释与其目标之间。
  let insertion = parent.end;
  while (insertion > parent.line + 1 && /^\s*(?:#.*)?$/.test(lines[insertion - 1])) insertion--;
  lines.splice(insertion, 0, ...added);
  const updated = lines.join(parsed.newline);
  return updated.endsWith(parsed.newline) ? updated : updated + parsed.newline;
}
