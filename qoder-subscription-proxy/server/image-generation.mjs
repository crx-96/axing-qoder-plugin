/** 复用 Magpie 原生生图 MCP，将返回的图片内容交付为本地文件。 */
import { randomUUID } from "node:crypto";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { httpFailure } from "./local-http.mjs";
import { requestOwned } from "./supervisor.mjs";
import { privatePortFile } from "./bridge-ports.mjs";

/** 生图总请求时限，单位毫秒。 */
const REQUEST_TIMEOUT_MS = 300_000;
/** 包含 base64 的 JSON 响应上限，单位字节。 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** 单张解码图片上限，单位字节。 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** 生图及结果查询共用同一模型网关路径。 */
const IMAGE_MCP_PATH = "/mcp/magpie/image";
/** 仅接受核心生成的文件路径与下载令牌，连接目标始终来自当前托管配置。 */
const IMAGE_FILE_PATH = /^\/mcp\/magpie\/image\/files\/[0-9a-f]{32}\.[a-z0-9]+$/;

/** 创建可公开错误，始终不包含上游正文、URL 或凭据。 */
function failure(message, code = "IMAGE_OUTPUT_INVALID") {
  return Object.assign(new Error(message), { code, safeMessage: message });
}

/** 取消不传播调用方可能含秘密的 signal.reason。 */
function checkCancelled(signal) {
  if (signal?.aborted) throw failure("生图请求已取消。", "ABORT_ERR");
}

/** 超时时核心可能仍在生成，保留可区分的错误码。 */
function imageTimeout() {
  return failure("等待图片超时，请检查已有任务结果，避免重复提交。", "ETIMEDOUT");
}

/** 使用单调时钟计算全部生图请求共用的剩余毫秒数。 */
function remainingTime(deadline) {
  const timeoutMs = Math.floor(deadline - performance.now());
  if (timeoutMs <= 0) throw imageTimeout();
  return timeoutMs;
}

/** 建连核验与 HTTP 共用截止信号，调用方取消仍优先于超时。 */
async function requestImage(config, path, options, deadline, request, resultOperation) {
  const { signal } = options;
  checkCancelled(signal);
  const timeoutMs = remainingTime(deadline);
  const timeout = AbortSignal.timeout(timeoutMs);
  const activeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try { response = await request(config, path, { ...options, signal: activeSignal, authenticated: true, timeoutMs }); }
  catch (error) {
    checkCancelled(signal);
    if (timeout.aborted || error?.code === "ETIMEDOUT") throw imageTimeout();
    remainingTime(deadline);
    if (error?.code === "ABORT_ERR") throw failure("生图请求已取消。", "ABORT_ERR");
    if (error?.code === "RESPONSE_TOO_LARGE") throw failure("图片响应超过大小限制。", "RESPONSE_TOO_LARGE");
    throw failure("订阅代理未返回有效响应，请检查运行状态，避免重复提交生图。", "IMAGE_REQUEST_FAILED");
  }
  // 定时器可能因事件循环忙碌而延迟，收到响应后仍要检查实际截止时间。
  checkCancelled(signal);
  if (timeout.aborted) throw imageTimeout();
  remainingTime(deadline);
  if (response?.status !== 200) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    if (resultOperation) throw failure(`${resultOperation}失败（HTTP ${status}），请检查已有任务结果，避免重复提交生图。`, status);
    if (status === 404) throw failure("原生 MCP 生图接口不可用（HTTP 404），请在管理页检查并切换到支持该接口的核心版本。", status);
    throw failure(httpFailure(status, "订阅代理生图").message, status);
  }
  return response;
}

/** 生图工具的文本可能含临时令牌、提示词或上游错误正文，仅消费结构化结果。 */
async function callImageTool(config, name, args, signal, deadline, request) {
  const resultOperation = name === "generation_result" ? "查询生图结果" : undefined;
  const response = await requestImage(config, IMAGE_MCP_PATH, {
    method: "POST", signal, maxBytes: MAX_RESPONSE_BYTES,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  }, deadline, request, resultOperation);
  if (typeof response.text !== "string" || Buffer.byteLength(response.text) > MAX_RESPONSE_BYTES) {
    throw failure("图片响应超过大小限制。", "RESPONSE_TOO_LARGE");
  }
  let body;
  try { body = JSON.parse(response.text); }
  catch { throw failure("生图响应不是有效 JSON。"); }
  if (body?.error || body?.result?.isError === true) {
    const message = resultOperation
      ? "查询生图结果失败，请检查已有任务和运行日志，避免重复提交生图。"
      : "订阅代理生图失败，请检查管理页中的生图设置、模型权限或运行日志。";
    throw failure(message, "IMAGE_TOOL_FAILED");
  }
  if (body?.jsonrpc !== "2.0" || body.id !== 1 || !Array.isArray(body.result?.content)) {
    throw failure("生图响应结构无效。");
  }
  return body.result;
}

