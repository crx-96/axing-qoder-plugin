/** 取面板中固定的控件或状态区域。 */
const $ = selector => document.querySelector(selector);
/** 请求 ID 对应的 Promise 回调与计时器，仅在等待期间保留。 */
const pending = new Map();
/** 握手和普通工具的响应等待上限，单位为毫秒。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 核心准备可用 10 分钟，额外留 1 分钟供启动及宿主传回结果。 */
const START_TIMEOUT_MS = 11 * 60_000;
/** 当前页面单调递增的请求序号，重连时也不复用。 */
let sequence = 0;
/** 握手状态：idle、connecting、retryable、ready、unsupported 或终态 closed。 */
let connection = "idle";
/** 从用户操作开始到其最后一次状态读取完成，串行占用工具按钮。 */
let busy = false;
/** 向嵌入本页的宿主发送 JSON-RPC 消息。 */
const send = message => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
/** 以纯文本发布状态，关闭后忽略异步提示。 */
const report = text => { if (connection !== "closed") $("#status").textContent = text; };

/** 等待指定请求的响应；本地等待超时不会取消或重发宿主操作。 */
function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (connection === "closed" || pending.size >= 2) return Promise.reject(Error("应用未连接，请重新打开。"));
  const id = `management-${++sequence}`;
  return new Promise((resolve, reject) => {
    // 发出前登记，以便响应、超时和关闭都能定位到同一次请求。
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("结果未知，请刷新状态确认。"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch { clearTimeout(timer); pending.delete(id); reject(Error("无法连接 Qoder，请重新打开应用。")); }
  });
}
/** 调用管理工具；状态查询解析 JSON，显式操作仅检查宿主是否返回错误。 */
async function tool(name, args = {}, json = true) {
  const timeoutMs = name === "bridge_start" ? START_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const result = await request("tools/call", { name, arguments: args }, timeoutMs);
  if (result?.isError) throw Error(result.content?.[0]?.text || "操作失败，请检查核心状态。");
  if (!json) return result;
  try { return JSON.parse(result.content[0].text); }
  catch { throw Error("返回结果无法确认，请刷新状态确认。"); }
}
/** 跟随宿主声明的浅色或深色主题。 */
function hostContext(context) {
  if (["light", "dark"].includes(context?.theme)) document.documentElement.style.colorScheme = context.theme;
}
/** 处理父窗口的响应、通知和请求，只有请求需要回包。 */
function receive(event) {
  if (connection === "closed" || event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  // 迟到或重复响应已无等待者，不能落入宿主请求的 Method not supported 分支。
  if (typeof message.method !== "string") {
    const task = pending.get(message.id);
    if (!task || (!("result" in message) && !("error" in message))) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(Error("Qoder 未完成操作，结果未知；请刷新状态确认。"));
    else task.resolve(message.result);
    return;
  }
  if (message.method === "ui/notifications/host-context-changed") hostContext(message.params);
  else if (message.method === "ui/notifications/tool-cancelled") report("操作已取消；请刷新状态确认。");
  else if (message.method === "ui/notifications/tool-result") {
    if (message.params?.isError) report(message.params.content?.[0]?.text || "入口操作失败。");
  } else if (message.id !== undefined) {
    if (message.method === "ping") send({ id: message.id, result: {} });
    else if (message.method === "ui/resource-teardown") { send({ id: message.id, result: {} }); dispose(); }
    else send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
  }
}
/** 握手未完成时隔离工具操作，仅在可恢复的连接失败后展示重连入口。 */
function controls() {
  for (const id of ["open", "start", "refresh"]) $("#" + id).disabled = connection !== "ready" || busy;
  $("#reconnect").hidden = $("#reconnect").disabled = connection !== "retryable";
}
/** 串行执行一次工具操作，成功、错误或超时后按连接状态恢复控件。 */
async function run(action) {
  if (connection !== "ready" || busy) return;
  busy = true;
  controls();
  try { await action(); }
  catch (error) { report(error.message); }
  finally { busy = false; controls(); }
}
/** 用宿主最新的核心状态更新启动入口和诊断文本。 */
async function readStatus() {
  const status = await tool("bridge_status");
  if (!status || typeof status.ready !== "boolean") throw Error("核心状态返回格式无效，请刷新状态确认。");
  if (connection === "closed") return;
  $("#start").hidden = status.ready;
  if (status.ready) report("核心已就绪。账号与模型配置请打开原生管理页。");
  else if (status.autoRecoveryPaused) report("自动恢复已暂停，请按需启动核心。");
  else if (status.core?.state === "downloading") report(status.core.reason || "正在准备当前平台核心，请稍候。");
  else report(status.startupError || status.reason || status.models?.note
    || (["missing", "invalid", "error"].includes(status.core?.state) && status.core.reason)
    || "核心尚未就绪，请刷新状态或按需启动核心。");
}
/** 关闭后释放宿主监听和所有等待中的请求，异步回调不能再启用控件。 */
function dispose() {
  if (connection === "closed") return;
  connection = "closed";
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error("应用已关闭。")); }
  pending.clear();
  window.removeEventListener("message", receive);
  controls();
}

/** 初次打开或显式重连时重新握手，仅在收到兼容的确认后查询状态。 */
async function connect() {
  if (window.parent === window || !["idle", "retryable"].includes(connection)) return;
  connection = "connecting";
  controls();
  report("正在连接 Qoder…");
  try {
    const result = await request("ui/initialize", {
      protocolVersion: "2026-01-26", appInfo: { name: "subscription-management", version: pluginVersion },
      appCapabilities: { availableDisplayModes: ["fullscreen"] },
    });
    if (connection === "closed") return;
    // 协议或能力不兼容时保留原有提示，仅传输失败提供重连。
    if (result?.protocolVersion !== "2026-01-26") {
      connection = "unsupported";
      report("Qoder 不支持当前应用协议，请升级客户端。");
      return;
    }
    hostContext(result.hostContext);
    send({ method: "ui/notifications/initialized", params: {} });
    if (!result.hostCapabilities?.serverTools) {
      connection = "unsupported";
      report("此会话不支持管理工具，请在本机 Qoder 中打开。");
      return;
    }
    connection = "ready";
    await run(readStatus);
  } catch {
    if (connection === "closed") return;
    connection = "retryable";
    report("未能完成 Qoder 连接，请点击“重新连接”。");
    controls();
  }
}

// 用户显式操作才会打开浏览器或启动核心；启动和后续状态读取共用一次操作锁。
$("#open").onclick = () => run(async () => { await tool("bridge_open_management", {}, false); report("已向系统默认浏览器发送打开请求。请在浏览器中继续原生管理。"); });
$("#start").onclick = () => run(async () => {
  report("正在启动核心，首次准备可能需要 10 分钟。");
  await tool("bridge_start", {}, false);
  report("正在获取最新核心状态…");
  await readStatus();
});
$("#refresh").onclick = () => run(readStatus);
$("#reconnect").onclick = connect;
window.addEventListener("message", receive);
window.addEventListener("pagehide", dispose, { once: true });
controls();
if (window.parent === window) report("请从 Qoder“更多 → 订阅代理管理”打开此入口。");
else connect();
