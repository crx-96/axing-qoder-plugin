import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  desiredProxyUrl, hasTunnelEgress, isProxyReachable, normalizeProxyServer,
  readEffectiveProxyUrl, readSystemProxyUrl, syncProxyUrl,
} from "../server/system-proxy.mjs";
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
  assert.equal(normalizeProxyServer("127.0.0.1:80"), "http://127.0.0.1:80");
  assert.equal(normalizeProxyServer("http://127.0.0.1:80"), "http://127.0.0.1:80");
  assert.equal(normalizeProxyServer("https://127.0.0.1:443"), "https://127.0.0.1:443");
  assert.equal(normalizeProxyServer("https=127.0.0.1:80"), "http://127.0.0.1:80");
  assert.equal(normalizeProxyServer("http://[::1]:80"), "http://[::1]:80");
  assert.equal(normalizeProxyServer("127.0.0.1:0"), null);
  assert.equal(normalizeProxyServer("127.0.0.1:65536"), null);
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

/** 临时 TCP 监听：为可达性探测提供真实可连接的端口，测试结束自动关闭。 */
async function tcpListener(t) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return server.address().port;
}

/** 可手工触发事件的假套接字；用于覆盖超时与错误路径而不依赖宿主网络状态。 */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  return socket;
}

test("isProxyReachable 连得上才算可达，超时、错误与非法地址一律不可达且不抛出", async (t) => {
  const live = await tcpListener(t);
  assert.equal(await isProxyReachable(`http://127.0.0.1:${live}`, { timeout: 2000 }), true, "在听的回环端口可达");
  // 回环不经路由表也不被隧道网卡捕获，关闭的端口必须快速判为不可达。
  assert.equal(await isProxyReachable(`http://127.0.0.1:${await unusedPort()}`, { timeout: 2000 }), false);

  // 无响应地址：连接实现按 timeout 触发空闲计时器事件，与真实 net 套接字行为一致。
  const pending = fakeSocket();
  const pendingArguments = [];
  const pendingResult = isProxyReachable(clash, {
    timeout: 20,
    connect: (options) => {
      pendingArguments.push(options);
      setTimeout(() => pending.emit("timeout"), options.timeout);
      return pending;
    },
  });
  assert.equal(await pendingResult, false, "时限内连不上按不可达处理");
  assert.deepEqual(pendingArguments, [{ host: "127.0.0.1", port: 7897, timeout: 20 }]);
  assert.equal(pending.destroyed, true, "试探用的套接字必须释放");

  const connected = fakeSocket();
  const settled = isProxyReachable(clash, { timeout: 2000, connect: () => connected });
  connected.emit("connect");
  assert.equal(await settled, true);
  assert.equal(connected.destroyed, true, "可达后同样释放套接字");

  const failed = fakeSocket();
  const failure = isProxyReachable(clash, { timeout: 2000, connect: () => failed });
  failed.emit("error", Object.assign(new Error("连接被拒绝"), { code: "ECONNREFUSED" }));
  assert.equal(await failure, false);

  const closed = fakeSocket();
  const closing = isProxyReachable(clash, { timeout: 2000, connect: () => closed });
  closed.emit("close");
  assert.equal(await closing, false);

  // IPv6 主机名要剥掉方括号再交给 net。
  const six = fakeSocket();
  const sixArguments = [];
  const sixResult = isProxyReachable("http://[::1]:7897", { timeout: 2000, connect: (options) => { sixArguments.push(options); return six; } });
  six.emit("connect");
  assert.equal(await sixResult, true);
  assert.equal(sixArguments[0].host, "::1");

  // 可达性只看主机与端口；带凭据的地址由归一化环节拦截，不会走到这里。
  const credentialed = fakeSocket();
  const credentialResult = isProxyReachable("http://user:pass@127.0.0.1:7897", { timeout: 2000, connect: () => credentialed });
  credentialed.emit("connect");
  assert.equal(await credentialResult, true);
  for (const [url, port] of [["http://127.0.0.1:80", 80], ["https://127.0.0.1:443", 443], ["http://[::1]:80", 80], ["http://127.0.0.1", 80]]) {
    const socket = fakeSocket();
    const result = isProxyReachable(url, { connect: (options) => { assert.equal(options.port, port); return socket; } });
    socket.emit("connect");
    assert.equal(await result, true);
  }
  for (const url of ["not a proxy", "127.0.0.1:7897", "", "http://:7897", "ftp://127.0.0.1:21"]) {
    assert.equal(await isProxyReachable(url, { connect: () => { throw new Error("不得发起连接"); } }), false, url);
  }
  assert.equal(await isProxyReachable(clash, { connect: () => { throw new Error("同步失败"); } }), false, "连接实现同步抛错也按不可达处理");
});

