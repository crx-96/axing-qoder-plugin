import { parseConfigYaml } from "./config-yaml.mjs";

const sourceModels = ["gpt-6-astra", "gpt-6.1-sol"];
const classifierPath = 'input.0.content.#(type=="input_text"&&text%"You are a security classifier for auto permission mode.*").type';
const overridePath = ["requests", "payload", "override"];

export function renderApprovalOverride(indent = 6) {
  const pad = " ".repeat(indent);
  const models = sourceModels.flatMap((model) => ["developer", "system"].flatMap((role) => [
    `${pad}    - name: ${JSON.stringify(model)}`,
    `${pad}      protocol: "codex"`,
    `${pad}      from-protocol: "responses"`,
    `${pad}      match:`,
    `${pad}        - "reasoning.effort": "none"`,
    `${pad}          "input.0.role": ${JSON.stringify(role)}`,
    `${pad}          "input.0.content.#": 1`,
    `${pad}          ${JSON.stringify(classifierPath)}: "input_text"`,
  ]));
  return [
    `${pad}- models:`,
    ...models,
    `${pad}  params:`,
    `${pad}    model: "gpt-6-luna"`,
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

export function ensureApprovalRouting(text) {
  const parsed = parseConfigYaml(text);
  const rules = parsed.values.get(JSON.stringify(overridePath));
  if (Array.isArray(rules) && rules.some((_, index) =>
    ruleSignature(parsed.values, [...overridePath, index]) === policySignature)) return text;

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
  // 只插入目标规则，保留已有配置、顺序、注释和换行风格。
  lines.splice(parent.end, 0, ...added);
  const updated = lines.join(parsed.newline);
  return updated.endsWith(parsed.newline) ? updated : updated + parsed.newline;
}
