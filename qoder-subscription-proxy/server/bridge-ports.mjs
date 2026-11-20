import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT, MANAGEMENT_PORT, syncMagpiePort } from "./config.mjs";
import { getSwitchingVersion, resolveLifecycleConfig } from "./core-selection.mjs";
import { ensureCore } from "./core-runtime.mjs";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
import { publishPrivateState, selectionLifecycle } from "./supervisor.mjs";

/** 浏览器拒绝 HTTP 访问的端口，管理面板和写入入口共用 Fetch Standard 的表（https://fetch.spec.whatwg.org/#port-blocking）。 */
export const blockedManagementPorts = Object.freeze([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
]);

/** 端口偏好独立于 Magpie 设置和核心选版，文件名不接受外部输入。 */
const storeName = "bridge-ports.json";
/** 实际安装目录，由模块位置确定。 */
const installation = fileURLToPath(new URL("../", import.meta.url));

/** 向管理端仅暴露固定诊断，排除文件内容和进程参数。 */
function failure(message) {
  return Object.assign(new Error(message), { code: "BRIDGE_CONFIG", safeMessage: message });
}

/** 只将文件不存在视为缺省，链接（含悬空链接）交给调用者拒绝。 */
async function optionalStat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** 逐级拒绝链接并返回最近的现存目录，兼容 Darwin 系统提供的 /var 和 /tmp 别名。 */
async function checkDirectory(path) {
  const parent = dirname(path);
  const existing = parent === path ? parent : await checkDirectory(parent);
  const stat = await optionalStat(path);
  if (!stat) return existing;
  if (stat.isDirectory()) return path;
  if (process.platform === "darwin" && ["/var", "/tmp"].includes(path) && await realpath(path) === `/private${path}`) return path;
  throw failure("数据目录及其子目录必须是普通目录，不能经符号链接或目录联接写入。");
}

/** 在读取和替换端口相关私有文件前检查固定位置；返回普通文件状态或 null。 */
export async function privatePortFile(dataDir, ...parts) {
  if (!isAbsolute(dataDir)) throw failure("端口设置需要绝对数据目录。");
  const path = join(dataDir, ...parts);
  // 用现存祖先的真实路径比较，覆盖 Windows 8.3 别名及尚未创建的数据目录。
  const ancestor = await checkDirectory(dirname(path));
  const child = relative(installation, await realpath(ancestor));
  if (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)) throw failure("端口设置不能写入插件安装目录。");
  const stat = await optionalStat(path);
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw failure("端口配置路径必须是私有普通文件，不能使用链接。");
  return stat;
}

/**
 * @typedef {object} PortSettings
 * @property {number} modelPort 模型服务的 IPv4 回环 TCP 端口，范围 1 到 65535。
 * @property {number} managementPort 浏览器管理服务的 TCP 端口，与模型端口不同。
 * @property {boolean} modelLocked 当前会话显式指定了 BRIDGE_PORT。
 * @property {boolean} managementLocked 当前会话显式指定了 BRIDGE_MANAGEMENT_PORT。
 */

/** 页面仅接受两个不同的整数，持久化记录沿用同一约束。 */
function validatePair(ports) {
  if (![ports?.modelPort, ports?.managementPort].every(port => Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw failure("模型端口和管理端口必须是 1~65535 的整数。");
  }
  if (ports.modelPort === ports.managementPort) throw failure("模型端口与管理端口不能相同。");
}

/** 仅环境变量允许十进制字符串；规范配置保存覆盖值，跨层传递时不需要携带整个环境。 */
function envPort(env, key, inherited) {
  if (env?.[key] === undefined) return inherited;
  const value = env[key];
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw failure(`${key} 必须是 1~65535 的纯十进制整数。`);
  }
  return Number(value);
}

/** 从有效偏好统一构造监听与对外地址；保留两端各自的环境覆盖和未覆盖的磁盘值。 */
function effective(config, persistedPorts, portOverrides) {
  const port = portOverrides.modelPort ?? persistedPorts.modelPort;
  const managementPort = portOverrides.managementPort ?? persistedPorts.managementPort;
  validatePair({ modelPort: port, managementPort });
  const host = config.host ?? DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw failure("BRIDGE_HOST 仅允许 127.0.0.1 回环地址。");
  return { ...config, host, port, managementPort, persistedPorts, portOverrides,
    endpoint: `http://${host}:${port}/v1`, managementUrl: `http://${host}:${managementPort}/` };
}

