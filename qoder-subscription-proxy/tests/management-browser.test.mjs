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
import { ensureRunning, shutdownOwnedBridges } from "../bridge/bridge-process.mjs";
import { loadConfig } from "../bridge/config.mjs";
import { createManagementLogin } from "../bridge/management-login.mjs";
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

async function connectBrowser(profile, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && child.exitCode === null) {
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
  return (method, params = {}) => {
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

test("真实浏览器兑换一次性票据、挂载授权页并在刷新后保留会话", {
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
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (send) await send("Browser.close").catch(() => {});
        if (!(await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })]))) child.kill();
        await exited;
      }
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
    "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore", windowsHide: true });
  await once(child, "spawn");
  exited = once(child, "exit");
  socket = await connectBrowser(profile, child);
  send = cdpClient(socket);
  let origin;
  login = createManagementLogin(config, { async launchBrowser(url) {
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
});
