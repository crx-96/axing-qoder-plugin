import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs, { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadConfig } from "../server/config.mjs";
import { applyCoreUpdate, getSwitchingVersion, resolveActiveConfig, selectInitialRelease } from "../server/core-selection.mjs";
import { registerStoredRelease, resolveCoreBinaryPath } from "../server/core-runtime.mjs";
import { ensureRunning, selectionLifecycle, stopBridge } from "../server/supervisor.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "qoder-selection-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { pluginRoot: dir, env: { BRIDGE_DATA_DIR: dir, BRIDGE_PORT: "1", BRIDGE_MANAGEMENT_PORT: "2" } };
  const config = await loadConfig(options);
  const path = join(dir, `core-selection-${config.core.key}.json`);
  async function stage(version) {
    const bytes = Buffer.from(version);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const release = registerStoredRelease({ ...config.core, version, sizeBytes: bytes.length, archiveSha256: digest, binarySha256: digest,
      url: `https://github.com/yetone/magpie/releases/download/${version}/${config.core.archive}` });
    const bin = resolveCoreBinaryPath({ dataDir: dir, ...release });
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, bytes);
    for (const kind of ["offer", "stage"]) await writeFile(join(dir, "runtimes", `${kind}-${release.key}-${version}.json`), JSON.stringify(release));
    return release;
  }
  const previous = await stage("v98.0.1");
  await writeFile(path, JSON.stringify({ active: previous }));
  const next = await stage("v98.0.2");
  let running = previous.version;
  const events = [];
  t.mock.method(selectionLifecycle, "inspect", async ({ core }) => {
    if (!running) return null;
    assert.equal(core.version, running);
    return { ready: true };
  });
  const verify = t.mock.method(selectionLifecycle, "verifyManagement", async () => {});
  t.mock.method(selectionLifecycle, "stop", async ({ core }) => {
    if (!running) return { stopped: true };
    assert.equal(core.version, running);
    events.push(`stop ${running}`);
    running = null;
    return { stopped: true };
  });
  const launch = t.mock.method(selectionLifecycle, "launch", async ({ core }) => {
    assert.equal(running, null);
    events.push(`launch ${core.version}`);
    running = core.version;
    return { ready: true };
  });
  return { config, options, path, previous, next, launch, verify, events, stage, setRunning: value => { running = value; } };
}

test("空缓存查询官方选版，保留联网期间其他会话已确认的选择或暂停", async t => {
  const f = await fixture(t);
  await rm(f.path);
  const fresh = await resolveActiveConfig(f.config);
  assert.equal(fresh.coreSelectionPending, true);
  const selected = await selectInitialRelease(fresh, undefined, async () => f.next);
  assert.equal(selected.core.version, f.next.version);
  assert.equal((await loadConfig(f.options)).core.version, f.next.version);

  await rm(f.path);
  const concurrent = await selectInitialRelease(fresh, undefined, async () => {
    await writeFile(f.path, JSON.stringify({ active: f.previous }));
    return f.next;
  });
  assert.equal(concurrent.core.version, f.previous.version);
  await rm(f.path);
  const paused = await selectInitialRelease(fresh, undefined, async () => {
    await writeFile(f.config.pausedPath, 'paused');
    return f.next;
  });
  assert.equal(paused.coreSelectionPending, true);
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});

test("暂存、状态刷新、未下载、摘要不符和已取消的确认均保持原服务", async t => {
  const f = await fixture(t);
  assert.equal((await resolveActiveConfig(f.config)).core.version, f.previous.version);
  assert.equal(await getSwitchingVersion(f.config), null);
  for (const [version, options] of [[f.previous.version], ["v98.0.3"], [f.next.version, { signal: AbortSignal.abort() }]]) {
    await assert.rejects(applyCoreUpdate(f.config, version, options), error => typeof error.safeMessage === "string");
  }
  await writeFile(resolveCoreBinaryPath({ dataDir: f.config.dataDir, ...f.next }), "invalid");
  await assert.rejects(applyCoreUpdate(f.config, f.next.version));
  assert.deepEqual(f.events, []);
});

test("切换持锁时无锁读取状态；并发确认只停一次，新 MCP 复用已选版本", async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  f.launch.mock.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; return { ready: true }; });
  const first = applyCoreUpdate(f.config, f.next.version);
  await entered.promise;
  try {
    assert.equal(await getSwitchingVersion(f.config), f.next.version);
    assert.equal((await resolveActiveConfig(f.config)).core.version, f.previous.version);
    assert.equal((await loadConfig(f.options)).core.version, f.previous.version);
  } finally { resume.resolve(); }
  const second = applyCoreUpdate(f.config, f.next.version);
  assert.deepEqual(await first, { ready: true, version: f.next.version });
  await assert.rejects(second, /当前核心/);
  assert.deepEqual(f.events, [`stop ${f.previous.version}`]);
  // 模拟 owner 退出，用旧配置触发 watchdog 使用的同一个自动恢复入口。
  f.setRunning(null);
  assert.equal((await ensureRunning(f.config, { automatic: true })).ready, true);
  assert.deepEqual(f.events, [`stop ${f.previous.version}`, `launch ${f.next.version}`]);
  const script = `import {loadConfig} from ${JSON.stringify(new URL("../server/config.mjs", import.meta.url).href)};console.log((await loadConfig(JSON.parse(process.argv[1]))).binPath);`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(f.options)]);
  assert.equal(result.stdout.trim(), resolveCoreBinaryPath({ dataDir: f.config.dataDir, ...f.next }));
});

