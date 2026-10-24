import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { decodeImage, generateImage } from "../bridge/image-generation.mjs";

const execFileAsync = promisify(execFile);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
// 本地 Pillow 12.3 编码的完整小图，无测试运行时依赖或网络取样。
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwClZwaBpeiQRWaTXlxcAqqRw7QOn3i+CAQSMgHH5UUUV9FldCChLmu9Vu32XaxnmODpe2VOd5cqVrt9dejS6/kf/9k=", "base64");
const progressiveJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAVAQEBAAAAAAAAAAAAAAAAAAACBf/aAAwDAQACEAMQAAABgKJ//8QAFhABAQEAAAAAAAAAAAAAAAAAAwEC/9oACAEBAAEFAsQCH//EABsRAAAHAQAAAAAAAAAAAAAAAAABAgMEERIh/9oACAEDAQE/AZDKd5PtD//EABgRAAIDAAAAAAAAAAAAAAAAAAERAAIE/9oACAECAQE/ActAi5//xAAYEAEBAAMAAAAAAAAAAAAAAAACAQARUf/aAAgBAQAGPwKQbaXJn//EABgQAAIDAAAAAAAAAAAAAAAAAAERACGR/9oACAEBAAE/IQ2VACdc/9oADAMBAAIAAwAAABDz/8QAGREAAwADAAAAAAAAAAAAAAAAARFBACGx/9oACAEDAQE/EFTUBMm7hAvM/8QAGREBAAIDAAAAAAAAAAAAAAAAASFRABEx/9oACAECAQE/EBzGTq0VrP/EABgQAQEBAQEAAAAAAAAAAAAAAAERMQCR/9oACAEBAAE/EBugwgzUoIpQZ53/2Q==", "base64");
const restartJpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/wAALCAAQABABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAAAgUG/8QAIhAAAgIDAQACAgMAAAAAAAAAAgMEBQEGBwgTFBESFRYk/90ABAAB/9oACAEBAAA/AF5i5RtWl8l5v4t17k1fmJe6Hbne381hsYcWyi2M0VIUOAwlqpGnx/y0yaJrmND4wIBZn//QyOt+YeV8t49UcL32L/F2G4WmyWtTaTjQiBj6lDMrMRDaxgl9mRLv4CkLES+UskP5weViz//RXpjoO1Vdn1m25rzywtm6B0SLcaeW7SzZFqpWhyaqC6vCIpmf8MqzsZkrHxuSX65MsgLZJ5X/AP/SpXHszzh7S6rYdiZsf9W4lzGHq0rXR2OEK58mey4qbu9PEZafsNkojQDScVByxyNG6RHIgaWc/wD/2Q==", "base64");
const vp8Webp = Buffer.from("UklGRo4AAABXRUJQVlA4IIIAAABQAwCdASoIAAgAAUAmJbACdLoA4ACyAP0A9ADpgAbAdKw12AD+82dP1jbo+foybt3gPfNbRZ9sU6Jk5/9wj5cKX5hd7UT5Wgy0hQpp7xnMEyU/bIbGTk98jNve87NnO7PNL0qufry+v9sB+/Gsz9ONTXNpE/git5UO6/+Du0alIAAA", "base64");
const vp8lWebp = Buffer.from("UklGRjAAAABXRUJQVlA4TCQAAAAvB8ABALkKRPQ/dkWoQPQ/DGTSNgqqpP4d9puB8YiSwYk8V2Y=", "base64");
const vp8xWebp = Buffer.from("UklGRrYAAABXRUJQVlA4WAoAAAAIAAAABwAABwAAVlA4IIIAAABQAwCdASoIAAgAAUAmJbACdLoA4ACyAP0A9ADpgAbAdKw12AD+82dP1jbo+foybt3gPfNbRZ9sU6Jk5/9wj5cKX5hd7UT5Wgy0hQpp7xnMEyU/bIbGTk98jNve87NnO7PNL0qufry+v9sB+/Gsz9ONTXNpE/git5UO6/+Du0alIAAARVhJRg4AAABJSSoACAAAAAAAAAAAAA==", "base64");
const alphaWebp = Buffer.from("UklGRsgAAABXRUJQVlA4WAoAAAAQAAAABwAABwAAQUxQSBgAAAABuYzof0BNAAKMFUT/nD4FIiZgAjB23QBWUDggigAAAFADAJ0BKggACAABQCYlsAJ0ugCTAP0A9AD2AP1VBcGeNjQYAP7vrc5oikmYIzQp+p0AzL8b7pLfmtos/JnergcP/cI99ndyYXe1E+VoMHgwCsnMSxrlh35/7v+P+Mq8zDgnjvedmznbper4lM/Ry1P/2/334/ZuwetBaSR/4IreVDuv/g7tGpSAAA==", "base64");
const alphaLosslessWebp = Buffer.from("UklGRmYAAABXRUJQVlA4WAoAAAAYAAAABwAABwAAVlA4TDEAAAAvB8ABELmM6H/sIqL/AcJsowmMZP6G9zsBgUCKUxhisWCK98cUgQBlqjDEBID+dvUbAEVYSUYOAAAASUkqAAgAAAAAAAAAAAA=", "base64");
const bridgeSignature = { message: "CLI Proxy API Server", endpoints: ["GET /v1/models"] };

