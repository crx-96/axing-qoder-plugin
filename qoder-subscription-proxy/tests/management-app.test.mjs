import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { managementAppResource } from "../server/management-app.mjs";
import { PLUGIN_VERSION } from "../server/config.mjs";

const script = await readFile(new URL("../server/panel/management-app.js", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const status = { ready: true };
function page(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const listeners = new Map(), sent = [], timers = new Set(), elements = new Map();
  function element() {
    return { disabled: false, hidden: false, value: "", textContent: "", style: {}, children: [], dataset: {},
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      removeAttribute(name) { delete this[name]; } };
  }
  const parent = { postMessage: message => sent.push(message) };
  const window = { parent, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const document = { querySelector(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, documentElement: { style: {}, dataset: {} } };
  const panel = () => ({ render() {}, initialize() {}, dispose() {} });
  runInNewContext(script, { document, window, console, pluginVersion: PLUGIN_VERSION, createUpdatePanel: panel, createInstalledCoresPanel: panel, createPortPanel: panel,
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); } });
  const receive = (data, source = parent) => listeners.get("message")?.({ data, source });
  return { sent, document, receive, timers, get: id => document.querySelector(id), pagehide: () => listeners.get('pagehide')?.(),
    diagnosticText: () => ['#facts', '#more'].flatMap(id => document.querySelector(id).children.flatMap(row => row.children.map(node => node.textContent))).join(' '),
    statusReply(value, call = sent.at(-1)) { assert.equal(call.params.name, 'bridge_status'); this.reply(call.id, { content: [{ text: JSON.stringify(value) }] }); },
    reply(id, result) { receive({ jsonrpc: "2.0", id, result }); },
    notify(method, params) { receive({ jsonrpc: "2.0", method, params }); },
    calls: () => sent.filter(message => message.method === "tools/call") };
}
async function initialize(p, capabilities = { serverTools: {} }) {
  p.reply(p.sent[0].id, { protocolVersion: "2026-01-26", hostCapabilities: capabilities, hostContext: { theme: "dark" } });
  await tick();
}
async function loaded(p, value = status) {
  await initialize(p);
  p.reply(p.calls()[0].id, { content: [{ type: "text", text: JSON.stringify(value) }] });
  await tick();
}

test("资源内联实际版本，保留状态与显式浏览器入口", async () => {
  const resource = await managementAppResource();
  assert.doesNotMatch(resource.text, /审批|bridge_approval_|<select/);
  assert.ok(resource.text.includes(`const pluginVersion=${JSON.stringify(PLUGIN_VERSION)}`));
  assert.match(resource.text, /打开原生管理页（浏览器）/);
  assert.match(resource.text, /刷新状态/);
  assert.match(resource.text, /role="status" aria-live="polite"/);
  assert.doesNotMatch(script, /innerHTML|window\.confirm/);
});
test("初始化仅查状态，早到与重复通知均不打开浏览器或写入", async t => {
  const p = page(t);
  p.notify("ui/notifications/tool-result", { content: [] });
  await loaded(p);
  p.notify("ui/notifications/tool-result", { content: [] });
  assert.deepEqual(p.calls().map(call => call.params.name), ["bridge_status"]);
  assert.equal(p.sent[0].params.appInfo.version, PLUGIN_VERSION);
  assert.equal(p.document.documentElement.style.colorScheme, "dark");
  assert.equal(p.document.documentElement.dataset.theme, "dark");
  assert.equal(p.timers.size, 0);
});
test("初始化 30 秒超时后仅可手动重连，迟到响应不干扰新握手", async t => {
  const p = page(t);
  const first = p.sent[0];
  t.mock.timers.tick(30_000);
  await tick();
  assert.match(p.get("#status").textContent, /重新连接/);
  assert.equal(p.get("#reconnect").hidden, false);
  assert.equal(p.get("#reconnect").disabled, false);
  for (const id of ["#open", "#refresh", "#start"]) assert.equal(p.get(id).disabled, true);
  assert.equal(p.sent.length, 1);

  const retry = p.get("#reconnect").onclick();
  await p.get("#reconnect").onclick();
  const second = p.sent[1];
  assert.equal(second.method, "ui/initialize");
  assert.notEqual(second.id, first.id);
  assert.equal(p.get("#reconnect").disabled, true);
  p.reply(first.id, { protocolVersion: "old" });
  p.receive({ jsonrpc: "2.0", id: first.id, error: { code: -1 } });
  await tick();
  assert.equal(p.sent.length, 2);
  assert.match(p.get("#status").textContent, /正在连接/);

  p.reply(second.id, { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} } });
  await tick();
  assert.deepEqual(p.sent.map(m => m.method), ["ui/initialize", "ui/initialize", "ui/notifications/initialized", "tools/call"]);
  assert.equal(p.calls()[0].params.name, "bridge_status");
  p.reply(p.calls()[0].id, { content: [{ text: JSON.stringify(status) }] });
  await retry;
  assert.match(p.get("#status").textContent, /核心已就绪/);
  assert.equal(p.get("#refresh").disabled, false);
  assert.equal(p.get("#reconnect").hidden, true);
  assert.equal(p.timers.size, 0);
});
test("协议版本不支持时保留升级提示", async t => {
  const p = page(t);
  p.reply(p.sent[0].id, { protocolVersion: "old" });
  await tick();
  assert.match(p.get("#status").textContent, /升级客户端/);
  assert.equal(p.get("#reconnect").hidden, true);
  await p.get("#reconnect").onclick();
  assert.equal(p.sent.length, 1);
});
test("缺少 serverTools 时不调用工具", async t => {
  const p = page(t);
  await initialize(p, {});
  await p.get("#open").onclick();
  assert.equal(p.calls().length, 0);
  assert.equal(p.get("#open").disabled, true);
  assert.equal(p.get("#reconnect").hidden, true);
  assert.match(p.get("#status").textContent, /不支持管理工具/);
});
test("重试跨过十分钟仍查询真实进度，旧故障、重复点击和迟到回复不会重复启动", async t => {
  const p = page(t);
  const failed = { ready: false, preparing: false, core: { state: 'error', reason: '核心下载失败' }, startupError: 'CORE_DOWNLOAD' };
  await loaded(p, failed);
  const task = p.get('#start').onclick();
  const start = p.calls()[1];
  t.mock.timers.tick(1200);
  await tick();
  p.statusReply(failed);
  await tick();
  assert.match(p.get('#status').textContent, /正在启动/);
  t.mock.timers.tick(598_800);
  await tick();
  for (const id of ['#open', '#refresh', '#start']) {
    assert.equal(p.get(id).disabled, true);
    await p.get(id).onclick();
  }
  assert.deepEqual(p.calls().map(call => call.params.name), ['bridge_status', 'bridge_start', 'bridge_status', 'bridge_status']);
  p.statusReply({ ...failed, preparing: true, core: { state: 'downloading', progress: { phase: 'downloading', receivedBytes: 256, totalBytes: 1024 } } });
  await tick();
  assert.equal(p.get('#amount').textContent, '25% · 256 B / 1 KiB');
  t.mock.timers.tick(1200);
  await tick();
  const count = p.sent.length;
  p.reply(start.id, { content: [] });
  await tick();
  assert.equal(p.sent.length, count, '在途状态未结束时不并发补查');
  p.statusReply(status);
  await task;
  p.reply(start.id, { isError: true });
  assert.equal(p.sent.length, count);
  assert.equal(p.get('#status').textContent, '核心已就绪');
  assert.equal(p.timers.size, 0);
});
test("启动等待到期后可手动查询，迟到结果不覆盖状态或回送错误", async t => {
  const p = page(t);
  await loaded(p, { ready: false });
  const task = p.get("#start").onclick();
  const start = p.calls()[1];
  t.mock.timers.tick(11 * 60_000);
  await task;
  assert.match(p.get("#detail").textContent, /结果未知.*刷新状态/);
  assert.equal(p.calls().length, 3);
  p.statusReply({ ready: false, core: { state: 'downloading' } });
  await tick();
  assert.match(p.get('#status').textContent, /启动结果未知/);
  assert.equal(p.get("#refresh").disabled, false);
  const refresh = p.get("#refresh").onclick();
  p.statusReply(status);
  await refresh;
  const count = p.sent.length;
  p.reply(start.id, { content: [] });
  p.receive({ jsonrpc: "2.0", id: start.id, error: { code: -1 } });
  await tick();
  assert.equal(p.sent.length, count);
  assert.match(p.get("#status").textContent, /核心已就绪/);
  assert.equal(p.timers.size, 0);
});
test("未就绪仅提示，由用户显式启动", async t => {
  const p = page(t);
  await loaded(p, { ...status, ready: false, reason: "核心暂停" });
  assert.equal(p.get("#start").hidden, false);
  assert.equal(p.calls().length, 1);
  const task = p.get("#start").onclick();
  assert.equal(p.calls()[1].params.name, "bridge_start");
  p.reply(p.calls()[1].id, { content: [] });
  await tick();
  p.reply(p.calls()[2].id, { content: [{ text: JSON.stringify(status) }] });
  await task;
  assert.equal(p.get("#start").hidden, true);
});
for (const [label, value, expected, active = false] of [
  ['暂停', { autoRecoveryPaused: true, startupError: '过期启动错误' }, /自动恢复已暂停/],
  ['旧版准备中', { core: { state: 'downloading' }, startupError: '过期启动错误' }, /正在准备当前平台核心/, true],
  ['启动失败', { startupError: '代理后台准备失败（CORE_DOWNLOAD）' }, /核心下载失败.*网络/],
  ['模型失败', { models: { note: '模型查询失败：HTTP 503' }, core: { state: 'ready' } }, /HTTP 503.*可用账号/],
  ['本地端口配置', { state: 'configuration_error', startupError: '模型端口与管理端口不能相同。（BRIDGE_CONFIG）' }, /本地配置不可用.*设为不同端口/],
  ['文件大小', { core: { state: 'error', reason: '核心下载大小与固定资产不符或超过安全限制' } }, /发行清单不符或超限.*核对下载来源/],
  ['缺失核心', { core: { state: 'missing' } }, /核心尚未安装.*查找本机可用核心.*当前平台的官方稳定版/],
  ['无效核心', { core: { state: 'invalid', reason: '核心摘要不一致' } }, /SHA256 不匹配/],
  ['下载失败', { core: { state: 'error', reason: '核心下载失败' } }, /核心下载失败.*代理|核心下载失败.*PROXY/],
  ['启动中', { core: { state: 'ready' }, preparing: true }, /正在启动核心.*缓存已通过校验/, true],
  ['未就绪', { core: { state: 'ready' } }, /核心尚未就绪/],
  ['未知异常', { startupError: '失败 <img src=x> secret\n at C:/private' }, /请检查核心、端口/],
]) {
  test(`管理页展示真实状态字段：${label}`, async t => {
    const p = page(t);
    await loaded(p, { ready: false, ...value });
    const summary = p.get('#status').textContent + p.get('#detail').textContent;
    assert.match(summary, expected);
    assert.doesNotMatch(summary, /<img|secret|private|过期启动错误/);
    assert.equal(p.get('#start').hidden, active);
    assert.equal(p.timers.size, active ? 1 : 0);
    assert.deepEqual(p.calls().map(call => call.params.name), ['bridge_status']);
  });
}

