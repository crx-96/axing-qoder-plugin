import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { patchManagementPanel, validateAntigravityCallback, disablePanelAutoUpdate, prepareManagementPanel } from "../bridge/management-panel.mjs";
import { renderConfigYaml } from "../bridge/config.mjs";

const upstream = await readFile(new URL("../bridge/panel/management.upstream.html", import.meta.url));
const patched = patchManagementPanel(upstream);
const state = "test-state-123";
const callback = `http://localhost:51121/oauth-callback?code=sample-code&state=${state}`;

function authClient(html) {
  const fragment = html.match(/startAuth:\(e,t\)=>\{let n=by\(e\),r=\{provider:n\};return [\s\S]*?W\.get\(`\/oauth\/auth-url`,\{params:r,\.\.\.t\?\{signal:t\}:\{\}\}\)\}/)?.[0];
  assert.ok(fragment, "固定版本应包含唯一授权客户端");
  return vm.runInNewContext(`({${fragment}})`, {
    by: (provider) => provider === "anthropic" ? "claude" : provider,
    Uee: new Set(["codex", "claude", "antigravity", "xai", "devin"]),
    W: { get: (path, options) => ({ path, ...options }) },
  });
}

test("实际管理页的授权客户端只对 Antigravity 禁用监听，保留取消信号", () => {
  const original = authClient(upstream.toString());
  assert.equal(original.startAuth("antigravity").params.is_webui, true);
  const client = authClient(patched);
  const signal = new AbortController().signal;
  for (const provider of ["antigravity", "codex", "anthropic", "xai", "devin"]) {
    const result = client.startAuth(provider, signal);
    assert.equal(result.params.is_webui, provider !== "antigravity");
    assert.equal(result.signal, signal);
    assert.equal(result.path, "/oauth/auth-url");
  }
  assert.equal(Object.hasOwn(client.startAuth("kimi").params, "is_webui"), false);
  assert.match(patched, /当前使用手动回调模式/);
  assert.match(patched, /Manual callback mode/);
});

test("嵌入页面的回调校验可独立执行，不影响其他提供商", () => {
  const start = patched.indexOf("Qne=(e,t,n)=>");
  const end = patched.indexOf(",AM=", start);
  assert.ok(start > 0 && end > start);
  const normalize = vm.runInNewContext(`(${patched.slice(start + 4, end)})`, { URL, Zne: () => "xai-unchanged" });
  assert.equal(normalize("antigravity", callback, state), callback);
  assert.equal(normalize("antigravity", callback, "other-state"), null);
  assert.equal(normalize("xai", "code", "state"), "xai-unchanged");
  assert.equal(normalize("codex", " other callback "), "other callback");
});

test("回调只接受本次 state 和固定地址，拒绝错误、重复参数和规范化绕过", () => {
  assert.equal(validateAntigravityCallback(` ${callback} `, state), callback);
  for (const value of [
    "", null, callback.replace("localhost", "127.0.0.1"), callback.replace("http:", "https:"),
    callback.replace("51121", "1455"), callback.replace("localhost", "localhost.evil.test"),
    callback.replace("/oauth-callback", "/wrong/../oauth-callback"), `${callback}#fragment`,
    `${callback}&state=${state}`, `${callback}&%73tate=${state}`, `${callback}&error=access_denied`,
    `${callback}&error_description=cancelled`, callback.replace("sample-code", ""),
    callback.replace("sample-code", "%0Acode"), callback.replace("sample-code", "bad%ZZ"),
    callback.replace(state, "wrong-state"), `${callback}&code=second`,
  ]) assert.equal(validateAntigravityCallback(value, state), null);
  assert.equal(validateAntigravityCallback(callback, ""), null);
  assert.equal(validateAntigravityCallback(callback, "unsafe..state"), null);
});