async function imageFixture(t, handler, rootBody = bridgeSignature) {
  const directory = await mkdtemp(join(tmpdir(), "subscription-bridge-image-test-"));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    request.setEncoding("utf8");
    let text = "";
    for await (const chunk of request) text += chunk;
    const entry = { url: request.url, method: request.method, headers: request.headers, body: text ? JSON.parse(text) : null };
    requests.push(entry);
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(rootBody));
      return;
    }
    handler(entry, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  assert.notEqual(port, 8787, "测试不能使用真实桥端口");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory, requests, server,
    config: { host: "127.0.0.1", port, apiKey: "image-test-secret-only", imagesDir: join(directory, "images") },
  };
}

function imageResponse(response, bytes = png) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }));
}

async function savedFiles(config) {
  try { return await readdir(config.imagesDir); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

test("generateImage 拒绝无效参数且不发起网络请求", async (t) => {
  const { config, requests } = await imageFixture(t, (_request, response) => imageResponse(response));
  const invalid = [
    undefined, null, [], "prompt", {}, { prompt: " " }, { prompt: 123 },
    { prompt: "x".repeat(32001) }, { prompt: "ok", unknown: true },
    { prompt: "ok", model: "" }, { prompt: "ok", model: 2 }, { prompt: "ok", model: "x".repeat(201) },
    { prompt: "ok", size: "100x100" }, { prompt: "ok", quality: "ultra" },
    { prompt: "ok", background: false }, { prompt: "ok", output_format: "gif" },
    { prompt: "ok", n: 2 }, { prompt: "ok", response_format: "url" },
  ];
  for (const args of invalid) {
    await assert.rejects(generateImage(config, args), { code: "INVALID_ARGUMENT" });
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(await savedFiles(config), []);
});

test("generateImage 保存 PNG 原图并返回 MCP image 和可定位文件文本", async (t) => {
  const { config, requests } = await imageFixture(t, (_request, response) => imageResponse(response));
  const args = { prompt: "一只猫", size: "1024x1024", quality: "high", background: "transparent" };
  const result = await generateImage(config, args);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].url, "/v1/images/generations");
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].headers.authorization, `Bearer ${config.apiKey}`);
  assert.deepEqual(requests[1].body, {
    ...args, model: "gpt-image-2.5", output_format: "png", response_format: "b64_json", n: 1, stream: false,
  });
  assert.equal(args.model, undefined, "不能修改调用方参数");
  const files = await savedFiles(config);
  assert.equal(files.length, 1);
  assert.match(files[0], /^image-.*\.png$/);
  const savedPath = join(config.imagesDir, files[0]);
  assert.deepEqual(await readFile(savedPath), png);
  const image = result.content.find((item) => item.type === "image");
  assert.deepEqual(image, { type: "image", data: png.toString("base64"), mimeType: "image/png" });
  assert.ok(result.content.find((item) => item.type === "text").text.includes(savedPath));
  assert.ok(!JSON.stringify(result).includes(config.apiKey));
});

