/** 按行传输的 MCP 服务；工具并发执行，协议输出串行写入，不管理桥子进程句柄。 */
import { StringDecoder } from "node:string_decoder";
import { ensureRunning, getStatus, stopBridge } from "./bridge-process.mjs";
import { PLUGIN_VERSION } from "./config.mjs";
import { generateImage } from "./image-generation.mjs";
import { DEFAULT_IMAGE_MODEL, GEMINI_IMAGE_MODEL } from "./image-models.mjs";

/** 2025-03-26 强制支持批请求，本按行单消息实现不声明支持；其余版本协商到首项。 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];
/** 单会话最多同时执行的工具数，取消但尚未结束的实现仍占用名额。 */
const MAX_TOOLS = 8;
/** 请求仍在执行时的进度心跳间隔，单位毫秒。 */
const PROGRESS_MS = 10_000;
/** EOF 或断管后的最大收尾时间，单位毫秒；不等待不响应取消的实现。 */
const SHUTDOWN_MS = 1_000;
/** 单行及尚未终止行的 UTF-16 长度上限；足以容纳最大提示词及 JSON 转义。 */
const MAX_LINE_LENGTH = 1_048_576;
/** 输出最多排队 64 MiB；持续背压时拒绝会话，仍允许读取取消与 EOF。 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** 服务版本与插件配置共用同一来源。 */
const SERVER_INFO = { name: "qoder-subscription-proxy", version: PLUGIN_VERSION };
/** 生产依赖与测试注入共用同一个分发器，进程操作只接收 config。 */
const DEFAULT_HANDLERS = { ensureRunning, getStatus, stopBridge, generateImage };
/** 无参数工具的契约；显式传 null、数组或额外参数均不接受。 */
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
/**
 * 生图通道选择指引，同时用于 initialize.instructions 与生图工具描述前缀。
 * 插件读不到会话主模型，因此明确告知调用方主模型对自身已知、生图前无需预查询，
 * 避免为核实一件工具无法回答的事而反复调用 bridge_status 或模型列表。
 */
