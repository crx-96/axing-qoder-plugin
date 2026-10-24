import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'scripts/package-plugin.mjs');
const scripts = ['ProxyJob.cs', 'antigravity-login.ps1', 'image-preview.ps1', 'mcp-server.mjs',
  'prepare-posix-marketplace.sh', 'proxy-supervisor.mjs', 'proxy-supervisor.ps1', 'start-mcp.ps1', 'start-mcp.sh'];
const expected = ['.qoder-plugin/plugin.json', '.mcp.json', '.mcp.posix.json', 'README.md', 'LICENSE',
  'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md', 'Antigravity授权.cmd', 'bridge/bin/LICENSE',
  'bridge/bin/README.md', 'bridge/bin/README_CN.md', 'bridge/bin/config.example.yaml',
  'bridge/bin/platforms.json', 'bridge/panel/LICENSE', 'bridge/panel/management.upstream.html',
  ...scripts.map(name => `scripts/${name}`),
  ...readdirSync(path.join(root, 'bridge')).filter(name => name.endsWith('.mjs')).map(name => `bridge/${name}`)].sort();

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

function unpack(filename) {
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
    assert.equal(zip.readUInt32LE(cursor + 38) >>> 16, name.endsWith('.sh') ? 0o100755 : 0o100644);
    result.set(name, content);
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(localEnd, start);
  return result;
}

function fixture(directory) {
  const source = path.join(directory, '源码 插件');
  for (const name of [...expected, 'scripts/package-plugin.mjs']) {
    const destination = path.join(source, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, name), destination);
  }
  return source;
}

for (const platform of ['windows', 'posix']) {
  test(`${platform}: 根清单、真实内容、CRC、UTF-8 路径及可重复产物`, t => {
    const directory = temporary(t);
    const target = path.join(directory, '产物 有空格.zip');
    const result = run([platform, platform === 'windows' ? target : path.basename(target)], directory);
    assert.equal(result.status, 0, result.stderr);
    const entries = unpack(target);
    assert.deepEqual([...entries.keys()], expected);
    for (const [name, data] of entries) {
      const source = name === '.mcp.json' && platform === 'posix' ? '.mcp.posix.json' : name;
      assert.deepEqual(data, readFileSync(path.join(root, source)), name);
    }
    const config = JSON.parse(entries.get('.mcp.json')).mcpServers['qoder-subscription-proxy'];
    assert.equal(config.command, platform === 'posix' ? '/bin/sh' : 'powershell.exe');
    assert(config.args.some(arg => arg.endsWith(platform === 'posix' ? '/scripts/start-mcp.sh' : '/scripts/start-mcp.ps1')));
    const again = path.join(directory, '再次.zip');
    assert.equal(run([platform, again], directory).status, 0);
    assert.deepEqual(readFileSync(target), readFileSync(again));
  });
}

test('白名单排除测试、数据、凭据、日志、核心及未知脚本', t => {
  const directory = temporary(t);
  const source = fixture(directory);
  for (const name of ['tests/private.test.mjs', 'bridge/data/token.json', 'bridge/bin/core.exe',
    'bridge/bin/core.tar.gz', 'bridge/panel/secret.json', 'bridge/debug.log', '.env',
    'scripts/prepare-test-core.mjs', 'scripts/unknown.mjs']) {
    const filename = path.join(source, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, 'must not be packaged');
  }
  const target = path.join(directory, '白名单.zip');
  const result = run(['windows', target], directory, path.join(source, 'scripts/package-plugin.mjs'));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([...unpack(target).keys()], expected);
});

test('拒绝覆盖、坏参数、缺失父目录及插件内输出', t => {
  const directory = temporary(t);
  const source = fixture(directory);
  const entry = path.join(source, 'scripts/package-plugin.mjs');
  const existing = path.join(directory, '已有.zip');
  writeFileSync(existing, 'keep');
  for (const args of [[], ['windows'], ['linux', 'bad.zip'], ['windows', ''],
    ['windows', 'bad.txt'], ['windows', 'bad.zip', 'extra'], ['windows', existing],
    ['posix', path.join(directory, 'missing', 'bad.zip')], ['windows', path.join(source, '内部.zip')]]) {
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
  const source = fixture(directory);
  rmSync(path.join(source, 'bridge/bin/LICENSE'));
  const target = path.join(directory, '失败.zip');
  assert.notEqual(run(['posix', target], directory, path.join(source, 'scripts/package-plugin.mjs')).status, 0);
  assert(!existsSync(target));
});

test('拒绝源祖先链接、白名单目录链接和已有输出链接', t => {
  const directory = temporary(t);
  const source = fixture(directory);
  const alias = path.join(directory, '别名');
  try {
    symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`环境不支持链接：${error.code}`);
    throw error;
  }
  const target = path.join(directory, '链接.zip');
  assert.notEqual(run(['windows', target], directory, path.join(alias, 'scripts/package-plugin.mjs')).status, 0);
  assert(!existsSync(target));
  const bridge = path.join(source, 'bridge');
  const moved = path.join(directory, 'bridge');
  mkdirSync(moved);
  rmSync(bridge, { recursive: true });
  symlinkSync(moved, bridge, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(run(['windows', target], directory, path.join(source, 'scripts/package-plugin.mjs')).status, 0);
  assert(!existsSync(target));
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(run(['windows', target], directory).status, 0);
  assert(lstatSync(target).isSymbolicLink());
});
