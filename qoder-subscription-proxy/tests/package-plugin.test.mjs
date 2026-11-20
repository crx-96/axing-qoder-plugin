import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const expected = readFileSync(path.join(root, 'scripts/distribution-files.txt'), 'utf8').trimEnd().split(/\r?\n/).sort();
const manifest = JSON.parse(readFileSync(path.join(root, 'server/bin/platforms.json'), 'utf8'));

function fixture(t) {
  const directory = mkdtempSync(path.join(path.resolve(root, '..'), '.插件 打包测试 '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, '源码 插件');
  for (const name of [...expected, 'scripts/package-plugin.mjs']) {
    const destination = path.join(source, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, name), destination);
  }
  const entry = path.join(source, 'scripts/package-plugin.mjs');
  const target = path.join(directory, '轻量 安装包.zip');
  function run(args = [target], script = entry) {
    return spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
  }
  return { directory, source, target, run };
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
    assert.equal(zip.readUInt16LE(cursor + 4), 0x0314);
    assert.equal(zip.readUInt16LE(cursor + 8), 0x800);
    assert.equal(zip.readUInt16LE(cursor + 10), 8);
    assert.equal(zip.readUInt16LE(cursor + 12), 0);
    assert.equal(zip.readUInt16LE(cursor + 14), 33);
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
    const compressed = zip.subarray(dataStart, localEnd);
    const content = inflateRawSync(compressed);
    assert.equal(content.length, size);
    assert.equal(checksum(content), crc, name);
    assert.deepEqual(compressed, deflateRawSync(content, { level: 9 }), name);
    assert.equal(zip.readUInt32LE(cursor + 38) >>> 16, name.endsWith('.sh') ? 0o100755 : 0o100644, name);
    result.set(name, content);
    cursor += 46 + nameLength + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, end);
  assert.equal(localEnd, start);
  return result;
}

function assertLocalImports(entries) {
  for (const [name, bytes] of entries) {
    if (!/\.(?:mjs|js)$/.test(name)) continue;
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      assert.ok(entries.has(path.posix.join(path.posix.dirname(name), match[1])), name + ': ' + match[1]);
    }
  }
}

