import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import { createLegacyCoreFinder, findLegacyCore, legacyCoreReleases } from "../server/legacy-core-cache.mjs";

const baseline = JSON.parse(await fs.readFile(new URL("../server/bin/platforms.json", import.meta.url), "utf8"));
const history = JSON.parse(await fs.readFile(new URL("../server/bin/legacy-releases.json", import.meta.url), "utf8"));
const keys = ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const versions = ["v0.1.4330", "v0.1.4403", "v0.1.4520", "v0.1.4582"];

async function temporary(t) {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "qoder-legacy-core-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fixtureBytes(version, key) {
  return Buffer.from(`offline fixture ${version} ${key}\n`);
}

async function fixture(t) {
  const root = await temporary(t);
  const dataDir = join(root, "data");
  const base = structuredClone(baseline);
  const old = structuredClone(history);
  for (const version of versions) {
    for (const key of keys) {
      const bytes = fixtureBytes(version, key);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      old.releases[version][key] = { sizeBytes: bytes.length, sha256 };
    }
  }
  const finder = createLegacyCoreFinder(base, old);
  const bin = (version, key) => join(dataDir, "runtimes", version, key, basename(base.platforms[key].path));
  const put = async (version, key, bytes = fixtureBytes(version, key)) => {
    const path = bin(version, key);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, bytes, { mode: 0o755 });
    return path;
  };
  return { root, dataDir, base, old, finder, bin, put };
}

// 计数后再断言，避免被测代码捕获 I/O 错误而掩盖越界读取或下载尝试。
function observe(t, object, name, observeCall) {
  const original = object[name];
  t.mock.method(object, name, function (...args) {
    observeCall(...args);
    return original.apply(this, args);
  });
}

