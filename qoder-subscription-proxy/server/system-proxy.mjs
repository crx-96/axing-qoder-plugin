/** 为核心下载发现 Windows 系统代理；隧道回退必须有默认路由证据，不修改核心配置或宿主环境。 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { join } from "node:path";

/** 不经过 shell 的异步子进程执行器，供系统代理与路由读取复用。 */
const execFileAsync = promisify(execFile);
/** 系统自带 PowerShell 的绝对路径，不依赖 PATH 选择可执行文件。 */
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** 注册表与网卡读取时限；读取慢或失败都按不可用处理，不得拖长或阻塞冷启动。 */
const READ_TIMEOUT_MS = 5000;
/** 代理可达性探测时限；本机监听是毫秒级，该预算只用于兜住被丢包的陈旧地址。 */
const PROBE_TIMEOUT_MS = 1200;

/**
 * 归一化 WinINET 的 ProxyServer 值。
 * 该值可能是单一 `host:port`，也可能是 `http=host:port;https=host:port;socks=host:port` 的分协议形式，
 * 极少数工具还会带上协议前缀。只接受用于核心下载的 HTTP(S) 代理。
 * @param {string} server 注册表中的原始 ProxyServer 字符串
 * @returns {string|null} 可传给下载器的代理地址；`""` 表示没有可用的 HTTP 代理（不覆盖环境代理），
 *   `null` 表示值无法解析，调用方不应将其推断为显式直连
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
 * 由注册表的 ProxyEnable/ProxyServer 计算下载器可使用的系统代理地址。
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
 * 读取当前 Windows 系统代理设置。任何失败都不抛出：本信息只供下载器选择代理，
 * 读取不到时返回不可用状态，不修改核心配置或宿主环境。
 * @param {object} [options] 依赖注入项
 * @param {string} [options.platform=process.platform] Node 平台标识，允许测试注入
 * @param {Function} [options.exec=execFileAsync] PowerShell 执行实现，只供测试注入；生产沿用系统环境
 * @returns {Promise<string|null>} `""` 表示未指定系统代理，`null` 表示系统代理状态不可用
 */
export async function readSystemProxyUrl({ platform = process.platform, exec = execFileAsync } = {}) {
  // macOS/Linux 不读取 Windows 注册表；curl 下载器保留自身的环境代理处理。
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
 * @param {string} url 待验证的下载代理地址
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

/**
 * 读取 Windows 活跃网卡和路由，确认可用 IP 协议族的默认出口均由隧道承载。
 * @param {object} [options] 平台与进程执行依赖；测试可注入，不改变系统路由
 * @param {string} [options.platform=process.platform] Node 平台标识；非 Windows 返回 false
 * @param {Function} [options.exec=execFileAsync] PowerShell 执行实现
 * @returns {Promise<boolean>} 仅证据完整时返回 true；读取失败或路由有歧义时返回 false
 */
export async function hasTunnelEgress({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== "win32") return false;
  // 只读取活跃网卡与默认路由候选；网卡名称疑似隧道还不足以认定出口已被接管。
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
  /** 按更具体前缀和路由指标选择出口；两半地址空间的最优候选必须全部属于隧道。 */
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
