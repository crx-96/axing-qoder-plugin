import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, renderConfigYaml } from "../bridge/config.mjs";
import { requestLocal } from "../bridge/local-http.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";
import {
  probeBridge, sameProcess, processIdentity, withLifecycleLock, ensureDataDir,
  ensureRunning, getStatus, stopBridge, startWatchdog,
} from "../bridge/bridge-process.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const processModuleUrl = new URL("../bridge/bridge-process.mjs", import.meta.url).href;
const execFileAsync = promisify(execFile);
const windowsOnly = process.platform !== "win32" ? "仅在 Windows 验证进程身份与隔离 exe" : nativeCoreSkip;
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const signature = { message: "CLI Proxy API Server", endpoints: ["GET /v1/models"] };

function testConfig(directory, port = 1) {
  assert.ok(![8787, 19787].includes(port), "禁止访问旧桥或插件默认端口");
  return {
    host: "127.0.0.1", port, apiKey: "isolated-client-test-key", mgmtKey: "123456",
    dataDir: directory, configPath: join(directory, "config.yaml"), authDir: join(directory, "auths"),
    binPath: join(directory, "no-binary-should-be-started.exe"), pidPath: join(directory, "bridge.pid"),
    lockPath: join(directory, "bridge.lock"), pausedPath: join(directory, "bridge.paused"),
    imagesDir: join(directory, "generated"), endpoint: `http://127.0.0.1:${port}/v1`,
    managementUrl: `http://127.0.0.1:${port}/management.html`,
  };
}

async function directoryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "subscription-bridge-process-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function localServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  assert.ok(![8787, 19787].includes(server.address().port));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return server;
}

async function unusedPort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(![8787, 19787].includes(port));
  return port;
}

async function waitUntil(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error("测试等待可观察状态超时");
}

async function readPid(config) {
  try { return JSON.parse(await readFile(config.pidPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function terminateOwnedBridge(config, pid) {
  const identity = await processIdentity(pid);
  if (!identity) return;
  assert.equal(resolve(identity.executablePath).toLowerCase(), resolve(config.binPath).toLowerCase(), "清理前必须确认隔离 exe 路径");
  assert.ok(identity.commandLine.includes(config.configPath), "清理前必须确认隔离配置路径");
  const encoded = Buffer.from(JSON.stringify(identity)).toString("base64");
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; $e=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $p=Get-Process -Id $e.pid -ErrorAction Stop; $null=$p.Handle; $c=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$e.pid); if($p.Path -ne $e.executablePath -or $c.CommandLine -ne $e.commandLine -or $c.CreationDate.ToUniversalTime().ToString('o') -ne $e.creationDate){throw 'Refuse to terminate unrelated process'}; $p.Kill(); if(-not $p.WaitForExit(5000)){throw 'Owned test process did not exit'}`;
  await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 10000, maxBuffer: 8192,
  });
}

async function isolatedBridgePids(config) {
  const encoded = Buffer.from(config.binPath).toString("base64");
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $ids=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $path } | ForEach-Object { [int]$_.ProcessId }); ConvertTo-Json -InputObject $ids -Compress`;
  const { stdout } = await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 10000, maxBuffer: 8192,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ""));
}

async function isolatedSupervisorPids(config) {
  const encoded = Buffer.from(config.configPath).toString("base64");
  const script = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $ErrorActionPreference='Stop'; $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $ids=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*proxy-supervisor.ps1*' -and $_.CommandLine.Contains($path) } | ForEach-Object { [int]$_.ProcessId }); ConvertTo-Json -InputObject $ids -Compress`;
  const { stdout } = await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 10000, maxBuffer: 8192,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ""));
}

async function assertOwnedProcessesExited(config, previousPid) {
  await waitUntil(async () => (await probeBridge(config)).state === "offline", 15000);
  if (previousPid) assert.equal(await processIdentity(previousPid), null, "owner 的 Job 必须回收原代理进程");
  await waitUntil(async () => (await isolatedBridgePids(config)).length === 0 && (await isolatedSupervisorPids(config)).length === 0);
}

