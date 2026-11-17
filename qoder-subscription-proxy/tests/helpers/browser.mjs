import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function connectBrowser(profile) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let text;
    try { text = await readFile(join(profile, "DevToolsActivePort"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const port = text?.split(/\r?\n/)[0];
    if (port && /^\d+$/.test(port)) {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
      const url = tabs.find(tab => tab.type === "page" && tab.url === "about:blank")?.webSocketDebuggerUrl;
      if (url?.startsWith(`ws://127.0.0.1:${port}/devtools/page/`)) {
        const socket = new WebSocket(url);
        await once(socket, "open", { signal: AbortSignal.timeout(5000) });
        return socket;
      }
    }
    await delay(100);
  }
  throw Error("隔离浏览器未提供调试入口");
}

export function cdpClient(socket) {
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const response = JSON.parse(event.data);
    const item = pending.get(response.id);
    if (!item) return;
    response.error ? item.reject(Error(response.error.message)) : item.resolve(response.result);
  });
  const disconnected = () => { for (const item of pending.values()) item.reject(Error("浏览器调试连接已关闭")); };
  socket.addEventListener("close", disconnected);
  socket.addEventListener("error", disconnected);
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => finish(Error("浏览器响应超时")), 10000);
    const finish = (error, result) => {
      clearTimeout(timer); pending.delete(id);
      error ? reject(error) : resolve(result);
    };
    pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error) });
    if (socket.readyState !== WebSocket.OPEN) { finish(Error("浏览器调试连接已关闭")); return; }
    socket.send(JSON.stringify({ id, method, params }));
  });
}
