import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, link, lstat, mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, magpieArguments, magpieEnvironment } from "../server/config.mjs";
import { requestLocal } from "../server/local-http.mjs";
import { connectOwned } from "../server/owned-http.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";
import {
  probeBridge, sameProcess, processIdentity, withLifecycleLock, ensureDataDir,
  ensureRunning, getStatus, stopBridge, startWatchdog, openCoreConnection, requestOwned, selectionLifecycle,
} from "../server/supervisor.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const processModuleUrl = new URL("../server/supervisor.mjs", import.meta.url).href;
const execFileAsync = promisify(execFile);
const windowsOnly = process.platform !== "win32" ? "仅在 Windows 验证进程身份与隔离 exe" : nativeCoreSkip;
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const signature = { name: "magpie", version: "0.1.4582" };

function testConfig(directory, port = 1) {
  assert.ok(![8787, 19787].includes(port), "禁止访问旧桥或插件默认端口");
  return {
    host: "127.0.0.1", port, managementPort: port, apiKey: "isolated-client-test-key", mgmtKey: "a".repeat(64),
    dataDir: directory, configPath: join(directory, "magpie", "settings.json"), profileDir: join(directory, "magpie"),
    binPath: join(directory, "no-binary-should-be-started.exe"), pidPath: join(directory, "bridge.pid"),
    lockPath: join(directory, "bridge.lock"), pausedPath: join(directory, "bridge.paused"),
    endpoint: `http://127.0.0.1:${port}/v1`,
    managementUrl: `http://127.0.0.1:${port}/`,
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
  assert.ok(identity.commandLine.includes("serve") && identity.commandLine.includes(`--web=127.0.0.1:${config.managementPort}`), "清理前必须确认隔离管理端口与 serve 参数");
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), "subscription-bridge-real-中文 路径-")));
  const port = await unusedPort();
  const binPath = join(directory, "隔离 订阅代理.exe");
  const env = {
    ...process.env, BRIDGE_DATA_DIR: join(directory, "数据 data"), BRIDGE_BIN: binPath,
    BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(port), BRIDGE_MANAGEMENT_PORT: String(await unusedPort()),
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
  assert.ok(config.profileDir.startsWith(directory));
  return { config, env, directory, beforeCleanup };
}

async function stopOwnNodeChild(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const identity = await processIdentity(child.pid);
    if (!identity) return;
    assert.equal(resolve(identity.executablePath).toLowerCase(), resolve(process.execPath).toLowerCase());
  }
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}

async function mcpClient(t, env, beforeCleanup, { initialize = true } = {}) {
  const child = spawn(process.execPath, [join(pluginRoot, "server", "mcp-server.mjs")], {
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
      assert.notEqual(result.isError, true, `MCP ${name} 不应报错：${JSON.stringify(result)}`);
      return JSON.parse(result.content.find((item) => item.type === "text").text);
    },
  };
}

