import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { patchManagementPanel, disablePanelAutoUpdate, prepareManagementPanel } from "../server/management-panel.mjs";
import { renderConfigYaml } from "../server/config.mjs";

const upstream = await readFile(new URL("../server/panel/management.upstream.html", import.meta.url));
const patched = patchManagementPanel(upstream);
const acpPage = await readFile(new URL("../server/panel/acp.html", import.meta.url), "utf8");

async function acpPageFixture(fetch, token = "synthetic-session") {
  const elements = Object.fromEntries(["status", "models", "connect", "stop", "refresh", "method", "login"].map(id => [id, {
    textContent: "", disabled: false, value: "oauth-personal", children: [], replaceChildren(...items) { this.children = items; },
  }]));
  const buttons = [elements.connect, elements.stop, elements.refresh, elements.login];
  const timers = new Set();
  const context = vm.createContext({
    document: { querySelector: selector => elements[selector.slice(1)], createElement: () => ({ textContent: "" }),
      querySelectorAll: selector => selector === "button" ? buttons : [elements.connect, elements.login] },
    sessionStorage: { getItem: () => token }, fetch,
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
  });
  vm.runInContext(acpPage.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, timers };
}

const pageResponse = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test("ACP 页面连接、认证、停用及登录失效状态可观察", async () => {
  const calls = [];
  const { elements, timers } = await acpPageFixture(async (path, options) => {
    calls.push({ path, options });
    return pageResponse({ state: path.endsWith("stop") ? "stopped" : path.endsWith("status") ? "not_connected" : "ready",
      models: path.endsWith("stop") ? [] : [{ id: "acp/test", name: "<script>synthetic</script>" }] });
  });
  assert.match(elements.status.textContent, /尚未连接/);
  await elements.connect.onclick(); assert.match(elements.status.textContent, /已就绪/);
  assert.equal(elements.models.children[0].textContent, "acp/test — <script>synthetic</script>");
  elements.method.value = "gemini-api-key";
  await elements.login.onclick();
  assert.equal(JSON.parse(calls.at(-1).options.body).methodId, "gemini-api-key");
  assert.equal(calls.at(-1).options.headers.Authorization, "Bearer synthetic-session");
  await elements.stop.onclick(); assert.match(elements.status.textContent, /已停用/);
  assert.equal(elements.models.children.length, 0); assert.equal(timers.size, 0);
  assert.equal(elements.connect.disabled, false);
  const expired = await acpPageFixture(async () => assert.fail("无会话不得发请求"), null);
  assert.match(expired.elements.status.textContent, /登录已过期/);
  for (const status of [401, 403]) {
    const rejected = await acpPageFixture(async () => pageResponse({}, status));
    assert.match(rejected.elements.status.textContent, /登录已过期或请求被拒/);
  }
  const malformed = await acpPageFixture(async () => ({ status: 200, ok: true, json: async () => { throw Error(); } }));
  assert.match(malformed.elements.status.textContent, /无效状态/);
});

test("ACP 页面停用后不会被迟到连接响应覆盖，重复连接不重复提交", async () => {
  let complete, connects = 0;
  const { elements, timers } = await acpPageFixture(async path => {
    if (path.endsWith("connect")) { connects++; return new Promise(resolve => { complete = resolve; }); }
    return pageResponse({ state: path.endsWith("stop") ? "stopped" : "not_connected", models: [] });
  });
  const connecting = elements.connect.onclick();
  assert.equal(elements.connect.disabled, true);
  await elements.connect.onclick(); assert.equal(connects, 1);
  await elements.stop.onclick(); assert.match(elements.status.textContent, /已停用/);
  complete(pageResponse({ state: "ready", models: [{ id: "acp/stale" }] })); await connecting;
  assert.match(elements.status.textContent, /已停用/); assert.equal(elements.models.children.length, 0);
  assert.equal(elements.connect.disabled, false); assert.equal(timers.size, 0);
});
function authClient(html, get) {
  const fragment = html.match(/startAuth:\(e,t\)=>\{let n=by\(e\),r=\{provider:n\};[\s\S]*?W\.get\(`\/oauth\/auth-url`,\{params:r,\.\.\.t\?\{signal:t\}:\{\}\}\)\}/)?.[0];
  assert.ok(fragment);
  return vm.runInNewContext(`({${fragment}})`, { by: provider => provider === "anthropic" ? "claude" : provider,
    Uee: new Set(["codex", "claude", "antigravity", "xai", "devin"]), W: { get } });
}

