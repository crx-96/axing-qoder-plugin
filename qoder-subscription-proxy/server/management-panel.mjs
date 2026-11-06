import { appendConfigBlock, parseConfigYaml, replaceConfigScalar } from "./config-yaml.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PANEL_UPSTREAM_SHA256 = "8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5";
// 插件版本可保持不变，运行中的页面修订仍必须明确区分。
export const PANEL_REVISION = "antigravity-auto-fallback-v3";
const upstreamPath = fileURLToPath(new URL("./panel/management.upstream.html", import.meta.url));

// 此函数会嵌入浏览器代码，必须自包含；回调地址只能作为数据提交，不能导航或请求它。
export function validateAntigravityCallback(text, expectedState) {
  if (typeof text !== "string" || typeof expectedState !== "string" ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(expectedState) || expectedState.includes("..")) return null;
  const value = text.trim();
  if (value.length > 16384 || /[\s\\#\u0000-\u001f\u007f]/.test(value) ||
      /%(?![0-9a-f]{2})/i.test(value) || !value.startsWith("http://localhost:51121/oauth-callback?")) return null;
  try {
    const url = new URL(value);
    if (url.origin !== "http://localhost:51121" || url.pathname !== "/oauth-callback" || url.username || url.password) return null;
    const names = new Set();
    for (const [key, item] of url.searchParams) {
      if (names.has(key) || /[\u0000-\u001f\u007f]/.test(key + item)) return null;
      names.add(key);
    }
    if (url.searchParams.has("error") || url.searchParams.has("error_description") ||
        url.searchParams.get("state") !== expectedState || !url.searchParams.get("code")?.trim()) return null;
    return value;
  } catch { return null; }
}

// 嵌入浏览器后使用上游 ApiError 契约，只对监听失败重新创建手动授权会话。
export async function startAntigravityAuth(request, signal) {
  signal?.throwIfAborted();
  try {
    return { ...await request(true), callbackMode: "automatic" };
  } catch (error) {
    if (signal?.aborted || error?.status !== 500 || error?.data?.error !== "failed to start callback server") throw error;
  }
  return { ...await request(false), callbackMode: "manual" };
}

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error("管理页补丁与固定上游版本不匹配；未生成页面。");
  return text.replace(before, () => after);
}

