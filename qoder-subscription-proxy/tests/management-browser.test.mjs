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
  const running = 'v0.1.4582', latest = 'v0.1.4600', specified = 'v0.1.4520';
  const installed = (version, active = false) => ({ version, sizeBytes: 16 * 1024 * 1024, active });
  const ready = {
    ready: true, state: 'bridge', alive: true, autoRecoveryPaused: false,
    core: { state: 'ready', platform: 'win32-x64', version: running },
    endpoint: 'http://127.0.0.1:8317/v1', models: { count: 2, sample: ['provider/chat', 'model-image'] },
    dataDir: 'C:/local', configPath: 'C:/local/settings.json',
    update: { state: 'idle', version: null }, installedVersions: [installed(running, true)],
    ports: { modelPort: 8317, managementPort: 8318, modelLocked: false, managementLocked: false },
  };
  const offer = { state: 'available', version: latest };
  const resource = await managementAppResource();
  host = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/shell") { res.end(resource.text); return; }
    res.end(`<!doctype html><html><body style="margin:0"><iframe id="app" src="/shell" style="border:0;width:100vw;height:100vh;display:block"></iframe><script>
      const app=document.querySelector('#app');window.calls=[];window.nextError='';window.openedLinks=[];
      window.ready=${JSON.stringify(ready)};
      window.data=window.ready;
      window.handshakes=[];window.rpcErrors=[];
      window.notify=(method,params)=>app.contentWindow.postMessage({jsonrpc:'2.0',method,params},location.origin);
      window.addEventListener('message',event=>{
        if(event.source!==app.contentWindow||event.origin!==location.origin)return;
        const m=event.data,reply=result=>app.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);
        if(m.error)window.rpcErrors.push(m);
        if(m.method==='ui/initialize')window.handshakes.push(()=>reply({protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{},openLinks:{}},hostContext:{theme:'dark',displayMode:'fullscreen'}}));
        else if(m.method==='ui/notifications/initialized')notify('ui/notifications/tool-result',{content:[]});
        else if(m.method==='ui/open-link'){
          window.openedLinks.push(m.params.url);
          reply({isError:window.failOpenLink===true});
        }
        else if(m.method==='tools/call'){
          const {name}=m.params;window.calls.push(m.params);
          if(window.nextError){reply({isError:true,content:[{type:'text',text:window.nextError}]});window.nextError='';return;}
          if(name==='bridge_check_update')window.data.update=window.checkResult ?? ${JSON.stringify(offer)};
          if(name==='bridge_start'){
            window.finishStart=()=>{window.data=window.ready;reply({content:[]});};
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
    while (!await evaluate(expression)) { if (Date.now() >= deadline) throw Error(`未观察到页面状态 ${expression}`); await delay(50); }
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
  const updatePart = part => `#core-update [data-part="${part}"]`;
  const portPart = part => `#bridge-ports [data-part="${part}"]`;
  const shows = (selector, value) => `${el(selector)}?.checkVisibility() && ${el(selector)}.innerText.includes(${JSON.stringify(value)})`;
  await waitFor(shows(updatePart('message'), `发现新版 ${latest}`));
  await idle();
  assert.equal(await evaluate(`${el('#reconnect')}.hidden`), true);
  assert.deepEqual(await evaluate('window.rpcErrors'), []);
  const statusCall = { name: 'bridge_status', arguments: {} };
  assert.deepEqual(await evaluate('window.calls'), [statusCall, { name: 'bridge_check_update', arguments: { automatic: true } }, statusCall]);
  assert.deepEqual(await evaluate('window.openedLinks'), []);
  assert.equal(await evaluate(`${el('#start')}.hidden`), true);
  assert.equal(await evaluate(`${doc}.querySelectorAll('input').length`), 3);
  assert.doesNotMatch(await evaluate(`${doc}.body.textContent`), /审批/);
  await click('summary');
  assert.match(await evaluate(`${el('#more')}.innerText`), /provider\/chat/);
  assert.match(await evaluate(`${el('#facts')}.innerText`), /已通过 SHA256 校验/);
  assert.equal(await evaluate(`${el('.logo')}.complete && ${el('.logo')}.naturalWidth > 0`), true);
  for (const [width, height] of [[1280, 800], [680, 768], [320, 640]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await evaluate(`window.notify('ui/notifications/host-context-changed',{theme:'${theme}'})`);
      await waitFor(`${doc}.documentElement.style.colorScheme==='${theme}'`);
      assert.equal(await evaluate(`${doc}.documentElement.dataset.theme`), theme);
      assert.equal(await evaluate(`getComputedStyle(${el('.logo-light')}).display !== 'none'`), theme === "light");
      assert.equal(await evaluate(`getComputedStyle(${el('.logo-dark')}).display !== 'none'`), theme === "dark");
      assert.ok(await evaluate(`${doc}.documentElement.scrollWidth<=${doc}.documentElement.clientWidth`));
      assert.equal(await evaluate(`${el('#open')}.disabled`), false);
      assert.equal(await evaluate(`${el('#open')}.offsetTop===${el('#refresh')}.offsetTop`), true);
    }
  }
  await click('#open');
  await idle();
  assert.equal(await evaluate("window.calls.filter(c=>c.name==='bridge_open_management').length"), 1);
  assert.match(await evaluate(`${el('#notice')}.textContent`), /已向系统默认浏览器/);
  await evaluate("window.nextError='打开失败 <img src=x onerror=alert(1)>'");
  await click('#open');
  await idle();
  assert.match(await evaluate(`${el('#notice')}.textContent`), /打开失败/);
  assert.equal(await evaluate(`${doc}.querySelectorAll('img:not(.logo)').length`), 0);
  await click('#open');
  await idle();
  assert.match(await evaluate(`${el('#notice')}.textContent`), /已向系统默认浏览器/);

  const setStatus = value => evaluate(`window.data=${JSON.stringify({ ready: false, ...value })}`);
  const title = expected => waitFor(`${el('#status')}.textContent===${JSON.stringify(expected)}`);
  const progress = (phase, receivedBytes, totalBytes) => ({ preparing: true, core: { state: 'downloading', progress: { phase, receivedBytes, totalBytes } } });
  const update = async (value, expected) => { await setStatus(value); await advance(1200); await title(expected); };
  const noMorePolls = async () => {
    const before = await evaluate('window.calls.length');
    await advance(10_000);
    assert.equal(await evaluate('window.calls.length'), before);
  };
  await setStatus({ autoRecoveryPaused: true });
  await click('#refresh');
  await title('自动恢复已暂停');
  assert.equal(await evaluate(`${el('#start')}.hidden`), false);
  await noMorePolls();
  await setStatus(progress('waiting', 0, null));
  await click('#refresh');
  await title('等待核心准备');
  await update(progress('downloading', 8192, null), '正在下载核心');
  assert.match(await evaluate(`${el('#amount')}.innerText`), /8 KiB.*总大小未知/);
  assert.equal(await evaluate(`${el('#progress')}.position`), -1);
  await setStatus(progress('downloading', 16384, 65536));
  await advance(1200);
  await waitFor(`${el('#progress')}.position===0.25`);
  assert.match(await evaluate(`${el('#amount')}.innerText`), /25%.*16 KiB.*64 KiB/);
  assert.ok(await evaluate(`${doc}.documentElement.scrollWidth<=${doc}.documentElement.clientWidth`));
  await update(progress('verifying', 65536, 65536), '正在校验核心');
  assert.equal(await evaluate(`${el('#download')}.hidden`), true);
  const failed = { preparing: false, core: { state: 'error', reason: '核心下载 SHA256 不匹配，未安装' }, startupError: 'CORE_ARCHIVE_HASH' };
  await update(failed, '核心准备失败');
  assert.match(await evaluate(`${el('#detail')}.innerText`), /SHA256 不匹配.*检查下载代理/);
  assert.equal(await evaluate(`${el('#start')}.innerText`), '重试启动');
  await noMorePolls();
  assert.equal(await evaluate("window.calls.filter(c=>c.name==='bridge_start').length"), 0);
  const beforeStart = await evaluate('window.calls.length');
  await click('#start');
  await waitFor("typeof window.finishStart==='function'");
  for (const selector of ['#open', '#refresh', '#start']) {
    assert.equal(await evaluate(`${el(selector)}.disabled`), true);
    await click(selector);
  }
  await update(failed, '正在启动核心');
  await update(progress('downloading', 32768, 65536), '正在下载核心');
  assert.match(await evaluate(`${el('#amount')}.innerText`), /50%/);
  await update(progress('installing', 65536, 65536), '正在安装核心');
  await update({ preparing: true, core: { state: 'ready' } }, '正在启动核心');
  await evaluate('window.finishStart()');
  await idle();
  assert.deepEqual(await evaluate(`window.calls.slice(${beforeStart}).map(c=>c.name)`), ['bridge_start', ...Array(5).fill('bridge_status')]);
  await noMorePolls();
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
  assert.equal(await evaluate(`${doc}.activeElement===${el('#refresh')}`), true);
  // 新区块使用 Chrome 的鼠标命中测试和原生文本输入，包括 iframe 中需滚动才能到达的按钮。
  const press = async selector => {
    const point = await evaluate(`(() => {
      const node = ${el(selector)};
      if (!node?.checkVisibility() || node.disabled) return null;
      node.scrollIntoView({block:'center', inline:'nearest', behavior:'instant'});
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (!node.contains(node.ownerDocument.elementFromPoint(x, y))) return null;
      const frame = document.querySelector('#app').getBoundingClientRect();
      return {x:frame.left + x, y:frame.top + y};
    })()`);
    assert.ok(point, `控件应可点击 ${selector}`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const fill = async (selector, value) => {
    await press(selector);
    await evaluate(`${el(selector)}.select()`);
    await send('Input.insertText', { text: value });
    assert.equal(await evaluate(`${el(selector)}.value`), value);
  };
  const callCount = () => evaluate('window.calls.length');
  const loadSnapshot = async snapshot => {
    await setStatus(snapshot);
    await click('#refresh');
    await idle();
  };
  // 宿主的操作回包只表示请求结束，新状态由页面发起的下一次 bridge_status 返回。
  const submit = async (selector, name, args, nextStatus, feedback) => {
    const before = await callCount();
    await setStatus(nextStatus);
    await press(selector);
    await waitFor(feedback);
    await idle();
    assert.deepEqual(await evaluate(`window.calls.slice(${before})`), [{ name, arguments: args }, statusCall]);
  };
  const assertNarrowLayout = async (...expanded) => {
    assert.equal(await evaluate(`${doc}.defaultView.innerWidth`), 320);
    const selectors = ['html', '#runtime', '#overview', '#bridge-ports', '#core-update', '#installed-cores', ...expanded];
    const issues = await evaluate(`${JSON.stringify(selectors)}.flatMap(selector => {
      const node = ${doc}.querySelector(selector);
      if (!node?.checkVisibility()) return [selector + ' 不可见'];
      const rect = node.getBoundingClientRect();
      if (node.scrollWidth > node.clientWidth || rect.left < 0 || rect.right > ${doc}.documentElement.clientWidth)
        return [{selector, scrollWidth:node.scrollWidth, clientWidth:node.clientWidth, left:rect.left, right:rect.right}];
      return [];
    })`);
    assert.deepEqual(issues, [], '320px 下的可见区块应完整落在视口内且没有横向滚动');
  };
  const offered = { ...ready, update: offer };
  const versionButton = (version, kind) => `#installed-cores [data-focus="${version}-${kind}"]`;

  await t.test('检查更新显示 GitHub 额度耗尽，重查成功后清除提示', async () => {
    const reason = 'GitHub API 查询额度已用完。请在本地时间 2026/11/22 11:33:56 后重试。';
    await loadSnapshot(offered);
    await evaluate(`window.checkResult=${JSON.stringify({ state: 'error', version: null, reason })}`);
    await submit(updatePart('check'), 'bridge_check_update', {}, offered, shows(updatePart('reason'), reason));
    const releasesUrl = 'https://github.com/yetone/magpie/releases';
    assert.equal(await evaluate(`${el('#magpie-releases')}.href`), releasesUrl);
    assert.ok(await evaluate(shows(updatePart('releaseHelp'), '填写后点击「下载指定版本」')));
    await evaluate('window.failOpenLink=true');
    await press('#magpie-releases');
    await waitFor(shows('#magpie-releases-feedback', '可复制链接'));
    await evaluate('window.failOpenLink=false');
    await press('#magpie-releases');
    await waitFor(`${el('#magpie-releases-feedback')}.textContent===''`);
    assert.deepEqual(await evaluate('window.openedLinks'), [releasesUrl, releasesUrl]);
    assert.ok(await evaluate(shows(updatePart('reason'), reason)));
    await evaluate('delete window.checkResult');
    await submit(updatePart('check'), 'bridge_check_update', {}, offered, shows(updatePart('message'), `发现新版 ${latest}`));
    assert.equal(await evaluate(`${el(updatePart('reason'))}.hidden`), true);
  });

  await t.test('新版提示、指定版本下载及确认切换', async () => {
    await loadSnapshot(offered);
    await waitFor(shows(updatePart('message'), `发现新版 ${latest}`));
    const before = await callCount();
    await fill('#release-tag', 'invalid');
    await press(updatePart('specified'));
    await waitFor(shows(updatePart('reason'), '版本号'));
    assert.equal(await evaluate(`${doc}.activeElement===${el('#release-tag')}`), true);
    assert.equal(await callCount(), before);

    const withSpecified = { ...offered, installedVersions: [...ready.installedVersions, installed(specified)] };
    await fill('#release-tag', specified.slice(1));
    await submit(updatePart('specified'), 'bridge_download_version', { version: specified }, withSpecified,
      shows(updatePart('message'), `指定版本 ${specified} 已列入「已安装版本」`));
    assert.ok(await evaluate(shows(updatePart('running'), running)));
    assert.ok(await evaluate(`${el(versionButton(specified, 'apply'))}.checkVisibility()`));

    const staged = { ...withSpecified, update: { state: 'staged', version: latest },
      installedVersions: [...withSpecified.installedVersions, installed(latest)] };
    await submit(updatePart('download'), 'bridge_download_update', { version: latest }, staged,
      shows(updatePart('message'), `${latest} 已就绪`));
    const beforeReview = await callCount();
    await press(updatePart('switch'));
    await waitFor(shows('#core-update-confirm', '短暂重启'));
    await assertNarrowLayout('#core-update-confirm');
    await press(updatePart('cancel'));
    assert.equal(await evaluate(`${el('#core-update-confirm')}.checkVisibility()`), false);
    assert.equal(await evaluate(`${doc}.activeElement===${el(updatePart('switch'))}`), true);
    await press(updatePart('switch'));
    assert.equal(await callCount(), beforeReview);
    const switched = { ...staged, core: { ...ready.core, version: latest }, update: { state: 'current', version: latest },
      installedVersions: [installed(latest, true), installed(running), installed(specified)] };
    await submit(updatePart('confirm'), 'bridge_apply_update', { version: latest }, switched, shows(updatePart('running'), latest));
    assert.ok(await evaluate(`${el(versionButton(latest, 'apply'))}.disabled`));
  });

  await t.test('已安装版本的行内切换与删除仅在确认后提交', async () => {
    const versions = { ...offered, installedVersions: [installed(running, true), installed(specified)] };
    await loadSnapshot(versions);
    for (const kind of ['apply', 'delete']) assert.ok(await evaluate(`${el(versionButton(running, kind))}.disabled`));
    const group = '#installed-cores [role="group"]';
    const review = async (version, kind, warning) => {
      const before = await callCount();
      const trigger = versionButton(version, kind);
      await press(trigger);
      await waitFor(shows(group, warning));
      await assertNarrowLayout(group);
      await press(versionButton(version, 'cancel'));
      assert.equal(await evaluate(`${el(group)}===null`), true);
      assert.equal(await evaluate(`${doc}.activeElement===${el(trigger)}`), true);
      await press(trigger);
      assert.equal(await callCount(), before);
    };
    await review(specified, 'apply', `切换到 ${specified}？`);
    const switched = { ...versions, core: { ...ready.core, version: specified },
      installedVersions: [installed(specified, true), installed(running)] };
    await submit(versionButton(specified, 'confirm'), 'bridge_apply_update', { version: specified }, switched,
      shows('#installed-cores [role="status"]', `已切换到 ${specified}`));
    assert.ok(await evaluate(shows(updatePart('running'), specified)));
    assert.ok(await evaluate(`${el(versionButton(specified, 'delete'))}.disabled`));
    await review(running, 'delete', `只删除 ${running} 的核心缓存，账号和数据将保留`);
    await submit(versionButton(running, 'confirm'), 'bridge_delete_version', { version: running },
      { ...switched, installedVersions: [installed(specified, true)] }, shows('#installed-cores [role="status"]', `已删除 ${running}`));
    assert.equal(await evaluate(`${el('#installed-cores ul')}.innerText.includes(${JSON.stringify(running)})`), false);
    assert.ok(await evaluate(shows('#installed-cores ul', specified)));
  });

  await t.test('端口冲突、取消、占用反馈及确认保存', async () => {
    const conflict = { ...offered, ready: false, alive: false, state: 'foreign', models: {}, reason: '端口由非 Magpie 服务占用' };
    await loadSnapshot(conflict);
    await waitFor(shows('#detail', '端口已被占用'));
    assert.ok(await evaluate(`${el('#open')}.disabled`));
    await press('#bridge-ports summary');
    const model = '#bridge-model-port', management = '#bridge-management-port';
    assert.equal(await evaluate(`${el(model)}.value`), '8317');
    assert.equal(await evaluate(`${el(management)}.value`), '8318');
    const before = await callCount();
    await fill(management, '8317');
    await press(portPart('save'));
    await waitFor(shows(portPart('message'), '不能相同'));
    assert.equal(await evaluate(`${el(management)}.getAttribute('aria-invalid')`), 'true');
    assert.equal(await evaluate(`${doc}.activeElement===${el(management)}`), true);
    assert.equal(await evaluate(`${el(portPart('confirmation'))}.checkVisibility()`), false);

    await fill(management, '6000');
    await press(portPart('save'));
    await waitFor(shows(portPart('message'), '浏览器禁止访问管理端口 6000'));
    assert.equal(await evaluate(`${el(portPart('confirmation'))}.checkVisibility()`), false);
    assert.equal(await callCount(), before);

    await fill(management, '9102');
    await fill(model, '9101');
    await press(portPart('save'));
    await waitFor(shows(portPart('preview'), '模型端口设为 9101、浏览器管理端口设为 9102'));
    await assertNarrowLayout('#bridge-ports details', '#bridge-ports .port-fields', '#bridge-ports-confirmation');
    await press(portPart('cancel'));
    assert.equal(await evaluate(`${el(portPart('confirmation'))}.checkVisibility()`), false);
    await press(portPart('save'));
    assert.equal(await callCount(), before);
    await evaluate("window.nextError='回环端口 9101 已被占用或没有监听权限'");
    const expected = { expectedModelPort: 8317, expectedManagementPort: 8318 };
    await submit(portPart('confirm'), 'bridge_set_ports', { modelPort: 9101, managementPort: 9102, ...expected }, conflict,
      shows(portPart('message'), '模型端口 9101 已被占用或没有监听权限'));

    const args = { modelPort: 9103, managementPort: 9102 };
    await fill(model, '9103');
    await press(portPart('save'));
    await waitFor(shows(portPart('preview'), '模型端口设为 9103、浏览器管理端口设为 9102'));
    const saved = { ...offered, endpoint: 'http://127.0.0.1:9103/v1', ports: { ...ready.ports, ...args } };
    await submit(portPart('confirm'), 'bridge_set_ports', { ...args, ...expected }, saved,
      shows(portPart('message'), '端口设置已应用。模型端口为 9103，浏览器管理端口为 9102'));
    assert.ok(await evaluate(`${el(portPart('save'))}.disabled`));
    assert.ok(await evaluate(shows('#facts', saved.endpoint)));
    assert.equal(await evaluate(`${el('#open')}.disabled`), false);
  });
  assert.deepEqual(exceptions, []);
});