test("generateImage 保留指定模型且请求参数不允许任意服务端选项", async (t) => {
  const { config, requests } = await imageFixture(t, (_request, response) => imageResponse(response));
  await generateImage(config, { prompt: "test", model: "gpt-image-2.5-flare", output_format: "png", quality: "low" });
  assert.equal(requests[1].body.model, "gpt-image-2.5-flare");
  assert.equal(requests[1].body.quality, "low");
});

test("generateImage 按 Unicode 码点校验 prompt 与 model 的长度边界", async (t) => {
  const { config, requests } = await imageFixture(t, (_request, response) => imageResponse(response));
  const supplementaryCharacter = "\u{1f600}";
  const prompt = supplementaryCharacter.repeat(32000);
  const model = supplementaryCharacter.repeat(200);
  await generateImage(config, { prompt, model });
  assert.ok(requests[1].body.prompt === prompt, "多字节 prompt 必须完整传输");
  assert.ok(requests[1].body.model === model, "多字节 model 必须完整传输");
  await assert.rejects(generateImage(config, { prompt: prompt + supplementaryCharacter }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(generateImage(config, { prompt: "test", model: model + supplementaryCharacter }), { code: "INVALID_ARGUMENT" });
  assert.equal(requests.length, 2, "超限参数不能发起网络请求");
});

test("generateImage 不向伪造或非桥根端点发送认证与生图请求", async (t) => {
  const { config, requests } = await imageFixture(t, (_request, response) => imageResponse(response), { message: "unrelated service" });
  await assert.rejects(generateImage(config, { prompt: "test" }), { code: "BRIDGE_UNAVAILABLE" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, undefined);
});

test("generateImage HTTP 失败仅传播诊断，不透传密钥或上游正文", async (t) => {
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const secret = "UPSTREAM_SECRET_MUST_NOT_LEAK";
      const { config, requests } = await imageFixture(t, (_request, response) => {
        response.writeHead(status).end(JSON.stringify({ error: { message: secret, apiKey: "image-test-secret-only" } }));
      });
      await assert.rejects(generateImage(config, { prompt: "test" }), (error) => {
        assert.equal(error.code, "IMAGE_GENERATION_FAILED");
        assert.match(error.safeMessage, new RegExp(`HTTP ${status}`));
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(secret));
        assert.ok(!`${error.stack} ${JSON.stringify(error)}`.includes(config.apiKey));
        return true;
      });
      assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
      assert.deepEqual(await savedFiles(config), []);
    });
  }
});

test("generateImage 请求中取消不重试、不保存部分图片", async (t) => {
  let notify;
  const received = new Promise((resolve) => { notify = resolve; });
  const { config, requests } = await imageFixture(t, (_request, response) => {
    response.writeHead(200);
    response.write('{"data":[');
    notify();
  });
  const controller = new AbortController();
  const pending = assert.rejects(generateImage(config, { prompt: "test" }, { signal: controller.signal }), (error) => {
    assert.equal(error.code, "ABORT_ERR");
    assert.match(error.safeMessage, /本 MCP 未自动重试；核心仍可能按配置重试/);
    return true;
  });
  await received;
  controller.abort();
  await pending;
  await delay(80);
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  assert.deepEqual(await savedFiles(config), []);
});

test("generateImage 预先取消不发送收费 POST", async (t) => {
  const { config, requests } = await imageFixture(t, (_request, response) => imageResponse(response));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateImage(config, { prompt: "test" }, { signal: controller.signal }), { code: "ABORT_ERR" });
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 0);
  assert.deepEqual(await savedFiles(config), []);
});