test("hasTunnelEgress 只在 Windows 读取网卡及路由，失败时不推断存在隧道出口", async () => {
  assert.equal(await hasTunnelEgress({ platform: "linux" }), false);
  assert.equal(await hasTunnelEgress({ platform: "darwin", exec: async () => { throw new Error("不得调用"); } }), false);
  const snapshot = {
    interfaces: [{ ipv4: 10, ipv6: null, tunnel: true, hasIPv6: false }],
    routes: [{ prefix: "0.0.0.0/0", index: 10, metric: 5 }],
  };
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: JSON.stringify(snapshot) };
  };
  assert.equal(await hasTunnelEgress({ platform: "win32", exec }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /powershell\.exe$/i);
  assert.equal(calls[0].args[0], "-NoProfile");
  const command = calls[0].args.join(" ");
  assert.match(command, /NetworkInterface\]::GetAllNetworkInterfaces/);
  assert.match(command, /Get-NetRoute -PolicyStore ActiveStore/);
  assert.match(command, /RouteMetric\+\[long\]\$_.InterfaceMetric/);
  assert.match(command, /OperationalStatus/);
  assert.match(command, /IsIPv6LinkLocal/);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 5000);
  const stdout = async (value) => hasTunnelEgress({ platform: "win32", exec: async () => ({ stdout: value }) });
  assert.equal(await stdout(`\uFEFF${JSON.stringify(snapshot)}\r\n`), true);
  for (const value of ['{"tunnel":true}', '{"interfaces":[],"routes":[]}', "not json", "[]", "null", ""]) {
    assert.equal(await stdout(value), false, value);
  }
  assert.equal(await hasTunnelEgress({ platform: "win32", exec: async () => { throw new Error("读取失败"); } }), false);
  assert.equal(await hasTunnelEgress({ platform: "win32", exec: async () => ({}) }), false);
});

test("隧道回退须由优选默认路由或两条 /1 覆盖出口，分流与多出口不误判", async () => {
  const interfaces = [
    { ipv4: 10, ipv6: 10, tunnel: false, hasIPv6: false },
    { ipv4: 20, ipv6: 20, tunnel: true, hasIPv6: false },
  ];
  const route = (prefix, index, metric = 10) => ({ prefix, index, metric });
  const check = (routes, adapters = interfaces) => hasTunnelEgress({
    platform: "win32", exec: async () => ({ stdout: JSON.stringify({ interfaces: adapters, routes }) }),
  });
  assert.equal(await check([route("0.0.0.0/0", 10), route("100.64.0.0/10", 20)]), false, "Tailscale 仅内网路由不代表出口");
  assert.equal(await check([route("0.0.0.0/0", 10), route("0.0.0.0/0", 20, 20)]), false, "隧道默认路由优先级较低");
  assert.equal(await check([route("0.0.0.0/0", 10), route("0.0.0.0/0", 20)]), false, "同指标多出口不能认定隧道接管");
  assert.equal(await check([route("0.0.0.0/0", 10, 20), route("0.0.0.0/0", 20)]), true);
  assert.equal(await check([route("0.0.0.0/0", 10), route("0.0.0.0/1", 20, 100), route("128.0.0.0/1", 20, 100)]), true, "/1 的优先级高于 /0");
  assert.equal(await check([route("0.0.0.0/0", 10), route("0.0.0.0/1", 20)]), false, "只有一半出口被覆盖");
  assert.equal(await check([route("0.0.0.0/0", 20), route("128.0.0.0/1", 10)]), false, "非隧道更具体路由优先");
  assert.equal(await check([route("0.0.0.0/0", 99)]), false, "不使用已断开或未知网卡");
  assert.equal(await check([route("0.0.0.0/0", 20, -1)]), false);
  assert.equal(await check([route("0.0.0.0/0", 20, null)]), false);
  assert.equal(await check([null]), false);
  assert.equal(await check([]), false);
  const dualStack = interfaces.map((item) => ({ ...item, hasIPv6: true }));
  assert.equal(await check([route("0.0.0.0/0", 20), route("::/0", 10)], dualStack), false, "IPv6 仍走物理出口");
  assert.equal(await check([route("0.0.0.0/0", 20)], dualStack), false, "IPv6 路由证据缺失");
  assert.equal(await check([route("0.0.0.0/0", 20), route("::/0", 20)], dualStack), true);
  assert.equal(await check([route("0.0.0.0/0", 20), route("::/0", 10), route("::/1", 20), route("8000::/1", 20)], dualStack), true);
});

