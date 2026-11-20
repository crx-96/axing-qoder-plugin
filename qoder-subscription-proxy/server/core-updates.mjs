/** 官方稳定发行发现与独立暂存。活动版本的选择由生命周期层负责。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as production from './core-runtime.mjs';

/** 固定公开 API 前缀，后缀只来自本模块或已校验的稳定 tag。 */
const RELEASES = 'https://api.github.com/repos/yetone/magpie/releases';
/** 元数据正文最多 1 MiB。 */
const METADATA_LIMIT = 1024 * 1024;
/** 无候选发行或确认已失效时的本地提示。 */
const INVALID = '更新候选无效或已过期，请重新检查更新。';
/** 未取得可用的公开元数据时不透传远端正文、URL 或代理凭据。 */
const NETWORK = '无法读取官方发行信息，请检查网络或代理后重试。';
/** 数据目录尚未获得下载器进度时使用同一快照格式。 */
const WAITING = Object.freeze({ phase: 'waiting', receivedBytes: 0, totalBytes: null });

/** 只有本模块生成的固定诊断可直接传给调用者。 */
class UpdateError extends Error {
  /** 兼容生命周期层的安全错误字段。 */
  constructor(message) { super(message); this.safeMessage = message; }
}
/** 有界读取核心元数据。核对已打开的单链接普通文件，路径缺失时保留 ENOENT 供调用方区分。 */
export async function readRecord(path, limit = 4096) {
  const before = await lstat(path, {bigint: true});
  if (!before.isFile() || before.nlink !== 1n || before.size > limit) throw new UpdateError(INVALID);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    // 原子替换后的新记录须由下一次读取验证，不能混用两个文件的身份和内容。
    const actual = await file.stat({bigint: true});
    if (!actual.isFile() || actual.nlink !== 1n || actual.ino !== before.ino || actual.dev !== before.dev || actual.ctimeNs !== before.ctimeNs) throw new UpdateError(INVALID);
    const bytes = Buffer.alloc(Number(actual.size) + 1);
    const {bytesRead} = await file.read(bytes);
    if (BigInt(bytesRead) !== actual.size || (await file.stat({bigint: true})).ctimeNs !== actual.ctimeNs) throw new UpdateError(INVALID);
    return JSON.parse(bytes.toString('utf8', 0, bytesRead));
  } finally { await file.close(); }
}
/** 稳定版本只接受规范的三段十进制 tag，限制用于文件名的长度。 */
function stable(version) {
  return typeof version === 'string' && version.length <= 64 && version.trim() === version && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version);
}
/** 按数字比较已经校验的 tag，避免字典序和浮点精度影响候选选择。 */
function compare(a, b) {
  const right = b.slice(1).split('.').map(BigInt);
  for (const [i, part] of a.slice(1).split('.').map(BigInt).entries()) {
    if (part !== right[i]) return part > right[i] ? 1 : -1;
  }
  return 0;
}
/** 复用 runtime 的 HTTPS、代理和流量限制。仅额外保留 curl 最终 HTTP 状态以区分 404。 */
async function fetchOfficialMetadata(signal, url) {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-release-'));
  let status = '';
  try {
    const destination = join(dir, 'metadata');
    await production.downloadWithCurl({ url, destination, maxBytes: METADATA_LIMIT, signal }, (file, args, options) => {
      const child = spawn(file, [...args, '--write-out', '%{stderr}%{http_code}'], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.on('data', chunk => { status = (status + chunk.toString('ascii')).slice(-3); });
      return child;
    });
    return JSON.parse(await readFile(destination, 'utf8'));
  } catch (error) {
    if (status === '404') throw Object.assign(new Error(), { status: 404 });
    throw error;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
/** 延迟加载以避免与生命周期模块的初始化环。版本锁始终先于 runtime 下载锁。 */
async function lockVersion(config, version, callback, signal) {
  const { withVersionOperation } = await import('./installed-cores.mjs');
  return withVersionOperation(config, version, callback, signal);
}
/** 同一键只运行一次。各订阅者独立取消，最后一个退出时等待任务清理再返回。 */
function share(jobs, key, signal, run) {
  signal?.throwIfAborted();
  let job = jobs.get(key);
  if (!job || job.controller.signal.aborted) {
    job = { controller: new AbortController(), subscribers: 0 };
    jobs.set(key, job);
    job.promise = run(job, job.controller.signal).finally(() => {
      if (jobs.get(key) === job) jobs.delete(key);
    });
  }
  job.subscribers++;
  return new Promise((resolve, reject) => {
    let subscribed = true;
    /** 拒绝单个订阅时不影响其他下载者或元数据读取者。 */
    function cancel() {
      if (!subscribed) return;
      subscribed = false;
      if (--job.subscribers === 0) job.controller.abort();
      else reject(new UpdateError('操作已取消。'));
    }
    signal?.addEventListener('abort', cancel, { once: true });
    /** 即使底层忽略取消并返回，也不向已取消者报告成功。 */
    function finish(settle, value) {
      signal?.removeEventListener('abort', cancel);
      if (!subscribed) return reject(new UpdateError('操作已取消。'));
      job.subscribers--;
      settle(value);
    }
    job.promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}
/** UI 和调用方沿用原有的错误状态结构。 */
function failed(reason, version = null) { return { state: 'error', version, reason }; }

/** 独立实例可注入运行时、元数据传输 (signal, url)、版本锁和检查缓存时钟。 */
export function createCoreUpdates({ runtime = production.createCoreRuntime(), fetchMetadata = fetchOfficialMetadata,
  withVersionOperation = lockVersion, now = Date.now } = {}) {
  /** 同一活动配置的短期检查结果、元数据订阅与各目标版本的下载进度。 */
  const sessions = new Map();
  /** 后续等价配置对象可复用同一会话。 */
  function session(config) {
    let item = sessions.get(config.binPath);
    if (!item) {
      item = { expires: 0, checks: new Map(), metadata: new Map(), downloads: new Map() };
      sessions.set(config.binPath, item);
    }
    return item;
  }
  /** 候选只替换内核描述及规范路径，不改变活动配置。 */
  function target(config, core) {
    return { ...config, core, binPath: runtime.resolveCoreBinaryPath({dataDir: config.dataDir, ...core}) };
  }
  /** 元数据位于 runtimes 根目录，发现发行无需建立版本目录。 */
  function record(config, version, kind) {
    return join(config.dataDir, 'runtimes', `${kind}-${config.core.key}-${version}.json`);
  }
  /** 版本锁需要 dataDir 的真实路径。只创建这个根目录，锁内再决定是否写发行或二进制。 */
  async function withRelease(config, version, callback, signal) {
    signal?.throwIfAborted();
    await runtime.checkReleaseDirectory(config);
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await runtime.checkReleaseDirectory(config);
    return withVersionOperation(config, version, callback, signal);
  }
  /** 版本锁内原子发布。offer 的 installedOnly 排除最新提示，downloadOnly 标明手动下载的来源。 */
  async function publish(config, release, kind, { latest = false, downloadOnly = false, signal } = {}) {
    const candidate = target(config, release);
    await runtime.checkReleaseDirectory(candidate);
    const path = record(config, release.version, kind);
    let existing;
    try { existing = await readRecord(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing !== undefined && runtime.registerStoredRelease(existing) !== release) throw new UpdateError(INVALID);
    // 已发现的 latest 保持可提示，手动下载来源在随后检查 latest 时也保留；旧 offer 默认为 latest。
    const installedOnly = kind === 'offer' && !latest && (!existing || existing.installedOnly === true);
    const manual = kind === 'offer' && (downloadOnly || existing?.downloadOnly === true);
    if (existing && Boolean(existing.installedOnly) === installedOnly && Boolean(existing.downloadOnly) === manual) return;
    await mkdir(join(config.dataDir, 'runtimes'), { recursive: true, mode: 0o700 });
    await runtime.checkReleaseDirectory(candidate);
    const value = { ...release, ...(installedOnly && { installedOnly: true }), ...(manual && { downloadOnly: true }) };
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      signal?.throwIfAborted();
      // 同版本写入均持独占锁，rename 让无锁枚举方始终看到单链接的完整文件。
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
  }
  /** 只取本平台经 latest 发现过的最高版本，兼容没有 installedOnly 字段的旧 offer。 */
  async function highest(config) {
    await runtime.checkReleaseDirectory(config);
    const prefix = `offer-${config.core.key}-`;
    let highestVersion = config.coreSelectionPending ? null : config.core.version;
    let names;
    try { names = await readdir(join(config.dataDir, 'runtimes')); }
    catch (error) { if (error.code === 'ENOENT') return highestVersion; throw error; }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const version = name.slice(prefix.length, -5);
      if (!stable(version) || (highestVersion && compare(version, highestVersion) <= 0)) continue;
      if (!(await readRecord(record(config, version, 'offer'))).installedOnly) highestVersion = version;
    }
    return highestVersion;
  }
  /** 登记前核对元数据文件与所选 tag、平台相符，路径和散列由 runtime 统一校验。 */
  async function stored(config, version, kind) {
    const value = await readRecord(record(config, version, kind));
    if (value?.version !== version || value?.key !== config.core.key) throw new UpdateError(INVALID);
    return runtime.registerStoredRelease(value);
  }
  /** 没有活动选择时平台模板的版本不参与比较；有活动版本时只允许提示更高版本。 */
  function aboveActive(config, version) { return config.coreSelectionPending || compare(version, config.core.version) > 0; }
  /** 无锁查询的两个持久化记录和二进制必须属于同一已校验发行。 */
  async function verifiedStage(config, version) {
    const release = await stored(config, version, 'stage');
    if (release !== await stored(config, version, 'offer') || (await runtime.getCoreStatus(target(config, release))).state !== 'ready') throw new UpdateError(INVALID);
    return release;
  }
  /** 切换最新提示前重新核验记录与二进制，校验期间公布了新版也拒绝旧确认。 */
  async function getStagedCore(config, version) {
    try {
      if (!config.core || !stable(version) || !aboveActive(config, version) || await highest(config) !== version) throw new UpdateError(INVALID);
      const release = await verifiedStage(config, version);
      if (await highest(config) !== version) throw new UpdateError(INVALID);
      return release;
    } catch { throw new UpdateError(INVALID); }
  }
  /** 默认显示最近开始且仍在下载的目标。并发下载时可按 version 读取独立进度。 */
  async function getUpdateStatus(config, { version: requested } = {}) {
    if (!config.core) return { state: 'custom', version: null };
    const item = session(config);
    try {
      if (requested !== undefined && !stable(requested)) return failed(INVALID);
      const download = [...item.downloads.values()].findLast(job => !requested || job.version === requested);
      if (download) return { state: 'downloading', version: download.version, ...(download.specified && {source: 'specified'}),
        progress: download.candidate ? runtime.getCoreProgress(download.candidate) : { ...WAITING } };
      if (requested) {
        // 定向轮询完成后仍报告该版本，不跳回其他正在下载的版本或最新提示。
        if (item.error?.version === requested) return item.error;
        await runtime.checkReleaseDirectory(config);
        try { await verifiedStage(config, requested); return { state: 'staged', version: requested }; }
        catch (error) { return error.code === 'ENOENT' ? { state: 'idle', version: requested } : failed(INVALID, requested); }
      }
      if (item.checks.size) return { state: 'checking', version: null };
      if (item.error?.source === 'specified') return item.error;
      const version = await highest(config);
      if (!version || !aboveActive(config, version)) return item.error ?? (item.current && version ? {state: 'current', version} : {state: 'idle', version: null});
      await stored(config, version, 'offer');
      try { await lstat(record(config, version, 'stage')); }
      catch (error) { if (error.code === 'ENOENT') return item.error ?? {state: 'available', version}; throw error; }
      await getStagedCore(config, version);
      return item.error ? {state: 'staged', version, reason: item.error.reason} : {state: 'staged', version};
    } catch { return failed(INVALID); }
  }
  /** 两个 API 入口共用同一平台资产约束；指定 tag 必须与返回值逐字匹配。 */
  function discover(config, data, requested) {
    const version = data?.tag_name;
    if (!stable(version) || (requested !== undefined && requested !== version) || data.draft !== false || data.prerelease !== false) {
      throw new UpdateError('官方响应未包含所请求的正式稳定 tag。');
    }
    const assets = Array.isArray(data.assets) ? data.assets.filter(entry => entry?.name === config.core.archive) : [];
    if (assets.length !== 1) throw new UpdateError(assets.length ? '当前平台有多个同名发行资产。' : '此发行没有当前平台的核心资产。');
    const [asset] = assets;
    if (typeof asset.digest !== 'string' || asset.digest.length !== 71 || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) {
      throw new UpdateError('官方资产缺少有效的 SHA256 摘要。');
    }
    const hash = asset.digest.slice(7).toLowerCase();
    try {
      return runtime.registerStoredRelease({...config.core, version, url: asset.browser_download_url, sizeBytes: asset.size, archiveSha256: hash, binarySha256: hash});
    } catch { throw new UpdateError('官方资产的 URL、大小或摘要与规范发行不符。'); }
  }
  /** 仅查询发行，不写提示、暂存或选版。订阅同一 API 请求的调用者可分别取消。 */
  async function official(config, requested, signal) {
    if (!config.core) throw new UpdateError('自定义 BRIDGE_BIN 不支持查询发行核心。');
    const url = `${RELEASES}/${requested === undefined ? 'latest' : `tags/${requested}`}`;
    try {
      return await share(session(config).metadata, url, signal, async (_job, sharedSignal) => {
        const combined = AbortSignal.any([sharedSignal, AbortSignal.timeout(15000)]);
        try {
          await runtime.checkReleaseDirectory(config);
          combined.throwIfAborted();
          const data = await fetchMetadata(combined, url);
          combined.throwIfAborted();
          return discover(config, data, requested);
        } catch (error) {
          if (combined.aborted) throw new UpdateError(sharedSignal.aborted ? '查询发行已取消。' : '查询官方发行信息超时。');
          if (error?.status === 404) throw new UpdateError('官方未找到此稳定发行（HTTP 404）。');
          throw error instanceof UpdateError ? error : new UpdateError(NETWORK);
        }
      });
    } catch (error) {
      if (signal?.aborted) throw new UpdateError('查询发行已取消。');
      throw error;
    }
  }
  /** 全新安装可取本机官方 latest；不比较活动版本或包内基线。 */
  function latestCoreRelease(config, {signal} = {}) { return official(config, undefined, signal); }
  /** 管理页限时缓存检查结果；只将高于活动版本的官方 latest 公布为提示。 */
  async function checkCoreUpdate(config, {signal} = {}) {
    if (!config.core) return getUpdateStatus(config);
    const item = session(config);
    try {
      signal?.throwIfAborted();
      if (item.checks.size || now() >= item.expires) {
        await share(item.checks, 'latest', signal, async (_job, sharedSignal) => {
          try {
            const release = await latestCoreRelease(config, {signal: sharedSignal});
            const current = !aboveActive(config, release.version);
            if (!current) await withRelease(config, release.version, () => publish(config, release, 'offer', {latest: true, signal: sharedSignal}), sharedSignal);
            sharedSignal.throwIfAborted();
            item.current = current;
            item.error = null;
          } catch (error) {
            // 全部订阅取消后，新请求可以立刻重查，旧任务不得覆盖重查结果或刷新有效期。
            sharedSignal.throwIfAborted();
            item.error = failed(error.safeMessage ?? '无法读写本地发行记录，请检查缓存目录。');
          }
          item.expires = now() + 60000;
        });
      }
      signal?.throwIfAborted();
      return getUpdateStatus(config);
    } catch (error) {
      if (signal?.aborted) return failed('已取消检查更新。');
      throw error;
    }
  }
  /** 锁内重新验证 ready 后先发 offer，再发作为安装完成标记的 stage；中断后可幂等补齐。 */
  async function rememberReady(config, release, signal) {
    if ((await runtime.getCoreStatus(target(config, release))).state !== 'ready') throw new UpdateError('核心文件未通过本地大小或 SHA256 校验。');
    signal?.throwIfAborted();
    await publish(config, release, 'offer', {signal});
    await publish(config, release, 'stage', {signal});
    return release;
  }
  /** 登记宿主已选的完整发行元数据；只读验证缓存，无下载或选择副作用。 */
  async function rememberInstalledCore(config, release, {signal} = {}) {
    if (!config.core || release?.key !== config.core.key || !stable(release?.version)) throw new UpdateError('安装记录的 tag 或平台无效。');
    const canonical = runtime.registerStoredRelease(release);
    return withRelease(config, canonical.version, () => rememberReady(config, canonical, signal), signal);
  }
  /** 供首次选版筛除手动下载的历史 tag。只读 offer；无记录即旧布局，损坏记录拒绝采用。 */
  async function isDownloadOnlyCore(config, version) {
    if (!config.core || !stable(version)) throw new UpdateError(INVALID);
    await runtime.checkReleaseDirectory(config);
    let entry;
    try { entry = await readRecord(record(config, version, 'offer')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (entry?.version !== version || entry.key !== config.core.key) throw new UpdateError(INVALID);
    return entry.downloadOnly === true;
  }
  /** 已登记的发行、当前选择或历史发行在缓存校验成功时可离线复用。 */
  async function cachedRelease(config, version) {
    let release;
    try { release = await stored(config, version, 'offer'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // 迁移层也能调用本模块的来源查询，按需加载可避免双方产生初始化环。
      const known = [config.core, runtime.getCoreRelease(config.core)];
      const entry = known.find(core => core.version === version) ??
        (await import('./legacy-core-cache.mjs')).legacyCoreReleases(config).find(core => core.version === version);
      if (entry) release = runtime.registerStoredRelease(entry);
    }
    return release && (await runtime.getCoreStatus(target(config, release))).state === 'ready' ? release : null;
  }
  /** 共用下载、散列校验及暂存发布，仅最新提示入口需要在操作前后检查过期。 */
  async function download(config, version, specified, signal) {
    if (!config.core) return getUpdateStatus(config);
    const item = session(config);
    let key;
    try {
      if (!stable(version)) throw new UpdateError('请输入严格三段的稳定 tag，例如 v1.2.3。');
      key = `${specified ? 'specified' : 'latest'}/${version}`;
      return await share(item.downloads, key, signal, async (job, sharedSignal) => {
        Object.assign(job, { version, specified });
        item.error = null;
        return withRelease(config, version, async () => {
          if (!specified && (!aboveActive(config, version) || await highest(config) !== version)) return failed(INVALID, version);
          // 锁内复查避免跨进程重复下载。旧插件留下的已验证缓存保留原来源。
          let release = await cachedRelease(config, version);
          if (!release) {
            release = specified ? await official(config, version, sharedSignal) : await stored(config, version, 'offer');
            // 在二进制首次可见之前注明来源，宿主迁移旧缓存时可排除本次手动下载。
            await publish(config, release, 'offer', {downloadOnly: true, signal: sharedSignal});
          }
          job.candidate = target(config, release);
          await runtime.ensureCore(job.candidate, {signal: sharedSignal});
          sharedSignal.throwIfAborted();
          // 即使提示已更新，校验成功的二进制仍是一次完整安装；过期只影响本次确认。
          await rememberReady(config, release, sharedSignal);
          if (!specified && await highest(config) !== version) return failed(INVALID, version);
          return {state: 'staged', version};
        }, sharedSignal);
      });
    } catch (error) {
      const reason = signal?.aborted ? '已取消下载。' : error.safeMessage ?? '无法读取或发布核心缓存记录，请检查本地文件。';
      const result = { ...failed(reason, stable(version) ? version : null), ...(specified && {source: 'specified'}) };
      // 重复点击中的单个订阅取消不覆盖仍在后台工作的真实结果。
      if (!item.downloads.has(key)) item.error = result;
      return result;
    }
  }
  /** 显式下载最新提示，沿用最高候选确认契约。 */
  function downloadCoreUpdate(config, version, {signal} = {}) { return download(config, version, false, signal); }
  /** 只下载指定的正式 tag，允许等于或低于活动版本，无 latest 回退。 */
  function downloadSpecifiedCore(config, version, {signal} = {}) { return download(config, version, true, signal); }
  return { latestCoreRelease, checkCoreUpdate, downloadCoreUpdate, downloadSpecifiedCore, rememberInstalledCore, isDownloadOnlyCore, getUpdateStatus, getStagedCore };
}
/** 生产入口与生命周期共享默认运行时注册表，隔离实例无法向其中注入下载器。 */
export const { latestCoreRelease, checkCoreUpdate, downloadCoreUpdate, downloadSpecifiedCore, rememberInstalledCore,
  isDownloadOnlyCore, getUpdateStatus, getStagedCore } = createCoreUpdates({runtime: production});
export { registerStoredRelease } from './core-runtime.mjs';
