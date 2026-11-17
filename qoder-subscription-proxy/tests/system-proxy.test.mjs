import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import {
  desiredProxyUrl, hasTunnelEgress, isProxyReachable, normalizeProxyServer,
  readEffectiveProxyUrl, readSystemProxyUrl,
} from "../server/system-proxy.mjs";

/** 本机常见的 Clash 混合端口形式；仅作为测试常量，插件不内置任何地址。 */
const clash = "http://127.0.0.1:7897";

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

/** 取一个当前空闲的回环端口，用于验证已关闭端口不会被判为可达。 */
async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
