import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

/** 与 server/bin/platforms.json 一致的五种平台键；每个 ZIP 只内置对应平台的核心。 */
const PLATFORMS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];

/** 从文件到根目录逐层拒绝符号链接，防止产物读写越过指定路径。 */
function assertNoLinks(filename) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接：${current}`);
    if (path.dirname(current) === current) break;
  }
}

/** 按源码白名单生成指定平台的安装 ZIP，并内置该平台已校验的核心二进制。仅向已存在的目录发布全新的文件。 */
async function packagePlugin(platform, requested) {
  if (!PLATFORMS.includes(platform) || !requested?.trim() || !requested.toLowerCase().endsWith('.zip')) {
    throw new Error(`用法：node package-plugin.mjs ${PLATFORMS.join('|')} <新.zip 路径>（父目录须存在）`);
  }
  // 校验入口、源目录与目标父目录，拒绝安装包覆盖插件源码或既有文件。
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
  // 两种入口共享发布清单。Windows 用默认 mcp.json，其余平台使用 mcp.posix.json 的内容。
  const manifest = path.join(root, 'scripts/distribution-files.txt');
  assertNoLinks(manifest);
  if (!lstatSync(manifest).isFile()) throw new Error('分发清单必须是常规文件');
  // 核心元数据只读固定清单；构建产物必须先由 fetch-core.mjs 下载并通过 SHA256 校验。
  const platformsFile = path.join(root, 'server/bin/platforms.json');
  assertNoLinks(platformsFile);
  const release = JSON.parse(readFileSync(platformsFile, 'utf8')).platforms[platform];
  if (!release || typeof release.path !== 'string' || !/^[a-f0-9]{64}$/.test(release.binarySha256)) {
    throw new Error(`平台清单缺少 ${platform} 的有效条目`);
  }
  const coreEntry = `server/bin/${release.path}`;
  const coreSource = path.join(root, '.core-build', platform, path.posix.basename(release.path));
  let coreStat;
  try { coreStat = lstatSync(coreSource); } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少 ${platform} 构建核心，请先运行 node scripts/fetch-core.mjs ${platform}`);
    throw error;
  }
  assertNoLinks(coreSource);
  if (!coreStat.isFile()) throw new Error(`不是常规文件：${coreSource}`);
  const coreData = readFileSync(coreSource);
  if (createHash('sha256').update(coreData).digest('hex') !== release.binarySha256) {
    throw new Error(`${platform} 构建核心 SHA256 与平台清单不一致，拒绝打包`);
  }
  // 校验构建期模块路径后复用原生扩展校验；扩展源码不进入静态分发清单。
  assertNoLinks(path.join(root, 'scripts/build-approval-router.mjs'));
  const { readApprovalArtifact } = await import('./build-approval-router.mjs');
  const approvalEntries = readApprovalArtifact(root, platform);
  const files = ['mcp.json', ...readFileSync(manifest, 'utf8').trimEnd().split(/\r?\n/), coreEntry, ...approvalEntries.keys()];
  if (new Set(files).size !== files.length) throw new Error('分发清单包含重复路径');
  for (const name of files) {
    if (/[\\:\r\n]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('分发清单仅允许插件内相对路径');
    }
  }
  // 先验证共享 CRC 源文件与父目录，禁止通过符号链接导入构建时运行的代码。
  assertNoLinks(path.join(root, 'server/crc32.mjs'));
  const { crc32 } = await import('../server/crc32.mjs');
  files.sort();
  if (files.length >= 0xffff) throw new Error('文件数超出 ZIP32 限制');
  // 按稳定顺序写局部记录和中央目录，记录压缩尺寸、校验和与 POSIX 执行位。
  const locals = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;
  for (const name of files) {
    // 核心和扩展使用已校验快照；其余按白名单读源码，POSIX 替换 MCP 入口。
    let data = approvalEntries.get(name);
    if (!data) {
      const source = name === coreEntry ? coreSource
        : path.join(root, name === 'mcp.json' && platform !== 'win32-x64' ? 'mcp.posix.json' : name);
      assertNoLinks(source);
      if (!lstatSync(source).isFile()) throw new Error(`不是常规文件：${source}`);
      data = name === coreEntry ? coreData : readFileSync(source);
    }
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
    // POSIX 核心与 shell 脚本需要执行位；Windows 核心及普通文件保持 0644。
    const executable = name.endsWith('.sh') || (name === coreEntry && platform !== 'win32-x64');
    entry.writeUInt32LE(((executable ? 0o100755 : 0o100644) * 65536) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, encoded, compressed);
    central.push(entry, encoded);
    offset += local.length + encoded.length + compressed.length;
    centralSize += entry.length + encoded.length;
    if (offset + centralSize >= 0xffffffff) throw new Error('产物超出 ZIP32 限制');
  }
  // 所有源文件及 ZIP32 边界均已核对，最后写入结束记录并排他创建目标。
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
    // 失败时只清理本次排他创建且仍指向同一文件的目标。
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
  if (process.argv.length !== 4) throw new Error(`用法：node package-plugin.mjs ${PLATFORMS.join('|')} <新.zip 路径>`);
  console.log(`已生成插件 ZIP：${await packagePlugin(process.argv[2], process.argv[3])}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
