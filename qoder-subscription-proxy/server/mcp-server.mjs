import { openManagement } from "./management-gateway.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.mjs";
import { applyCoreUpdate, getSwitchingVersion, resolveActiveConfig } from "./core-selection.mjs";
import { checkCoreUpdate, downloadCoreUpdate, downloadSpecifiedCore, getUpdateStatus } from "./core-updates.mjs";
import { deleteInstalledCore, listInstalledCores } from "./installed-cores.mjs";
import { generateImage } from "./image-generation.mjs";
import { legacyCoreReleases } from "./legacy-core-cache.mjs";
import { getPortSettings, setPortSettings } from "./bridge-ports.mjs";
import { ensureRunning, getStatus, isPreparing, stopBridge, startWatchdog, shutdownOwnedBridges } from "./supervisor.mjs";
import { runMcp } from "./mcp-protocol.mjs";

/** 插件源码根目录；不依赖宿主启动时的工作目录。 */
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 协议与后台启动共享的上下文；核心故障不影响 MCP 连接。 */
const ctx = {
  /** 配置不可用时仅提供诊断和重试入口。 */
  config: null,
  /** 最近一次后台启动故障，供 bridge_status 返回安全摘要；代理就绪后清除。 */
  startupError: null,
};
/** 健康检查的停止函数；只注册一次，下载失败时不启用自动恢复。 */
let stopWatchdog;
/** MCP 会话的取消信号，防止退出收尾期间重新注册健康检查。 */
let sessionSignal;
/** 后台核心准备及代理启动任务；退出前等待取消清理完成。 */
let backgroundPreparation = Promise.resolve();
/** 显式重试可以在用户修复配置后重新加载；并发启动共享一次校验。 */
let loadingConfig;

/** 输出可展示的启动故障；过滤密钥、链接和堆栈，stdout 仅供 JSON-RPC 使用。 */
function reportStartupFailure(error, fallback) {
  let safeMessage = typeof error?.safeMessage === "string" ? error.safeMessage : fallback;
  // 先移除已知凭据，再限制为单行；不输出原始异常 message、路径或响应正文。
  for (const secret of [ctx.config?.apiKey, ctx.config?.mgmtKey]) {
    if (typeof secret === "string" && secret) safeMessage = safeMessage.split(secret).join("[已脱敏]");
  }
  safeMessage = safeMessage.replace(/https?:\/\/\S+/gi, "[链接已隐藏]").split(/[\r\n]/, 1)[0].slice(0, 500);
  process.stderr.write(`qoder-subscription-proxy: ${safeMessage}\n`);
  return Object.assign(new Error(safeMessage), { code: error?.code ?? "BRIDGE_START_FAILED", safeMessage });
}

/** 成功启动或已持久暂停后开启健康检查；显式重试成功也复用这一入口。 */
function ensureWatchdog() {
  if (stopWatchdog || sessionSignal?.aborted) return;
  stopWatchdog = startWatchdog(ctx.config, (error) => {
    if (error) ctx.startupError = { code: error.code ?? "BRIDGE_RECOVERY_FAILED", safeMessage: error.safeMessage ?? "桥自动恢复未成功，请检查端口和配置。" };
  });
}

/**
 * 后台准备核心并自动启动代理；独立于握手，复用生命周期层的下载去重和暂停/取消。
 * 下载仍使用下载器自身的 10 分钟预算；失败只记录状态，保留 MCP 供查询和手动重试。
 */
async function prepareBridge(signal) {
  try {
    const result = await ensureRunning(ctx.config, { automatic: true, allowDownload: true, signal });
    signal.throwIfAborted();
    if (!result.ready) {
      // 主动暂停不是故障；必须保持暂停，不能在下载完成后重新拉起代理。
      const status = await getStatus(ctx.config);
      if (!status.autoRecoveryPaused) throw Object.assign(new Error("代理未就绪"), { safeMessage: result.reason });
    }
    ctx.startupError = null;
    ensureWatchdog();
  } catch (error) {
    // EOF、断管或 bridge_stop 取消属于正常收尾，不记录成下载失败。
    if (signal.aborted || error.name === "AbortError" || error.code === "CORE_CANCELLED") return;
    ctx.startupError = reportStartupFailure(error, "代理后台准备失败；请检查核心、端口和配置，可通过 bridge_start 或重连 MCP 重试。");
  }
}

