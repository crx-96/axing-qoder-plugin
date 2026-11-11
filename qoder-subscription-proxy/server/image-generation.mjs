/** 订阅代理生图：GPT 族走 OpenAI 图片接口，Gemini 族走聊天接口的 images 字段；结果解码落盘，base64 不进入对话。 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { httpFailure } from "./local-http.mjs";
import { requestOwned } from "./supervisor.mjs";

/** 两个生图族的模型命名约定：核心图片接口只接受 gpt-image 系，Gemini 图片模型以 -image 结尾并经聊天接口出图。 */
const FAMILY_PATTERNS = {
  gpt: /^gpt-image-/,
  gemini: /^gemini-.*-image$/,
};
/** 生图上游耗时可达数十秒，单独放宽时限；模型清单查询仍用短时限。 */
const REQUEST_TIMEOUT_MS = 300_000;
/** 模型清单查询时限。 */
const MODELS_TIMEOUT_MS = 10_000;
/** 图片 base64 响应体上限，防止无界缓冲。 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** 缺省输出尺寸；调用方可用 size 参数覆盖。 */
export const DEFAULT_IMAGE_SIZE = "1024x1024";
const GEMINI_IMAGE_SIZES = new Map([
  ["1K", "1K"], ["2K", "2K"], ["4K", "4K"],
  ["1024x1024", "1K"], ["2048x2048", "2K"], ["4096x4096", "4K"],
]);

/** 生图失败只传播状态码诊断，不回显上游正文或凭据。 */
function imageFailure(response) {
  const error = httpFailure(response.status, "生图");
  return Object.assign(error, { code: response.status, safeMessage: error.message });
}

/** 按族过滤可用生图模型；输入为核心 /v1/models 的模型 ID 列表。 */
export function imageModelsByFamily(ids, family) {
  const pattern = FAMILY_PATTERNS[family];
  if (!pattern) throw new Error(`未知的生图族 ${family}。`);
  return ids.filter((id) => typeof id === "string" && pattern.test(id));
}

/** 查询核心模型清单并返回指定族的生图模型；清单结构无效时抛固定诊断。 */
export async function listImageModels(config, family, signal) {
  const response = await requestOwned(config, "/v1/models",
    { authenticated: true, signal, timeoutMs: MODELS_TIMEOUT_MS });
  if (response.status !== 200) throw imageFailure(response);
  let body;
  try { body = JSON.parse(response.text); } catch { throw new Error("核心模型清单不是 JSON。"); }
  if (!Array.isArray(body.data)) throw new Error("核心模型清单结构无效。");
  return imageModelsByFamily(body.data.map((model) => model.id), family);
}

/** 按族调用对应上游接口，返回首张图片的 MIME 与 base64；无图片输出时抛固定诊断。 */
async function requestImage(config, { family, model, prompt, size }, signal) {
  if (family === "gpt") {
    const response = await requestOwned(config, "/v1/images/generations", {
      authenticated: true, method: "POST", signal, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES,
      body: { model, prompt, size, n: 1 },
    });
    if (response.status !== 200) throw imageFailure(response);
    const item = JSON.parse(response.text)?.data?.[0];
    if (typeof item?.b64_json !== "string" || !item.b64_json) {
      throw new Error("图片接口未返回 base64 图片数据。");
    }
    return { mime: "image/png", base64: item.b64_json };
  }
  // Gemini 图片模型不经图片接口；聊天响应的 message.images 携带 data URL。
  const response = await requestOwned(config, "/v1/chat/completions", {
    authenticated: true, method: "POST", signal, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES,
    body: { model, messages: [{ role: "user", content: prompt }], stream: false,
      image_config: { aspect_ratio: "1:1", image_size: GEMINI_IMAGE_SIZES.get(size) } },
  });
  if (response.status !== 200) throw imageFailure(response);
  const images = JSON.parse(response.text)?.choices?.[0]?.message?.images;
  const url = Array.isArray(images) ? images[0]?.image_url?.url : undefined;
  const match = /^data:([a-z0-9+.-]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/s.exec(typeof url === "string" ? url : "");
  if (!match) throw new Error("聊天响应未携带 base64 图片数据。");
  return { mime: match[1], base64: match[2].replace(/\s/g, "") };
}

/** 解码并写入数据目录 generated/；文件名含时间、模型与随机后缀，返回绝对路径与字节数。 */
async function saveImage(config, { model, mime, base64 }) {
  const directory = join(config.dataDir, "generated");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const extension = mime.includes("png") ? "png" : mime.includes("jpeg") ? "jpg" : "bin";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeModel = model.replace(/[^A-Za-z0-9.-]/g, "_");
  const path = join(directory, `${stamp}-${safeModel}-${randomBytes(4).toString("hex")}.${extension}`);
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw new Error("图片 base64 解码为空。");
  await writeFile(path, buffer, { mode: 0o600 });
  return { path, bytes: buffer.length };
}

/**
 * 生图工具入口。
 * 省略 model 时按族内可用模型自动决策：仅一个直接生成；多个返回 needsModelChoice 与候选列表，
 * 由宿主弹窗让用户选择后带 model 重调，工具不替用户做选择。
 * @param {object} config loadConfig 运行配置
 * @param {object} options family 为 gpt/gemini；prompt 必填；model、size 可选；signal 为请求级取消
 * @returns {Promise<object>} 生成成功含 path/bytes/model；多模型待选时含 needsModelChoice/models
 */
export async function generateImage(config, { family, prompt, model, size = DEFAULT_IMAGE_SIZE, signal }) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("生图提示词必须是非空字符串。");
  if (family === "gemini" && !GEMINI_IMAGE_SIZES.has(size)) {
    const safeMessage = "Gemini 生图尺寸仅支持 1K、2K、4K 或对应的 1024x1024、2048x2048、4096x4096 方图。";
    throw Object.assign(new Error(safeMessage), { safeMessage, code: "ERR_INVALID_ARG_VALUE" });
  }
  const models = model ? [model] : await listImageModels(config, family, signal);
  if (!models.length) {
    throw Object.assign(new Error(`当前没有可用的 ${family} 生图模型；请检查账号授权或管理页模型列表。`),
      { code: "BRIDGE_NOT_READY", safeMessage: `当前没有可用的 ${family} 生图模型。` });
  }
  if (!model && models.length > 1) return { needsModelChoice: true, family, models };
  const chosen = models[0];
  const image = await requestImage(config, { family, model: chosen, prompt, size }, signal);
  const saved = await saveImage(config, { model: chosen, ...image });
  return { generated: true, family, model: chosen, ...(family === "gemini" ? { requestedSize: size } : { size }), ...saved };
}
