import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { desiredProxyUrl, normalizeProxyServer, readSystemProxyUrl, syncProxyUrl } from "../server/system-proxy.mjs";
import { parseConfigYaml } from "../server/config-yaml.mjs";
import { loadConfig, renderConfigYaml } from "../server/config.mjs";
import { ensureDataDir } from "../server/supervisor.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const proxyKey = JSON.stringify(["requests", "proxy-url"]);
/** 本机常见的 Clash 混合端口形式；仅作为测试常量，插件不内置任何地址。 */
const clash = "http://127.0.0.1:7897";
const withRequests = "config-version: 8\nrequests:\n  streaming:\n    keepalive-seconds: 0\n";

test("归一化 WinINET 的 ProxyServer 各种形式", () => {
  assert.equal(normalizeProxyServer("127.0.0.1:7897"), clash);
  assert.equal(normalizeProxyServer("  127.0.0.1:7897  "), clash);
  assert.equal(normalizeProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7891"), "http://127.0.0.1:7891", "分协议形式优先取 https 条目");
  assert.equal(normalizeProxyServer("http=127.0.0.1:7890;ftp=127.0.0.1:1"), "http://127.0.0.1:7890");
  assert.equal(normalizeProxyServer("https=http://127.0.0.1:7890"), "http://127.0.0.1:7890", "条目值自带协议前缀时按前缀解析");
  assert.equal(normalizeProxyServer("socks=127.0.0.1:7897"), "", "无 HTTP(S) 条目时按直连处理");
  assert.equal(normalizeProxyServer(""), "", "PAC 模式只有脚本地址，按直连处理");
  assert.equal(normalizeProxyServer("   "), "");
  // 不可解析或含凭据的值不得写入明文配置，也不能被当成直连。
  assert.equal(normalizeProxyServer("127.0.0.1"), null, "缺少端口不是 WinINET 形式");
  assert.equal(normalizeProxyServer("http://user:pass@127.0.0.1:7897"), null);
  assert.equal(normalizeProxyServer("socks5://127.0.0.1:7897"), null);
  assert.equal(normalizeProxyServer("not a proxy"), null);
});

test("只有明确启用系统代理才使用地址", () => {
  assert.equal(desiredProxyUrl({ enable: 1, server: "127.0.0.1:7897" }), clash);
  assert.equal(desiredProxyUrl({ enable: "1", server: "127.0.0.1:7897" }), clash);
  assert.equal(desiredProxyUrl({ enable: true, server: "127.0.0.1:7897" }), clash);
  assert.equal(desiredProxyUrl({ enable: 0, server: "127.0.0.1:7897" }), "", "关闭系统代理时即使地址仍在也按直连");
  assert.equal(desiredProxyUrl({ server: "127.0.0.1:7897" }), "");
  assert.equal(desiredProxyUrl({}), "");
  assert.equal(desiredProxyUrl(), "");
  assert.equal(desiredProxyUrl({ enable: 1, server: "127.0.0.1" }), null);
});

test("readSystemProxyUrl 只在 Windows 读取注册表，任何失败都返回不可用而不抛出", async () => {
  assert.equal(await readSystemProxyUrl({ platform: "linux" }), "", "非 Windows 平台无系统代理概念");
  assert.equal(await readSystemProxyUrl({ platform: "darwin" }), "");
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: '{"enable":1,"server":"127.0.0.1:7897"}' };
  };
  assert.equal(await readSystemProxyUrl({ platform: "win32", exec }), clash);
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /powershell\.exe$/i);
  const command = calls[0].args.join(" ");
  assert.match(command, /Internet Settings/);
  assert.equal(calls[0].args[0], "-NoProfile");
  // execFile 的参数数组不经过 shell，注册表路径为脚本内常量。
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.windowsHide, true);
  const stdout = async (value) => readSystemProxyUrl({ platform: "win32", exec: async () => ({ stdout: value }) });
  assert.equal(await stdout('\uFEFF{"enable":1,"server":"https=127.0.0.1:7890;http=127.0.0.1:7890"}\r\n'), "http://127.0.0.1:7890");
  assert.equal(await stdout('{"enable":0,"server":"127.0.0.1:7897"}'), "");
  assert.equal(await stdout('{"enable":1,"server":""}'), "");
  assert.equal(await stdout("not json"), null);
  assert.equal(await stdout("[]"), null);
  assert.equal(await stdout(""), null);
  assert.equal(await readSystemProxyUrl({ platform: "win32", exec: async () => { throw new Error("注册表不可读"); } }), null);
  assert.equal(await readSystemProxyUrl({ platform: "win32", exec: async () => ({}) }), null);
});

