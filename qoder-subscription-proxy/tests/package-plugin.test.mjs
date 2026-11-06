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
  for (const name of [...expected, 'scripts/package-plugin.mjs']) {
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
  return { source, coreEntry, fake, build, entry: path.join(source, 'scripts/package-plugin.mjs') };
}

for (const platform of platforms) {
  test(`${platform}: 根清单、真实内容、CRC、仅内置本平台核心及可重复产物`, t => {
    const directory = temporary(t);
    const { source, coreEntry, fake, entry } = fixture(directory, platform);
    const target = path.join(directory, '产物 有空格.zip');
    const result = run([platform, path.basename(target)], directory, entry);
    assert.equal(result.status, 0, result.stderr);
    const entries = unpack(target, platform, coreEntry);
    assert.deepEqual([...entries.keys()], [...expected, coreEntry].sort());
    for (const [name, data] of entries) {
      if (name === coreEntry) {
        assert.deepEqual(data, fake, name);
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
  const { source, coreEntry, entry } = fixture(directory, 'win32-x64');
  for (const name of ['tests/private.test.mjs', 'server/data/token.json', 'server/bin/core.exe',
    'server/bin/core.tar.gz', 'server/panel/secret.json', 'server/debug.log', '.env',
    'scripts/prepare-test-core.mjs', 'scripts/fetch-core.mjs', 'scripts/unknown.mjs',
    'server/local-debug-only.mjs', 'commands/private.md', '.core-build/linux-x64/qoder-plugin-subscription-proxy']) {
    const filename = path.join(source, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, 'must not be packaged');
  }
  const target = path.join(directory, '白名单.zip');
  const result = run(['win32-x64', target], directory, entry);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([...unpack(target, 'win32-x64', coreEntry).keys()], [...expected, coreEntry].sort());
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
