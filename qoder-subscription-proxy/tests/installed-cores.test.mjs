import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { selectionLifecycle } from '../server/supervisor.mjs';
import { getCoreRelease, registerStoredRelease, resolveCoreBinaryPath } from '../server/core-runtime.mjs';
import { deleteInstalledCore, getInstalledCore, listInstalledCores, withVersionOperation } from '../server/installed-cores.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'installed-cores-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const core = getCoreRelease();
  const config = { dataDir, core, binPath: resolveCoreBinaryPath({ dataDir, ...core }) };
  async function add(version, records = true) {
    const bytes = Buffer.from(version);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const release = registerStoredRelease({ ...core, version, sizeBytes: bytes.length, archiveSha256: hash, binarySha256: hash, url: core.url.replace(core.version, version) });
    const binary = resolveCoreBinaryPath({ dataDir, ...release });
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, bytes);
    const record = kind => join(dataDir, 'runtimes', `${kind}-${core.key}-${version}.json`);
    if (records) for (const kind of ['offer', 'stage']) await writeFile(record(kind), JSON.stringify(release));
    return { release, binary, record, version };
  }
  return { config, add };
}

test('高低版本分别复核来源、字节及活动状态，历史清单可恢复无 stage 的安装', async t => {
  const { config, add } = await fixture(t);
  const old = await add('v0.0.1');
  const newer = await add('v3.0.0');
  const legacy = await add('v0.0.2', false);
  const options = { legacyCoreReleases: () => [legacy.release] };
  await writeFile(join(config.dataDir, `core-selection-${config.core.key}.json`), JSON.stringify({ active: newer.release }));
  assert.deepEqual(await listInstalledCores(config, options), [newer, legacy, old].map(item => ({ version: item.version, sizeBytes: item.release.sizeBytes, active: item === newer })));
  assert.equal(await getInstalledCore(config, old.version), old.release);
  assert.equal(await getInstalledCore(config, legacy.version, options), legacy.release);
  await assert.rejects(getInstalledCore(config, legacy.version));
  await writeFile(old.binary, 'abcdef');
  await assert.rejects(getInstalledCore(config, old.version));
  await assert.rejects(deleteInstalledCore(config, newer.version), /不能删除/);
});

test('删除只清理闲置二进制和匹配的 stage，事务目标和旁置文件保留', async t => {
  const { config, add } = await fixture(t);
  const old = await add('v0.0.1');
  const selection = join(config.dataDir, `core-selection-${config.core.key}.json`);
  await writeFile(selection, JSON.stringify({ active: config.core, pending: { target: old.release, wasRunning: false } }));
  await assert.rejects(deleteInstalledCore(config, old.version), /不能删除/);
  await writeFile(selection, JSON.stringify({ active: null, pending: { target: config.core, previous: old.release, wasRunning: true } }));
  await assert.rejects(deleteInstalledCore(config, old.version), /不能删除/);
  await writeFile(selection, JSON.stringify({ active: old.release }));
  await assert.rejects(deleteInstalledCore(config, old.version), /不能删除/);
  await writeFile(selection, JSON.stringify({ active: config.core }));
  const userFile = join(dirname(old.binary), 'notes');
  await writeFile(userFile, 'keep');
  await deleteInstalledCore(config, old.version);
  assert.equal(await readFile(userFile, 'utf8'), 'keep');
  await stat(old.record('offer'));
  for (const path of [old.binary, old.record('stage')]) await assert.rejects(stat(path), { code: 'ENOENT' });
});

test('自定义 BRIDGE_BIN 经目录别名运行闲置版本时不可删除，其他版本和已退出实例仍可清理', async t => {
  const { config, add } = await fixture(t);
  const old = await add('v0.0.5');
  const idle = await add('v0.0.6');
  const alias = join(config.dataDir, 'custom-bin');
  await symlink(dirname(old.binary), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const pidPath = join(config.dataDir, 'bridge.pid');
  await writeFile(pidPath, JSON.stringify({ binPath: join(alias, basename(old.binary)), pid: 42 }));
  const owns = t.mock.method(selectionLifecycle, 'hasOwnedProcess', async target => {
    assert.equal(target.pidPath, pidPath);
    assert.equal(target.binPath, old.binary);
    return true;
  });
  await assert.rejects(deleteInstalledCore(config, old.version), /正在运行/);
  assert.equal(await readFile(old.binary, 'utf8'), old.version);
  await stat(old.record('stage'));
  await deleteInstalledCore(config, idle.version);
  assert.equal(owns.mock.callCount(), 1);
  owns.mock.mockImplementationOnce(async () => { throw Error('unknown identity'); });
  await assert.rejects(deleteInstalledCore(config, old.version), /unknown identity/);
  owns.mock.mockImplementationOnce(async () => false);
  await deleteInstalledCore(config, old.version);
  await assert.rejects(stat(old.binary), { code: 'ENOENT' });
});

test('删除中断后可重试清理匹配的 stage 和空目录', async t => {
  const { config, add } = await fixture(t);
  const old = await add('v0.0.1');
  await rm(old.binary);
  await deleteInstalledCore(config, old.version);
  await assert.rejects(stat(dirname(dirname(old.binary))), { code: 'ENOENT' });
  await assert.rejects(stat(old.record('stage')), { code: 'ENOENT' });
  await stat(old.record('offer'));
});

test('同版本下载排队且可取消，删除立即拒绝，其他版本独立', async t => {
  const { config, add } = await fixture(t);
  const old = await add('v0.0.1');
  const entered = Promise.withResolvers(), leave = Promise.withResolvers();
  const first = withVersionOperation(config, old.version, () => { entered.resolve(); return leave.promise; });
  await entered.promise;
  try {
    await assert.rejects(deleteInstalledCore(config, old.version), /操作中/);
    const module = new URL('../server/installed-cores.mjs', import.meta.url).href;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { deleteInstalledCore } from ${JSON.stringify(module)};
      await assert.rejects(deleteInstalledCore(JSON.parse(process.argv[1]), process.argv[2]), /操作中/);
    `, JSON.stringify(config), old.version], { timeout: 5000 });
    const controller = new AbortController();
    const cancelled = withVersionOperation(config, old.version, () => assert.fail(), controller.signal);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(await withVersionOperation(config, 'v0.0.2', () => 123), 123);
    const second = withVersionOperation(config, old.version, () => getInstalledCore(config, old.version));
    leave.resolve();
    assert.equal(await second, old.release);
  } finally { leave.resolve(); await first; }
});

test('拒绝路径穿越、自定义路径、硬链接文件和目录链接', async t => {
  const { config, add } = await fixture(t);
  const old = await add('v0.0.1');
  await assert.rejects(deleteInstalledCore(config, '../escape'));
  await assert.rejects(deleteInstalledCore({ ...config, core: null }, old.version));
  const alias = join(config.dataDir, 'alias');
  await link(old.binary, alias);
  await assert.rejects(deleteInstalledCore(config, old.version));
  await rm(alias);
  await link(old.record('stage'), alias);
  await assert.rejects(deleteInstalledCore(config, old.version));
  await rm(alias);
  const platform = dirname(old.binary);
  await rename(platform, alias);
  await symlink(alias, platform, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(deleteInstalledCore(config, old.version));
  assert.equal(await readFile(old.binary, 'utf8'), old.version);
});
