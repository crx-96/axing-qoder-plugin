import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureMagpieConfig } from "../server/config.mjs";
import { ensureRunning, stopBridge } from "../server/supervisor.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";
import { tmpdir } from "node:os";
import { join, extname, isAbsolute } from "node:path";
import { generateImage, imageModelsByFamily, listImageModels } from "../server/image-generation.mjs";

const MODEL = "codex/gpt-image-2";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=", "base64");
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const OPTIONS = { family: "gpt", model: MODEL, prompt: "一只猫" };

function response(body) { return { status: 200, text: JSON.stringify(body) }; }
function modelsResponse(models) {
  return response({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "generate_image", inputSchema: { properties: { model: { type: "string", enum: models } } } }] } });
}
function imageResponse(bytes = PNG, mime = "image/png") {
  return response({ data: [{ b64_json: bytes.toString("base64"), mime_type: mime }] });
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "magpie-image-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, apiKey: "private-api-key", mgmtKey: "private-management-key" };
}
function safeError(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.safeMessage, error.message);
  assert.doesNotMatch(error.message, /private-|https?:|127\.0\.0\.1/);
  return true;
}

test("原生核心图片目录与生成端点贯通，假上游图片实际落盘", { skip: nativeCoreSkip, timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "magpie-native-image-"));
  const seen = [];
  const servers = [];
  let config;
  t.after(async () => {
    if (config) await stopBridge(config);
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "gpt-image-1" }] }));
    if (req.url === "/v1/images/generations") {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      return res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
    }
    res.writeHead(404).end("{}");
  });
  for (const server of [upstream, http.createServer(), http.createServer()]) {
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const port = servers[1].address().port;
  const managementPort = servers[2].address().port;
  const binDir = join(root, "bin");
  await mkdir(binDir);
  const binPath = await copyTestCore(join(binDir, process.platform === "win32" ? "magpie.exe" : "magpie"));
  config = await loadConfig({ pluginRoot: fileURLToPath(new URL("../", import.meta.url)), env: {
    BRIDGE_DATA_DIR: join(root, "data"), BRIDGE_BIN: binPath,
    BRIDGE_PORT: String(port), BRIDGE_MANAGEMENT_PORT: String(managementPort),
  } });
  await ensureMagpieConfig(config);
  const settings = JSON.parse(await readFile(config.configPath, "utf8"));
  await writeFile(config.configPath, JSON.stringify({ ...settings, proxy: "direct", imageGen: "fixture/gpt-image-1" }));
  await writeFile(join(config.profileDir, "providers.json"), JSON.stringify({ providers: [{
    id: "fixture", name: "Local image fixture", key: "test-only-key", listOff: true,
    chat: `http://127.0.0.1:${upstream.address().port}/v1`, models: ["gpt-image-1"],
  }] }));
  for (const server of servers.slice(1)) await new Promise(resolve => server.close(resolve));
  assert.equal((await ensureRunning(config)).ready, true);
  assert.ok((await listImageModels(config, "gpt")).includes("fixture/gpt-image-1"));
  const result = await generateImage(config, { family: "gpt", prompt: "local image fixture", model: "fixture/gpt-image-1" });
  assert.deepEqual(await readFile(result.path), PNG);
  assert.equal(result.mime, "image/png");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "gpt-image-1");
  assert.equal(seen[0].prompt, "local image fixture");
});

test("目录只匹配 provider/gpt-image-*，去重且排除旧裸名、聊天和 Gemini", () => {
  assert.deepEqual(imageModelsByFamily([MODEL, "other/gpt-image-fixture", MODEL, "gpt-image-2",
    "codex/gpt-5", "agy/gemini-image", "codex/gpt-image-", "../gpt-image-2", "x/y/gpt-image-2", null], "gpt"),
  [MODEL, "other/gpt-image-fixture"]);
  assert.throws(() => imageModelsByFamily([], "gemini"), e => e.code === "INVALID_PARAMS");
});