const IMAGE_TOOL_GUIDANCE = `当前聊天主模型为 GPT（包括通过 Codex 订阅接入）或 Gemini，且用户未明确指定生图工具或通道时，优先使用本插件的 bridge_generate_image，不要先调用宿主内置 ImageGen 或其他生图服务。未明确指定图片模型时，GPT 会话显式传入 model=${DEFAULT_IMAGE_MODEL}，Gemini 会话显式传入 model=${GEMINI_IMAGE_MODEL}；Gemini 会话不能省略 model，省略会按 ${DEFAULT_IMAGE_MODEL} 处理。你会话的主模型对自身是已知的，生图前不需要调用 bridge_status、查询模型列表或另行核实主模型与图片模型是否可用；直接提交生图调用，由本工具返回结果或失败原因。按当前聊天主模型判断，不按待生成的图片模型判断；用户明确指定的工具或通道优先，明确指定的图片模型优先于上述默认映射；主模型既不是 GPT 也不是 Gemini 时沿用宿主生图工具，不据此改道。仅适用于文生图，参考图编辑不受支持，不把图片路径或 URL 当作已读取的输入。工具不可用、授权/额度/权限受阻或生成失败时如实说明，不擅自换工具、换模型或重试。遵守宿主工具权限，不改变聊天主模型。`;
/** 图片只接受文字与生成选项，不接收文件路径、图片 URL 或输出路径。 */
const IMAGE_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", minLength: 1, maxLength: 32_000, pattern: "\\S", description: "必填的非空图片文字描述；不会读取其中的路径或 URL。" },
    model: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", default: DEFAULT_IMAGE_MODEL, description: `图片模型：GPT 会话传 ${DEFAULT_IMAGE_MODEL}，Gemini 会话必须传 ${GEMINI_IMAGE_MODEL}；用户指定优先。省略仍为 ${DEFAULT_IMAGE_MODEL}，不会自动识别聊天主模型，也不需要先查询模型列表确认。` },
    size: { type: "string", enum: ["auto", "1024x1024", "1536x1024", "1024x1536"], description: "GPT 图片尺寸；Gemini 分别映射为 1K 的 1:1、3:2、2:3 比例，不保证精确像素；auto 或省略由上游决定。" },
    quality: { type: "string", enum: ["auto", "low", "medium", "high"], description: "GPT 图片质量；Gemini 仅允许 auto 或省略。" },
    background: { type: "string", enum: ["auto", "transparent", "opaque"], description: "GPT 背景选项；Gemini 仅允许 auto 或省略。" },
    output_format: { type: "string", enum: ["png", "jpeg", "webp"], default: "png", description: "GPT 输出编码，默认 png；Gemini 仅允许默认值或省略，按上游实际图片格式保存，不转码或保证 PNG。" },
  },
  required: ["prompt"],
  additionalProperties: false,
};
/** 工具清单与运行时参数校验共用 schema，避免两套约束漂移。 */
const TOOLS = [
  {
    name: "bridge_status",
    description: "查看订阅桥运行状态、核心后台下载状态和启动失败原因；MCP 已连接不代表代理已就绪，ready=true 才可使用代理。models.imageModels 列出本工具可路由的图片模型（含 Gemini 原生模型）。生图前无需调用本工具确认主模型或图片模型。不会执行登录。",
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "bridge_start",
    description: "解除暂停并启动订阅桥，或在后台核心下载失败后手动重试。首次下载在后台自动进行，不阻塞 MCP 握手；已有准备任务时等待同一次尝试，已就绪时复用实例。失败时先检查原因，不盲目重试。",
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "bridge_stop",
    description: "暂停本插件管理的订阅桥并取消本会话在途的核心下载/启动；重连后仍保持暂停。不停止无法确认归属的其他进程。",
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: "bridge_generate_image",
    description: `${IMAGE_TOOL_GUIDANCE} 通过已授权订阅生成一张图片。省略 model 时默认 ${DEFAULT_IMAGE_MODEL}，也可指定账号支持的图片模型；不改变聊天主模型；本 MCP 不自动降级或重试，但 CLIProxyAPI 核心仍可能按配置轮换凭据和重试，单次调用不保证上游只执行一次。仅接受文字描述与生成选项，不读取路径或 URL。可能消耗订阅额度或产生费用；超时、失败或取消不保证上游未执行。`,
    inputSchema: IMAGE_SCHEMA,
  },
];
/** 只允许稳定错误标识出现在异常响应中，不转发异常 message、stack 或响应正文。 */
const SAFE_CODES = new Set([
  "ABORT_ERR", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOENT", "EACCES", "EPERM",
  "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_ARG_TYPE",
  "BRIDGE_NOT_READY", "BRIDGE_START_FAILED", "IMAGE_GENERATION_FAILED", "RATE_LIMITED", "TIMEOUT",
  "INVALID_ARGUMENT", "BRIDGE_UNAVAILABLE", "IMAGE_CONNECTION_FAILED",
  "CORE_CONFIG", "CORE_CANCELLED", "CORE_TIMEOUT", "CORE_CURL", "CORE_DOWNLOAD", "CORE_SIZE",
  "CORE_ARCHIVE_HASH", "CORE_BINARY_HASH", "CORE_ARCHIVE", "CORE_PATH", "CORE_CACHE",
  "CORE_PUBLISH", "CORE_CLEANUP", "CORE_LOCK",
]);