test('从无核心的源码打包，已有五平台核心、构建脚本、账号或缓存也不改变 ZIP 字节', t => {
  const { directory, source, target, run } = fixture(t);
  const first = run([path.basename(target)]);
  assert.equal(first.status, 0, first.stderr);
  assert(lstatSync(target).size < 20_000_000);
  const entries = unpack(target);
  assert.deepEqual([...entries.keys()], expected);
  for (const [name, data] of entries) assert.deepEqual(data, readFileSync(path.join(source, name)), name);
  const plugin = JSON.parse(entries.get('.qoder-plugin/plugin.json'));
  assert.equal(plugin.commands, undefined);
  assert.deepEqual([...entries.keys()].filter(name => name.startsWith('server/bin/')).sort(),
    ['server/bin/LICENSE', 'server/bin/README.md', 'server/bin/README_CN.md', 'server/bin/legacy-releases.json', 'server/bin/platforms.json']);
  for (const required of ['assets/logo.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'server/magpie-third-party-notices.txt',
    'scripts/start-mcp.ps1', 'scripts/proxy-supervisor.ps1', 'scripts/ProxyJob.cs', 'scripts/proxy-supervisor.mjs']) {
    assert.ok(entries.has(required), required);
  }
  const config = JSON.parse(entries.get(plugin.mcpServers.replace(/^\.\//, ''))).mcpServers['qoder-subscription-proxy'];
  assert.equal(config.command, '${QODER_NODE_RUNTIME}');
  assert.deepEqual(config.args, ['${QODER_PLUGIN_ROOT}/scripts/start-mcp.mjs']);
  assert(entries.has('scripts/start-mcp.mjs'));
  assert.equal(config.timeout, 660000);
  assertLocalImports(entries);

  const excluded = ['mcp.posix.json', 'tests/private.test.mjs', 'server/data/token.json', 'server/bin/core.exe',
    'server/bin/core.tar.gz', 'server/panel/secret.json', 'server/debug.log', '.env',
    'auths/account.json', '.cache/archive.zip', 'node_modules/private/index.js', 'scripts/prepare-test-core.mjs',
    'scripts/fetch-core.mjs', 'scripts/unknown.mjs', 'server/local-debug-only.mjs', 'commands/private.md',
    'native/approval-router/src/lib.rs', '.approval-build/linux-x64/manifest.json', 'server/approval-router/obsolete.so'];
  for (const [platform, release] of Object.entries(manifest.platforms)) {
    excluded.push(`server/bin/${release.path}`, `.core-build/${platform}/${path.posix.basename(release.path)}`, release.archive);
  }
  for (const name of excluded) {
    assert(!entries.has(name), name);
    const filename = path.join(source, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, 'must not be packaged');
  }
  const second = path.join(directory, '再次打包.zip');
  const again = run([second]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(readFileSync(target), readFileSync(second));
});

test('导入闭包检查覆盖静态、再导出、无绑定和动态导入', () => {
  for (const source of ["import { value } from './missing.mjs';", "export { value } from './missing.mjs';",
    "import './missing.mjs';", "await import('./missing.mjs');"]) {
    assert.throws(() => assertLocalImports(new Map([['server/main.mjs', Buffer.from(source)]])), /missing\.mjs/);
    assert.doesNotThrow(() => assertLocalImports(new Map([
      ['server/main.mjs', Buffer.from(source)], ['server/missing.mjs', Buffer.from('export const value = 1;')],
    ])));
  }
});

test('19,999,999 字节可打包，完整 ZIP 恰为 20,000,000 时排他输出前失败', t => {
  const { directory, source, target, run } = fixture(t);
  const asset = path.join(source, 'assets/logo.png');
  const readme = path.join(source, 'README.md');
  writeFileSync(asset, Buffer.alloc(0));
  writeFileSync(readme, '');
  const base = path.join(directory, 'baseline.zip');
  const baseline = run([base]);
  assert.equal(baseline.status, 0, baseline.stderr);
  const overhead = lstatSync(base).size - deflateRawSync(Buffer.alloc(0), { level: 9 }).length;
  const bytes = randomBytes(20_000_000);
  let length = 19_999_999 - overhead;
  for (let i = 0; i < 8; i++) {
    const size = overhead + deflateRawSync(bytes.subarray(0, length), { level: 9 }).length;
    if (size === 19_999_999) break;
    length += 19_999_999 - size;
  }
  writeFileSync(asset, bytes.subarray(0, length));
  const below = path.join(directory, 'below.zip');
  const accepted = run([below]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(lstatSync(below).size, 19_999_999);
  // DEFLATE 编码单字节比空成员多一字节，其他记录长度均保持不变。
  writeFileSync(readme, 'x');
  const rejected = run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /小于 20000000 字节/);
  assert(!existsSync(target));
});

test('拒绝覆盖、旧平台参数、缺失父目录及插件内输出', t => {
  const { directory, source, target, run } = fixture(t);
  writeFileSync(target, 'keep');
  for (const args of [[], [''], ['bad.txt'], ['windows', 'bad.zip'], ['win32-x64', 'bad.zip'],
    [target], [path.join(directory, 'missing', 'bad.zip')], [path.join(source, '内部.zip')]]) {
    const result = run(args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert(result.stderr.length > 0);
  }
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert(!existsSync(path.join(source, '内部.zip')));
  assert(!existsSync(path.join(directory, 'bad.zip')));
});

test('重复、越界或缺失的白名单文件不产生 ZIP', t => {
  const { source, target, run } = fixture(t);
  const file = path.join(source, 'scripts/distribution-files.txt');
  const original = readFileSync(file, 'utf8');
  for (const invalid of ['mcp.json', '../outside', '/outside', 'server\\outside', 'C:/outside', 'server//outside', 'server/./outside']) {
    writeFileSync(file, `${original.trimEnd()}\n${invalid}\n`);
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /重复路径|相对路径/);
    assert(!existsSync(target));
  }
  writeFileSync(file, original);
  rmSync(path.join(source, 'server/bin/LICENSE'));
  assert.notEqual(run().status, 0);
  assert(!existsSync(target));
});

test('拒绝源祖先、构建模块及输出的链接', t => {
  const { directory, source, target, run } = fixture(t);
  const alias = path.join(directory, '别名');
  const dirType = process.platform === 'win32' ? 'junction' : 'dir';
  try { symlinkSync(source, alias, dirType); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`环境不支持链接：${error.code}`);
    throw error;
  }
  assert.notEqual(run([target], path.join(alias, 'scripts/package-plugin.mjs')).status, 0);
  assert(!existsSync(target));
  const moved = path.join(directory, 'external');
  mkdirSync(moved);
  writeFileSync(path.join(moved, 'crc32.mjs'), "throw new Error('unexpected external import')");
  rmSync(path.join(source, 'server'), { recursive: true });
  symlinkSync(moved, path.join(source, 'server'), dirType);
  const rejected = run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /拒绝符号链接/);
  assert(!existsSync(target));
  symlinkSync(source, target, dirType);
  assert.notEqual(run().status, 0);
  assert(lstatSync(target).isSymbolicLink());
});