/** 无锁读取上次提交的偏好；只有调用方明确传入的环境覆盖能够锁定对应端口。 */
export async function resolvePortConfig(config) {
  const overrides = {
    modelPort: envPort(config.env, "BRIDGE_PORT", config.portOverrides?.modelPort),
    managementPort: envPort(config.env, "BRIDGE_MANAGEMENT_PORT", config.portOverrides?.managementPort),
  };
  // 直接构造的内部配置可提供初始端口。规范配置在每次刷新时都重新读取磁盘。
  const portDefaults = config.portDefaults ?? { modelPort: config.port ?? DEFAULT_PORT, managementPort: config.managementPort ?? MANAGEMENT_PORT };
  let ports = portDefaults;
  const stat = await privatePortFile(config.dataDir, storeName);
  if (stat) {
    if (stat.size > 1024) throw failure("持久端口设置无效。");
    try { ports = JSON.parse(await readFile(join(config.dataDir, storeName), "utf8")); }
    catch { throw failure("无法读取持久端口设置，请检查文件格式和权限。"); }
  }
  validatePair(ports);
  return effective({ ...config, portDefaults }, ports, overrides);
}

/** 只向管理端返回当前端口和逐项只读标记，排除配置中的本机凭据。 */
function publicSettings(config) {
  return { modelPort: config.port, managementPort: config.managementPort,
    modelLocked: config.portOverrides.modelPort !== undefined, managementLocked: config.portOverrides.managementPort !== undefined };
}

/** 读取最近成功提交的配置，无需等待切换或启动完成。@returns {Promise<PortSettings>} */
export async function getPortSettings(config) {
  return publicSettings(await resolvePortConfig(config));
}

/** 用真实回环 bind 检查占用及监听权限；不向已占用端口发送请求。 */
async function checkAvailable(port) {
  const server = createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: DEFAULT_HOST, port, exclusive: true }, resolve);
    });
  } catch { throw failure(`回环端口 ${port} 已被占用或没有监听权限。`); }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

/** 停服前确认原端口对可用于回滚，再检查候选所需的其他端口是否空闲。 */
async function checkListeners(previous, target, running, signal) {
  if (running) {
    // 同一私有目录的会话可有不同的环境覆盖。PID 归属不能证明本会话的模型端口正确。
    try {
      if (!(await selectionLifecycle.inspect(previous))?.ready) throw failure("模型服务未就绪。");
      await selectionLifecycle.verifyManagement(previous, signal);
    } catch {
      signal?.throwIfAborted();
      throw failure("无法认证原实例的两个端口，请核对会话端口设置后重试。当前服务已保留。");
    }
  }
  // 允许复用或互换已认证的端口。没有运行实例时，每个目标都需通过 bind 检查。
  for (const port of [target.port, target.managementPort]) {
    if (running && (port === previous.port || port === previous.managementPort)) continue;
    await checkAvailable(port);
  }
}

/** 启动流程验证模型服务，再认证管理连接，避免把外部管理监听者误报为已应用。 */
async function launchVerified(config, signal) {
  const result = await selectionLifecycle.launch(config, signal);
  if (!result?.ready) throw failure("模型端口未就绪。");
  await selectionLifecycle.verifyManagement(config, signal);
}

/**
 * 持有与选版相同的锁，确认原实例归属；新服务通过认证后才提交端口记录。
 * @param {object} config 来自 loadConfig 的私有目录、凭据、核心与会话覆盖值。
 * @param {Pick<PortSettings, 'modelPort' | 'managementPort'>} ports 用户确认应用的两个端口。
 * @param {{signal?: AbortSignal, expectedPorts?: Pick<PortSettings, 'modelPort' | 'managementPort'>}} [options]
 * expectedPorts 是页面确认时的原端口对，内部调用可省略。取消后仍会尝试恢复已停止的服务。
 * @returns {Promise<PortSettings & {changed: boolean, ready: boolean, paused: boolean, reason: string}>}
 * changed 表示本次提交了新端口，ready 表示两个端口已验证，paused 是用户的原暂停意图。
 */