test("generateImage 连接异常不自动重试", async (t) => {
  const { config, requests } = await imageFixture(t, (_request, response) => response.destroy());
  await assert.rejects(generateImage(config, { prompt: "test" }), (error) => {
    assert.equal(error.code, "IMAGE_CONNECTION_FAILED");
    assert.match(error.safeMessage, /本 MCP 未自动重试；核心仍可能按配置重试/);
    assert.ok(!error.safeMessage.includes("避免重复消耗"));
    return true;
  });
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
});

test("generateImage 拒绝格式错误、外部 URL 和多图响应", async (t) => {
  const cases = [
    ["非 JSON", "<html>UPSTREAM_SECRET</html>"],
    ["JSON null", "null"],
    ["缺少 data", "{}"],
    ["空 data", '{"data":[]}'],
    ["多图", JSON.stringify({ data: [{ b64_json: png.toString("base64") }, { b64_json: png.toString("base64") }] })],
    ["URL 图片", '{"data":[{"url":"https://must-not-fetch.invalid/image.png"}]}'],
    ["无效 base64", '{"data":[{"b64_json":"not-base64!"}]}'],
    ["非图片内容", JSON.stringify({ data: [{ b64_json: Buffer.from("UPSTREAM_SECRET").toString("base64") }] })],
  ];
  for (const [name, body] of cases) {
    await t.test(name, async (t) => {
      const { config, requests } = await imageFixture(t, (_request, response) => response.end(body));
      await assert.rejects(generateImage(config, { prompt: "test" }), (error) => {
        assert.equal(error.code, "IMAGE_GENERATION_FAILED");
        assert.equal(typeof error.safeMessage, "string");
        assert.ok(!error.safeMessage.includes("UPSTREAM_SECRET"));
        return true;
      });
      assert.equal(requests.length, 2);
      assert.deepEqual(await savedFiles(config), []);
    });
  }
});

test("decodeImage 拒绝损坏编码、不支持的类型和过大尺寸", () => {
  for (const value of [null, "", "a", "!!!!", "AA=A", "AB==", "data:image/png;base64,AAAA", Buffer.from("GIF89a").toString("base64")]) {
    assert.throws(() => decodeImage(value), { code: "IMAGE_GENERATION_FAILED" });
  }
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(10000, 16);
  oversized.writeUInt32BE(10000, 20);
  assert.throws(() => decodeImage(oversized.toString("base64")), /尺寸/);
  const empty = Buffer.from(png);
  empty.writeUInt32BE(0, 16);
  assert.throws(() => decodeImage(empty.toString("base64")), /尺寸/);
  assert.equal(decodeImage(png.toString("base64")).mimeType, "image/png");
});

test("decodeImage 不把只有 PNG 签名和尺寸的截断文件视为有效图像", () => {
  const truncated = png.subarray(0, 24);
  assert.throws(() => decodeImage(truncated.toString("base64")), { code: "IMAGE_GENERATION_FAILED" });
});

function webpChunk(type, payload) {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length & 1));
  chunk.write(type, 0, "latin1");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function webpContainer(...chunks) {
  const header = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
  const bytes = Buffer.concat([header, ...chunks]);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}

const validImages = [
  ["基线 JPEG", jpeg, "image/jpeg", "jpg"],
  ["渐进 JPEG 多扫描", progressiveJpeg, "image/jpeg", "jpg"],
  ["JPEG FF00 转义及 RST 标记", restartJpeg, "image/jpeg", "jpg"],
  ["有损 VP8", vp8Webp, "image/webp", "webp"],
  ["无损 VP8L", vp8lWebp, "image/webp", "webp"],
  ["VP8X 与 EXIF", vp8xWebp, "image/webp", "webp"],
  ["VP8X 与 ALPH", alphaWebp, "image/webp", "webp"],
  ["VP8X 无损透明及奇数长度补齐", alphaLosslessWebp, "image/webp", "webp"],
];