async function cleanupBridgeFixture(config, directory) {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(config.pausedPath, "Test fixture cleanup; never restart\n");
  for (const pid of await isolatedBridgePids(config)) await terminateOwnedBridge(config, pid);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function realBridgeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "subscription-bridge-real-中文 路径-"));
  const port = await unusedPort();
  const binPath = join(directory, "隔离 订阅代理.exe");
  const env = {
    ...process.env, BRIDGE_DATA_DIR: join(directory, "数据 data"), BRIDGE_BIN: binPath,
    BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(port),
    BRIDGE_API_KEY: "isolated-test-client-key", BRIDGE_MGMT_KEY: "123456",
  };
  const config = { ...testConfig(env.BRIDGE_DATA_DIR, port), binPath };
  const beforeCleanup = [];
  t.after(async () => {
    for (const stop of beforeCleanup) await stop();
    await cleanupBridgeFixture(config, directory);
  });
  await copyTestCore(binPath);
  Object.assign(config, await loadConfig({ pluginRoot, env }));
  assert.ok(config.dataDir.startsWith(directory));
  assert.ok(config.authDir.startsWith(directory));
  return { config, env, directory, beforeCleanup };
}

async function stopOwnNodeChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const identity = await processIdentity(child.pid);
    if (!identity) return;
    assert.equal(resolve(identity.executablePath).toLowerCase(), resolve(process.execPath).toLowerCase());
  }
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function mcpClient(t, env, beforeCleanup, { initialize = true } = {}) {
  const child = spawn(process.execPath, [join(pluginRoot, "scripts", "mcp-server.mjs")], {
    env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map();
  const responses = [];
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let protocolError;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => { protocolError = error; });
  child.stdin.on("error", (error) => { protocolError = error; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0", "MCP stdout 不得混入桥日志");
        responses.push(message);
        if (waiters.has(message.id)) waiters.get(message.id)(message);
      } catch (error) { protocolError = error; }
    }
  });
  async function endInput() {
    child.stdin.end();
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 20000);
    assert.equal(child.exitCode, 0, `MCP 必须正常 EOF 退出：${stderr}`);
    assert.equal(child.signalCode, null);
    if (protocolError) throw protocolError;
    assert.equal(buffer.trim(), "", "MCP stdout 不能留下不完整的协议行");
  }
  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      try { await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 20000); }
      catch { await stopOwnNodeChild(child); }
    }
  }
  t.after(close);
  beforeCleanup.push(close);
  async function request(method, params) {
    const id = nextId++;
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(protocolError || new Error(`MCP ${method} 响应超时`)); }, 20000);
      waiters.set(id, (message) => { clearTimeout(timer); waiters.delete(id); resolve(message); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const response = await pending;
    if (protocolError) throw protocolError;
    assert.equal(response.error, undefined);
    return response.result;
  }
  if (initialize) {
    const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "isolated-tests", version: "1" } });
    assert.ok(initialized.serverInfo);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  return {
    child, close, endInput, request, responses,
    async call(name) {
      const result = await request("tools/call", { name, arguments: {} });
      assert.notEqual(result.isError, true, `MCP ${name} 不应报错`);
      return JSON.parse(result.content.find((item) => item.type === "text").text);
    },
  };
}

test("probeBridge 只有完整根签名才识别为桥，不泄漏认证头", async (t) => {
  const cases = [
    [200, "ok", "foreign"], [200, "null", "foreign"],
    [200, JSON.stringify({ message: "CLI Proxy API Server" }), "foreign"],
    [200, JSON.stringify({ message: "CLI Proxy API Server", endpoints: ["POST /v1/chat/completions"] }), "foreign"],
    [503, JSON.stringify(signature), "foreign"], [200, JSON.stringify(signature), "bridge"],
  ];
  for (const [status, body, expected] of cases) {
    const server = await localServer(t, (request, response) => {
      assert.equal(request.headers.authorization, undefined);
      response.writeHead(status).end(body);
    });
    const result = await probeBridge(testConfig(tmpdir(), server.address().port));
    assert.equal(result.state, expected);
  }
  assert.equal((await probeBridge(testConfig(tmpdir(), await unusedPort()))).state, "offline");
});