test("readEffectiveProxyUrl 仅在地址不可达且隧道在用时回落直连", async () => {
  const seen = [];
  const run = ({ url, reachable, tunneled }) => readEffectiveProxyUrl({
    read: async () => { seen.push("read"); return url; },
    probe: async () => { seen.push("probe"); return reachable; },
    tunnel: async () => { seen.push("tunnel"); return tunneled; },
  });
  // 本就直连或状态不可用时不必探测，TUN 单开的用户零额外开销。
  seen.length = 0;
  assert.equal(await run({ url: "", reachable: true, tunneled: true }), "");
  assert.deepEqual(seen, ["read"]);
  seen.length = 0;
  assert.equal(await run({ url: null, reachable: true, tunneled: true }), null);
  assert.deepEqual(seen, ["read"]);
  // 地址可达即沿用，隧道状态无关：显式端口与 TUN 都只有一跳。
  seen.length = 0;
  assert.equal(await run({ url: clash, reachable: true, tunneled: true }), clash);
  assert.deepEqual(seen, ["read", "probe"]);
  seen.length = 0;
  assert.equal(await run({ url: clash, reachable: false, tunneled: true }), "direct", "显式直连必须绕过继承的环境代理");
  assert.deepEqual(seen, ["read", "probe", "tunnel"]);
  // 不可达 + 没有隧道：保留写入，客户端随后启动即可自愈，清空反倒要重启桥。
  seen.length = 0;
  assert.equal(await run({ url: clash, reachable: false, tunneled: false }), clash);
  assert.deepEqual(seen, ["read", "probe", "tunnel"]);
});

test("syncProxyUrl 自动写入、清空，但不接管恰好相同的用户值", () => {
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
  const manual = `config-version: 8\nrequests:\n  proxy-url: ${JSON.stringify(clash)}\n`;
  assert.deepEqual(syncProxyUrl(manual, { desired: clash, recorded: null }), { text: manual });
  assert.deepEqual(syncProxyUrl(manual, { desired: "direct", recorded: null }), { text: manual });
  assert.deepEqual(syncProxyUrl(manual, { desired: "", recorded: null }), { text: manual });
});

test("清空或删除代理字段会恢复跟随，并重置陈旧归属记录", () => {
  for (const form of ["", "  proxy-url:\n", "  proxy-url: null\n", '  proxy-url: ""\n']) {
    const text = `config-version: 8\nrequests:\n  streaming:\n    keepalive-seconds: 0\n${form}`;
    const restored = syncProxyUrl(text, { desired: clash, recorded: "http://127.0.0.1:7890" });
    assert.equal(parseConfigYaml(restored.text).values.get(proxyKey), clash);
    assert.equal(restored.recorded, clash);
    const empty = syncProxyUrl(text, { desired: "", recorded: clash });
    assert.deepEqual(empty, { text, recorded: "" });
    const tunnel = syncProxyUrl(text, { desired: "direct", recorded: clash });
    assert.equal(parseConfigYaml(tunnel.text).values.get(proxyKey), "direct");
    assert.equal(tunnel.recorded, "direct");
  }
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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

test("隧道在用且系统代理地址失效时冷启动回落直连，隧道消失后恢复写入", async (t) => {
  const { config } = await fixture(t, "qoder-system-proxy-tunnel-");
  let reachable = true;
  let tunneled = true;
  const readProxy = () => readEffectiveProxyUrl({ read: async () => clash, probe: async () => reachable, tunnel: async () => tunneled });
  await ensureDataDir(config, { readProxy });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), clash, "地址可达时照常写入");
  assert.equal(await readFile(config.proxyStatePath, "utf8"), `${clash}\n`);
  // 客户端关闭混合端口但 TUN 仍在承载出口：直连可用，失效地址必须清掉，否则核心每次请求都拨号失败。
  reachable = false;
  await ensureDataDir(config, { readProxy });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), "direct", "路由确认隧道出口后显式直连");
  assert.equal(await readFile(config.proxyStatePath, "utf8"), "direct\n", "记录自动写入的 direct，允许后续恢复系统代理");
  await ensureDataDir(config, { readProxy });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), "direct", "重复冷启动保持幂等");
  // 隧道关闭（用户退出 TUN 只留系统代理）后恢复跟随：此时直连出不去，写入才能在客户端启动后自愈。
  tunneled = false;
  await ensureDataDir(config, { readProxy });
  assert.equal(parseConfigYaml(await readFile(config.configPath, "utf8")).values.get(proxyKey), clash, "没有隧道兜底时保留写入");
  assert.equal(await readFile(config.proxyStatePath, "utf8"), `${clash}\n`);
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

