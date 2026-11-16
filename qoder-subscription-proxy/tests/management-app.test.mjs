import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { managementAppResource } from "../server/management-app.mjs";

const script = await readFile(new URL("../server/panel/management-app.js", import.meta.url), "utf8");
const success = { content: [{ type: "text", text: "已请求系统浏览器打开授权与账号管理页。" }] };
const tick = () => new Promise(resolve => setImmediate(resolve));

function page(t) {
  const listeners = new Map();
  const sent = [];
  const timers = new Map();
  function element() {
    const events = new Map();
    return { events, disabled: true, hidden: true, textContent: "", addEventListener: (name, listener) => events.set(name, listener),
      removeEventListener: name => events.delete(name) };
  }
  const elements = { main: element(), h1: element(), "#status": element(), "#open": element() };
  elements.main.hidden = false;
  const parent = { postMessage: message => sent.push(message) };
  const window = { parent, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) };
  const document = { querySelector: id => elements[id], documentElement: { style: {} } };
  runInNewContext(script, { document, window, console,
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.set(timer, { fn, ms }); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); } });
  t.after(() => { for (const timer of timers.keys()) clearTimeout(timer); });
  const receive = (data, source = parent) => listeners.get("message")?.({ data, source });
  return { sent, elements, document, receive, timers,
    reply(id, result) { receive({ jsonrpc: "2.0", id, result }); },
    notify(method, params) { receive({ jsonrpc: "2.0", method, params }); },
    closing() { return sent.filter(message => message.method === "ui/notifications/request-teardown"); },
  };
}

async function initialize(p, capabilities = { serverTools: {} }, displayMode = "fullscreen") {
  p.reply(p.sent[0].id, { protocolVersion: "2026-01-26", hostCapabilities: capabilities, hostContext: { theme: "dark", displayMode } });
  await tick();
}

function expectOpened(p) {
  assert.equal(p.elements.main.hidden, false);
  assert.equal(p.elements.h1.textContent, "请在浏览器中继续");
  assert.match(p.elements["#status"].textContent, /已向系统默认浏览器发送打开请求/);
  assert.equal(p.elements["#open"].hidden, false);
  assert.equal(p.elements["#open"].disabled, false);
  assert.equal(p.closing().length, 0);
}

test("入口文案显示打开状态和再次打开按钮，不包含重试按钮", async () => {
  const resource = await managementAppResource();
  assert.match(resource.text, /<main><h1>订阅代理管理/);
  assert.match(resource.text, /<button[^>]*>再次打开管理页<\/button>/);
  assert.doesNotMatch(resource.text, /<button[^>]*>[^<]*重试/);
});

test("先到达的成功结果初始化后保留提示，不回收页面或重复打开浏览器", async t => {
  const p = page(t);
  p.notify("ui/notifications/tool-result", success);
  await initialize(p);
  expectOpened(p);
  assert.equal(p.sent.filter(message => message.method === "tools/call").length, 0);
  assert.equal(p.timers.size, 0);
  assert.equal(p.document.documentElement.style.colorScheme, "dark");
});

test("没有宿主工具能力时隐藏操作，不调用工具或请求关闭", async t => {
  const p = page(t);
  await initialize(p, {});
  assert.equal(p.elements.main.hidden, false);
  assert.equal(p.elements["#open"].hidden, true);
  assert.equal(p.elements["#open"].disabled, true);
  await p.elements["#open"].events.get("click")();
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
  assert.equal(p.closing().length, 0);
});

test("失败后再次打开只执行一次，成功恢复提示和可用按钮", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", { isError: true, content: [{ type: "text", text: "启动失败" }] });
  const open = p.elements["#open"].events.get("click");
  const first = open();
  await open();
  assert.equal(p.elements.main.hidden, false);
  assert.equal(p.elements["#open"].disabled, true);
  assert.match(p.elements["#status"].textContent, /正在请求/);
  const calls = p.sent.filter(message => message.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, "bridge_open_management");
  p.reply(calls[0].id, success);
  await first;
  expectOpened(p);
});

test("成功后允许用户再次打开，但不因重复通知自动打开", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", success);
  p.notify("ui/notifications/tool-result", success);
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
  const opened = p.elements["#open"].events.get("click")();
  const calls = p.sent.filter(message => message.method === "tools/call");
  assert.equal(calls.length, 1);
  p.reply(calls[0].id, success);
  await opened;
  expectOpened(p);
});

test("伪造来源不能更改显示、调用宿主或关闭页面", async t => {
  const p = page(t);
  await initialize(p);
  p.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: success }, {});
  assert.equal(p.closing().length, 0);
  assert.equal(p.elements.h1.textContent, "");
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
});

test("真实打开失败仍显示原因，不自动重新打开或关闭", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", { isError: true, content: [{ type: "text", text: "核心未就绪" }] });
  assert.equal(p.elements["#status"].textContent, "核心未就绪");
  assert.equal(p.elements.h1.textContent, "订阅代理管理");
  assert.equal(p.elements.main.hidden, false);
  assert.equal(p.elements["#open"].hidden, false);
  assert.equal(p.elements["#open"].disabled, false);
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
  assert.equal(p.closing().length, 0);
});

test("宿主回收时清理未完成请求，不调用停止代理或接收迟到结果", async t => {
  const p = page(t);
  await initialize(p);
  const opened = p.elements["#open"].events.get("click")();
  const call = p.sent.find(message => message.method === "tools/call");
  assert.equal(p.timers.size, 1);
  p.receive({ jsonrpc: "2.0", id: "close", method: "ui/resource-teardown", params: {} });
  await opened;
  p.reply(call.id, success);
  assert.equal(p.timers.size, 0);
  assert.equal(p.elements["#open"].disabled, true);
  assert.notEqual(p.elements.h1.textContent, "请在浏览器中继续");
  assert.ok(p.sent.some(message => message.id === "close" && message.result));
  assert.equal(p.sent.some(message => message.params?.name === "bridge_stop"), false);
});

test("返回页面及主题切换仍保留成功提示，不自动重新打开", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", success);
  p.notify("ui/notifications/host-context-changed", { theme: "light" });
  expectOpened(p);
  assert.equal(p.document.documentElement.style.colorScheme, "light");
  assert.equal(p.timers.size, 0);
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
});

test("非独立视图同样保留浏览器提示，不发送关闭通知", async t => {
  const p = page(t);
  await initialize(p, { serverTools: {} }, "inline");
  p.notify("ui/notifications/tool-result", success);
  expectOpened(p);
});

test("打开超时提示结果未确认，允许手动操作而不自动重发", async t => {
  const p = page(t);
  await initialize(p);
  const opened = p.elements["#open"].events.get("click")();
  const timeout = [...p.timers.values()].find(timer => timer.ms === 30000);
  timeout.fn();
  await opened;
  assert.match(p.elements["#status"].textContent, /打开结果未确认/);
  assert.equal(p.elements["#open"].disabled, false);
  assert.equal(p.sent.filter(message => message.method === "tools/call").length, 1);
});

test("取消操作不误显示成功，也不自动重发", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-cancelled", {});
  assert.match(p.elements["#status"].textContent, /已取消/);
  assert.equal(p.elements.h1.textContent, "订阅代理管理");
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
});
