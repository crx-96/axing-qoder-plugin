const main = document.querySelector("main");
const status = document.querySelector("#status");
const heading = document.querySelector("h1");
const open = document.querySelector("#open");
const pending = new Map();
let sequence = 0;
let ready = false;
let closed = false;
let busy = false;
let initialResult;
const send = message => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");

function report(text, canOpen = false, title = "订阅代理管理") {
  heading.textContent = title;
  status.textContent = text;
  open.hidden = !canOpen;
  main.hidden = false;
}
function controls() { open.disabled = !ready || closed || busy; }
function request(method, params) {
  if (closed || pending.size >= 2) return Promise.reject(Error("应用未连接，请重新打开。"));
  const id = `management-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("打开结果未确认，请先检查浏览器窗口，再决定是否重试。")); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch { clearTimeout(timer); pending.delete(id); reject(Error("无法连接 Qoder，请重新打开应用。")); }
  });
}
function render(result) {
  if (closed) return;
  if (result?.isError) {
    report(result.content?.find(item => item.type === "text")?.text || "管理页打开失败，请检查代理状态后重试。", ready);
    return;
  }
  // 回收通知只销毁页面实例，不保证退出全局入口；保留页面避免宿主显示失效占位。
  report("已向系统默认浏览器发送打开请求。请切换到浏览器，继续管理订阅与账号。", ready, "请在浏览器中继续");
}
function hostContext(context) {
  if (["light", "dark"].includes(context?.theme)) document.documentElement.style.colorScheme = context.theme;
}
function receive(event) {
  if (closed || event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (!message.method && pending.has(message.id)) {
    if (!("result" in message) && !("error" in message)) return;
    const task = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(Error("Qoder 未完成打开操作，请检查浏览器后再重试。"));
    else task.resolve(message.result);
  } else if (message.method === "ui/notifications/tool-result") {
    initialResult = message.params;
    if (ready) render(initialResult);
  } else if (message.method === "ui/notifications/host-context-changed") hostContext(message.params);
  else if (message.method === "ui/notifications/tool-cancelled") report("打开已取消，请先检查浏览器窗口，再按需重试。", true);
  else if (message.id !== undefined) {
    if (message.method === "ping") send({ id: message.id, result: {} });
    else if (message.method === "ui/resource-teardown") { send({ id: message.id, result: {} }); dispose(); }
    else send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
  }
}
async function openManagement() {
  if (!ready || busy || closed) return;
  busy = true;
  controls();
  report("正在请求系统默认浏览器打开管理页…", true);
  try {
    const result = await request("tools/call", { name: "bridge_open_management", arguments: {} });
    if (!closed) render(result);
  } catch (error) { if (!closed) report(error.message, true); }
  finally { busy = false; controls(); }
}
function dispose() {
  if (closed) return;
  closed = true;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error("应用已关闭。")); }
  pending.clear();
  window.removeEventListener("message", receive);
  open.removeEventListener("click", openManagement);
  controls();
}
window.addEventListener("message", receive);
window.addEventListener("pagehide", dispose, { once: true });
open.addEventListener("click", openManagement);
if (window.parent === window) report("请从 Qoder“更多 → 订阅代理管理”打开此入口。");
else request("ui/initialize", {
  protocolVersion: "2026-01-26", appInfo: { name: "subscription-management", version: "1.0.10" },
  appCapabilities: { availableDisplayModes: ["fullscreen"] },
}).then(result => {
  if (closed) return;
  if (result?.protocolVersion !== "2026-01-26") throw Error("Qoder 不支持当前应用协议，请升级客户端。");
  ready = Boolean(result.hostCapabilities?.serverTools);
  hostContext(result.hostContext);
  send({ method: "ui/notifications/initialized", params: {} });
  controls();
  if (!ready) report("此会话不支持管理工具，请在本机 Qoder 中打开。");
  else if (initialResult) render(initialResult);
}).catch(error => { if (!closed) report(error.message); });
