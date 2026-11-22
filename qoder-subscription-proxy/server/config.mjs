import { randomBytes } from "node:crypto";
import { constants, statSync } from "node:fs";
import { access, link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { privatePortFile, resolvePortConfig } from "./bridge-ports.mjs";
import { publishPrivateState } from "./supervisor.mjs";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { resolveActiveConfig } from "./core-selection.mjs";
import { getCoreRelease, resolveCoreBinaryPath } from "./core-runtime.mjs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 19787;
export const MANAGEMENT_PORT = 19788;
export const PLUGIN_VERSION = "2.0.2";
const LEGACY_MGMT_KEY = "123456";

/** 仅将本模块生成的字段名与纠正建议传给管理页，排除用户提供的配置值。 */
function configError(message) {
  return Object.assign(new Error(message), { code: "BRIDGE_CONFIG", safeMessage: message });
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw configError(`${name} 必须是非空且不含 NUL 的字符串。`);
  }
  return value;
}

function envString(env, name) {
  return env[name] === undefined ? undefined : requireString(env[name], name);
}

function validClientKey(value) {
  return typeof value === "string" && /^[!-~]+$/.test(value) && value !== LEGACY_MGMT_KEY;
}

/** 只把真正不存在的路径视为缺省；悬空链接也属于已有条目。 */
async function entry(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** 读和收紧权限始终使用同一文件描述符；Windows 无 O_NOFOLLOW，通过 inode 身份补查。 */
async function openPrivateFile(path, before) {
  const invalid = () => configError("私有配置必须是当前用户的普通文件，不能使用链接。");
  if (!before?.isFile() || before.nlink !== 1n) throw invalid();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const actual = await handle.stat({ bigint: true });
    if (!actual.isFile() || actual.nlink !== 1n || actual.ino !== before.ino || actual.dev !== before.dev ||
        (process.getuid && actual.uid !== BigInt(process.getuid()))) throw invalid();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** 识别真实旧插件的单密钥或双密钥结构，格式校验成功后才在该句柄上收紧 POSIX 权限。 */
async function readSecrets(file, before) {
  const handle = await openPrivateFile(file, before);
  try {
    const secrets = JSON.parse(await handle.readFile("utf8"));
    if (!validClientKey(secrets?.apiKey) || Object.keys(secrets).some(k => !["mgmtKey", "apiKey"].includes(k)) ||
        (Object.hasOwn(secrets, "mgmtKey") && secrets.mgmtKey !== LEGACY_MGMT_KEY &&
         (typeof secrets.mgmtKey !== "string" || !/^[a-f0-9]{64}$/.test(secrets.mgmtKey) || secrets.apiKey === secrets.mgmtKey))) {
      throw configError("本地凭据格式无效。");
    }
    // Windows 文件使用目录继承的 ACL，chmod 只能改变只读位。
    if (process.platform !== "win32" && (before.mode & 0o7777n) !== 0o600n) await handle.chmod(0o600);
    return secrets;
  } finally { await handle.close(); }
}

/** 锁内完整写入凭据；首次创建不覆盖已有条目，升级只替换刚刚复核过的凭据。 */
async function publishSecrets(file, apiKey, upgrade) {
  const temporary = file + "." + randomBytes(16).toString("hex") + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try {
    const mgmtKey = randomBytes(32).toString("hex");
    await handle.writeFile(JSON.stringify({ apiKey, mgmtKey }) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    if (upgrade) await rename(temporary, file);
    else {
      try { await link(temporary, file); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  } finally {
    await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

/** 判断指定目录是否已经由独立核心使用；仅查看条目，不读取账号、配置内容或缓存。 */
async function checkDataOwner(dataDir, file) {
  const dir = await entry(dataDir);
  if (dir && (!dir.isDirectory() || (process.getuid && (dir.uid !== BigInt(process.getuid()) || (dir.mode & 0o022n) !== 0n)))) {
    throw configError("BRIDGE_DATA_DIR 必须是当前用户拥有且其他用户不能写入的目录。");
  }
  const foreign = () => configError("BRIDGE_DATA_DIR 中存在独立 Magpie 的配置或缓存，请使用插件自己的数据目录。");
  // 上游 appdir.hasFiles 以这三个文件识别 Magpie 自己的配置（含便携 data/）。
  for (const name of ["settings.json", "providers.json", "logins.json"]) {
    if (await entry(join(dataDir, name))) throw foreign();
  }
  // 旧插件先发布 launcher-secrets.json，之后才创建 Magpie 配置。不能用新生成的凭据认领已有目录；
  // 凭据被删除但仍有插件专属产物时，目录仍属于本插件，允许重新生成凭据。
  if (!(await entry(file))) {
    const pluginOwned = [];
    for (const name of ["runtimes", "generated", "bridge.log", "bridge.paused", "bridge.pid", "bridge-ports.json"]) {
      pluginOwned.push(await entry(join(dataDir, name)));
    }
    if (pluginOwned.some(Boolean)) return;
    for (const name of ["magpie", "dial", "cache", "home", "state"]) {
      if (await entry(join(dataDir, name)) && !(await entry(file))) throw foreign();
    }
  }
}

/** 正常双密钥无锁复用；首次发布及旧版迁移在共享生命周期锁内复核归属。 */
async function loadSecrets(dataDir, port) {
  const file = join(dataDir, "launcher-secrets.json");
  try {
    await checkDataOwner(dataDir, file);
    const before = await entry(file);
    if (before?.isFile() && before.nlink === 1n) {
      try {
        const existing = await readSecrets(file, before);
        if (existing.mgmtKey && existing.mgmtKey !== LEGACY_MGMT_KEY) return existing;
      } catch (error) {
        // 只有文件已在并发迁移中被替换时才重读；损坏或无法访问的原文件原样报告。
        const now = await entry(file);
        if (now?.ino === before.ino && now.dev === before.dev) throw error;
      }
    }
    return await withLifecycleLock({ dataDir, port }, async () => {
      await checkDataOwner(dataDir, file);
      const currentFile = await entry(file);
      if (currentFile) {
        const current = await readSecrets(file, currentFile);
        if (current.mgmtKey && current.mgmtKey !== LEGACY_MGMT_KEY) return current;
        await publishSecrets(file, current.apiKey, true);
      } else {
        await publishSecrets(file, randomBytes(32).toString("hex"), false);
      }
      return readSecrets(file, await entry(file));
    });
  } catch (error) {
    if (error.safeMessage) throw error;
    throw Object.assign(configError("无法安全加载 launcher-secrets.json；请检查文件格式、访问权限及文件系统硬链接支持。"), {
      code: error.code ?? "BRIDGE_CONFIG", syscall: error.syscall,
    });
  }
}

/** 在创建凭据前合并本机端口偏好和显式环境配置，随后解析当前核心。 */
export async function loadConfig({ pluginRoot, env = process.env, platform = process.platform, arch = process.arch }) {
  requireString(pluginRoot, "pluginRoot");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw configError("env 必须是环境变量对象。");
  let core;
  try { core = getCoreRelease({ platform, arch }); }
  catch { throw configError("不支持的平台或架构。请使用 Windows x64、macOS x64/arm64 或 Linux x64/arm64。"); }
  const bin = envString(env, "BRIDGE_BIN");
  const data = envString(env, "BRIDGE_DATA_DIR");
  const qoderClient = envString(env, "BRIDGE_QODER_CLIENT");
  if (qoderClient !== undefined && !["qoder", "qoder-cn"].includes(qoderClient)) {
    throw configError("BRIDGE_QODER_CLIENT 仅支持 qoder 或 qoder-cn；使用手动配置时请移除此设置。");
  }
  const host = envString(env, "BRIDGE_HOST") ?? DEFAULT_HOST;
  const apiKey = envString(env, "BRIDGE_API_KEY");
  const mgmtKey = envString(env, "BRIDGE_MGMT_KEY");
  if (host !== DEFAULT_HOST) throw configError("BRIDGE_HOST 仅允许 127.0.0.1 回环地址。");
  if (mgmtKey !== undefined && mgmtKey !== LEGACY_MGMT_KEY) {
    throw configError("BRIDGE_MGMT_KEY 不允许覆盖本机生成的管理密码；请移除此环境变量。");
  }
  if (apiKey !== undefined && !validClientKey(apiKey)) throw configError("BRIDGE_API_KEY 必须是可用于 HTTP 的可见 ASCII 字符，不含空格，且不能复用旧公共密码。");
  const dataDir = resolve(data ?? join(homedir(), ".qoder", "qoder-subscription-proxy", "data"));
  // 即使独立核心尚未创建文件，也不能把它的标准配置/缓存（或其父目录）先认领为插件数据。
  const hostHome = env[process.platform === "win32" ? "USERPROFILE" : "HOME"] || homedir();
  const externalRoots = [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, join(hostHome, ".config"), join(hostHome, ".cache")];
  if (process.platform === "darwin") externalRoots.push(join(hostHome, "Library", "Caches"), join(hostHome, "Library", "Logs"));
  if (process.platform === "win32") externalRoots.push(env.LOCALAPPDATA, join(hostHome, "AppData", "Local"));
  for (const root of externalRoots) {
    if (!root || !isAbsolute(root)) continue;
    const independent = join(root, "magpie");
    if (within(dataDir, independent) || within(independent, dataDir)) throw configError("BRIDGE_DATA_DIR 与独立 Magpie 的配置或缓存路径重叠。");
  }
  // 仅传递两项覆盖值，不把宿主环境和其他密钥保留在规范配置中。
  const { env: _portEnv, ...ports } = await resolvePortConfig({ dataDir, host, env: {
    BRIDGE_PORT: env.BRIDGE_PORT, BRIDGE_MANAGEMENT_PORT: env.BRIDGE_MANAGEMENT_PORT,
  } });
  const secrets = await loadSecrets(dataDir, ports.port);
  if (apiKey === secrets.mgmtKey) throw configError("BRIDGE_API_KEY 不能与管理密钥相同。");
  const config = {
    pluginRoot: resolve(pluginRoot),
    qoderClient,
    binPath: bin ? resolve(bin) : resolveCoreBinaryPath({ dataDir, platform, arch }),
    core: bin ? null : core,
    dataDir,
    profileDir: join(dataDir, "magpie"),
    configPath: join(dataDir, "magpie", "settings.json"),
    pidPath: join(dataDir, "bridge.pid"),
    lockPath: join(dataDir, "bridge.lock"),
    pausedPath: join(dataDir, "bridge.paused"),
    ...ports,
    apiKey: apiKey ?? secrets.apiKey,
    mgmtKey: secrets.mgmtKey,
  };
  // 并发切换期间可能看到候选端口；读取配置不取锁、不写盘，启动者在锁内同步。
  try { await syncMagpiePort(config, { readOnly: true }); }
  catch (error) {
    if (error.code !== "ENOENT") throw error.safeMessage ? error : configError("无法读取 Magpie settings.json，请检查数据目录中的文件和访问权限。");
  }
  return resolveActiveConfig(config);
}

/** 校验 Magpie 隔离设置；端口迁移仅允许从另一个合法 TCP 端口转换。 */
export function validateMagpieSettings(config, text, { allowPortChange = false } = {}) {
  let settings;
  try { settings = JSON.parse(text); } catch { throw configError("Magpie settings.json 不是有效 JSON。"); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw configError("Magpie settings.json 必须是对象。");
  if (settings.lan === true || settings.https === true || !Number.isInteger(settings.port) ||
      settings.port < 1 || settings.port > 65535 || (!allowPortChange && settings.port !== config.port)) {
    throw configError("Magpie 必须使用插件指定的本机 HTTP 端口，不能开启局域网共享或 HTTPS。");
  }
  if (settings.noAutoUpdate !== true || settings.noAutoDownload !== true || settings.autoRestart === true) {
    throw configError("请关闭 Magpie 自带的自动更新和下载，以使用插件指定的核心版本。");
  }
  return settings;
}

/** 从私有目录读取已有设置；提交或回退时仅替换模型端口，保留用户和未来版本的其他字段。 */
export async function syncMagpiePort(config, { readOnly = false, checkOnly = false } = {}) {
  if (config.profileDir !== join(config.dataDir, "magpie") || config.configPath !== join(config.profileDir, "settings.json")) {
    throw configError("Magpie 设置路径必须位于本插件的私有数据目录。");
  }
  const file = await privatePortFile(config.dataDir, "magpie", "settings.json");
  if (!file) return;
  const handle = await openPrivateFile(config.configPath, await entry(config.configPath));
  let text;
  try { text = await handle.readFile("utf8"); }
  finally { await handle.close(); }
  const settings = validateMagpieSettings(config, text, { allowPortChange: true });
  if (readOnly || settings.port === config.port) return;
  // 即使目录允许 rename，也尊重现有设置文件的只读权限。
  if ((file.mode & 0o222) === 0) throw configError("Magpie 设置文件只读，无法更新端口。");
  await access(config.configPath, constants.W_OK);
  if (checkOnly) return;
  // Magpie 的扩展字段可含 64 位整数。保留每个原始数字的 JSON 表示，避免改端口时损失精度。
  const preserved = JSON.parse(text, (_key, value, context) => typeof value === "number" ? JSON.rawJSON(context.source) : value);
  preserved.port = config.port;
  await publishPrivateState(config.configPath, JSON.stringify(preserved, null, 2) + "\n");
}

/** 与上游 appdir.Beside 一致，路径必须在绝对目录内，允许目录本身。 */
function within(path, directory) {
  if (!directory || !isAbsolute(directory)) return false;
  const child = relative(directory, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}

/** 核心优先使用便携 data；检查用户提供的入口、解析后的程序和上游识别的容器外层。 */
async function checkPortable(config, env) {
  const roots = new Set([dirname(config.binPath)]);
  let executable;
  try { executable = await realpath(config.binPath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // 尚未下载的托管核心仍允许初始化设置。自定义核心必须能查到实际位置。
  const dir = dirname(executable ?? config.binPath);
  roots.add(dir);
  const bundle = dirname(dirname(dir));
  if (basename(dir) === "MacOS" && basename(dirname(dir)) === "Contents" && extname(bundle).toLowerCase() === ".app") {
    roots.add(dirname(bundle));
  }
  // AppImage 自身启动后会设置这两个变量；从其他 AppImage 继承的挂载点与本核心无关。
  if (executable && process.platform === "linux" && env.APPIMAGE && within(executable, env.APPDIR)) roots.add(dirname(resolve(env.APPIMAGE)));
  for (const root of roots) {
    if (await entry(join(root, "data")) || await entry(join(root, ".portable"))) {
      throw configError("核心便携根存在 data 或 .portable，可能覆盖 Magpie 配置隔离；请将 BRIDGE_BIN 放在独立的程序目录。");
    }
  }
  if (!executable && config.core === null) throw configError("BRIDGE_BIN 不存在，无法核实核心的实际程序目录。");
}

/** 启动前建立隔离配置，按本次已解析的端口校正已有文件。 */
export async function ensureMagpieConfig(config, baseEnv = process.env) {
  await checkPortable(config, baseEnv);
  // 原生端从这些根创建客户端、日志和缓存。逐级 lstat，避免通过现有联接访问外部文件。
  const checked = new Set();
  for (const parts of [["home", "Library", "Caches", "magpie"], ["home", "Library", "Logs", "magpie"],
    ["home", "AppData", "Local", "magpie"], ["home", "AppData", "Roaming"], ["home", ".local", "share"],
    ["home", "runtime"], ["home", "tmp"], ["state", "magpie"], ["cache", "magpie"], ["cache", "dial"]]) {
    let dir = config.dataDir;
    for (const part of parts) {
      dir = join(dir, part);
      if (checked.has(dir)) continue;
      const stat = await entry(dir);
      if (stat && !stat.isDirectory()) throw configError("Magpie 私有目录不能是链接或普通文件。");
      checked.add(dir);
    }
  }
  for (const parts of [["bridge.log"], ["magpie", "providers.json"], ["magpie", "logins.json"],
    ["home", ".codex", "config.toml"], ["home", ".claude", "settings.json"],
    ["home", ".qoder", "settings.json"], ["home", ".qoder-cn", "settings.json"]]) {
    await privatePortFile(config.dataDir, ...parts);
  }
  if (await entry(join(config.dataDir, "magpie", "move-to.json"))) throw configError("插件托管的 Magpie 不支持原生数据目录迁移，请使用 BRIDGE_DATA_DIR。");
  // 已有设置可能来自上次中断的切换或不同的显式环境覆盖。
  await syncMagpiePort(config);
  for (const dir of [config.profileDir, join(config.dataDir, "home", "tmp"), join(config.dataDir, "home", "runtime")]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const text = JSON.stringify({
    lang: "zh", port: config.port, lan: false, noAutoUpdate: true, noAutoDownload: true,
    autoRestart: false, noAccountDiscovery: true, noStats: true, noUsageStats: true,
  }, null, 2) + "\n";
  const temporary = `${config.configPath}.${randomBytes(16).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
    await file.close();
    try { await link(temporary, config.configPath); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally {
    await file.close();
    await unlink(temporary);
  }
  const before = await entry(config.configPath);
  const published = await openPrivateFile(config.configPath, before);
  try {
    validateMagpieSettings(config, await published.readFile("utf8"));
    if (process.platform !== "win32" && (before.mode & 0o7777n) !== 0o600n) await published.chmod(0o600);
  } finally { await published.close(); }
}

export function magpieArguments(config) {
  return ["serve", `--web=${DEFAULT_HOST}:${config.managementPort}`];
}

/** 核对 v0.1.4582～v0.1.4597 的 internal/agentenv/agentenv.go 与 internal/agent/*.go。升级时同步上游可重新导入的客户端变量。
 * 显式空值阻止 proc.UserPath 和 Windows 注册表补回宿主值；随后仅按下方白名单恢复客户端配置目录，
 * 服务商密钥、URL 和行为变量继续保持清空。 */
const clientPathVars = `CLAUDE_CONFIG_DIR COPILOT_HOME COPILOT_PROVIDERS_CONFIG CLAUDE_CODE_TMPDIR
MAGPIE_ZED_BIN MAGPIE_ZED_CONFIG_DIR MAGPIE_ZED_PROCESS_NAMES CODEX_SQLITE_HOME GEMINI_CLI_HOME
CLINE_DIR CLINE_DATA_DIR CLINE_SESSION_DATA_DIR CLINE_MCP_SETTINGS_PATH CLINE_GLOBAL_SETTINGS_PATH
PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR PI_CONFIG_DIR PI_PROFILE OMO_CODING_AGENT_DIR SENPI_CODING_AGENT_DIR
SLOCK_HOME PRIME_AGENT_CODING_AGENT_DIR MU_AGENT_DIR KYRN_AGENT_DIR MU_CODING_AGENT_DIR KYRN_CODING_AGENT_DIR
STEP_CODING_AGENT_DIR STEPCODE_CONFIG_DIR MOTHX_DIR BUN_INSTALL SHELLEY_SOCKET PENGUIN_HOME PENGUIN_PROJECT_ID
DEVIN_SESSIONS_DIR OMP_PROFILE GROK_HOME GROK_BIN_DIR GROK_APP_HOME KIMI_CODE_HOME KIMI_SHARE_DIR QWEN_HOME
ANTE_HOME NEWMAX_USER_DATA_DIR LIVEAGENT_HOME K_BRAIN_HOME OMB_DATA_DIR AVIBE_HOME KUN_DATA_DIR NMEM_APP_CONFIG_DIR
ASTRBOT_ROOT DIMCODE_HOME VIBE_HOME JCODE_HOME OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR OPENCLAW_PROFILE OPENCLAW_HOME
MIMOCODE_HOME MINIMAX_DATA_DIR MAVIS_DATA_DIR HANA_HOME PASEO_HOME HERMES_HOME DSH_HOME WORKBUDDY_CONFIG_DIR
CODEBUDDY_CONFIG_DIR DS_BOT_HOME DS_BOT_SHELL_DATA DEVECO_CONFIG_DIR ALMA_DATA_DIR MINIQ_DATA_DIR PAIMON_CONFIG_HOME
CRAFT_CONFIG_DIR REASONIX_HOME REASONIX_STATE_HOME PI_DESKTOP_DATA_DIR MISTER_MORPH_CONFIG T3CODE_HOME ATOMCODE_HOME
SNOW_CONFIG_DIR QWENPAW_WORKING_DIR QWENPAW_SECRET_DIR BILI_CONFIG_FILE CURSOR_CONFIG_DIR CURSOR_DATA_DIR
OPENCODE_CONFIG OPENCODE_CONFIG_DIR OPENCODE_DB OPENCHAMBER_DATA_DIR KIROCREW_HOME CODEX_ACP_BIN CLAUDE_AGENT_ACP_BIN
PI_ACP_BIN FACTORY_HOME_OVERRIDE NVM_DIR FNM_DIR MISE_DATA_DIR ASDF_DIR CARGO_HOME OMARCHY_PATH
GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_CONFIG AGY_LLM_GATEWAY_URL NMEM_API_URL WINDSURF_API_SERVER_URL ZCODE_CREDENTIAL_SECRET`.split(/\s+/);

/** 第二层托管的环境标记；下一跳沿用首跳解析好的客户端目录，不再探测私有 HOME 下的默认位置。 */
const nestedCoreEnv = "BRIDGE_NESTED_CORE_ENV";

/** 只接受可传给子进程的绝对路径；空值、含 NUL 或相对路径都视为未设置。 */
function absolutePath(value) {
  return typeof value === "string" && value && !value.includes("\0") && isAbsolute(value) ? value : null;
}

/** 判断宿主上的文件是否存在；用于识别 Qoder 的状态和设置标记，不读取内容。 */
function fileExists(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** 判断宿主上的目录是否存在；用于按默认位置识别已安装的客户端。 */
function directoryExists(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Qoder 桌面端写入状态文件，CLI 写入 settings.json；任一标记存在都说明客户端已安装。 */
const qoderStatusFiles = [".qoder-app-status.json", ".qoder-app-canary-status.json", ".qoder-app-dev-status.json"];
function qoderPresent(dir) {
  return qoderStatusFiles.some(name => fileExists(join(dir, name))) || fileExists(join(dir, "settings.json"));
}

/** 比较宿主路径；Windows 不区分大小写，避免同一客户端因盘符拼写不同被识别成两个。 */
function samePath(a, b, platform) {
  const normalize = path => platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return normalize(a) === normalize(b);
}

/**
 * 隔离 HOME 下仍允许核心识别和接入的客户端目录变量。默认位置与 Magpie v0.1.4582～v0.1.4597 的 Agent 实现一致，
 * 只列目录型变量；密钥、URL 和行为变量不在此表，仍被 clientPathVars 清空。
 * home 相对宿主主目录，config 相对宿主 XDG 配置根，appData 相对宿主 Roaming 目录。
 */
const clientDirVars = Object.freeze({
  CLAUDE_CONFIG_DIR: { home: [".claude"] },
  CODEX_HOME: { home: [".codex"] },
  COPILOT_HOME: { home: [".copilot"] },
  CLINE_DIR: { home: [".cline"] },
  CURSOR_CONFIG_DIR: { home: [".cursor"] },
  QWEN_HOME: { home: [".qwen"] },
  KIMI_CODE_HOME: { home: [".kimi-code", ".kimi"] },
  GROK_HOME: { home: [".grok"] },
  OPENCLAW_HOME: { home: [".openclaw"] },
  ANTE_HOME: { home: [".ante"] },
  OPENCODE_CONFIG_DIR: { config: ["opencode"] },
  PI_CODING_AGENT_DIR: { home: [".pi/agent"] },
  MAGPIE_ZED_CONFIG_DIR: { win32: { appData: ["Zed"] }, default: { config: ["zed"] } },
});

/** 按平台依次给出某个客户端变量的宿主候选目录，顺序靠前者优先。 */
function clientDirCandidates(spec, { hostHome, configHome, appData, platform }) {
  const roots = { home: hostHome, config: configHome, appData };
  const collect = (value, into) => {
    for (const kind of ["home", "config", "appData"]) {
      if (value[kind]) into.push(...value[kind].map(rel => join(roots[kind], rel)));
    }
  };
  const candidates = [];
  collect(spec, candidates);
  collect(spec[platform] ?? spec.default ?? {}, candidates);
  return candidates;
}

/** 选择要暴露给核心的 Qoder 构建：显式选择优先；否则识别宿主上真实存在的构建并避免两个入口写同一份设置。 */
function qoderClientDirs(host, { home, hostHome, selected, nested, platform }) {
  const privateDir = (name) => join(home, name);
  if (["qoder", "qoder-cn"].includes(selected)) {
    return {
      QODER_CONFIG_DIR: selected === "qoder" ? (absolutePath(host.QODER_CONFIG_DIR) ?? join(hostHome, ".qoder")) : privateDir(".qoder"),
      QODERCN_CONFIG_DIR: selected === "qoder-cn" ? (absolutePath(host.QODERCN_CONFIG_DIR) ?? join(hostHome, ".qoder-cn")) : privateDir(".qoder-cn"),
    };
  }
  if (nested) {
    return {
      QODER_CONFIG_DIR: absolutePath(host.QODER_CONFIG_DIR) ?? privateDir(".qoder"),
      QODERCN_CONFIG_DIR: absolutePath(host.QODERCN_CONFIG_DIR) ?? privateDir(".qoder-cn"),
    };
  }
  // Qoder 会同时把它自己的两个变量指到当前构建的目录；同一目录只暴露目录名对应的一侧。
  let globalDir = absolutePath(host.QODER_CONFIG_DIR) ??
    (qoderPresent(join(hostHome, ".qoder")) ? join(hostHome, ".qoder") : null);
  let chinaDir = absolutePath(host.QODERCN_CONFIG_DIR) ??
    (qoderPresent(join(hostHome, ".qoder-cn")) ? join(hostHome, ".qoder-cn") : null);
  if (globalDir && chinaDir && samePath(globalDir, chinaDir, platform)) {
    if (basename(globalDir).toLowerCase().startsWith(".qoder-cn")) globalDir = null;
    else chinaDir = null;
  }
  return {
    QODER_CONFIG_DIR: globalDir ?? privateDir(".qoder"),
    QODERCN_CONFIG_DIR: chinaDir ?? privateDir(".qoder-cn"),
  };
}

/** 把宿主上已存在的客户端目录交给核心用于识别和接入；未列出的客户端仍回落到私有 HOME。 */
function clientDirectoryOverrides(host, { home, hostHome, nested, platform }) {
  const configHome = absolutePath(host.XDG_CONFIG_HOME) ?? join(hostHome, ".config");
  const appData = absolutePath(host.APPDATA) ?? join(hostHome, "AppData", "Roaming");
  const dirs = {};
  for (const [name, spec] of Object.entries(clientDirVars)) {
    const explicit = absolutePath(host[name]);
    if (explicit) dirs[name] = explicit;
    else if (nested) dirs[name] = "";
    else dirs[name] = clientDirCandidates(spec, { hostHome, configHome, appData, platform }).find(directoryExists) ?? "";
  }
  // Codex 一直使用私有目录承载核心自己的登录；没有宿主目录时保持原有私有位置。
  dirs.CODEX_HOME ||= join(home, ".codex");
  return dirs;
}

/** 原生核心及中间托管器使用相同环境，多次构造仍指向同一私有目录和客户端选择。 */
export function magpieEnvironment(config, baseEnv = process.env) {
  const home = join(config.dataDir, "home");
  const temp = join(home, "tmp");
  // Windows 子进程环境键不分大小写，Node 只传排序后第一个别名；不要把旧拼写一并传入。
  const host = process.platform === "win32"
    ? Object.fromEntries(Object.entries(baseEnv).map(([key, value]) => [key.toUpperCase(), value])) : baseEnv;
  const hostHome = host[process.platform === "win32" ? "USERPROFILE" : "HOME"] || homedir();
  // 显式选择的客户端沿用旧行为；未选择时只暴露宿主上确实存在的客户端，便于核心识别和接入。
  // POSIX supervisor/guardian 只从 argv 重建路径和端口；下一跳靠嵌套标记复用首跳的解析结果。
  const selected = Object.hasOwn(config, "qoderClient") ? config.qoderClient : host.BRIDGE_QODER_CLIENT;
  const nested = host[nestedCoreEnv] === "1";
  const overrides = {
    ...Object.fromEntries(clientPathVars.map(name => [name, ""])),
    ...(["qoder", "qoder-cn"].includes(selected) ? { BRIDGE_QODER_CLIENT: selected } : {}),
    HOME: home, USERPROFILE: home,
    HOMEDRIVE: parse(home).root.replace(/[\\/]$/, ""), HOMEPATH: home.slice(parse(home).root.length - 1),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: config.dataDir, XDG_CACHE_HOME: join(config.dataDir, "cache"),
    XDG_STATE_HOME: join(config.dataDir, "state"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_RUNTIME_DIR: join(home, "runtime"), TMPDIR: temp, TEMP: temp, TMP: temp,
    ...qoderClientDirs(host, { home, hostHome, selected, nested, platform: process.platform }),
    ...clientDirectoryOverrides(host, { home, hostHome, nested, platform: process.platform }),
    [nestedCoreEnv]: "1",
    MAGPIE_ADDR: `${DEFAULT_HOST}:${config.port}`, MAGPIE_WEB_KEY: config.mgmtKey, DO_NOT_TRACK: "1",
  };
  // 仅传递系统运行、桌面会话、地区和网络所需的变量，避免服务商密钥或宿主配置文件路径进入核心。
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|PROGRAMDATA|ELECTRON_RUN_AS_NODE|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|(?:HTTP|HTTPS|ALL|NO)_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i;
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => allowed.test(key)));
  return { ...env, ...overrides };
}
