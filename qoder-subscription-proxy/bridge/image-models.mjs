/** 生图模型标识：状态查询、工具 schema 与实际请求路由共用同一来源，避免清单与能力漂移。 */

/** 省略 model 时使用的默认图片模型，经核心的 OpenAI 图片端点生成。 */
export const DEFAULT_IMAGE_MODEL = "gpt-image-2.5";

/** 唯一改走原生 generateContent 的图片模型；核心的 OpenAI 图片端点不支持它。 */
export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";

/**
 * 判断上游模型清单中的一项是否为本工具能路由的图片模型。
 * 入参来自已校验过 id 均为字符串的模型清单；gpt-image- 前缀覆盖同族变体，
 * Gemini 侧只承认原生接口支持的这一个名称，其余 Gemini 名称会被送往不支持它的图片端点。
 */
export function isRoutableImageModel(id) {
  return id.startsWith("gpt-image-") || id === GEMINI_IMAGE_MODEL;
}