export async function setPortSettings(config, ports, { signal, expectedPorts } = {}) {
  validatePair(ports);
  // 旧配置仍可读取并迁出禁用端口，只对即将应用的管理端口实施浏览器限制。
  if (blockedManagementPorts.includes(ports.managementPort)) throw failure(`浏览器禁止访问管理端口 ${ports.managementPort}，请选择其他端口。`);
  if (expectedPorts !== undefined) validatePair(expectedPorts);
  try {
    // 加锁会创建 dataDir，必须在它之前排除目录重定向。
    await privatePortFile(config.dataDir, storeName);
    return await withLifecycleLock(config, async () => {
      // 在选版恢复或 PID 核验访问路径前，确认控制文件均属于同一私有目录。
      if (config.profileDir !== join(config.dataDir, "magpie") || config.configPath !== join(config.profileDir, "settings.json") ||
          config.pidPath !== join(config.dataDir, "bridge.pid") || config.pausedPath !== join(config.dataDir, "bridge.paused")) {
        throw failure("配置路径必须位于本插件的私有数据目录。");
      }
      await privatePortFile(config.dataDir, "magpie", "settings.json");
      await privatePortFile(config.dataDir, "bridge.pid");
      const paused = Boolean(await privatePortFile(config.dataDir, "bridge.paused"));
      // 锁内重新读取，先比较用户确认过的旧值，排队期间生效的更改必须重新确认。
      const portConfig = await resolvePortConfig(config);
      const current = publicSettings(portConfig);
      if (expectedPorts && (expectedPorts.modelPort !== current.modelPort || expectedPorts.managementPort !== current.managementPort)) {
        throw failure("端口设置已更新，请核对最新端口后重新确认。");
      }
      if ((current.modelLocked && ports.modelPort !== current.modelPort) ||
          (current.managementLocked && ports.managementPort !== current.managementPort)) throw failure("环境变量已锁定对应端口，请修改未锁定的端口。");
      // 选版恢复可能自行停服和重启，留给正常启停入口处理，避免在端口尚未认证时恢复实例。
      if (await getSwitchingVersion(portConfig)) throw failure("核心切换尚待恢复，请先完成核心启停再更改端口。");
      const previous = await resolveLifecycleConfig(portConfig);
      // 环境覆盖不得落入用户偏好；移除覆盖后仍能还原当时保存的独立值。
      const saved = { modelPort: current.modelLocked ? previous.persistedPorts.modelPort : ports.modelPort,
        managementPort: current.managementLocked ? previous.persistedPorts.managementPort : ports.managementPort };
      validatePair(saved);
      const target = effective(previous, saved, previous.portOverrides);
      const changed = previous.port !== target.port || previous.managementPort !== target.managementPort;
      const running = await selectionLifecycle.hasOwnedProcess(previous);
      await checkListeners(previous, target, running, signal);
      if (!changed) return { ...current, changed, ready: running, paused, reason: "端口设置未变化。" };
      const available = !paused && !previous.coreSelectionPending && previous.binPath && (await ensureCore(previous, { allowDownload: false, signal })).available;
      if (running && !paused && !available) throw failure("原核心不可用于重启，已保留当前服务。");
      // 停服前检查现有程序及配置的可访问性。首次尚未安装的核心留给正常启动入口准备。
      if (available) await access(previous.binPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      await access(previous.dataDir, constants.W_OK);
      const store = join(previous.dataDir, storeName);
      const existing = await privatePortFile(previous.dataDir, storeName);
      if (existing) {
        if ((existing.mode & 0o222) === 0) throw failure("端口设置文件只读，无法保存。");
        await access(store, constants.W_OK);
      }
      await syncMagpiePort(target, { checkOnly: true });
      signal?.throwIfAborted();
      let attemptedLaunch = false;
      let syncStarted = false;
      try {
        if (running && !(await selectionLifecycle.stop(previous)).stopped) throw failure("未能确认原核心已停止，端口未提交。");
        if (running) for (const port of [target.port, target.managementPort]) await checkAvailable(port);
        signal?.throwIfAborted();
        syncStarted = true;
        await syncMagpiePort(target);
        if (available) {
          attemptedLaunch = true;
          await launchVerified(target, signal);
        }
        signal?.throwIfAborted();
        await privatePortFile(config.dataDir, storeName);
        await publishPrivateState(store, JSON.stringify(saved) + "\n");
      } catch (error) {
        // 回退独立于触发失败的取消信号；先确认候选进程已回收，才恢复共享设置及原服务。
        try {
          if (attemptedLaunch && await selectionLifecycle.hasOwnedProcess(target) && !(await selectionLifecycle.stop(target)).stopped) {
            throw failure("无法认证候选核心已停止。");
          }
          if (syncStarted) await syncMagpiePort(previous);
          if (running && !paused && !await selectionLifecycle.inspect(previous)) await launchVerified(previous);
        } catch { throw failure("应用端口失败，旧端口记录已保留，未能确认原服务已恢复。请检查权限和端口后重试启动。"); }
        throw error;
      }
      const ready = Boolean(available);
      const reason = ready ? "两个新端口均已验证，请重新打开浏览器管理页。" : paused ? "端口已保存，恢复启动时生效。" : "端口已保存，核心下次启动时生效。";
      return { ...publicSettings(target), changed, ready, paused, reason };
    }, 60000, signal);
  } catch (error) {
    if (error.safeMessage) throw error;
    throw Object.assign(failure(signal?.aborted ? "端口更改已取消。" : "端口更改失败，请检查数据目录、程序权限及核心托管状态。"), { cause: error });
  }
}
