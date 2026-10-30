import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeBridge } from "./bridge-process.mjs";
import { DEFAULT_IMAGE_MODEL, GEMINI_IMAGE_MODEL } from "./image-models.mjs";
import { requestLocal, httpFailure } from "./local-http.mjs";

const execFileAsync = promisify(execFile);
const previewScript = fileURLToPath(new URL("../scripts/image-preview.ps1", import.meta.url));
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const INLINE_BASE64_LIMIT = 190 * 1024;

/** 所有支持格式统一限制为 40MP，避免将巨大尺寸交给后续预览器。 */
const MAX_IMAGE_PIXELS = 40_000_000;

/** 只传播本地定义的诊断，不把上游正文、图片内容或凭据带入错误。 */
function safeError(message, code = "IMAGE_GENERATION_FAILED") {
  return Object.assign(new Error(message), { safeMessage: message, code });
}

/** 检查头部声明的像素尺寸；压缩像素流本身不在此解码。 */
function validateDimensions(width, height) {
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) throw safeError("图片尺寸超出处理限制");
}

/** 校验常见 Huffman DCT JPEG 的段、表、帧与扫描边界，不验证全部熵编码像素。 */
function validateJpeg(bytes) {
  let offset = 2;
  let frame;
  let restartInterval = 0;
  const quantizationTables = new Set();
  const huffmanTables = new Set();
  const scannedComponents = new Set();
  // 段长度包含长度字段本身；只有 SOI/EOI 和扫描内的重启标记没有长度。
  segments: while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (frame && scannedComponents.size === frame.components.size && offset === bytes.length) return;
      break;
    }
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    const start = offset + 2;
    const end = offset + length;
    if (length < 2 || end > bytes.length) break;

    if (marker === 0xdb) {
      // 量化表可在同一段内连续定义；拒绝表项不足或非法表精度/编号。
      let cursor = start;
      while (cursor < end) {
        const info = bytes[cursor++];
        const precision = info >> 4;
        if (precision > 1 || (info & 15) > 3) break segments;
        cursor += 64 * (precision + 1);
        if (cursor <= end) quantizationTables.add(info & 15);
      }
      if (cursor !== end || length === 2) break;
    } else if (marker === 0xc4) {
      // Huffman 表的 16 个计数决定符号区长度，不解码实际扫描内容。
      let cursor = start;
      while (cursor < end) {
        const info = bytes[cursor++];
        if ((info >> 4) > 1 || (info & 15) > 3 || cursor + 16 > end) break segments;
        let symbols = 0;
        let available = 1;
        for (let index = 0; index < 16; index++) {
          const count = bytes[cursor++];
          symbols += count;
          available = available * 2 - count;
          if (available < 0) break;
        }
        if (available < 0 || !symbols || symbols > 256) break segments;
        cursor += symbols;
        if (cursor <= end) huffmanTables.add(info);
      }
      if (cursor !== end || length === 2) break;
    } else if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      // 支持基线、扩展顺序与渐进 DCT；同一文件必须只有一个完整帧头。
      if (frame || length < 11) break;
      const precision = bytes[start];
      const count = bytes[start + 5];
      if (!count || length !== 8 + 3 * count ||
          (precision !== 8 && (marker === 0xc0 || precision !== 12))) break;
      validateDimensions(bytes.readUInt16BE(start + 3), bytes.readUInt16BE(start + 1));
      const components = new Map();
      for (let cursor = start + 6; cursor < end; cursor += 3) {
        const id = bytes[cursor];
        const sampling = bytes[cursor + 1];
        const table = bytes[cursor + 2];
        if (components.has(id) || !(sampling >> 4) || (sampling >> 4) > 4 ||
            !(sampling & 15) || (sampling & 15) > 4 || table > 3) break;
        components.set(id, table);
      }
      if (components.size !== count) break;
      frame = { progressive: marker === 0xc2, components };
    } else if (marker === 0xdd) {
      if (length !== 4) break;
      restartInterval = bytes.readUInt16BE(start);
    } else if (marker === 0xda) {
      // 每次 SOS 都须有有效组件、所需编码表和扫描参数；允许渐进图的多次扫描。
      if (!frame || length < 8) break;
      const count = bytes[start];
      if (!count || count > 4 || length !== 6 + 2 * count) break;
      const spectralStart = bytes[end - 3];
      const spectralEnd = bytes[end - 2];
      const high = bytes[end - 1] >> 4;
      const low = bytes[end - 1] & 15;
      if (frame.progressive ?
        (spectralStart > spectralEnd || spectralEnd > 63 ||
          (spectralStart === 0 ? spectralEnd !== 0 : count !== 1) ||
          high > 13 || low > 13 || (high !== 0 && high !== low + 1)) :
        (spectralStart !== 0 || spectralEnd !== 63 || high !== 0 || low !== 0)) break;
      const components = new Set();
      for (let cursor = start + 1; cursor < end - 3; cursor += 2) {
        const id = bytes[cursor];
        const tables = bytes[cursor + 1];
        if (!frame.components.has(id) || components.has(id) ||
            !quantizationTables.has(frame.components.get(id)) || (tables >> 4) > 3 || (tables & 15) > 3 ||
            (spectralStart === 0 && high === 0 && !huffmanTables.has(tables >> 4)) ||
            (spectralEnd > 0 && !huffmanTables.has(0x10 | (tables & 15))) ||
            (!frame.progressive && scannedComponents.has(id))) break;
        components.add(id);
      }
      if (components.size !== count) break;
      offset = end;
      let entropyBytes = 0;
      let nextRestart = 0;
      // FF00 是像素流中的转义字节；RSTn 不结束扫描，其余标记交回外层解析。
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { entropyBytes++; offset++; continue; }
        const markerStart = offset++;
        if (bytes[offset] === 0) { entropyBytes++; offset++; continue; }
        while (bytes[offset] === 0xff) offset++;
        const scanMarker = bytes[offset];
        if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          if (!restartInterval || !entropyBytes || scanMarker !== 0xd0 + nextRestart) break;
          nextRestart = (nextRestart + 1) % 8;
          entropyBytes = 0;
          offset++;
          continue;
        }
        offset = markerStart;
        break;
      }
      if (!entropyBytes || offset >= bytes.length || bytes[offset] !== 0xff) break;
      if (spectralStart === 0) for (const id of components) scannedComponents.add(id);
      continue;
    } else if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) {
      // 生成端的常见 JPEG 不需要算术编码、分层帧或 DNL；不把未知控制段当元数据跳过。
      break;
    }
    offset = end;
  }
  throw safeError("JPEG 图片截断、结构无效或缺少受支持的图像数据");
}