/** 从首个 IHDR 取像素宽高，仅在 IDAT 和末尾 IEND 也通过边界校验后返回。 */
function pngMetadata(bytes) {
  // 至少要能容纳签名、13 字节 IHDR 和空 IEND，才能读取固定偏移。
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) return null;

  // 从 IHDR 的 CRC 之后逐块跳过数据，保留对截断块及尾部多余字节的检查。
  let offset = 33;
  let hasData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    offset += 12 + length;
    if (offset > bytes.length) return null;
    if (type === "IDAT" && length > 0) hasData = true;
    if (type === "IEND") return hasData && length === 0 && offset === bytes.length ? { extension: "png", size: `${width}x${height}` } : null;
  }
  return null;
}

/** 从 JPEG 的 SOF0/1/2 读取编码宽高，并确认扫描段和文件终止标记存在。 */
function jpegMetadata(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return null;
  let offset = 2;
  let size;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    // SOF 段内先高后宽，确认段长再读，防止跨入下一个标记。
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      size = `${width}x${height}`;
    }
    // SOS 之后要有扫描数据，扫描正文仍交给像素解码器处理。
    if (marker === 0xda) return size && length >= 6 && offset + 2 + length < bytes.length - 2 ? { extension: "jpg", size } : null;
    offset += 2 + length;
  }
  return null;
}

/** 校验静态 WebP 顶层块，扩展容器报告 VP8X 画布，简单容器报告 VP8/VP8L 帧尺寸。 */
function webpMetadata(bytes) {
  if (bytes.length < 26 || bytes.toString("latin1", 0, 4) !== "RIFF" ||
      bytes.toString("latin1", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) !== bytes.length - 8) return null;
  let offset = 12;
  let canvasSize;
  let frameSize;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const next = data + length + (length % 2);
    if (next > bytes.length) return null;

    if (type === "VP8X") {
      // 扩展头位于首块，画布两个小端 24 位值分别保存宽、高减一。
      if (offset !== 12 || length !== 10) return null;
      const width = bytes.readUIntLE(data + 4, 3) + 1;
      const height = bytes.readUIntLE(data + 7, 3) + 1;
      if (width * height > 0xffffffff) return null;
      canvasSize = `${width}x${height}`;
    } else if (type === "VP8 ") {
      // 有损关键帧的宽高各占低 14 位，上两位为缩放标志。
      if (frameSize || length < 10 || (bytes[data] & 1) || bytes.readUIntBE(data + 3, 3) !== 0x9d012a) return null;
      const width = bytes.readUInt16LE(data + 6) & 0x3fff;
      const height = bytes.readUInt16LE(data + 8) & 0x3fff;
      if (!width || !height) return null;
      frameSize = `${width}x${height}`;
    } else if (type === "VP8L") {
      // 无损帧把宽减一和高减一连续打包为两个 14 位字段，最高三位是版本。
      if (frameSize || length < 5 || bytes[data] !== 0x2f) return null;
      const bits = bytes.readUInt32LE(data + 1);
      if (bits >>> 29) return null;
      frameSize = `${(bits & 0x3fff) + 1}x${((bits >>> 14) & 0x3fff) + 1}`;
    }
    offset = next;
  }
  // 完整遍历到 RIFF 末尾且确有图片块，才能发布画布尺寸。
  return frameSize && offset === bytes.length ? { extension: "webp", size: canvasSize ?? frameSize } : null;
}

/** 严格校验标准 base64，避免 Buffer.from 静默忽略非法字节。 */
function decodeImage(base64) {
  if (typeof base64 !== "string" || !base64.length || base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw failure("图片 base64 数据无效或超过大小限制。");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw failure("图片 base64 数据无效。");
  return bytes;
}

/** 按实际写盘的图片字节校验 MIME 和容器，并读取像素尺寸。 */
function validateImage(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw failure("图片数据为空或超过大小限制。");
  }
  let metadata;
  switch (mime) {
    case "image/png": metadata = pngMetadata(bytes); break;
    case "image/jpeg": metadata = jpegMetadata(bytes); break;
    case "image/webp": metadata = webpMetadata(bytes); break;
  }
  if (!metadata) throw failure("图片 MIME 或实际文件格式无效，仅支持 PNG、JPEG、WebP。");
  return { bytes, mime, ...metadata };
}

