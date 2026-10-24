import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../bridge/config.mjs";
import { resolveCoreBinaryPath } from "../bridge/core-runtime.mjs";
import { copyTestCore, nativeCoreSkip, testCorePath } from "./helpers/native-core.mjs";
import { ensureRunning, getStatus, stopBridge, withLifecycleLock, probeBridge } from "../bridge/bridge-process.mjs";
import { queryPosixSupervisor } from "../bridge/posix-supervisor.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const native = {
  skip: ["darwin", "linux"].includes(process.platform) ? nativeCoreSkip : "仅在 macOS/Linux 运行原生桥；Windows 不启动真实桥",
  timeout: 90000,
};

async function waitUntil(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  assert.fail(`等待超时：${label}`);
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  assert.ok(![8787, 19787].includes(port), "不得使用旧桥或正式桥默认端口");
  return port;
}

async function readPid(config) {
  try { return JSON.parse(await readFile(config.pidPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function processGone(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

async function controlClosed(record) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: record.controlPort });
    function finish(error, closed) {
      socket.destroy();
      if (error) reject(error); else resolve(closed);
    }
    socket.once("connect", () => finish(null, false));
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? finish(null, true) : finish(error));
    socket.setTimeout(2000, () => finish(new Error("控制端口检查超时，不能视为已关闭")));
  });
}

async function assertReleased(config, record) {
  await waitUntil(() => processGone(record.pid), "隔离核心必须实际退出");
  await waitUntil(async () => (await probeBridge(config)).state === "offline", "隔离 HTTP 端口关闭");
  await waitUntil(() => controlClosed(record), "owner 租约释放后控制端口关闭");
  assert.equal(await queryPosixSupervisor(record, config), null);
}

