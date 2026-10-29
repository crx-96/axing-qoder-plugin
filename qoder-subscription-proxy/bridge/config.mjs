/** 拉起器配置：仅允许 IPv4 回环监听，使用插件专属稳定数据目录，API 密钥仅供本地使用。 */

import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getCoreRelease, resolveCoreBinaryPath } from "./core-runtime.mjs";
import { parseConfigYaml } from "./config-yaml.mjs";

/** 仅支持此回环地址，不接受 localhost、IPv6 或任意网络接口。 */
export const DEFAULT_HOST = "127.0.0.1";
/** 默认 HTTP 端口，避开旧桥 8787 与普通 CLIProxyAPI 8317；环境变量仍须为合法十进制端口。 */
export const DEFAULT_PORT = 19787;
/** 与插件 manifest 保持一致；版本升级不改变专属数据目录。 */
export const PLUGIN_VERSION = "0.2.5";
/** 用户指定的公共管理密码，仅限回环管理接口；不能用作客户端 API 密钥。 */
const DEFAULT_MGMT_KEY = "123456";

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

/** 读取持久默认密钥并收紧文件权限；不传播可能包含密钥的 JSON 解析错误。 */
async function readSecrets(path) {
  const text = await readFile(path, "utf-8");
  let secrets;
  try {
    secrets = JSON.parse(text);
    requireString(secrets?.apiKey, "apiKey");
    // 持久文件仅保存 API 密钥，拒绝旧桥密钥格式以及复用公共管理密码的值。
    if (Object.keys(secrets).length !== 1 || secrets.apiKey === DEFAULT_MGMT_KEY) throw new Error();
  } catch {
    throw new Error("launcher-secrets.json 格式无效；请检查本地密钥文件，不要直接删除或轮换密钥。");
  }
  // POSIX 下强制仅所有者读写；Windows 的实际访问权限仍由所在目录 ACL 约束。
  await chmod(path, 0o600);
  return secrets;
}

/**
 * 幂等创建默认密钥。先完整写入私有临时文件，再用硬链接原子发布，避免读到半份 JSON。
 * link 的 EEXIST 表示另一个进程胜出，必须读取胜者，绝不能用 rename 覆盖它。
 */
async function loadSecrets(dataDir) {
  const path = join(dataDir, "launcher-secrets.json");
  try {
    try {
      return await readSecrets(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporaryPath = join(dataDir, `.launcher-secrets-${randomBytes(16).toString("hex")}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      // 客户端密钥使用独立随机值；公共管理密码不持久化，环境覆盖也不改写默认密钥。
      await handle.writeFile(JSON.stringify({
        apiKey: randomBytes(32).toString("hex"),
      }) + "\n", "utf-8");
      await handle.sync();
      await handle.close();
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      await handle.close();
      await unlink(temporaryPath);
    }
    return await readSecrets(path);
  } catch {
    // 文件系统错误可能包含输入路径，JSON 错误可能包含密钥，两者均不透传。
    throw new Error("无法安全加载 launcher-secrets.json；请检查文件格式、权限及文件系统硬链接支持，勿直接删除已有密钥。");
  }
}

/**
 * 加载配置，不启动进程、不创建 config.yaml，也不复制旧插件账号；本插件升级沿用专属目录。
 * 支持 BRIDGE_BIN / DATA_DIR / HOST / PORT / API_KEY（均带 BRIDGE_ 前缀）。
 * BRIDGE_MGMT_KEY 不可覆盖公共管理密码，仅容许未设置或精确设置为 123456。
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
  if (mgmtKey !== undefined && mgmtKey !== DEFAULT_MGMT_KEY) {
    throw new Error("BRIDGE_MGMT_KEY 不允许覆盖固定管理密码；请移除此环境变量。");
  }
  if (apiKey === DEFAULT_MGMT_KEY) throw new Error("BRIDGE_API_KEY 不得复用公共管理密码。");
  const dataDir = resolve(data ?? join(homedir(), ".qoder", "qoder-subscription-proxy", "data"));
  const secrets = await loadSecrets(dataDir);
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
    /** 固定公共管理密码，仅供回环接口；上游可在 YAML 内将其哈希化。 */
    mgmtKey: DEFAULT_MGMT_KEY,
    /** 不包含密钥的管理面板入口。 */
    managementUrl: `http://${host}:${port}/management.html`,
    /** OpenAI 兼容接口地址。 */
    endpoint: `http://${host}:${port}/v1`,
    /** 供生命周期管理使用的跨进程互斥锁。 */
    lockPath: join(dataDir, "bridge.lock"),
    /** 用户主动暂停自动启动的持久标记。 */
    pausedPath: join(dataDir, "bridge.paused"),
    /** 生成图片的插件专属输出目录，升级不改变位置。 */
    imagesDir: join(dataDir, "generated"),
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

/** 生成最小 v8 配置，所有字符串均转义；由调用方在跨进程锁内以 wx/0600 创建文件。 */
export function renderConfigYaml(config) {
  return [
    "# 由 qoder-subscription-proxy 插件生成；手工修改核心字段时须同步环境变量。",
    "config-version: 8",
    "server:",
    `  host: ${yamlString(config.host)}`,
    `  port: ${config.port}`,
    "management:",
    "  # 固定公共密码仅限本机管理，上游启动后可能改写为哈希",
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
    "multimedia:",
    "  # 不自动注入原生图片工具，仍保留独立图片生成端点",
    '  disable-image-generation: "passthrough"',
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
  // 固定公共管理密码只能用于本机；缺失或字符串形式的 false 也不能沿用上游默认行为。
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