/** 只提取核心签名文件路径，丢弃链接中的主机、端口和其余查询参数。 */
function signedImagePath(fileUrl) {
  const url = typeof fileUrl === "string" && fileUrl.length <= 4096 && URL.canParse(fileUrl) ? new URL(fileUrl) : null;
  const token = url?.searchParams.get("t");
  if (!url || !["http:", "https:"].includes(url.protocol) || !IMAGE_FILE_PATH.test(url.pathname) ||
      !token || !/^\d{1,20}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return `${url.pathname}?t=${token}`;
}

/** 优先保存可用的内联图片，必要时从同次结果下载签名文件。 */
async function resolveImage(config, result, signal, deadline, request) {
  let invalidImage;
  for (const item of result.content) {
    if (item?.type !== "image") continue;
    try { return validateImage(decodeImage(item.data), item.mimeType); }
    catch (error) {
      if (error?.code !== "IMAGE_OUTPUT_INVALID") throw error;
      invalidImage = error;
    }
  }
  // 无效的候选链接可以跳过，下载仍只发往已核验的模型端口。
  const files = result._meta?.["usemagpie.ai/files"];
  for (const file of Array.isArray(files) ? files : []) {
    const path = signedImagePath(file?.url);
    if (!path) continue;
    const response = await requestImage(config, path, {
      signal, binary: true, maxBytes: MAX_IMAGE_BYTES,
    }, deadline, request, "下载生图结果");
    return validateImage(response.bytes, response.headers?.["content-type"]);
  }
  throw invalidImage ?? failure("订阅代理未返回可保存的图片，请检查已有任务结果，避免重复提交。", "IMAGE_OUTPUT_UNAVAILABLE");
}

// 硬链接原子发布，避免读到半张图片或覆盖已有文件。
async function saveImage(config, image, signal) {
  checkCancelled(signal);
  const directory = resolve(config.dataDir, "generated");
  const name = randomUUID();
  const temporary = join(directory, `.${name}.tmp`);
  const path = join(directory, `${name}.${image.extension}`);
  let ownedTemporary = false;
  let published = false;
  try {
    await privatePortFile(config.dataDir, "generated", `${name}.${image.extension}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    checkCancelled(signal);
    // UUID 加 wx 防止覆盖；失败时只删除已确认属于当前调用的文件。
    const handle = await open(temporary, "wx", 0o600);
    ownedTemporary = true;
    try { await handle.writeFile(image.bytes, { signal }); }
    finally { await handle.close(); }
    checkCancelled(signal);
    await link(temporary, path);
    published = true;
    await unlink(temporary);
    ownedTemporary = false;
    checkCancelled(signal);
    return { path, bytes: image.bytes.length, mime: image.mime };
  } catch {
    const cleanup = await Promise.allSettled([
      ...(published ? [unlink(path)] : []),
      ...(ownedTemporary ? [unlink(temporary)] : []),
    ]);
    if (cleanup.some((result) => result.status === "rejected")) {
      throw failure("图片保存未完成，且本次文件清理失败，请检查 generated 目录，不要重复提交生图。", "IMAGE_SAVE_FAILED");
    }
    checkCancelled(signal);
    throw failure("图片未能保存到本地，请检查数据目录，不要重复提交生图。", "IMAGE_SAVE_FAILED");
  }
}

/** 生成一张图片。省略模型与尺寸时沿用原生设置，成功时返回本地路径和实际像素尺寸。 */
export async function generateImage(config, { prompt, model, size, signal }, request = requestOwned) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32_000) {
    throw failure("生图提示词必须是非空字符串，且不超过 32000 个字符。", "INVALID_PARAMS");
  }
  if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 200)) {
    throw failure("生图模型必须是非空的模型 ID。", "INVALID_PARAMS");
  }
  if (size !== undefined && (typeof size !== "string" || !/^[1-9]\d{0,4}[x:][1-9]\d{0,4}$/.test(size))) {
    throw failure("生图尺寸请使用宽x高或宽高比格式。", "INVALID_PARAMS");
  }
  const deadline = performance.now() + REQUEST_TIMEOUT_MS;
  const args = { prompt };
  if (model !== undefined) args.model = model;
  if (size !== undefined) args.size = size;
  let result = await callImageTool(config, "generate_image", args, signal, deadline, request);
  const pending = result._meta?.["usemagpie.ai/pending"];
  if (pending !== undefined) {
    if (typeof pending !== "string" || !/^img_[0-9a-f]{24}$/.test(pending)) throw failure("生图任务 ID 无效。");
    // 原生核心会继续生成。只按原 ID 等待结果，避免再次消耗生图额度。
    do {
      await delay(Math.min(250, remainingTime(deadline)), undefined, { signal }).catch(() => { throw failure("生图请求已取消。", "ABORT_ERR"); });
      result = await callImageTool(config, "generation_result", { id: pending }, signal, deadline, request);
      const next = result._meta?.["usemagpie.ai/pending"];
      if (next === undefined) break;
      if (next !== pending) throw failure("生图任务 ID 不一致。");
    } while (true);
  }
  const image = await resolveImage(config, result, signal, deadline, request);
  const saved = await saveImage(config, image, signal);
  return { generated: true, size: image.size, ...(size === undefined ? {} : { requestedSize: size }), ...saved };
}
