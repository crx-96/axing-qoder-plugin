import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getPortSettings, resolvePortConfig, setPortSettings } from "../server/bridge-ports.mjs";
import { ensureMagpieConfig, loadConfig } from "../server/config.mjs";
import { handleMessage } from "../server/mcp-protocol.mjs";
import { selectionLifecycle, startWatchdog, stopBridge } from "../server/supervisor.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const host = "127.0.0.1";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qoder-port-test-"));
  const dataDir = join(root, "data");
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const load = (extra = {}) => loadConfig({ pluginRoot, env: { BRIDGE_DATA_DIR: dataDir, ...extra } });
  return { root, dataDir, load, config: await load(), store: join(dataDir, "bridge-ports.json") };
}

async function listener(port = 0) {
  const server = createServer(socket => socket.destroy());
  server.listen(port, host);
  await once(server, "listening");
  assert.ok(![19787, 19788].includes(server.address().port));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

async function freePair(excluded = []) {
  const servers = [];
  const ports = new Set();
  try {
    // 测试会在真正启动前释放端口，避开操作系统为出站连接分配的临时端口区间。
    const start = Math.floor(Math.random() * 10000);
    for (let offset = 0; ports.size < 2 && offset < 100; offset++) {
      const port = 20000 + (start + offset) % 10000;
      if (excluded.includes(port)) continue;
      try { servers.push(await listener(port)); }
      catch (error) { if (error.code === 'EADDRINUSE' || error.code === 'EACCES') continue; throw error; }
      ports.add(port);
    }
    assert.equal(ports.size, 2, '隔离测试需要两个可监听的端口');
    const [modelPort, managementPort] = ports;
    return { modelPort, managementPort };
  } finally { await Promise.all(servers.map(server => server.close())); }
}

test("新目录默认端口，拒绝相同、越界、非整数与占用的目标，不创建配置", async t => {
  const f = await fixture(t);
  assert.deepEqual(await getPortSettings(f.config), { modelPort: 19787, managementPort: 19788, modelLocked: false, managementLocked: false });
  const foreign = await listener();
  t.after(foreign.close);
  const ports = await freePair([foreign.port]);
  for (const value of [0, -1, 65536, 3.5, "80", null, ports.managementPort]) {
    await assert.rejects(setPortSettings(f.config, { ...ports, modelPort: value }), /整数|相同/);
  }
  for (const key of ["modelPort", "managementPort"]) {
    await assert.rejects(setPortSettings(f.config, { ...ports, [key]: foreign.port }), /已被占用/);
  }
  await assert.rejects(readFile(f.store), { code: "ENOENT" });
  assert.deepEqual(await readdir(f.dataDir), process.platform === "darwin" ? [".bridge-lifecycle.lock", "launcher-secrets.json"] : ["launcher-secrets.json"]);
});

test("旧端口冲突可换到空闲端口；冷启动保存不下载，重连及旧会话均可读", async t => {
  const f = await fixture(t);
  const foreign = await listener();
  t.after(foreign.close);
  const contacts = t.mock.fn();
  const stop = t.mock.method(selectionLifecycle, "stop", contacts);
  const launch = t.mock.method(selectionLifecycle, "launch", contacts);
  const ports = await freePair([foreign.port]);
  await writeFile(f.store, JSON.stringify({ ...ports, modelPort: foreign.port }));
  const result = await setPortSettings(f.config, ports);
  assert.deepEqual([result.changed, result.ready, result.paused], [true, false, false]);
  assert.deepEqual([stop.mock.callCount(), launch.mock.callCount()], [0, 0]);
  const fresh = await f.load();
  assert.equal(fresh.endpoint, `http://${host}:${ports.modelPort}/v1`);
  assert.equal(fresh.managementUrl, `http://${host}:${ports.managementPort}/`);
  assert.deepEqual(await getPortSettings(f.config), { ...ports, modelLocked: false, managementLocked: false });
  assert.equal((await setPortSettings(fresh, ports)).changed, false);
  assert.ok(!(await readdir(f.dataDir)).includes("runtimes"));
});

test("环境按项覆盖；更改未锁定端口不持久化覆盖值，显式覆盖优先于默认值冲突", async t => {
  const f = await fixture(t);
  const ports = await freePair();
  await setPortSettings(f.config, ports);
  const other = await freePair(Object.values(ports));
  for (const [envKey, key, locked] of [["BRIDGE_PORT", "modelPort", "modelLocked"], ["BRIDGE_MANAGEMENT_PORT", "managementPort", "managementLocked"]]) {
    const cfg = await f.load({ [envKey]: String(other[key]) });
    assert.equal((await getPortSettings(cfg))[locked], true);
    await assert.rejects(setPortSettings(cfg, ports), /锁定/);
    assert.equal((await resolvePortConfig({ ...f.config, env: { [envKey]: String(other[key]) } }))[key === "modelPort" ? "port" : key], other[key]);
  }
  const cfg = await f.load({ BRIDGE_PORT: String(other.modelPort) });
  await setPortSettings(cfg, other);
  assert.deepEqual((await f.load()).persistedPorts, { modelPort: ports.modelPort, managementPort: other.managementPort });
  assert.equal((await f.load({ BRIDGE_PORT: "19788" })).port, 19788);
});

test("手动暂停时仅保存；保留所有 Magpie 偏好并在下次启动同步环境指定的端口", async t => {
  const f = await fixture(t);
  await ensureMagpieConfig(f.config);
  const settings = { ...JSON.parse(await readFile(f.config.configPath)), noAccountDiscovery: false,
    custom: { future: [1, "test", { port: "preserved" }] }, imageGen: "user-model" };
  await writeFile(f.config.configPath, JSON.stringify({ ...settings, largeId: JSON.rawJSON("9223372036854775807") }));
  settings.largeId = Number("9223372036854775807");
  await writeFile(f.config.pausedPath, "paused");
  const ports = await freePair();
  const launch = t.mock.method(selectionLifecycle, "launch");
  const result = await setPortSettings(f.config, ports);
  assert.deepEqual([result.paused, result.ready, launch.mock.callCount()], [true, false, 0]);
  assert.equal(await readFile(f.config.pausedPath, "utf8"), "paused");
  assert.deepEqual(JSON.parse(await readFile(f.config.configPath)), { ...settings, port: ports.modelPort });
  const overrides = await freePair(Object.values(ports));
  await ensureMagpieConfig(await f.load({ BRIDGE_PORT: String(overrides.modelPort) }));
  assert.deepEqual(JSON.parse(await readFile(f.config.configPath)), { ...settings, port: overrides.modelPort });
  assert.match(await readFile(f.config.configPath, "utf8"), /"largeId": 9223372036854775807/);
});

test("只读设置和端口记录在停服前报错；取消候选启动恢复上次提交的设置", async t => {
  const f = await fixture(t);
  const initial = await freePair();
  const target = await freePair(Object.values(initial));
  await setPortSettings(f.config, initial);
  await mkdir(join(f.root, "bin"));
  const customBin = join(f.root, "bin", "test-core");
  await writeFile(customBin, "test fixture", { mode: 0o700 });
  const cfg = await f.load({ BRIDGE_BIN: customBin });
  await ensureMagpieConfig(cfg);
  const before = await readFile(f.store, "utf8");
  const stop = t.mock.method(selectionLifecycle, "stop");
  for (const file of [f.store, cfg.configPath]) {
    await chmod(file, 0o400);
    try { await assert.rejects(setPortSettings(cfg, target), /只读|权限/); }
    finally { await chmod(file, 0o600); }
    assert.equal(await readFile(f.store, "utf8"), before);
    assert.equal(JSON.parse(await readFile(cfg.configPath)).port, initial.modelPort);
  }
  const controller = new AbortController();
  t.mock.method(selectionLifecycle, "launch", async (_config, signal) => {
    assert.equal(JSON.parse(await readFile(cfg.configPath)).port, target.modelPort);
    controller.abort();
    signal.throwIfAborted();
  });
  await assert.rejects(setPortSettings(cfg, target, { signal: controller.signal }), /取消/);
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(await readFile(f.store, "utf8"), before);
  assert.equal(JSON.parse(await readFile(cfg.configPath)).port, initial.modelPort);
});

test("拒绝外部配置路径、目录联接和文件硬链接，保留链接目标", async t => {
  const f = await fixture(t);
  const ports = await freePair();
  await assert.rejects(resolvePortConfig({ dataDir: join(pluginRoot, "forbidden-port-test") }), /安装目录/);
  const external = join(f.root, "external");
  await mkdir(external);
  const file = join(external, "settings.json");
  await writeFile(file, "private external content");
  await assert.rejects(setPortSettings({ ...f.config, configPath: file }, ports), /私有数据目录/);
  await symlink(external, f.config.profileDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(setPortSettings(f.config, ports), /目录/);
  await unlink(f.config.profileDir);
  await mkdir(f.config.profileDir);
  await link(file, f.config.configPath);
  await assert.rejects(setPortSettings(f.config, ports), /链接/);
  await unlink(f.config.configPath);
  await link(file, f.store);
  await assert.rejects(setPortSettings(f.config, ports), /链接/);
  assert.equal(await readFile(file, "utf8"), "private external content");
});

test("无法确认归属或停止失败时不发布设置，不启动候选核心", async t => {
  const f = await fixture(t);
  const cfg = await f.load({ BRIDGE_BIN: process.execPath });
  const ports = await freePair();
  const owned = t.mock.method(selectionLifecycle, "hasOwnedProcess", async () => { throw Error("access denied"); });
  const launch = t.mock.method(selectionLifecycle, "launch");
  await assert.rejects(setPortSettings(cfg, ports), error => error.safeMessage && !error.safeMessage.includes("access denied"));
  owned.mock.mockImplementation(async () => true);
  t.mock.method(selectionLifecycle, "inspect", async () => ({ ready: true }));
  t.mock.method(selectionLifecycle, "verifyManagement", async () => "test key");
  t.mock.method(selectionLifecycle, "stop", async () => ({ stopped: false }));
  await assert.rejects(setPortSettings(cfg, ports), /未能确认原核心已停止/);
  assert.equal(launch.mock.callCount(), 0);
  await assert.rejects(readFile(f.store), { code: "ENOENT" });
});

test("切换持锁期间可立即读取旧配置，并发保存逐次提交", async t => {
  const f = await fixture(t);
  const first = await freePair();
  const second = await freePair(Object.values(first));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.mock.method(selectionLifecycle, "hasOwnedProcess", async () => { entered.resolve(); await release.promise; return false; });
  const applying = setPortSettings(f.config, first);
  await entered.promise;
  const queued = setPortSettings(f.config, second);
  try {
    assert.equal((await getPortSettings(f.config)).modelPort, 19787);
    assert.equal((await f.load()).port, 19787);
  } finally { release.resolve(); }
  assert.equal((await applying).modelPort, first.modelPort);
  assert.equal((await queued).modelPort, second.modelPort);
  assert.equal((await f.load()).managementPort, second.managementPort);
});

test("两个管理页面持相同旧值分别修改一个端口，第二次写入在锁内拒绝", async t => {
  const f = await fixture(t);
  const original = await freePair();
  const next = await freePair(Object.values(original));
  await setPortSettings(f.config, original);
  const firstPage = await f.load(), secondPage = await f.load();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const inspect = t.mock.method(selectionLifecycle, "hasOwnedProcess", async () => {
    entered.resolve(); await release.promise; return false;
  });
  const submit = (config, ports, expected) => handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "bridge_set_ports", arguments: { ...ports, expectedModelPort: expected.modelPort, expectedManagementPort: expected.managementPort },
  } }, { config, supportsApps: true }, { handlers: { setPorts: setPortSettings } });
  const first = { ...original, managementPort: next.managementPort };
  const applying = submit(firstPage, first, original);
  await entered.promise;
  const queued = submit(secondPage, { ...original, modelPort: next.modelPort }, original);
  release.resolve();
  assert.equal((await applying).result.isError, undefined);
  const rejected = (await queued).result;
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /端口设置已更新/);
  assert.deepEqual((await f.load()).persistedPorts, first);
  assert.equal(inspect.mock.callCount(), 1);
  assert.equal((await submit(secondPage, next, first)).result.isError, undefined);
  assert.deepEqual((await f.load()).persistedPorts, next);
  await assert.rejects(setPortSettings(firstPage, first, { expectedPorts: first }), /端口设置已更新/);
});

