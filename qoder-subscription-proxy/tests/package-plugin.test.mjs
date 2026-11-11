import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/package-plugin.mjs');
const platforms = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];
const expected = ['mcp.json', ...readFileSync(path.join(root, 'scripts/distribution-files.txt'), 'utf8').trimEnd().split(/\r?\n/)].sort();
const manifest = JSON.parse(readFileSync(path.join(root, 'server/bin/platforms.json'), 'utf8'));

function temporary(t) {
  const directory = mkdtempSync(path.join(path.resolve(root, '..'), '.插件 打包测试 '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, cwd, entry = script) {
  return spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });
}

function checksum(data) {
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let value = 0xffffffff;
  for (const byte of data) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function unpack(filename, platform, coreEntry) {
  const zip = readFileSync(filename);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 4), 0);
  assert.equal(zip.readUInt16LE(end + 6), 0);
  const count = zip.readUInt16LE(end + 10);
  assert.equal(zip.readUInt16LE(end + 8), count);
  const start = zip.readUInt32LE(end + 16);
  assert.equal(start + zip.readUInt32LE(end + 12), end);
  const result = new Map();
  let cursor = start;
  let localEnd = 0;
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    assert.equal(zip.readUInt16LE(cursor + 8), 0x800);
    assert.equal(zip.readUInt16LE(cursor + 10), 8);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert(!result.has(name));
    const local = zip.readUInt32LE(cursor + 42);
    assert.equal(local, localEnd);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.deepEqual(zip.subarray(local + 4, local + 30), zip.subarray(cursor + 6, cursor + 32));
    assert.equal(zip.subarray(local + 30, local + 30 + nameLength).toString('utf8'), name);
    const dataStart = local + 30 + nameLength + zip.readUInt16LE(local + 28);
    localEnd = dataStart + compressedSize;
    const content = inflateRawSync(zip.subarray(dataStart, localEnd));
    assert.equal(content.length, size);
    assert.equal(checksum(content), crc, name);
    const executable = name.endsWith('.sh') || (name === coreEntry && platform !== 'win32-x64');
    assert.equal(zip.readUInt32LE(cursor + 38) >>> 16, executable ? 0o100755 : 0o100644, name);
    result.set(name, content);
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(localEnd, start);
  return result;
}

// 源码夹具附带合成构建核心，并把平台清单摘要改为合成值；测试不依赖真实下载产物。
function fixture(directory, platform) {
  const source = path.join(directory, '源码 插件');
  for (const name of [...expected, 'scripts/package-plugin.mjs', 'scripts/build-approval-router.mjs']) {
    const destination = path.join(source, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, name), destination);
  }
  const release = manifest.platforms[platform];
  const coreEntry = `server/bin/${release.path}`;
  const fake = Buffer.from(`fake core for ${platform}; never executed\n`.repeat(64));
  const build = path.join(source, '.core-build', platform, path.posix.basename(release.path));
  mkdirSync(path.dirname(build), { recursive: true });
  writeFileSync(build, fake);
  const patched = structuredClone(manifest);
  patched.platforms[platform].binarySha256 = createHash('sha256').update(fake).digest('hex');
  writeFileSync(path.join(source, 'server/bin/platforms.json'), JSON.stringify(patched, null, 2));
  const approvalFile = `qoder-approval-router.${platform.startsWith('win32') ? 'dll' : platform.startsWith('darwin') ? 'dylib' : 'so'}`;
  const approvalBuild = path.join(source, '.approval-build', platform);
  const approvalBytes = Buffer.from(`synthetic approval library ${platform}`);
  const approvalManifest = { abiVersion: 1, platform, file: approvalFile, sha256: createHash('sha256').update(approvalBytes).digest('hex') };
  mkdirSync(approvalBuild, { recursive: true });
  writeFileSync(path.join(approvalBuild, approvalFile), approvalBytes);
  writeFileSync(path.join(approvalBuild, 'manifest.json'), JSON.stringify(approvalManifest));
  const approvalEntries = ['server/approval-router/manifest.json', `server/approval-router/${approvalFile}`];
  return { source, coreEntry, fake, build, approvalFile, approvalBuild, approvalManifest, approvalEntries, entry: path.join(source, 'scripts/package-plugin.mjs') };
}