test("decodeImage 接受完整 JPEG/WebP 编码器输出并原样保留字节", () => {
  assert.ok(restartJpeg.includes(Buffer.from([255, 0])));
  assert.ok(restartJpeg.includes(Buffer.from([255, 208])));
  for (const [name, bytes, mimeType, extension] of validImages) {
    assert.deepEqual(decodeImage(bytes.toString("base64")), { bytes, mimeType, extension }, name);
  }
  const filledMarker = Buffer.concat([jpeg.subarray(0, 2), Buffer.from([255]), jpeg.subarray(2)]);
  assert.equal(decodeImage(filledMarker.toString("base64")).mimeType, "image/jpeg");
  const unknownChunk = webpContainer(vp8Webp.subarray(12), webpChunk("TEST", Buffer.from([1, 2, 3])));
  assert.equal(decodeImage(unknownChunk.toString("base64")).mimeType, "image/webp");
});

test("decodeImage 拒绝 JPEG/WebP 每个截断前缀", () => {
  for (const [name, bytes] of validImages) {
    for (let end = 1; end < bytes.length; end++) {
      assert.throws(() => decodeImage(bytes.subarray(0, end).toString("base64")), { code: "IMAGE_GENERATION_FAILED" }, `${name}: ${end}`);
    }
  }
});

test("decodeImage 拒绝 JPEG 伪签名、损坏段、缺表、缺扫描和空扫描", () => {
  const sof = jpeg.indexOf(Buffer.from([255, 192]));
  const sos = jpeg.indexOf(Buffer.from([255, 218]));
  const endOfScanHeader = sos + 2 + jpeg.readUInt16BE(sos + 2);
  const eoi = Buffer.from([255, 217]);
  const malformedLength = Buffer.from(jpeg);
  malformedLength.writeUInt16BE(65535, 4);
  const missingTables = Buffer.concat([jpeg.subarray(0, 2), jpeg.subarray(sof, sof + 19), jpeg.subarray(sos)]);
  const unknownComponent = Buffer.from(jpeg);
  unknownComponent[sos + 5] = 127;
  const brokenRestart = Buffer.from(restartJpeg);
  brokenRestart[brokenRestart.indexOf(Buffer.from([255, 208])) + 1] = 213;
  const invalidTable = Buffer.from(jpeg);
  invalidTable[invalidTable.indexOf(Buffer.from([255, 219])) + 4] = 255;
  for (const bytes of [
    Buffer.from([255, 216, 255, 0, 0]), Buffer.from([255, 216, 255, 217]),
    Buffer.concat([Buffer.from([255, 216, 255, 0, 0]), eoi]),
    malformedLength, missingTables, unknownComponent, brokenRestart, invalidTable,
    Buffer.concat([jpeg.subarray(0, sos), eoi]),
    Buffer.concat([jpeg.subarray(0, endOfScanHeader), eoi]),
    Buffer.concat([jpeg.subarray(0, sos + 6), eoi]),
    Buffer.concat([jpeg, Buffer.from([0])]),
  ]) assert.throws(() => decodeImage(bytes.toString("base64")), { code: "IMAGE_GENERATION_FAILED" });
});

