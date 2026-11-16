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
import { createAcpService, getAcpService } from "../server/acp-service.mjs";

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

test("真实浏览器验证入口返回、居中布局、主题、重复打开和错误恢复", {
  skip: !browser && "未设置 BRIDGE_TEST_BROWSER；跳过真实 Chromium 入口页",
  timeout: 60000,
}, async t => {
  assert.ok(isAbsolute(browser));
  const directory = await mkdtemp(join(tmpdir(), "subscription-entry-browser-"));
  const profile = join(directory, "browser");
  let child, exited, socket, send, host;
  t.after(async () => {
    try { await stopBrowser(child, exited, send); }
    finally {
      socket?.close();
      if (host) { host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  });
  const resource = await managementAppResource();
  host = createHttpServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/shell") { res.end(resource.text); return; }
    res.end(`<!doctype html><html><body style="margin:0"><iframe id="app" src="/shell" sandbox="allow-scripts allow-same-origin" style="display:block;border:0;width:100vw;height:100vh"></iframe><script>
      const app=document.querySelector('#app');window.calls=0;window.teardowns=0;window.failNext=false;
      window.notify=(method,params)=>app.contentWindow.postMessage({jsonrpc:'2.0',method,params},location.origin);
      window.addEventListener('message',event=>{
        if(event.source!==app.contentWindow||event.origin!==location.origin)return;
        const message=event.data;
        const reply=result=>app.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result},location.origin);
        if(message.method==='ui/initialize')reply({protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}},hostContext:{theme:'dark',displayMode:'fullscreen'}});
        else if(message.method==='ui/notifications/initialized')window.notify('ui/notifications/tool-result',{content:[]});
        else if(message.method==='tools/call'){
          window.calls++;
          reply(window.failNext?{isError:true,content:[{type:'text',text:'无法打开系统默认浏览器。'}]}:{content:[]});window.failNext=false;
        }else if(message.method==='ui/notifications/request-teardown'){
          window.teardowns++;app.srcdoc='<p>交互界面暂时无法打开</p><button>重试</button>';
        }
      });</script></body></html>`);
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0",
    ...(process.platform === "win32" && /msedge\.exe$/i.test(browser) ? ["--edge-skip-compat-layer-relaunch"] : []),
    "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
  exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  await once(child, "spawn");
  socket = await connectBrowser(profile);
  const exceptions = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params);
  });
  send = cdpClient(socket);
  await send("Runtime.enable");
  const evaluate = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  async function waitFor(expression) {
    const deadline = Date.now() + 5000;
    while (!await evaluate(expression)) {
      if (Date.now() >= deadline) {
        const state = await evaluate("({calls:window.calls,teardowns:window.teardowns,text:document.querySelector('#app')?.contentDocument.body?.innerText})");
        assert.fail(`入口页面状态未在期限内更新：${expression}；${JSON.stringify(state)}`);
      }
      await delay(50);
    }
  }
  await send("Page.navigate", { url: `http://127.0.0.1:${host.address().port}/` });
  const doc = "document.querySelector('#app').contentDocument";
  await waitFor(`${doc}?.querySelector('h1')?.textContent==='请在浏览器中继续'`);
  for (const [width, height] of [[1280, 800], [360, 640], [2000, 437]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await evaluate(`window.notify('ui/notifications/host-context-changed',{theme:'${theme}'})`);
      await waitFor(`${doc}.documentElement.style.colorScheme==='${theme}'`);
      const layout = await evaluate(`(() => {
        const doc=${doc},main=doc.querySelector('main'),box=main.getBoundingClientRect(),button=doc.querySelector('#open');
        return {x:box.x+box.width/2,y:box.y+box.height/2,width:doc.documentElement.scrollWidth,
          height:doc.documentElement.scrollHeight,text:main.innerText,button:button.textContent,disabled:button.disabled};
      })()`);
      assert.ok(Math.abs(layout.x - width / 2) <= 1, "内容水平居中");
      assert.ok(Math.abs(layout.y - height / 2) <= 1, "内容垂直居中");
      assert.equal(layout.width, width, "窄屏不产生水平滚动");
      assert.equal(layout.height, height, "正常文案不产生垂直溢出");
      assert.equal(layout.button, "再次打开管理页");
      assert.equal(layout.disabled, false);
      assert.doesNotMatch(layout.text, /重试|失败|暂时无法打开/);
    }
  }
  await evaluate("document.querySelector('#app').style.display='none'");
  await evaluate("document.querySelector('#app').style.display='block'");
  assert.equal(await evaluate("window.calls"), 0, "返回入口不自动打开新窗口");
  await evaluate(`${doc}.querySelector('#open').focus()`);
  assert.equal(await evaluate(`${doc}.activeElement.id`), "open");
  await send("Page.bringToFront");
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor(`window.calls===1 && !${doc}.querySelector('#open').disabled`);
  await evaluate(`window.failNext=true;${doc}.querySelector('#open').click()`);
  await waitFor(`${doc}.querySelector('#status').textContent==='无法打开系统默认浏览器。'`);
  assert.equal(await evaluate(`${doc}.querySelector('h1').textContent`), "订阅代理管理");
  await evaluate(`${doc}.querySelector('#open').click()`);
  await waitFor(`${doc}.querySelector('h1').textContent==='请在浏览器中继续'`);
  assert.equal(await evaluate("window.calls"), 3);
  assert.equal(await evaluate("window.teardowns"), 0);
  assert.deepEqual(exceptions, [], "页面无未捕获的脚本异常");
});

