/* global pluginVersion, createUpdatePanel, createInstalledCoresPanel, createPortPanel */
/** 面板中的固定控件。 */
const $ = selector => document.querySelector(selector);
/** JSON-RPC 请求 ID 对应的等待者与超时计时器。 */
const pending = new Map();
/** 握手和只读查询的等待上限，单位毫秒。 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 包含下载预算与进程启动时间的显式启动等待上限。 */
const START_TIMEOUT_MS = 11 * 60_000;
/** 上一次查询完成到下一次进度查询之间的毫秒数。 */
const POLL_MS = 1200;
/** 递增的请求 ID 跨重连也不会复用。 */
let sequence = 0;
/** 宿主连接状态，closed 为终态。 */
let connection = "idle";
/** 最近一次通过基本结构校验的状态快照。 */
let snapshot = null;
/** 用户发起的互斥操作，空字符串表示当前没有写操作。 */
let action = "";
/** 重试前的快照，用来识别宿主在新任务开始前仍可能返回的旧失败。 */
let startBaseline = null;
/** 本次重试是否已观察到新一轮准备。 */
let sawPreparation = false;
/** 正在等待的唯一状态读取，自动与手动刷新共用。 */
let reading = null;
/** 启动失败后使更早发出的查询失效，避免迟到的下载进度覆盖错误。 */
let generation = 0;
/** 仅在准备状态且没有在途读取时设置的一次性计时器。 */
let pollTimer;
/** 当前显示状态的语义，同时决定是否继续轮询。 */
let tone = "idle";
/** 向嵌入本页的宿主发送协议消息。 */
const send = message => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");

/** 仅在内容变化时更新文本，避免连续下载快照重复触发状态播报。 */
function text(selector, value) {
  const node = $(selector);
  if (connection !== "closed" && node.textContent !== value) node.textContent = value;
}

