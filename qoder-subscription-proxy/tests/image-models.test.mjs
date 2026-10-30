import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IMAGE_MODEL, GEMINI_IMAGE_MODEL, isRoutableImageModel } from "../bridge/image-models.mjs";

test("图片模型常量固定为工具 schema 与请求路由使用的名称", () => {
  assert.equal(DEFAULT_IMAGE_MODEL, "gpt-image-2.5");
  assert.equal(GEMINI_IMAGE_MODEL, "gemini-3.1-flash-image");
});

test("可路由图片模型覆盖 gpt-image 同族变体与 Gemini 原生图片模型", () => {
  for (const id of [DEFAULT_IMAGE_MODEL, "gpt-image-1", "gpt-image-2.5-flare", GEMINI_IMAGE_MODEL]) {
    assert.equal(isRoutableImageModel(id), true, id);
  }
});

test("聊天模型、相近 Gemini 名称与不完整前缀不被当作可路由图片模型", () => {
  const excluded = [
    "gemini-3.1-pro", "gemini-2.5-flash", "gemini-2.5-flash-image-preview",
    "gemini-3.1-flash-image-lite", "gpt-5", "codex-auto-review", "gpt-image", "",
  ];
  for (const id of excluded) assert.equal(isRoutableImageModel(id), false, id);
});