async function shutdownFixture(t) {
  const url = new URL("../server/supervisor.mjs", import.meta.url);
  const source = (await readFile(url, "utf8"))
    .replaceAll("import.meta.url", JSON.stringify(url.href))
    .replace(/from "(\.\/[^"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(
    `const process = { platform: "linux", env: {}, pid: 1 };\n${source}\nexport { supervisors as ownedForTest };\n// ${Math.random()}`
  ).toString("base64")}`);
  const config = testConfig(await directoryFixture(t));
  const identity = { pid: 123, creationDate: "instance", commandLine: "command", executablePath: config.binPath,
    controlPort: 12345, controlToken: "token", binPath: config.binPath, configPath: config.configPath, runtimeRevision: "revision" };
  await writeFile(config.pidPath, JSON.stringify(identity));
  const child = new EventEmitter();
  Object.assign(child, { pid: 456, exitCode: null, signalCode: null,
    stdin: { end() { queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0, null); }); } } });
  module.ownedForTest.set(config.dataDir, { child, config, identity });
  return { config, identity, child, module };
}

for (const mode of ["same", "different-token", "different-path", "different-revision", "failed", "signaled", "borrower", "concurrent"]) {
  test(`POSIX owned shutdown ${mode} 仅清理已确认回收的完整实例记录`, async (t) => {
    const f = await shutdownFixture(t);
    let expected = f.identity;
    if (mode.startsWith("different")) {
      const field = { "different-token": "controlToken", "different-path": "binPath", "different-revision": "runtimeRevision" }[mode];
      expected = { ...expected, [field]: "replacement" };
      await writeFile(f.config.pidPath, JSON.stringify(expected));
    }
    if (mode === "failed" || mode === "signaled") {
      f.child.stdin.end = () => queueMicrotask(() => {
        f.child.exitCode = mode === "failed" ? 1 : null;
        f.child.signalCode = mode === "signaled" ? "SIGKILL" : null;
        f.child.emit("exit", f.child.exitCode, f.child.signalCode);
      });
    }
    if (mode === "borrower") f.module.ownedForTest.clear();
    if (mode === "concurrent") {
      let pending;
      await withLifecycleLock(f.config, async () => {
        pending = f.module.shutdownOwnedBridges();
        expected = { ...expected, creationDate: "watchdog-new-instance" };
        await writeFile(f.config.pidPath, JSON.stringify(expected));
      });
      await pending;
    } else await f.module.shutdownOwnedBridges();
    if (mode === "same") assert.equal(await readPid(f.config), null);
    else assert.deepEqual(await readPid(f.config), expected);
    if (!["borrower", "signaled"].includes(mode)) assert.notEqual(f.child.exitCode, null, "必须先等待所拥有的托管器退出");
  });
}

test("Windows PID 原子发布有界重试短暂占用，永久错误保留原记录且清理临时文件", async t => {
  const directory = await directoryFixture(t);
  const path = join(directory, "bridge.pid");
  const url = new URL("../server/supervisor.mjs", import.meta.url);
  const source = (await readFile(url, "utf8"))
    .replaceAll("import.meta.url", JSON.stringify(url.href))
    .replace(/from "(\.\/[^"]+)"/g, (_, name) => `from ${JSON.stringify(new URL(name, url).href)}`)
    .replace("await rename(temporary, path)", "await renameForTest(temporary, path)");
  for (const [platform, code, failures, expectedAttempts] of [
    ["win32", "EPERM", 2, 3], ["win32", "EACCES", 2, 3], ["win32", "EBUSY", 2, 3],
    ["win32", "EPERM", 10, 6], ["win32", "ENOENT", 2, 1], ["linux", "EPERM", 2, 1],
  ]) {
    await writeFile(path, "previous-record");
    const prelude = `
      const process = { platform: ${JSON.stringify(platform)}, env: {}, pid: 1 };
      let attempts = 0;
      async function renameForTest(from, to) {
        if (++attempts <= ${failures}) throw Object.assign(new Error('sharing failure'), { code: ${JSON.stringify(code)} });
        return rename(from, to);
      }
    `;
    const module = await import(`data:text/javascript;base64,${Buffer.from(prelude + source + "\nexport { replacePrivateFile, attempts };").toString("base64")}`);
    if (expectedAttempts > failures) {
      await module.replacePrivateFile(path, "new-record");
      assert.equal(await readFile(path, "utf8"), "new-record");
    } else {
      await assert.rejects(module.replacePrivateFile(path, "new-record"), { code });
      assert.equal(await readFile(path, "utf8"), "previous-record");
    }
    assert.equal(module.attempts, expectedAttempts);
    assert.deepEqual(await readdir(directory), ["bridge.pid"]);
  }
});

test("Windows PID 被复用且 CIM 隐藏路径和命令行时，仅确证旧实例已退出才继续启动", async (t) => {
  const config = testConfig(await directoryFixture(t), await unusedPort());
  const current = "2026-11-20T03:09:45.1234560Z";
  const older = "2026-11-20T03:09:45.1234550Z";
  const record = { pid: 17428, creationDate: older, binPath: config.binPath, configPath: config.configPath };
  const url = new URL("../server/supervisor.mjs", import.meta.url);
  const source = (await readFile(url, "utf8"))
    .replaceAll("import.meta.url", JSON.stringify(url.href))
    .replace(/from "(\.\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`)
    .replace("promisify(execFile)", "cimQuery");
  const fixture = `
    const process = { platform: "win32", env: {} };
    let created;
    export function setCreated(value) { created = value; }
    async function cimQuery(_exe, args) {
      if (!args.at(-1).includes("Get-CimInstance Win32_Process -Filter 'ProcessId = 17428'")) throw Error("Unexpected process operation");
      return { stdout: JSON.stringify({pid: 17428, executablePath: null, commandLine: null, creationDate: created}) };
    }
  `;
  const bridge = await import(`data:text/javascript;base64,${Buffer.from(fixture + source).toString("base64")}`);
  bridge.setCreated(current);
  await writeFile(config.pidPath, JSON.stringify(record));
  await assert.rejects(bridge.ensureRunning(config, { allowDownload: false }), /BRIDGE_BIN 不存在/);
  assert.deepEqual(await readPid(config), record);
  await assert.rejects(bridge.processIdentity(record.pid), /无法读取进程归属/);

  const server = await localServer(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    response.end(JSON.stringify(signature));
  });
  const occupied = { ...config, port: server.address().port };
  await assert.rejects(bridge.ensureRunning(occupied), /旧版或外部 Magpie/);
  assert.equal((await bridge.stopBridge(occupied)).stopped, false);
  assert.deepEqual(await readPid(config), record);

  for (const [saved, observed] of [[current, current], [null, current], ["invalid", current], [older, null]]) {
    bridge.setCreated(observed);
    await writeFile(config.pidPath, JSON.stringify({ ...record, creationDate: saved }));
    for (const operation of [() => bridge.ensureRunning(config), () => bridge.stopBridge(config)]) {
      await assert.rejects(operation(), /无法读取进程归属/);
    }
  }
});

