import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, symlink } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setPortSettings } from "../server/bridge-ports.mjs";
import { loadConfig, ensureMagpieConfig } from "../server/config.mjs";
import { resolveActiveConfig } from "../server/core-selection.mjs";
import { crc32 } from "../server/crc32.mjs";
import { ensureRunning, probeBridge, stopBridge } from "../server/supervisor.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";
import { tmpdir } from "node:os";
import { join, extname, isAbsolute } from "node:path";
import { generateImage } from "../server/image-generation.mjs";

const MODEL = "ai-studio/gemini-nano-banana-2.1";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAADAAcBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AP//Z", "base64");
const WEBP = Buffer.from("UklGRi4AAABXRUJQVlA4ICIAAACwAgCdASoRAAMAPm0sk0WkIqGYBABABsS0gABKxAAA5EAA", "base64");
const WEBP_LOSSLESS = Buffer.from("UklGRiQAAABXRUJQVlA4TBcAAAAvK4EQAAdQwAIWsP8BAEX6/18i+p/CBwA=", "base64");

function webpContainer(...chunks) {
  const header = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
  const parts = [header];
  for (const [type, payload] of chunks) {
    const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32LE(payload.length, 4);
    payload.copy(chunk, 8);
    parts.push(chunk);
  }
  const file = Buffer.concat(parts);
  file.writeUInt32LE(file.length - 8, 4);
  return file;
}
const OPTIONS = { model: MODEL, prompt: "一只猫" };
const JOB_ID = `img_${"a".repeat(24)}`;
const FILE_PATH = `/mcp/magpie/image/files/${"b".repeat(32)}.png?t=1234567890.${"c".repeat(43)}`;