test("syncProxyUrl 写入、清空并接管恰好相同的用户值", () => {
  const written = syncProxyUrl(withRequests, { desired: clash, recorded: null });
  assert.equal(written.recorded, clash);
  assert.equal(parseConfigYaml(written.text).values.get(proxyKey), clash);
  assert.ok(written.text.startsWith("config-version: 8\nrequests:\n  streaming:\n    keepalive-seconds: 0\n"), "既有请求参数与顺序保留");
  assert.ok(written.text.endsWith("\n"));
  // 已有字段时定点替换，不追加重复键。
  const replaced = syncProxyUrl(written.text, { desired: "http://127.0.0.1:7890", recorded: clash });
  assert.equal(replaced.recorded, "http://127.0.0.1:7890");
  assert.equal(parseConfigYaml(replaced.text).values.get(proxyKey), "http://127.0.0.1:7890");
  assert.equal(replaced.text.match(/proxy-url/g).length, 1);
  // 系统代理关闭时清空为上游默认值，而不是删除字段。
  const cleared = syncProxyUrl(written.text, { desired: "", recorded: clash });
  assert.equal(cleared.recorded, "");
  assert.equal(parseConfigYaml(cleared.text).values.get(proxyKey), "");
  // 值未变化时保持幂等，不产生归属记录变更。
  assert.deepEqual(syncProxyUrl(written.text, { desired: clash, recorded: clash }), { text: written.text });
  assert.deepEqual(syncProxyUrl(withRequests, { desired: "", recorded: "" }), { text: withRequests });
  // 缺失 requests 段时补齐祖先。
  const created = syncProxyUrl("config-version: 8\n", { desired: clash, recorded: null });
  assert.equal(parseConfigYaml(created.text).values.get(proxyKey), clash);
  assert.ok(created.text.includes("\nrequests:\n  proxy-url: "));
  // 空键与显式 null 都可写入。
  for (const form of ["requests:\n  proxy-url:\n", "requests:\n  proxy-url: null\n", "requests:\n  proxy-url: \"\"\n"]) {
    const filled = syncProxyUrl(`config-version: 8\n${form}`, { desired: clash, recorded: null });
    assert.equal(parseConfigYaml(filled.text).values.get(proxyKey), clash, form);
  }
  // 用户手填值恰好等于系统代理时接管归属，配置内容不变。
  const adopted = syncProxyUrl(`config-version: 8\nrequests:\n  proxy-url: ${JSON.stringify(clash)}\n`, { desired: clash, recorded: null });
  assert.deepEqual(adopted, { text: `config-version: 8\nrequests:\n  proxy-url: ${JSON.stringify(clash)}\n`, recorded: clash });
});