test("可以选择已安装的旧核心，重启后沿用选择，之后仍可切回新版", async t => {
  const f = await fixture(t);
  const old = await f.stage("v0.0.1");
  assert.deepEqual(await applyCoreUpdate(f.config, old.version), { version: old.version, ready: true });
  assert.equal((await resolveActiveConfig(f.config)).core.version, old.version);
  assert.equal((await loadConfig(f.options)).core.version, old.version);
  assert.deepEqual(await applyCoreUpdate(f.config, f.previous.version), { version: f.previous.version, ready: true });
  assert.deepEqual(f.events, [`stop ${f.previous.version}`, `launch ${old.version}`, `stop ${old.version}`, `launch ${f.previous.version}`]);
});

test("新核心启动失败时自动重启旧核心，清除恢复标记", async t => {
  const f = await fixture(t);
  f.launch.mock.mockImplementationOnce(async () => { throw Error("private failure"); });
  await assert.rejects(applyCoreUpdate(f.config, f.next.version), error => error.safeMessage && !error.safeMessage.includes("private"));
  assert.deepEqual(f.events, [`stop ${f.previous.version}`, `launch ${f.previous.version}`]);
  assert.equal((await loadConfig(f.options)).core.version, f.previous.version);
  assert.equal(await getSwitchingVersion(f.config), null);
});

test("用户停止后可更新持久选择，旧会话 watchdog 遵守暂停；中断事务在锁内恢复", async t => {
  const f = await fixture(t);
  f.setRunning(null);
  await writeFile(f.config.pausedPath, "Stopped by user\n");
  await writeFile(f.path, JSON.stringify({ active: f.previous, pending: { target: f.next, wasRunning: true } }));
  assert.equal((await ensureRunning(f.config, { automatic: true })).ready, false);
  assert.equal(await getSwitchingVersion(f.config), null);
  assert.deepEqual(await applyCoreUpdate(f.config, f.next.version), { ready: false, version: f.next.version });
  assert.equal((await ensureRunning(f.config, { automatic: true })).ready, false);
  assert.equal(await readFile(f.config.pausedPath, "utf8"), "Stopped by user\n");
  assert.deepEqual(f.events, []);
});

test("事务中断时按候选路径回收已启动实例，并按原路径恢复服务", async t => {
  const f = await fixture(t);
  f.setRunning(f.next.version);
  await writeFile(f.config.pidPath, JSON.stringify({ binPath: resolveCoreBinaryPath({ dataDir: f.config.dataDir, ...f.next }) }));
  await writeFile(f.path, JSON.stringify({ active: f.previous, pending: { target: f.next, wasRunning: true } }));
  assert.equal((await ensureRunning(f.config, { automatic: true })).ready, true);
  assert.deepEqual(f.events, [`stop ${f.next.version}`, `launch ${f.previous.version}`]);
  assert.equal(await getSwitchingVersion(f.config), null);
});

for (const fault of ['取消', '提交写入失败']) {
  test(`首次选版在候选启动后${fault}会回收进程并还原空选择`, async t => {
    const f = await fixture(t);
    await rm(f.path);
    f.setRunning(null);
    const controller = new AbortController();
    let pending, visible, switching, failedCommit = false;
    f.verify.mock.mockImplementationOnce(async () => {
      pending = JSON.parse(await readFile(f.path, 'utf8'));
      visible = await loadConfig(f.options);
      switching = await getSwitchingVersion(f.config);
      if (fault === '取消') return controller.abort();
      const rename = fs.rename;
      const injection = t.mock.method(fs, 'rename', async (from, to) => {
        if (to === f.path) { failedCommit = true; throw Object.assign(Error('write failure'), {code: 'EIO'}); }
        return rename(from, to);
      });
      syncBuiltinESMExports();
      t.after(() => { injection.mock.restore(); syncBuiltinESMExports(); });
    });
    await assert.rejects(applyCoreUpdate(f.config, f.next.version, {signal: controller.signal}), fault === '取消' ? /取消/ : /切换失败/);
    assert.equal(visible.coreSelectionPending, true);
    assert.equal(switching, f.next.version);
    assert.equal(failedCommit, fault === '提交写入失败');
    assert.equal(pending.active, null);
    assert.equal(pending.pending.target.version, f.next.version);
    assert.deepEqual(f.events, [`launch ${f.next.version}`, `stop ${f.next.version}`]);
    await assert.rejects(readFile(f.path), {code: 'ENOENT'});
    assert.equal((await loadConfig(f.options)).coreSelectionPending, true);
  });
}

