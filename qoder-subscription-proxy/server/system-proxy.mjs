/**
 * Windows 系统代理同步。
 *
 * CLIProxyAPI 核心只通过环境变量（HTTPS_PROXY 等）或 `requests.proxy-url` 决定上游出口，
 * 不读取 WinINET 的「系统代理」设置，因此在仅启用系统代理（非 TUN）的机器上模型请求会直连并失败。
 * 本模块在冷启动时把系统代理地址同步进 config.yaml，并保证只改写插件自己写过的值。
 *
 * TUN 模式不需要这个地址：隧道网卡在 IP 层承载全部出口流量，核心直连即可正常工作，
 * 而注册表里的 ProxyEnable/ProxyServer 常与 TUN 并存（客户端两个开关都开，或退出时未清理）。
 * 照抄一个已失效的地址会让核心每次请求都拨号失败——核心的 tls-handshake-timeout-seconds
 * 明确不约束 dial 与 proxy CONNECT，失败还要叠加 requests.retry 的轮次。因此写入前先探测可达性，
 * 且只在「地址不可达 + 隧道网卡在用」时回落直连；地址不可达又没有隧道兜底时维持照写，
 * 因为此时直连同样出不去，而写入能让客户端随后启动时自愈，清空反倒要重启桥才能恢复。
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { join } from "node:path";
import { appendConfigBlock, parseConfigYaml, replaceConfigScalar } from "./config-yaml.mjs";

const execFileAsync = promisify(execFile);
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** 注册表与网卡读取时限；读取慢或失败都按不可用处理，不得拖长或阻塞冷启动。 */
const READ_TIMEOUT_MS = 5000;
/** 代理可达性探测时限；本机监听是毫秒级，该预算只用于兜住被丢包的陈旧地址。 */
const PROBE_TIMEOUT_MS = 1200;
/** 核心与随包示例中的上游代理字段路径。 */
const PROXY_PATH = ["requests", "proxy-url"];

/**
 * 归一化 WinINET 的 ProxyServer 值。
 * 该值可能是单一 `host:port`，也可能是 `http=host:port;https=host:port;socks=host:port` 的分协议形式，
 * 极少数工具还会带上协议前缀。只接受能表达为 `proxy-url` 的 HTTP(S) 代理。
 * @param {string} server 注册表中的原始 ProxyServer 字符串
 * @returns {string|null} 可直接写入 `proxy-url` 的地址；`""` 表示没有可用的 HTTP 代理（应按直连处理），
 *   `null` 表示值无法解析，调用方须跳过同步而不是改写配置
 */
export function normalizeProxyServer(server) {
  const text = typeof server === "string" ? server.trim() : "";
  // 启用系统代理但地址为空通常是「自动配置脚本（PAC）」模式；PAC 需要执行脚本才能解析，按直连处理。
  if (!text) return "";
  const entries = text.split(";").map((entry) => entry.trim()).filter(Boolean);
  const byScheme = (name) => {
    const entry = entries.find((item) => item.toLowerCase().startsWith(`${name}=`));
    return entry?.slice(name.length + 1).trim();
  };
  // 无 `=` 的单一地址适用于全部协议；只在没有 https/http 条目时采用。
  const single = entries.length === 1 && !entries[0].includes("=") ? entries[0] : undefined;
  const candidate = byScheme("https") || byScheme("http") || single;
  // 仅有 socks/ftp 等条目时无法转成核心的 http(s) 代理，同样按直连处理。
  if (!candidate) return "";
  let url;
  try { url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate) ? candidate : `http://${candidate}`); }
  catch { return null; }
  // 端口缺失说明值不是 WinINET 形式；凭据不写入明文配置，两者都视为不可用。
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !url.port || url.username || url.password) return null;
  return `${url.protocol}//${url.hostname}:${url.port}`;
}

/**
 * 由注册表的 ProxyEnable/ProxyServer 计算期望写入的上游代理地址。
 * @param {object} settings 注册表读取结果
 * @param {number|string|boolean} [settings.enable] ProxyEnable；只有明确启用才使用地址
 * @param {string} [settings.server] ProxyServer 原始值
 * @returns {string|null} 语义同 normalizeProxyServer 的返回值
 */
export function desiredProxyUrl({ enable, server } = {}) {
  // ProxyEnable 可能缺失、为字符串或布尔；未启用时无论地址为何都按直连处理。
  if (enable !== true && enable !== 1 && enable !== "1") return "";
  return normalizeProxyServer(server);
}

