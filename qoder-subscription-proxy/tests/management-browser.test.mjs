import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { managementAppResource } from "../server/management-app.mjs";
import { connectBrowser, cdpClient } from "./helpers/browser.mjs";

const browser = process.env.BRIDGE_TEST_BROWSER;

test("调试连接关闭立即结束等待", async () => {
  const socket = new EventTarget();
  socket.readyState = WebSocket.OPEN;
  socket.send = () => queueMicrotask(() => socket.dispatchEvent(new Event("close")));
  await assert.rejects(cdpClient(socket)("Runtime.evaluate"), /连接已关闭/);
});

test("真实浏览器验证核心状态、显式启动与原生管理入口", {
  skip: !browser && "未设置 BRIDGE_TEST_BROWSER", timeout: 120000,
}, async t => {
  assert.ok(isAbsolute(browser));
  const directory = await mkdtemp(join(tmpdir(), "magpie-entry-browser-"));
  const profile = join(directory, "browser");
  let child, exited, socket, send, host;
  t.after(async () => {
    if (send) await send("Browser.close").catch(() => {});
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      let timer;
      const ended = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
      clearTimeout(timer);
      if (!ended) { child.kill(); await exited; }
    }
    socket?.close();
    if (host) { host.closeAllConnections(); await new Promise(resolve => host.close(resolve)); }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const resource = await managementAppResource();
  host = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/shell") { res.end(resource.text); return; }
    res.end(`<!doctype html><html><body style="margin:0"><iframe id="app" src="/shell" style="border:0;width:100vw;height:100vh;display:block"></iframe><script>
      const app=document.querySelector('#app');window.calls=[];window.failNext=false;window.data={ready:true};
      window.handshakes=[];window.rpcErrors=[];
      window.notify=(method,params)=>app.contentWindow.postMessage({jsonrpc:'2.0',method,params},location.origin);
      window.addEventListener('message',event=>{
        if(event.source!==app.contentWindow||event.origin!==location.origin)return;
        const m=event.data,reply=result=>app.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);
        if(m.error)window.rpcErrors.push(m);
        if(m.method==='ui/initialize')window.handshakes.push(()=>reply({protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}},hostContext:{theme:'dark',displayMode:'fullscreen'}}));
        else if(m.method==='ui/notifications/initialized')notify('ui/notifications/tool-result',{content:[]});
        else if(m.method==='tools/call'){
          const {name}=m.params;window.calls.push(m.params);
          if(window.failNext){window.failNext=false;reply({isError:true,content:[{type:'text',text:'打开失败 <img src=x onerror=alert(1)>'}]});return;}
          if(name==='bridge_start'){
            window.finishStart=()=>{window.data={ready:true};reply({content:[]});};
            return;
          }
          reply({content:[{type:'text',text:JSON.stringify(name==='bridge_status'?window.data:{})}]});
        }
      });</script></body></html>`);
  });
  host.listen(0, "127.0.0.1");
  await once(host, "listening");
  child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
  exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
  await once(child, "spawn");
  socket = await connectBrowser(profile);
  send = cdpClient(socket);
  const exceptions = [];
  socket.addEventListener("message", event => { const m = JSON.parse(event.data); if (m.method === "Runtime.exceptionThrown" || (m.method === "Runtime.consoleAPICalled" && m.params.type === "error")) exceptions.push(m.params); });
  await send("Runtime.enable");
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  const waitFor = async expression => {
    const deadline = Date.now() + 5000;
    while (!await evaluate(expression)) { if (Date.now() >= deadline) throw Error("页面状态未就绪"); await delay(50); }
  };
  // 仅接管面板请求的定时器，保留 Chrome 原生的跨窗口消息和键盘事件调度。
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.pathname === '/shell') {
    const timers = new Map(); let now = 0, next = 0;
    window.setTimeout = (fn, ms) => { timers.set(++next, { fn, at: now + ms }); return next; };
    window.clearTimeout = id => timers.delete(id);
    window.advanceClock = ms => {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    };
  }` });
  await send("Page.navigate", { url: `http://127.0.0.1:${host.address().port}/` });
  const doc = "document.querySelector('#app').contentDocument";
  const el = selector => `${doc}.querySelector(${JSON.stringify(selector)})`;
  const click = async selector => { await evaluate(`${el(selector)}.click()`); };
  const idle = () => waitFor(`!${el('#refresh')}.disabled`);
  const advance = ms => evaluate(`document.querySelector('#app').contentWindow.advanceClock(${ms})`);
  await waitFor('window.handshakes?.length===1');
  await advance(30_000);
  assert.equal(await evaluate(`${el('#reconnect')}.hidden || ${el('#reconnect')}.disabled`), false);
  assert.equal(await evaluate(`${el('#refresh')}.disabled`), true);
  assert.match(await evaluate(`${el('#status')}.textContent`), /重新连接/);
  assert.deepEqual(await evaluate('window.calls'), []);
  await click('#reconnect');
  await click('#reconnect');
  await waitFor('window.handshakes.length===2');
  await evaluate('window.handshakes[0]();window.handshakes[1]()');
  await idle();
  assert.equal(await evaluate(`${el('#reconnect')}.hidden`), true);
  assert.deepEqual(await evaluate('window.rpcErrors'), []);
  assert.deepEqual(await evaluate('window.calls.map(c=>c.name)'), ['bridge_status']);
  assert.equal(await evaluate(`${el('#start')}.hidden`), true);
  assert.equal(await evaluate(`${doc}.querySelectorAll('form,select,input,textarea').length`), 0);
  assert.doesNotMatch(await evaluate(`${doc}.body.textContent`), /审批/);
  for (const [width, height] of [[1280, 800], [360, 640]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await evaluate(`window.notify('ui/notifications/host-context-changed',{theme:'${theme}'})`);
      await waitFor(`${doc}.documentElement.style.colorScheme==='${theme}'`);
      assert.ok(await evaluate(`${doc}.documentElement.scrollWidth<=${doc}.documentElement.clientWidth`));
      assert.equal(await evaluate(`${el('#open')}.disabled`), false);
    }
  }
  await click('#open');
  await idle();
  assert.equal(await evaluate("window.calls.filter(c=>c.name==='bridge_open_management').length"), 1);
  assert.match(await evaluate(`${el('#status')}.textContent`), /已向系统默认浏览器/);
  await evaluate('window.failNext=true');
  await click('#open');
  await idle();
  assert.match(await evaluate(`${el('#status')}.textContent`), /打开失败/);
  assert.equal(await evaluate(`${doc}.querySelectorAll('img').length`), 0);
  await click('#open');
  await idle();
  assert.match(await evaluate(`${el('#status')}.textContent`), /已向系统默认浏览器/);
  for (const [state, expected] of [
    [{ ready: false, startupError: "启动失败 <img src=x onerror=alert(1)>" }, "启动失败"],
    [{ ready: false, core: { state: "downloading", reason: "正在准备当前平台核心" } }, "正在准备当前平台核心"],
    [{ ready: false, models: { note: "模型查询失败" }, core: { state: "ready" } }, "模型查询失败"],
    [{ ready: false, autoRecoveryPaused: true }, "自动恢复已暂停"],
  ]) {
    await evaluate(`window.data=${JSON.stringify(state)}`);
    await click('#refresh');
    await idle();
    assert.ok((await evaluate(`${el('#status')}.textContent`)).includes(expected));
    assert.equal(await evaluate(`${doc}.querySelectorAll('img').length`), 0);
    assert.equal(await evaluate("window.calls.filter(c=>c.name==='bridge_start').length"), 0);
  }
  await evaluate('window.data={ready:false,reason:"核心暂停"}');
  await click('#refresh');
  await idle();
  assert.equal(await evaluate(`${el('#start')}.hidden`), false);
  assert.match(await evaluate(`${el('#status')}.textContent`), /核心暂停/);
  assert.equal(await evaluate("window.calls.filter(c=>c.name==='bridge_start').length"), 0);
  const beforeStart = await evaluate('window.calls.length');
  await click('#start');
  await waitFor("typeof window.finishStart==='function'");
  await advance(600_000);
  assert.match(await evaluate(`${el('#status')}.textContent`), /正在启动/);
  for (const selector of ['#open', '#refresh', '#start']) {
    assert.equal(await evaluate(`${el(selector)}.disabled`), true);
    await click(selector);
  }
  await evaluate('window.finishStart()');
  await idle();
  assert.deepEqual(await evaluate(`window.calls.slice(${beforeStart}).map(c=>c.name)`), ['bridge_start', 'bridge_status']);
  assert.match(await evaluate(`${el('#status')}.textContent`), /核心已就绪/);
  assert.equal(await evaluate(`${el('#start')}.hidden`), true);
  assert.equal(await evaluate("window.calls.filter(c=>c.name==='bridge_start').length"), 1);
  await send('Page.bringToFront');
  await evaluate(`document.querySelector('#app').focus();${el('#refresh')}.focus()`);
  const before = await evaluate('window.calls.length');
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await waitFor(`window.calls.length>${before}`);
  await idle();
  assert.equal(await evaluate('window.calls.at(-1).name'), 'bridge_status');
  assert.deepEqual(exceptions, []);
});
