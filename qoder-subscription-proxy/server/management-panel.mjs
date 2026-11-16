import { appendConfigBlock, parseConfigYaml, replaceConfigScalar } from "./config-yaml.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PANEL_UPSTREAM_SHA256 = "8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5";
export const PANEL_REVISION = "google-acp-only-v1";
const upstreamPath = fileURLToPath(new URL("./panel/management.upstream.html", import.meta.url));

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error("管理页补丁与固定上游版本不匹配；未生成页面。");
  return text.replace(before, () => after);
}

export function patchManagementPanel(bytes) {
  if (createHash("sha256").update(bytes).digest("hex") !== PANEL_UPSTREAM_SHA256) throw new Error("随包管理页 SHA256 校验失败。");
  let text = bytes.toString("utf8");
  text = replaceOnce(text,
    "startAuth:(e,t)=>{let n=by(e),r={provider:n};return Uee.has(n)&&(r.is_webui=!0),W.get(`/oauth/auth-url`,{params:r,...t?{signal:t}:{}})}",
    "startAuth:(e,t)=>{let n=by(e),r={provider:n};if([`antigravity`,`gemini`,`gemini-cli`,`aistudio`,`vertex`,`google`].includes(n))return Promise.reject(Error(`Google 模型已迁移至 ACP，请打开顶部 Antigravity ACP 管理入口。`));return Uee.has(n)&&(r.is_webui=!0),W.get(`/oauth/auth-url`,{params:r,...t?{signal:t}:{}})}");
  return replaceOnce(text, "</body>", '<a href="/acp" style="position:fixed;right:20px;bottom:20px;z-index:100000;padding:10px 18px;background:#175cd3;color:white;border-radius:8px;font:14px system-ui;text-decoration:none">Antigravity ACP 管理</a></body>');
}

export function disablePanelAutoUpdate(text) {
  const parsed = parseConfigYaml(text);
  const section = ["management"];
  const field = [...section, "disable-auto-update-panel"];
  if (parsed.nodes.get(JSON.stringify(section))?.kind !== "map") throw new Error("config.yaml 缺少有效的 management 段，无法固定管理页版本。");
  if (!parsed.nodes.has(JSON.stringify(field))) return appendConfigBlock(parsed, section, "map", indent => " ".repeat(indent) + "disable-auto-update-panel: true");
  const value = parsed.values.get(JSON.stringify(field));
  if (typeof value !== "boolean") throw new Error("config.yaml 的 disable-auto-update-panel 不是布尔值；未修改配置。");
  return value ? text : replaceConfigScalar(text, field, true);
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export async function prepareManagementPanel(config) {
  const text = patchManagementPanel(await readFile(upstreamPath));
  const digest = createHash("sha256").update(text).digest("hex");
  const directory = join(config.dataDir, "management-panel", digest);
  const target = join(directory, "management.html");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let existing;
  try { existing = await readFile(target, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined && existing !== text) throw new Error("受控管理页已被外部修改；未覆盖文件。");
  if (existing === undefined) await atomicWrite(target, text);
  const original = await readFile(config.configPath, "utf8");
  const updated = disablePanelAutoUpdate(original);
  if (updated !== original) await atomicWrite(config.configPath, updated);
  return directory;
}