test("管理页阻止旧 Google 授权并保留非 Google 授权和取消信号", async () => {
  const calls = [];
  const client = authClient(patched, (path, options) => { calls.push({ path, ...options }); return { path, ...options }; });
  for (const provider of ["antigravity", "gemini", "gemini-cli", "aistudio", "vertex", "google"]) {
    await assert.rejects(client.startAuth(provider), /ACP/);
  }
  assert.equal(calls.length, 0);
  const signal = new AbortController().signal;
  for (const provider of ["codex", "anthropic", "xai", "devin"]) {
    const result = await client.startAuth(provider, signal);
    assert.equal(result.params.is_webui, true); assert.equal(result.signal, signal);
    assert.equal(result.path, "/oauth/auth-url");
  }
  assert.equal(Object.hasOwn(client.startAuth("kimi").params, "is_webui"), false);
  assert.match(patched, /href="\/acp"/);
  assert.doesNotMatch(patched, /startAntigravityAuth|antigravity_manual_callback_hint/);
});

test("非 Google 授权失败不被补丁重试或吞错", async () => {
  const failure = new Error("network"); let calls = 0;
  const client = authClient(patched, async () => { calls++; throw failure; });
  await assert.rejects(client.startAuth("codex"), error => error === failure);
  assert.equal(calls, 1);
});

test("未知或已补丁资产不能重复修改，生成脚本语法有效", () => {
  assert.throws(() => patchManagementPanel(Buffer.from(patched)), /SHA256/);
  assert.throws(() => patchManagementPanel(Buffer.from("unknown")), /SHA256/);
  for (const [, script] of patched.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (script.trim()) new vm.Script(script.replaceAll("import.meta", "({url:'https://syntax-test.invalid/'})"));
  }
});

test("Git 换行转换不改变上游管理页固定哈希", async t => {
  const directory = await mkdtemp(join(tmpdir(), "subscription-panel-git-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assetPath = "qoder-subscription-proxy/server/panel/management.upstream.html";
  await mkdir(join(directory, "qoder-subscription-proxy/server/panel"), { recursive: true });
  await writeFile(join(directory, ".gitattributes"), await readFile(new URL("../../.gitattributes", import.meta.url)));
  await writeFile(join(directory, assetPath), upstream);
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git("init", "--quiet"); git("-c", "core.autocrlf=true", "add", ".gitattributes", assetPath);
  await rm(join(directory, assetPath));
  git("-c", "core.autocrlf=true", "checkout-index", "--", assetPath);
  const checkedOut = await readFile(join(directory, assetPath));
  assert.deepEqual(checkedOut, upstream); assert.doesNotThrow(() => patchManagementPanel(checkedOut));
});

test("管理页配置迁移保留其他字段与换行", () => {
  const original = '# user config\r\nmanagement:\r\n    secret-key: "test"\r\n    allow-remote: false\r\nrequests:\r\n    proxy-url: "http://proxy.local:7890"\r\n';
  const updated = disablePanelAutoUpdate(original);
  assert.equal(updated.replace("    disable-auto-update-panel: true\r\n", ""), original);
  assert.equal(disablePanelAutoUpdate(updated), updated);
  assert.throws(() => disablePanelAutoUpdate("server:\n  port: 1234\n"), /management/);
  assert.throws(() => disablePanelAutoUpdate(updated.replace("disable-auto-update-panel: true", 'disable-auto-update-panel: "false"')), /布尔值/);
});

test("受控页面幂等发布且不覆盖用户文件", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "subscription-panel-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, configPath: join(dataDir, "config.yaml"), authDir: join(dataDir, "auths"), host: "127.0.0.1", port: 12345, apiKey: "isolated-api", mgmtKey: "123456" };
  await mkdir(join(dataDir, "static")); await writeFile(join(dataDir, "static", "management.html"), "user-owned-page");
  const original = renderConfigYaml(config).replace("  disable-auto-update-panel: true\n", "");
  await writeFile(config.configPath, original);
  const directory = await prepareManagementPanel(config);
  assert.equal(await readFile(join(directory, "management.html"), "utf8"), patched);
  assert.equal(await readFile(join(dataDir, "static", "management.html"), "utf8"), "user-owned-page");
  const first = await stat(join(directory, "management.html"));
  assert.equal(await prepareManagementPanel(config), directory);
  assert.equal((await stat(join(directory, "management.html"))).mtimeMs, first.mtimeMs);
  assert.equal(await readFile(config.configPath, "utf8"), disablePanelAutoUpdate(original));
  assert.ok(!(await readdir(dataDir)).some(name => name.endsWith(".tmp")));
  await writeFile(join(directory, "management.html"), "external-change");
  await assert.rejects(prepareManagementPanel(config), /外部修改/);
});
