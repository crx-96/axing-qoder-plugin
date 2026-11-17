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

// MIME 不足以证明图片有效；只检查容器边界，不重新实现像素解码器。
function imageExtension(bytes, mime) {
  // PNG 必须具有非零尺寸的首个 IHDR、图片数据与终止块，块长度不能越界。
  if (mime === "image/png" && bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    let offset = 8;
    let hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) break;
      if (offset === 8 && (type !== "IHDR" || length !== 13 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20))) break;
      if (type === "IDAT" && length > 0) hasData = true;
      offset += 12 + length;
      if (type === "IEND") return hasData && length === 0 && offset === bytes.length ? "png" : null;
    }
  }
  // JPEG 要求起止标记、非零尺寸帧及扫描段；压缩扫描正文不在此重实现解码。
  if (mime === "image/jpeg" && bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
    let offset = 2;
    let hasFrame = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        hasFrame = bytes.readUInt16BE(offset + 5) > 0 && bytes.readUInt16BE(offset + 7) > 0;
      }
      if (marker === 0xda) return hasFrame && length >= 6 && offset + 2 + length < bytes.length - 2 ? "jpg" : null;
      offset += 2 + length;
    }
  }
  // WebP 按 RIFF 声明长度与偶数字节填充遍历，必须有 VP8 或 VP8L 图片块。
  if (mime === "image/webp" && bytes.length >= 26 && bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) === bytes.length - 8) {
    let offset = 12;
    let hasImage = false;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      if (offset + 8 + length > bytes.length) return null;
      if (type === "VP8 " && length >= 10 && bytes.subarray(offset + 11, offset + 14).equals(Buffer.from("9d012a", "hex"))) hasImage = true;
      if (type === "VP8L" && length >= 5 && bytes[offset + 8] === 0x2f) hasImage = true;
      offset += 8 + length + (length % 2);
    }
    if (hasImage && offset === bytes.length) return "webp";
  }
  return null;
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
  const extension = imageExtension(bytes, item.mime_type);
  if (!extension) throw failure("图片 MIME 或实际文件格式无效；仅支持 PNG、JPEG、WebP。");
  return { bytes, extension, mime: item.mime_type };
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

export async function generateImage(config, { family, prompt, model, size = DEFAULT_IMAGE_SIZE, signal }, request = requestOwned) {
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
  return { generated: true, family, model: chosen, size, ...saved };
}