test("保留入口并连续打开管理页，真实浏览器验证 ACP 连接、认证、停用及过期", {
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
  await getAcpService(config).close();
  let failConnect = false, authenticated;
  const acp = createAcpService(config, {
    prepareRuntime: async () => {
      if (failConnect) throw Object.assign(Error("fixture failure"), { code: "ACP_START_FAILED", safeMessage: "测试连接失败" });
      return { path: "fixture", source: "host", version: "1.5.0" };
    },
    Connection: class {
      async initialize() { return { authMethods: [{ id: "gemini-api-key" }] }; }
      async call(method, args) {
        if (method === "authenticate") { authenticated = args.methodId; return {}; }
        assert.equal(method, "session/new");
        return { sessionId: "browser-fixture", models: { availableModels: [{ modelId: "fixture", name: "Browser fixture" }] } };
      }
      async close() {}
    },
  });
  await acp.listen();
  t.after(() => acp.close());
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
        if(app){app.contentDocument.querySelector('#open').click();return;}
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
      const state = (await send("Runtime.evaluate", { expression: `({closed:window.closedApps,frames:document.querySelectorAll('iframe').length,
        ready:document.querySelector('iframe')?.contentDocument.querySelector('h1')?.textContent==='请在浏览器中继续'
          &&!document.querySelector('iframe')?.contentDocument.querySelector('#open')?.disabled})`, returnByValue: true })).result.value;
      if (opened === count && state.ready) {
        assert.equal(state.closed, 0, "成功后不能销毁仍展示的入口");
        assert.equal(state.frames, 1, "返回时复用入口页面");
        return;
      }
      await delay(100);
    }
    throw Error("管理入口未完成浏览器打开和状态更新");
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
  const evaluate = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  const waitFor = async expression => {
    const deadline = Date.now() + 10000;
    while (!await evaluate(expression)) {
      assert.ok(Date.now() < deadline, `页面状态未更新：${expression}`);
      await delay(50);
    }
  };
  await evaluate("Array.from(document.querySelectorAll('button')).find(element => element.textContent.trim() === 'Antigravity').click()");
  await waitFor("document.body.innerText.includes('Google 模型已迁移至 ACP')");
  await evaluate("document.querySelector('a[href=\"/acp\"]').click()");
  await waitFor("location.pathname==='/acp' && document.querySelector('#status')?.textContent.includes('尚未连接')");
  await evaluate("document.querySelector('#connect').click()");
  await waitFor("document.querySelector('#status').textContent.includes('已就绪') && !document.querySelector('#connect').disabled");
  assert.match(await evaluate("document.querySelector('#models').innerText"), /acp\/fixture/);
  await evaluate("document.querySelector('#method').value='gemini-api-key';document.querySelector('#login').click()");
  await waitFor("document.querySelector('#status').textContent.includes('已就绪') && !document.querySelector('#login').disabled");
  assert.equal(authenticated, "gemini-api-key");
  await evaluate("document.querySelector('#stop').click()");
  await waitFor("document.querySelector('#status').textContent.includes('已停用')");
  assert.equal(await evaluate("document.querySelector('#models').children.length"), 0);
  failConnect = true;
  await evaluate("document.querySelector('#connect').click()");
  await waitFor("document.querySelector('#status').textContent.includes('测试连接失败') && !document.querySelector('#connect').disabled");
  failConnect = false;
  await evaluate("document.querySelector('#connect').click()");
  await waitFor("document.querySelector('#status').textContent.includes('已就绪') && !document.querySelector('#connect').disabled");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate("document.documentElement.scrollWidth === document.documentElement.clientWidth"), true, "ACP 页面窄屏不溢出");
  await evaluate("sessionStorage.removeItem('bridge-panel-session');document.querySelector('#refresh').click()");
  await waitFor("document.querySelector('#status').textContent.includes('登录已过期')");
});
