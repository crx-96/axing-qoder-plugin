import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { imageModelsByFamily } from "../server/image-generation.mjs";
import { handleMessage } from "../server/mcp-protocol.mjs";

const MODELS = ["gpt-6.1-sol", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
  "gemini-3-flash", "gemini-3.1-flash-image", "claude-sonnet-4-6"];

test("生图模型按族过滤，排除聊天与其他族模型", () => {
  assert.deepEqual(imageModelsByFamily(MODELS, "gpt"), ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
  assert.throws(() => imageModelsByFamily(MODELS, "gemini"), /未知的生图族/);
  assert.deepEqual(imageModelsByFamily([], "gpt"), []);
  assert.throws(() => imageModelsByFamily(MODELS, "grok"), /未知的生图族/);
});

test("tools/list 只公开可用 GPT 生图能力，提示词必填", async () => {
  const response = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { config: {} });
  const tools = response.result.tools;
  assert.equal(tools.some(tool => tool.name === "image_gen_gemini"), false);
  for (const name of ["image_gen_gpt"]) {
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
    params: { name: "image_gen_gemini", arguments: { prompt: "一只狗", model: "gemini-3.1-flash-image", size: "2048x2048" } } }, ctx, { handlers });
  assert.equal(calls.length, 1);
  assert.equal(gemini.result.isError, true);
  assert.match(gemini.result.content[0].text, /不会回退旧 Google 通道/);
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

test("Gemini 生图不触及核心，GPT 生图及 HTTP 安全诊断保持有效", { timeout: 15000 }, () => {
  const server = fileURLToPath(new URL("../server/", import.meta.url));
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import { mkdtemp, readFile, rm } from 'node:fs/promises';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { pathToFileURL } from 'node:url';
    const context = vm.createContext({ Buffer, AbortController, setTimeout, clearTimeout, setInterval, clearInterval });
    const calls = [];
    let responseStatus = 200;
    const imageBytes = Buffer.from('synthetic-image');
    const dependencies = {
      './supervisor.mjs': {
        ensureRunning() {}, getStatus() {}, stopBridge() {},
        async requestOwned(_config, path, options) {
          calls.push({ path, ...options });
          if (responseStatus !== 200) return { status: responseStatus, text: 'private-upstream-response-token' };
          const base64 = imageBytes.toString('base64');
          return { status: 200, text: JSON.stringify(path === '/v1/images/generations'
            ? { data: [{ b64_json: base64 }] }
            : { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + base64 } }] } }] }) };
        },
      },
      './config.mjs': { PLUGIN_VERSION: 'fixture', MANAGEMENT_PORT: 19788 },
      './local-http.mjs': await import(pathToFileURL(join(${JSON.stringify(server)}, 'local-http.mjs'))),
    };
    const modules = new Map();
    async function load(name) {
      if (modules.has(name)) return modules.get(name);
      let module;
      if (name.startsWith('node:') || dependencies[name]) {
        const exports = dependencies[name] || await import(name);
        module = new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context });
      } else {
        module = new vm.SourceTextModule(await readFile(join(${JSON.stringify(server)}, name), 'utf8'), { context });
      }
      modules.set(name, module);
      await module.link(load);
      return module;
    }
    const image = await load('./image-generation.mjs');
    const protocol = await load('./mcp-protocol.mjs');
    await image.evaluate();
    await protocol.evaluate();
    const root = await mkdtemp(join(tmpdir(), 'image-request-regression-'));
    const config = { dataDir: root, apiKey: 'private-api-fixture', mgmtKey: 'private-management-fixture' };
    try {
      for (const size of [undefined, '1K', '2048x2048', 'garbage']) {
        await assert.rejects(image.namespace.generateImage(config, { family: 'gemini', model: 'gemini-fixture-image', prompt: 'synthetic', size }), error => error.code === 'ACP_IMAGE_UNSUPPORTED');
        assert.equal(calls.length, 0);
      }
      const gpt = await image.namespace.generateImage(config, { family: 'gpt', model: 'gpt-image-fixture', prompt: 'synthetic', size: '1536x1024' });
      assert.equal(calls.at(-1).body.size, '1536x1024');
      assert.equal(gpt.size, '1536x1024');
      for (const status of [401, 403, 429, 502]) {
        responseStatus = status;
        const response = await protocol.namespace.handleMessage({ jsonrpc: '2.0', id: status, method: 'tools/call', params: {
          name: 'image_gen_gpt', arguments: { prompt: 'synthetic', model: 'gpt-image-fixture' },
        } }, { config });
        assert.equal(response.result.isError, true);
        assert.match(response.result.content[0].text, new RegExp('HTTP ' + status));
        if (status === 429) assert.match(response.result.content[0].text, /额度或速率/);
        assert.doesNotMatch(response.result.content[0].text, /private-|BRIDGE_NOT_READY/);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  `;
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 12000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