function offline(t) {
  const calls = [];
  for (const [object, methods] of [[globalThis, ["fetch"]], [childProcess, ["spawn", "execFile", "exec"]],
    [net, ["createConnection", "createServer"]], [process, ["kill"]]]) {
    for (const method of methods) {
      t.mock.method(object, method, () => { calls.push(method); throw Error(`unexpected ${method}`); });
    }
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test("生产历史清单覆盖八个 1.1.x 标签的四版五平台；空缓存没有默认版本", async (t) => {
  assert.deepEqual(Object.keys(history.releases).sort(), versions);
  for (const assets of Object.values(history.releases)) {
    assert.deepEqual(Object.keys(assets).sort(), [...keys].sort());
  }
  const root = await temporary(t);
  const dataDir = join(root, "fresh");
  const calls = offline(t);
  for (const key of keys) {
    const [platform, arch] = key.split("-");
    const config = { dataDir, core: { platform, arch, key } };
    const published = legacyCoreReleases(config);
    assert.deepEqual(published.map(release => release.version), [...versions].reverse());
    for (const release of published) {
      const asset = history.releases[release.version][key];
      assert.equal(release.key, key);
      assert.equal(release.sizeBytes, asset.sizeBytes);
      assert.equal(release.binarySha256, asset.sha256);
    }
    assert.equal(await findLegacyCore(config), null);
  }
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(calls, []);
});

for (const key of keys) {
  test(`${key} 离线从多个历史缓存选最新版，返回完整规范发行`, async (t) => {
    const { dataDir, base, old, finder, put } = await fixture(t);
    const [platform, arch] = key.split("-");
    await put(versions[0], key);
    await put(versions[1], key);
    const version = versions[2];
    const path = await put(version, key);
    const otherKey = key === "win32-x64" ? "linux-x64" : "win32-x64";
    await put(versions[3], otherKey);
    await put("v99.0.0", key);
    const before = await fs.stat(path);
    const calls = offline(t);
    const actual = await finder({ dataDir, core: { platform, arch } });
    const entry = base.platforms[key];
    const asset = old.releases[version][key];
    assert.deepEqual(actual, { ...entry, version, key, platform, arch,
      url: `https://github.com/yetone/magpie/releases/download/${version}/${entry.archive}`,
      sizeBytes: asset.sizeBytes, binarySha256: asset.sha256, archiveSha256: asset.sha256 });
    assert.equal((await fs.stat(path)).mtimeMs, before.mtimeMs);
    assert.deepEqual(calls, []);
  });
}

test("新的下载记录先于核心发布，历史版本下载中或已暂存均不能当作旧安装自动选用", async t => {
  const { dataDir, finder, put } = await fixture(t);
  const key = 'win32-x64';
  const config = { dataDir, platform: 'win32', arch: 'x64' };
  await put(versions[3], key);
  for (const kind of ['offer', 'stage']) {
    const record = join(dataDir, 'runtimes', `${kind}-${key}-${versions[3]}.json`);
    await fs.writeFile(record, '{}');
    assert.equal(await finder(config), null);
    await fs.unlink(record);
  }
  await fs.writeFile(join(dataDir, 'runtimes', `stage-${key}-${versions[3]}.json`), '{}');
  await put(versions[1], key);
  assert.equal((await finder(config)).version, versions[1]);
});

test('枚举通过后并发下载才发布来源和二进制，迁移继续寻找真正的旧缓存', async t => {
  const { dataDir, finder, bin, put } = await fixture(t);
  const key = 'linux-x64', recent = versions[3], previous = versions[1];
  const path = bin(recent, key);
  await fs.mkdir(dirname(path), { recursive: true });
  await put(previous, key);
  const lstat = fs.lstat;
  let published = false;
  const intercept = t.mock.method(fs, 'lstat', async (probe, ...options) => {
    if (!published && probe === dirname(path)) {
      published = true;
      await fs.writeFile(join(dataDir, 'runtimes', `offer-${key}-${recent}.json`), '{}');
      await put(recent, key);
    }
    return lstat(probe, ...options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await finder({dataDir, platform: 'linux', arch: 'x64'})).version, previous);
    assert.equal(published, true);
  } finally { intercept.mock.restore(); syncBuiltinESMExports(); }
});

test('macOS 的 /tmp 和 /var 系统别名下可识别历史核心', {skip: process.platform !== 'darwin'}, async t => {
  const { finder } = await fixture(t);
  const key = 'darwin-arm64', version = versions[2];
  for (const parent of ['/tmp', '/var/tmp']) {
    const dataDir = await fs.mkdtemp(join(parent, 'legacy-alias-'));
    t.after(() => fs.rm(dataDir, {recursive: true, force: true}));
    const dir = join(dataDir, 'runtimes', version, key);
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(join(dir, 'magpie'), fixtureBytes(version, key));
    assert.equal((await finder({dataDir, platform: 'darwin', arch: 'arm64'})).version, version);
  }
});

test("无版本的平台清单仍能找回末版旧核心，新基线和同名候选不进入历史名单", async (t) => {
  const { dataDir, base, old, put } = await fixture(t);
  const key = "darwin-arm64";
  const layout = { upstream: base.upstream, platforms: {} };
  for (const [key, { path, archive, mode }] of Object.entries(base.platforms)) {
    layout.platforms[key] = { path, archive, ...(mode ? { mode } : {}) };
  }
  await put(versions[3], key);
  const future = "v1.2.3";
  const binPath = await put(future, key);
  const config = { dataDir, binPath, platform: "darwin", arch: "arm64" };
  for (const manifest of [layout, { ...layout, version: future }]) {
    assert.equal((await createLegacyCoreFinder(manifest, old)(config)).version, versions[3]);
  }
});

test("bridge.pid 和规范运行时路径只影响排序，摘要失败回退到下一份有效缓存", async (t) => {
  const { dataDir, finder, put } = await fixture(t);
  const key = "win32-x64";
  const [oldest, intermediate, , newest] = versions;
  const pidHint = await put(oldest, key);
  const config = { dataDir, platform: "win32", arch: "x64", binPath: await put(intermediate, key) };
  await put(newest, key);
  const pidPath = join(dataDir, "bridge.pid");
  await fs.writeFile(pidPath, JSON.stringify({ pid: -1, binPath: pidHint }));
  const calls = offline(t);
  assert.equal((await finder(config)).version, oldest);
  await put(oldest, key, Buffer.alloc(fixtureBytes(oldest, key).length));
  assert.equal((await finder(config)).version, intermediate);
  await fs.writeFile(pidPath, JSON.stringify({ pid: process.pid, binPath: join(dataDir, "other-app", "magpie.exe") }));
  assert.equal((await finder({ ...config, binPath: undefined })).version, newest);
  await fs.writeFile(pidPath, "{");
  assert.equal((await finder(config)).version, intermediate);
  assert.deepEqual(calls, []);
});

test("未知版本、其他平台、其他应用和外部 pidPath 均不探测，无有效缓存时返回 null", async (t) => {
  const { root, dataDir, finder, put } = await fixture(t);
  const key = "linux-x64";
  const known = versions[1];
  await put(known, key, Buffer.alloc(fixtureBytes(known, key).length));
  await put(versions[2], key, Buffer.from("short"));
  await put("v99.0.0", key);
  await put(versions[3], "darwin-x64");
  const latest = join(dataDir, "runtimes", "stage-linux-x64-v99.0.0.json");
  await fs.writeFile(latest, "{}");
  const forbidden = [join(dataDir, "runtimes", "v99.0.0"), join(dataDir, "runtimes", versions[3], "darwin-x64"), latest, join(root, "other-app")];
  const accesses = [];
  for (const method of ["lstat", "open", "readFile", "realpath", "readdir"]) observe(t, fs, method, (path) => {
    if (method === "readdir" || forbidden.some((p) => String(path).startsWith(p))) accesses.push([method, path]);
  });
  const calls = offline(t);
  const config = { dataDir, platform: "linux", arch: "x64", binPath: forbidden[3], pidPath: join(forbidden[3], "bridge.pid") };
  assert.equal(await finder(config), null);
  assert.equal(await finder({ ...config, arch: "ia32" }), null);
  assert.deepEqual(accesses, []);
  assert.deepEqual(calls, []);
});

test("缓存祖先、dataDir、runtimes、版本及平台目录的链接均在访问子路径前拒绝", async (t) => {
  const { root, dataDir, finder, put } = await fixture(t);
  const version = versions[2];
  const key = "darwin-arm64";
  const path = await put(version, key);
  const calls = offline(t);
  const type = process.platform === "win32" ? "junction" : "dir";
  const alias = join(root, "alias");
  await fs.symlink(root, alias, type);
  const config = { platform: "darwin", arch: "arm64", dataDir };
  assert.equal(await finder({ ...config, dataDir: join(alias, "data") }), null);
  for (const dir of [dataDir, join(dataDir, "runtimes"), join(dataDir, "runtimes", version), dirname(path)]) {
    const target = join(root, "target");
    await fs.rename(dir, target);
    await fs.symlink(target, dir, type);
    const touched = [];
    const original = fs.lstat;
    const mock = t.mock.method(fs, "lstat", (p, ...options) => {
      const child = relative(dir, p);
      if (child && !child.startsWith("..")) touched.push(p);
      return original(p, ...options);
    });
    syncBuiltinESMExports();
    try {
      assert.equal(await finder(config), null);
      assert.deepEqual(touched, []);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
      await fs.unlink(dir);
      await fs.rename(target, dir);
    }
  }
  assert.deepEqual(calls, []);
});

test("多硬链接的核心与 PID 记录均跳过，不执行、不读取链接内容", async (t) => {
  const { root, dataDir, finder, put } = await fixture(t);
  const key = "linux-arm64";
  const paths = [];
  for (const version of versions) paths.push(await put(version, key));
  await fs.link(paths[3], join(root, "linked-core"));
  const pidPath = join(dataDir, "bridge.pid");
  const external = join(root, "external-record");
  await fs.writeFile(external, JSON.stringify({ binPath: paths[0] }));
  await fs.link(external, pidPath);
  const opened = [];
  observe(t, fs, "open", (p) => opened.push(p));
  const calls = offline(t);
  const config = { dataDir, platform: "linux", arch: "arm64" };
  assert.equal((await finder(config)).version, versions[2]);
  assert.deepEqual(opened, [paths[2]]);
  assert.deepEqual(calls, []);
});

test("核心和 PID 文件位置的链接均不打开", async (t) => {
  const { root, dataDir, finder, put } = await fixture(t);
  const key = "win32-x64";
  const old = await put(versions[0], key);
  await put(versions[1], key);
  const link = await put(versions[3], key);
  const external = join(root, "external-core");
  await fs.rename(link, external);
  const pid = join(root, "external-pid");
  await fs.writeFile(pid, JSON.stringify({ binPath: old }));
  try {
    await fs.symlink(external, link, "file");
    await fs.symlink(pid, join(dataDir, "bridge.pid"), "file");
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    t.diagnostic("Windows 无文件符号链接权限，在两个文件位置使用真实 junction 检查拒绝访问。");
    const destination = join(root, "link-target");
    await fs.mkdir(destination);
    for (const p of [link, join(dataDir, "bridge.pid")]) {
      if (!await fs.lstat(p).catch(() => null)) await fs.symlink(destination, p, "junction");
    }
  }
  const opened = [];
  observe(t, fs, "open", (p) => opened.push(p));
  const calls = offline(t);
  assert.equal((await finder({ dataDir, platform: "win32", arch: "x64" })).version, versions[1]);
  assert.ok(!opened.includes(link) && !opened.includes(join(dataDir, "bridge.pid")));
  assert.deepEqual(calls, []);
});