test('原管理端无法认证时保留运行服务和原选版', async t => {
  const f = await fixture(t);
  f.verify.mock.mockImplementationOnce(async () => { throw Error('foreign management'); });
  await assert.rejects(applyCoreUpdate(f.config, f.next.version));
  assert.deepEqual(f.events, []);
  assert.deepEqual(JSON.parse(await readFile(f.path)), {active: f.previous});
});

test('管理端认证失败回收候选，原核心重新通过两端验证后清除未决记录', async t => {
  const f = await fixture(t);
  f.verify.mock.mockImplementation(async ({core}) => { if (core.version === f.next.version) throw Error('foreign management'); });
  await assert.rejects(applyCoreUpdate(f.config, f.next.version), /切换失败/);
  assert.deepEqual(f.events, [`stop ${f.previous.version}`, `launch ${f.next.version}`, `stop ${f.next.version}`, `launch ${f.previous.version}`]);
  assert.deepEqual(f.verify.mock.calls.map(call => call.arguments[0].core.version), [f.previous.version, f.next.version, f.previous.version]);
  assert.equal((await loadConfig(f.options)).core.version, f.previous.version);
  assert.equal(await getSwitchingVersion(f.config), null);
});

test('活动记录已移除但旧会话仍在运行时，首次选版失败恢复原实例而不提交选版', async t => {
  const f = await fixture(t);
  const session = await loadConfig(f.options);
  await rm(f.path);
  let pending;
  f.verify.mock.mockImplementation(async ({core}) => {
    if (core.version !== f.next.version) return;
    pending = JSON.parse(await readFile(f.path));
    throw Error('foreign');
  });
  await assert.rejects(applyCoreUpdate(session, f.next.version));
  assert.equal(pending.active, null);
  assert.equal(pending.pending.previous.version, f.previous.version);
  assert.deepEqual(f.events, [`stop ${f.previous.version}`, `launch ${f.next.version}`, `stop ${f.next.version}`, `launch ${f.previous.version}`]);
  await assert.rejects(readFile(f.path), {code: 'ENOENT'});
});

test('首次事务在回收失败后保留，另一端口配置的会话按原端口回收并恢复空选择', async t => {
  const f = await fixture(t);
  await rm(f.path);
  f.setRunning(null);
  f.verify.mock.mockImplementationOnce(async ({binPath}) => {
    await writeFile(f.config.pidPath, JSON.stringify({binPath}));
    throw Error('foreign');
  });
  selectionLifecycle.stop.mock.mockImplementationOnce(async () => ({stopped: false}));
  await assert.rejects(applyCoreUpdate(f.config, f.next.version), /下次启停/);
  assert.equal(await getSwitchingVersion(f.config), f.next.version);
  const current = await loadConfig({...f.options, env: {...f.options.env, BRIDGE_PORT: '39001', BRIDGE_MANAGEMENT_PORT: '39002'}});
  assert.equal(current.coreSelectionPending, true);
  assert.equal((await ensureRunning(current, {automatic: true})).ready, false);
  const recovered = selectionLifecycle.stop.mock.calls.at(-1).arguments[0];
  assert.equal(recovered.port, f.config.port);
  assert.equal(recovered.managementPort, f.config.managementPort);
  assert.deepEqual(f.events, [`launch ${f.next.version}`, `stop ${f.next.version}`]);
  await assert.rejects(readFile(f.path), {code: 'ENOENT'});
});

test('拒绝多硬链接、目录及超长选版记录，损坏的空选择不能作为首次事务', async t => {
  const f = await fixture(t);
  const alias = join(f.config.dataDir, 'other-state');
  await link(f.path, alias);
  for (const read of [resolveActiveConfig, getSwitchingVersion]) await assert.rejects(read(f.config), /选版/);
  await assert.rejects(applyCoreUpdate(f.config, f.next.version), /选版/);
  await rm(f.path);
  await mkdir(f.path);
  await assert.rejects(getSwitchingVersion(f.config), /选版/);
  await rm(f.path, {recursive: true});
  await writeFile(f.path, JSON.stringify({active: f.previous, extra: ' '.repeat(5000)}));
  await assert.rejects(resolveActiveConfig(f.config), /选版/);
  await writeFile(f.path, JSON.stringify({active: null, pending: {target: f.next, wasRunning: true}}));
  await assert.rejects(resolveActiveConfig(f.config), /选版/);
  assert.deepEqual(f.events, []);
});

test("确认期间到达的停止与后台启动串行，保留最终暂停", async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  f.launch.mock.mockImplementationOnce(async ({ core }) => {
    entered.resolve(); await resume.promise; f.setRunning(core.version); return { ready: true };
  });
  const update = applyCoreUpdate(f.config, f.next.version);
  await entered.promise;
  const stop = stopBridge(f.config);
  resume.resolve();
  assert.equal((await update).ready, true);
  assert.equal((await stop).stopped, true);
  assert.equal((await ensureRunning(f.config, { automatic: true })).ready, false);
  assert.equal((await resolveActiveConfig(f.config)).core.version, f.next.version);
});