/** 校验静态 WebP 的 RIFF/chunk 边界、编码头与画布尺寸，不解码 VP8/VP8L 像素流。 */
function validateWebp(bytes) {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length || bytes.length % 2) {
    throw safeError("WebP 图片截断或容器长度无效");
  }
  let offset = 12;
  let canvas;
  let image;
  let alpha;
  const metadata = new Set();
  // 每个 chunk 的长度不含 8 字节头和奇数字节补齐；必须完整覆盖声明的 RIFF 容器。
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const next = end + (length & 1);
    if (next > bytes.length || (length & 1 && bytes[end] !== 0)) break;
    if (type === "VP8X") {
      if (offset !== 12 || length !== 10 || (bytes[start] & 0xc3) || bytes.readUIntLE(start + 1, 3)) break;
      const width = bytes.readUIntLE(start + 4, 3) + 1;
      const height = bytes.readUIntLE(start + 7, 3) + 1;
      validateDimensions(width, height);
      canvas = { width, height, flags: bytes[start] };
    } else if (type === "VP8 " || type === "VP8L") {
      if (image || (!canvas && offset !== 12)) break;
      let width;
      let height;
      if (type === "VP8 ") {
        // WebP 使用显示用关键帧；分区零须完整且后方仍有像素 token 数据。
        if (length <= 10) break;
        const tag = bytes.readUIntLE(start, 3);
        const partitionLength = tag >>> 5;
        if ((tag & 1) || ((tag >> 1) & 7) > 3 || !(tag & 16) || !partitionLength ||
            10 + partitionLength >= length || bytes.readUIntLE(start + 3, 3) !== 0x2a019d) break;
        width = bytes.readUInt16LE(start + 6) & 0x3fff;
        height = bytes.readUInt16LE(start + 8) & 0x3fff;
      } else {
        // VP8L 的前五字节声明签名、尺寸和版本；alpha hint 不参与像素正确性判断。
        if (length <= 5 || bytes[start] !== 0x2f || (bytes[start + 4] >> 5) || alpha) break;
        const bits = bytes.readUInt32LE(start + 1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      validateDimensions(width, height);
      if (canvas && (canvas.width !== width || canvas.height !== height)) break;
      if (alpha && alpha.compression === 0 && alpha.length !== 1 + width * height) break;
      if (canvas && type === "VP8 " && Boolean(canvas.flags & 16) !== Boolean(alpha)) break;
      image = { width, height };
    } else if (type === "ALPH") {
      // 扩展有损图像可先带 alpha 数据；无损图像的透明度直接在 VP8L 内。
      if (!canvas || !(canvas.flags & 16) || image || alpha || length <= 1 ||
          (bytes[start] & 0xc0) || (bytes[start] & 3) > 1 || ((bytes[start] >> 4) & 3) > 1) break;
      alpha = { compression: bytes[start] & 3, length };
    } else if (["ICCP", "EXIF", "XMP "].includes(type)) {
      if (!canvas || !length || metadata.has(type) || (type === "ICCP" && (image || alpha))) break;
      metadata.add(type);
    } else if (type === "ANIM" || type === "ANMF") {
      // 工具返回的是一张静态图；动画不是此结构校验器支持的格式。
      break;
    }
    offset = next;
  }
  if (offset !== bytes.length || !image || (canvas &&
      (Boolean(canvas.flags & 32) !== metadata.has("ICCP") ||
       Boolean(canvas.flags & 8) !== metadata.has("EXIF") ||
       Boolean(canvas.flags & 4) !== metadata.has("XMP ")))) {
    throw safeError("WebP 图片截断、结构无效或缺少静态图像数据");
  }
}