/** 配置失败时保留只读诊断入口，直到用户修复并显式重试。 */
async function readConfiguration() {
  loadingConfig ??= loadConfig({ pluginRoot }).then(config => {
    ctx.config = config;
    ctx.startupError = null;
  }).catch(error => {
    ctx.startupError = reportStartupFailure(error, "无法读取本地配置，请检查数据目录权限和 Magpie 设置文件。");
    throw ctx.startupError;
  }).finally(() => { loadingConfig = null; });
  await loadingConfig;
}

/** 握手只等待本地配置，允许用户在管理页诊断配置和启动问题。 */
async function prepare(signal) {
  sessionSignal = signal;
  try { await readConfiguration(); } catch { return; }
  signal.throwIfAborted();
  // 保存任务用于退出收尾；异步故障由 prepareBridge 接住，不拒绝本次 initialize。
  backgroundPreparation = prepareBridge(signal);
}

/** 工具共用同一配置和生命周期；下载期间状态、暂停及工具发现仍可使用。 */
const handlers = {
  /** 用户明确调用授权指令时才打开本机浏览器。 */
  async openManagement(config, options) { return openManagement(await resolveActiveConfig(config), options); },
  async generateImage(config, options) { return generateImage(await resolveActiveConfig(config), options); },
  async checkUpdate(config, options) { return checkCoreUpdate(await resolveActiveConfig(config), options); },
  async downloadUpdate(config, version, options) { return downloadCoreUpdate(await resolveActiveConfig(config), version, options); },
  async downloadVersion(config, version, options) { return downloadSpecifiedCore(await resolveActiveConfig(config), version, options); },
  async deleteVersion(config, version, options) { return deleteInstalledCore(await resolveActiveConfig(config), version, { ...options, legacyCoreReleases }); },
  async setPorts(config, ports, options) {
    const result = await setPortSettings(await resolveActiveConfig(config), ports, options);
    ctx.config = await resolveActiveConfig(config);
    ctx.startupError = null;
    if (result.ready) ensureWatchdog();
    return result;
  },
  async applyUpdate(config, version, options) {
    const result = await applyCoreUpdate(config, version, options);
    if (result.ready) { ctx.startupError = null; ensureWatchdog(); }
    return result;
  },
  /** 查询实际代理与核心状态；MCP 已连接不代表 ready 为 true。 */
  async getStatus() {
    if (!ctx.config) return { alive: false, ready: false, preparing: false, state: "configuration_error" };
    const active = await resolveActiveConfig(ctx.config);
    const [status, update, switchedTo, installedVersions, ports] = await Promise.all([
      getStatus(active), getUpdateStatus(active), getSwitchingVersion(active), listInstalledCores(active, { legacyCoreReleases }), getPortSettings(active),
    ]);
    if (status.ready) ctx.startupError = null;
    if (active.coreSelectionPending) status.core = { state: 'missing', version: null, platform: active.core.key, reason: '正在等待首次选择本机核心。' };
    return { ...status, preparing: isPreparing(active), ports, installedVersions, update: switchedTo ? { state: "switching", version: switchedTo } : update };
  },
  /** 显式启动可解除暂停或重试下载；已有启动任务由生命周期层合并等待。 */
  async ensureRunning(_config, options) {
    if (!ctx.config) await readConfiguration();
    ctx.startupError = null;
    try {
      const result = await ensureRunning(ctx.config, options);
      if (result.ready) ensureWatchdog();
      return result;
    } catch (error) {
      if (options.signal?.aborted || error.name === "AbortError" || error.code === "CORE_CANCELLED") throw error;
      ctx.startupError = reportStartupFailure(error, "启动失败，请检查数据目录权限、核心运行依赖和本机端口。");
      throw ctx.startupError;
    }
  },
  /** 持久暂停并取消本会话的在途下载/启动；只停止可确认归属的代理。 */
  async stopBridge() {
    return stopBridge(ctx.config);
  },
};

/** 系统退出信号统一走输入关闭，使协议和后台任务共享取消与清理路径。 */
const stopInput = () => process.stdin.destroy();
process.once("SIGINT", stopInput);
process.once("SIGTERM", stopInput);
try { await runMcp(ctx, { handlers, prepare }); }
finally {
  // 先拒绝新启动并取消在途任务，再等待后台下载清理及本会话拥有的代理回收。
  const shutdown = shutdownOwnedBridges();
  if (stopWatchdog) await stopWatchdog();
  await backgroundPreparation;
  await shutdown;
  process.off("SIGINT", stopInput);
  process.off("SIGTERM", stopInput);
  process.stdin.destroy();
}
