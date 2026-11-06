/** Windows 系统代理发现与归属同步；隧道回退必须有默认路由证据，空值仍允许核心继承环境代理。 */

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
 * @returns {string|null} 可直接写入 `proxy-url` 的地址；`""` 表示没有可用的 HTTP 代理（允许继承环境代理），
 *   `null` 表示值无法解析，调用方须跳过同步而不是改写配置
 */
export function normalizeProxyServer(server) {
  const text = typeof server === "string" ? server.trim() : "";
  // 不执行 PAC；空地址交由环境代理或用户显式配置决定出口。
  if (!text) return "";
  const entries = text.split(";").map((entry) => entry.trim()).filter(Boolean);
  const byScheme = (name) => {
    const entry = entries.find((item) => item.toLowerCase().startsWith(`${name}=`));
    return entry?.slice(name.length + 1).trim();
  };
  // 无 `=` 的单一地址适用于全部协议；只在没有 https/http 条目时采用。
  const single = entries.length === 1 && !entries[0].includes("=") ? entries[0] : undefined;
  const candidate = byScheme("https") || byScheme("http") || single;
  // 仅有 socks/ftp 条目时不自动转成 HTTP(S) 代理。
  if (!candidate) return "";
  let url;
  try { url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate) ? candidate : `http://${candidate}`); }
  catch { return null; }
  const authority = candidate.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "").split(/[/?#]/, 1)[0];
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !/:\d+$/.test(authority) || url.username || url.password) return null;
  // URL 会剥掉显式的默认端口，不能据此把合法的 :80/:443 当成缺失。
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (port < 1) return null;
  return `${url.protocol}//${url.hostname}:${port}`;
}

/**
 * 由注册表的 ProxyEnable/ProxyServer 计算期望写入的上游代理地址。
 * @param {object} settings 注册表读取结果
 * @param {number|string|boolean} [settings.enable] ProxyEnable；只有明确启用才使用地址
 * @param {string} [settings.server] ProxyServer 原始值
 * @returns {string|null} 语义同 normalizeProxyServer 的返回值
 */
export function desiredProxyUrl({ enable, server } = {}) {
  // 关闭后注册表可能仍有旧地址，不能继续把它作为显式代理。
  if (enable !== true && enable !== 1 && enable !== "1") return "";
  return normalizeProxyServer(server);
}

