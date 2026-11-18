/** Magpie 原生生图 HTTP 薄适配；只交付本地文件，不下载上游 URL，也不重试生成。 */
import { randomUUID } from "node:crypto";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { httpFailure } from "./local-http.mjs";
import { requestOwned } from "./supervisor.mjs";

/** Magpie 目录使用 provider/model；不接受旧裸模型名或其他图片族。 */
const GPT_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/gpt-image-[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 生图总请求时限，单位毫秒。 */
const REQUEST_TIMEOUT_MS = 300_000;
/** 模型目录请求时限，单位毫秒。 */
const MODELS_TIMEOUT_MS = 10_000;
/** 包含 base64 的 JSON 响应上限，单位字节。 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** 单张解码图片上限，单位字节。 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** 缺省输出尺寸；由 Magpie 验证具体模型是否支持调用方提供的尺寸。 */
export const DEFAULT_IMAGE_SIZE = "1024x1024";

/** 创建可公开错误，始终不包含上游正文、URL 或凭据。 */
function failure(message, code = "IMAGE_OUTPUT_INVALID") {
  return Object.assign(new Error(message), { code, safeMessage: message });
}

/** 取消不传播调用方可能含秘密的 signal.reason。 */
function checkCancelled(signal) {
  if (signal?.aborted) throw failure("生图请求已取消。", "ABORT_ERR");
}

/** 请求只经托管器；网络错误采用固定诊断，不透传原始 error.message。 */
async function requestJson(config, path, options, request) {
  checkCancelled(options.signal);
  let response;
  try { response = await request(config, path, options); }
  catch (error) {
    checkCancelled(options.signal);
    if (error?.code === "ABORT_ERR") throw failure("生图请求已取消。", "ABORT_ERR");
    throw failure("Magpie 请求未取得有效响应，请检查运行状态，不要重复提交生图。", "IMAGE_REQUEST_FAILED");
  }
  checkCancelled(options.signal);
  if (response?.status !== 200) {
    const status = Number.isInteger(response?.status) ? response.status : 0;
    throw failure(httpFailure(status, "生图").message, status);
  }
  if (typeof response.text !== "string" || Buffer.byteLength(response.text) > options.maxBytes) {
    throw failure("Magpie 响应超过大小限制。", "RESPONSE_TOO_LARGE");
  }
  try { return JSON.parse(response.text); }
  catch { throw failure("Magpie 响应不是有效 JSON。"); }
}

/** 过滤并去重目录中的 GPT 图片模型；未知族立即拒绝且不回显输入。 */
export function imageModelsByFamily(ids, family) {
  if (family !== "gpt") throw failure("未支持的生图渠道。", "INVALID_PARAMS");
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length <= 200 && GPT_MODEL.test(id)))];
}

/** 查询 Magpie 模型目录；request 是测试替身，生产默认使用 requestOwned。 */
export async function listImageModels(config, family, signal, request = requestOwned) {
  imageModelsByFamily([], family);
  const body = await requestJson(config, "/mcp/magpie/image", {
    authenticated: true, method: "POST", signal, timeoutMs: MODELS_TIMEOUT_MS, maxBytes: 1024 * 1024,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  }, request);
  if (body?.error || !Array.isArray(body?.result?.tools)) throw failure("Magpie 图片能力目录结构无效。");
  const models = body.result.tools.find(tool => tool.name === "generate_image")?.inputSchema?.properties?.model?.enum;
  // 上游在未配置图片模型或候选超过 40 个时省略 enum，不能据此宣称没有图片能力。
  if (!Array.isArray(models)) throw failure("Magpie 未提供完整图片模型枚举，请在管理页确认图片能力后显式指定 model。", "IMAGE_MODELS_UNAVAILABLE");
  return imageModelsByFamily(models, family);
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

/** 严格校验标准 base64 和声明的 MIME，避免 Buffer.from 静默忽略非法字节。 */
function decodeImage(body) {
  const item = Array.isArray(body?.data) ? body.data[0] : undefined;
  if (!item?.b64_json && typeof item?.url === "string" && item.url) {
    throw failure("上游仅返回远程图片链接，未取得可保存图片，请在Magpie检查生成结果，不要重复提交", "IMAGE_OUTPUT_UNAVAILABLE");
  }
  const base64 = item?.b64_json;
  if (typeof base64 !== "string" || !base64.length || base64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) ||
      base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw failure("图片 base64 数据无效或超过大小限制。");
  }
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== base64) {
    throw failure("图片 base64 数据无效或超过大小限制。");
  }
  // 仅从即将原样写盘的字节读取尺寸，按声明的 MIME 选择对应容器校验。
  let metadata;
  switch (item.mime_type) {
    case "image/png": metadata = pngMetadata(bytes); break;
    case "image/jpeg": metadata = jpegMetadata(bytes); break;
    case "image/webp": metadata = webpMetadata(bytes); break;
  }
  if (!metadata) throw failure("图片 MIME 或实际文件格式无效；仅支持 PNG、JPEG、WebP。");
  return { bytes, mime: item.mime_type, ...metadata };
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

/** 生成并保存图片。成功时 size 是文件的像素宽高，requestedSize 是发送给模型的尺寸。 */
export async function generateImage(config, { family, prompt, model, size = DEFAULT_IMAGE_SIZE, signal }, request = requestOwned) {
  // 请求参数在模型查询和生图之前统一校验。
  imageModelsByFamily([], family);
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32_000) {
    throw failure("生图提示词必须是非空字符串，且不超过 32000 个字符。", "INVALID_PARAMS");
  }
  if (model !== undefined && (typeof model !== "string" || !imageModelsByFamily([model], family).length)) {
    throw failure("生图模型必须为 provider/gpt-image-* 格式。", "INVALID_PARAMS");
  }
  if (typeof size !== "string" || !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(size)) {
    throw failure("生图尺寸必须为宽x高像素格式。", "INVALID_PARAMS");
  }
  checkCancelled(signal);
  const models = model === undefined ? await listImageModels(config, family, signal, request) : [model];
  if (!models.length) throw failure("当前没有可用的 GPT 生图模型，请检查 Magpie 模型列表。", "BRIDGE_NOT_READY");
  if (models.length > 1) return { needsModelChoice: true, family, models };
  const chosen = models[0];
  const body = await requestJson(config, "/v1/images/generations", {
    authenticated: true, method: "POST", signal, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_RESPONSE_BYTES,
    body: { model: chosen, prompt, size, n: 1, response_format: "b64_json" },
  }, request);
  const image = decodeImage(body);
  const saved = await saveImage(config, image, signal);
  return { generated: true, family, model: chosen, size: image.size, requestedSize: size, ...saved };
}