/** 仅接受内联图像并校验结构与尺寸，不追随 URL，也不声称验证全部压缩像素。 */
export function decodeImage(value) {
  if (typeof value !== "string" || !value.length || value.length > 32 * 1024 * 1024 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw safeError("上游没有返回有效的 base64 图片，未下载任何外部 URL");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw safeError("图片编码损坏");
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    validateDimensions(width, height);
    let offset = 8;
    let hasPixels = false;
    let complete = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length || (offset === 8 && (type !== "IHDR" || length !== 13))) break;
      if (type === "IDAT" && length > 0) hasPixels = true;
      offset += length + 12;
      if (type === "IEND" && length === 0) { complete = offset === bytes.length; break; }
    }
    if (!complete || !hasPixels) throw safeError("PNG 图片截断或缺少图像数据");
    return { bytes, mimeType: "image/png", extension: "png" };
  }
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    validateJpeg(bytes);
    return { bytes, mimeType: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 16 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    validateWebp(bytes);
    return { bytes, mimeType: "image/webp", extension: "webp" };
  }
  throw safeError("上游结果不是受支持的 PNG/JPEG/WebP 图片");
}

/** 缩略图只服务于 Qoder 的 MCP 限额；原图始终保留，不以压缩结果替换。 */
async function previewImage(filePath, image, signal) {
  if (image.bytes.toString("base64").length <= INLINE_BASE64_LIMIT) {
    return { type: "image", data: image.bytes.toString("base64"), mimeType: image.mimeType };
  }
  if (process.platform !== "win32" || image.extension === "webp") return null;
  const temporary = `${filePath}.${randomUUID()}.preview.jpg`;
  try {
    await execFileAsync(powerShell, [
      "-NoProfile", "-NonInteractive", "-File", previewScript,
      "-InputPath", filePath, "-OutputPath", temporary,
    ], { windowsHide: true, timeout: 20000, maxBuffer: 8192, signal });
    const bytes = await readFile(temporary);
    const data = bytes.toString("base64");
    if (data.length > INLINE_BASE64_LIMIT) return null;
    return { type: "image", data, mimeType: "image/jpeg" };
  } catch (error) {
    if (signal?.aborted) throw safeError("图片已保存，但预览处理被取消", "ABORT_ERR");
    return null;
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

/**
 * 用已授权订阅生成一张图片，校验后保存原图并返回本地路径与可选预览。
 * 按 model 选择上游协议：GEMINI_IMAGE_MODEL 走原生 generateContent，其余走 OpenAI 图片端点。
 * 不重放 POST、不降级换模型；signal 取消只停止本地等待，不保证上游未消耗额度。
 * @param {object} config 含 host/port/apiKey/imagesDir 的运行配置
 * @param {object} args 已通过工具 schema 校验的文字描述与生成选项
 * @param {{signal?: AbortSignal}} [options] 请求级取消信号
 * @returns {Promise<{content: Array<object>}>} MCP 内容数组，首项为原图路径说明
 */
export async function generateImage(config, args, { signal } = {}) {
  const allowed = ["prompt", "model", "size", "quality", "background", "output_format"];
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).some((key) => !allowed.includes(key)) ||
      typeof args.prompt !== "string" || !args.prompt.trim() || Array.from(args.prompt).length > 32000) {
    throw safeError("请提供非空的图片描述（最多 32000 字符）及受支持的参数", "INVALID_ARGUMENT");
  }
  const model = args.model ?? DEFAULT_IMAGE_MODEL;
  if (typeof model !== "string" || !model.trim() || Array.from(model).length > 200) throw safeError("模型名称无效", "INVALID_ARGUMENT");
  for (const [key, values] of Object.entries({
    size: ["auto", "1024x1024", "1536x1024", "1024x1536"],
    quality: ["auto", "low", "medium", "high"],
    background: ["auto", "transparent", "opaque"],
    output_format: ["png", "jpeg", "webp"],
  })) {
    if (args[key] !== undefined && !values.includes(args[key])) throw safeError(`不支持的 ${key} 参数`, "INVALID_ARGUMENT");
  }
  const gemini = model === GEMINI_IMAGE_MODEL;
  if (gemini && ((args.quality !== undefined && args.quality !== "auto") ||
      (args.background !== undefined && args.background !== "auto") ||
      (args.output_format !== undefined && args.output_format !== "png"))) {
    throw safeError("Gemini 不支持指定质量、背景或 JPEG/WebP 输出编码；请省略这些选项，原图按上游实际格式保存", "INVALID_ARGUMENT");
  }
  // 核心的 OpenAI 图片端点不支持 Gemini；原生接口只接收比例和分辨率档位，不保证精确像素。
  const aspectRatio = { "1024x1024": "1:1", "1536x1024": "3:2", "1024x1536": "2:3" }[args.size];
  const requestBody = gemini ? {
    contents: [{ role: "user", parts: [{ text: args.prompt }] }],
    generationConfig: {
      candidateCount: 1, responseModalities: ["TEXT", "IMAGE"],
      ...(aspectRatio ? { imageConfig: { aspectRatio, imageSize: "1K" } } : {}),
    },
  } : { ...args, model, output_format: args.output_format ?? "png", response_format: "b64_json", n: 1, stream: false };
  const probe = await probeBridge(config);
  if (probe.state !== "bridge") throw safeError("本地订阅桥未就绪，请先检查 bridge_status", "BRIDGE_UNAVAILABLE");
  let response;
  try {
    // 生图是有成本操作：本 MCP 层不重放 POST；核心仍可能按配置刷新凭据或重试。
    response = await requestLocal(config, gemini ? `/v1beta/models/${model}:generateContent` : "/v1/images/generations", {
      method: "POST", authenticated: true, signal, timeoutMs: 240000, maxBytes: 36 * 1024 * 1024,
      body: requestBody,
    });
  } catch (error) {
    if (signal?.aborted || error.code === "ABORT_ERR") throw safeError("生图请求已取消；上游可能已消耗额度。本 MCP 未自动重试；核心仍可能按配置重试", "ABORT_ERR");
    throw safeError("生图连接中断或超时；上游可能已消耗额度。本 MCP 未自动重试；核心仍可能按配置重试。检查代理节点与管理面板后再决定是否手动重试。", "IMAGE_CONNECTION_FAILED");
  }
  if (response.status !== 200) throw safeError(httpFailure(response.status, "生图").message);
  let body;
  try { body = JSON.parse(response.text); } catch { throw safeError("生图端点返回了非 JSON 内容"); }
  let image;
  if (gemini) {
    const parts = Array.isArray(body?.candidates) && body.candidates.length === 1 ? body.candidates[0]?.content?.parts : null;
    if (!Array.isArray(parts)) throw safeError("Gemini 未返回预期的一张图片");
    const images = parts.filter((part) => part?.inlineData).map((part) => part.inlineData);
    if (images.length !== 1) throw safeError("Gemini 未返回预期的一张图片");
    image = decodeImage(images[0].data);
    if (images[0].mimeType !== image.mimeType) throw safeError("Gemini 图片类型与实际编码不一致");
  } else {
    if (!Array.isArray(body?.data) || body.data.length !== 1) throw safeError("生图端点未返回预期的一张图片");
    image = decodeImage(body.data[0]?.b64_json);
  }
  await mkdir(config.imagesDir, { recursive: true, mode: 0o700 });
  const filePath = join(config.imagesDir, `image-${Date.now()}-${randomUUID()}.${image.extension}`);
  await writeFile(filePath, image.bytes, { flag: "wx", mode: 0o600 });
  const preview = await previewImage(filePath, image, signal);
  return { content: [
    { type: "text", text: `图片已生成，原图保存在：${filePath}\n请向用户展示原图的本地 Markdown 文件链接。${preview ? "附带的是适合会话显示的预览，原图未压缩。" : "原图较大或该格式无法生成预览，请打开本地图片链接。"}` },
    ...(preview ? [preview] : []),
  ] };
}