for (const platform of platforms) {
  test(`${platform}: 根清单、真实内容、CRC、仅内置本平台核心及可重复产物`, t => {
    const directory = temporary(t);
    const { source, coreEntry, fake, entry, approvalEntries, approvalBuild } = fixture(directory, platform);
    const target = path.join(directory, '产物 有空格.zip');
    const result = run([platform, path.basename(target)], directory, entry);
    assert.equal(result.status, 0, result.stderr);
    const entries = unpack(target, platform, coreEntry);
    assert.deepEqual([...entries.keys()], [...expected, coreEntry, ...approvalEntries].sort());
    for (const [name, data] of entries) {
      if (name === coreEntry) {
        assert.deepEqual(data, fake, name);
        continue;
      }
      if (approvalEntries.includes(name)) {
        assert.deepEqual(data, readFileSync(path.join(approvalBuild, path.posix.basename(name))));
        continue;
      }
      const sourceName = name === 'mcp.json' && platform !== 'win32-x64' ? 'mcp.posix.json' : name;
      assert.deepEqual(data, readFileSync(path.join(source, sourceName)), name);
    }
    const pluginManifest = JSON.parse(entries.get('.qoder-plugin/plugin.json'));
    assert.equal(pluginManifest.commands, undefined, '1.0.0 起不再随包斜杠指令');
    // 每个随包运行模块的本地导入都必须同时在 ZIP 内。
    for (const [name, bytes] of entries) {
      if (!name.endsWith('.mjs')) continue;
      for (const match of bytes.toString().matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
        assert.ok(entries.has(path.posix.join(path.posix.dirname(name), match[1])), name + ': ' + match[1]);
      }
    }
    const config = JSON.parse(entries.get('mcp.json')).mcpServers['qoder-subscription-proxy'];
    assert.equal(config.command, platform === 'win32-x64' ? 'powershell.exe' : '/bin/sh');
    assert(config.args.some(arg => arg.endsWith(platform === 'win32-x64' ? '/scripts/start-mcp.ps1' : '/scripts/start-mcp.sh')));
    const again = path.join(directory, '再次.zip');
    assert.equal(run([platform, again], directory, entry).status, 0);
    assert.deepEqual(readFileSync(target), readFileSync(again));
  });
}

test('白名单排除测试、数据、凭据、日志、其他平台核心及未知脚本', t => {
  const directory = temporary(t);
  const { source, coreEntry, entry, approvalEntries } = fixture(directory, 'win32-x64');
  for (const name of ['tests/private.test.mjs', 'server/data/token.json', 'server/bin/core.exe',
    'server/bin/core.tar.gz', 'server/panel/secret.json', 'server/debug.log', '.env',
    'scripts/prepare-test-core.mjs', 'scripts/fetch-core.mjs', 'scripts/unknown.mjs',
    'server/local-debug-only.mjs', 'commands/private.md', '.core-build/linux-x64/qoder-plugin-subscription-proxy',
    '.approval-build/linux-x64/manifest.json', '.approval-build/linux-x64/qoder-approval-router.so',
    'native/approval-router/src/lib.rs']) {
    const filename = path.join(source, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, 'must not be packaged');
  }
  const target = path.join(directory, '白名单.zip');
  const result = run(['win32-x64', target], directory, entry);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([...unpack(target, 'win32-x64', coreEntry).keys()], [...expected, coreEntry, ...approvalEntries].sort());
});

