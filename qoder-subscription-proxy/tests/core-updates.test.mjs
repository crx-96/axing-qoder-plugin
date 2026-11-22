import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createCoreRuntime, getCoreRelease, getCoreStatus } from '../server/core-runtime.mjs';
import { createCoreUpdates, registerStoredRelease } from '../server/core-updates.mjs';

const bytes = Buffer.from('fixture executable, never run');
const sha = createHash('sha256').update(bytes).digest('hex');
const version = 'v1.20.100';
function metadata(core, tag = version) {
  return {tag_name: tag, draft: false, prerelease: false, assets: [{name: core.archive, size: bytes.length,
    digest: `sha256:${sha}`, browser_download_url: `https://github.com/yetone/magpie/releases/download/${tag}/${core.archive}`}]};
}
async function setup(t, download) {
  const dataDir = await mkdtemp(join(tmpdir(), 'core-updates-test-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const runtime = createCoreRuntime({download: download ?? (async ({destination}) => writeFile(destination, bytes))});
  const core = runtime.getCoreRelease();
  const config = {core, dataDir, binPath: runtime.resolveCoreBinaryPath({dataDir})};
  const urls = [];
  const fixture = {runtime, config, time: 1, urls, data: metadata(core)};
  fixture.fetch = async () => fixture.data;
  fixture.updates = createCoreUpdates({runtime, now: () => fixture.time, fetchMetadata: (signal, url) => {
    urls.push(url);
    return fixture.fetch(signal, url);
  }});
  fixture.calls = () => urls.length;
  return fixture;
}

test('检查并发去重、限时缓存，无点击不下载；暂存可在新实例恢复且不碰当前版本', async t => {
  const f = await setup(t);
  const {config, updates} = f;
  assert.deepEqual(await updates.getUpdateStatus(config), {state: 'idle', version: null});
  const checks = await Promise.all([updates.checkCoreUpdate(config, {automatic: true}), updates.checkCoreUpdate(config)]);
  assert.deepEqual(checks, Array(2).fill({state: 'available', version}));
  await updates.checkCoreUpdate(config);
  assert.equal(f.calls(), 1);
  assert.deepEqual(await readdir(join(config.dataDir, 'runtimes')), [`offer-${config.core.key}-${version}.json`]);
  await assert.rejects(updates.getStagedCore(config, version));
  assert.equal((await updates.downloadCoreUpdate(config, '../invalid')).state, 'error');
  assert.deepEqual(await updates.downloadCoreUpdate(config, version), {state: 'staged', version});
  const moduleUrl = new URL('../server/core-updates.mjs', import.meta.url).href;
  const child = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {getUpdateStatus, getStagedCore} from ${JSON.stringify(moduleUrl)};
    const config = JSON.parse(process.argv[1]);
    const status = await getUpdateStatus(config);
    console.log(JSON.stringify([status, (await getStagedCore(config, status.version)).version]));
  `, JSON.stringify(config)], {encoding: 'utf8'});
  assert.deepEqual(JSON.parse(child), [{state: 'staged', version}, version]);
  const offline = createCoreUpdates({fetchMetadata: async () => {throw Error('private');}});
  assert.equal((await offline.checkCoreUpdate(config)).state, 'staged');
  const fresh = createCoreUpdates();
  assert.deepEqual(await fresh.getUpdateStatus(config), {state: 'staged', version});
  const release = registerStoredRelease(await fresh.getStagedCore(config, version));
  const binPath = f.runtime.resolveCoreBinaryPath({dataDir: config.dataDir, ...release});
  assert.equal((await getCoreStatus({...config, core: release, binPath})).state, 'ready');
  assert.equal((await getCoreStatus(config)).state, 'missing');
  assert.equal(getCoreRelease().version, config.core.version);
  assert.throws(() => registerStoredRelease({...config.core, archiveSha256: sha, binarySha256: sha}));
  assert.throws(() => registerStoredRelease({...release, url: release.url + '?secret'}));
  await writeFile(binPath, Buffer.alloc(bytes.length));
  await assert.rejects(fresh.getStagedCore(config, version));
});

test('自动检查缓存 30 分钟，手动检查仍按 1 分钟刷新两者共用的结果', async t => {
  const f = await setup(t);
  const {config, updates} = f;
  const auto = () => updates.checkCoreUpdate(config, {automatic: true});
  const fifthMinute = 5 * 60_000;
  const halfHour = 30 * 60_000;
  const initial = await auto();
  assert.deepEqual(initial, {state: 'available', version});
  f.time += fifthMinute;
  f.data = metadata(config.core, 'v1.20.101');
  assert.deepEqual(await auto(), initial);
  assert.equal(f.calls(), 1);
  const newer = await updates.checkCoreUpdate(config);
  assert.deepEqual(newer, {state: 'available', version: 'v1.20.101'});
  assert.deepEqual(await updates.checkCoreUpdate(config), newer);
  assert.equal(f.calls(), 2);
  f.time += halfHour - 1;
  assert.deepEqual(await auto(), newer);
  assert.equal(f.calls(), 2);
  f.time++;
  f.data = metadata(config.core, 'v1.20.102');
  assert.deepEqual(await auto(), {state: 'available', version: 'v1.20.102'});
  assert.equal(f.calls(), 3);
});

for (const index of [0, 1]) {
  test(`并发检查中第 ${index + 1} 个请求取消只结束自己的等待`, { timeout: 5000 }, async t => {
    const f = await setup(t);
    const controllers = [new AbortController(), new AbortController()];
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    f.fetch = async signal => { entered.resolve(signal); await resume.promise; return f.data; };
    const requests = controllers.map(({signal}) => f.updates.checkCoreUpdate(f.config, {signal}));
    const shared = await entered.promise;
    try {
      controllers[index].abort();
      assert.match((await requests[index]).reason, /取消/);
      assert.equal(shared.aborted, false);
      assert.equal((await f.updates.getUpdateStatus(f.config)).state, 'checking');
    } finally { resume.resolve(); }
    assert.deepEqual(await requests[1 - index], {state: 'available', version});
    assert.deepEqual(await f.updates.checkCoreUpdate(f.config), {state: 'available', version});
    assert.equal(f.calls(), 1);
  });
}

test('全部检查订阅取消会中止传输，重查不受失败缓存影响', async t => {
  const f = await setup(t);
  const entered = Promise.withResolvers();
  f.fetch = async signal => { entered.resolve(signal); await delay(10000, null, {signal}); };
  const controllers = [new AbortController(), new AbortController()];
  const requests = controllers.map(({signal}) => f.updates.checkCoreUpdate(f.config, {signal}));
  const shared = await entered.promise;
  for (const controller of controllers) controller.abort();
  for (const result of await Promise.all(requests)) assert.match(result.reason, /取消/);
  assert.equal(shared.aborted, true);
  assert.deepEqual(await readdir(f.config.dataDir), []);
  f.fetch = async () => f.data;
  assert.deepEqual(await f.updates.checkCoreUpdate(f.config), {state: 'available', version});
  assert.equal(f.calls(), 2);
});

test('自定义路径不访问网络或磁盘，基线版本精确匹配', async t => {
  const f = await setup(t);
  const custom = {...f.config, core: null};
  for (const result of [await f.updates.checkCoreUpdate(custom), await f.updates.downloadCoreUpdate(custom, version), await f.updates.getUpdateStatus(custom)]) {
    assert.deepEqual(result, {state: 'custom', version: null});
  }
  await assert.rejects(f.updates.getStagedCore(custom, version));
  assert.equal(f.calls(), 0);
  assert.deepEqual(await readdir(f.config.dataDir), []);
  const core = f.config.core;
  f.data = metadata(core, core.version);
  Object.assign(f.data.assets[0], {digest: `sha256:${core.binarySha256}`, size: core.sizeBytes});
  assert.deepEqual(await f.updates.checkCoreUpdate(f.config), {state: 'current', version: core.version});
});

test('拒绝非稳定 tag、歧义资产、错误 URL、摘要和大小，不泄露响应内容', async t => {
  const f = await setup(t);
  for (const corrupt of [r => r.draft = true, r => r.prerelease = true, r => r.tag_name += '-rc1', r => r.tag_name = 'v01.0.0',
    r => r.assets.push(r.assets[0]), r => r.assets[0].name += '.zip', r => r.assets[0].browser_download_url += '?private',
    r => r.assets[0].browser_download_url = r.assets[0].browser_download_url.replace('https:', 'http:'),
    r => r.assets[0].digest += '0', r => r.assets[0].digest = 'secret', r => r.assets[0].size = -1,
    r => r.assets[0].size = 128 * 1024 ** 2 + 1]) {
    f.time += 61000;
    f.data = metadata(f.config.core);
    corrupt(f.data);
    const result = await f.updates.checkCoreUpdate(f.config);
    assert.equal(result.state, 'error');
    assert.doesNotMatch(result.reason, /private|secret|https?:/);
    assert.deepEqual(await readdir(f.config.dataDir), []);
  }
});

test('两个点击共享下载，单个请求断线仍完成，进度可读', async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let count = 0;
  const f = await setup(t, async ({destination, onProgress, signal}) => {
    count++; onProgress(3); started.resolve(); await finish.promise; signal.throwIfAborted(); await writeFile(destination, bytes);
  });
  await f.updates.checkCoreUpdate(f.config);
  const abort = new AbortController();
  const requests = [f.updates.downloadCoreUpdate(f.config, version, {signal: abort.signal}), f.updates.downloadCoreUpdate(f.config, version)];
  await started.promise;
  assert.equal((await f.updates.getUpdateStatus(f.config)).progress.receivedBytes, 3);
  await delay(25);
  abort.abort('private'); finish.resolve();
  const [first, second] = await Promise.all(requests);
  assert.equal(first.state, 'error'); assert.equal(second.state, 'staged'); assert.equal(count, 1);
});

test('断线及损坏下载不发布候选，可再次手动下载', async t => {
  let attempts = 0;
  const started = Promise.withResolvers();
  const f = await setup(t, async ({destination, signal}) => {
    if (++attempts === 1) { started.resolve(); await delay(10000, null, {signal}); }
    await writeFile(destination, attempts === 2 ? Buffer.alloc(bytes.length) : bytes);
  });
  await f.updates.checkCoreUpdate(f.config);
  const controller = new AbortController();
  const task = f.updates.downloadCoreUpdate(f.config, version, {signal: controller.signal});
  await started.promise; controller.abort('private');
  assert.equal((await task).state, 'error');
  await assert.rejects(f.updates.getStagedCore(f.config, version));
  assert.equal((await f.updates.downloadCoreUpdate(f.config, version)).state, 'error');
  await assert.rejects(f.updates.getStagedCore(f.config, version));
  assert.equal((await f.updates.downloadCoreUpdate(f.config, version)).state, 'staged');
});

test('新实例发现新版后，旧下载即使较晚完成也无法发布为当前候选', async t => {
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const f = await setup(t, async ({destination}) => { started.resolve(); await finish.promise; await writeFile(destination, bytes); });
  await f.updates.checkCoreUpdate(f.config);
  const old = f.updates.downloadCoreUpdate(f.config, version);
  await started.promise;
  const newer = 'v1.100.0';
  const other = createCoreUpdates({fetchMetadata: async () => metadata(f.config.core, newer)});
  assert.deepEqual(await other.checkCoreUpdate(f.config), {state: 'available', version: newer});
  finish.resolve();
  assert.equal((await old).state, 'error');
  await assert.rejects(f.updates.getStagedCore(f.config, version));
  const {getInstalledCore, listInstalledCores} = await import('../server/installed-cores.mjs');
  assert.equal((await getInstalledCore(f.config, version)).version, version);
  assert.deepEqual((await listInstalledCores(f.config)).map(row => row.version), [version]);
  assert.deepEqual(await f.updates.getUpdateStatus(f.config, {version}), {state: 'staged', version});
  assert.deepEqual(await f.updates.getUpdateStatus(f.config), {state: 'available', version: newer});
  assert.deepEqual(await createCoreUpdates().getUpdateStatus(f.config), {state: 'available', version: newer});
});

const api = 'https://api.github.com/repos/yetone/magpie/releases';

test('首次查询只返回规范 latest，可低于基线；共享请求独立取消且不写文件', async t => {
  const f = await setup(t, () => assert.fail('查询不应下载'));
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  f.fetch = async signal => {
    entered.resolve(); await resume.promise; signal.throwIfAborted();
    return metadata(f.config.core, 'v0.0.1');
  };
  const controller = new AbortController();
  const cancelled = f.updates.latestCoreRelease(f.config, {signal: controller.signal});
  const other = f.updates.latestCoreRelease(f.config);
  await entered.promise;
  controller.abort('private');
  await assert.rejects(cancelled, /取消/);
  resume.resolve();
  const release = await other;
  assert.equal(release.version, 'v0.0.1');
  assert.equal(release, f.runtime.registerStoredRelease(release));
  assert.deepEqual(f.urls, [`${api}/latest`]);
  assert.deepEqual(await readdir(f.config.dataDir), []);
  await assert.rejects(f.updates.latestCoreRelease({...f.config, core: null}), /自定义/);
  await assert.rejects(f.updates.latestCoreRelease(f.config, {signal: AbortSignal.abort()}), /取消/);
  assert.equal(f.calls(), 1);
});

test('元数据超时取消传输并返回安全原因，下次可以重新查询', async t => {
  const f = await setup(t);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 15000); return deadline.signal; });
  f.fetch = async signal => { deadline.abort(); signal.throwIfAborted(); };
  await assert.rejects(f.updates.latestCoreRelease(f.config), error => error.safeMessage?.includes('超时'));
  t.mock.restoreAll();
  f.fetch = () => f.data;
  assert.equal((await f.updates.latestCoreRelease(f.config)).version, version);
  assert.equal(f.calls(), 2);
});

test('指定下载后出现更新的 latest 仍按原 tag 落盘；多个版本可离线枚举且不改 active', async t => {
  const low = 'v0.0.17', high = 'v20.0.1', latest = 'v21.0.1';
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const downloads = [];
  const f = await setup(t, async ({url, destination, onProgress}) => {
    downloads.push(url);
    if (url.includes(`/${low}/`)) { onProgress(7); entered.resolve(); await resume.promise; }
    await writeFile(destination, bytes);
  });
  const {config, updates} = f;
  const activePath = join(config.dataDir, `core-selection-${config.core.key}.json`);
  const active = JSON.stringify({active: config.core});
  await writeFile(activePath, active);
  f.fetch = async (_signal, url) => metadata(config.core, url === `${api}/latest` ? latest : url.split('/').at(-1));
  const pending = updates.downloadSpecifiedCore(config, low);
  await entered.promise;
  try {
    assert.equal(await updates.isDownloadOnlyCore(config, low), true);
    assert.equal(await updates.isDownloadOnlyCore(config, latest), false);
    const {state, version: tag, progress, source} = await updates.getUpdateStatus(config);
    assert.equal(state, 'downloading'); assert.equal(tag, low); assert.equal(source, 'specified');
    assert.equal(progress.receivedBytes, 7);
    const second = updates.downloadSpecifiedCore(config, high);
    assert.equal((await updates.getUpdateStatus(config)).version, high);
    assert.equal((await updates.getUpdateStatus(config, {version: low})).progress.receivedBytes, 7);
    assert.deepEqual(await second, {state: 'staged', version: high});
    assert.deepEqual(await updates.getUpdateStatus(config, {version: high}), {state: 'staged', version: high});
    // 手动下载的高版本还不是最新提示。
    assert.deepEqual(await createCoreUpdates().getUpdateStatus(config), {state: 'idle', version: null});
    await updates.checkCoreUpdate(config);
    const {deleteInstalledCore} = await import('../server/installed-cores.mjs');
    await assert.rejects(deleteInstalledCore(config, low), /正在操作|忙/);
  } finally { resume.resolve(); }
  assert.deepEqual(await pending, {state: 'staged', version: low});
  assert.deepEqual(await updates.getUpdateStatus(config), {state: 'available', version: latest});
  assert.deepEqual(f.urls, [`${api}/tags/${low}`, `${api}/tags/${high}`, `${api}/latest`]);
  assert.deepEqual(downloads, [low, high].map(tag => metadata(config.core, tag).assets[0].browser_download_url));
  const offline = createCoreUpdates({runtime: createCoreRuntime({download: () => assert.fail('不应下载')}), fetchMetadata: () => assert.fail('不应联网')});
  const {getInstalledCore, listInstalledCores} = await import('../server/installed-cores.mjs');
  for (const tag of [low, high]) {
    assert.deepEqual(await offline.downloadSpecifiedCore(config, tag), {state: 'staged', version: tag});
    assert.equal((await getInstalledCore(config, tag)).version, tag);
    await assert.rejects(offline.getStagedCore(config, tag));
  }
  assert.deepEqual((await listInstalledCores(config)).map(row => [row.version, row.active]), [[high, false], [low, false]]);
  assert.equal(await readFile(activePath, 'utf8'), active);
  assert.equal((await getCoreStatus(config)).state, 'missing');
});

test('指定下载无 tag、404、错 tag、错平台、缺摘要及网络失败均可诊断且不发布', async t => {
  const f = await setup(t, () => assert.fail('错误元数据不应下载'));
  const {config, updates} = f;
  for (const tag of [undefined, null, '', 'latest', 'v1.2.3-rc.1', 'v01.2.3', '../v1.2.3', 'v1.2.3\n']) {
    assert.match((await updates.downloadSpecifiedCore(config, tag)).reason, /三段/);
  }
  assert.equal(f.calls(), 0);
  for (const [load, reason] of [
    [() => {throw Object.assign(Error('private'), {status: 404});}, /404/],
    [() => {throw Error('private');}, /网络/],
    [() => metadata(config.core, 'v2.0.0'), /tag/],
    [() => ({...metadata(config.core), tag_name: undefined}), /tag/],
    [() => ({...metadata(config.core), draft: true}), /稳定/],
    [() => ({...metadata(config.core), prerelease: true}), /稳定/],
    [() => ({...metadata(config.core), assets: [{name: 'wrong'}]}), /平台/],
    [() => ({...metadata(config.core), assets: [{name: config.core.archive}]}), /摘要/],
  ]) {
    f.fetch = load;
    const result = await updates.downloadSpecifiedCore(config, version);
    assert.equal(result.state, 'error'); assert.equal(result.version, version);
    assert.match(result.reason, reason); assert.doesNotMatch(result.reason, /private/);
    assert.deepEqual(await updates.getUpdateStatus(config), result);
  }
  assert.deepEqual(await readdir(config.dataDir), []);
  assert.deepEqual(await updates.downloadSpecifiedCore({...config, core: null}, version), {state: 'custom', version: null});
});

test('生产元数据传输区分最终响应的 404、普通 403 和 GitHub 限流', async t => {
  const {config} = await setup(t);
  const moduleUrl = new URL('../server/core-updates.mjs', import.meta.url).href;
  const reset = Math.floor(Date.now() / 1000) + 300;
  const prefix = 'HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 302\r\nX-RateLimit-Remaining: 0\r\n\r\n';
  const responses = [
    ['403', 'HTTP/2 403\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ' + reset],
    ['404', 'HTTP/2 404'],
    ['403', 'HTTP/2 403'],
    ['403', 'HTTP/2 403\r\nRetry-After: 120'],
    ['429', 'HTTP/2 429'],
    ['000', ''],
  ].map(([status, headers]) => [status, prefix + headers + '\r\n\r\n']);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const spawn = childProcess.spawn;
    const responses = ${JSON.stringify(responses)};
    let calls = 0;
    childProcess.spawn = (_file, args, options) => {
      assert.ok(args.includes(calls === 0 ? ${JSON.stringify(`${api}/latest`)} : ${JSON.stringify(`${api}/tags/${version}`)}));
      assert.ok(args.includes('%{stderr}%{http_code}'));
      assert.equal(options.env.HTTPS_PROXY, 'http://127.0.0.1:1');
      const [status, headers] = responses[calls++];
      const headersIndex = args.indexOf('--dump-header');
      assert.ok(headersIndex >= 0);
      writeFileSync(args[headersIndex + 1], headers);
      return spawn(process.execPath, ['-e', "process.stderr.write(process.argv[1]); process.exitCode = 22", status], options);
    };
    syncBuiltinESMExports();
    const {checkCoreUpdate, downloadSpecifiedCore} = await import(${JSON.stringify(moduleUrl)});
    const config = JSON.parse(process.argv[1]);
    const results = [await checkCoreUpdate(config)];
    for (let i = 1; i < responses.length; i++) results.push(await downloadSpecifiedCore(config, ${JSON.stringify(version)}));
    console.log(JSON.stringify([calls, results]));
  `, JSON.stringify(config)], {encoding: 'utf8', timeout: 5000, env: {...process.env, QODER_HTTP_PROXY: 'http://127.0.0.1:1'}});
  const [calls, results] = JSON.parse(output);
  const resetTime = new Intl.DateTimeFormat('zh-CN', {dateStyle: 'short', timeStyle: 'medium', hour12: false}).format(reset * 1000);
  assert.equal(calls, responses.length);
  assert.ok(results.every(result => result.state === 'error'));
  const [exhausted, missing, forbidden, throttled, tooMany, offline] = results.map(result => result.reason);
  assert.equal(exhausted, `GitHub API 查询额度已用完。请在本地时间 ${resetTime} 后重试。`);
  assert.match(missing, /404/);
  assert.match(forbidden, /无法读取官方发行信息/);
  assert.match(throttled, /GitHub API 请求暂时受限。请在本地时间 .* 后重试。/);
  assert.equal(tooMany, 'GitHub API 请求暂时受限。请稍后重试。');
  assert.equal(offline, forbidden);
  assert.deepEqual(await readdir(config.dataDir), []);
});