test("sameProcess 核对 pid、创建时间、命令行与 exe/config 绝对路径", () => {
  const config = testConfig(join(tmpdir(), "identity-test"));
  const identity = { pid: 1234, creationDate: "2026-10-22T01:02:03.1234567Z", commandLine: `\"${config.binPath}\" -config \"${config.configPath}\"`, executablePath: config.binPath };
  const record = { ...identity, binPath: config.binPath, configPath: config.configPath };
  assert.equal(sameProcess(record, identity, config), true);
  assert.equal(sameProcess({ ...record, binPath: config.binPath.toUpperCase() }, identity, config), process.platform === "win32");
  for (const changed of [
    null, { ...identity, pid: 9999 }, { ...identity, creationDate: "2026-10-22T01:02:03.1234560Z" },
    { ...identity, commandLine: `${identity.commandLine} -other` },
    { ...identity, executablePath: join(tmpdir(), "other.exe") },
  ]) assert.equal(sameProcess(record, changed, config), false);
  for (const changed of [null, { ...record, binPath: undefined }, { ...record, configPath: join(tmpdir(), "foreign.yaml") }]) {
    assert.equal(sameProcess(changed, identity, config), false);
  }
});

test("生命周期锁排他、超时且 action 异常后释放", async (t) => {
  const config = testConfig(await directoryFixture(t));
  let active = 0;
  let maximum = 0;
  await Promise.all(Array.from({ length: 5 }, () => withLifecycleLock(config, async () => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(35);
    active--;
  })));
  assert.equal(maximum, 1);
  let release;
  let acquired;
  const entered = new Promise((resolve) => { acquired = resolve; });
  const held = withLifecycleLock(config, async () => { acquired(); await new Promise((resolve) => { release = resolve; }); });
  await entered;
  try {
    await assert.rejects(withLifecycleLock(config, () => assert.fail("锁被占用时不能执行"), 150), /会话|锁/);
  } finally { release(); await held; }
  await assert.rejects(withLifecycleLock(config, async () => { throw new Error("expected test failure"); }), /expected test failure/);
  assert.equal(await withLifecycleLock(config, () => "released"), "released");
});

test("跨进程生命周期锁在持锁进程异常退出后由系统释放", { timeout: 20000 }, async (t) => {
  const config = testConfig(await directoryFixture(t));
  const code = `import {withLifecycleLock} from ${JSON.stringify(processModuleUrl)}; await withLifecycleLock(${JSON.stringify(config)}, async()=>{process.stdout.write('LOCKED\\n'); await new Promise(()=>{setInterval(()=>{},1000)});});`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => stopOwnNodeChild(child));
  child.stderr.resume();
  const [output] = await once(child.stdout, "data");
  assert.match(output.toString(), /LOCKED/);
  await assert.rejects(withLifecycleLock(config, () => assert.fail("不能抢占另一个进程"), 150), /会话|锁/);
  await stopOwnNodeChild(child);
  assert.equal(await withLifecycleLock(config, () => "recovered", 1500), "recovered");
});

test("暂停标记使 automatic ensureRunning 和 watchdog 不恢复进程", { timeout: 10000 }, async (t) => {
  const config = testConfig(await directoryFixture(t), await unusedPort());
  await writeFile(config.pausedPath, "test paused\n");
  const result = await ensureRunning(config, { automatic: true });
  assert.equal(result.ready, false);
  assert.equal(result.started, false);
  let notify;
  const ticked = new Promise((resolve) => { notify = resolve; });
  const errors = [];
  const stopWatchdog = startWatchdog(config, (error) => { if (error) errors.push(error); notify(); });
  t.after(stopWatchdog);
  await Promise.race([ticked, delay(6000).then(() => { throw new Error("watchdog 没有执行"); })]);
  await stopWatchdog();
  assert.equal(errors.length, 0);
  assert.equal(await readPid(config), null);
  await assert.rejects(readFile(config.configPath), { code: "ENOENT" });
  assert.equal((await getStatus(config)).autoRecoveryPaused, true);
});

