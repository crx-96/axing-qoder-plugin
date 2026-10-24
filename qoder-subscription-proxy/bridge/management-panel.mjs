import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PANEL_UPSTREAM_SHA256 = "8c9c6b7d3fb311e6aad5d06e1993e53a2d28389e640448a1bc6304ed20b057b5";
// 插件版本可保持不变，运行中的页面修订仍必须明确区分。
export const PANEL_REVISION = "antigravity-manual-v1";
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
  text = replaceOnce(text, "Uee.has(n)&&(r.is_webui=!0)", "Uee.has(n)&&(r.is_webui=n!==`antigravity`)");
  text = replaceOnce(text, "aside:(0,V.jsx)(`span`,{className:q.optional,children:i(`auth_login.optional_step`)})",
    "aside:e!==`antigravity`&&(0,V.jsx)(`span`,{className:q.optional,children:i(`auth_login.optional_step`)})");
  text = replaceOnce(text, "placeholder:i(f),disabled:u,autoComplete:`off`",
    "placeholder:e===`antigravity`?`http://localhost:51121/oauth-callback?code=...&state=...`:i(f),disabled:u,autoComplete:`off`");
  text = replaceOnce(text, "Qne=(e,t,n)=>e===`xai`?Zne(t,n):t.trim()",
    `Qne=(e,t,n)=>e===\`antigravity\`?(${validateAntigravityCallback.toString()})(t,n):e===\`xai\`?Zne(t,n):t.trim()`);
  text = replaceOnce(text, "r(e===`xai`?`auth_login.xai_callback_state_missing`:`auth_login.missing_state`)",
    "r(e===`antigravity`?`auth_login.antigravity_callback_invalid`:e===`xai`?`auth_login.xai_callback_state_missing`:`auth_login.missing_state`)");
  text = replaceOnce(text,
    "antigravity_oauth_hint:`通过 OAuth 流程登录 Antigravity（Google 账号）服务，自动获取并保存认证文件。`",
    "antigravity_callback_invalid:`请粘贴本次授权的完整 localhost:51121 回调地址，确认包含 code 和匹配的 state；取消或过期后请重新开始。`,antigravity_oauth_hint:`当前使用手动回调模式，不占用本机端口。打开链接并完成 Google 授权后，跳回 localhost:51121 显示无法访问是预期现象。请复制地址栏完整 URL，回到此窗口粘贴并提交，等待认证成功。请在 5 分钟内完成，不要分享回调地址。`");
  text = replaceOnce(text,
    "antigravity_oauth_hint:`Login to Antigravity service (Google account) through OAuth flow, automatically obtain and save authentication files.`",
    "antigravity_callback_invalid:`Paste the full localhost:51121 callback URL from this attempt, including code and matching state. Restart if cancelled or expired.`,antigravity_oauth_hint:`Manual callback mode: no local callback port is opened. Complete Google authorization using Open Link. The resulting localhost:51121 connection error is expected. Copy the full address, paste it here, submit, and wait for authentication success. Finish within five minutes and do not share the callback URL.`");
  return text;
}

// 上游自动更新会覆盖兼容补丁；仅改变此单一配置项，不重建用户 YAML 或接触凭据。
export function disablePanelAutoUpdate(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^management:\s*(?:#.*)?$/.test(line));
  if (start < 0) throw new Error("config.yaml 缺少 management 段，无法固定管理页版本。");
  let end = start + 1;
  while (end < lines.length && !/^[a-z][a-z0-9-]*:/.test(lines[end])) end++;
  const field = lines.findIndex((line, index) => index > start && index < end && /^ +disable-auto-update-panel:/.test(line));
  if (field >= 0) {
    if (/^ +disable-auto-update-panel: true(?:\s+#.*)?\s*$/.test(lines[field])) return text;
    lines[field] = lines[field].replace(/(:)\s*(?:true|false)(\s*(?:#.*)?)$/, "$1 true$2");
    if (!/^ +disable-auto-update-panel: true(?:\s+#.*)?\s*$/.test(lines[field])) {
      throw new Error("config.yaml 的 disable-auto-update-panel 不是布尔值；未修改配置。");
    }
  } else {
    const indentation = lines.slice(start + 1, end).find((line) => /^ +[a-z]/.test(line))?.match(/^ +/)[0];
    if (!indentation) throw new Error("config.yaml 的 management 段结构无效；未修改配置。");
    lines.splice(start + 1, 0, `${indentation}disable-auto-update-panel: true`);
  }
  return lines.join(text.includes("\r\n") ? "\r\n" : "\n");
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