test("旧管理端口被浏览器禁用时仍能读取和迁出，写入禁用端口先于进程检查被拒绝", async t => {
  const f = await fixture(t);
  const ports = await freePair();
  const legacy = { ...ports, managementPort: 6000 };
  await writeFile(f.store, JSON.stringify(legacy));
  const owned = t.mock.method(selectionLifecycle, "hasOwnedProcess", async () => false);
  for (const port of [22, 4190, 6000, 6667, 10080]) {
    await assert.rejects(setPortSettings(f.config, { ...ports, managementPort: port }), /浏览器禁止访问管理端口/);
  }
  assert.equal(owned.mock.callCount(), 0);
  assert.equal((await getPortSettings(f.config)).managementPort, 6000);
  assert.equal((await setPortSettings(f.config, ports, { expectedPorts: legacy })).changed, true);
  assert.deepEqual((await f.load()).persistedPorts, ports);
});

test("共享目录的会话覆盖了模型端口，单独认证旧管理端口不足以停服", async t => {
  const f = await fixture(t);
  const original = await freePair();
  const other = await freePair(Object.values(original));
  await setPortSettings(f.config, original);
  const session = await f.load({ BRIDGE_BIN: process.execPath, BRIDGE_PORT: String(other.modelPort) });
  const owned = t.mock.method(selectionLifecycle, "hasOwnedProcess", async () => true);
  t.mock.method(selectionLifecycle, "inspect", async c => c.port === original.modelPort ? { ready: true } : null);
  t.mock.method(selectionLifecycle, "verifyManagement", async c => assert.equal(c.managementPort, original.managementPort));
  const stop = t.mock.method(selectionLifecycle, "stop", async () => ({ stopped: true }));
  const launch = t.mock.method(selectionLifecycle, "launch", async () => ({ ready: true }));
  await assert.rejects(setPortSettings(session, other), /无法认证原实例的两个端口/);
  assert.equal(owned.mock.callCount(), 1);
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(launch.mock.callCount(), 0);
  assert.deepEqual((await f.load()).persistedPorts, original);
});