test("ensureRunning 不接管只有根签名但无本版本 PID 归属的服务", async (t) => {
  const requests = [];
  const server = await localServer(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined, "无有效 PID 的同签名服务不能得到认证头");
    requests.push(request.url);
    response.end(JSON.stringify(signature));
  });
  const config = testConfig(await directoryFixture(t), server.address().port);
  await assert.rejects(ensureRunning(config), /旧版|外部|接管/);
  assert.deepEqual(requests, ["/"]);
  assert.equal((await getStatus(config)).ready, false);
  assert.deepEqual(requests, ["/", "/"], "status 不得向未归属服务请求模型清单");
  const stopped = await stopBridge(config);
  assert.equal(stopped.stopped, false);
  assert.equal((await probeBridge(config)).state, "bridge");
});

test("ensureDataDir 并发发布完整配置，既有配置保持不变", async (t) => {
  const config = testConfig(await directoryFixture(t), await unusedPort());
  config.apiKey = "synthetic-test-value-".repeat(32768);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => ensureDataDir(config)));
  const errors = results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason.message);
  assert.equal(errors.length, 0, `并发读取不得观察到空/半份配置：${errors.join("; ")}`);
  assert.equal(await readFile(config.configPath, "utf8") === renderConfigYaml(config), true);
  const marker = "# user-owned marker\n";
  await writeFile(config.configPath, marker + renderConfigYaml(config));
  await ensureDataDir(config);
  assert.equal((await readFile(config.configPath, "utf8")).startsWith(marker), true);
  assert.ok(!(await readdir(config.dataDir)).some((name) => name.endsWith(".tmp")));
});

