import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 支持的原生平台；构建入口不允许伪装成跨平台编译。 */
const PLATFORMS = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];

/** 检查文件及祖先均不是链接，避免从外部路径读取或覆盖产物。 */
export function assertNoLinks(filename) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`拒绝符号链接：${current}`);
    if (path.dirname(current) === current) break;
  }
}

/** 返回固定安装文件名，不接受 manifest 自定义路径。 */
function libraryName(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error(`不支持的审批路由平台：${platform}`);
  return `qoder-approval-router.${platform.startsWith('win32-') ? 'dll' : platform.startsWith('darwin-') ? 'dylib' : 'so'}`;
}

/** 读取并校验构建快照；返回安装路径到已校验字节的映射，供 ZIP 和独立市场共用。 */
export function readApprovalArtifact(root, platform) {
  /** 仅由平台决定的库文件名与构建缓存目录。 */
  const file = libraryName(platform);
  const directory = path.join(root, '.approval-build', platform);
  /** 同次读取的 manifest 与库字节；后续直接发布，避免校验后重新读取。 */
  const entries = new Map();
  for (const name of ['manifest.json', file]) {
    const source = path.join(directory, name);
    try {
      assertNoLinks(directory);
      assertNoLinks(source);
      if (!lstatSync(source).isFile()) throw new Error(`审批路由产物不是常规文件：${source}`);
      entries.set(`server/approval-router/${name}`, readFileSync(source));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`缺少 ${platform} 审批路由产物，请先运行 node scripts/build-approval-router.mjs ${platform}`);
      throw error;
    }
  }
  /** ABI 版本为 1，平台与文件名必须精确匹配；不允许额外字段或缺失字段。 */
  const manifest = JSON.parse(entries.get('server/approval-router/manifest.json').toString('utf8'));
  if (!manifest || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(',') !== 'abiVersion,file,platform,sha256' ||
      manifest.abiVersion !== 1 || manifest.platform !== platform || manifest.file !== file ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error('审批路由 manifest 的 ABI、平台、文件名或 SHA256 格式错误');
  }
  if (createHash('sha256').update(entries.get(`server/approval-router/${file}`)).digest('hex') !== manifest.sha256) {
    throw new Error('审批路由库 SHA256 与 manifest 不一致');
  }
  return entries;
}

/** 用宿主 Cargo 构建锁定依赖的 cdylib，并输出平台独立的库与 ABI manifest。 */
function main() {
  /** 默认平台来自 Node 宿主；显式参数只用于验证调用方与 runner 一致。 */
  const host = `${process.platform}-${process.arch}`;
  const platform = process.argv[2] ?? host;
  const file = libraryName(platform);
  if (process.argv.length > 3 || platform !== host) throw new Error(`只允许构建当前宿主平台 ${host}，不支持跨编译`);
  /** 所有输出位于源码插件缓存，不修改官方核心或用户全局 Rust 配置。 */
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = path.join(root, 'native/approval-router/Cargo.toml');
  const target = path.join(root, '.approval-build', 'cargo-target', platform);
  const directory = path.join(root, '.approval-build', platform);
  assertNoLinks(manifestPath);
  // 逐层创建并校验输出目录；绝不沿既有目录链接写入。
  for (const relative of ['.approval-build', '.approval-build/cargo-target', `.approval-build/cargo-target/${platform}`, `.approval-build/${platform}`]) {
    const output = path.join(root, relative);
    mkdirSync(output, { recursive: true });
    assertNoLinks(output);
  }
  /** 显式 target 目录与宿主 triple，避免继承 CARGO_BUILD_TARGET 导致伪跨编译。 */
  const triples = { 'win32-x64': 'x86_64-pc-windows-msvc', 'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu' };
  const result = spawnSync('cargo', ['build', '--locked', '--release', '--manifest-path', manifestPath,
    '--target', triples[platform], '--target-dir', target], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cargo 构建失败：${result.signal || result.status}`);
  /** Cargo 使用下划线和平台前缀；安装包统一为连字符文件名。 */
  const cargoName = platform.startsWith('win32-') ? 'qoder_approval_router.dll'
    : `libqoder_approval_router.${platform.startsWith('darwin-') ? 'dylib' : 'so'}`;
  const source = path.join(target, triples[platform], 'release', cargoName);
  assertNoLinks(source);
  if (!lstatSync(source).isFile()) throw new Error('Cargo 动态库不是常规文件');
  const bytes = readFileSync(source);
  // 已存在的缓存也必须是普通文件，不跟随符号链接覆写。
  for (const name of [file, 'manifest.json']) {
    try {
      const output = path.join(directory, name);
      assertNoLinks(output);
      if (!lstatSync(output).isFile()) throw new Error(`构建输出不是常规文件：${output}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  writeFileSync(path.join(directory, file), bytes);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ abiVersion: 1, platform, file,
    sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
  readApprovalArtifact(root, platform);
  console.log(`已构建审批路由：${directory}`);
}

// 导入时只提供校验能力；只有 CLI 入口才执行 Cargo。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