for (const failure of ['missing-manifest', 'missing-library', 'json', 'null', 'abi', 'platform', 'file', 'sha-format', 'sha-mismatch', 'extra', 'directory']) {
  test(`审批扩展 ${failure}：拒绝错误产物且不留下 ZIP`, t => {
    const directory = temporary(t);
    const { entry, approvalBuild, approvalFile, approvalManifest } = fixture(directory, 'linux-x64');
    const manifestFile = path.join(approvalBuild, 'manifest.json');
    const library = path.join(approvalBuild, approvalFile);
    if (failure === 'missing-manifest') rmSync(manifestFile);
    else if (failure === 'missing-library') rmSync(library);
    else if (failure === 'json') writeFileSync(manifestFile, '{');
    else if (failure === 'null') writeFileSync(manifestFile, 'null');
    else if (failure === 'directory') { rmSync(library); mkdirSync(library); }
    else {
      const patches = { abi: { abiVersion: 2 }, platform: { platform: 'linux-arm64' }, file: { file: '../outside.so' },
        'sha-format': { sha256: 'not-a-hash' }, 'sha-mismatch': { sha256: '0'.repeat(64) }, extra: { other: true } };
      writeFileSync(manifestFile, JSON.stringify({ ...approvalManifest, ...patches[failure] }));
    }
    const target = path.join(directory, 'invalid.zip');
    const result = run(['linux-x64', target], directory, entry);
    assert.notEqual(result.status, 0);
    assert(!existsSync(target));
    if (failure.startsWith('missing')) assert.match(result.stderr, /build-approval-router/);
  });
}

for (const linked of ['manifest.json', 'qoder-approval-router.so', 'platform-directory']) {
  test(`审批扩展拒绝链接：${linked}`, t => {
    const directory = temporary(t);
    const { entry, approvalBuild } = fixture(directory, 'linux-x64');
    const source = linked === 'platform-directory' ? approvalBuild : path.join(approvalBuild, linked);
    const external = path.join(directory, 'external');
    if (linked === 'platform-directory') mkdirSync(external);
    else copyFileSync(source, external);
    rmSync(source, { recursive: true });
    try { symlinkSync(external, source, linked === 'platform-directory' ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`文件链接不可用：${error.code}`);
      throw error;
    }
    const target = path.join(directory, 'linked.zip');
    const result = run(['linux-x64', target], directory, entry);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /拒绝符号链接/);
    assert(!existsSync(target));
  });
}

for (const status of [0, 1]) {
  test(`构建脚本使用锁定 Cargo 参数并处理退出码 ${status}（模拟 Cargo，不编译 Rust）`, t => {
    const directory = temporary(t);
    const platform = `${process.platform}-${process.arch}`;
    const { source } = fixture(directory, platform);
    rmSync(path.join(source, '.approval-build'), { recursive: true });
    mkdirSync(path.join(source, 'native/approval-router'), { recursive: true });
    writeFileSync(path.join(source, 'native/approval-router/Cargo.toml'), '# synthetic manifest; never compiled');
    const mock = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      childProcess.spawnSync = (command, args) => {
        assert.equal(command, 'cargo');
        assert.deepEqual(args.slice(0, 4), ['build', '--locked', '--release', '--manifest-path']);
        assert.ok(args[4].endsWith(path.join('native', 'approval-router', 'Cargo.toml')));
        const target = args[args.indexOf('--target-dir') + 1];
        const triple = args[args.indexOf('--target') + 1];
        const name = process.platform === 'win32' ? 'qoder_approval_router.dll' : 'libqoder_approval_router.' + (process.platform === 'darwin' ? 'dylib' : 'so');
        mkdirSync(path.join(target, triple, 'release'), { recursive: true });
        writeFileSync(path.join(target, triple, 'release', name), 'synthetic cdylib');
        return { status: ${status} };
      };
      syncBuiltinESMExports();
    `;
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`,
      path.join(source, 'scripts/build-approval-router.mjs')], { cwd: directory, encoding: 'utf8' });
    const output = path.join(source, '.approval-build', platform, 'manifest.json');
    assert.equal(result.status, status, result.stderr);
    if (status) { assert.match(result.stderr, /Cargo 构建失败/); assert(!existsSync(output)); }
    else {
      const file = `qoder-approval-router.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`;
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { abiVersion: 1, platform, file,
        sha256: createHash('sha256').update('synthetic cdylib').digest('hex') });
      assert.equal(readFileSync(path.join(path.dirname(output), file), 'utf8'), 'synthetic cdylib');
    }
  });
}