test("syncProxyUrl 不改写用户自管的代理值与结构", () => {
  const userManaged = "config-version: 8\nrequests:\n  proxy-url: direct\n";
  assert.deepEqual(syncProxyUrl(userManaged, { desired: clash, recorded: null }), { text: userManaged }, "无归属记录时不接管非空值");
  assert.deepEqual(syncProxyUrl(userManaged, { desired: clash, recorded: "http://127.0.0.1:7890" }), { text: userManaged }, "用户改动过的值不再跟随");
  for (const form of [
    "config-version: 8\nrequests:\n  proxy-url: socks5://127.0.0.1:1080\n",
    "config-version: 8\nrequests:\n  proxy-url: 7897\n",
    "config-version: 8\nrequests:\n  proxy-url:\n    http: 127.0.0.1:7897\n",
    "config-version: 8\nrequests:\n  proxy-url:\n    - 127.0.0.1:7897\n",
  ]) {
    assert.deepEqual(syncProxyUrl(form, { desired: clash, recorded: null }), { text: form }, form);
    assert.deepEqual(syncProxyUrl(form, { desired: clash, recorded: clash }), { text: form }, form);
  }
  // requests 段本身不是映射时按既有约定报错，且不回显用户值。
  assert.throws(() => syncProxyUrl("config-version: 8\nrequests: private-value\n", { desired: clash, recorded: null }), (error) => {
    assert.match(error.message, /必须为标准映射/);
    assert.ok(!error.message.includes("private-value"));
    return true;
  });
});

/** 隔离数据目录与配置；reader 注入系统代理状态，避免测试依赖宿主真实设置。 */
async function fixture(t, name = "qoder-system-proxy-", port = "1") {
  const root = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { BRIDGE_DATA_DIR: root, BRIDGE_PORT: port, BRIDGE_API_KEY: "isolated-proxy-api" };
  const config = await loadConfig({ pluginRoot, env });
  return { config, reader: (value) => async () => value };
}

test("冷启动写入系统代理并保持幂等，端口变化与关闭系统代理均跟随", async (t) => {
  const { config, reader } = await fixture(t);
  await ensureDataDir(config, { readProxy: reader(clash) });
  const updated = await readFile(config.configPath, "utf8");
  assert.equal(parseConfigYaml(updated).values.get(proxyKey), clash);
  assert.ok(updated.includes("codex-auto-review"), "审批兼容规则不受代理同步影响");
  assert.equal(await readFile(config.proxyStatePath, "utf8"), `${clash}\n`);
  await ensureDataDir(config, { readProxy: reader(clash) });
  assert.equal(await readFile(config.configPath, "utf8"), updated, "重复冷启动不得改写配置");
  await ensureDataDir(config, { readProxy: reader("http://127.0.0.1:7890") });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), "http://127.0.0.1:7890");
  await ensureDataDir(config, { readProxy: reader("") });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), "", "关闭系统代理后回到上游默认直连");
  assert.equal(await readFile(config.proxyStatePath, "utf8"), "\n");
  await ensureDataDir(config, { readProxy: reader(clash) });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), clash, "重新启用系统代理可恢复跟随");
});

test("系统代理不可用时冷启动不改写代理，也不产生归属记录", async (t) => {
  const { config, reader } = await fixture(t);
  await ensureDataDir(config, { readProxy: async () => null });
  const baseline = await readFile(config.configPath, "utf8");
  assert.equal(baseline.includes("proxy-url"), false, "读取失败不得写入或清空代理");
  assert.equal(await readFile(config.proxyStatePath, "utf8").catch((error) => error.code), "ENOENT");
  // 注册表读取失败后系统代理恢复，仍可正常写入。
  await ensureDataDir(config, { readProxy: reader(clash) });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), clash);
});

test("用户自管的显式直连在冷启动后保留且不被接管", async (t) => {
  const { config, reader } = await fixture(t, "qoder-system-proxy-user-");
  await writeFile(config.configPath, `${renderConfigYaml(config)}requests:\n  proxy-url: direct\n`);
  await ensureDataDir(config, { readProxy: reader(clash) });
  const preserved = await readFile(config.configPath, "utf8");
  assert.equal(parseConfigYaml(preserved).values.get(proxyKey), "direct", "用户显式直连必须保留");
  assert.ok(preserved.includes("codex-auto-review"), "审批兼容规则仍随冷启动补齐");
  assert.equal(await readFile(config.proxyStatePath, "utf8").catch((error) => error.code), "ENOENT");
  await ensureDataDir(config, { readProxy: reader(clash) });
  assert.equal(await readFile(config.configPath, "utf8"), preserved, "重复冷启动同样不得改写用户代理");
});