/** 判断 JSON 对象；数组、null 和标量不能冒充参数对象。 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** MCP 的请求 ID 与 progressToken 只接受字符串或有限数字，保留数字 0。 */
function isId(value) {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** 校验 JSON-RPC 信封；不合法的消息不能触发工具或取消操作。 */
function validEnvelope(message) {
  return isObject(message) && message.jsonrpc === "2.0" && typeof message.method === "string"
    && message.method.length > 0 && (!Object.hasOwn(message, "id") || isId(message.id));
}

/** 构造成功响应，id 原样保留其字符串或数字类型。 */
function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/** 协议错误不包含用户输入、异常或上游响应正文。 */
function fail(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** 将普通结果包装为 MCP 文本，业务失败通过 isError 标识。 */
function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** 只展示插件自身声明的 safeMessage 和白名单错误码；普通异常正文绝不透传。 */
function safeError(error, config) {
  const code = error?.code;
  const safeCode = SAFE_CODES.has(code) || (typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599);
  let message = typeof error?.safeMessage === "string" ? error.safeMessage : "工具执行失败。";
  for (const secret of [config?.apiKey, config?.mgmtKey]) {
    if (typeof secret === "string" && secret) message = message.split(secret).join("[已脱敏]");
  }
  // safeMessage 的归属是插件常量，额外移除链接与多行，避免误带 URL 查询串或堆栈。
  message = message.replace(/https?:\/\/\S+/gi, "[链接已隐藏]").split(/[\r\n]/, 1)[0].slice(0, 500);
  return `${message}${safeCode ? `（${code}）` : ""} 本 MCP 未自动重试；核心仍可能按配置重试，请检查桥状态和订阅额度。`;
}

/** 生命周期原因允许短的普通说明；含密钥、URL、正文或堆栈痕迹时改用安全摘要。 */
function safeReason(value, fallback, config) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) return fallback;
  const secrets = [config?.apiKey, config?.mgmtKey].filter((secret) => typeof secret === "string" && secret);
  if (secrets.some((secret) => value.includes(secret))
    || /[\r\n]|https?:|\b(?:api[-_ ]?key|token|secret|authorization|bearer|body|stack)\b/i.test(value)) return fallback;
  return value;
}

/** 按公布的 schema 校验全部工具参数；错误不回显不可信的字段名或值。 */
function validateArguments(schema, args) {
  if (!isObject(args)) return "arguments 必须是对象。";
  if (Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key))) return "包含不支持的工具参数。";
  if (schema.required?.some((key) => !Object.hasOwn(args, key))) return "缺少必需的 prompt 参数。";
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (typeof value !== rule.type) return `${key} 必须是字符串。`;
    if (rule.enum && !rule.enum.includes(value)) return `${key} 不在允许的枚举中。`;
    // JSON Schema 的长度按 Unicode 码点计算，不能把一个 emoji 当成两个字符。
    const length = Array.from(value).length;
    if ((rule.minLength && (!value.trim() || length < rule.minLength)) || (rule.maxLength && length > rule.maxLength)) {
      return `${key} 为空或超过允许长度。`;
    }
  }
  return null;
}

/**
 * 执行已验证的工具；测试只替换依赖函数，不另造分发逻辑。
 * ctx 仅含 config 与可选 startupError；启动下载与图片模块共享请求级取消信号。
 */
async function callTool(name, args, ctx, handlers, signal) {
  const { config } = ctx;
  signal?.throwIfAborted();
  switch (name) {
    case "bridge_status": {
      const status = await handlers.getStatus(config);
      return textResult(ctx.startupError ? { ...status, startupError: safeError(ctx.startupError, config) } : status);
    }
    case "bridge_start": {
      const result = await handlers.ensureRunning(config, { signal });
      const started = result?.started === true;
      const ready = result?.ready === true;
      return textResult({ started, ready, reason: safeReason(result?.reason, ready ? "已就绪" : "启动未就绪", config) }, !ready);
    }
    case "bridge_stop": {
      const result = await handlers.stopBridge(config);
      const stopped = result?.stopped === true;
      return textResult({ stopped, reason: safeReason(result?.reason, stopped ? "已停止" : "未能停止", config) }, !stopped);
    }
    case "bridge_generate_image": {
      const result = await handlers.generateImage(config, { model: DEFAULT_IMAGE_MODEL, output_format: "png", ...args }, { signal });
      if (!isObject(result) || !Array.isArray(result.content)) throw new Error("invalid image result");
      return result;
    }
  }
}