/**
 * 读取当前 Windows 系统代理设置。任何失败都不抛出：本信息只用于决定是否改写配置，
 * 读取不到时保持现有配置，不能因此让代理无法启动。
 * @param {object} [options] 依赖注入项
 * @param {string} [options.platform=process.platform] Node 平台标识，允许测试注入
 * @param {Function} [options.exec=execFileAsync] PowerShell 执行实现，只供测试注入；生产沿用系统环境
 * @returns {Promise<string|null>} `""` 表示直连，`null` 表示系统代理状态不可用
 */
export async function readSystemProxyUrl({ platform = process.platform, exec = execFileAsync } = {}) {
  // macOS/Linux 没有等价的系统代理注册表；核心自身已读取环境变量代理，插件不额外写入。
  if (platform !== "win32") return "";
  // 脚本内不含任何外部输入，注册表路径为常量；输出走 ConvertTo-Json 避免解析本地化的 reg.exe 文本。
  const script = [
    "$ErrorActionPreference='Stop';",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);",
    "$s=Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
    "$e=0; if($s.ProxyEnable){$e=[int]$s.ProxyEnable}",
    "$v=''; if($s.ProxyServer){$v=[string]$s.ProxyServer}",
    "[pscustomobject]@{enable=$e;server=$v} | ConvertTo-Json -Compress",
  ].join(" ");
  let stdout;
  try {
    ({ stdout } = await exec(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: 32768,
    }));
  } catch { return null; }
  let settings;
  try { settings = JSON.parse(String(stdout ?? "").replace(/^\uFEFF/, "").trim()); }
  catch { return null; }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  return desiredProxyUrl(settings);
}

/**
 * 探测代理地址能否建立 TCP 连接。只验证连通，不发送任何代理协议数据。
 * 回环地址不经路由表也不被隧道网卡捕获，结果可信；非回环地址在 TUN 下会被隧道直接应答而恒为可达，
 * 这种情形无法区分，按可达处理即可——与不探测时的行为一致，不会更差。
 * @param {string} url 期望写入的上游代理地址
 * @param {object} [options] 依赖注入项
 * @param {number} [options.timeout=PROBE_TIMEOUT_MS] 连接时限（毫秒）
 * @param {Function} [options.connect=createConnection] TCP 连接实现，只供测试注入；生产沿用系统环境
 * @returns {Promise<boolean>} 时限内是否连上；地址不可解析或端口非法一律视为不可达，且不抛出
 */
export async function isProxyReachable(url, { timeout = PROBE_TIMEOUT_MS, connect = createConnection } = {}) {
  let target;
  try { target = new URL(url); } catch { return false; }
  // URL 把 IPv6 主机名包在方括号里，net 需要裸地址。
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return false;
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    // 连接、超时、错误、关闭四条路径只结算一次，并释放试探用的套接字。
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(reachable);
    };
    try { socket = connect({ host, port, timeout }); }
    catch { resolve(false); return; }
    socket.once("connect", () => finish(true));
    // timeout 由套接字空闲计时器触发，同时覆盖 DNS 解析挂起与 SYN 被丢弃的地址。
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

/**
 * 判断是否有隧道网卡（TUN/VPN）处于连接状态，即直连是否已被隧道承载。
 * 用 .NET 原生枚举而非 Get-NetRoute：后者要加载 CIM 模块，实测约 3.5 秒，会吃掉冷启动预算；
 * 原生枚举约 0.3 秒，且 Wintun 系适配器统一上报 PropVirtual 类型，不必依赖本地化的适配器名。
 * 只作为「地址不可达」时的兜底判据，因此任何不确定都返回 false，即维持写入系统代理的原有行为。
 * @param {object} [options] 依赖注入项
 * @param {string} [options.platform=process.platform] Node 平台标识，允许测试注入
 * @param {Function} [options.exec=execFileAsync] PowerShell 执行实现，只供测试注入；生产沿用系统环境
 * @returns {Promise<boolean>} 是否检测到在用的隧道网卡
 */
