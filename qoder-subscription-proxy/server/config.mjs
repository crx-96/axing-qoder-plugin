/** 拉起器配置：仅允许 IPv4 回环监听，使用插件专属稳定数据目录，API 密钥仅供本地使用。 */

import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { withLifecycleLock } from "./lifecycle-lock.mjs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getCoreRelease, resolveCoreBinaryPath } from "./core-runtime.mjs";
import { parseConfigYaml } from "./config-yaml.mjs";

/** 仅支持此回环地址，不接受 localhost、IPv6 或任意网络接口。 */
export const DEFAULT_HOST = "127.0.0.1";
/** 模型 API 固定端口；跨版本保持不变，用户客户端地址与核心配置均依赖该常量。 */
export const DEFAULT_PORT = 19787;
/** 管理页网关固定端口：免密管理入口与连接器授权元数据共用；与模型端口不同且跨版本保持不变。 */
export const MANAGEMENT_PORT = 19788;
/** 与插件 manifest 保持一致；版本升级不改变专属数据目录与上述固定端口。 */
export const PLUGIN_VERSION = "1.0.4";
/** 旧版公共密码仅用于识别需要升级的文件和兼容环境配置。 */
const LEGACY_MGMT_KEY = "123456";

/** 校验非空字符串；错误只包含固定字段名，不回显用户值。 */
function requireString(value, name) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${name} 必须是非空且不含 NUL 的字符串。`);
  }
  return value;
}

/** 未设置的环境变量保持 undefined；显式空值或错误类型不能被默认值掩盖。 */
function envString(env, name) {
  return env[name] === undefined ? undefined : requireString(env[name], name);
}

/** 严格解析端口，不接受空白、符号、小数、指数或尾随字符，也不回退非法值。 */
function parsePort(raw) {
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw new Error("BRIDGE_PORT 必须是 1~65535 的纯十进制整数。");
  }
  return Number(raw);
}

/** 校验 HTTP Bearer 值，避免接受核心可以保存但无法发到请求头的字符。 */
function validClientKey(value) {
  return typeof value === "string" && /^[!-~]+$/.test(value) && value !== LEGACY_MGMT_KEY;
}

/** 只接受旧版单密钥或本版本的双密钥结构；错误不暴露文件内容。 */
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

/** 完整写入再原子发布。首次安装只接受一个创建者，旧文件替换仅在生命周期锁内调用。 */
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

/** 保留旧 API key，首次迁移时生成单独管理密钥；同时升级的多个宿主读取同一份结果。 */
async function loadSecrets(dataDir, port) {
  const file = join(dataDir, "launcher-secrets.json");
  try {
    let current;
    try { current = await readSecrets(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await publishSecrets(file, randomBytes(32).toString("hex"), false);
      current = await readSecrets(file);
    }
    if (current.mgmtKey && current.mgmtKey !== LEGACY_MGMT_KEY) return current;
    return await withLifecycleLock({ dataDir, port }, async () => {
      // 重读胜者；只有仍为历史格式时才替换，不覆盖其他会话生成的管理密钥。
      const previous = await readSecrets(file);
      if (!previous.mgmtKey || previous.mgmtKey === LEGACY_MGMT_KEY) await publishSecrets(file, previous.apiKey, true);
      return readSecrets(file);
    });
  } catch {
    throw new Error("无法安全加载 launcher-secrets.json；请检查文件格式、访问权限及文件系统硬链接支持。");
  }
}

/**
 * 加载配置，不启动进程、不创建 config.yaml，也不复制旧插件账号；本插件升级沿用专属目录。
 * 支持 BRIDGE_BIN / DATA_DIR / HOST / PORT / API_KEY（均带 BRIDGE_ 前缀）。
 * BRIDGE_MGMT_KEY 旧管理密码环境值仅作兼容占位，实际管理密钥由本机生成，仅容许未设置或精确设置为 123456。
 * @param {object} options 配置输入
 * @param {string} options.pluginRoot 插件根目录，相对路径会解析为绝对路径
 * @param {NodeJS.ProcessEnv} [options.env=process.env] 环境变量，只接受字符串或 undefined
 * @param {string} [options.platform=process.platform] Node 平台标识，允许测试注入，不从环境变量读取
 * @param {string} [options.arch=process.arch] Node 进程架构；不按宿主硬件猜测或回退到其他架构
 * @returns {Promise<object>} 含内部密钥的运行配置，禁止整对象返回 MCP 工具或写日志
 */
export async function loadConfig({ pluginRoot, env = process.env, platform = process.platform, arch = process.arch }) {
  requireString(pluginRoot, "pluginRoot");
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("env 必须是环境变量对象。");
  }
  // 在任何文件写入之前验证全部输入；覆盖核心路径也不能绕过平台/架构支持检查。
  const core = getCoreRelease({ platform, arch });
  const bin = envString(env, "BRIDGE_BIN");
  const data = envString(env, "BRIDGE_DATA_DIR");
  const host = envString(env, "BRIDGE_HOST") ?? DEFAULT_HOST;
  const port = parsePort(envString(env, "BRIDGE_PORT"));
  const apiKey = envString(env, "BRIDGE_API_KEY");
  const mgmtKey = envString(env, "BRIDGE_MGMT_KEY");
  if (host !== DEFAULT_HOST) throw new Error("BRIDGE_HOST 仅允许 127.0.0.1 回环地址。");
  if (mgmtKey !== undefined && mgmtKey !== LEGACY_MGMT_KEY) {
    throw new Error("BRIDGE_MGMT_KEY 不允许覆盖本机生成的管理密码；请移除此环境变量。");
  }
  if (apiKey !== undefined && !validClientKey(apiKey)) throw new Error("BRIDGE_API_KEY 必须是可用于 HTTP 的可见 ASCII 字符，不含空格，且不能复用旧公共密码。");
  const dataDir = resolve(data ?? join(homedir(), ".qoder", "qoder-subscription-proxy", "data"));
  const secrets = await loadSecrets(dataDir, port);
  if (apiKey === secrets.mgmtKey) throw new Error("BRIDGE_API_KEY 不能与管理密钥相同。");
  const config = {
    /** 默认核心位于稳定缓存；BRIDGE_BIN 只覆盖路径，不隐式下载或替换自定义程序。 */
    binPath: bin ? resolve(bin) : resolveCoreBinaryPath({ dataDir, platform, arch }),
    /** 固定版本的当前平台下载清单；null 表示自定义核心，不归下载器管理。 */
    core: bin ? null : core,
    /** 插件专属稳定运行数据目录，绝对路径；升级保留已有授权。 */
    dataDir,
    /** 桥进程读取的 v8 YAML 文件。 */
    configPath: join(dataDir, "config.yaml"),
    /** 本插件 OAuth 登录结果目录；升级沿用，但不从旧插件复制。 */
    authDir: join(dataDir, "auths"),
    /** 本拉起器的进程记录文件。 */
    pidPath: join(dataDir, "bridge.pid"),
    /** 固定 IPv4 回环地址。 */
    host,
    /** 经严格验证的整数监听端口。 */
    port,
    /** 客户端密钥，仅内部使用；环境变量优先于持久默认值。 */
    apiKey: apiKey ?? secrets.apiKey,
    /** 按安装持久保存的管理密钥，独立于模型 API Key；核心启动后可在 YAML 中保存其哈希。 */
    mgmtKey: secrets.mgmtKey,
    /** 核心原生管理面板，供手动登录；免密入口由连接器授权按钮或 bridge_open_management 打开。 */
    managementUrl: `http://${host}:${port}/management.html`,
    /** OpenAI 兼容接口地址。 */
    endpoint: `http://${host}:${port}/v1`,
    /** 供生命周期管理使用的跨进程互斥锁。 */
    lockPath: join(dataDir, "bridge.lock"),
    /** 用户主动暂停自动启动的持久标记。 */
    pausedPath: join(dataDir, "bridge.paused"),
    /** 插件上次写入 requests.proxy-url 的值；用于区分系统代理同步结果与用户自管代理。 */
    proxyStatePath: join(dataDir, "bridge.proxy"),
  };
  // 既有 YAML 不能静默覆盖本次环境输入；创建/启动锁内仍需再次核对以消除检查后竞争。
  let text;
  try {
    text = await readFile(config.configPath, "utf-8");
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("无法读取已有 config.yaml；请检查文件权限。");
  }
  if (text !== undefined) validateExistingConfig(config, text);
  return config;
}

