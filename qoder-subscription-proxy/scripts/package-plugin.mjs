import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

function assertNoLinks(filename) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接：${current}`);
    if (path.dirname(current) === current) break;
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function packagePlugin(platform, requested) {
  if (!['windows', 'posix'].includes(platform) || !requested?.trim() || !requested.toLowerCase().endsWith('.zip')) {
    throw new Error('用法：node package-plugin.mjs windows|posix <新.zip 路径>（父目录须存在）');
  }
  assertNoLinks(process.argv[1]);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assertNoLinks(root);
  const target = path.resolve(requested);
  const parent = path.dirname(target);
  assertNoLinks(parent);
  if (!lstatSync(parent).isDirectory()) throw new Error('目标父路径必须是目录');
  const relative = path.relative(realpathSync(root), path.join(realpathSync(parent), path.basename(target)));
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('输出不能位于源码插件内部');
  }
  try {
    lstatSync(target);
    throw new Error('目标已存在，拒绝覆盖');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const files = [
    '.qoder-plugin/plugin.json', '.mcp.json', '.mcp.posix.json',
    'README.md', 'LICENSE', 'DISCLAIMER.md', 'THIRD_PARTY_NOTICES.md', 'Antigravity授权.cmd',
    'bridge/bin/LICENSE', 'bridge/bin/README.md', 'bridge/bin/README_CN.md',
    'bridge/bin/config.example.yaml', 'bridge/bin/platforms.json',
    'bridge/panel/LICENSE', 'bridge/panel/management.upstream.html',
    ...['antigravity-login.ps1', 'image-preview.ps1', 'mcp-server.mjs', 'proxy-supervisor.ps1',
      'proxy-supervisor.mjs', 'ProxyJob.cs', 'start-mcp.ps1', 'start-mcp.sh',
      'prepare-posix-marketplace.sh'].map(name => `scripts/${name}`),
  ];
  assertNoLinks(path.join(root, 'bridge'));
  for (const name of readdirSync(path.join(root, 'bridge'))) {
    if (name.endsWith('.mjs')) files.push(`bridge/${name}`);
  }
  files.sort();
  if (files.length >= 0xffff) throw new Error('文件数超出 ZIP32 限制');
  const locals = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  for (const name of files) {
    const sourceName = name === '.mcp.json' && platform === 'posix' ? '.mcp.posix.json' : name;
    const source = path.join(root, sourceName);
    assertNoLinks(source);
    if (!lstatSync(source).isFile()) throw new Error(`不是常规文件：${source}`);
    const data = readFileSync(source);
    const compressed = deflateRawSync(data, { level: 9 });
    const encoded = Buffer.from(name, 'utf8');
    if (data.length >= 0xffffffff || compressed.length >= 0xffffffff || encoded.length > 0xffff) {
      throw new Error('文件超出 ZIP32 限制');
    }
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    // 固定 DOS 日期为 1980-01-01，不继承宿主时间与权限。
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    local.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(((name.endsWith('.sh') ? 0o100755 : 0o100644) * 65536) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, encoded, compressed);
    central.push(entry, encoded);
    offset += local.length + encoded.length + compressed.length;
    centralSize += entry.length + encoded.length;
    if (offset + centralSize >= 0xffffffff) throw new Error('产物超出 ZIP32 限制');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...locals, ...central, end]);
  let descriptor;
  let owned;
  try {
    descriptor = openSync(target, 'wx', 0o600);
    owned = fstatSync(descriptor);
    writeFileSync(descriptor, archive);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (owned) {
      try {
        const current = lstatSync(target);
        if (current.dev === owned.dev && current.ino === owned.ino && current.isFile()) unlinkSync(target);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], '打包及清理失败');
      }
    }
    throw error;
  }
  return target;
}

try {
  if (process.argv.length !== 4) throw new Error('用法：node package-plugin.mjs windows|posix <新.zip 路径>');
  console.log(`已生成插件 ZIP：${packagePlugin(process.argv[2], process.argv[3])}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