test("独立真实 exe 完成 ensureRunning -> getStatus -> stopBridge，创建时间精度不会误拒绝停止", {
  skip: windowsOnly, timeout: 60000,
}, async (t) => {
  const { config } = await realBridgeFixture(t);
  await writeFile(config.pidPath, JSON.stringify({
    pid: process.pid, creationDate: "1970-01-01T00:00:00.0000000Z",
    commandLine: "stale test pid record", binPath: config.binPath, configPath: config.configPath,
  }));
  const started = await ensureRunning(config);
  assert.equal(process.kill(process.pid, 0), true, "陈旧 PID 记录不能误杀当前测试进程");
  assert.equal(started.started, true);
  assert.equal(started.ready, true);
  const pid = await readPid(config);
  const identity = await processIdentity(pid.pid);
  assert.equal(sameProcess(pid, identity, config), true);
  const status = await getStatus(config);
  assert.equal(status.alive, true);
  assert.equal(status.ready, true);
  assert.equal(status.authCount, 0);
  assert.ok(!JSON.stringify(status).includes(config.apiKey));
  assert.equal(Object.hasOwn(status, "mgmtKey"), false);
  assert.match(status.loginHint, /123456/, "公共管理密码应在用户提示中可见");
  const { stdout } = await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid.pid}).StartTime.ToUniversalTime().ToString('o')`], { windowsHide: true, timeout: 5000 });
  t.diagnostic(`CIM creationDate=${identity.creationDate}; Get-Process StartTime=${stdout.trim()}`);
  await writeFile(config.pidPath, JSON.stringify({ ...pid, creationDate: "1970-01-01T00:00:00.0000000Z" }));
  const refused = await stopBridge(config);
  assert.equal(refused.stopped, false, "身份记录不匹配时绝不能结束进程");
  const untrusted = await getStatus(config);
  assert.equal(untrusted.alive, true, "篡改记录不能终止仍在运行的服务");
  assert.equal(untrusted.ready, false, "没有有效归属不能发送认证请求或报告就绪");
  assert.match(untrusted.models.note, /不属于|未.*发送|归属/);
  assert.equal((await probeBridge(config)).state, "bridge");
  await writeFile(config.pidPath, JSON.stringify(pid));
  const stopped = await stopBridge(config);
  assert.equal(stopped.stopped, true, stopped.reason);
  assert.equal(await processIdentity(pid.pid), null);
  assert.equal((await getStatus(config)).state, "offline");
  assert.equal((await getStatus(config)).autoRecoveryPaused, true);
  assert.equal(await readPid(config), null);
});

test("启动后 PID 登记失败会回滚自己启动的进程，不留下孤儿 exe", {
  skip: windowsOnly, timeout: 30000,
}, async (t) => {
  const { config } = await realBridgeFixture(t);
  config.pidPath = join(config.dataDir, "missing-pid-parent", "bridge.pid");
  await assert.rejects(ensureRunning(config));
  await waitUntil(async () => (await probeBridge(config)).state === "offline", 8000);
  assert.deepEqual(await isolatedBridgePids(config), [], "登记失败后必须结束刚创建的隔离进程");
  assert.equal(await readPid(config), null);
});

test("并发 ensureRunning 只启动一个实例，两个真实 MCP 子进程复用同一 PID", {
  skip: windowsOnly, timeout: 90000,
}, async (t) => {
  const { config, env, beforeCleanup } = await realBridgeFixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => ensureRunning(config)));
  assert.equal(results.filter((entry) => entry.started).length, 1);
  assert.ok(results.every((entry) => entry.ready));
  const before = await readPid(config);
  const first = await mcpClient(t, env, beforeCleanup);
  const second = await mcpClient(t, env, beforeCleanup);
  const reused = await Promise.all([first.call("bridge_start"), second.call("bridge_start")]);
  assert.ok(reused.every((entry) => !entry.started && entry.ready));
  assert.equal((await readPid(config)).pid, before.pid);
  assert.equal((await first.call("bridge_status")).ready, true);
  assert.equal((await second.call("bridge_status")).ready, true);
  first.child.stdin.end();
  second.child.stdin.end();
  await waitUntil(() => first.child.exitCode !== null && second.child.exitCode !== null, 10000);
  assert.equal((await getStatus(config)).ready, true, "MCP 会话关闭不能关闭共享桥");
  assert.equal((await readPid(config)).pid, before.pid);
});

test("单个 MCP 握手后后台自动就绪，无需工具或账号，正常 EOF 回收代理和 supervisor", { skip: windowsOnly, timeout: 60000 }, async (t) => {
  const { config, env, beforeCleanup } = await realBridgeFixture(t);
  const client = await mcpClient(t, env, beforeCleanup);
  await waitUntil(async () => (await getStatus(config)).ready, 30000);
  const status = await getStatus(config);
  assert.equal(status.ready, true, "后台必须自动启动，不能靠 bridge_start 补启动");
  assert.equal(status.authCount, 0, "没有授权账号也允许握手成功");
  assert.equal((await requestLocal(config, "/management.html", { maxBytes: 5 * 1024 * 1024 })).status, 200);
  const before = await readPid(config);
  assert.equal((await isolatedSupervisorPids(config)).length, 1);
  await client.endInput();
  await assertOwnedProcessesExited(config, before.pid);
});

test("强杀独立 MCP 后 supervisor 通过 owner 句柄关闭代理，不操作本机 Qoder", { skip: windowsOnly, timeout: 60000 }, async (t) => {
  const { config, env, beforeCleanup } = await realBridgeFixture(t);
  const client = await mcpClient(t, env, beforeCleanup);
  assert.equal((await client.call("bridge_start")).ready, true);
  const before = await readPid(config);
  await stopOwnNodeChild(client.child);
  assert.notEqual(client.child.exitCode, 0, "必须覆盖非正常 EOF 的进程终止");
  await assertOwnedProcessesExited(config, before.pid);
});

test("MCP 收到早期请求后在启动尚未发布 PID 时收到 EOF，不残留代理或 supervisor", { skip: windowsOnly, timeout: 60000 }, async (t) => {
  const { config, env, beforeCleanup } = await realBridgeFixture(t);
  const client = await mcpClient(t, env, beforeCleanup, { initialize: false });
  assert.ok((await client.request("initialize", { protocolVersion: "2024-11-05" })).serverInfo);
  await waitUntil(async () => {
    try { await readFile(config.configPath); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  });
  assert.equal(await readPid(config), null, "须在实际启动过程中、PID 发布前送 EOF");
  await client.endInput();
  assert.equal(client.responses.filter((response) => response.result?.serverInfo).length, 1,
    "MCP 握手仅发布一次成功，后台取消不改变已完成的握手");
  await assertOwnedProcessesExited(config);
  await delay(2500);
  assert.equal((await probeBridge(config)).state, "offline", "EOF 后不能由残留 watchdog 重启");
});

test("关闭非 owner MCP 不会结束 owner 的代理", { skip: windowsOnly, timeout: 90000 }, async (t) => {
  const { config, env, beforeCleanup } = await realBridgeFixture(t);
  const owner = await mcpClient(t, env, beforeCleanup);
  await owner.call("bridge_start");
  const before = await readPid(config);
  const borrower = await mcpClient(t, env, beforeCleanup);
  const reused = await borrower.call("bridge_start");
  assert.equal(reused.started, false);
  assert.equal(reused.ready, true);
  await borrower.endInput();
  assert.equal((await owner.call("bridge_status")).ready, true);
  assert.equal((await readPid(config)).pid, before.pid);
  assert.equal(sameProcess(before, await processIdentity(before.pid), config), true);
  await owner.endInput();
  await assertOwnedProcessesExited(config, before.pid);
});

test("owner MCP 退出后另一个活跃 MCP 的 watchdog 自动恢复代理", { skip: windowsOnly, timeout: 90000 }, async (t) => {
  const { config, env, beforeCleanup } = await realBridgeFixture(t);
  const owner = await mcpClient(t, env, beforeCleanup);
  await owner.call("bridge_start");
  const before = await readPid(config);
  const borrower = await mcpClient(t, env, beforeCleanup);
  assert.equal((await borrower.call("bridge_start")).started, false);
  await owner.endInput();
  assert.equal(await processIdentity(before.pid), null, "恢复前必须结束旧 owner 的代理");
  await waitUntil(async () => {
    const current = await readPid(config);
    return current && current.pid !== before.pid && (await getStatus(config)).ready;
  }, 30000);
  const recovered = await readPid(config);
  assert.equal((await borrower.call("bridge_status")).ready, true);
  assert.equal((await isolatedBridgePids(config)).length, 1);
  await borrower.endInput();
  await assertOwnedProcessesExited(config, recovered.pid);
});

test("隔离真实 exe 管理 API 接受 123456，拒绝无密码、错误密码及客户端 API key", { skip: windowsOnly, timeout: 60000 }, async (t) => {
  const { config } = await realBridgeFixture(t);
  await ensureRunning(config);
  async function managementRequest(key) {
    return new Promise((resolve, reject) => {
      const request = http.get({
        host: config.host, port: config.port, path: "/v0/management/auth-files",
        headers: key === undefined ? {} : { Authorization: `Bearer ${key}` },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("管理接口响应超时")));
    });
  }
  const accepted = await managementRequest("123456");
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body).files, []);
  for (const key of [undefined, "wrong-management-password", config.apiKey]) {
    const rejected = await managementRequest(key);
    assert.ok([401, 403].includes(rejected.status), `无效管理认证应拒绝，实际 HTTP ${rejected.status}`);
  }
  assert.equal((await managementRequest("123456")).status, 200, "拒绝错误密码后正确密码仍可用");
  await stopBridge(config);
});

test("隔离真实核心提供修复页面，Antigravity 不监听回调端口且拒绝未知会话", {
  skip: windowsOnly, timeout: 60000,
}, async (t) => {
  const { config } = await realBridgeFixture(t);
  await ensureRunning(config);
  const page = await requestLocal(config, "/management.html", { maxBytes: 5 * 1024 * 1024 });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("r.is_webui=n!==`antigravity`"));
  assert.ok(page.text.includes("当前使用手动回调模式"));
  const management = { ...config, apiKey: "123456" };
  const initialized = await requestLocal(management, "/v8/management/oauth/auth-url?provider=antigravity&is_webui=false", { authenticated: true });
  assert.equal(initialized.status, 200);
  const auth = JSON.parse(initialized.text);
  assert.equal(auth.status, "ok");
  assert.ok(auth.state);
  const url = new URL(auth.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:51121/oauth-callback");
  const waiting = await requestLocal(management, `/v8/management/oauth/status?state=${encodeURIComponent(auth.state)}`, { authenticated: true });
  assert.equal(JSON.parse(waiting.text).status, "wait");
  const unknown = await requestLocal(management, "/v8/management/oauth/callback", {
    method: "POST", authenticated: true,
    body: { provider: "antigravity", redirect_url: "http://localhost:51121/oauth-callback?code=not-real&state=unknown-test-state" },
  });
  assert.equal(unknown.status, 404);
  // 使用拒绝授权回调完成失败分支，不能把伪造 code 交给 Google 做 token 交换。
  const cancelled = await requestLocal(management, "/v8/management/oauth/callback", {
    method: "POST", authenticated: true,
    body: { provider: "antigravity", redirect_url: `http://localhost:51121/oauth-callback?error=access_denied&state=${encodeURIComponent(auth.state)}` },
  });
  assert.equal(cancelled.status, 200);
  await waitUntil(async () => {
    const status = await requestLocal(management, `/v8/management/oauth/status?state=${encodeURIComponent(auth.state)}`, { authenticated: true });
    return JSON.parse(status.text).status === "error";
  }, 5000);
  assert.equal((await getStatus(config)).authCount, 0);
  const record = await readPid(config);
  const legacyRecord = { ...record };
  delete legacyRecord.panelRevision;
  await writeFile(config.pidPath, JSON.stringify(legacyRecord));
  await assert.rejects(ensureRunning(config), /尚未加载网页授权修复/);
  const legacyStatus = await getStatus(config);
  assert.equal(legacyStatus.alive, true);
  assert.equal(legacyStatus.ready, false);
  assert.match(legacyStatus.models.note, /bridge_stop/);
  assert.ok(await processIdentity(record.pid), "旧修订不能被自动终止");
  const log = await readFile(join(config.dataDir, "bridge.log"), "utf8");
  assert.doesNotMatch(log, /callback forwarder for antigravity|failed to start antigravity callback forwarder/);
  await stopBridge(config);
});

test("只结束隔离实例后 watchdog 自动恢复，停止 watchdog 后不再重启", {
  skip: windowsOnly, timeout: 60000,
}, async (t) => {
  const { config, beforeCleanup } = await realBridgeFixture(t);
  await ensureRunning(config);
  const before = await readPid(config);
  await terminateOwnedBridge(config, before.pid);
  assert.equal((await probeBridge(config)).state, "offline");
  const errors = [];
  const stopWatchdog = startWatchdog(config, (error) => { if (error) errors.push(error.message); });
  beforeCleanup.push(stopWatchdog);
  try {
    await waitUntil(async () => {
      const pid = await readPid(config);
      if (!pid || pid.pid === before.pid) return false;
      return (await getStatus(config)).ready;
    }, 20000);
  } finally { await stopWatchdog(); }
  assert.equal(errors.length, 0, errors.join("; "));
  const recovered = await readPid(config);
  assert.notEqual(recovered.pid, before.pid);
  await terminateOwnedBridge(config, recovered.pid);
  await delay(2300);
  assert.equal((await probeBridge(config)).state, "offline");
});