test("模型目录解析 provider 前缀，使用短时限、鉴权与有界响应", async () => {
  const controller = new AbortController();
  const ids = await listImageModels({}, "gpt", controller.signal, async (_config, path, options) => {
    assert.equal(path, "/mcp/magpie/image");
    assert.equal(options.signal, controller.signal);
    assert.equal(options.authenticated, true);
    assert.equal(options.timeoutMs, 10000);
    assert.equal(options.maxBytes, 1024 * 1024);
    assert.equal(options.method, "POST");
    assert.deepEqual(options.body, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    return modelsResponse([null, MODEL, "codex/gpt-5"]);
  });
  assert.deepEqual(ids, [MODEL]);
});

test("单模型自动生成，严格使用 Magpie 原生协议，结果仅为本地元数据", async (t) => {
  const config = await fixture(t);
  const calls = [];
  const output = await generateImage(config, { family: "gpt", prompt: "一只猫" }, async (_config, path, options) => {
    calls.push(path);
    if (path === "/mcp/magpie/image") return modelsResponse([MODEL]);
    assert.equal(options.authenticated, true);
    assert.equal(options.method, "POST");
    assert.equal(options.timeoutMs, 300000);
    assert.equal(options.maxBytes, 64 * 1024 * 1024);
    assert.deepEqual(options.body, { model: MODEL, prompt: "一只猫", size: "1024x1024", n: 1, response_format: "b64_json" });
    return imageResponse();
  });
  assert.deepEqual(calls, ["/mcp/magpie/image", "/v1/images/generations"]);
  assert.equal(output.generated, true);
  assert.equal(output.model, MODEL);
  assert.equal(output.mime, "image/png");
  assert.equal(output.bytes, PNG.length);
  assert.equal(isAbsolute(output.path), true);
  assert.equal(output.path.startsWith(join(config.dataDir, "generated")), true);
  assert.deepEqual(await readFile(output.path), PNG);
  assert.deepEqual(Object.keys(output).sort(), ["bytes", "family", "generated", "mime", "model", "path", "size"]);
  assert.doesNotMatch(JSON.stringify(output), /private-|b64_json/);
  if (process.platform !== "win32") assert.equal((await stat(output.path)).mode & 0o777, 0o600);
});

test("多模型只返回选择，不提交生图或创建目录", async (t) => {
  const config = await fixture(t);
  let calls = 0;
  const output = await generateImage(config, { family: "gpt", prompt: "x" }, async (_config, path) => {
    calls++;
    assert.equal(path, "/mcp/magpie/image");
    return modelsResponse([MODEL, "second/gpt-image-test"]);
  });
  assert.deepEqual(output, { needsModelChoice: true, family: "gpt", models: [MODEL, "second/gpt-image-test"] });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("上游省略图片枚举时要求显式选择，不回退聊天模型目录", async () => {
  let calls = 0;
  await assert.rejects(listImageModels({}, "gpt", undefined, async (_config, path) => {
    calls++;
    assert.equal(path, "/mcp/magpie/image");
    return modelsResponse(undefined);
  }), error => error.code === "IMAGE_MODELS_UNAVAILABLE" && /显式指定 model/.test(error.safeMessage));
  assert.equal(calls, 1);
});

test("无图片模型安全失败", async () => {
  await assert.rejects(generateImage({}, { family: "gpt", prompt: "x" }, async () => modelsResponse(["codex/gpt-5"])),
    e => safeError(e, "BRIDGE_NOT_READY"));
});

test("prompt/model/family/size 非法时不访问核心", async () => {
  const invalid = [{ prompt: "" }, { prompt: "  " }, { prompt: 7 }, { prompt: "x".repeat(32001) },
    { model: "" }, { model: null }, { model: 7 }, { model: "gpt-image-2" }, { model: "codex/gpt-5" },
    { model: "agy/gemini-image" }, { model: "https://private-key/gpt-image-2" },
    { family: "gemini" }, { size: "1K" }, { size: null }, { size: "0x1" }, { size: "1x999999" }];
  for (const options of invalid) {
    await assert.rejects(generateImage({}, { ...OPTIONS, ...options }, async () => assert.fail("不能请求")),
      e => safeError(e, "INVALID_PARAMS"));
  }
});

for (const [mime, bytes, extension] of [["image/png", PNG, ".png"], ["image/jpeg", JPEG, ".jpg"], ["image/webp", WEBP, ".webp"]]) {
  test(`${mime} 按真实格式落盘，指定模型不查询目录`, async (t) => {
    const config = await fixture(t);
    let calls = 0;
    const output = await generateImage(config, { ...OPTIONS, size: "1536x1024" }, async (_config, path, options) => {
      calls++;
      assert.equal(path, "/v1/images/generations");
      assert.equal(options.body.size, "1536x1024");
      return imageResponse(bytes, mime);
    });
    assert.equal(calls, 1);
    assert.equal(extname(output.path), extension);
    assert.equal(output.mime, mime);
    assert.deepEqual(await readFile(output.path), bytes);
    assert.equal((await readdir(join(config.dataDir, "generated"))).length, 1);
  });
}

test("并行保存文件唯一且不留下临时文件、不覆盖既有文件", async (t) => {
  const config = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => generateImage(config, OPTIONS, async () => imageResponse())));
  assert.equal(new Set(results.map(result => result.path)).size, 8);
  assert.equal((await readdir(join(config.dataDir, "generated"))).length, 8);
  for (const result of results) assert.deepEqual(await readFile(result.path), PNG);
});

test("非法、非规范或空 base64 拒绝且不落盘", async (t) => {
  const config = await fixture(t);
  for (const base64 of ["", "!!!!", "a===", "YW Jj", "YWJj\n", "Zh==", "data:image/png;base64,eA==", 123]) {
    await assert.rejects(generateImage(config, OPTIONS, async () => response({ data: [{ b64_json: base64, mime_type: "image/png" }] })),
      e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("MIME 不匹配、假图片、截断容器拒绝", async (t) => {
  const config = await fixture(t);
  for (const [bytes, mime] of [[PNG, "image/jpeg"], [PNG, undefined], [PNG, "image/svg+xml"],
    [Buffer.from("not-an-image"), "image/png"], [PNG.subarray(0, 33), "image/png"],
    [JPEG.subarray(0, -2), "image/jpeg"], [WEBP.subarray(0, -2), "image/webp"]]) {
    await assert.rejects(generateImage(config, OPTIONS, async () => response({ data: [{ b64_json: bytes.toString("base64"), mime_type: mime }] })),
      e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("URL-only 不访问任意远端、不重试且固定安全诊断", async (t) => {
  const config = await fixture(t);
  let calls = 0;
  await assert.rejects(generateImage(config, OPTIONS, async () => {
    calls++;
    return response({ data: [{ url: "http://127.0.0.1/private-token" }] });
  }), e => {
    safeError(e, "IMAGE_OUTPUT_UNAVAILABLE");
    assert.equal(e.message, "上游仅返回远程图片链接，未取得可保存图片，请在Magpie检查生成结果，不要重复提交");
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("HTTP 错误只公开状态和本地诊断，不泄漏正文、不重试", async () => {
  for (const status of [401, 403, 429, 500, 502]) {
    let calls = 0;
    await assert.rejects(generateImage({}, OPTIONS, async () => {
      calls++;
      return { status, text: "private-upstream-token" };
    }), e => {
      safeError(e, status);
      assert.match(e.message, new RegExp(`HTTP ${status}`));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("错误 JSON、结构和传输错误固定脱敏", async () => {
  for (const text of ["private-token{", "null", "{}", '{"data":{}}', '{"data":[]}']) {
    await assert.rejects(generateImage({}, OPTIONS, async () => ({ status: 200, text })), e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  }
  await assert.rejects(generateImage({}, OPTIONS, async () => { throw new Error("private-api-key"); }), e => safeError(e, "IMAGE_REQUEST_FAILED"));
  await assert.rejects(listImageModels({}, "gpt", undefined, async () => response(null)), e => safeError(e, "IMAGE_OUTPUT_INVALID"));
});

test("响应和解码大小有限，超限不会落盘", async (t) => {
  const config = await fixture(t);
  await assert.rejects(generateImage(config, OPTIONS, async () => ({ status: 200, text: "x".repeat(64 * 1024 * 1024 + 1) })),
    e => safeError(e, "RESPONSE_TOO_LARGE"));
  const tooLarge = Buffer.alloc(32 * 1024 * 1024 + 1).toString("base64");
  await assert.rejects(generateImage(config, OPTIONS, async () => response({ data: [{ b64_json: tooLarge, mime_type: "image/png" }] })),
    e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("预先取消不请求、不传播 reason；进行中取消传给 HTTP", async (t) => {
  const config = await fixture(t);
  const before = new AbortController();
  before.abort("private-cancel-reason");
  await assert.rejects(generateImage(config, { ...OPTIONS, signal: before.signal }, async () => assert.fail("不能请求")),
    e => safeError(e, "ABORT_ERR"));
  const during = new AbortController();
  const pending = generateImage(config, { ...OPTIONS, signal: during.signal }, async (_config, _path, { signal }) => {
    assert.equal(signal, during.signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-cancel-reason")), { once: true });
      during.abort("private-cancel-reason");
    });
  });
  await assert.rejects(pending, e => safeError(e, "ABORT_ERR"));
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("HTTP 完成后取消不保存；模型查询结束后取消不生成", async (t) => {
  const config = await fixture(t);
  for (const model of [MODEL, undefined]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(generateImage(config, { ...OPTIONS, model, signal: controller.signal }, async () => {
      calls++;
      controller.abort("private-reason");
      return model ? imageResponse() : response({ data: [{ id: MODEL }] });
    }), e => safeError(e, "ABORT_ERR"));
    assert.equal(calls, 1);
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("磁盘目标冲突安全失败且保留用户原有文件", async (t) => {
  const config = await fixture(t);
  await writeFile(join(config.dataDir, "generated"), "existing-user-data");
  await assert.rejects(generateImage(config, OPTIONS, async () => imageResponse()), e => safeError(e, "IMAGE_SAVE_FAILED"));
  assert.equal(await readFile(join(config.dataDir, "generated"), "utf8"), "existing-user-data");
});
