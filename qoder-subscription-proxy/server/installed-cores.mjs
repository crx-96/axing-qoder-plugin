import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { checkReleaseDirectory, getCoreRelease, getCoreStatus, registerStoredRelease, resolveCoreBinaryPath } from './core-runtime.mjs';
import { readSelectionState, recordedCoreMatches, resolveActiveConfig } from './core-selection.mjs';
import { readRecord } from './core-updates.mjs';
import { selectionLifecycle } from './supervisor.mjs';
import { withLifecycleLock } from './lifecycle-lock.mjs';

/** 固定文案可安全传给管理页。 */
function failure(message) { return Object.assign(new Error(message), { safeMessage: message }); }

/** 只接受 canonical tag，先于任何路径拼接。 */
function stable(version) {
  return typeof version === 'string' && version.length <= 64 && version.trim() === version && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version);
}

/** 先检查原始配置和目录，防止自定义路径或链接参与托管。 */
async function validate(config, version) {
  if (!config.core) throw failure('自定义 BRIDGE_BIN 不支持管理发行核心。');
  if (!stable(version)) throw failure('核心版本格式无效。');
  await checkReleaseDirectory(config);
}

/** 无磁盘锁文件，进程退出后内核自动释放。普通下载等待后重进回调复用落盘结果；删除只尝试一次。 */
async function versionLock(config, version, callback, signal, wait) {
  signal?.throwIfAborted();
  await validate(config, version);
  const directory = await realpath(config.dataDir);
  const identity = process.platform === 'win32' ? directory.toLowerCase() : directory;
  const key = createHash('sha256').update(JSON.stringify([identity, config.core.key, version])).digest('hex');
  // Darwin 无抽象 socket，以回环端口取得排他性，端口碰撞只会产生保守的忙碌结果。
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\qoder-version-${key}` : process.platform === 'linux' ? `\0qoder-version-${key}` : { host: '127.0.0.1', port: 20000 + parseInt(key.slice(0, 8), 16) % 40000, exclusive: true };
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    signal?.throwIfAborted();
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (!wait || Date.now() >= deadline) throw failure('此核心版本正在操作中，请稍后重试。');
      await delay(100, undefined, { signal });
      continue;
    }
    try { signal?.throwIfAborted(); return await callback(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}

/** 包住下载、校验、暂存发布全过程。调用方进锁后重新检查是否已完成，且不要在回调中再取同版本锁。 */
export function withVersionOperation(config, version, callback, signal) {
  return versionLock(config, version, callback, signal, true);
}

/** 只有与文件名对应的 canonical release 才能参加来源匹配。 */
async function record(config, version, kind) {
  const path = join(config.dataDir, 'runtimes', `${kind}-${config.core.key}-${version}.json`);
  let entry;
  try { entry = await readRecord(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (entry?.version !== version || entry.key !== config.core.key) throw failure('核心发行记录无效。');
  return registerStoredRelease(entry);
}

/** 历史清单由宿主注入，可同步或异步返回；当前选择和包内基线均是独立可信来源。 */
async function sources(config, legacyCoreReleases) {
  const active = await resolveActiveConfig(config);
  const known = new Map();
  for (const entry of [getCoreRelease(config.core), active.core, ...await (legacyCoreReleases?.(config) ?? [])]) {
    if (entry.key === config.core.key) known.set(entry.version, registerStoredRelease(entry));
  }
  return { active, known };
}

/** 非清单发行必须同时存在匹配的发现、暂存记录，随后由 runtime 验证规范二进制。 */
async function installed(config, version, known) {
  let core = known.get(version);
  if (!core) {
    core = await record(config, version, 'stage');
    if (!core || core !== await record(config, version, 'offer')) return null;
  }
  const binPath = resolveCoreBinaryPath({ dataDir: config.dataDir, ...core });
  return (await getCoreStatus({ ...config, core, binPath })).state === 'ready' ? core : null;
}

/** 切换确认用，只读且不复锁；返回复核后的 canonical release，失败抛错。 */
export async function getInstalledCore(config, version, { legacyCoreReleases } = {}) {
  await validate(config, version);
  const { known } = await sources(config, legacyCoreReleases);
  const release = await installed(config, version, known);
  if (!release) throw failure('找不到已校验的对应版本核心。');
  return release;
}

/** 枚举真实版本目录；无效条目不妨碍展示其他已安装版本，轮询复用 runtime 的文件指纹缓存。 */
export async function listInstalledCores(config, { legacyCoreReleases } = {}) {
  if (!config.core) return [];
  await validate(config, config.core.version);
  const { active, known } = await sources(config, legacyCoreReleases);
  let entries;
  try { entries = await readdir(join(config.dataDir, 'runtimes'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !stable(entry.name)) continue;
    const core = await installed(config, entry.name, known).catch(() => null);
    if (core) result.push({ version: core.version, sizeBytes: core.sizeBytes, active: !active.coreSelectionPending && active.core.version === core.version });
  }
  return result.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
}

/** 只清理空目录。用户旁置文件或其他平台核心会自然保留父目录。 */
async function removeEmpty(path) {
  try { await rmdir(path); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

/** 生命周期锁内重读选版，目标版本争用立即拒绝；核验后仅 unlink 精确匹配的文件。 */
export async function deleteInstalledCore(config, version, { signal, legacyCoreReleases } = {}) {
  await validate(config, version);
  // 删除没有创建目录的理由，先证明缓存确实存在，再进入会准备 dataDir 的生命周期锁。
  await realpath(config.dataDir);
  return withLifecycleLock(config, () => versionLock(config, version, async () => {
    const { active, known } = await sources(config, legacyCoreReleases);
    // 恢复需要保留候选和回退二进制，包括首次事务中仍由旧会话持有的版本。
    const pending = (await readSelectionState(config))?.pending;
    if ((!active.coreSelectionPending && active.core.version === version) || pending?.target.version === version || pending?.previous?.version === version) {
      throw failure('当前版本和切换事务涉及的版本不能删除。');
    }
    const verified = await installed(config, version, known);
    const stage = await record(config, version, 'stage');
    // 中断可能发生在二进制已删而 stage 尚存时。仅在来源仍匹配且路径确实缺失时收尾。
    const core = verified ?? (stage && (known.get(version) ?? await record(config, version, 'offer')));
    if (!core) throw failure('找不到已校验的对应版本核心。');
    if (stage && stage !== core) throw failure('核心暂存记录不匹配。');
    const binPath = resolveCoreBinaryPath({ dataDir: config.dataDir, ...core });
    const target = { ...active, core, binPath, pidPath: join(config.dataDir, 'bridge.pid') };
    await checkReleaseDirectory(target);
    // 同目录的其他会话可用 BRIDGE_BIN 直接启动此缓存。匹配记录时按系统身份区分活实例与残留 PID。
    if (await recordedCoreMatches(target, binPath) && await selectionLifecycle.hasOwnedProcess(target)) {
      throw failure('此核心正在运行，不能删除。');
    }
    signal?.throwIfAborted();
    if (verified) await unlink(binPath);
    else {
      try { await lstat(binPath); throw failure('现有核心文件未通过校验。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (stage) await unlink(join(config.dataDir, 'runtimes', `stage-${core.key}-${version}.json`));
    await removeEmpty(dirname(binPath));
    await removeEmpty(dirname(dirname(binPath)));
    return { deleted: true, version };
  }, signal, false), 25000, signal);
}
