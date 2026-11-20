import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

/** 安装 ZIP 的排他字节上限，包含全部成员、目录和结束记录。 */
const ZIP_SIZE_LIMIT = 20_000_000;
/** ZIP32 无注释的结束记录长度，用于精确计算实际产物大小。 */
const END_RECORD_SIZE = 22;

/** 从文件到根目录逐层拒绝符号链接，防止产物读写越过指定路径。 */
function assertNoLinks(filename) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接：${current}`);
    if (path.dirname(current) === current) break;
  }
}

/** ZIP 成员必须是插件内的 POSIX 相对文件路径，不能包含空段、盘符、控制字符或目录穿越。 */
function isPackagePath(name) {
  return typeof name === 'string' && !/[\\:\x00-\x1f\x7f]/.test(name)
    && !name.split('/').some(part => !part || part === '.' || part === '..');
}

/** 离线从分发清单生成通用 ZIP，仅向已存在的目录发布全新的文件。 */
async function packagePlugin(requested) {
  if (process.argv.length !== 3 || !requested?.trim() || !requested.toLowerCase().endsWith('.zip')) {
    throw new Error('用法：node package-plugin.mjs <新.zip 路径>（父目录须存在）');
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
  // ZIP 与独立市场使用相同的白名单，源码中的通用 mcp.json 原样进入包根。
  const manifest = path.join(root, 'scripts/distribution-files.txt');
  assertNoLinks(manifest);
  if (!lstatSync(manifest).isFile()) throw new Error('分发清单必须是常规文件');
  const files = readFileSync(manifest, 'utf8').trimEnd().split(/\r?\n/);
  if (new Set(files).size !== files.length) throw new Error('分发清单包含重复路径');
  for (const name of files) {
    if (!isPackagePath(name)) {
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
    const source = path.join(root, name);
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
    // 保留 shell 脚本的执行位，其余成员由宿主或解释器读取。
    const executable = name.endsWith('.sh');
    entry.writeUInt32LE(((executable ? 0o100755 : 0o100644) * 65536) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, encoded, compressed);
    central.push(entry, encoded);
    offset += local.length + encoded.length + compressed.length;
    centralSize += entry.length + encoded.length;
    // 同时计入尚未写出的中央目录和结束记录，在创建任何输出前拒绝等于或超限的成品。
    if (offset + centralSize + END_RECORD_SIZE >= ZIP_SIZE_LIMIT) {
      throw new Error(`插件 ZIP 必须小于 ${ZIP_SIZE_LIMIT} 字节`);
    }
  }
  // 产物大小已经校验，最后写入结束记录并排他创建目标。
  const end = Buffer.alloc(END_RECORD_SIZE);
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
  console.log(`已生成通用插件 ZIP：${await packagePlugin(process.argv[2])}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