function response(body) { return { status: 200, text: JSON.stringify(body) }; }
function toolResponse(content, extra = {}) {
  return response({ jsonrpc: "2.0", id: 1, result: { content, isError: false, ...extra } });
}
function imageResponse(bytes = PNG, mime = "image/png") {
  return toolResponse([{ type: "text", text: "private-message" }, { type: "image", data: bytes.toString("base64"), mimeType: mime }]);
}
function pendingResponse(id = JOB_ID) {
  return toolResponse([{ type: "text", text: "pending" }], { _meta: { "usemagpie.ai/pending": id } });
}
function fileResponse(url) {
  return toolResponse([{ type: "text", text: "private-link" }], { _meta: { "usemagpie.ai/files": [{ url }] } });
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "magpie-image-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, apiKey: "private-api-key", mgmtKey: "private-management-key" };
}
test("生成目录指向其他实例时不向目标写入图片", async t => {
  const config = await fixture(t);
  const other = await fixture(t);
  await symlink(other.dataDir, join(config.dataDir, "generated"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(generateImage(config, OPTIONS, async () => imageResponse()), { code: "IMAGE_SAVE_FAILED" });
  assert.deepEqual(await readdir(other.dataDir), []);
});

function safeError(error, code) {
  assert.equal(error.code, code);
  assert.equal(error.safeMessage, error.message);
  assert.doesNotMatch(error.message, /private-|https?:|127\.0\.0\.1/);
  return true;
}

test("原生生图 MCP 自动选择 Gemini，更换模型和管理端口后仍能保存大图", { skip: nativeCoreSkip, timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "magpie-native-image-"));
  const textChunk = Buffer.alloc(5 * 1024 * 1024 + 12, 0x61);
  textChunk.writeUInt32BE(textChunk.length - 12);
  textChunk.write("tEXtcomment\0", 4);
  textChunk.writeUInt32BE(crc32(textChunk.subarray(4, -4)), textChunk.length - 4);
  const largePng = Buffer.concat([PNG.subarray(0, -12), textChunk, PNG.subarray(-12)]);
  const models = ["gpt-image-1", "gemini-2.5-flash-image"];
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
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: models.map(id => ({ id })) }));
    if (req.url === "/v1/images/generations") {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      return res.end(JSON.stringify({ data: [{ b64_json: largePng.toString("base64") }] }));
    }
    if (req.url === "/v1/chat/completions") {
      seen.push(JSON.parse(Buffer.concat(chunks).toString()));
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Here you go!",
        multi_mod_content: [{ inline_data: { mime_type: "image/png", data: PNG.toString("base64") } }],
      } }] }));
    }
    res.writeHead(404).end("{}");
  });
  for (const server of [upstream, ...Array.from({ length: 4 }, () => http.createServer())]) {
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const [modelPort, managementPort, nextModelPort, nextManagementPort] = servers.slice(1).map(server => server.address().port);
  const dataDir = join(root, "data");
  const binDir = join(root, "bin");
  await mkdir(dataDir);
  await mkdir(binDir);
  await writeFile(join(dataDir, "bridge-ports.json"), JSON.stringify({ modelPort, managementPort }));
  const binPath = await copyTestCore(join(binDir, process.platform === "win32" ? "magpie.exe" : "magpie"));
  config = await loadConfig({ pluginRoot: fileURLToPath(new URL("../", import.meta.url)), env: {
    BRIDGE_DATA_DIR: dataDir, BRIDGE_BIN: binPath,
  } });
  await ensureMagpieConfig(config);
  const settings = JSON.parse(await readFile(config.configPath, "utf8"));
  await writeFile(config.configPath, JSON.stringify({ ...settings, proxy: "direct", imageGen: "fixture/gemini-2.5-flash-image" }));
  await writeFile(join(config.profileDir, "providers.json"), JSON.stringify({ providers: [{
    id: "fixture", name: "Local image fixture", key: "test-only-key", listOff: true,
    chat: `http://127.0.0.1:${upstream.address().port}/v1`, models,
  }] }));
  for (const server of servers.slice(1)) await new Promise(resolve => server.close(resolve));
  assert.equal((await ensureRunning(config)).ready, true);
  const before = await generateImage(await resolveActiveConfig(config), { prompt: "before port change" });
  assert.deepEqual(await readFile(before.path), PNG);
  assert.equal(before.mime, "image/png");
  assert.equal(before.size, "1x1");

  assert.equal((await setPortSettings(config, { modelPort: nextModelPort, managementPort: nextManagementPort })).ready, true);
  assert.equal(config.port, modelPort);
  assert.equal((await probeBridge(config)).state, "offline");
  const active = await resolveActiveConfig(config);
  assert.equal(active.port, nextModelPort);
  assert.equal(active.managementPort, nextManagementPort);
  const after = await generateImage(active, { prompt: "after port change", model: "fixture/gpt-image-1" });
  assert.deepEqual(await readFile(after.path), largePng);
  assert.notEqual(after.path, before.path);
  assert.deepEqual(seen.map(({ model }) => model), ["gemini-2.5-flash-image", "gpt-image-1"]);
  assert.match(JSON.stringify(seen[0].messages), /before port change/);
  assert.equal(seen[1].prompt, "after port change");
});

test("省略模型与尺寸仅调用原生生成工具，默认值由核心决定", async (t) => {
  const config = await fixture(t);
  const calls = [];
  const output = await generateImage(config, { prompt: "一只猫" }, async (_config, path, options) => {
    calls.push(path);
    assert.equal(options.authenticated, true);
    assert.equal(options.method, "POST");
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 300000);
    assert.equal(options.maxBytes, 64 * 1024 * 1024);
    assert.deepEqual(options.body, { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "generate_image", arguments: { prompt: "一只猫" } } });
    return imageResponse();
  });
  assert.deepEqual(calls, ["/mcp/magpie/image"]);
  assert.equal(output.generated, true);
  assert.equal(output.mime, "image/png");
  assert.equal(output.bytes, PNG.length);
  assert.equal(isAbsolute(output.path), true);
  assert.equal(output.path.startsWith(join(config.dataDir, "generated")), true);
  assert.deepEqual(await readFile(output.path), PNG);
  assert.equal(output.size, "1x1");
  assert.deepEqual(Object.keys(output).sort(), ["bytes", "generated", "mime", "path", "size"]);
  assert.doesNotMatch(JSON.stringify(output), /private-|b64_json/);
  if (process.platform !== "win32") assert.equal((await stat(output.path)).mode & 0o777, 0o600);
});