test("显式打开防重复且 isError 安全文本可恢复", async t => {
  const p = page(t);
  await loaded(p);
  const first = p.get("#open").onclick();
  await p.get("#open").onclick();
  assert.equal(p.calls().length, 2);
  p.reply(p.calls()[1].id, { isError: true, content: [{ text: "<img onerror=alert(1)>打开失败" }] });
  await first;
  assert.match(p.get("#notice").textContent, /打开失败/);
  assert.doesNotMatch(p.get("#notice").textContent, /<img/);
  assert.equal(p.get("#status").textContent, "核心已就绪");
  const next = p.get("#open").onclick();
  p.reply(p.calls()[2].id, { content: [] });
  await next;
  assert.match(p.get("#notice").textContent, /已向系统默认浏览器/);
});
test("协议错误、超时不自动重试，外来消息无效", async t => {
  const p = page(t);
  await loaded(p);
  const before = p.get("#status").textContent;
  p.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { isError: true, content: [{ text: "伪造" }] } }, {});
  assert.equal(p.get("#status").textContent, before);
  let task = p.get("#open").onclick();
  p.receive({ jsonrpc: "2.0", id: p.calls()[1].id, error: { message: "internal secret" } });
  await task;
  assert.match(p.get("#notice").textContent, /结果未知/);
  assert.doesNotMatch(p.get("#status").textContent, /secret/);
  task = p.get("#open").onclick();
  t.mock.timers.tick(30_000);
  await task;
  assert.match(p.get("#notice").textContent, /结果未知/);
  assert.equal(p.calls().length, 3);
});
test('已确认失败停止轮询，即使启动请求尚未返回', async t => {
  const p = page(t);
  await loaded(p, { ready: false, core: { state: 'missing' } });
  const task = p.get('#start').onclick();
  t.mock.timers.tick(1200);
  await tick();
  p.statusReply({ ready: false, preparing: false, core: { state: 'ready' }, startupError: '无法读取进程归属信息，拒绝接管或停止' });
  await tick();
  assert.match(p.get('#detail').textContent, /进程归属/);
  t.mock.timers.tick(4000);
  assert.equal(p.calls().length, 3);
  p.reply(p.calls()[1].id, { isError: true, content: [{ text: JSON.stringify({ ready: false, reason: '本版本托管协议' }) }] });
  await task;
  assert.match(p.get('#detail').textContent, /先停止旧版/);
  assert.equal(p.get('#start').disabled, false);
  assert.equal(p.timers.size, 0);
});