export async function hasTunnelEgress({ platform = process.platform, exec = execFileAsync } = {}) {
  // macOS/Linux 的隧道形态与 Windows 不同，且这两个平台本就不写入系统代理，无需检测。
  if (platform !== "win32") return false;
  // 脚本内不含任何外部输入；关键字覆盖 Wintun/TAP 两类隧道与常见客户端的适配器命名。
  const script = [
    "$ErrorActionPreference='Stop';",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);",
    "$t=$false;",
    "foreach($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){",
    "if($n.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up){continue};",
    "$k=$n.NetworkInterfaceType.ToString()+' '+[string]$n.Description+' '+[string]$n.Name;",
    "if($k -match 'PropVirtual|PropNonVirtual|Tunnel|wintun|wireguard|tap-windows|utun|mihomo|clash|sing-box|v2ray|netch|sstap|softether|openvpn|tailscale|zerotier|vpn'){$t=$true;break}};",
    "[pscustomobject]@{tunnel=$t} | ConvertTo-Json -Compress",
  ].join(" ");
  let stdout;
  try {
    ({ stdout } = await exec(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: 32768,
    }));
  } catch { return false; }
  try { return JSON.parse(String(stdout ?? "").replace(/^\uFEFF/, "").trim())?.tunnel === true; }
  catch { return false; }
}

/**
 * 计算冷启动实际应写入的上游代理地址：在系统代理值之上叠加可达性与隧道判断。
 * @param {object} [options] 依赖注入项
 * @param {Function} [options.read=readSystemProxyUrl] 系统代理读取实现，只供测试注入
 * @param {Function} [options.probe=isProxyReachable] 代理可达性探测实现，只供测试注入
 * @param {Function} [options.tunnel=hasTunnelEgress] 隧道网卡检测实现，只供测试注入
 * @returns {Promise<string|null>} 语义同 readSystemProxyUrl：`""` 表示直连，`null` 表示状态不可用
 */
export async function readEffectiveProxyUrl({ read = readSystemProxyUrl, probe = isProxyReachable, tunnel = hasTunnelEgress } = {}) {
  const url = await read();
  // null 是状态不可用（保持现有配置），"" 是本就直连（TUN 单开属于此类）；两者都不必探测。
  if (url === null || url === "") return url;
  if (await probe(url)) return url;
  // 不可达且隧道在用才回落直连：此时直连确定可用，而死地址只会让核心反复拨号失败。
  return await tunnel() ? "" : url;
}

/**
 * 幂等同步 config.yaml 的 `requests.proxy-url`，只改写插件上次写入的值。
 * 用户自行设置的代理（包括核心的 `direct`/`none` 显式直连）一律原样保留，也不接管归属。
 * @param {string} text 现有 config.yaml 文本
 * @param {object} options 同步输入
 * @param {string} options.desired 期望值，`""` 表示直连
 * @param {string|null} options.recorded 上次由插件写入并记录的值；`null` 表示尚无归属记录
 * @returns {{text: string, recorded?: string}} `recorded` 存在时表示归属记录需要更新为该值
 */
export function syncProxyUrl(text, { desired, recorded }) {
  const parsed = parseConfigYaml(text);
  const key = JSON.stringify(PROXY_PATH);
  const node = parsed.nodes.get(key);
  // 映射或列表形式的 proxy-url 不是插件写入的标量，视为用户自管结构，既不改写也不接管。
  if (node && node.kind !== null) return { text };
  const value = parsed.values.get(key);
  // 缺失与空键（`proxy-url:`）都表示尚未设置；数字、布尔等标量同样不是插件写入的形式。
  const current = typeof value === "string" ? value : value === undefined || value === null ? "" : null;
  if (current === null) return { text };
  // 无归属记录时只接管空值，避免覆盖用户在本功能之前手工写入的代理。
  const owned = recorded === null ? current === "" : current === recorded;
  if (!owned) {
    // 用户手填的值恰好等于系统代理时接管归属，之后跟随系统设置变化；配置内容本身不变。
    return recorded === null && desired !== "" && current === desired ? { text, recorded: desired } : { text };
  }
  if (current === desired) return { text };
  // allowNull 兼容核心或用户留下的 `proxy-url:` 空键与显式 null；这两种形式都表示尚未设置代理。
  const updated = node
    ? replaceConfigScalar(text, PROXY_PATH, desired, { allowNull: true })
    : appendConfigBlock(parsed, ["requests"], "map", (indent) => `${" ".repeat(indent)}proxy-url: ${JSON.stringify(desired)}`);
  return { text: updated, recorded: desired };
}
