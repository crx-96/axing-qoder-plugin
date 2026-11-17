const $ = selector => document.querySelector(selector);
const pending = new Map();
let sequence = 0;
let ready = false;
let closed = false;
let busy = false;
const send = message => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
const report = text => { if (!closed) $("#status").textContent = text; };

function request(method, params) {
  if (closed || pending.size >= 2) return Promise.reject(Error("应用未连接，请重新打开。"));
  const id = `management-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("结果未知，请刷新状态确认。")); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch { clearTimeout(timer); pending.delete(id); reject(Error("无法连接 Qoder，请重新打开应用。")); }
  });
}
async function tool(name, args = {}, json = true) {
  const result = await request("tools/call", { name, arguments: args });
  if (result?.isError) throw Error(result.content?.[0]?.text || "操作失败，请检查核心状态。");
  if (!json) return result;
  try { return JSON.parse(result.content[0].text); }
  catch { throw Error("返回结果无法确认，请刷新状态确认。"); }
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
    if (message.error) task.reject(Error("Qoder 未完成操作，结果未知；请刷新状态确认。"));
    else task.resolve(message.result);
  } else if (message.method === "ui/notifications/host-context-changed") hostContext(message.params);
  else if (message.method === "ui/notifications/tool-cancelled") report("操作已取消；请刷新状态确认。");
  else if (message.method === "ui/notifications/tool-result") {
    if (message.params?.isError) report(message.params.content?.[0]?.text || "入口操作失败。");
  } else if (message.id !== undefined) {
    if (message.method === "ping") send({ id: message.id, result: {} });
    else if (message.method === "ui/resource-teardown") { send({ id: message.id, result: {} }); dispose(); }
    else send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
  }
}
function controls() {
  for (const id of ["open", "start", "refresh"]) $("#" + id).disabled = !ready || closed || busy;
}
async function run(action) {
  if (!ready || busy || closed) return;
  busy = true;
  controls();
  try { await action(); }
  catch (error) { report(error.message); }
  finally { busy = false; controls(); }
}
async function readStatus() {
  const status = await tool("bridge_status");
  if (!status || typeof status.ready !== "boolean") throw Error("核心状态返回格式无效，请刷新状态确认。");
  if (closed) return;
  $("#start").hidden = status.ready;
  if (status.ready) report("核心已就绪。账号与模型配置请打开原生管理页。");
  else if (status.autoRecoveryPaused) report("自动恢复已暂停，请按需启动核心。");
  else if (status.core?.state === "downloading") report(status.core.reason || "正在准备当前平台核心，请稍候。");
  else report(status.startupError || status.reason || status.models?.note
    || (["missing", "invalid", "error"].includes(status.core?.state) && status.core.reason)
    || "核心尚未就绪，请刷新状态或按需启动核心。");
}
function dispose() {
  if (closed) return;
  closed = true;
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error("应用已关闭。")); }
  pending.clear();
  window.removeEventListener("message", receive);
  controls();
}
$("#open").onclick = () => run(async () => { await tool("bridge_open_management", {}, false); report("已向系统默认浏览器发送打开请求。请在浏览器中继续原生管理。"); });
$("#start").onclick = () => run(async () => { await tool("bridge_start", {}, false); await readStatus(); });
$("#refresh").onclick = () => run(readStatus);
window.addEventListener("message", receive);
window.addEventListener("pagehide", dispose, { once: true });
controls();
if (window.parent === window) report("请从 Qoder“更多 → 订阅代理管理”打开此入口。");
else request("ui/initialize", {
  protocolVersion: "2026-01-26", appInfo: { name: "subscription-management", version: pluginVersion },
  appCapabilities: { availableDisplayModes: ["fullscreen"] },
}).then(async result => {
  if (closed) return;
  if (result?.protocolVersion !== "2026-01-26") throw Error("Qoder 不支持当前应用协议，请升级客户端。");
  ready = Boolean(result.hostCapabilities?.serverTools);
  hostContext(result.hostContext);
  send({ method: "ui/notifications/initialized", params: {} });
  controls();
  if (!ready) report("此会话不支持管理工具，请在本机 Qoder 中打开。");
  else await run(readStatus);
}).catch(error => { report(error.message); controls(); });
