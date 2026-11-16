import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { acpError } from "./acp-connection.mjs";
import { parseConfigYaml, appendConfigBlock, replaceConfigScalar } from "./config-yaml.mjs";

const GOOGLE_PROVIDERS = new Set(["antigravity", "gemini", "gemini-cli", "interactions", "aistudio", "vertex", "vertex-ai", "google"]);
export function isLegacyGoogleProvider(provider) { return typeof provider === "string" && GOOGLE_PROVIDERS.has(provider.trim().toLowerCase()); }

function replaceExclusions(text, path, exclusions) {
  const parsed = parseConfigYaml(text);
  const node = parsed.nodes.get(JSON.stringify(path));
  if (!node) return appendConfigBlock(parsed, path.slice(0, -1), "map", indent => " ".repeat(indent) + path.at(-1) + ": " + JSON.stringify(exclusions));
  if (node.kind !== "list" && parsed.values.get(JSON.stringify(path)) !== null) throw acpError("GOOGLE_CONFIG_CONFLICT", "已有模型排除规则不是列表，未修改。");
  if (node.flow) {
    const row = parsed.lines[node.line];
    parsed.lines[node.line] = row.slice(0, node.flow.start) + JSON.stringify(exclusions) + row.slice(node.flow.end);
  } else {
    let end = node.end;
    while (end > node.line + 1 && /^\s*(?:#.*)?$/.test(parsed.lines[end - 1])) end--;
    parsed.lines.splice(node.line, end - node.line, " ".repeat(node.indent) + path.at(-1) + ": " + JSON.stringify(exclusions));
  }
  const result = parsed.lines.join(parsed.newline);
  parseConfigYaml(result);
  return result;
}

function yamlValue(parsed, path) {
  const node = parsed.nodes.get(JSON.stringify(path));
  if (node?.kind === "map") return Object.fromEntries([...parsed.nodes.keys()].map(key => JSON.parse(key))
    .filter(parts => parts.length === path.length + 1 && path.every((part, index) => parts[index] === part))
    .map(parts => [parts.at(-1), yamlValue(parsed, parts)]));
  if (node?.kind === "list") return (parsed.values.get(JSON.stringify(path)) ?? []).map((_value, index) => yamlValue(parsed, [...path, index]));
  if (node?.raw?.startsWith("[]")) return [];
  if (node?.raw?.startsWith("{}")) return {};
  return parsed.values.get(JSON.stringify(path)) ?? null;
}

export async function archiveGoogleModels(config, removed, writePrivateFile) {
  if (!removed.length) return;
  const path = join(config.dataDir, "acp-disabled-models.json");
  let original = null, records = [];
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw acpError("GOOGLE_CONFIG_CONFLICT", "已停用模型记录不能是链接或超限文件。");
    original = await readFile(path, "utf8"); records = JSON.parse(original);
  }
  catch (error) { if (error.code !== "ENOENT") throw acpError("GOOGLE_CONFIG_CONFLICT", "无法读取已停用模型记录，未覆盖配置。"); }
  if (!Array.isArray(records)) throw acpError("GOOGLE_CONFIG_CONFLICT", "已停用模型记录格式错误，未覆盖配置。");
  const known = new Set(records.map(record => JSON.stringify(record)));
  for (const item of removed) if (!known.has(JSON.stringify(item))) { records.push(item); known.add(JSON.stringify(item)); }
  await writePrivateFile(path, JSON.stringify(records, null, 2) + "\n", original);
}

export function configureGoogleExclusions(text, removedModels = []) {
  const parsed = parseConfigYaml(text);
  for (const key of ["gemini-api-key", "vertex-api-key", "interactions-api-key"]) {
    const legacy = yamlValue(parsed, [key]);
    if (Array.isArray(legacy) && legacy.length) throw acpError("GOOGLE_CONFIG_CONFLICT", "检测到旧式 Google 凭据配置，请先转换为标准 v8 api-keys 分组；未启动旧通道。");
  }
  if (containsGoogleConfiguration(yamlValue(parsed, ["openai-compatibility"]))) throw acpError("GOOGLE_CONFIG_CONFLICT", "旧式兼容供应商包含 Google 模型，请先转换为标准 v8 分组。");
  const updates = [];
  const disabled = [];
  for (const key of parsed.nodes.keys()) {
    const group = JSON.parse(key);
    if (group.length !== 3 || group[0] !== "api-keys" || typeof group[2] !== "number") continue;
    const name = parsed.values.get(JSON.stringify([...group, "name"]));
    if (name === "antigravity-acp") continue;
    const all = isLegacyGoogleProvider(group[1]) || containsGoogleConfiguration({ "base-url": parsed.values.get(JSON.stringify([...group, "base-url"])) });
    const models = parsed.values.get(JSON.stringify([...group, "models"])) ?? [];
    if (!Array.isArray(models)) throw acpError("GOOGLE_CONFIG_CONFLICT", "模型配置不是列表，无法安全迁移。");
    const excluded = all ? ["*"] : models.map((_model, index) => parsed.values.get(JSON.stringify([...group, "models", index, "name"])))
      .filter(model => typeof model === "string" && /^gemini[-/]/i.test(model.trim()));
    if (!excluded.length) continue;
    if (group[1] === "openai-compatibility") {
      if (parsed.values.get(JSON.stringify([...group, "disabled"])) === true) continue;
      if (all || excluded.length === models.length) { disabled.push([...group, "disabled"]); continue; }
      const definitions = models.map((_model, index) => yamlValue(parsed, [...group, "models", index]));
      const removed = definitions.filter(model => excluded.includes(model.name));
      const retained = definitions.filter(model => !excluded.includes(model.name));
      removedModels.push({ provider: name ?? group[2], models: removed });
      updates.push({ path: [...group, "models"], merged: retained });
      continue;
    }
    const keys = parsed.values.get(JSON.stringify([...group, "keys"])) ?? [];
    if (!Array.isArray(keys)) throw acpError("GOOGLE_CONFIG_CONFLICT", "供应商凭据配置不是列表，无法安全迁移。");
    for (let index = 0; index < keys.length; index++) {
      const path = [...group, "keys", index, "excluded-models"];
      const current = parsed.values.get(JSON.stringify(path)) ?? [];
      if (!Array.isArray(current) || current.some(item => typeof item !== "string")) throw acpError("GOOGLE_CONFIG_CONFLICT", "模型排除规则无效，未修改。");
      const merged = [...new Set([...current, ...excluded])];
      if (merged.length !== current.length) updates.push({ path, merged });
    }
  }
  for (const update of updates) text = replaceExclusions(text, update.path, update.merged);
  for (const path of disabled) {
    const current = parseConfigYaml(text);
    text = current.nodes.has(JSON.stringify(path)) ? replaceConfigScalar(text, path, true, { allowNull: true })
      : appendConfigBlock(current, path.slice(0, -1), "map", indent => " ".repeat(indent) + "disabled: true");
  }
  return text;
}

export async function disableGoogleAuthFiles(config, writePrivateFile) {
  const names = await readdir(config.authDir);
  let count = 0;
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const path = join(config.authDir, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw acpError("GOOGLE_MIGRATION_FAILED", "授权目录含无法安全检查的文件，未启动核心。");
    let record, original;
    try { original = await readFile(path, "utf8"); record = JSON.parse(original); }
    catch { throw acpError("GOOGLE_MIGRATION_FAILED", "授权文件无法安全解析，未启动核心。"); }
    if (!isLegacyGoogleProvider(record.type ?? record.provider) || record.disabled === true) continue;
    await writePrivateFile(path, JSON.stringify({ ...record, disabled: true }, null, 2) + "\n", original);
    count++;
  }
  return count;
}

export async function disableGoogleCredentials(config, request) {
  const list = await request(config, "/v0/management/auth-files", { management: true });
  if (list.status !== 200) throw acpError("GOOGLE_MIGRATION_FAILED", "无法验证旧 Google 授权已停用。");
  let files;
  try { files = JSON.parse(list.text).files; } catch {}
  if (!Array.isArray(files)) throw acpError("GOOGLE_MIGRATION_FAILED", "核心未提供有效授权目录。");
  let count = 0;
  for (const credential of files) {
    if (!isLegacyGoogleProvider(credential.provider ?? credential.type) || credential.disabled === true) continue;
    if (typeof credential.name !== "string") throw acpError("GOOGLE_MIGRATION_FAILED", "无法确定旧 Google 授权的管理标识。");
    const result = await request(config, "/v0/management/auth-files/status", { management: true, method: "PATCH",
      body: { name: credential.name, ...(credential.auth_index ? { auth_index: credential.auth_index } : {}), disabled: true } });
    if (result.status !== 200) throw acpError("GOOGLE_MIGRATION_FAILED", "核心未能停用旧 Google 授权；未报告代理就绪。");
    count++;
  }
  return count;
}

export function containsGoogleConfiguration(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsGoogleConfiguration);
  if (isLegacyGoogleProvider(value.provider ?? value.type) ||
      [value.name, value.model].some(item => typeof item === "string" && /^gemini[-/]/i.test(item.trim()))) return true;
  for (const [key, item] of Object.entries(value)) {
    if (["base-url", "base_url"].includes(key) && typeof item === "string") {
      try { const host = new URL(item).hostname.replace(/\.$/, ""); if (host === "googleapis.com" || host.endsWith(".googleapis.com")) return true; } catch {}
    }
    if (isLegacyGoogleProvider(key) && item !== null && item !== false && (!Array.isArray(item) || item.length > 0)) return true;
    if (containsGoogleConfiguration(item)) return true;
  }
  return false;
}

export function blockedGoogleManagement(path, method) {
  const url = new URL(path, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);
  if (["GET", "HEAD"].includes(method) && !pathname.includes("auth-url")) return false;
  const provider = url.searchParams.get("provider");
  return isLegacyGoogleProvider(provider) || /\/(?:antigravity|gemini-cli|gemini|interactions|vertex|aistudio)(?:[/-]|$)/i.test(pathname);
}