test('指定 tag 元数据取消传递给底层，损坏文件无法暂存，重试校验后可恢复', async t => {
  const entered = Promise.withResolvers();
  let attempts = 0;
  const f = await setup(t, async ({destination}) => writeFile(destination, ++attempts === 1 ? Buffer.alloc(bytes.length) : bytes));
  f.fetch = async signal => { entered.resolve(); await delay(10000, null, {signal}); };
  const controller = new AbortController();
  const task = f.updates.downloadSpecifiedCore(f.config, version, {signal: controller.signal});
  await entered.promise;
  assert.deepEqual((await f.updates.getUpdateStatus(f.config)).progress, {phase: 'waiting', receivedBytes: 0, totalBytes: null});
  controller.abort('private');
  assert.match((await task).reason, /取消/);
  assert.equal(attempts, 0);
  f.fetch = () => f.data;
  const corrupt = await f.updates.downloadSpecifiedCore(f.config, version);
  assert.match(corrupt.reason, /SHA256/);
  assert.deepEqual(await f.updates.getUpdateStatus(f.config), corrupt);
  const root = join(f.config.dataDir, 'runtimes');
  const offerPath = join(root, `offer-${f.config.core.key}-${version}.json`);
  assert.equal(JSON.parse(await readFile(offerPath)).downloadOnly, true);
  await assert.rejects(readFile(join(root, `stage-${f.config.core.key}-${version}.json`)), {code: 'ENOENT'});
  assert.equal((await f.updates.downloadSpecifiedCore(f.config, version)).state, 'staged');
  // 此发行仅在 latest 确认后才可从提示切换，原二进制可直接使用。
  assert.deepEqual(await f.updates.checkCoreUpdate(f.config), {state: 'staged', version});
  assert.equal((await f.updates.getStagedCore(f.config, version)).version, version);
  assert.equal(JSON.parse(await readFile(offerPath)).downloadOnly, true);
  assert.equal(attempts, 2);
  assert.deepEqual(await readdir(f.config.dataDir), ['runtimes']);
});