test("慢任务只提交一次生图，使用同一 ID 取回结果", async t => {
  const config = await fixture(t);
  const calls = [];
  const output = await generateImage(config, { ...OPTIONS, size: "16:9" }, async (_config, path, options) => {
    assert.equal(path, "/mcp/magpie/image");
    calls.push(options.body.params);
    return calls.length < 3 ? pendingResponse() : imageResponse();
  });
  assert.deepEqual(calls, [
    { name: "generate_image", arguments: { ...OPTIONS, size: "16:9" } },
    { name: "generation_result", arguments: { id: JOB_ID } },
    { name: "generation_result", arguments: { id: JOB_ID } },
  ]);
  assert.deepEqual(await readFile(output.path), PNG);
  assert.equal(output.requestedSize, "16:9");
});

test("超时信号覆盖建连阶段，截止后的响应也不会保存", async t => {
  const config = await fixture(t);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 300_000);
    return timeout.signal;
  });
  for (const abortConnection of [false, true]) {
    now = 0;
    const calls = [];
    await assert.rejects(generateImage(config, { ...OPTIONS, signal: new AbortController().signal }, async (_config, _path, { signal, body }) => {
      calls.push(body.params.name);
      if (!abortConnection) {
        now = 300_000;
        return imageResponse();
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("private-connection-detail")), { once: true });
        timeout.abort();
        assert.equal(signal.aborted, true);
      });
    }), e => safeError(e, "ETIMEDOUT"));
    assert.deepEqual(calls, ["generate_image"]);
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("prompt/model/size 非法时不访问核心", async () => {
  const invalid = [{ prompt: "" }, { prompt: "  " }, { prompt: 7 }, { prompt: "x".repeat(32001) },
    { model: "" }, { model: null }, { model: 7 }, { model: "x".repeat(201) },
    { size: "1K" }, { size: null }, { size: "0x1" }, { size: "1x999999" }];
  for (const options of invalid) {
    await assert.rejects(generateImage({}, { ...OPTIONS, ...options }, async () => assert.fail("不能请求")),
      e => safeError(e, "INVALID_PARAMS"));
  }
});