test('在途读取晚于启动失败时不覆盖失败；关闭时清理启动及进度读取', async t => {
  const p = page(t);
  await loaded(p, { ready: false });
  const task = p.get('#start').onclick();
  t.mock.timers.tick(1200);
  await tick();
  p.reply(p.calls()[1].id, { isError: true, content: [{ text: 'CORE_ARCHIVE_HASH token=private' }] });
  await task;
  p.statusReply({ ready: false, core: { state: 'downloading' } });
  await tick();
  assert.match(p.get('#detail').textContent, /SHA256 不匹配/);
  assert.doesNotMatch(p.get('#detail').textContent, /private/);
  assert.equal(p.timers.size, 0);
  const retry = p.get('#start').onclick();
  t.mock.timers.tick(1200);
  await tick();
  p.pagehide();
  await retry;
  assert.equal(p.timers.size, 0);
  const count = p.calls().length;
  t.mock.timers.tick(700_000);
  assert.equal(p.calls().length, count);
  assert.equal(p.get('#refresh').disabled, true);
});

test('概览仅使用允许的字段、路径、端点和模型标识', async t => {
  const p = page(t);
  await loaded(p, { ready: true, alive: true, state: 'bridge', core: { state: 'ready', platform: 'linux-arm64', version: 'v0.1.4582' }, models: { count: 3, sample: ['provider/chat', 'sk-testprivate', 'https://private'] },
    autoRecoveryPaused: false, endpoint: 'http://127.0.0.1:8317/v1', configPath: '/local/settings.json', dataDir: '/local', credentialsFile: '/private', apiKey: 'private', gatewayError: 'Error\n at private', loginHint: 'token=private' });
  const details = p.diagnosticText();
  for (const expected of ['Magpie 已响应', '已通过 SHA256', 'Linux arm64', 'v0.1.4582', '3 个', 'provider/chat', '8317/v1', '允许恢复', '/local/settings.json', '检查管理端口']) assert.ok(details.includes(expected));
  assert.doesNotMatch(details, /private|token|Error/);
  const refresh = p.get('#refresh').onclick();
  p.statusReply({ ready: false, core: { state: 'custom' }, endpoint: 'http://127.0.0.1:8317/v1?k=private', dataDir: '/local\n at private' });
  await refresh;
  assert.match(p.diagnosticText(), /自定义 BRIDGE_BIN/);
  assert.doesNotMatch(p.diagnosticText(), /8317|private|provider\/chat/);
});