for (const platform of ["linux", "darwin"]) {
  for (const mode of ["dead", "live", "reused", "EPERM", "unknown", "invalid-pid"]) {
    test(`POSIX legacy ${platform} ${mode} 仅 ESRCH 允许越过旧记录`, async (t) => {
      const config = testConfig(await directoryFixture(t), await unusedPort());
      const record = { pid: mode === "invalid-pid" ? -1 : 12345, creationDate: "old-instance",
        commandLine: "CLIProxyAPI -config old.yaml", binPath: join(config.dataDir, "CLIProxyAPI"),
        configPath: join(config.dataDir, "config.yaml"), controlPort: 12346, controlToken: "old-token" };
      await writeFile(config.pidPath, JSON.stringify(record));
      const url = new URL("../server/supervisor.mjs", import.meta.url);
      const source = (await readFile(url, "utf8"))
        .replaceAll("import.meta.url", JSON.stringify(url.href))
        .replace(/from "(\.\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, url).href)}`);
      const prelude = `
        export const signals = [];
        const process = { platform: ${JSON.stringify(platform)}, env: {}, pid: 1,
          kill(pid, signal) {
            signals.push([pid, signal]);
            if (signal !== 0) throw new Error('禁止终止记录 PID');
            const mode = ${JSON.stringify(mode)};
            if (mode === 'dead') throw Object.assign(new Error(), { code: 'ESRCH' });
            if (mode === 'EPERM') throw Object.assign(new Error(), { code: 'EPERM' });
            if (mode === 'unknown') throw new Error('unknown');
            return true;
          }
        };
      `;
      const module = await import(`data:text/javascript;base64,${Buffer.from(prelude + source).toString("base64")}`);
      if (mode === "dead") {
        await assert.rejects(module.ensureRunning(config, { allowDownload: false }), /BRIDGE_BIN 不存在/,
          "旧记录必须允许进入正常启动检查，但不能启动真实核心");
        assert.equal((await module.stopBridge(config)).stopped, true);
      } else {
        for (const action of [() => module.ensureRunning(config, { allowDownload: false }), () => module.stopBridge(config)]) {
          await assert.rejects(action, error => error.code === "BRIDGE_NOT_READY" && /旧版本.*手动停止/.test(error.safeMessage));
        }
      }
      assert.deepEqual(await readPid(config), record, "不得认领或删除旧版本路径的记录");
      assert.equal(await readFile(config.pausedPath, "utf8"), "Stopped by user\n");
      assert.equal(module.signals.length, mode === "invalid-pid" ? 0 : mode === "dead" ? 3 : 2);
      assert.ok(module.signals.every(([pid, signal]) => pid === record.pid && signal === 0));
    });
  }
}

test("Darwin 生命周期锁复用遗留文件，长路径与别名共享锁，其他目录可独立取锁", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await directoryFixture(t);
  const directory = join(root, "long-data-dir-".repeat(10));
  const alias = join(root, "alias");
  await mkdir(directory);
  await symlink(directory, alias);
  const path = join(directory, ".bridge-lifecycle.lock");
  await writeFile(path, "leftover contents\n", { mode: 0o600 });
  const previous = await stat(path, { bigint: true });
  const config = testConfig(directory);
  await writeFile(config.lockPath, "legacy lock\n");

  await withLifecycleLock(config, async () => {
    await assert.rejects(withLifecycleLock(testConfig(alias), () => assert.fail("不能经别名抢占"), 0), { code: "BRIDGE_NOT_READY" });
    assert.equal(await withLifecycleLock(testConfig(join(root, "other")), () => "independent", 0), "independent");
  });
  assert.equal(await withLifecycleLock(testConfig(alias), () => "reused", 0), "reused");
  assert.equal((await stat(path, { bigint: true })).ino, previous.ino);
  assert.equal(await readFile(path, "utf8"), "leftover contents\n");
  assert.equal(await readFile(config.lockPath, "utf8"), "legacy lock\n");
});

