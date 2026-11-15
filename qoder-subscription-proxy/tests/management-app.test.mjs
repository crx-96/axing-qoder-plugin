import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

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
  const elements = { main: element(), "#status": element(), "#open": element() };
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

test("先到达的成功结果在初始化后请求关闭，不重复打开浏览器或显示中间页", async t => {
  const p = page(t);
  p.notify("ui/notifications/tool-result", success);
  assert.equal(p.closing().length, 0);
  await initialize(p);
  assert.equal(p.closing().length, 1);
  assert.equal(p.elements.main.hidden, true);
  assert.equal(p.sent.filter(message => message.method === "tools/call").length, 0);
  assert.equal(p.document.documentElement.style.colorScheme, "dark");
});

test("没有宿主工具能力时显示错误，不调用工具或请求关闭", async t => {
  const p = page(t);
  await initialize(p, {});
  assert.equal(p.elements.main.hidden, false);
  assert.equal(p.elements["#open"].disabled, true);
  await p.elements["#open"].events.get("click")();
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
  assert.equal(p.closing().length, 0);
});

test("失败后显式重试只执行一次，成功即关闭而非保留再次打开按钮", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", { isError: true, content: [{ type: "text", text: "启动失败" }] });
  const open = p.elements["#open"].events.get("click");
  const first = open();
  await open();
  const calls = p.sent.filter(message => message.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, "bridge_open_management");
  p.reply(calls[0].id, success);
  await first;
  assert.equal(p.elements["#open"].disabled, true);
  assert.equal(p.elements.main.hidden, true);
  assert.equal(p.closing().length, 1);
});

test("伪造来源不能更改显示、调用宿主或关闭页面", async t => {
  const p = page(t);
  await initialize(p);
  p.receive({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: success }, {});
  assert.equal(p.closing().length, 0);
  assert.equal(p.elements.main.hidden, true);
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
});

test("打开失败才显示重试，不自动重试或关闭", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", { isError: true, content: [{ type: "text", text: "核心未就绪" }] });
  await tick();
  assert.equal(p.elements["#status"].textContent, "核心未就绪");
  assert.equal(p.elements.main.hidden, false);
  assert.equal(p.elements["#open"].hidden, false);
  assert.equal(p.elements["#open"].disabled, false);
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
  assert.equal(p.closing().length, 0);
});

test("宿主回收时清理请求和关闭超时，不调用停止代理", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", success);
  assert.equal(p.timers.size, 1);
  p.receive({ jsonrpc: "2.0", id: "close", method: "ui/resource-teardown", params: {} });
  await tick();
  assert.equal(p.timers.size, 0);
  assert.equal(p.elements["#open"].disabled, true);
  assert.ok(p.sent.some(message => message.id === "close" && message.result));
  assert.equal(p.sent.some(message => message.params?.name === "bridge_stop"), false);
});

test("重复成功通知只请求一次关闭，等待回收时不能再打开", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", success);
  p.notify("ui/notifications/tool-result", success);
  await p.elements["#open"].events.get("click")();
  assert.equal(p.closing().length, 1);
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
});

test("非独立视图不调用其不支持的关闭通知", async t => {
  const p = page(t);
  await initialize(p, { serverTools: {} }, "inline");
  p.notify("ui/notifications/tool-result", success);
  assert.equal(p.closing().length, 0);
  assert.match(p.elements["#status"].textContent, /不支持自动关闭/);
});

test("宿主未完成关闭时如实提示，不假称已关闭也不重复打开", async t => {
  const p = page(t);
  await initialize(p);
  p.notify("ui/notifications/tool-result", success);
  const timeout = [...p.timers.values()].find(timer => timer.ms === 5000);
  assert.ok(timeout);
  timeout.fn();
  assert.match(p.elements["#status"].textContent, /尚未关闭/);
  assert.equal(p.elements.main.hidden, false);
  assert.equal(p.elements["#open"].hidden, true);
  assert.equal(p.closing().length, 1);
  assert.equal(p.sent.some(message => message.method === "tools/call"), false);
});