/**
 * 处理一个已解析的消息；无 id 的通知不执行工具也不产生响应。
 * @param {unknown} message JSON-RPC 消息
 * @param {{config: object, startupError?: unknown}} ctx 会话配置及启动故障摘要来源
 * @param {object} [options] handlers 为原模块函数的可选替换，signal 为请求级取消信号
 * @returns {Promise<object|null>} JSON-RPC 响应或通知的 null
 */
export async function handleMessage(message, ctx, { handlers = {}, signal } = {}) {
  if (!validEnvelope(message)) return fail(null, -32600, "无效的 JSON-RPC 请求。");
  if (!Object.hasOwn(message, "id")) return null;
  const { id, method, params } = message;
  if (params !== undefined && !isObject(params)) return fail(id, -32602, "params 必须是对象。");
  switch (method) {
    case "initialize": {
      if (typeof params?.protocolVersion !== "string" || !params.protocolVersion.trim()) return fail(id, -32602, "缺少有效的 protocolVersion。");
      const protocolVersion = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return ok(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: IMAGE_TOOL_GUIDANCE });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const tool = TOOLS.find(({ name }) => name === params?.name);
      if (!tool) return fail(id, -32602, "未知工具或缺少工具名称。");
      const args = params.arguments === undefined ? {} : params.arguments;
      const invalid = validateArguments(tool.inputSchema, args);
      if (invalid) return fail(id, -32602, invalid);
      if (params._meta !== undefined && (!isObject(params._meta)
        || (Object.hasOwn(params._meta, "progressToken") && !isId(params._meta.progressToken)))) {
        return fail(id, -32602, "无效的进度元数据。");
      }
      try {
        const result = await callTool(tool.name, args, ctx, { ...DEFAULT_HANDLERS, ...handlers }, signal);
        signal?.throwIfAborted();
        return ok(id, result);
      } catch (error) {
        return ok(id, textResult(signal?.aborted
          ? "已请求取消工具调用；操作可能已完成，请先检查状态，不要盲目重试。"
          : safeError(error, ctx.config), true));
      }
    }
    default:
      return fail(id, -32601, "方法不存在。");
  }
}

/**
 * 运行按行 JSON-RPC 会话。工具不阻塞读循环，stdout 串行且遵守背压。
 * EOF、输入关闭/错误或断管会取消在途请求；最多等待一秒，代理回收由入口负责。
 * @param {{config: object, startupError?: unknown}} ctx 会话上下文
 * @param {object} [options] 可注入 input/output、handlers 和可取消的本地配置 prepare；prepare 不得等待网络或代理就绪
 * @returns {Promise<void>} 会话停止且已完成有界收尾
 */