/** JSON 双引号转义是 YAML 子集；额外转义 YAML 会折叠的 Unicode 换行及禁用控制字符。 */
function yamlString(value) {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** 插件生成配置的文件头，仅说明来源，不据此覆盖用户设置。 */
const CONFIG_HEADER = "# 由 qoder-subscription-proxy 插件生成；手工修改核心字段时须同步环境变量。";

/**
 * 生成含本机安全字段的 v8 基础配置。
 * 重试、冷却、心跳等请求参数一律沿用核心上游默认值，插件不写入也不迁移这些字段；
 * 用户如需调整请在管理页或 config.yaml 中自行设置。
 */
export function renderConfigYaml(config) {
  return [
    CONFIG_HEADER,
    "config-version: 8",
    "server:",
    `  host: ${yamlString(config.host)}`,
    `  port: ${config.port}`,
    "management:",
    "  # 独立管理密钥仅限本机管理，上游启动后可能改写为哈希",
    `  secret-key: ${yamlString(config.mgmtKey)}`,
    "  allow-remote: false",
    "  # 保持内置管理面板可用；字段与随包上游 v8 示例一致",
    "  disable-control-panel: false",
    "  # 固定随包管理页，避免上游自动更新覆盖 Antigravity 兼容补丁",
    "  disable-auto-update-panel: true",
    "access:",
    "  api-keys:",
    `    - ${yamlString(config.apiKey)}`,
    "oauth:",
    `  auth-dir: ${yamlString(config.authDir)}`,
    "",
  ].join("\n");
}

/**
 * 核对现有 YAML 的版本、监听、远程管理禁用、客户端密钥与授权目录；失败仅报告固定字段名。
 * 识别块映射及标量/映射列表（含无额外缩进式列表），以兼容管理页保存的模型别名与供应商配置。
 * 不比较管理密钥或其哈希，不改写 YAML，也不从 YAML 反向覆盖环境配置。
 * @param {object} config loadConfig 返回的运行配置
 * @param {string} text 已有 config.yaml 文本，禁止进入日志或异常信息
 */
export function validateExistingConfig(config, text) {
  const { values } = parseConfigYaml(text);
  // 仅比较明确解析到的值，缺失字段与不一致字段均阻止启动，绝不回退上游默认监听。
  if (values.get(JSON.stringify(["config-version"])) !== 8) throw new Error("config.yaml 必须使用 config-version: 8。");
  if (values.get(JSON.stringify(["server", "host"])) !== DEFAULT_HOST || config.host !== DEFAULT_HOST) {
    throw new Error("config.yaml 的 server.host 必须与 BRIDGE_HOST 一致且为 127.0.0.1。");
  }
  if (values.get(JSON.stringify(["server", "port"])) !== config.port) {
    throw new Error("config.yaml 的 server.port 与 BRIDGE_PORT 不一致或缺失；请同步配置后重试。");
  }
  // 管理端只能用于本机；缺失或字符串形式的 false 也不能沿用上游默认行为。
  if (values.get(JSON.stringify(["management", "allow-remote"])) !== false) {
    throw new Error("config.yaml 的 management.allow-remote 必须明确为 false；禁止远程管理。");
  }
  const keys = values.get(JSON.stringify(["access", "api-keys"]));
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string") || !keys.includes(config.apiKey)) {
    throw new Error("config.yaml 的 access.api-keys 未包含当前 BRIDGE_API_KEY；请同步本地配置后重试。");
  }
  const authDir = values.get(JSON.stringify(["oauth", "auth-dir"]));
  if (typeof authDir !== "string" || !isAbsolute(authDir) || resolve(authDir) !== resolve(config.authDir)) {
    throw new Error("config.yaml 的 oauth.auth-dir 与当前数据目录不一致或缺失；禁止隐式复用其他凭据目录。");
  }
}