for (const mode of ["system", "environment", "tunnel"]) test(`真实核心代理出口：${mode}`, { skip: nativeCoreSkip, timeout: 60000 }, async (t) => {
  const host = mode === "system" ? "127.0.0.1" : Object.values(networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address;
  if (!host) return t.skip("环境代理对回环有隐式豁免，需要可绑定的本机非回环 IPv4 地址");
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
  await new Promise((resolve) => upstream.listen(0, host, resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });

  const proxy = await forwardProxy(t, observed);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const desired = mode === "system" ? proxyUrl : mode === "environment" ? "" :
    await readEffectiveProxyUrl({ read: reader(proxyUrl), probe: async () => false, tunnel: async () => true });
  await ensureDataDir(config, { readProxy: reader(desired) });
  const synced = await readFile(config.configPath, "utf8");
  assert.equal(parseConfigYaml(synced).values.get(proxyKey) ?? "", desired);
  if (desired) assert.equal((await readFile(config.proxyStatePath, "utf8")).trim(), desired);
  const binary = await copyTestCore(join(config.dataDir, process.platform === "win32" ? "core.exe" : "core"));
  // 凭据不单独指定 proxy-url，继承全局值；关闭内置管理页避免测试期间联网下载面板。
  await writeFile(config.configPath, synced.replace("disable-control-panel: false", "disable-control-panel: true") + `api-keys:
  codex:
    - name: proxy-fixture
      base-url: "http://${host}:${upstream.address().port}"
      models:
        - name: gpt-proxy-check
          alias: gpt-proxy-check
      keys:
        - api-key: isolated-upstream
          disable-codex-cloaking: true
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(name)));
  if (mode !== "system") {
    env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = proxyUrl;
    env.NO_PROXY = "";
  }
  const child = spawn(binary, ["-config", config.configPath], { cwd: config.dataDir, env, windowsHide: true, stdio: "ignore" });
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
    assert.equal(observed.length, mode === "tunnel" ? 0 : 1, "TUN 显式直连须绕过环境代理，其余场景必须经指定代理");
    if (observed.length) assert.ok(observed[0].startsWith(`http://${host}:`));
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
});

for (const desired of ["", "direct"]) test(`真实核心 HTTPS 出口：${desired || "environment"}`, { skip: nativeCoreSkip, timeout: 60000 }, async (t) => {
  const host = Object.values(networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address;
  if (!host) return t.skip("环境代理对回环有隐式豁免，需要可绑定的本机非回环 IPv4 地址");
  let directConnections = 0;
  const upstream = net.createServer((socket) => { directConnections++; socket.destroy(); });
  await new Promise((resolve) => upstream.listen(0, host, resolve));
  t.after(() => upstream.close());
  const target = `${host}:${upstream.address().port}`;
  let proxyConnections = 0;
  const proxy = http.createServer((request, response) => response.writeHead(502).end());
  proxy.on("connect", (request, socket) => {
    if (request.url === target) proxyConnections++;
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const { config, reader } = await fixture(t, "qoder-system-proxy-https-", String(await unusedPort()));
  await ensureDataDir(config, { readProxy: reader(desired) });
  const synced = await readFile(config.configPath, "utf8");
  await writeFile(config.configPath, synced.replace("disable-control-panel: false", "disable-control-panel: true") + `routing:
  retry:
    request-retry: 0
api-keys:
  codex:
    - name: https-fixture
      base-url: "https://${target}"
      models:
        - name: gpt-https-check
          alias: gpt-https-check
      keys:
        - api-key: isolated-upstream
          request-retry: 0
          disable-codex-cloaking: true
`);
  const binary = await copyTestCore(join(config.dataDir, process.platform === "win32" ? "core.exe" : "core"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(name)));
  env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  env.NO_PROXY = "";
  const child = spawn(binary, ["-config", config.configPath], { cwd: config.dataDir, env, windowsHide: true, stdio: "ignore" });
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
      body: JSON.stringify({ model: "gpt-https-check", stream: true, input: "local https routing test" }),
    });
    await response.text();
    assert.ok(response.status >= 400, "测试端点主动拒绝 TLS，不访问外网");
    assert.equal(proxyConnections > 0, desired === "");
    assert.equal(directConnections > 0, desired === "direct");
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
});