test("重连中关闭后不接受迟到握手，也不再次显示重连", async t => {
  const p = page(t);
  t.mock.timers.tick(30_000);
  await tick();
  const retry = p.get("#reconnect").onclick();
  const id = p.sent.at(-1).id;
  p.receive({ jsonrpc: "2.0", id: "close", method: "ui/resource-teardown" });
  await retry;
  const count = p.sent.length;
  p.reply(id, { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} } });
  await p.get("#reconnect").onclick();
  assert.equal(p.sent.length, count);
  assert.equal(p.get("#reconnect").hidden, true);
  assert.equal(p.get("#refresh").disabled, true);
  assert.equal(p.timers.size, 0);
});
test("回收清理请求、禁止迟到状态与启动停止副作用", async t => {
  const p = page(t);
  await loaded(p);
  const task = p.get("#open").onclick();
  p.receive({ jsonrpc: "2.0", id: "close", method: "ui/resource-teardown" });
  await task;
  assert.equal(p.timers.size, 0);
  assert.equal(p.get("#open").disabled, true);
  assert.ok(p.sent.some(message => message.id === "close" && message.result));
  assert.equal(p.calls().some(call => call.params.name === "bridge_stop"), false);
});
test("主题通知和取消提示不发送写入", async t => {
  const p = page(t);
  await loaded(p);
  p.notify("ui/notifications/host-context-changed", { theme: "light" });
  p.notify("ui/notifications/tool-cancelled", {});
  assert.equal(p.document.documentElement.style.colorScheme, "light");
  assert.equal(p.document.documentElement.dataset.theme, "light");
  assert.match(p.get("#notice").textContent, /已取消/);
  assert.equal(p.calls().length, 1);
});