export async function runMcp(ctx, { input = process.stdin, output = process.stdout, handlers = {}, prepare } = {}) {
  const decoder = new StringDecoder("utf8");
  let inputLine = "";
  let discardingLine = false;
  /** 在途工具按原始 ID 区分；重复 ID 不替换已有控制器。 */
  const requests = new Map();
  /** 所有响应任务，包含非工具请求，供 EOF 收尾等待。 */
  const pending = new Set();
  /** 输出取消与请求取消分开，EOF 后仍可发送已完成响应。 */
  const outputController = new AbortController();
  let readingClosed = false;
  let outputClosed = false;
  let writeQueue = Promise.resolve();
  let queuedBytes = 0;
  let resolveInput;
  const inputDone = new Promise((resolve) => { resolveInput = resolve; });
  /** 本地配置准备及入口后台任务共享连接生命周期；配置可用后即可发布 MCP 能力。 */
  const preparationController = new AbortController();
  let initialized = !prepare;
  let preparationError;
  const preparation = prepare ? Promise.resolve().then(() => prepare(preparationController.signal)).catch((error) => {
    preparationError = error;
    ctx.startupError = error;
    stopReading();
  }) : Promise.resolve();

  /** 只停止本会话读取与请求；不退出进程、不调用 stopBridge。 */
  function stopReading() {
    if (readingClosed) return;
    readingClosed = true;
    inputLine = "";
    input.pause();
    preparationController.abort();
    for (const request of requests.values()) request.controller.abort();
    resolveInput();
  }

  /** 输出不可用时终止会话，避免 EPIPE 成为未处理异常或继续积压结果。 */
  function breakOutput() {
    outputClosed = true;
    outputController.abort();
    stopReading();
  }

  /** 写入一行，同时等待写回调和必要的 drain；断管及关闭会解除等待。 */
  function writeLine(line) {
    if (outputClosed) return Promise.resolve();
    return new Promise((resolve) => {
      let callbackDone = false;
      let drained = false;
      let writeReturned = false;
      /** 清理本次写入的监听；输出故障由会话级监听处理。 */
      function finish() {
        output.off("drain", onDrain);
        outputController.signal.removeEventListener("abort", finish);
        resolve();
      }
      /** drain 可能早于写回调，只有两个条件满足才写下一行。 */
      function onDrain() {
        drained = true;
        if (callbackDone && writeReturned) finish();
      }
      output.on("drain", onDrain);
      outputController.signal.addEventListener("abort", finish, { once: true });
      try {
        const accepted = output.write(line, (error) => {
          if (error) breakOutput();
          callbackDone = true;
          if (drained && writeReturned) finish();
        });
        writeReturned = true;
        drained ||= accepted;
        if (callbackDone && drained) finish();
      } catch {
        breakOutput();
      }
    });
  }

  /** 有界排队且不暂停输入，保证背压时仍可接收取消和 EOF；整行串行发送。 */
  function send(message) {
    if (!message || outputClosed) return Promise.resolve();
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      line = `${JSON.stringify(fail(message.id ?? null, -32603, "结果无法序列化。"))}\n`;
    }
    const bytes = Buffer.byteLength(line);
    if (queuedBytes + bytes > MAX_OUTPUT_BYTES) {
      breakOutput();
      return Promise.resolve();
    }
    queuedBytes += bytes;
    const task = writeQueue.then(() => writeLine(line)).finally(() => { queuedBytes -= bytes; });
    writeQueue = task;
    return task;
  }

  /** 注册响应任务，异常只产生安全协议错误，不打断后续工具调用。 */
  function dispatch(message) {
    const validRequest = validEnvelope(message) && Object.hasOwn(message, "id");
    const isTool = validRequest && message.method === "tools/call";
    const isInitialize = Boolean(prepare && validRequest && message.method === "initialize");
    if (prepare && !initialized && validRequest && ["tools/list", "tools/call"].includes(message.method)) {
      return send(fail(message.id, -32002, "本地配置尚未初始化完成，请等待 MCP 初始化成功。"));
    }
    if (isInitialize && [...requests.values()].some((request) => request.initializing)) {
      return send(fail(message.id, -32600, "初始化请求正在处理中。"));
    }
    let request;
    if (validEnvelope(message) && Object.hasOwn(message, "id") && requests.has(message.id)) {
      return send(fail(message.id, -32600, "请求 ID 已在使用。"));
    }
    if (isTool || isInitialize) {
      if (requests.size >= MAX_TOOLS) return send(ok(message.id, textResult("同时执行的工具已达 8 个；未执行本次调用，请等待已有调用结束。", true)));
      request = { controller: new AbortController(), timer: null, initializing: isInitialize };
      requests.set(message.id, request);
      if (isInitialize) request.controller.signal.addEventListener("abort", stopReading, { once: true });
      const token = message.params?._meta?.progressToken;
      if (isId(token)) {
        let progress = 0;
        request.timer = setInterval(() => {
          void send({ jsonrpc: "2.0", method: "notifications/progress", params: {
            progressToken: token, progress: ++progress, message: "工具仍在处理中，请勿重复提交。",
          } });
        }, PROGRESS_MS);
        request.timer.unref();
        request.controller.signal.addEventListener("abort", () => clearInterval(request.timer), { once: true });
      }
    }
    const task = (async () => {
      if (isInitialize) {
        await preparation;
        if (preparationError) return fail(message.id, -32001, safeError(preparationError, ctx.config));
        if (preparationController.signal.aborted) return fail(message.id, -32001, "MCP 初始化已取消，未报告就绪。");
      }
      const response = await handleMessage(message, ctx, { handlers, signal: request?.controller.signal });
      if (isInitialize && response?.result) initialized = true;
      return response;
    })()
      .then((response) => {
        if (request) clearInterval(request.timer);
        return send(response);
      })
      .catch(() => send(fail(message.id ?? null, -32603, "内部处理错误。")))
      .finally(() => {
        if (request) {
          clearInterval(request.timer);
          requests.delete(message.id);
        }
        pending.delete(task);
      });
    pending.add(task);
    return task;
  }

  /** 每行独立解析；非法 JSON 可恢复，取消通知仅作用于同一会话的对应 ID。 */
  function onLine(line) {
    if (readingClosed || !line.trim()) return;
    if (line.length > MAX_LINE_LENGTH) {
      void send(fail(null, -32600, "请求行过长。"));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      void send(fail(null, -32700, "JSON 解析失败。"));
      return;
    }
    if (validEnvelope(message) && !Object.hasOwn(message, "id") && message.method === "notifications/cancelled") {
      if (isObject(message.params) && isId(message.params.requestId)) requests.get(message.params.requestId)?.controller.abort();
      return;
    }
    void dispatch(message);
  }

  // 必须在遇到换行前实施上限，否则 readline 会无界积压未完成的请求。
  function onData(chunk) {
    if (readingClosed) return;
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let offset = 0;
    while (offset < text.length && !readingClosed) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      if (!discardingLine) {
        if (inputLine.length + end - offset > MAX_LINE_LENGTH) {
          inputLine = "";
          discardingLine = true;
          void send(fail(null, -32600, "请求行过长。"));
        } else inputLine += text.slice(offset, end);
      }
      if (newline < 0) break;
      const complete = inputLine;
      const discard = discardingLine;
      inputLine = "";
      discardingLine = false;
      if (!discard) onLine(complete.replace(/\r$/, ""));
      offset = newline + 1;
    }
  }

  /** EOF 时消费残留的完整 UTF-8 行，再取消工具与入口共享的会话信号。 */
  function onEnd() {
    onData(decoder.end());
    if (!discardingLine && inputLine) onLine(inputLine);
    stopReading();
  }

  output.on("error", breakOutput);
  output.on("close", breakOutput);
  input.on("error", stopReading);
  input.on("close", stopReading);
  input.on("end", onEnd);
  input.on("data", onData);
  // 已关闭的注入流不会再发事件，必须主动结束，避免测试或宿主永久挂起。
  if (output.destroyed || output.writableEnded) breakOutput();
  if (input.destroyed || input.readableEnded) stopReading();
  await inputDone;
  // 等待本地配置准备结束；后台下载/启动的取消清理由持有任务的入口负责。
  await preparation;
  let deadline;
  await Promise.race([
    Promise.allSettled([...pending]).then(() => writeQueue),
    new Promise((resolve) => { deadline = setTimeout(resolve, SHUTDOWN_MS); }),
  ]);
  clearTimeout(deadline);
  outputClosed = true;
  outputController.abort();
  input.off("data", onData);
  input.off("end", onEnd);
  input.off("error", stopReading);
  input.off("close", stopReading);
  // 不结束正常 stdout。尚有积压或断管时销毁会话输出，error 监听保留到 close。
  if (!output.destroyed && output.writableLength > 0) output.destroy();
  if (output.destroyed && !output.closed) {
    output.once("close", () => {
      output.off("error", breakOutput);
      output.off("close", breakOutput);
    });
  } else {
    output.off("error", breakOutput);
    output.off("close", breakOutput);
  }
}
