import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

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
    const executable = name.endsWith('.sh') || (name === coreEntry && platform !== 'win32-x64');
    assert.equal(zip.readUInt32LE(cursor + 38) >>> 16, executable ? 0o100755 : 0o100644, name);
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
    // 覆盖静态导入、再导出、无绑定导入和字面量动态导入；不执行模块或启动核心。
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      assert.ok(entries.has(path.posix.join(path.posix.dirname(name), match[1])), name + ': ' + match[1]);
    }
  }
}

// 源码夹具附带合成构建核心，并把平台清单摘要改为合成值；测试不依赖真实下载产物。
function fixture(directory, platform, fake = Buffer.from(`fake core for ${platform}; never executed\n`.repeat(64))) {
  const source = path.join(directory, '源码 插件');
  for (const name of [...expected, 'scripts/package-plugin.mjs']) {
    const destination = path.join(source, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(root, name), destination);
  }
  const release = manifest.platforms[platform];
  const coreEntry = `server/bin/${release.path}`;
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
    for (const other of platforms.filter(value => value !== platform)) {
      for (const name of [`server/bin/${manifest.platforms[other].path}`,
        `.core-build/${other}/${path.posix.basename(manifest.platforms[other].path)}`]) {
        const filename = path.join(source, name);
        mkdirSync(path.dirname(filename), { recursive: true });
        writeFileSync(filename, `other platform: ${other}; must not be packaged`);
      }
    }
    const target = path.join(directory, '产物 有空格.zip');
    const result = run([platform, path.basename(target)], directory, entry);
    assert.equal(result.status, 0, result.stderr);
    const entries = unpack(target, platform, coreEntry);
    assert.deepEqual([...entries.keys()], [...expected, coreEntry].sort());
    assert.deepEqual(platforms.filter(value => entries.has(`server/bin/${manifest.platforms[value].path}`)), [platform]);
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
    assertLocalImports(entries);
    const config = JSON.parse(entries.get('mcp.json')).mcpServers['qoder-subscription-proxy'];
    assert.equal(config.command, platform === 'win32-x64' ? 'powershell.exe' : '/bin/sh');
    assert(config.args.some(arg => arg.endsWith(platform === 'win32-x64' ? '/scripts/start-mcp.ps1' : '/scripts/start-mcp.sh')));
    const again = path.join(directory, '再次.zip');
    const repeated = run([platform, again], directory, entry);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(readFileSync(target), readFileSync(again));
  });
}

test('导入闭包检查覆盖静态、再导出、无绑定和动态导入', () => {
  for (const source of ["import { value } from './missing.mjs';", "export { value } from './missing.mjs';",
    "import './missing.mjs';", "await import('./missing.mjs');"]) {
    assert.throws(() => assertLocalImports(new Map([['server/main.mjs', Buffer.from(source)]])), /missing\.mjs/);
    assert.doesNotThrow(() => assertLocalImports(new Map([
      ['server/main.mjs', Buffer.from(source)], ['server/missing.mjs', Buffer.from('export const value = 1;')],
    ])));
  }
});

