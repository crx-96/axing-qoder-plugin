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
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
      querySelectorAll() { return []; }, setAttribute() {}, focus() {} };
  }
  const parent = { postMessage: message => sent.push(message) };
  const window = { parent, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  const document = { querySelector(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element, documentElement: { style: {} } };
  runInNewContext(script, { document, window, console, pluginVersion: PLUGIN_VERSION,
    setTimeout(fn, ms) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); } });
  const receive = (data, source = parent) => listeners.get("message")?.({ data, source });
  return { sent, document, receive, timers, get: id => document.querySelector(id),
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
  assert.doesNotMatch(resource.text, /审批|bridge_approval_|<form|<select/);
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
test("显式启动跨过 10 分钟准备预算后仍可接收结果，只刷新一次最新状态", async t => {
  const p = page(t);
  await loaded(p, { ready: false });
  const task = p.get("#start").onclick();
  const start = p.calls()[1];
  t.mock.timers.tick(600_000);
  await tick();
  assert.match(p.get("#status").textContent, /正在启动/);
  for (const id of ["#open", "#refresh", "#start"]) {
    assert.equal(p.get(id).disabled, true);
    await p.get(id).onclick();
  }
  assert.deepEqual(p.calls().map(call => call.params.name), ["bridge_status", "bridge_start"]);
  p.reply(start.id, { content: [] });
  await tick();
  assert.equal(p.calls()[2].params.name, "bridge_status");
  assert.equal(p.get("#start").disabled, true);
  const count = p.sent.length;
  p.reply(start.id, { isError: true });
  assert.equal(p.sent.length, count);
  p.reply(p.calls()[2].id, { content: [{ text: JSON.stringify({ ready: false, reason: "最新状态仍未就绪" }) }] });
  await task;
  assert.equal(p.get("#status").textContent, "最新状态仍未就绪");
  assert.equal(p.get("#start").disabled, false);
  assert.equal(p.timers.size, 0);
});
test("启动等待到期后可手动查询，迟到结果不覆盖状态或回送错误", async t => {
  const p = page(t);
  await loaded(p, { ready: false });
  const task = p.get("#start").onclick();
  const start = p.calls()[1];
  t.mock.timers.tick(11 * 60_000);
  await task;
  assert.match(p.get("#status").textContent, /结果未知.*刷新状态/);
  assert.equal(p.get("#refresh").disabled, false);
  assert.equal(p.calls().length, 2);
  const refresh = p.get("#refresh").onclick();
  p.reply(p.calls()[2].id, { content: [{ text: JSON.stringify(status) }] });
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
for (const [label, value, expected] of [
  ["暂停", { autoRecoveryPaused: true, startupError: "过期启动错误" }, /自动恢复已暂停/],
  ["准备中", { core: { state: "downloading", reason: "正在准备当前平台核心，请稍候。" }, startupError: "过期启动错误" }, /正在准备当前平台核心/],
  ["启动失败", { startupError: "代理后台准备失败（CORE_DOWNLOAD）" }, /代理后台准备失败/],
  ["模型失败", { models: { note: "模型查询失败：HTTP 503" }, core: { state: "ready", reason: "核心缓存已通过 SHA256 校验。" } }, /模型查询失败/],
  ["缺失核心", { core: { state: "missing", reason: "核心尚未安装" } }, /核心尚未安装/],
  ["无效核心", { core: { state: "invalid", reason: "核心摘要不一致" } }, /核心摘要不一致/],
  ["下载失败", { core: { state: "error", reason: "核心下载失败" } }, /核心下载失败/],
  ["未就绪", { core: { state: "ready", reason: "核心缓存已通过 SHA256 校验。" } }, /核心尚未就绪/],
  ["错误文本", { startupError: "失败 <img src=x onerror=alert(1)>" }, /<img src=x onerror=alert\(1\)>/],
]) {
  test(`管理页展示真实状态字段：${label}`, async t => {
    const p = page(t);
    await loaded(p, { ready: false, ...value });
    assert.match(p.get("#status").textContent, expected);
    assert.equal(p.get("#start").hidden, false);
    assert.deepEqual(p.calls().map(call => call.params.name), ["bridge_status"]);
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
  assert.equal(p.get("#status").textContent, "<img onerror=alert(1)>打开失败");
  const next = p.get("#open").onclick();
  p.reply(p.calls()[2].id, { content: [] });
  await next;
  assert.match(p.get("#status").textContent, /已向系统默认浏览器/);
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
  assert.match(p.get("#status").textContent, /结果未知/);
  assert.doesNotMatch(p.get("#status").textContent, /secret/);
  task = p.get("#open").onclick();
  t.mock.timers.tick(30_000);
  await task;
  assert.match(p.get("#status").textContent, /结果未知/);
  assert.equal(p.calls().length, 3);
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
  assert.match(p.get("#status").textContent, /已取消/);
  assert.equal(p.calls().length, 1);
});