test("decodeImage 拒绝 WebP 损坏容器长度、chunk、编码头和缺图像数据", () => {
  const fake = Buffer.alloc(16);
  fake.write("RIFF"); fake.write("WEBP", 8);
  const wrongRiffLength = Buffer.from(vp8Webp);
  wrongRiffLength.writeUInt32LE(wrongRiffLength.length, 4);
  const wrongChunkLength = Buffer.from(vp8Webp);
  wrongChunkLength.writeUInt32LE(0xffffffff, 16);
  const badPartition = Buffer.from(vp8Webp);
  badPartition.writeUIntLE(0xfffff0, 20, 3);
  const badKeyframe = Buffer.from(vp8Webp);
  badKeyframe[23] = 0;
  const interFrame = Buffer.from(vp8Webp);
  interFrame[20] |= 1;
  const badLosslessVersion = Buffer.from(vp8lWebp);
  badLosslessVersion[24] |= 32;
  const mismatchedCanvas = Buffer.from(vp8xWebp);
  mismatchedCanvas[24]++;
  const badPadding = webpContainer(vp8Webp.subarray(12), webpChunk("TEST", Buffer.from([1])));
  badPadding[badPadding.length - 1] = 1;
  const alphaHeaderOnly = webpContainer(alphaWebp.subarray(12, 30), webpChunk("ALPH", Buffer.from([0])), vp8Webp.subarray(12));
  const badRawAlpha = webpContainer(alphaWebp.subarray(12, 30), webpChunk("ALPH", Buffer.from([0, 1])), vp8Webp.subarray(12));
  for (const bytes of [
    fake, webpContainer(), wrongRiffLength, wrongChunkLength, badPartition, badKeyframe, interFrame,
    badLosslessVersion, mismatchedCanvas, badPadding, alphaHeaderOnly, badRawAlpha,
    webpContainer(vp8xWebp.subarray(12, 30)),
    webpContainer(webpChunk("VP8 ", vp8Webp.subarray(20, 30))),
    webpContainer(webpChunk("VP8L", vp8lWebp.subarray(20, 25))),
    webpContainer(vp8Webp.subarray(12), vp8Webp.subarray(12)),
    webpContainer(vp8xWebp.subarray(12, 30), vp8Webp.subarray(12)),
    webpContainer(vp8Webp.subarray(12), Buffer.from([0, 0])),
  ]) assert.throws(() => decodeImage(bytes.toString("base64")), { code: "IMAGE_GENERATION_FAILED" });
});

test("decodeImage 对 JPEG、VP8、VP8L、VP8X 统一限制 40MP", () => {
  const sof = jpeg.indexOf(Buffer.from([255, 192]));
  const cases = [
    [jpeg, (bytes, width, height) => { bytes.writeUInt16BE(height, sof + 5); bytes.writeUInt16BE(width, sof + 7); }],
    [vp8Webp, (bytes, width, height) => { bytes.writeUInt16LE(width, 26); bytes.writeUInt16LE(height, 28); }],
    [vp8lWebp, (bytes, width, height) => { bytes.writeUInt32LE((width - 1) + (height - 1) * 16384, 21); }],
    [vp8xWebp, (bytes, width, height) => {
      bytes.writeUIntLE(width - 1, 24, 3); bytes.writeUIntLE(height - 1, 27, 3);
      bytes.writeUInt16LE(width, 44); bytes.writeUInt16LE(height, 46);
    }],
  ];
  for (const [source, setDimensions] of cases) {
    const boundary = Buffer.from(source);
    setDimensions(boundary, 8000, 5000);
    assert.doesNotThrow(() => decodeImage(boundary.toString("base64")), "尺寸头的边界校验不等价于像素流解码");
    setDimensions(boundary, 8000, 5001);
    assert.throws(() => decodeImage(boundary.toString("base64")), /尺寸/);
  }
  for (const [source, setDimensions] of cases.slice(0, 2)) {
    const zero = Buffer.from(source);
    setDimensions(zero, 0, 8);
    assert.throws(() => decodeImage(zero.toString("base64")), /尺寸/);
  }
});

test("generateImage mock HTTP 保存有效 JPEG/WebP，截断失败脱敏、不落盘且本层不重试", async (t) => {
  for (const [name, bytes, mimeType, extension] of validImages) {
    await t.test(name, async (t) => {
      let payload = bytes.subarray(0, bytes.length - 2);
      const { config, requests } = await imageFixture(t, (_request, response) => {
        response.end(JSON.stringify({ data: [{ b64_json: payload.toString("base64"), revised_prompt: "UPSTREAM_SECRET" }] }));
      });
      await assert.rejects(generateImage(config, { prompt: "test", output_format: extension === "jpg" ? "jpeg" : "webp" }), (error) => {
        assert.equal(error.code, "IMAGE_GENERATION_FAILED");
        assert.equal(error.message, error.safeMessage);
        assert.ok(!error.stack.includes("UPSTREAM_SECRET"));
        assert.ok(!error.stack.includes(config.apiKey));
        assert.ok(!error.stack.includes(payload.toString("base64")));
        return true;
      });
      assert.deepEqual(await savedFiles(config), []);
      assert.deepEqual(await readdir(join(config.imagesDir, "..")), [], "验证失败前不能创建 images 目录");
      assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
      payload = bytes;
      const result = await generateImage(config, { prompt: "test", output_format: extension === "jpg" ? "jpeg" : "webp" });
      const files = await savedFiles(config);
      assert.equal(files.length, 1);
      assert.ok(files[0].endsWith(`.${extension}`));
      assert.deepEqual(await readFile(join(config.imagesDir, files[0])), bytes);
      assert.deepEqual(result.content.find((item) => item.type === "image"), { type: "image", data: bytes.toString("base64"), mimeType });
      assert.equal(requests.filter((entry) => entry.method === "POST").length, 2);
    });
  }
});