test('白名单排除测试、账号、缓存、日志、其他平台核心、native 和未知脚本', t => {
  const directory = temporary(t);
  const { source, coreEntry, entry } = fixture(directory, 'win32-x64');
  const excluded = ['tests/private.test.mjs', 'server/data/token.json', 'server/bin/core.exe',
    'server/bin/core.tar.gz', 'server/panel/secret.json', 'server/debug.log', '.env',
    'auths/account.json', 'accounts/token.json', '.cache/archive.zip', 'node_modules/private/index.js',
    'scripts/prepare-test-core.mjs', 'scripts/fetch-core.mjs', 'scripts/unknown.mjs',
    'server/local-debug-only.mjs', 'commands/private.md', 'native/approval-router/src/lib.rs',
    '.approval-build/linux-x64/manifest.json', 'server/approval-router/obsolete.so',
    'server/approval-plugin.mjs', 'server/approval-config.mjs', 'server/approval-rules.mjs', 'server/bin/config.example.yaml',
    'server/bin/qoder-plugin-subscription-proxy.exe'];
  for (const name of excluded) {
    const filename = path.join(source, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, 'must not be packaged');
  }
  const target = path.join(directory, '白名单.zip');
  const result = run(['win32-x64', target], directory, entry);
  assert.equal(result.status, 0, result.stderr);
  const entries = unpack(target, 'win32-x64', coreEntry);
  assert.deepEqual([...entries.keys()], [...expected, coreEntry].sort());
  for (const name of excluded) assert(!entries.has(name), name);
  assert(![...entries.keys()].some(name => /^(?:native|\.approval-build|\.core-build|server\/approval-router)\//.test(name)));
});

test('超过 8 MiB 的源码、核心与压缩 ZIP 均能正常打包并复现', t => {
  const directory = temporary(t);
  const { source, coreEntry, fake, entry } = fixture(directory, 'linux-x64', randomBytes(9 * 1024 * 1024));
  const sourceBytes = Buffer.alloc(9 * 1024 * 1024, 's');
  writeFileSync(path.join(source, 'README.md'), sourceBytes);
  const target = path.join(directory, '大核心.zip');
  const result = run(['linux-x64', target], directory, entry);
  assert.equal(result.status, 0, result.stderr);
  assert(lstatSync(target).size > 8 * 1024 * 1024);
  const entries = unpack(target, 'linux-x64', coreEntry);
  assert.deepEqual(entries.get(coreEntry), fake);
  assert.deepEqual(entries.get('README.md'), sourceBytes);
  const again = path.join(directory, '大核心再次.zip');
  const repeated = run(['linux-x64', again], directory, entry);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(readFileSync(target), readFileSync(again));
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

test('构建核心不是常规文件时拒绝打包', t => {
  const directory = temporary(t);
  const { build, entry } = fixture(directory, 'linux-arm64');
  rmSync(build);
  mkdirSync(build);
  const target = path.join(directory, '核心目录.zip');
  const result = run(['linux-arm64', target], directory, entry);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不是常规文件/);
  assert(!existsSync(target));
});

for (const invalid of [null, {}, { path: '../outside' }, { path: '/outside' }, { path: 'C:/outside' },
  { path: 'linux-x64\\outside' }, { path: 'linux-x64//outside' }, { path: 'linux-x64/./outside' },
  { path: 'linux-x64/out\u0000side' }, { binarySha256: 'not-a-hash' }, { archiveSha256: '' }]) {
  test(`拒绝无效平台清单：${JSON.stringify(invalid)}`, t => {
    const directory = temporary(t);
    const { source, entry } = fixture(directory, 'linux-x64');
    const file = path.join(source, 'server/bin/platforms.json');
    const metadata = JSON.parse(readFileSync(file, 'utf8'));
    if (invalid === null || Object.keys(invalid).length === 0) metadata.platforms['linux-x64'] = invalid;
    else Object.assign(metadata.platforms['linux-x64'], invalid);
    writeFileSync(file, JSON.stringify(metadata));
    const target = path.join(directory, '坏清单.zip');
    const result = run(['linux-x64', target], directory, entry);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /平台清单/);
    assert(!existsSync(target));
  });
}

for (const linked of ['binary', 'platform-directory', 'build-directory', 'crc-module']) {
  test(`拒绝核心或构建期模块链接：${linked}`, t => {
    const directory = temporary(t);
    const { source, build, entry } = fixture(directory, 'linux-x64');
    const isDirectory = linked.endsWith('directory');
    const targetPath = linked === 'binary' ? build : linked === 'platform-directory' ? path.dirname(build)
      : linked === 'build-directory' ? path.join(source, '.core-build') : path.join(source, 'server/crc32.mjs');
    const external = path.join(directory, 'external');
    if (isDirectory) {
      mkdirSync(external);
      const copied = path.join(external, path.relative(targetPath, build));
      mkdirSync(path.dirname(copied), { recursive: true });
      copyFileSync(build, copied);
    } else copyFileSync(targetPath, external);
    rmSync(targetPath, { recursive: true });
    try { symlinkSync(external, targetPath, isDirectory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`链接不可用：${error.code}`);
      throw error;
    }
    const target = path.join(directory, '链接核心.zip');
    const result = run(['linux-x64', target], directory, entry);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /拒绝符号链接/);
    assert(!existsSync(target));
  });
}

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

test('分发清单拒绝重复路径及越界路径，不留下 ZIP', t => {
  const directory = temporary(t);
  const { source, entry } = fixture(directory, 'win32-x64');
  const file = path.join(source, 'scripts/distribution-files.txt');
  const original = readFileSync(file, 'utf8');
  const target = path.join(directory, '非法白名单.zip');
  for (const invalid of ['mcp.json', '../outside', '/outside', 'server\\outside', 'C:/outside', 'server//outside', 'server/./outside']) {
    writeFileSync(file, `${original.trimEnd()}\n${invalid}\n`);
    const result = run(['win32-x64', target], directory, entry);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /重复路径|相对路径/);
    assert(!existsSync(target));
  }
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
