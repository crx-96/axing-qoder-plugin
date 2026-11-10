import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
    if (response.error) settle.reject(new Error("浏览器调试接口调用失败"));
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

test("真实浏览器保留管理会话、自动回调并在端口占用时提示手动回填", {
  skip: nativeCoreSkip || (!browser && "未设置 BRIDGE_TEST_BROWSER；跳过真实 Chromium 管理页"),
  timeout: 90000,
}, async (t) => {
  assert.ok(isAbsolute(browser), "请提供受信任的 Chrome 或 Edge 可执行文件绝对路径");
  const directory = await mkdtemp(join(tmpdir(), "subscription-management-browser-"));
  const profile = join(directory, "browser");
  let child, exited, socket, send, login;
  t.after(async () => {
    login?.close();
    try {
      await stopBrowser(child, exited, send);
    } finally {
      socket?.close();
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
  exited = new Promise(resolve => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  await once(child, "spawn");
  socket = await connectBrowser(profile);
  send = cdpClient(socket);
  let origin;
  login = createManagementLogin(config, { port: await unusedPort(), async launchBrowser(url) {
    origin = new URL(url).origin;
    assert.ok(new URL(url).hash.length > 1);
    const result = await send("Page.navigate", { url });
    assert.equal(result.errorText, undefined);
  } });
  await login.open();
  await expectAuthorizedPanel(send, config, origin);
  await send("Runtime.evaluate", { expression: "window.testDocumentAboutToReload = true" });
  await send("Page.reload", { ignoreCache: true });
  await expectAuthorizedPanel(send, config, origin);
  const blocker = createServer(connection => connection.destroy());
  t.after(async () => {
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
  });
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
    await send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll('button')).find(element => element.textContent.trim() === 'Antigravity').click()` });
    const deadline = Date.now() + 10000;
    let state;
    while (Date.now() < deadline) {
      const result = await send("Runtime.evaluate", { expression: `(() => {
        const dialog = document.querySelector('.modal');
        if (!dialog) return null;
        const input = dialog.querySelector('input[placeholder^="http://localhost:51121/"]');
        const open = Array.from(dialog.querySelectorAll('button')).find(element => element.textContent.trim() === '打开链接');
        return {
          ready: !!input && !input.disabled && !!open && !open.disabled,
          manual: dialog.innerText.includes('本机回调监听启动失败，已切换为手动回填'),
          optional: !!dialog.querySelector('[class*="optional"]')
        };
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
    await send("Runtime.evaluate", { expression: `Array.from(document.querySelectorAll('.modal button')).find(element => element.textContent.trim() === '提交回调 URL').click()` });
    const validation = await send("Runtime.evaluate", { expression: `document.querySelector('.modal').innerText.includes('请粘贴本次授权的完整 localhost:51121 回调地址')`, returnByValue: true });
    assert.equal(validation.result.value, true, "不匹配的 state 必须在浏览器端拒绝");
  }
});