test("Darwin 生命周期锁遇到符号链接保留目标并报告文件错误", { skip: process.platform !== "darwin" }, async (t) => {
  const config = testConfig(await directoryFixture(t));
  await writeFile(config.lockPath, "preserved");
  await symlink(config.lockPath, join(config.dataDir, ".bridge-lifecycle.lock"));
  await assert.rejects(withLifecycleLock(config, () => assert.fail("不能跟随锁路径的符号链接"), 0), { code: "ELOOP" });
  assert.equal(await readFile(config.lockPath, "utf8"), "preserved");
});

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
  const identity = { pid: 1234, creationDate: "2026-10-22T01:02:03.1234567Z", commandLine: JSON.stringify([config.binPath, ...magpieArguments(config)]), executablePath: config.binPath };
  const record = { ...identity, binPath: config.binPath, configPath: config.configPath, managementPort: config.managementPort };
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

test("POSIX 生命周期锁不受旧哈希 TCP 端口占用或模型、管理端口重合影响", { skip: process.platform === "win32" }, async (t) => {
  const config = testConfig(await realpath(await directoryFixture(t)));
  const hash = createHash("sha256").update(config.dataDir).digest("hex");
  const port = 20000 + Number.parseInt(hash.slice(0, 8), 16) % 20000;
  const server = http.createServer();
  try {
    server.listen({ host: "127.0.0.1", port, exclusive: true });
    await once(server, "listening");
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  }
  t.after(async () => { if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  assert.equal(await withLifecycleLock(config, () => "acquired", 150), "acquired");
  for (const field of ["port", "managementPort"]) {
    assert.equal(await withLifecycleLock({ ...config, [field]: port }, () => "same-port", 150), "same-port");
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
  await stopOwnNodeChild(child, "SIGKILL");

  // 多个新进程同时接手。临界区内独占创建见证目录，任何重叠都会直接以 EEXIST 失败。
  const contender = `
    import { withLifecycleLock } from ${JSON.stringify(processModuleUrl)};
    import { mkdir, rmdir } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const witness = ${JSON.stringify(join(config.dataDir, "in-action"))};
    await withLifecycleLock(${JSON.stringify(config)}, async () => {
      await mkdir(witness);
      try { await delay(100); } finally { await rmdir(witness); }
    }, 3000);
  `;
  const results = await Promise.allSettled(Array.from({ length: 4 }, () =>
    execFileAsync(process.execPath, ["--input-type=module", "--eval", contender], { windowsHide: true, timeout: 5000 })));
  for (const result of results) if (result.status === "rejected") throw result.reason;
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

for (const kind of ["hardlink", "symlink", "dangling", "outside"]) {
  test(`暂停标记 ${kind} 越界时保留目标且拒绝启停`, async t => {
    const root = await directoryFixture(t);
    const config = testConfig(join(root, "data"), await unusedPort());
    await mkdir(config.dataDir);
    const target = join(root, "outside.txt");
    if (kind !== "dangling") await writeFile(target, "preserved");
    if (kind === "outside") config.pausedPath = target;
    else if (kind === "hardlink") await link(target, config.pausedPath);
    else {
      try { await symlink(target, config.pausedPath, "file"); }
      catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") return t.skip("当前 Windows 账户无文件符号链接创建权限");
        throw error;
      }
    }
    for (const operation of [() => stopBridge(config), () => ensureRunning(config), () => getStatus(config)]) {
      await assert.rejects(operation, /暂停标记|私有普通文件/);
    }
    if (kind === "dangling") await assert.rejects(lstat(target), { code: "ENOENT" });
    else assert.equal(await readFile(target, "utf8"), "preserved");
    if (kind === "hardlink") assert.equal((await lstat(config.pausedPath)).nlink, 2);
    if (kind === "symlink" || kind === "dangling") assert.ok((await lstat(config.pausedPath)).isSymbolicLink());
  });
}

test("数据目录经目录链接指向其他目录时，停止保留对方的暂停标记", async t => {
  const root = await directoryFixture(t);
  const source = join(root, "source");
  await mkdir(source);
  const marker = join(source, "bridge.paused");
  await writeFile(marker, "other directory");
  const config = testConfig(join(root, "alias"), await unusedPort());
  await symlink(source, config.dataDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(stopBridge(config), /目录/);
  assert.equal(await readFile(marker, "utf8"), "other directory");
});

test("停止在排队取锁前即能取消本会话启动，已离线时重复暂停均成功", { timeout: 8000 }, async (t) => {
  const config = testConfig(await directoryFixture(t), await unusedPort());
  let stopping;
  try {
    await withLifecycleLock(config, async () => {
      const starting = ensureRunning(config);
      stopping = stopBridge(config);
      const outcome = await Promise.race([
        starting.then(() => "started", error => error.name),
        delay(1500, "lock wait timed out", { ref: false }),
      ]);
      assert.equal(outcome, "AbortError", "停止不能等到生命周期锁释放才取消启动");
    });
  } finally { if (stopping) await stopping; }
  assert.equal((await stopping).stopped, true);
  assert.equal((await stopBridge(config)).stopped, true);
  assert.equal((await getStatus(config)).autoRecoveryPaused, true);
  if (process.platform !== "win32") assert.equal((await stat(config.pausedPath)).mode & 0o777, 0o600);
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
  assert.deepEqual(requests, ["/api/hello"]);
  assert.equal((await getStatus(config)).ready, false);
  assert.deepEqual(requests, ["/api/hello", "/api/hello"], "status 不得向未归属服务请求模型清单");
  const stopped = await stopBridge(config);
  assert.equal(stopped.stopped, false);
  assert.equal((await probeBridge(config)).state, "bridge");
});

test("ensureDataDir 并发发布完整 JSON 并保留既有内容与旧用户数据", async (t) => {
  const config = testConfig(await directoryFixture(t), await unusedPort());
  const legacy = join(config.dataDir, "config.yaml");
  const authDir = join(config.dataDir, "auths");
  await writeFile(legacy, "invalid old yaml: must not be read");
  await mkdir(authDir);
  await writeFile(join(authDir, "account.json"), "untouched account");
  await Promise.all(Array.from({ length: 12 }, () => ensureDataDir(config)));
  const settings = JSON.parse(await readFile(config.configPath, "utf8"));
  assert.equal(settings.port, config.port);
  settings.userMarker = "preserve";
  const original = JSON.stringify(settings);
  await writeFile(config.configPath, original);
  await ensureDataDir(config);
  assert.equal(await readFile(config.configPath, "utf8"), original);
  assert.equal(await readFile(legacy, "utf8"), "invalid old yaml: must not be read");
  assert.equal(await readFile(join(authDir, "account.json"), "utf8"), "untouched account");
  assert.ok(!(await readdir(config.profileDir)).some((name) => name.endsWith(".tmp")));
});

test("Windows 真实核心的进程身份和零字节连接归属保持一致", { skip: windowsOnly, timeout: 30000 }, async (t) => {
  const { config, beforeCleanup } = await realBridgeFixture(t);
  await ensureDataDir(config);
  const child = spawn(config.binPath, magpieArguments(config), {
    cwd: config.dataDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: magpieEnvironment(config),
  });
  let startupOutput = "";
  child.stdout.on("data", chunk => { startupOutput += chunk; });
  child.stderr.on("data", chunk => { startupOutput += chunk; });
  const exited = once(child, "exit");
  beforeCleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  await waitUntil(async () => {
    assert.equal(child.exitCode, null, startupOutput.replaceAll(config.mgmtKey, "[redacted]").replaceAll(config.apiKey, "[redacted]"));
    return (await probeBridge(config)).state === "bridge";
  }).catch(async error => {
    t.diagnostic(startupOutput.replaceAll(config.mgmtKey, "[redacted]").replaceAll(config.apiKey, "[redacted]"));
    t.diagnostic(JSON.stringify(await requestLocal({ ...config, port: config.managementPort }, "/api/hello").catch(() => ({ state: "offline" }))));
    throw error;
  });
  const first = await processIdentity(child.pid);
  const second = await processIdentity(child.pid);
  const record = { ...first, binPath: config.binPath, configPath: config.configPath, managementPort: config.managementPort };
  assert.equal(first?.pid, child.pid);
  assert.equal(sameProcess(record, second, config), true);
  const socket = await connectOwned(config, async () => second);
  try {
    const reply = await requestLocal(config, "/v1/models", { socket, authenticated: true });
    assert.equal(reply.status, 200);
  } finally { socket.destroy(); }
});

test("Windows 8.3 短路径经托管器展开后仍认证同一核心，不接管其他可执行文件", { skip: windowsOnly, timeout: 60000 }, async (t) => {
  const fixture = await realBridgeFixture(t);
  const encoded = Buffer.from(fixture.directory).toString("base64");
  const { stdout } = await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command",
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); (New-Object -ComObject Scripting.FileSystemObject).GetFolder($p).ShortPath`], { windowsHide: true, timeout: 5000 });
  const shortDirectory = stdout.trim();
  if (resolve(shortDirectory).toLowerCase() === resolve(fixture.directory).toLowerCase()) return t.skip("测试卷未提供不同的 8.3 短路径");
  const config = await loadConfig({ pluginRoot, env: { ...fixture.env,
    BRIDGE_BIN: join(shortDirectory, basename(fixture.config.binPath)),
    BRIDGE_DATA_DIR: join(shortDirectory, basename(fixture.config.dataDir)),
  } });
  fixture.beforeCleanup.push(() => stopBridge(config));
  assert.equal((await ensureRunning(config)).ready, true);
  const record = await readPid(config);
  assert.notEqual(resolve(record.executablePath).toLowerCase(), resolve(config.binPath).toLowerCase());
  assert.equal(sameProcess(record, await processIdentity(record.pid), config), true);
  assert.equal(sameProcess(record, { ...record, executablePath: process.execPath }, config), false);
  assert.equal((await getStatus(config)).ready, true);
  assert.equal((await stopBridge(config)).stopped, true);
  assert.equal(await readPid(config), null);
});

test("独立真实 exe 完成 ensureRunning -> getStatus -> stopBridge，创建时间精度不会误拒绝停止", {
  skip: windowsOnly, timeout: 180000,
}, async (t) => {
  const { config } = await realBridgeFixture(t);
  await writeFile(config.pidPath, JSON.stringify({
    pid: process.pid, creationDate: "1970-01-01T00:00:00.0000000Z",
    commandLine: "stale test pid record", binPath: config.binPath, configPath: config.configPath,
  }));
  const started = await ensureRunning(config).catch(async error => {
    t.diagnostic((await readFile(join(config.dataDir, "bridge.log"), "utf8").catch(() => "No core log"))
      .replaceAll(config.mgmtKey, "[redacted]").replaceAll(config.apiKey, "[redacted]"));
    throw error;
  });
  assert.equal(process.kill(process.pid, 0), true, "陈旧 PID 记录不能误杀当前测试进程");
  assert.equal(started.started, true);
  assert.equal(started.ready, true);
  const pid = await readPid(config);
  const identity = await processIdentity(pid.pid);
  assert.equal(sameProcess(pid, identity, config), true);
  const marker = join(config.dataDir, "retry-policy-version");
  assert.equal(await readFile(marker, "utf8").catch(() => ""), "", "不再写入重试策略版本标记");
  const reused = await ensureRunning(config);
  assert.equal(reused.started, false);
  assert.equal((await readPid(config)).pid, pid.pid);
  const status = await getStatus(config);
  assert.equal(status.alive, true);
  assert.equal(status.ready, true);
  assert.equal(Object.hasOwn(status, "authCount"), false);
  assert.ok(!JSON.stringify(status).includes(config.apiKey));
  assert.equal(Object.hasOwn(status, "mgmtKey"), false);
  assert.ok(!JSON.stringify(status).includes(config.mgmtKey));
  assert.doesNotMatch(status.loginHint, /123456/);
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
  skip: windowsOnly, timeout: 180000,
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
  for (let sample = 0; sample < 5; sample++) {
    const firstStatus = await first.call("bridge_status");
    const secondStatus = await second.call("bridge_status");
    assert.equal(firstStatus.ready, true, JSON.stringify(firstStatus));
    assert.equal(secondStatus.ready, true, JSON.stringify(secondStatus));
  }
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
  const models = await requestOwned(config, "/v1/models", { authenticated: true });
  assert.equal(models.status, 200);
  assert.ok(Array.isArray(JSON.parse(models.text).data), "归属认证后的请求仍使用模型端口并读取完整响应");
  assert.equal((await requestLocal({ ...config, port: config.managementPort }, "/", { maxBytes: 5 * 1024 * 1024 })).status, 401, "原生管理端禁止未登录访问");
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

test("隔离真实核心使用原生管理端口，旧托管修订不被接管", {
  skip: windowsOnly, timeout: 120000,
}, async (t) => {
  const { config } = await realBridgeFixture(t);
  await ensureRunning(config);
  const page = await requestLocal(config, "/api/hello");
  assert.equal(page.status, 200);
  assert.equal(JSON.parse(page.text).name, "magpie");
  const managementSocket = await openCoreConnection(config, undefined, config.managementPort);
  try {
    const response = await requestLocal({ ...config, port: config.managementPort }, "/", { socket: managementSocket });
    assert.equal(response.status, 401, "同一核心的管理端仍要求原生登录");
  } finally { managementSocket.destroy(); }
  await assert.rejects(async () => openCoreConnection(config, undefined, 1), /目标端口/);
  const record = await readPid(config);
  const copy = { ...testConfig(join(await directoryFixture(t), "copy"), await unusedPort()), binPath: config.binPath };
  await mkdir(copy.dataDir);
  await copyFile(config.pidPath, copy.pidPath);
  assert.equal(await selectionLifecycle.hasOwnedProcess(copy), false);
  assert.equal(await selectionLifecycle.inspect(copy), null);
  assert.equal((await stopBridge(copy)).stopped, true);
  assert.deepEqual(await readPid(copy), record);
  assert.equal((await getStatus(config)).ready, true);

  assert.equal(record.runtimeRevision, "magpie-win32-v3");
  for (const revision of [undefined, "magpie-win32-v2"]) {
    const legacyRecord = { ...record, runtimeRevision: revision };
    await writeFile(config.pidPath, JSON.stringify(legacyRecord));
    await assert.rejects(ensureRunning(config), /旧版 bridge_stop/);
    const legacyStatus = await getStatus(config);
    assert.equal(legacyStatus.alive, true);
    assert.equal(legacyStatus.ready, false);
    assert.match(legacyStatus.models.note, /旧版 bridge_stop/);
    await assert.rejects(openCoreConnection(config), /未发送凭据/);
    const refused = await stopBridge(config);
    assert.equal(refused.stopped, false);
    assert.match(refused.reason, /旧版 bridge_stop/);
    assert.equal((await readPid(config)).runtimeRevision, revision);
    assert.ok(sameProcess(record, await processIdentity(record.pid, record.creationDate), config));
  }
  await writeFile(config.pidPath, JSON.stringify(record));
  assert.equal((await stopBridge(config)).stopped, true);
  const log = await waitUntil(async () => {
    const value = await readFile(join(config.dataDir, "bridge.log"), "utf8");
    return value.includes("[REDACTED]") ? value : false;
  });
  assert.ok(!log.includes(config.mgmtKey), "原生启动日志不能包含长期管理密钥");
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
  } catch (error) {
    throw new Error(`${error.message}; watchdog: ${errors.join("; ")}`, { cause: error });
  } finally { await stopWatchdog(); }
  assert.equal(errors.length, 0, errors.join("; "));
  const recovered = await readPid(config);
  assert.notEqual(recovered.pid, before.pid);
  await terminateOwnedBridge(config, recovered.pid);
  await delay(2300);
  assert.equal((await probeBridge(config)).state, "offline");
});

test("Windows 托管脚本接受整数管理端口并发布核心身份", { skip: windowsOnly, timeout: 30000 }, async (t) => {
  const { config, beforeCleanup } = await realBridgeFixture(t);
  await ensureDataDir(config);
  const child = spawn(powerShell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(pluginRoot, "scripts", "proxy-supervisor.ps1"), "-OwnerPid", String(process.pid),
    "-BinPath", config.binPath, "-ConfigPath", config.configPath, "-WorkingDirectory", config.dataDir,
    "-LogPath", join(config.dataDir, "bridge.log"), "-ManagementPort", String(config.managementPort)],
  { windowsHide: true, env: magpieEnvironment(config), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  beforeCleanup.push(async () => { if (child.exitCode === null) { const done = once(child, "exit"); child.kill(); await done; } });
  await waitUntil(() => {
    assert.equal(child.exitCode, null, errors);
    return output.includes("\n");
  });
  const identity = await processIdentity(JSON.parse(output).pid);
  assert.ok(identity.commandLine.includes(`--web=127.0.0.1:${config.managementPort}`));
  assert.ok(!identity.commandLine.includes(config.configPath));
});

test("无效 Magpie JSON 设置不被改写", async (t) => {
  const config = testConfig(await directoryFixture(t), await unusedPort());
  await ensureDataDir(config);
  const settings = JSON.parse(await readFile(config.configPath, "utf8"));
  settings.lan = true;
  const invalid = JSON.stringify(settings);
  await writeFile(config.configPath, invalid);
  await assert.rejects(ensureDataDir(config), /本机|局域网/);
  assert.equal(await readFile(config.configPath, "utf8"), invalid);
});