test("POSIX 大图仅返回原图链接，不调用 Windows 预览且不重试生成", {
  skip: process.platform === "win32" ? "POSIX 原图链接降级" : false,
}, async (t) => {
  const payload = Buffer.from("Comment\0" + "large-image-metadata".repeat(12000));
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write("tEXt", 4);
  payload.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  const original = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
  assert.ok(original.toString("base64").length > 190 * 1024);
  const { config, requests } = await imageFixture(t, (_request, response) => imageResponse(response, original));
  const result = await generateImage(config, { prompt: "isolated POSIX image" });
  const files = await savedFiles(config);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(config.imagesDir, files[0])), original);
  assert.equal(result.content.some((item) => item.type === "image"), false);
  assert.ok(result.content[0].text.includes(join(config.imagesDir, files[0])));
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
});

test("大 PNG 生成不超过 190 KiB base64 的预览，同时逐字节保留原图", {
  skip: process.platform !== "win32" ? "预览实现仅支持 Windows PowerShell" : false,
  timeout: 60000,
}, async (t) => {
  let original;
  const { config, directory } = await imageFixture(t, (_request, response) => imageResponse(response, original));
  const fixturePath = join(directory, "large-fixture.png");
  const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encodedPath = Buffer.from(fixturePath).toString("base64");
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Drawing; $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $b=New-Object Drawing.Bitmap(1024,1024,([Drawing.Imaging.PixelFormat]::Format24bppRgb)); try { $rect=New-Object Drawing.Rectangle(0,0,1024,1024); $bits=$b.LockBits($rect,[Drawing.Imaging.ImageLockMode]::WriteOnly,[Drawing.Imaging.PixelFormat]::Format24bppRgb); try { $raw=New-Object byte[] ([Math]::Abs($bits.Stride)*1024); $random=New-Object Random(12345); $random.NextBytes($raw); [Runtime.InteropServices.Marshal]::Copy($raw,0,$bits.Scan0,$raw.Length) } finally { $b.UnlockBits($bits) }; $b.Save($path,[Drawing.Imaging.ImageFormat]::Png) } finally { $b.Dispose() }`;
  await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 20000, maxBuffer: 8192,
  });
  original = await readFile(fixturePath);
  assert.ok(original.toString("base64").length > 190 * 1024);
  const result = await generateImage(config, { prompt: "large PNG test" });
  const files = await savedFiles(config);
  assert.equal(files.length, 1, "预览临时文件必须清理");
  assert.deepEqual(await readFile(join(config.imagesDir, files[0])), original, "原图必须逐字节保留");
  const preview = result.content.find((item) => item.type === "image");
  assert.ok(preview, "大 PNG 应生成 MCP 图片预览");
  assert.equal(preview.mimeType, "image/jpeg");
  assert.ok(preview.data.length <= 190 * 1024, "按 base64 而不是二进制大小检查 MCP 限制");
  const previewBytes = Buffer.from(preview.data, "base64");
  assert.equal(previewBytes[0], 255);
  assert.equal(previewBytes[1], 216);
  assert.ok(previewBytes.length < original.length);
});