test("端口事务遇到待恢复选版时拒绝，避免隐式停止候选实例", async t => {
  const f = await fixture(t);
  const active = f.config.core;
  const pending = { target: { ...active, version: 'v0.1.9999' }, wasRunning: true };
  const file = join(f.dataDir, `core-selection-${active.key}.json`);
  const state = JSON.stringify({ active, pending });
  await writeFile(file, state);
  const stop = t.mock.method(selectionLifecycle, "stop", async () => ({ stopped: true }));
  await assert.rejects(setPortSettings(f.config, await freePair()), /切换尚待恢复/);
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(await readFile(file, 'utf8'), state);
  await assert.rejects(readFile(f.store), { code: 'ENOENT' });
});

test("旧管理端口无法认证时，无论保留还是迁出该端口都在停服前拒绝", async t => {
  const f = await fixture(t);
  const foreign = await listener();
  t.after(foreign.close);
  const ports = await freePair([foreign.port]);
  const original = { modelPort: ports.modelPort, managementPort: foreign.port };
  await writeFile(f.store, JSON.stringify(original));
  t.mock.method(selectionLifecycle, "hasOwnedProcess", async () => true);
  const stop = t.mock.method(selectionLifecycle, "stop", async () => ({ stopped: true }));
  t.mock.method(selectionLifecycle, "inspect", async () => ({ ready: true }));
  const verify = t.mock.method(selectionLifecycle, "verifyManagement", async () => { throw Error("foreign"); });
  const bothNew = await freePair([...Object.values(ports), foreign.port]);
  for (const target of [{ ...original, modelPort: ports.managementPort }, bothNew]) {
    await assert.rejects(setPortSettings(f.config, target), /无法认证原实例的两个端口/);
  }
  assert.equal(verify.mock.callCount(), 2);
  assert.equal(stop.mock.callCount(), 0);
  assert.deepEqual((await f.load()).persistedPorts, original);
});

