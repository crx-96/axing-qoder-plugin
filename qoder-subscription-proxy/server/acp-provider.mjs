import { parseConfigYaml, appendConfigBlock } from "./config-yaml.mjs";

export const ACP_PROVIDER = "antigravity-acp";

export function readAcpModels(text) {
  const parsed = parseConfigYaml(text);
  const path = ["api-keys", "openai-compatibility"];
  const providers = parsed.values.get(JSON.stringify(path)) ?? [];
  if (!Array.isArray(providers)) return [];
  for (let index = 0; index < providers.length; index++) {
    const group = [...path, index];
    if (parsed.values.get(JSON.stringify([...group, "name"])) !== ACP_PROVIDER ||
        parsed.values.get(JSON.stringify([...group, "headers", "X-Qoder-ACP-Bridge"])) !== "1") continue;
    const models = parsed.values.get(JSON.stringify([...group, "models"])) ?? [];
    if (!Array.isArray(models)) throw new Error("已保存的 ACP 模型目录无效。");
    return models.map((_model, modelIndex) => {
      const id = parsed.values.get(JSON.stringify([...group, "models", modelIndex, "name"]));
      if (typeof id !== "string" || !id.startsWith("acp/")) throw new Error("已保存的 ACP 模型命名空间无效。");
      return { id: id.slice(4), name: parsed.values.get(JSON.stringify([...group, "models", modelIndex, "display-name"])) ?? id };
    });
  }
  return [];
}

export function configureAcpProvider(text, models, endpoint, key) {
  const provider = { name: ACP_PROVIDER, "base-url": endpoint, "request-retry": 0, headers: { "X-Qoder-ACP-Bridge": "1" },
    keys: [{ "api-key": key, "proxy-url": "direct" }],
    models: models.map(model => ({ name: model.id, alias: model.id, "display-name": model.name })) };
  const path = ["api-keys", "openai-compatibility"];
  const parsed = parseConfigYaml(text);
  const entries = parsed.values.get(JSON.stringify(path));
  if (entries != null && !Array.isArray(entries)) throw new Error("OpenAI 上游配置不是列表，未修改用户配置。");
  const matches = [];
  for (let index = 0; index < (entries?.length ?? 0); index++) {
    if (parsed.values.get(JSON.stringify([...path, index, "name"])) === ACP_PROVIDER) matches.push(index);
  }
  if (matches.length > 1) throw new Error("存在重复的 ACP 专用上游配置，未修改。");
  if (!matches.length) {
    return appendConfigBlock(parsed, path, "list", indent => " ".repeat(indent) + "- " + JSON.stringify(provider));
  }
  if (parsed.values.get(JSON.stringify([...path, matches[0], "headers", "X-Qoder-ACP-Bridge"])) !== "1") {
    throw new Error("ACP 专用供应商名称已被用户配置占用，未覆盖原配置。");
  }
  const node = parsed.nodes.get(JSON.stringify([...path, matches[0]]));
  if (node.flow) {
    const row = parsed.lines[node.line];
    parsed.lines[node.line] = row.slice(0, node.flow.start) + JSON.stringify(provider) + row.slice(node.flow.end);
  } else {
    let end = node.end;
    while (end > node.line + 1 && /^\s*(?:#.*)?$/.test(parsed.lines[end - 1])) end--;
    parsed.lines.splice(node.line, end - node.line, " ".repeat(node.indent) + "- " + JSON.stringify(provider));
  }
  const result = parsed.lines.join(parsed.newline);
  parseConfigYaml(result);
  return result;
}