for (const [format, mime, bytes, extension, expectedSize] of [
  ["PNG", "image/png", PNG, ".png", "1x1"],
  ["JPEG", "image/jpeg", JPEG, ".jpg", "7x3"],
  ["VP8", "image/webp", WEBP, ".webp", "17x3"],
  ["VP8L", "image/webp", WEBP_LOSSLESS, ".webp", "300x67"],
  // 用与内层帧不同的值，单独验证 VP8X 的两个 24 位画布字段及其加一编码。
  ["VP8X", "image/webp", webpContainer(["VP8X", Buffer.from("00000000010001000100", "hex")],
    ["VP8 ", WEBP.subarray(20)]), ".webp", "65538x257"],
]) {
  test(`${format} 落盘并返回文件尺寸和请求尺寸，可指定非 GPT 模型`, async (t) => {
    const config = await fixture(t);
    let calls = 0;
    const output = await generateImage(config, { ...OPTIONS, size: "1536x1024" }, async (_config, path, options) => {
      calls++;
      assert.equal(path, "/mcp/magpie/image");
      assert.equal(options.body.params.name, "generate_image");
      assert.deepEqual(options.body.params.arguments, { ...OPTIONS, size: "1536x1024" });
      return imageResponse(bytes, mime);
    });
    assert.equal(calls, 1);
    assert.equal(extname(output.path), extension);
    assert.equal(output.mime, mime);
    assert.equal(output.size, expectedSize);
    assert.equal(output.requestedSize, "1536x1024");
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
    await assert.rejects(generateImage(config, OPTIONS, async () => toolResponse([{ type: "image", data: base64, mimeType: "image/png" }])),
      e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("MIME 不匹配、假图片、截断容器拒绝", async (t) => {
  const config = await fixture(t);
  for (const [bytes, mime] of [[PNG, "image/jpeg"], [PNG, undefined], [PNG, "image/svg+xml"],
    [Buffer.from("not-an-image"), "image/png"], [PNG.subarray(0, 33), "image/png"],
    [JPEG.subarray(0, -2), "image/jpeg"], [WEBP.subarray(0, -2), "image/webp"]]) {
    await assert.rejects(generateImage(config, OPTIONS, async () => toolResponse([{ type: "image", data: bytes.toString("base64"), mimeType: mime }])),
      e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("尺寸字段无效、越过块边界或只有画布头时拒绝且不落盘", async (t) => {
  const config = await fixture(t);
  const zeroPng = Buffer.from(PNG);
  zeroPng.writeUInt32BE(0, 16);
  const zeroJpeg = Buffer.from(JPEG);
  zeroJpeg.writeUInt16BE(0, zeroJpeg.indexOf(Buffer.from([0xff, 0xc0])) + 5);
  const frame = WEBP.subarray(20);
  const zeroVp8 = Buffer.from(frame);
  zeroVp8.writeUInt16LE(0xc000, 6); // 两个缩放位不能算入像素宽度。
  for (const [mime, bytes] of [
    ["image/png", zeroPng], ["image/jpeg", zeroJpeg],
    ["image/webp", webpContainer(["VP8 ", zeroVp8])],
    ["image/webp", webpContainer(["VP8 ", frame.subarray(0, 9)])],
    ["image/webp", webpContainer(["VP8L", WEBP_LOSSLESS.subarray(20, 24)], ["JUNK", Buffer.alloc(4)])],
    ["image/webp", webpContainer(["VP8X", Buffer.alloc(9)], ["VP8 ", frame])],
    ["image/webp", webpContainer(["VP8X", Buffer.alloc(10)])],
  ]) {
    await assert.rejects(generateImage(config, OPTIONS, async () => imageResponse(bytes, mime)),
      e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("大图从已验证的模型连接下载，不采用链接中的主机或端口", async t => {
  const config = { ...await fixture(t), host: "127.0.0.1", port: 32123, managementPort: 32124 };
  const paths = [];
  const output = await generateImage(config, OPTIONS, async (actual, path, options) => {
    assert.equal(actual, config);
    assert.equal(options.authenticated, true);
    paths.push(path);
    if (options.method === "POST") return fileResponse(`https://public.example:443${FILE_PATH}`);
    assert.equal(options.binary, true);
    assert.equal(options.maxBytes, 32 * 1024 * 1024);
    return { status: 200, bytes: PNG, headers: { "content-type": "image/png" } };
  });
  assert.deepEqual(paths, ["/mcp/magpie/image", FILE_PATH]);
  assert.deepEqual(await readFile(output.path), PNG);
  assert.doesNotMatch(JSON.stringify(output), /public\.example|1234567890/);
});

test("跳过无效内联图和无效文件候选，下载同次生成的有效图片", async t => {
  const config = await fixture(t);
  const paths = [];
  const output = await generateImage(config, OPTIONS, async (_config, path, options) => {
    paths.push(path);
    if (options.method === "POST") {
      return toolResponse([{ type: "image", data: "invalid", mimeType: "image/png" }], {
        _meta: { "usemagpie.ai/files": [{ url: "https://public.example/invalid" }, { url: `https://public.example${FILE_PATH}` }] },
      });
    }
    return { status: 200, bytes: PNG, headers: { "content-type": "image/png" } };
  });
  assert.deepEqual(paths, ["/mcp/magpie/image", FILE_PATH]);
  assert.deepEqual(await readFile(output.path), PNG);
});

test("缺少有效同源文件路径时不下载，也不重试生成", async t => {
  const config = await fixture(t);
  for (const url of [undefined, "http://127.0.0.1/private-token", `file://${FILE_PATH}`, `http://localhost${FILE_PATH.split("?")[0]}`]) {
    let calls = 0;
    await assert.rejects(generateImage(config, OPTIONS, async () => {
      calls++;
      return fileResponse(url);
    }), e => safeError(e, "IMAGE_OUTPUT_UNAVAILABLE"));
    assert.equal(calls, 1);
  }
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("HTTP 错误只公开状态和本地诊断，不泄漏正文、不重试", async () => {
  for (const status of [401, 403, 404, 429, 500, 502]) {
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

test("生成已提交后，查询或下载失败保留状态码且提示避免重复提交", async () => {
  for (const [initial, followUp, label] of [
    [pendingResponse(), "generation_result", "查询生图结果"],
    [fileResponse(`http://localhost${FILE_PATH}`), FILE_PATH, "下载生图结果"],
  ]) {
    const calls = [];
    await assert.rejects(generateImage({}, OPTIONS, async (_config, path, options) => {
      calls.push(options.body?.params.name ?? path);
      return calls.length === 1 ? initial : { status: 502, text: "private-upstream-detail" };
    }), e => {
      safeError(e, 502);
      assert.match(e.message, new RegExp(`${label}失败（HTTP 502）`));
      assert.match(e.message, /避免重复提交/);
      assert.doesNotMatch(e.message, /后重试/);
      return true;
    });
    assert.deepEqual(calls, ["generate_image", followUp]);
  }
});

test("错误 JSON、结构和传输错误固定脱敏", async () => {
  for (const text of ["private-token{", "null", "{}", '{"jsonrpc":"2.0","id":1,"result":{}}']) {
    await assert.rejects(generateImage({}, OPTIONS, async () => ({ status: 200, text })), e => safeError(e, "IMAGE_OUTPUT_INVALID"));
  }
  for (const failed of [toolResponse([{ type: "text", text: "private-token" }], { isError: true }), response({ error: { message: "private-token" } })]) {
    await assert.rejects(generateImage({}, OPTIONS, async () => failed), e => safeError(e, "IMAGE_TOOL_FAILED"));
  }
  await assert.rejects(generateImage({}, OPTIONS, async () => { throw new Error("private-api-key"); }), e => safeError(e, "IMAGE_REQUEST_FAILED"));
});

test("响应和解码大小有限，超限不会落盘", async (t) => {
  const config = await fixture(t);
  await assert.rejects(generateImage(config, OPTIONS, async () => ({ status: 200, text: "x".repeat(64 * 1024 * 1024 + 1) })),
    e => safeError(e, "RESPONSE_TOO_LARGE"));
  const tooLarge = Buffer.alloc(32 * 1024 * 1024 + 1).toString("base64");
  await assert.rejects(generateImage(config, OPTIONS, async () => toolResponse([{ type: "image", data: tooLarge, mimeType: "image/png" }])),
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
    assert.equal(signal.aborted, false);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-cancel-reason")), { once: true });
      during.abort("private-cancel-reason");
    });
  });
  await assert.rejects(pending, e => safeError(e, "ABORT_ERR"));
  assert.deepEqual(await readdir(config.dataDir), []);
});

test("生成完成后取消不保存，等待慢任务期间取消不再查询", async t => {
  const config = await fixture(t);
  for (const pending of [false, true]) {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(generateImage(config, { ...OPTIONS, signal: controller.signal }, async () => {
      calls++;
      if (pending) {
        setTimeout(() => controller.abort("private-reason"), 0);
        return pendingResponse();
      }
      controller.abort("private-reason");
      return imageResponse();
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