test('初始或历史发行须 ready 才能登记；成功登记可离线恢复且没有 active 或更新提示', async t => {
  const f = await setup(t);
  const release = await f.updates.latestCoreRelease(f.config);
  const bin = f.runtime.resolveCoreBinaryPath({dataDir: f.config.dataDir, ...release});
  await assert.rejects(f.updates.rememberInstalledCore(f.config, release), /校验/);
  assert.deepEqual(await readdir(f.config.dataDir), []);
  await mkdir(dirname(bin), {recursive: true});
  await writeFile(bin, Buffer.alloc(bytes.length));
  await assert.rejects(f.updates.rememberInstalledCore(f.config, release), /校验/);
  await writeFile(bin, bytes);
  assert.equal(await f.updates.rememberInstalledCore(f.config, release), release);
  assert.equal(await f.updates.rememberInstalledCore(f.config, release), release);
  const {getInstalledCore} = await import('../server/installed-cores.mjs');
  assert.equal((await getInstalledCore(f.config, version)).binarySha256, sha);
  const restarted = createCoreUpdates();
  assert.equal(await restarted.isDownloadOnlyCore(f.config, version), false);
  assert.deepEqual(await restarted.getUpdateStatus(f.config), {state: 'idle', version: null});
  assert.deepEqual(await readdir(f.config.dataDir), ['runtimes']);
  assert.equal(f.calls(), 1);
});
