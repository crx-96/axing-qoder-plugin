import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getCoreRelease, resolveCoreBinaryPath } from "./core-runtime.mjs";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 19787;
export const MANAGEMENT_PORT = 19788;
export const PLUGIN_VERSION = "1.1.4";
const LEGACY_MGMT_KEY = "123456";

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${name} 必须是非空且不含 NUL 的字符串。`);
  }
  return value;
}

function envString(env, name) {
  return env[name] === undefined ? undefined : requireString(env[name], name);
}

function parsePort(raw, name, fallback) {
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error(`${name} 必须是 1~65535 的纯十进制整数。`);
  }
  return Number(raw);
}

function validClientKey(value) {
  return typeof value === "string" && /^[!-~]+$/.test(value) && value !== LEGACY_MGMT_KEY;
}

async function readSecrets(file) {
  const secrets = JSON.parse(await readFile(file, "utf8"));
  if (!validClientKey(secrets?.apiKey) || Object.keys(secrets).some(k => !["mgmtKey", "apiKey"].includes(k)) ||
      (Object.hasOwn(secrets, "mgmtKey") && secrets.mgmtKey !== LEGACY_MGMT_KEY &&
       (typeof secrets.mgmtKey !== "string" || !/^[a-f0-9]{64}$/.test(secrets.mgmtKey) || secrets.apiKey === secrets.mgmtKey))) {
    throw new Error("本地凭据格式无效。");
  }
  await chmod(file, 0o600);
  return secrets;
}

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

async function loadSecrets(dataDir, port) {
  const file = join(dataDir, "launcher-secrets.json");
  try {
    return await withLifecycleLock({ dataDir, port }, async () => {
      let current;
      try { current = await readSecrets(file); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        await publishSecrets(file, randomBytes(32).toString("hex"), false);
        current = await readSecrets(file);
      }
      if (current.mgmtKey && current.mgmtKey !== LEGACY_MGMT_KEY) return current;
      await publishSecrets(file, current.apiKey, true);
      return readSecrets(file);
    });
  } catch (error) {
    throw Object.assign(new Error("无法安全加载 launcher-secrets.json；请检查文件格式、访问权限及文件系统硬链接支持。"), {
      code: error.code, syscall: error.syscall,
    });
  }
}

export async function loadConfig({ pluginRoot, env = process.env, platform = process.platform, arch = process.arch }) {
  requireString(pluginRoot, "pluginRoot");
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env 必须是环境变量对象。");
  const core = getCoreRelease({ platform, arch });
  const bin = envString(env, "BRIDGE_BIN");
  const data = envString(env, "BRIDGE_DATA_DIR");
  const host = envString(env, "BRIDGE_HOST") ?? DEFAULT_HOST;
  const port = parsePort(envString(env, "BRIDGE_PORT"), "BRIDGE_PORT", DEFAULT_PORT);
  const managementPort = parsePort(envString(env, "BRIDGE_MANAGEMENT_PORT"), "BRIDGE_MANAGEMENT_PORT", MANAGEMENT_PORT);
  const apiKey = envString(env, "BRIDGE_API_KEY");
  const mgmtKey = envString(env, "BRIDGE_MGMT_KEY");
  if (host !== DEFAULT_HOST) throw new Error("BRIDGE_HOST 仅允许 127.0.0.1 回环地址。");
  if (port === managementPort) throw new Error("模型端口与管理端口不能相同。");
  if (mgmtKey !== undefined && mgmtKey !== LEGACY_MGMT_KEY) {
    throw new Error("BRIDGE_MGMT_KEY 不允许覆盖本机生成的管理密码；请移除此环境变量。");
  }
  if (apiKey !== undefined && !validClientKey(apiKey)) throw new Error("BRIDGE_API_KEY 必须是可用于 HTTP 的可见 ASCII 字符，不含空格，且不能复用旧公共密码。");
  const dataDir = resolve(data ?? join(homedir(), ".qoder", "qoder-subscription-proxy", "data"));
  const secrets = await loadSecrets(dataDir, port);
  if (apiKey === secrets.mgmtKey) throw new Error("BRIDGE_API_KEY 不能与管理密钥相同。");
  const config = {
    pluginRoot: resolve(pluginRoot),
    binPath: bin ? resolve(bin) : resolveCoreBinaryPath({ dataDir, platform, arch }),
    core: bin ? null : core,
    dataDir,
    profileDir: join(dataDir, "magpie"),
    configPath: join(dataDir, "magpie", "settings.json"),
    pidPath: join(dataDir, "bridge.pid"),
    lockPath: join(dataDir, "bridge.lock"),
    pausedPath: join(dataDir, "bridge.paused"),
    host, port, managementPort,
    apiKey: apiKey ?? secrets.apiKey,
    mgmtKey: secrets.mgmtKey,
    endpoint: `http://${host}:${port}/v1`,
    managementUrl: `http://${host}:${managementPort}/`,
  };
  try { validateMagpieSettings(config, await readFile(config.configPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return config;
}

export function validateMagpieSettings(config, text) {
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error("Magpie settings.json 不是有效 JSON。"); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Magpie settings.json 必须是对象。");
  if (settings.lan === true || settings.https === true || settings.port !== config.port) {
    throw new Error("Magpie 必须使用插件指定的本机 HTTP 端口，不能开启局域网共享或更换端口。");
  }
  if (settings.noAutoUpdate !== true || settings.noAutoDownload !== true || settings.autoRestart === true) {
    throw new Error("随包 Magpie 的自动更新和下载必须关闭，由插件版本统一升级。");
  }
  return settings;
}

export async function ensureMagpieConfig(config) {
  // Magpie 的 portable 目录优先于 XDG；不能让自定义核心绕过插件数据隔离。
  for (const name of ["data", ".portable"]) {
    try {
      await lstat(join(dirname(config.binPath), name));
      throw new Error("核心旁存在 data 或 .portable，可能覆盖 Magpie 配置隔离；请将 BRIDGE_BIN 放在独立的程序目录。");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
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
  validateMagpieSettings(config, await readFile(config.configPath, "utf8"));
  await chmod(config.configPath, 0o600);
}

export function magpieArguments(config) {
  return ["serve", `--web=${DEFAULT_HOST}:${config.managementPort}`];
}

export function magpieEnvironment(config, baseEnv = process.env) {
  // 订阅开关由用户在隐私设置中控制；MAGPIE_NO_ACCOUNTS 会连手动登录一起锁死。
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !/^MAGPIE_/i.test(key)));
  return {
    ...env,
    XDG_CONFIG_HOME: config.dataDir,
    XDG_CACHE_HOME: join(config.dataDir, "cache"),
    XDG_STATE_HOME: join(config.dataDir, "state"),
    MAGPIE_ADDR: `${DEFAULT_HOST}:${config.port}`,
    MAGPIE_WEB_KEY: config.mgmtKey,
    DO_NOT_TRACK: "1",
  };
}
