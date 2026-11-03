import assert from "node:assert/strict";
import test from "node:test";
import { imageModelsByFamily } from "../server/image-generation.mjs";
import { handleMessage } from "../server/mcp-protocol.mjs";

const MODELS = ["gpt-6.1-sol", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
  "gemini-3-flash", "gemini-3.1-flash-image", "claude-sonnet-4-6"];

test("生图模型按族过滤，排除聊天与其他族模型", () => {
  assert.deepEqual(imageModelsByFamily(MODELS, "gpt"), ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
  assert.deepEqual(imageModelsByFamily(MODELS, "gemini"), ["gemini-3.1-flash-image"]);
  assert.deepEqual(imageModelsByFamily([], "gpt"), []);
  assert.throws(() => imageModelsByFamily(MODELS, "grok"), /未知的生图族/);
});

test("tools/list 暴露两个生图工具且提示词必填", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { config: {} });
  const tools = response.result.tools;
  for (const name of ["image_gen_gpt", "image_gen_gemini"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, name);
    assert.deepEqual(tool.inputSchema.required, ["prompt"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test("生图工具按族分发参数并原样返回多模型待选结果", async () => {
  const calls = [];
  const handlers = {
    generateImage: async (_config, options) => {
      calls.push(options);
      // 模拟 gpt 族多模型待选与 gemini 族单模型直调两种决策路径。
      return options.family === "gpt" && options.model === undefined
        ? { needsModelChoice: true, family: "gpt", models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] }
        : { generated: true, family: options.family, model: options.model ?? "gemini-3.1-flash-image", path: "/tmp/x.png", bytes: 1 };
    },
  };
  const ctx = { config: { apiKey: "secret", mgmtKey: "secret2" } };
  const choice = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "image_gen_gpt", arguments: { prompt: "一只猫" } } }, ctx, { handlers });
  assert.deepEqual(calls.at(-1), { family: "gpt", prompt: "一只猫", model: undefined, size: undefined, signal: undefined });
  assert.match(choice.result.content[0].text, /needsModelChoice/);
  assert.match(choice.result.content[0].text, /gpt-image-2.5-sunburst/);
  const gemini = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "image_gen_gemini", arguments: { prompt: "一只狗", model: "gemini-3.1-flash-image", size: "512x512" } } }, ctx, { handlers });
  assert.deepEqual(calls.at(-1), { family: "gemini", prompt: "一只狗", model: "gemini-3.1-flash-image", size: "512x512", signal: undefined });
  assert.match(gemini.result.content[0].text, /"generated": true/);
  assert.match(gemini.result.content[0].text, /\/tmp\/x\.png/);
});

test("生图工具参数校验拒绝缺失提示词、未知字段与非字符串，管理工具仍拒非空", async () => {
  const ctx = { config: {} };
  for (const args of [{}, { model: "gpt-image-2.5-flare" }, { prompt: "x", extra: "1" }, { prompt: 5 }, { prompt: "  " }]) {
    const response = await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "image_gen_gpt", arguments: args } }, ctx);
    assert.equal(response.error?.code, -32602, JSON.stringify(args));
  }
  const legacy = await handleMessage({ jsonrpc: "2.0", id: 10, method: "tools/call",
    params: { name: "bridge_status", arguments: { prompt: "x" } } }, ctx);
  assert.equal(legacy.error?.code, -32602);
});