function assertContained(directory, path) {
  const suffix = relative(directory, path);
  assert.ok(suffix && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`), "路径必须在本次临时目录内");
}

// 只复制本次运行需要的源码及静态资源；不复制正式数据、其他平台核心或整个仓库。
async function copyRuntime(root) {
  const modules = (await readdir(join(pluginRoot, "bridge")))
    .filter((name) => name.endsWith(".mjs")).map((name) => join("bridge", name));
  for (const path of [...modules, "scripts/mcp-server.mjs", "scripts/proxy-supervisor.mjs",
    "bridge/bin/platforms.json", "bridge/panel/management.upstream.html"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(pluginRoot, path), join(root, path));
  }
}

async function fixture(t, { cached = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "posix-bridge-中文 路径-")));
  const clients = [];
  let config;
  t.after(async () => {
    // 先暂停 watchdog，再关闭自己持有的 MCP；不枚举进程、不按 PID 发终止信号。
    if (config) await writeFile(config.pausedPath, "Isolated test cleanup\n", { mode: 0o600 });
    for (const client of clients) await client.close();
    if (config) {
      await stopBridge(config);
      await waitUntil(async () => (await probeBridge(config)).state === "offline", "清理后桥端口关闭");
    }
    await rm(directory, { recursive: true, force: true });
  });
  const root = cached ? join(directory, "plugin copy") : pluginRoot;
  if (cached) await copyRuntime(root);
  const dataDir = join(directory, "数据 data");
  const binPath = cached ? resolveCoreBinaryPath({ dataDir }) : join(directory, "隔离 核心");
  assertContained(directory, binPath);
  await mkdir(dirname(binPath), { recursive: true });
  await copyTestCore(binPath);
  await chmod(binPath, cached ? 0o644 : 0o755);
  const env = {
    ...process.env,
    HOME: join(directory, "home"), USERPROFILE: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "xdg-config"), XDG_CACHE_HOME: join(directory, "xdg-cache"),
    XDG_DATA_HOME: join(directory, "xdg-data"),
    BRIDGE_BIN: binPath, BRIDGE_DATA_DIR: dataDir,
    BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(await unusedPort()),
    BRIDGE_API_KEY: "isolated-posix-test-client-key", BRIDGE_MGMT_KEY: "123456",
  };
  if (cached) delete env.BRIDGE_BIN;
  config = await loadConfig({ pluginRoot: root, env });
  for (const path of [config.binPath, config.dataDir, config.authDir, config.configPath, config.pidPath]) {
    assertContained(directory, path);
  }
  return { config, env, root, clients };
}

async function mcpClient(fixture) {
  const child = spawn(process.execPath, [join(fixture.root, "scripts", "mcp-server.mjs")], {
    env: fixture.env, cwd: fixture.config.dataDir, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let failure;
  let stderr = "";
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  function fail(error) {
    failure ??= error;
    for (const finish of [...pending.values()]) finish(error);
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  child.once("exit", () => {
    if (pending.size) fail(new Error(`MCP 在响应前退出：${stderr}`));
  });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0", "stdout 只允许 MCP 协议，不能混入核心日志");
      pending.get(message.id)?.(null, message);
    } catch (error) { fail(error); }
  });
  async function request(method, params) {
    if (failure) throw failure;
    assert.equal(exited(), false, "已退出的 MCP 不能接收请求");
    const id = nextId++;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`MCP ${method} 响应超时：${stderr}`)), 30000);
      function finish(error, value) {
        clearTimeout(timer);
        pending.delete(id);
        if (error) reject(error); else resolve(value);
      }
      pending.set(id, finish);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    assert.equal(response.error, undefined);
    return response.result;
  }
  const client = {
    child,
    async call(name) {
      assert.ok(["bridge_start", "bridge_status", "bridge_stop"].includes(name), "原生测试禁止生成或 OAuth 工具");
      const result = await request("tools/call", { name, arguments: {} });
      assert.notEqual(result.isError, true, `MCP ${name} 应成功：${JSON.stringify(result)}`);
      return JSON.parse(result.content.find((item) => item.type === "text").text);
    },
    async endInput() {
      child.stdin.end();
      await waitUntil(exited, "MCP 正常 EOF 退出");
      assert.equal(child.exitCode, 0, stderr);
      assert.equal(child.signalCode, null);
      if (failure) throw failure;
    },
    async killOwner() {
      assert.equal(exited(), false);
      assert.equal(child.kill("SIGKILL"), true, "只强杀本测试持有的 MCP ChildProcess");
      await waitUntil(exited, "owner SIGKILL 退出");
      assert.equal(child.signalCode, "SIGKILL", "不能用正常退出代替 stdin 租约断开");
    },
    async close() {
      if (!exited()) {
        child.stdin.end();
        try { await waitUntil(exited, "清理 MCP EOF"); }
        catch { child.kill("SIGKILL"); await waitUntil(exited, "清理测试 MCP"); }
      }
      lines.close();
    },
  };
  fixture.clients.push(client);
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "posix-isolated-tests", version: "1" },
  });
  assert.ok(initialized.serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return client;
}

async function assertIdentity(config) {
  const record = await readPid(config);
  assert.ok(record);
  assert.match(record.creationDate, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(record.controlToken, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(record.controlPort) && record.controlPort > 0 && record.controlPort <= 65535);
  assert.equal(record.executablePath, config.binPath);
  assert.deepEqual(JSON.parse(record.commandLine), [config.binPath, "-config", config.configPath]);
  const identity = await queryPosixSupervisor(record, config);
  assert.ok(identity);
  for (const key of ["pid", "creationDate", "commandLine", "executablePath", "controlPort", "controlToken"]) {
    assert.equal(identity[key], record[key]);
  }
  assert.equal((await stat(config.pidPath)).mode & 0o777, 0o600);
  return record;
}

test("POSIX 隔离原生核心并发 start/status/stop，暂停自动恢复且显式 start 创建新实例", native, async (t) => {
  const { config } = await fixture(t);
  const started = await Promise.all([ensureRunning(config), ensureRunning(config)]);
  assert.equal(started.filter((result) => result.started).length, 1);
  assert.ok(started.every((result) => result.ready));
  const record = await assertIdentity(config);
  const status = await getStatus(config);
  assert.equal(status.alive, true);
  assert.equal(status.ready, true);
  assert.equal(status.authCount, 0);
  assert.equal(status.autoRecoveryPaused, false);
  assert.ok(!JSON.stringify(status).includes(record.controlToken), "状态不得暴露控制令牌");
  assert.ok(!JSON.stringify(status).includes(config.apiKey), "状态不得暴露客户端密钥");
  assert.equal((await probeBridge(config)).state, "bridge");
  assert.equal((await stopBridge(config)).stopped, true);
  await assertReleased(config, record);
  assert.equal(await readPid(config), null);
  const paused = await ensureRunning(config, { automatic: true });
  assert.equal(paused.started, false);
  assert.equal(paused.ready, false);
  assert.equal((await getStatus(config)).autoRecoveryPaused, true);
  assert.equal((await probeBridge(config)).state, "offline");
  assert.equal((await ensureRunning(config)).started, true);
  assert.notEqual((await assertIdentity(config)).creationDate, record.creationDate);
  assert.equal((await getStatus(config)).autoRecoveryPaused, false);
});

test("POSIX 无账号 MCP 握手后后台自动就绪，两个真实 MCP 复用同一实例且非 owner EOF 不关闭桥", native, async (t) => {
  const f = await fixture(t);
  const owner = await mcpClient(f);
  await waitUntil(async () => (await getStatus(f.config)).ready, "后台无需工具自动启动", 30000);
  const status = await getStatus(f.config);
  assert.equal(status.ready, true, "后台必须自动启动，不能靠 bridge_start 补启动");
  assert.equal(status.authCount, 0, "不要求先登录账号或提供模型");
  const before = await assertIdentity(f.config);
  const borrower = await mcpClient(f);
  const reused = await borrower.call("bridge_start");
  assert.equal(reused.started, false);
  assert.equal(reused.ready, true);
  assert.equal((await borrower.call("bridge_status")).ready, true);
  await borrower.endInput();
  assert.equal((await owner.call("bridge_status")).ready, true);
  assert.deepEqual(await readPid(f.config), before);
  assert.equal((await queryPosixSupervisor(before, f.config)).creationDate, before.creationDate);
  await owner.endInput();
  await assertReleased(f.config, before);
});

// shutdownOwnedBridges 的 closing 是模块全局状态，只通过 MCP 子进程的 finally 调用。
for (const mode of ["EOF", "SIGKILL"]) {
  test(`POSIX owner ${mode} 后 supervisor 回收 stdin 租约下的真实核心`, native, async (t) => {
    const f = await fixture(t);
    const owner = await mcpClient(f);
    assert.equal((await owner.call("bridge_start")).ready, true);
    const record = await assertIdentity(f.config);
    if (mode === "EOF") await owner.endInput(); else await owner.killOwner();
    await assertReleased(f.config, record);
    assert.equal((await getStatus(f.config)).autoRecoveryPaused, false, "owner 退出不是用户暂停");
    await delay(2300);
    assert.equal((await probeBridge(f.config)).state, "offline", "退出的 MCP 不得残留 watchdog");
  });
}

test("POSIX owner 被强杀后另一 MCP watchdog 恢复，bridge_stop 暂停后不再拉起", native, async (t) => {
  const f = await fixture(t);
  const owner = await mcpClient(f);
  await owner.call("bridge_start");
  const before = await assertIdentity(f.config);
  const borrower = await mcpClient(f);
  assert.equal((await borrower.call("bridge_start")).started, false);
  await owner.killOwner();
  await waitUntil(() => processGone(before.pid), "旧 owner 核心退出");
  await waitUntil(() => controlClosed(before), "旧 owner 托管器释放控制端口");
  await waitUntil(async () => {
    const current = await readPid(f.config);
    return current && current.creationDate !== before.creationDate && (await getStatus(f.config)).ready;
  }, "另一 MCP watchdog 自动恢复新实例", 45000);
  const recovered = await assertIdentity(f.config);
  assert.equal((await borrower.call("bridge_status")).ready, true);
  assert.equal((await borrower.call("bridge_stop")).stopped, true);
  await assertReleased(f.config, recovered);
  await delay(4500);
  assert.equal((await probeBridge(f.config)).state, "offline");
  assert.equal(await readPid(f.config), null);
  assert.equal((await borrower.call("bridge_status")).autoRecoveryPaused, true);
  await borrower.endInput();
  const reconnected = await mcpClient(f);
  assert.equal((await reconnected.call("bridge_status")).autoRecoveryPaused, true,
    "重连必须允许握手但保留用户暂停，不能自动恢复代理");
  assert.equal((await probeBridge(f.config)).state, "offline");
  assert.equal(await readPid(f.config), null);
  assert.equal((await reconnected.call("bridge_start")).ready, true);
  const resumed = await assertIdentity(f.config);
  assert.notEqual(resumed.creationDate, recovered.creationDate);
  await reconnected.endInput();
  await assertReleased(f.config, resumed);
});

test("POSIX 控制端点消失时仅确认 PID 不存在才恢复陈旧记录", native, async (t) => {
  const f = await fixture(t);
  const owner = await mcpClient(f);
  await owner.call("bridge_start");
  const stale = await assertIdentity(f.config);
  await owner.endInput();
  await assertReleased(f.config, stale);
  const saveRecord = (record) => withLifecycleLock(f.config,
    () => writeFile(f.config.pidPath, JSON.stringify(record), { mode: 0o600 }));
  try {
    await saveRecord({ ...stale, pid: process.pid });
    await assert.rejects(ensureRunning(f.config), { code: "BRIDGE_NOT_READY" });
    assert.equal(processGone(process.pid), false, "归属未知的存活 PID 不能被当作陈旧进程结束");
    assert.equal((await probeBridge(f.config)).state, "offline");
  } finally { await saveRecord(stale); }
  assert.equal(processGone(stale.pid), true);
  assert.equal(await queryPosixSupervisor(stale, f.config), null);
  const recovered = await ensureRunning(f.config);
  assert.equal(recovered.started, true);
  assert.equal(recovered.ready, true);
  assert.notEqual((await assertIdentity(f.config)).creationDate, stale.creationDate);
});

test("POSIX 升级核心路径时不接管存活旧实例，owner EOF 保留旧记录后可在原数据目录启动新核心", native, async (t) => {
  const f = await fixture(t);
  const owner = await mcpClient(f);
  assert.equal((await owner.call("bridge_start")).ready, true);
  const oldRecord = await assertIdentity(f.config);
  const newBin = join(dirname(f.config.binPath), "升级后 核心 B");
  assertContained(dirname(f.config.dataDir), newBin);
  await copyFile(f.config.binPath, newBin);
  await chmod(newBin, 0o755);
  const newConfig = await loadConfig({ pluginRoot: f.root, env: { ...f.env, BRIDGE_BIN: newBin } });
  assert.notEqual(newConfig.binPath, f.config.binPath);
  for (const key of ["dataDir", "authDir", "configPath", "pidPath", "pausedPath", "port", "apiKey"]) {
    assert.equal(newConfig[key], f.config[key], `升级仅改变核心路径，不改变 ${key}`);
  }
  const dataPaths = [f.config.configPath, join(f.config.dataDir, "launcher-secrets.json")];
  const originalData = await Promise.all(dataPaths.map((path) => readFile(path)));
  const originalAuths = await readdir(f.config.authDir);
  async function assertDataUnchanged() {
    assert.deepEqual(await Promise.all(dataPaths.map((path) => readFile(path))), originalData);
    assert.deepEqual(await readdir(newConfig.authDir), originalAuths);
    await assert.rejects(readFile(newConfig.pausedPath), { code: "ENOENT" });
  }
  try {
    await assertDataUnchanged();
    await assert.rejects(ensureRunning(newConfig), { code: "BRIDGE_NOT_READY" });
    assert.equal(processGone(oldRecord.pid), false, "新路径不能结束仍存活的旧核心");
    assert.equal((await owner.call("bridge_status")).ready, true);
    assert.deepEqual(await readPid(newConfig), oldRecord, "拒绝接管不能改写旧实例记录");
    await assertDataUnchanged();

    // 必须由 EOF 回收，bridge_stop 会删除旧记录，无法复现路径升级后的校验回归。
    await owner.endInput();
    await assertReleased(f.config, oldRecord);
    assert.deepEqual(await readPid(newConfig), oldRecord, "EOF 后必须留下路径 A 的陈旧记录");
    await assertDataUnchanged();
    const started = await ensureRunning(newConfig);
    assert.equal(started.started, true);
    assert.equal(started.ready, true);
    const upgraded = await assertIdentity(newConfig);
    assert.equal(upgraded.binPath, newBin);
    assert.notEqual(upgraded.creationDate, oldRecord.creationDate);
    assert.equal((await getStatus(newConfig)).ready, true);
    await assertDataUnchanged();
  } finally {
    // 在旧 fixture 删除目录前清理路径 B；只经已验证控制端点停止，不按未知 PID 发信号。
    await stopBridge(newConfig);
  }
});

test("POSIX 自定义 BRIDGE_BIN 没有执行位时拒绝启动且不修改权限", native, async (t) => {
  const { config } = await fixture(t);
  await chmod(config.binPath, 0o644);
  await assert.rejects(ensureRunning(config), (error) => {
    assert.equal(error.code, "BRIDGE_NOT_READY");
    assert.match(error.message, /BRIDGE_BIN.*执行权限/);
    return true;
  });
  assert.equal((await stat(config.binPath)).mode & 0o777, 0o644);
  assert.equal(await readPid(config), null);
  assert.equal((await probeBridge(config)).state, "offline");
});

test("POSIX 默认缓存核心丢失执行位时只恢复隔离 dataDir 内副本，不修改测试源核心", native, async (t) => {
  const sourceMode = (await stat(testCorePath)).mode;
  const f = await fixture(t, { cached: true });
  assert.equal(f.env.BRIDGE_BIN, undefined);
  assert.equal(f.config.binPath, resolveCoreBinaryPath({ dataDir: f.config.dataDir }));
  assert.notEqual(f.config.binPath, testCorePath);
  assert.equal((await stat(f.config.binPath)).mode & 0o777, 0o644);
  const client = await mcpClient(f);
  assert.equal((await getStatus(f.config)).ready, true, "默认缓存应在 initialize 前自动校验、恢复执行位并启动");
  assert.equal((await stat(f.config.binPath)).mode & 0o777, 0o755);
  assert.equal((await stat(testCorePath)).mode, sourceMode, "预先准备的测试核心不得被 chmod");
  const record = await assertIdentity(f.config);
  await client.endInput();
  await assertReleased(f.config, record);
});