/**
 * 读取当前 Windows 系统代理设置。任何失败都不抛出：本信息只用于决定是否改写配置，
 * 读取不到时保持现有配置，不能因此让代理无法启动。
 * @param {object} [options] 依赖注入项
 * @param {string} [options.platform=process.platform] Node 平台标识，允许测试注入
 * @param {Function} [options.exec=execFileAsync] PowerShell 执行实现，只供测试注入；生产沿用系统环境
 * @returns {Promise<string|null>} `""` 表示未指定系统代理，`null` 表示系统代理状态不可用
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
 * 非回环地址可能被 TUN 提前应答；TCP 连通不能证明代理协议或上游可用。
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
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  if (!["http:", "https:"].includes(target.protocol) || !host || !Number.isInteger(port) || port < 1 || port > 65535) return false;
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

export async function hasTunnelEgress({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== "win32") return false;
  const script = [
    "$ErrorActionPreference='Stop';",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);",
    "$interfaces=@(foreach($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){",
    "if($n.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up){continue};",
    "$ip=$n.GetIPProperties(); $v4=$null; $v6=$null;",
    "if($n.Supports([System.Net.NetworkInformation.NetworkInterfaceComponent]::IPv4)){$v4=$ip.GetIPv4Properties().Index};",
    "if($n.Supports([System.Net.NetworkInformation.NetworkInterfaceComponent]::IPv6)){$v6=$ip.GetIPv6Properties().Index};",
    "$k=$n.NetworkInterfaceType.ToString()+' '+[string]$n.Description+' '+[string]$n.Name;",
    "$t=$k -match 'PropVirtual|PropNonVirtual|Tunnel|wintun|wireguard|tap-windows|utun|mihomo|clash|sing-box|v2ray|netch|sstap|softether|openvpn|tailscale|zerotier|vpn';",
    "$hasV6=@($ip.UnicastAddresses | Where-Object {$_.Address.AddressFamily -eq 'InterNetworkV6' -and -not $_.Address.IsIPv6LinkLocal -and -not $_.Address.Equals([System.Net.IPAddress]::IPv6Loopback)}).Count -gt 0;",
    "[pscustomobject]@{ipv4=$v4;ipv6=$v6;tunnel=$t;hasIPv6=$hasV6}});",
    "$routes=@(); if(@($interfaces | Where-Object {$_.tunnel}).Count -gt 0){",
    "$routes=@(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object {",
    "$_.State -ne 'Dead' -and $_.DestinationPrefix -in @('0.0.0.0/0','0.0.0.0/1','128.0.0.0/1','::/0','::/1','8000::/1')",
    "} | ForEach-Object {[pscustomobject]@{prefix=$_.DestinationPrefix;index=$_.InterfaceIndex;metric=([long]$_.RouteMetric+[long]$_.InterfaceMetric)}})};",
    "[pscustomobject]@{interfaces=$interfaces;routes=$routes} | ConvertTo-Json -Compress -Depth 4",
  ].join(" ");
  let snapshot;
  try {
    const { stdout } = await exec(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: READ_TIMEOUT_MS, maxBuffer: 32768,
    });
    snapshot = JSON.parse(String(stdout ?? "").replace(/^\uFEFF/, "").trim());
  } catch { return false; }
  if (!Array.isArray(snapshot?.interfaces) || !Array.isArray(snapshot?.routes)) return false;
  const interfaces = snapshot.interfaces.filter((item) => item && typeof item === "object");
  const routes = snapshot.routes.filter((route) => route && Number.isInteger(route.index) && Number.isFinite(route.metric) && route.metric >= 0);
  const routedThroughTunnel = (family, fallback, halves) => {
    const active = new Set(interfaces.map((item) => item[family]).filter(Number.isInteger));
    const tunnels = new Set(interfaces.filter((item) => item.tunnel === true).map((item) => item[family]).filter(Number.isInteger));
    return halves.every((prefix) => {
      const candidates = routes.filter((route) => active.has(route.index) && (route.prefix === prefix || route.prefix === fallback));
      // 两条 /1 比 /0 优先；同优先级存在非隧道出口时不能认定直连安全。
      const specific = candidates.filter((route) => route.prefix === prefix);
      const preferred = specific.length ? specific : candidates;
      const metric = Math.min(...preferred.map((route) => route.metric));
      const best = preferred.filter((route) => route.metric === metric);
      return best.length > 0 && best.every((route) => tunnels.has(route.index));
    });
  };
  return routedThroughTunnel("ipv4", "0.0.0.0/0", ["0.0.0.0/1", "128.0.0.0/1"]) &&
    (!interfaces.some((item) => item.hasIPv6 === true) || routedThroughTunnel("ipv6", "::/0", ["::/1", "8000::/1"]));
}

/** 空值允许继承环境代理；只有路由证据充分的 TUN 回退才返回显式 direct。 */
export async function readEffectiveProxyUrl({ read = readSystemProxyUrl, probe = isProxyReachable, tunnel = hasTunnelEgress } = {}) {
  const url = await read();
  if (url === null || url === "") return url;
  if (await probe(url)) return url;
  return await tunnel() ? "direct" : url;
}

/**
 * 幂等同步 config.yaml 的 `requests.proxy-url`，只改写插件上次写入的值。
 * 用户自行设置的代理（包括核心的 `direct`/`none` 显式直连）一律原样保留，也不接管归属。
 * @param {string} text 现有 config.yaml 文本
 * @param {object} options 同步输入
 * @param {string} options.desired 期望值，`""` 允许继承环境代理，`direct` 显式直连
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
  const owned = current === "" || (recorded !== null && current === recorded);
  if (!owned) return { text };
  if (current === desired) {
    return recorded !== null && recorded !== desired ? { text, recorded: desired } : { text };
  }
  // allowNull 兼容核心或用户留下的 `proxy-url:` 空键与显式 null；这两种形式都表示尚未设置代理。
  const updated = node
    ? replaceConfigScalar(text, PROXY_PATH, desired, { allowNull: true })
    : appendConfigBlock(parsed, ["requests"], "map", (indent) => `${" ".repeat(indent)}proxy-url: ${JSON.stringify(desired)}`);
  return { text: updated, recorded: desired };
}