test("未知或已补丁资产不能重复修改，生成的脚本保持有效语法", () => {
  assert.throws(() => patchManagementPanel(Buffer.from(patched)), /SHA256/);
  assert.throws(() => patchManagementPanel(Buffer.from("unknown")), /SHA256/);
  const scripts = [...patched.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  for (const [, script] of scripts) {
    // 上游单文件包是 module；此处仅检查语法，不执行，import.meta 用等价表达式占位。
    if (script.trim()) new vm.Script(script.replaceAll("import.meta", "({url:'https://syntax-test.invalid/'})"));
  }
});

test("Windows Git 换行转换开启后检出管理页仍保留原始字节和固定哈希", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "subscription-panel-git-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assetPath = "qoder-subscription-proxy/bridge/panel/management.upstream.html";
  await mkdir(join(directory, "qoder-subscription-proxy/bridge/panel"), { recursive: true });
  await writeFile(join(directory, ".gitattributes"), await readFile(new URL("../../.gitattributes", import.meta.url)));
  await writeFile(join(directory, assetPath), upstream);
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git("init", "--quiet");
  git("config", "core.autocrlf", "true");
  git("add", ".gitattributes", assetPath);
  await rm(join(directory, assetPath));
  git("checkout-index", "--", assetPath);
  const checkedOut = await readFile(join(directory, assetPath));
  assert.deepEqual(checkedOut, upstream);
  assert.doesNotThrow(() => patchManagementPanel(checkedOut));
});

test("迁移仅修改管理页自动更新字段，保留缩进、注释、换行及其他配置", () => {
  const original = "# user config\r\nmanagement:\r\n    secret-key: \"test\"\r\n    allow-remote: false\r\nrequests:\r\n    proxy-url: \"http://proxy.local:7890\"\r\n";
  const updated = disablePanelAutoUpdate(original);
  assert.equal(updated.replace("    disable-auto-update-panel: true\r\n", ""), original);
  assert.equal(disablePanelAutoUpdate(updated), updated);
  const disabled = updated.replace("disable-auto-update-panel: true", "disable-auto-update-panel: false # keep comment");
  assert.equal(disablePanelAutoUpdate(disabled), updated.replace("disable-auto-update-panel: true", "disable-auto-update-panel: true # keep comment"));
  assert.throws(() => disablePanelAutoUpdate("server:\n  port: 1234\n"), /management/);
  assert.throws(() => disablePanelAutoUpdate(updated.replace("disable-auto-update-panel: true", 'disable-auto-update-panel: "false"')), /布尔值/);
});

test("受控页面按内容发布并幂等复用，不覆盖原页面或被外部修改的副本", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "subscription-panel-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = {
    dataDir, configPath: join(dataDir, "config.yaml"), authDir: join(dataDir, "auths"),
    host: "127.0.0.1", port: 12345, apiKey: "isolated-api", mgmtKey: "123456",
  };
  await mkdir(join(dataDir, "static"));
  await writeFile(join(dataDir, "static", "management.html"), "user-owned-page");
  const original = renderConfigYaml(config).replace("  disable-auto-update-panel: true\n", "");
  await writeFile(config.configPath, original);
  const directory = await prepareManagementPanel(config);
  assert.equal(await readFile(join(directory, "management.html"), "utf8"), patched);
  assert.equal(await readFile(join(dataDir, "static", "management.html"), "utf8"), "user-owned-page");
  const first = await stat(join(directory, "management.html"));
  assert.equal(await prepareManagementPanel(config), directory);
  assert.equal((await stat(join(directory, "management.html"))).mtimeMs, first.mtimeMs);
  assert.equal(await readFile(config.configPath, "utf8"), disablePanelAutoUpdate(original));
  assert.ok(!(await readdir(dataDir)).some((name) => name.endsWith(".tmp")));
  await writeFile(join(directory, "management.html"), "external-change");
  await assert.rejects(prepareManagementPanel(config), /外部修改/);
  assert.equal(await readFile(join(directory, "management.html"), "utf8"), "external-change");
});