test("管理连接误指外部实例时，回收自己的候选并恢复原设置和服务", async t => {
  const f = await fixture(t);
  const initial = await freePair();
  const target = await freePair(Object.values(initial));
  await setPortSettings(f.config, initial);
  const cfg = await f.load({ BRIDGE_BIN: process.execPath });
  let activePort = initial.modelPort;
  const events = [];
  t.mock.method(selectionLifecycle, "hasOwnedProcess", async c => activePort === c.port);
  t.mock.method(selectionLifecycle, "inspect", async c => activePort === c.port ? { ready: true } : null);
  t.mock.method(selectionLifecycle, "stop", async c => {
    assert.equal(c.port, activePort);
    events.push(["stop", c.port]);
    activePort = null;
    return { stopped: true };
  });
  t.mock.method(selectionLifecycle, "launch", async c => {
    assert.equal(activePort, null);
    events.push(["launch", c.port]);
    activePort = c.port;
    return { ready: true };
  });
  t.mock.method(selectionLifecycle, "verifyManagement", async c => {
    if (c.port === target.modelPort) throw Error("foreign management listener");
    assert.equal(c.port, initial.modelPort);
  });
  await assert.rejects(setPortSettings(cfg, target), /端口更改失败/);
  assert.deepEqual(events, [["stop", initial.modelPort], ["launch", target.modelPort], ["stop", target.modelPort], ["launch", initial.modelPort]]);
  assert.equal(activePort, initial.modelPort);
  assert.deepEqual((await f.load()).persistedPorts, initial);
});

