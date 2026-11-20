import { realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { latestCoreRelease, readRecord, rememberInstalledCore } from "./core-updates.mjs";
import { findLegacyCore, legacyCoreReleases } from "./legacy-core-cache.mjs";
import { getInstalledCore } from "./installed-cores.mjs";
import { privatePortFile, resolvePortConfig } from "./bridge-ports.mjs";
import { ensureCore, registerStoredRelease, resolveCoreBinaryPath } from "./core-runtime.mjs";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
import { publishPrivateState, selectionLifecycle } from "./supervisor.mjs";

/** 向管理页返回固定的本地诊断。 */
function failure(message) {
  return Object.assign(new Error(message), { safeMessage: message });
}

/** 每个平台在同一私有数据目录中保存独立选择。 */
function selectionName(config) {
  return `core-selection-${config.core.key}.json`;
}

/** 兼容只有 active 的旧记录；active 为 null 仅表示首次选版尚未提交。 */
export async function readSelectionState(config) {
  const name = selectionName(config);
  try {
    if (!await privatePortFile(config.dataDir, name)) return null;
    const state = await readRecord(join(config.dataDir, name));
    if (state.active === null) {
      if (!state.pending || (state.pending.wasRunning && state.pending.previous?.key !== config.core.key)) throw Error();
    } else if (state.active?.key !== config.core.key || typeof state.active.version !== "string") throw Error();
    if (state.pending && (state.pending.target?.key !== config.core.key || typeof state.pending.target.version !== "string" ||
        typeof state.pending.wasRunning !== "boolean")) throw Error();
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw failure("无法读取持久核心选版，请检查数据目录中的选版记录。");
  }
}

/** 持锁发布事务快照；首次切换回退时删除未决记录以恢复原先的空选择。 */
async function save(config, active, pending = null, signal) {
  const name = selectionName(config);
  const existing = await privatePortFile(config.dataDir, name);
  const path = join(config.dataDir, name);
  // 路径复核也可能等待 I/O。进入原子发布前最后检查取消，回退写入使用独立于请求的生命周期。
  signal?.throwIfAborted();
  if (active === null && pending === null) {
    if (existing) await unlink(path);
  } else await publishPrivateState(path, JSON.stringify({ active, pending }));
}

/** 从受校验的发行重建平台配置，二进制路径由运行时推导。 */
function releasedConfig(config, release) {
  const core = registerStoredRelease(release);
  if (core.key !== config.core.key) throw failure("核心平台与本机配置不匹配。");
  return { ...config, core, coreSelectionPending: false, binPath: resolveCoreBinaryPath({ dataDir: config.dataDir, ...core }) };
}

/** 仅从已选记录或旧版已校验缓存恢复。暂存目录的出现不能代表用户已选择该版本。 */
export async function resolveActiveConfig(config) {
  if (config.portOverrides) config = await resolvePortConfig(config);
  if (!config.core) return config;
  const state = await readSelectionState(config);
  const release = state ? state.active : await findLegacyCore(config);
  return release ? releasedConfig(config, release) : { ...config, coreSelectionPending: true };
}

/** 无锁读取切换目标，供管理页及 watchdog 发现未决事务。 */
export async function getSwitchingVersion(config) {
  return config.core ? (await readSelectionState(config))?.pending?.target.version ?? null : null;
}

/** 生命周期锁内检查用户的暂停标记。 */
async function paused(config) {
  try { await stat(config.pausedPath); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** 网络请求不占生命周期锁。取得锁后再读选版及暂停，保留其他会话在此期间作出的决定。 */
export async function selectInitialRelease(config, signal, discover = latestCoreRelease) {
  const release = await discover(config, { signal });
  signal?.throwIfAborted();
  return withLifecycleLock(config, async () => {
    const current = await resolveLifecycleConfig(config);
    if (!current.coreSelectionPending || await paused(config)) return current;
    const selected = releasedConfig(current, release);
    await save(current, selected.core, null, signal);
    return selected;
  }, 25000, signal);
}

/** 启动前离线复核二进制，启动后依次确认模型和管理端口。 */
async function launchCached(config, signal) {
  const checked = await ensureCore(config, { allowDownload: false, signal });
  if (!checked.available) throw failure("选定核心缓存不可用。");
  if (!(await selectionLifecycle.launch(config, signal))?.ready) throw failure("模型端口未就绪。");
  await selectionLifecycle.verifyManagement(config, signal);
}

/** 持锁读取同目录 PID 记录，仅用于定位二进制。进程存活及停止权限由 supervisor 另行认证。 */
export async function recordedCoreMatches(config, binPath) {
  if (!await privatePortFile(config.dataDir, "bridge.pid")) return false;
  const record = await readRecord(join(config.dataDir, "bridge.pid"), 128 * 1024);
  if (typeof record?.binPath !== "string" || !isAbsolute(record.binPath)) throw failure("无法确认 PID 记录中的核心路径。");
  // 自定义 BRIDGE_BIN 可通过短路径或符号链接引用同一缓存。优先匹配记录中的启动路径及 OS 路径。
  const paths = [record.binPath, record.executablePath].filter(path => typeof path === "string" && isAbsolute(path));
  if (paths.some(path => relative(path, binPath) === "")) return true;
  for (const path of paths) {
    try { if (relative(await realpath(path), await realpath(binPath)) === "") return true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return false;
}

/** 先回收候选，再按切换前状态恢复；回退失败时留下 pending 供下一持锁调用重试。 */
async function recover(config, state, attemptedLaunch) {
  const { pending } = state;
  // 新事务记录发起会话的有效端口。旧记录没有此字段，沿用原有的当前配置恢复路径。
  if (pending.ports !== undefined) {
    if (!Number.isInteger(pending.ports?.modelPort) || !Number.isInteger(pending.ports?.managementPort)) throw failure("未决选版的端口记录无效。");
    config = await resolvePortConfig({ ...config, env: undefined, portOverrides: pending.ports });
  }
  const priorRelease = state.active ?? pending.previous;
  const previous = priorRelease ? releasedConfig(config, priorRelease) : null;
  const target = releasedConfig(config, pending.target);
  const stopCandidate = attemptedLaunch ?? await recordedCoreMatches(config, target.binPath);
  if (stopCandidate && !(await selectionLifecycle.stop(target)).stopped) {
    throw failure("无法确认候选核心已经停止。");
  }
  if (pending.wasRunning && !await paused(config)) {
    if (await selectionLifecycle.inspect(previous)) await selectionLifecycle.verifyManagement(previous);
    else await launchCached(previous);
  }
  await save(config, state.active);
}

/** 启停持锁入口会将旧缓存正式登记为活动版本，无缓存时只返回等待首次选版的状态。 */
export async function resolveLifecycleConfig(config) {
  if (config.portOverrides) config = await resolvePortConfig(config);
  if (!config.core) return config;
  const state = await readSelectionState(config);
  if (state?.pending) await recover(config, state);
  if (state) return state.active ? releasedConfig(config, state.active) : { ...config, coreSelectionPending: true };
  const legacy = await findLegacyCore(config);
  if (!legacy) return { ...config, coreSelectionPending: true };
  const active = releasedConfig(config, legacy);
  await save(config, legacy);
  return active;
}

/** 选择已安装的发行。先发布可恢复的事务记录，候选通过认证后才提交活动版本。 */
export async function applyCoreUpdate(config, version, { signal } = {}) {
  try {
    if (!config.core) throw failure("自定义 BRIDGE_BIN 不支持切换发行核心。");
    return await withLifecycleLock(config, async () => {
      const previous = await resolveLifecycleConfig(config);
      if (!previous.coreSelectionPending && previous.core.version === version) throw failure("此版本已是当前核心。");
      const release = await getInstalledCore(previous, version, { legacyCoreReleases });
      const target = releasedConfig(previous, release);
      const wasRunning = Boolean(await selectionLifecycle.inspect(previous));
      const active = previous.coreSelectionPending ? null : previous.core;
      const canRestore = (active || wasRunning) && (await ensureCore(previous, { allowDownload: false, signal })).available;
      if (wasRunning) {
        if (!canRestore) throw failure("原核心缓存不可用于回退，已保留当前服务。");
        await selectionLifecycle.verifyManagement(previous, signal);
      }
      // 在改变活动记录前为原核心留下不可变的安装记录，使用户能离线切回。
      if (canRestore) {
        await rememberInstalledCore(previous, previous.core, {signal});
      }
      signal?.throwIfAborted();
      // 无已选记录也可能正运行会话先前的核心。只在需要恢复该进程时额外保存其发行。
      const pending = { target: target.core, wasRunning, ports: { modelPort: previous.port, managementPort: previous.managementPort },
        ...(!active && wasRunning && { previous: previous.core }) };
      await save(config, active, pending, signal);
      let attemptedLaunch = false;
      try {
        signal?.throwIfAborted();
        if (wasRunning && !(await selectionLifecycle.stop(previous)).stopped) throw failure("旧核心停止失败，请检查服务归属。");
        const ready = !await paused(config);
        if (ready) {
          attemptedLaunch = true;
          await launchCached(target, signal);
        }
        signal?.throwIfAborted();
        await save(config, target.core, null, signal);
        return { ready, version };
      } catch (error) {
        // 恢复原服务使用锁内重读的端口，不继承已取消的请求信号。
        try { await recover(previous, { active, pending }, attemptedLaunch); }
        catch { throw failure("切换失败，未决选版已保留，下次启停将重试恢复。"); }
        throw error;
      }
    }, 60000, signal);
  } catch (error) {
    if (error.safeMessage) throw error;
    throw failure(signal?.aborted ? "核心切换已取消。" : "核心切换失败，请检查本机缓存和托管状态。");
  }
}