/** 取一个当前空闲的回环端口；原生核心需要真实可监听的地址。 */
async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 轮询等待条件成立；原生核心启动与就绪需要短暂重试。 */
async function waitUntil(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error("等待隔离核心就绪超时");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 最小转发代理：记录经过它的上游请求，用于验证真实核心确实使用 requests.proxy-url。 */
function forwardProxy(t, observed) {
  const server = http.createServer((request, response) => {
    observed.push(request.url);
    const target = new URL(request.url);
    const upstream = http.request({
      hostname: target.hostname, port: target.port, method: request.method,
      path: target.pathname + target.search, headers: { ...request.headers, host: target.host },
    }, (reply) => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { t.after(() => server.close()); resolve(server); });
  });
}

test("真实核心把冷启动写入的系统代理用于上游请求", { skip: nativeCoreSkip, timeout: 60000 }, async (t) => {
  const port = await unusedPort();
  const { config, reader } = await fixture(t, "qoder-system-proxy-native-", String(port));
  const observed = [];
  const hits = [];
  const upstream = http.createServer(async (request, response) => {
    // 必须读完请求体，否则核心侧的写入会挂起。
    for await (const chunk of request) { void chunk; }
    hits.push(request.url);
    const payload = { id: "resp-proxy", object: "response", model: "gpt-proxy-check", status: "completed", output: [] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`event: response.created
data: ${JSON.stringify({ type: "response.created", response: payload })}

`);
    response.end(`event: response.completed
data: ${JSON.stringify({ type: "response.completed", response: payload })}

`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const proxy = await forwardProxy(t, observed);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  await ensureDataDir(config, { readProxy: reader(proxyUrl) });
  const synced = await readFile(config.configPath, "utf8");
  assert.equal(parseConfigYaml(synced).values.get(proxyKey), proxyUrl, "冷启动把系统代理写入 requests.proxy-url");
  assert.equal((await readFile(config.proxyStatePath, "utf8")).trim(), proxyUrl, "归属记录与写入值一致");
  const binary = await copyTestCore(join(config.dataDir, process.platform === "win32" ? "core.exe" : "core"));
  // 凭据不单独指定 proxy-url，继承全局值；关闭内置管理页避免测试期间联网下载面板。
  await writeFile(config.configPath, synced.replace("disable-control-panel: false", "disable-control-panel: true") + `api-keys:
  codex:
    - name: proxy-fixture
      base-url: "http://127.0.0.1:${upstream.address().port}"
      models:
        - name: gpt-proxy-check
          alias: gpt-proxy-check
      keys:
        - api-key: isolated-upstream
          disable-codex-cloaking: true
`);
  const child = spawn(binary, ["-config", config.configPath], { cwd: config.dataDir, windowsHide: true, stdio: "ignore" });
  const exited = once(child, "exit");
  try {
    const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error("隔离核心启动失败");
      try { return (await fetch(config.endpoint + "/models", { headers, signal: AbortSignal.timeout(500) })).ok; }
      catch { return false; }
    });
    const response = await fetch(config.endpoint + "/responses", {
      method: "POST", headers, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ model: "gpt-proxy-check", stream: true, input: "local proxy test" }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, /"type":"response.completed"/, body);
    assert.equal(hits.length, 1, "上游应收到一次请求");
    assert.equal(observed.length, 1, "上游请求必须经过冷启动写入的代理");
    assert.ok(observed[0].startsWith("http://127.0.0.1:"), `代理应收到绝对 URI 转发请求，实际 ${observed[0]}`);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
});