test("长连接 watchdog 在旧端口被占用时按新端口恢复", async t => {
  const f = await fixture(t);
  const foreign = await listener();
  t.after(foreign.close);
  const ports = await freePair([foreign.port]);
  await writeFile(f.store, JSON.stringify({ ...ports, modelPort: foreign.port }));
  const old = await f.load({ BRIDGE_BIN: process.execPath });
  await writeFile(f.store, JSON.stringify(ports));
  const inspect = t.mock.method(selectionLifecycle, "inspect", async c => {
    assert.equal(c.port, ports.modelPort);
    return { ready: true };
  });
  const tick = Promise.withResolvers();
  const stop = startWatchdog(old, error => error ? tick.reject(error) : tick.resolve());
  const timeout = setTimeout(() => tick.reject(Error("watchdog timed out")), 8000);
  try { await tick.promise; assert.equal(inspect.mock.callCount(), 1); }
  finally { clearTimeout(timeout); await stop(); }
});

test("隔离原生核心就地换端口；候选启动失败后原端口和已认证服务恢复", { skip: nativeCoreSkip, timeout: 300000 }, async t => {
  const f = await fixture(t);
  const binDir = join(f.root, "bin");
  await mkdir(binDir);
  const binPath = await copyTestCore(join(binDir, process.platform === "win32" ? "magpie.exe" : "magpie"));
  if (process.platform !== "win32") await chmod(binPath, 0o700);
  // 只给启动的托管器及其核心注入临时用户目录，OS PID 认证继续使用宿主的系统运行环境。
  const spawn = childProcess.spawn;
  const spawnMock = t.mock.method(childProcess, "spawn", (exe, args, options) => spawn(exe, args, {
    ...options, env: { ...options.env, HOME: f.root, USERPROFILE: f.root, APPDATA: f.root, LOCALAPPDATA: f.root, XDG_DATA_HOME: f.root },
  }));
  syncBuiltinESMExports();
  try {
    const initial = await freePair();
    const second = await freePair(Object.values(initial));
    const cfg = await f.load({ BRIDGE_BIN: binPath });
    let active;
    try {
      assert.equal((await setPortSettings(cfg, initial)).ready, true);
      active = await resolvePortConfig(cfg);
      const oldPid = JSON.parse(await readFile(active.pidPath)).pid;
      const sessionB = await f.load({ BRIDGE_BIN: binPath, BRIDGE_PORT: String(second.modelPort) });
      await assert.rejects(setPortSettings(sessionB, second), /无法认证原实例的两个端口/);
      assert.equal(JSON.parse(await readFile(active.pidPath)).pid, oldPid);
      assert.equal(JSON.parse(await readFile(active.configPath)).port, initial.modelPort);
      assert.deepEqual((await f.load()).persistedPorts, initial);
      assert.equal((await selectionLifecycle.inspect(active)).ready, true);
      assert.equal((await setPortSettings(cfg, second)).ready, true);
      active = await resolvePortConfig(cfg);
      assert.notEqual(JSON.parse(await readFile(active.pidPath)).pid, oldPid);
      const third = await freePair(Object.values(second));
      t.mock.method(selectionLifecycle, "launch").mock.mockImplementationOnce(async () => { throw Error("failed test launch"); });
      await assert.rejects(setPortSettings(cfg, third), error => error.safeMessage && !error.safeMessage.includes("未能确认原服务已恢复"));
      assert.equal((await f.load({ BRIDGE_BIN: binPath })).endpoint, active.endpoint);
      assert.equal(JSON.parse(await readFile(active.configPath)).port, second.modelPort);
      assert.ok((await selectionLifecycle.inspect(active)).ready);
      assert.equal((await f.load({ BRIDGE_BIN: binPath })).managementUrl, active.managementUrl);
    } finally {
      if (active) assert.ok((await stopBridge(await resolvePortConfig(cfg))).stopped);
    }
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
  }
});