/** 只接受预期的响应。请求超时不会重放写操作。 */
function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (connection === "closed" || pending.size >= 6) return Promise.reject(Error("应用未连接，请重新打开。"));
  const id = `management-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("结果未知，请刷新状态确认。"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch { clearTimeout(timer); pending.delete(id); reject(Error("无法连接 Qoder，请重新打开应用。")); }
  });
}

/** 错误摘要只选取已知特征，输出本页固定的原因和恢复操作。原始诊断可能含路径、凭据或堆栈。 */
const remedies = [
  [/CORE_ARCHIVE_HASH|下载 SHA256 不匹配/, "下载包 SHA256 不匹配，已阻止安装。检查下载代理或网络后重试。"],
  [/CORE_BINARY_HASH|核心文件 SHA256 不匹配|核心摘要不一致/, "核心文件 SHA256 不匹配。请更新插件或核对下载来源后重试。"],
  [/CORE_SIZE|下载大小与固定资产不符|超过安全大小限制/, "下载文件大小与发行清单不符或超限，请核对下载来源或更新插件。"],
  [/CORE_ARCHIVE\b|文件类型不受支持或不安全/, "下载包格式不安全，请更新插件后重试。"],
  [/CORE_PATH|缓存路径包含/, "缓存路径不安全，请改用独立的普通用户目录后重试。"],
  [/CORE_CLEANUP|无法清理本次/, "临时文件未能清理，请检查缓存目录权限后重试。"],
  [/CORE_PUBLISH|无法安全发布/, "无法写入核心缓存，请检查目录权限和文件占用后重试。"],
  [/CORE_CACHE|无法读取核心缓存/, "无法读取核心缓存，请检查缓存目录权限后重试。"],
  [/CORE_LOCK|核心下载互斥|另一会话正在启动或停止/, "另一任务正在使用核心或锁，请稍后重试并保留锁文件。"],
  [/CORE_CONFIG|核心下载配置无效/, "核心下载配置无效，请检查缓存目录配置或更新插件。"],
  [/CORE_CANCELLED|核心下载已取消/, "核心准备已取消，可在需要时重新启动。"],
  [/CORE_TIMEOUT|核心准备超过/, "核心准备超时，请检查网络和下载代理后重试。"],
  [/CORE_CURL|无法运行系统 curl/, "无法运行系统 curl，请确认 curl 可用后重试。"],
  [/CORE_DOWNLOAD|核心下载失败/, "核心下载失败，请检查网络及 QODER_HTTP_PROXY、HTTPS_PROXY 或 NO_PROXY 后重试。"],
  [/模型端口与管理端口不能相同/, "模型和管理端口发生冲突，请将 BRIDGE_PORT 和 BRIDGE_MANAGEMENT_PORT 设为不同端口后重试。"],
  [/BRIDGE_(?:MANAGEMENT_)?PORT 必须/, "端口格式无效，请将对应端口设为 1 到 65535 的十进制整数后重试。"],
  [/BRIDGE_HOST/, "BRIDGE_HOST 仅支持本机回环地址，请改为 127.0.0.1 后重试。"],
  [/不能开启局域网共享/, "请在 Magpie 设置中关闭局域网共享，使用插件指定的本机端口。"],
  [/BRIDGE_MGMT_KEY 不允许覆盖/, "请移除 BRIDGE_MGMT_KEY，让插件生成本机管理凭据后重试。"],
  [/BRIDGE_API_KEY 不能与管理密钥相同/, "模型访问密钥与管理凭据重复，请为模型端点设置单独的密钥。"],
  [/BRIDGE_API_KEY 必须/, "请检查模型访问密钥的格式，使用不含空格的可见 ASCII 字符并避开旧公共密码。"],
  [/本地凭据格式无效|无法安全加载 launcher-secrets/, "本地凭据文件无法加载，请检查文件格式、权限及文件系统硬链接支持后重试。"],
  [/settings\.json 不是有效 JSON|settings\.json 必须是对象/, "Magpie 设置格式无效，请将 settings.json 修复为有效的 JSON 对象后重试。"],
  [/无法读取本地配置|无法读取 Magpie settings/, "本地配置不可读，请检查数据目录权限和 Magpie 设置文件后重试。"],
  [/不支持的平台或架构/, "当前平台不受支持，请使用 Windows x64、macOS x64 或 arm64、Linux x64 或 arm64。"],
  [/自带的自动更新和下载/, "请在 Magpie 设置中关闭核心自动更新和下载，再启动插件指定的版本。"],
  [/核心旁存在 data 或 \.portable/, "自定义核心旁有便携配置，请把 BRIDGE_BIN 放在独立的程序目录后重试。"],
  [/本次启动的管理凭据/, "本次启动缺少管理凭据，请先停止并重新启动核心，再打开原生管理页。"],
  [/无法打开系统默认浏览器/, "无法打开系统默认浏览器，请检查默认浏览器设置后重试。"],
  [/旧版本|旧版或外部|本版本托管协议|版本不匹配/, "核心与当前托管版本不匹配，请先停止旧版并关闭其 MCP 会话，再启动当前版本。"],
  [/非 Magpie|端口.*占用|EADDRINUSE/, "本机端口已被占用，请检查端口配置或关闭占用它的服务后重试。"],
  [/不属于本插件|归属|未发送凭据|PID 记录损坏/, "无法确认核心进程归属。请检查本机端口及已有核心进程，再刷新状态。"],
  [/BRIDGE_BIN|自定义程序/, "自定义核心不可执行，请检查 BRIDGE_BIN 路径和执行权限。"],
  [/文件权限|执行权限|EACCES|EPERM/, "核心文件访问受限，请检查文件和目录权限后重试。"],
  [/进程仍存在|进程仍在运行/, "已有核心进程尚未就绪，请检查其运行状态后刷新。"],
  [/在启动时退出|未在启动时限内就绪|启动已中止/, "核心启动中止或超时，请检查数据目录中的 bridge.log 后重试。"],
  [/无响应|ECONNREFUSED|ECONNRESET|ETIMEDOUT/, "本机端点未能响应，请检查端口和核心进程后刷新。"],
  [/模型清单不是 JSON|模型清单结构无效/, "核心返回的模型清单格式无效，请检查核心版本后刷新。"],
];
/** 上游 HTTP 错误只提取数值状态码，提供与该状态对应的本地操作。 */
const httpHints = {
  401: "请在原生管理页检查服务商账号授权。", 403: "请检查账号或模型权限。",
  404: "请检查模型及端点是否启用。", 429: "额度或速率受限，请稍后重试。",
  502: "请检查上游连接和代理节点。", 503: "请检查可用账号和上游服务。", 504: "上游响应超时，请稍后重试。",
};

/** 从工具错误、启动摘要或模型诊断中选取可公开展示的信息。 */
function explain(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const http = raw.match(/\bHTTP\s+([45]\d{2})\b/i);
  if (http) return `HTTP ${http[1]}。${httpHints[http[1]] || "请检查原生管理页后重试。"}`;
  return remedies.find(([pattern]) => pattern.test(raw))?.[1] || fallback;
}

/** 工具返回业务错误时只解释 reason 或已知错误特征，忽略其他返回字段。 */
async function tool(name) {
  const result = await request("tools/call", { name, arguments: {} }, name === "bridge_start" ? START_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const raw = result?.content?.[0]?.text;
  if (result?.isError) {
    let reason = raw;
    try { reason = JSON.parse(raw)?.reason; } catch { /* 普通安全摘要不是 JSON。 */ }
    const fallback = name === "bridge_open_management" ? "打开失败，请确认核心已启动后重试。" : "操作失败，请检查核心状态和本机端口后重试。";
    const detail = explain(reason, "");
    throw Object.assign(Error(detail || fallback), { diagnosed: Boolean(detail) });
  }
  if (name !== "bridge_status") return;
  try {
    const status = JSON.parse(raw);
    if (typeof status?.ready === "boolean") return status;
  } catch { /* 格式错误与缺少 ready 共用恢复入口。 */ }
  throw Error("核心状态返回格式无效，请刷新状态确认。");
}

/** 阶段标题与帮助文字。没有进度信息的旧宿主只显示准备状态。 */
const phases = {
  waiting: ["等待核心准备", "正在等待核心准备任务，进度会自动更新。"],
  downloading: ["正在下载核心", "下载完成后自动校验并安装到本机缓存。"],
  verifying: ["正在校验核心", "正在核对 SHA256 摘要，校验通过后继续安装。"],
  installing: ["正在安装核心", "正在将已校验的核心写入本机缓存。"],
};

/** 展示状态转变，同时收起上一阶段的进度。 */
function view(kind, title, detail = "") {
  if (connection === "closed") return;
  tone = kind;
  $("#runtime").dataset.tone = kind;
  text("#status", title);
  text("#detail", detail);
  $("#download").hidden = true;
}

/** 按二进制单位格式化下载字节数，零是有效读数。 */
function bytes(value) {
  if (value < 1024) return `${value} B`;
  const unit = value < 1024 * 1024 ? 1024 : 1024 * 1024;
  return `${Number((value / unit).toFixed(2))} ${unit === 1024 ? "KiB" : "MiB"}`;
}

/** 只以实测的分子、分母确定进度；未提供可信总量时保留原生不定进度语义。 */
function showDownload({ receivedBytes, totalBytes }) {
  if (!Number.isSafeInteger(receivedBytes) || receivedBytes < 0) return;
  const bar = $("#progress");
  let amount = `已接收 ${bytes(receivedBytes)} · 总大小未知`;
  if (Number.isSafeInteger(totalBytes) && totalBytes > 0 && receivedBytes <= totalBytes) {
    bar.max = totalBytes;
    bar.value = receivedBytes;
    amount = `${Math.floor(receivedBytes / totalBytes * 100)}% · ${bytes(receivedBytes)} / ${bytes(totalBytes)}`;
  } else bar.removeAttribute("value");
  text("#amount", amount);
  $("#download").hidden = false;
}

/** 公开状态枚举对应的中文诊断值，未知扩展字段不直接显示。 */
const cacheStates = { ready: "已通过 SHA256 校验", custom: "自定义 BRIDGE_BIN", missing: "尚未安装", invalid: "校验未通过", downloading: "准备中", error: "准备失败" };
/** 端口探测只说明服务是否可达，ready 单独由后端模型探测决定。 */
const serviceStates = { bridge: "Magpie 已响应", offline: "离线", foreign: "其他服务占用", unreachable: "未响应", configuration_error: "配置未通过校验" };
/** 平台键只接受发布清单中支持的组合。 */
const platforms = { "win32-x64": "Windows x64", "darwin-x64": "macOS x64", "darwin-arm64": "macOS arm64", "linux-x64": "Linux x64", "linux-arm64": "Linux arm64" };

/** 按允许的键查表，避免把对象继承属性当作状态。 */
function label(map, key) { return Object.hasOwn(map, key) ? map[key] : undefined; }

/** 只展示普通本地路径，过滤多行诊断、URL、参数和凭据信息。 */
function localPath(value) {
  return typeof value === "string" && /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(value) && value.length <= 1024
    && !/[\x00-\x1f<>?&#=]|:\/\/|launcher-secrets|bearer |token[: ]|password[: ]/i.test(value) ? value : null;
}

/** 将已筛选的诊断值作为普通文本写入语义化定义列表，缺失字段不占行。 */
function facts(selector, entries) {
  const rows = [];
  for (const [name, value] of entries) {
    if (!value) continue;
    const row = document.createElement("div"), term = document.createElement("dt"), description = document.createElement("dd");
    row.className = "fact";
    term.textContent = name;
    description.textContent = value;
    row.append(term, description);
    rows.push(row);
  }
  $(selector).replaceChildren(...rows);
}

/** 概览突出服务、缓存与模型，较长的路径和模型样例留给主动展开的详情。 */
function diagnostics(status) {
  const core = status.core || {}, models = status.models || {};
  const endpoint = typeof status.endpoint === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/.test(status.endpoint) ? status.endpoint : null;
  const version = typeof core.version === "string" && /^v?\d{1,5}\.\d{1,5}\.\d{1,8}$/.test(core.version) ? core.version : null;
  const platform = label(platforms, core.platform);
  const samples = Array.isArray(models.sample) ? models.sample.slice(0, 40).filter(id => typeof id === "string" && /^[\w.:-]+(?:\/[\w.:-]+)*$/u.test(id)
    && id.length <= 120 && !/^(?:sk-|Bearer|eyJ)|[\da-f]{32}|token:|secret:|key:/i.test(id)) : [];
  const count = Number.isSafeInteger(models.count) && models.count >= 0 ? `${models.count} 个` : null;
  const service = label(serviceStates, status.state) || (typeof status.alive === "boolean" ? (status.alive ? "已响应" : "未检测到核心") : null);
  facts("#facts", [
    ["本机服务", service], ["核心缓存", label(cacheStates, core.state)],
    ["核心版本", [version, platform].filter(Boolean).join(" · ")], ["可用模型", count || (models.note ? "查询失败" : null)],
    ["模型端点", endpoint], ["自动恢复", typeof status.autoRecoveryPaused === "boolean" ? (status.autoRecoveryPaused ? "已暂停" : "允许恢复") : null],
    ["管理入口", status.gatewayError ? explain(status.gatewayError, "管理入口异常，请检查管理端口后重试。") : null],
  ]);
  facts("#more", [["模型样例", samples.join("、")], ["数据目录", localPath(status.dataDir)], ["配置文件", localPath(status.configPath)]]);
  $("#overview").hidden = false;
}

/** 解析最新快照。重试时允许第一帧仍反映上次失败，在途启动继续查询。 */
function render(status) {
  updates.render(status);
  if (status.update && !status.preparing && status.update.state !== 'switching') void updates.initialize(status);
  $("#core-update").hidden = !status.update;
  $("#installed-cores").hidden = !Array.isArray(status.installedVersions) || status.update?.state === 'custom';
  versions.render(status);
  ports.render(status);
  const core = status.core || {};
  const retry = startBaseline;
  const staleCore = retry && (!sawPreparation || status.preparing === true) && retry.core?.state === core.state && retry.core?.reason === core.reason;
  const staleError = retry && retry.startupError === status.startupError && (!sawPreparation || status.preparing === true);
  const paused = status.autoRecoveryPaused && !(retry?.autoRecoveryPaused && !sawPreparation);
  const probeFailure = status.models?.note || status.reason || (["foreign", "unreachable"].includes(status.state) && status.state);
  const staleProbe = retry && !sawPreparation && status.state === retry.state && status.reason === retry.reason && status.models?.note === retry.models?.note;
  diagnostics(status);
  if (status.ready) view("ready", "核心已就绪", "本机模型服务可用。账号、模型和路由设置请打开原生管理页。");
  else if (paused) view("paused", "自动恢复已暂停", "按需启动核心即可恢复服务。");
  else if (core.state === "downloading") {
    sawPreparation = true;
    const progress = core.progress;
    const stage = label(phases, progress?.phase) || ["正在准备当前平台核心", "准备进度会自动更新。"];
    view("working", ...stage);
    if (progress?.phase === "downloading") showDownload(progress);
  } else if ((core.state === "error" || (core.state === "invalid" && !status.preparing)) && !staleCore) {
    view("error", "核心准备失败", explain(core.reason, explain(status.startupError, "请检查核心缓存和插件版本后重试。")));
  } else if (status.state === "configuration_error" && !(retry?.state === status.state && staleError)) {
    view("error", "本地配置不可用", explain(status.startupError, "请检查数据目录权限和 Magpie 设置文件，修复后重试启动。"));
  } else if (status.startupError && !staleError && !status.preparing) {
    view("error", "核心启动失败", explain(status.startupError, explain(status.reason || status.models?.note, "请检查核心、端口和配置后重新启动。")));
  } else if (!status.preparing && probeFailure && !staleProbe) {
    view("error", status.models?.note ? "模型查询失败" : "本机服务未就绪", explain(probeFailure, "请检查本机服务和端口后刷新状态。"));
  } else if (status.preparing || retry) {
    if (status.preparing && !status.autoRecoveryPaused) sawPreparation = true;
    view("working", core.state === "missing" ? "正在准备核心" : "正在启动核心", core.state === "ready" ? "缓存已通过校验，正在等待本机模型服务就绪。" : "正在等待核心准备或本机服务响应，状态会自动更新。");
  } else if (core.state === "missing") view("idle", "核心尚未安装", "首次启动会查找本机可用核心；需要下载时，会获取当前平台的官方稳定版。");
  else view("idle", "核心尚未就绪", core.state === "ready" ? "核心缓存已通过校验，可直接启动本机服务。" : "可按需启动核心，或刷新状态查看最新结果。");
}

/** 根据握手、操作与阶段选择主按钮；在途启动或后台准备期间禁止重复启动。 */
function controls() {
  const connected = connection === "ready";
  const locked = !connected || Boolean(action) || Boolean(reading);
  const canStart = Boolean(snapshot) && !snapshot.ready && tone !== "working" && tone !== "unknown";
  const canOpen = !["offline", "foreign", "unreachable", "configuration_error"].includes(snapshot?.state);
  const preferOpen = canOpen && (snapshot?.ready === true || (snapshot?.state === "bridge" && Boolean(snapshot.models?.note)));
  $("#start").hidden = !canStart;
  $("#start").disabled = locked || !canStart;
  $("#start").dataset.primary = String(!preferOpen);
  text("#start", tone === "error" ? "重试启动" : "启动核心");
  $("#open").dataset.primary = String(preferOpen);
  $("#open").disabled = locked || !canOpen;
  $("#refresh").disabled = locked;
  $("#reconnect").hidden = $("#reconnect").disabled = connection !== "retryable";
  $("#reconnect").dataset.primary = "true";
}

/** 只取消下一次计划读取，已发出的响应由 generation 与连接状态约束。 */
function stopPolling() { clearTimeout(pollTimer); pollTimer = undefined; }

/** 完成一次读取后再安排下一次，延迟的宿主响应不会堆积查询。 */
function schedule() {
  stopPolling();
  if (connection === "ready" && tone === "working" && !reading) pollTimer = setTimeout(readStatus, POLL_MS);
}

/** 初始、手动、轮询与启动收尾共用同一在途查询；错误后由用户刷新确认。 */
function readStatus() {
  if (connection !== "ready" || reading) return reading;
  stopPolling();
  const revision = generation;
  reading = tool("bridge_status").then(status => {
    if (connection !== "ready" || revision !== generation) return;
    snapshot = status;
    render(status);
  }).catch(error => {
    if (connection === "ready" && revision === generation) view("unknown", "无法确认核心状态", error.message);
  }).finally(() => { reading = null; controls(); schedule(); });
  controls();
  return reading;
}

/** 显式启动与状态查询可并行。结束前复用已有读取，仅在缺少最终快照时补查一次。 */
async function start() {
  if ($("#start").disabled || $("#start").hidden) return;
  action = "start";
  startBaseline = snapshot;
  sawPreparation = false;
  text("#notice", "");
  view("working", "正在启动核心", "首次准备可能需要 10 分钟，进度会自动更新。");
  controls();
  schedule();
  try {
    await tool("bridge_start");
    if (connection !== "ready") return;
    startBaseline = null;
    if (reading) await reading;
    if (connection === "ready" && !snapshot?.ready) await readStatus();
  } catch (error) {
    // 丢弃早于启动失败发出的进度读取，不再由它恢复轮询或覆盖新原因。
    generation++;
    stopPolling();
    const unknown = error.message.includes("结果未知");
    if (tone !== "error" || error.diagnosed) view(unknown ? "unknown" : "error", unknown ? "启动结果未知" : "核心启动失败", error.message);
  } finally { startBaseline = null; action = ""; controls(); }
}

/** 显式打开由宿主签发本机管理凭据，页面只呈现结果。 */
async function openNative() {
  if ($("#open").disabled) return;
  action = "open";
  controls();
  try { await tool("bridge_open_management"); text("#notice", "已向系统默认浏览器发送打开请求。"); }
  catch (error) { text("#notice", error.message); }
  finally { action = ""; controls(); }
}

/** 应用宿主的初始主题及后续主题通知。 */
function hostContext(context) {
  if (["light", "dark"].includes(context?.theme)) document.documentElement.style.colorScheme = context.theme;
}

/** 只接收父窗口的协议消息；迟到响应不会被误当作宿主请求。 */
function receive(event) {
  if (connection === "closed" || event.source !== window.parent) return;
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (typeof message.method !== "string") {
    const task = pending.get(message.id);
    if (!task || (!("result" in message) && !("error" in message))) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(Error("Qoder 未完成操作，结果未知，请刷新状态确认。"));
    else task.resolve(message.result);
    return;
  }
  if (message.method === "ui/notifications/host-context-changed") hostContext(message.params);
  else if (message.method === "ui/notifications/tool-cancelled") text("#notice", "操作已取消，请刷新状态确认。");
  else if (message.method === "ui/notifications/tool-result") {
    if (message.params?.isError) text("#notice", explain(message.params.content?.[0]?.text, "入口操作失败，请刷新状态确认。"));
  } else if (message.id !== undefined) {
    if (message.method === "ping") send({ id: message.id, result: {} });
    else if (message.method === "ui/resource-teardown") { send({ id: message.id, result: {} }); dispose(); }
    else send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
  }
}

/** 页面关闭时立即停止计时、释放监听和等待者，保持核心生命周期独立。 */
function dispose() {
  if (connection === "closed") return;
  connection = "closed";
  stopPolling();
  updates.dispose();
  versions.dispose();
  ports.dispose();
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(Error("应用已关闭。")); }
  pending.clear();
  window.removeEventListener("message", receive);
  window.removeEventListener("pagehide", dispose);
  controls();
}

/** 只在兼容的宿主确认能力后查询状态；传输失败保留手动重连入口。 */
async function connect() {
  if (window.parent === window || !["idle", "retryable"].includes(connection)) return;
  connection = "connecting";
  view("idle", "正在连接 Qoder…");
  controls();
  try {
    const result = await request("ui/initialize", {
      protocolVersion: "2026-01-26", appInfo: { name: "subscription-management", version: pluginVersion },
      appCapabilities: { availableDisplayModes: ["fullscreen"] },
    });
    if (connection === "closed") return;
    if (result?.protocolVersion !== "2026-01-26") {
      connection = "unsupported";
      view("error", "Qoder 不支持当前应用协议，请升级客户端。");
      return;
    }
    hostContext(result.hostContext);
    send({ method: "ui/notifications/initialized", params: {} });
    if (!result.hostCapabilities?.serverTools) {
      connection = "unsupported";
      view("error", "此会话不支持管理工具，请在本机 Qoder 中打开。");
      return;
    }
    connection = "ready";
    await readStatus();
  } catch {
    if (connection === "closed") return;
    connection = "retryable";
    view("error", "连接未完成，请重新连接 Qoder。");
    controls();
  }
}

const updates = createUpdatePanel({ request, readStatus });
const versions = createInstalledCoresPanel({ root: $("#installed-cores"), request, readStatus });
const ports = createPortPanel({ request, readStatus });

// 只读工具可自动刷新，启动与浏览器操作必须由用户显式触发。
$("#open").onclick = openNative;
$("#start").onclick = start;
$("#refresh").onclick = async () => {
  const button = $("#refresh");
  if (button.disabled) return;
  const hadFocus = document.activeElement === button;
  text("#notice", "");
  await readStatus();
  // 浏览器会在按钮临时禁用时把焦点移回 body；用户已移到其他控件时不抢焦点。
  if (hadFocus && connection === "ready" && document.activeElement === document.body) button.focus();
};
$("#reconnect").onclick = connect;
window.addEventListener("message", receive);
window.addEventListener("pagehide", dispose, { once: true });
controls();
if (window.parent === window) view("idle", "请从 Qoder「更多 → 订阅代理管理」打开此入口。");
else connect();