test('构建脚本拒绝跨平台或无效参数，不调用 Cargo', t => {
  const directory = temporary(t);
  const entry = path.join(root, 'scripts/build-approval-router.mjs');
  const host = `${process.platform}-${process.arch}`;
  for (const args of [['invalid'], [platforms.find(value => value !== host)], [host, 'extra']]) {
    const result = run(args, directory, entry);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不支持|只允许/);
  }
});

test('缺失构建核心时失败并提示先运行 fetch-core，不留下 ZIP', t => {
  const directory = temporary(t);
  const { build, entry } = fixture(directory, 'linux-x64');
  rmSync(build);
  const target = path.join(directory, '缺核心.zip');
  const result = run(['linux-x64', target], directory, entry);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fetch-core/);
  assert(!existsSync(target));
});

test('构建核心 SHA256 与平台清单不一致时拒绝打包', t => {
  const directory = temporary(t);
  const { build, entry } = fixture(directory, 'darwin-arm64');
  writeFileSync(build, 'tampered core bytes');
  const target = path.join(directory, '坏核心.zip');
  const result = run(['darwin-arm64', target], directory, entry);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA256/);
  assert(!existsSync(target));
});

test('拒绝覆盖、坏参数、旧平台别名、缺失父目录及插件内输出', t => {
  const directory = temporary(t);
  const { source, entry } = fixture(directory, 'win32-x64');
  const existing = path.join(directory, '已有.zip');
  writeFileSync(existing, 'keep');
  for (const args of [[], ['win32-x64'], ['linux', 'bad.zip'], ['windows', 'bad.zip'], ['posix', 'bad.zip'],
    ['win32-x64', ''], ['win32-x64', 'bad.txt'], ['win32-x64', 'bad.zip', 'extra'], ['win32-x64', existing],
    ['darwin-x64', path.join(directory, 'missing', 'bad.zip')], ['win32-x64', path.join(source, '内部.zip')]]) {
    const result = run(args, directory, entry);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert(result.stderr.length > 0);
  }
  assert.equal(readFileSync(existing, 'utf8'), 'keep');
  assert(!existsSync(path.join(source, '内部.zip')));
  assert(!existsSync(path.join(directory, 'bad.zip')));
});

test('缺失源文件失败不留下 ZIP', t => {
  const directory = temporary(t);
  const { source, entry } = fixture(directory, 'linux-arm64');
  rmSync(path.join(source, 'server/bin/LICENSE'));
  const target = path.join(directory, '失败.zip');
  assert.notEqual(run(['linux-arm64', target], directory, entry).status, 0);
  assert(!existsSync(target));
});

test('拒绝源祖先链接、白名单目录链接和已有输出链接', t => {
  const directory = temporary(t);
  const { source, entry } = fixture(directory, 'win32-x64');
  const alias = path.join(directory, '别名');
  try {
    symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`环境不支持链接：${error.code}`);
    throw error;
  }
  const target = path.join(directory, '链接.zip');
  assert.notEqual(run(['win32-x64', target], directory, path.join(alias, 'scripts/package-plugin.mjs')).status, 0);
  assert(!existsSync(target));
  const bridge = path.join(source, 'server');
  const moved = path.join(directory, 'server');
  mkdirSync(moved);
  rmSync(bridge, { recursive: true });
  symlinkSync(moved, bridge, process.platform === 'win32' ? 'junction' : 'dir');
  // 外部目录补齐平台清单，让脚本走到祖先链接检查而不是提前 ENOENT。
  mkdirSync(path.join(moved, 'bin'), { recursive: true });
  copyFileSync(path.join(root, 'server/bin/platforms.json'), path.join(moved, 'bin', 'platforms.json'));
  writeFileSync(path.join(moved, 'crc32.mjs'), "throw new Error('unexpected external import')");
  const badSource = run(['win32-x64', target], directory, entry);
  assert.notEqual(badSource.status, 0);
  assert.match(badSource.stderr, /拒绝符号链接/);
  assert(!existsSync(target));
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(run(['win32-x64', target], directory, entry).status, 0);
  assert(lstatSync(target).isSymbolicLink());
});