// 不直接维护压缩后的第三方代码：只对校验过的原资产应用可重现、唯一匹配的补丁。
export function patchManagementPanel(bytes) {
  if (createHash("sha256").update(bytes).digest("hex") !== PANEL_UPSTREAM_SHA256) {
    throw new Error("随包管理页 SHA256 校验失败；请检查插件文件完整性。");
  }
  let text = bytes.toString("utf8");
  text = replaceOnce(text,
    "startAuth:(e,t)=>{let n=by(e),r={provider:n};return Uee.has(n)&&(r.is_webui=!0),W.get(`/oauth/auth-url`,{params:r,...t?{signal:t}:{}})}",
    `startAuth:(e,t)=>{let n=by(e),r={provider:n};return Uee.has(n)&&(r.is_webui=!0),n===\`antigravity\`?(${startAntigravityAuth.toString()})(r=>W.get(\`/oauth/auth-url\`,{params:{provider:n,is_webui:r},...t?{signal:t}:{}}),t):W.get(\`/oauth/auth-url\`,{params:r,...t?{signal:t}:{}})}`);
  text = replaceOnce(text, "p(e,{url:void 0,userCode:void 0,state:void 0,status:`waiting`",
    "p(e,{url:void 0,userCode:void 0,state:void 0,callbackMode:void 0,status:`waiting`");
  text = replaceOnce(text, "p(e,{url:r.url,userCode:r.user_code,state:r.state,status:`waiting`,polling:!0})",
    "p(e,{url:r.url,userCode:r.user_code,state:r.state,callbackMode:r.callbackMode,status:`waiting`,polling:!0})");
  text = replaceOnce(text, "aside:(0,V.jsx)(`span`,{className:q.optional,children:i(`auth_login.optional_step`)})",
    "aside:(e!==`antigravity`||t.callbackMode!==`manual`)&&(0,V.jsx)(`span`,{className:q.optional,children:i(`auth_login.optional_step`)})");
  text = replaceOnce(text, "className:q.stepHint,id:o,children:i(d)",
    "className:q.stepHint,id:o,children:i(e===`antigravity`&&t.callbackMode===`manual`?`auth_login.antigravity_manual_callback_hint`:d)");
  text = replaceOnce(text, "placeholder:i(f),disabled:u,autoComplete:`off`",
    "placeholder:e===`antigravity`?`http://localhost:51121/oauth-callback?code=...&state=...`:i(f),disabled:u,autoComplete:`off`");
  text = replaceOnce(text, "Qne=(e,t,n)=>e===`xai`?Zne(t,n):t.trim()",
    `Qne=(e,t,n)=>e===\`antigravity\`?(${validateAntigravityCallback.toString()})(t,n):e===\`xai\`?Zne(t,n):t.trim()`);
  text = replaceOnce(text, "r(e===`xai`?`auth_login.xai_callback_state_missing`:`auth_login.missing_state`)",
    "r(e===`antigravity`?`auth_login.antigravity_callback_invalid`:e===`xai`?`auth_login.xai_callback_state_missing`:`auth_login.missing_state`)");
  text = replaceOnce(text,
    "antigravity_oauth_hint:`通过 OAuth 流程登录 Antigravity（Google 账号）服务，自动获取并保存认证文件。`",
    "antigravity_callback_invalid:`请粘贴本次授权的完整 localhost:51121 回调地址，确认包含 code 和匹配的 state；取消或过期后请重新开始。`,antigravity_manual_callback_hint:`本机回调监听启动失败，已切换为手动回填。完成 Google 授权后，请复制地址栏完整的 localhost:51121 回调 URL，回到此处粘贴并提交；回调页无法访问不影响手动提交。请勿向其他页面提交授权信息或分享回调地址。`,antigravity_oauth_hint:`默认自动接收 Google 授权回调，无需手动粘贴；只有本机 51121 回调端口无法监听时才切换为手动回填。请在 5 分钟内完成授权，不要分享回调地址。`");
  text = replaceOnce(text,
    "antigravity_oauth_hint:`Login to Antigravity service (Google account) through OAuth flow, automatically obtain and save authentication files.`",
    "antigravity_callback_invalid:`Paste the full localhost:51121 callback URL from this attempt, including code and matching state. Restart if cancelled or expired.`,antigravity_manual_callback_hint:`The local callback listener could not start, so manual callback mode is active. After Google authorization, copy the full localhost:51121 callback URL and submit it here, even if the callback page cannot be reached. Do not submit authorization details to another page or share the callback URL.`,antigravity_oauth_hint:`Google authorization callbacks are received automatically by default. Manual callback is used only when the local listener on port 51121 cannot start. Finish within five minutes and do not share the callback URL.`");
  return text;
}

/** 禁用自动更新，确保加载固定的管理页补丁；字段定位沿用启动校验的 YAML 路径。 */
export function disablePanelAutoUpdate(text) {
  const parsed = parseConfigYaml(text);
  const section = ["management"];
  const field = [...section, "disable-auto-update-panel"];
  if (parsed.nodes.get(JSON.stringify(section))?.kind !== "map") {
    throw new Error("config.yaml 缺少有效的 management 段，无法固定管理页版本。");
  }
  // 仅插入缺失项，已存在的非布尔值不得当成 false 处理。
  if (!parsed.nodes.has(JSON.stringify(field))) {
    return appendConfigBlock(parsed, section, "map", indent => " ".repeat(indent) + "disable-auto-update-panel: true");
  }
  const value = parsed.values.get(JSON.stringify(field));
  if (typeof value !== "boolean") throw new Error("config.yaml 的 disable-auto-update-panel 不是布尔值；未修改配置。");
  return value ? text : replaceConfigScalar(text, field, true);
}

// 调用方须持有生命周期锁；完整写入后原子替换，避免核心读到半份配置。
async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

// 使用内容寻址的独立目录，既不覆盖用户原 static 页面，也不改写宿主安装缓存。
export async function prepareManagementPanel(config) {
  const text = patchManagementPanel(await readFile(upstreamPath));
  const digest = createHash("sha256").update(text).digest("hex");
  const directory = join(config.dataDir, "management-panel", digest);
  const target = join(directory, "management.html");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let existing;
  try { existing = await readFile(target, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined && existing !== text) throw new Error("受控管理页已被外部修改；未覆盖文件。");
  if (existing === undefined) await atomicWrite(target, text);
  const original = await readFile(config.configPath, "utf8");
  const updated = disablePanelAutoUpdate(original);
  if (updated !== original) await atomicWrite(config.configPath, updated);
  return directory;
}
