import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { managementAppResource } from "../server/management-app.mjs";
import { handleMessage } from "../server/mcp-protocol.mjs";
import { ensureRunning, shutdownOwnedBridges } from "../server/supervisor.mjs";
import { loadConfig } from "../server/config.mjs";
import { createManagementLogin } from "../server/management-gateway.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const browser = process.env.BRIDGE_TEST_BROWSER;
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connectBrowser(profile) {
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
        const connection = new WebSocket(url);
        await once(connection, "open", { signal: AbortSignal.timeout(5000) });
        return connection;
      }
    }
    await delay(100);
  }
  throw new Error("隔离 Chromium 浏览器未提供空白测试标签页");
}

function cdpClient(socket) {
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const response = JSON.parse(event.data);
    const settle = pending.get(response.id);
    if (!settle) return;
    pending.delete(response.id);
    if (response.error) settle.reject(new Error(response.error.message));
    else settle.resolve(response.result);
  });
  const disconnected = () => {
    for (const settle of pending.values()) settle.reject(new Error("浏览器调试连接已关闭"));
    pending.clear();
  };
  socket.addEventListener("close", disconnected, { once: true });
  socket.addEventListener("error", disconnected, { once: true });
  return (method, params = {}) => {
    if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("浏览器调试连接未就绪"));
    const id = ++next;
    const signal = AbortSignal.timeout(10000);
    return new Promise((resolve, reject) => {
      const timeout = () => { pending.delete(id); reject(new Error("浏览器调试接口超时")); };
      signal.addEventListener("abort", timeout, { once: true });
      pending.set(id, {
        resolve(value) { signal.removeEventListener("abort", timeout); resolve(value); },
        reject(error) { signal.removeEventListener("abort", timeout); reject(error); },
      });
      socket.send(JSON.stringify({ method, params, id }));
    });
  };
}

async function stopBrowser(child, exited, send, timeoutMs = 3000) {
  if (send) await send("Browser.close").catch(() => {});
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  async function waitForExit() {
    let timer;
    try {
      return await Promise.race([exited.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  if (await waitForExit()) return;
  child.kill();
  assert.ok(await waitForExit(), "测试浏览器未在清理期限内退出");
}

test("浏览器调试连接关闭时立即拒绝尚未响应的请求", async () => {
  const socket = new EventTarget();
  socket.readyState = WebSocket.OPEN;
  socket.send = () => queueMicrotask(() => socket.dispatchEvent(new Event("close")));
  await assert.rejects(cdpClient(socket)("Runtime.evaluate"), /连接已关闭/);
});

test("浏览器启动器已退出时仍通过调试会话关闭实际浏览器", async () => {
  const commands = [];
  await stopBrowser({ pid: 1, exitCode: 0, signalCode: null }, Promise.resolve(), async method => commands.push(method));
  assert.deepEqual(commands, ["Browser.close"]);
});

test("浏览器退出失败时清理有界，不无限等待初始进程", async () => {
  let killed = false;
  await assert.rejects(stopBrowser({ pid: 1, exitCode: null, signalCode: null, kill() { killed = true; } },
    new Promise(() => {}), undefined, 10), /清理期限/);
  assert.equal(killed, true);
});

async function expectAuthorizedPanel(send, config, origin) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await send("Runtime.evaluate", { expression: `({
      oauth: location.hash === "#/oauth",
      path: location.pathname, origin: location.origin, search: location.search,
      ready: !window.testDocumentAboutToReload && document.readyState !== "loading" && /Antigravity/i.test(document.body?.innerText)
        && /Codex/i.test(document.body?.innerText) && !document.querySelector("input[name=cpa-management-key]"),
      tokens: [document.documentElement.outerHTML, location.href, JSON.stringify(sessionStorage),
        JSON.stringify(localStorage)].flatMap(text => text.match(/[a-f0-9]{64}/g) || [])
    })`, returnByValue: true });
    const state = result.result.value;
    if (state?.ready) {
      assert.equal(state.oauth, true);
      assert.equal(state.origin, origin);
      assert.equal(state.path, "/management.html");
      assert.equal(state.search, "");
      assert.ok(!state.tokens.includes(config.mgmtKey), "长期管理密钥不能出现在受控页面或浏览器存储中");
      return;
    }
    await delay(150);
  }
  throw new Error("已兑换的管理页未显示真实 Codex 和 Antigravity 授权选项");
}

test("宿主回收后连续三次入口均打开新浏览器会话，真实管理页保留授权回调", {
  skip: nativeCoreSkip || (!browser && "未设置 BRIDGE_TEST_BROWSER；跳过真实 Chromium 管理页"),
  timeout: 90000,
}, async t => {
  assert.ok(isAbsolute(browser), "请提供受信任的 Chrome 或 Edge 可执行文件绝对路径");
  const directory = await mkdtemp(join(tmpdir(), "subscription-management-browser-"));
  const profile = join(directory, "browser");
  let child, exited, socket, send, login, host;
  t.after(async () => {
    login?.close();
    try { await stopBrowser(child, exited, send); }
    finally {
      socket?.close();
      if (host) { host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); }
      await shutdownOwnedBridges();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  });
  const binary = await copyTestCore(join(directory, process.platform === "win32" ? "test-core.exe" : "test-core"));
  const config = await loadConfig({ pluginRoot, env: {
    BRIDGE_DATA_DIR: join(directory, "data"), BRIDGE_BIN: binary, BRIDGE_PORT: String(await unusedPort()),
    BRIDGE_API_KEY: "synthetic-browser-fixture",
  } });
  assert.equal((await ensureRunning(config)).ready, true);
  child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0",
    ...(process.platform === "win32" && /msedge\.exe$/i.test(browser) ? ["--edge-skip-compat-layer-relaunch"] : []),
    "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
  exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  await once(child, "spawn");
  socket = await connectBrowser(profile);
  send = cdpClient(socket);
  let launchUrl, opened = 0;
  const launches = [];
  login = createManagementLogin(config, { port: await unusedPort(), async launchBrowser(url) {
    launchUrl = url;
    launches.push(url);
    opened++;
  } });
  const resource = await managementAppResource();
  const ctx = { config, supportsApps: true };
  const handlers = { openManagement: (_config, { signal }) => login.open(signal) };
  host = createHttpServer(async (req, res) => {
    try {
      if (req.url === "/shell") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'" });
        res.end(resource.text); return;
      }
      if (req.url === "/rpc" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(await handleMessage(message, ctx, { handlers }))); return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><body style="margin:0"><button id="menu">订阅代理管理</button><script>
      let app,closingId;
      window.closedApps=0;window.intermediateVisible=false;
      function openApp(){
        if(app)return;
        app=document.createElement('iframe');app.id='app';app.style='border:0;width:100vw;height:90vh';
        app.setAttribute('sandbox','allow-scripts allow-same-origin');app.src='/shell';document.body.append(app);
      }
      document.querySelector('#menu').addEventListener('click',openApp);
      window.addEventListener('message',async event=>{
        if(!app||event.source!==app.contentWindow||event.origin!==location.origin||event.data?.jsonrpc!=='2.0')return;
        const message=event.data;
        const send=data=>app.contentWindow.postMessage({jsonrpc:'2.0',...data},location.origin);
        if(!message.method&&message.id===closingId&&message.result){app.remove();app=null;window.closedApps++;return;}
        if(message.method==='ui/initialize')send({id:message.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}},hostContext:{theme:'dark',displayMode:'fullscreen'}}});
        else if(message.method==='ui/notifications/initialized'){
          const response=await(await fetch('/rpc',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:'entry',method:'tools/call',params:{name:'bridge_management_app',arguments:{}}})})).json();
          send({method:'ui/notifications/tool-result',params:response.result});
        }else if(message.method==='ui/notifications/request-teardown'){
          window.intermediateVisible ||= !app.contentDocument.querySelector('main').hidden;
          closingId='close-'+window.closedApps;send({id:closingId,method:'ui/resource-teardown',params:{}});
        }else if(message.method==='tools/call')send(await(await fetch('/rpc',{method:'POST',body:JSON.stringify(message)})).json());
      });</script></body></html>`);
    } catch { res.writeHead(500).end(); }
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  await send("Page.navigate", { url: `http://127.0.0.1:${host.address().port}/` });
  const waitOpen = async count => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const state = (await send("Runtime.evaluate", { expression: `({closed:window.closedApps,visible:window.intermediateVisible,frames:document.querySelectorAll('iframe').length})`, returnByValue: true })).result.value;
      if (opened === count && state.closed === count) {
        assert.equal(state.frames, 0, "成功后入口页面必须被回收");
        assert.equal(state.visible, false, "正常路径不展示中间页");
        return;
      }
      await delay(100);
    }
    throw Error("管理入口未完成浏览器打开和页面回收");
  };
  const menuDeadline = Date.now() + 10000;
  while (!(await send("Runtime.evaluate", { expression: "Boolean(document.querySelector('#menu'))", returnByValue: true })).result.value) {
    assert.ok(Date.now() < menuDeadline, "测试宿主菜单未加载");
    await delay(50);
  }
  for (let count = 1; count <= 3; count++) {
    await send("Runtime.evaluate", { expression: "document.querySelector('#menu').click()" });
    await waitOpen(count);
  }
  assert.equal(new Set(launches).size, 3, "每次进入都产生新的浏览器登录链接");
  await send("Page.navigate", { url: launchUrl });
  const origin = new URL(launchUrl).origin;
  await expectAuthorizedPanel(send, config, origin);
  await send("Runtime.evaluate", { expression: "window.testDocumentAboutToReload = true" });
  await send("Page.reload", { ignoreCache: true });
  await expectAuthorizedPanel(send, config, origin);
  const blocker = createServer(connection => connection.destroy());
  t.after(async () => { if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); });
  for (const manual of [true, false]) {
    if (manual) {
      blocker.listen({ port: 51121, exclusive: true });
      await once(blocker, "listening");
    } else {
      await new Promise(resolve => blocker.close(resolve));
      await send("Runtime.evaluate", { expression: "window.testDocumentAboutToReload = true" });
      await send("Page.reload", { ignoreCache: true });
      await expectAuthorizedPanel(send, config, origin);
    }
    await send("Runtime.evaluate", { expression: "Array.from(document.querySelectorAll('button')).find(element => element.textContent.trim() === 'Antigravity').click()" });
    const deadline = Date.now() + 10000;
    let state;
    while (Date.now() < deadline) {
      const result = await send("Runtime.evaluate", { expression: `(() => {
        const dialog = document.querySelector('.modal');
        if (!dialog) return null;
        const input = dialog.querySelector('input[placeholder^="http://localhost:51121/"]');
        const open = Array.from(dialog.querySelectorAll('button')).find(element => element.textContent.trim() === '打开链接');
        return {ready:!!input&&!input.disabled&&!!open&&!open.disabled,
          manual:dialog.innerText.includes('本机回调监听启动失败，已切换为手动回填'),optional:!!dialog.querySelector('[class*="optional"]')};
      })()`, returnByValue: true });
      state = result.result.value;
      if (state?.ready) break;
      await delay(100);
    }
    assert.equal(state?.ready, true, "授权链接和回调输入应可用");
    assert.equal(state.manual, manual);
    assert.equal(state.optional, !manual, "仅手动降级时回填步骤才为必填");
    await send("Runtime.evaluate", { expression: `(() => {
      const input = document.querySelector('.modal input[placeholder^="http://localhost:51121/"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'http://localhost:51121/oauth-callback?code=synthetic-never-submit&state=wrong-state');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()` });
    await send("Runtime.evaluate", { expression: "Array.from(document.querySelectorAll('.modal button')).find(element => element.textContent.trim() === '提交回调 URL').click()" });
    const validation = await send("Runtime.evaluate", { expression: "document.querySelector('.modal').innerText.includes('请粘贴本次授权的完整 localhost:51121 回调地址')", returnByValue: true });
    assert.equal(validation.result.value, true, "不匹配的 state 必须在浏览器端拒绝");
  }
});
