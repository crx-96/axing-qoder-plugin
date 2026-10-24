import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { requestLocal, httpFailure } from "../bridge/local-http.mjs";

async function localServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  assert.notEqual(port, 8787, "测试不能使用真实桥端口");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { server, config: { host: "127.0.0.1", port, apiKey: "unit-test-api-key" } };
}

test("requestLocal 仅访问本地回环地址，并按需发送认证和 JSON", async (t) => {
  const requests = [];
  const { config } = await localServer(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, headers: request.headers, body, url: request.url });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  });
  await requestLocal(config, "/");
  const result = await requestLocal(config, "/v1/test", {
    method: "POST", authenticated: true, body: { prompt: "中文内容" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { ok: true });
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[1].headers.authorization, `Bearer ${config.apiKey}`);
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].headers.connection, "close");
  assert.equal(requests[1].headers["content-type"], "application/json");
  assert.equal(Number(requests[1].headers["content-length"]), Buffer.byteLength(requests[1].body));
  assert.deepEqual(JSON.parse(requests[1].body), { prompt: "中文内容" });
  for (const [candidate, path] of [
    [{ ...config, host: "localhost" }, "/"],
    [{ ...config, host: "example.invalid" }, "/"],
    [config, "//example.invalid/path"],
    [config, "https://example.invalid/path"],
  ]) await assert.rejects(requestLocal(candidate, path), /本机回环/);
  assert.equal(requests.length, 2);
});

test("requestLocal 不受 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 环境变量影响", async (t) => {
  let proxyRequests = 0;
  const proxy = await localServer(t, (_request, response) => {
    proxyRequests++;
    response.writeHead(502).end("PROXY_MUST_NOT_RECEIVE_LOCAL_REQUEST");
  });
  const { config } = await localServer(t, (_request, response) => response.end("direct-local-response"));
  const proxyUrl = `http://127.0.0.1:${proxy.config.port}`;
  const changes = {
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
    NO_PROXY: "", no_proxy: "",
  };
  const saved = new Map(Object.keys(changes).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, changes);
  const result = await requestLocal(config, "/", { authenticated: true });
  assert.equal(result.text, "direct-local-response");
  assert.equal(proxyRequests, 0);
});

test("requestLocal 返回重定向状态，但绝不跟随 Location 或转发密钥", async (t) => {
  let destinationRequests = 0;
  const destination = await localServer(t, (_request, response) => {
    destinationRequests++;
    response.end("must not be reached");
  });
  const { config } = await localServer(t, (_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination.config.port}/redirected` });
    response.end("redirect");
  });
  const result = await requestLocal(config, "/", { authenticated: true });
  assert.equal(result.status, 302);
  assert.equal(destinationRequests, 0);
});

test("requestLocal 总超时不被持续响应字节延长", async (t) => {
  const { config } = await localServer(t, (_request, response) => {
    response.writeHead(200);
    response.write("first");
    const interval = setInterval(() => response.write("."), 15);
    response.once("close", () => clearInterval(interval));
  });
  const started = Date.now();
  await assert.rejects(requestLocal(config, "/", { timeoutMs: 120 }), { code: "ETIMEDOUT" });
  assert.ok(Date.now() - started < 1500, "持续输出仍必须受总时限限制");
});

test("requestLocal 支持发送前与请求中的 AbortSignal", async (t) => {
  let requestCount = 0;
  const { config, server } = await localServer(t, (_request, response) => {
    requestCount++;
    response.writeHead(200);
    response.write("pending");
  });
  const before = new AbortController();
  before.abort();
  await assert.rejects(requestLocal(config, "/", { signal: before.signal }), { code: "ABORT_ERR" });
  assert.equal(requestCount, 0);
  const during = new AbortController();
  const received = once(server, "request");
  const pending = assert.rejects(requestLocal(config, "/", { signal: during.signal }), { code: "ABORT_ERR" });
  await received;
  during.abort();
  await pending;
  assert.equal(requestCount, 1);
});

test("requestLocal 限制完整响应及分块响应的字节数", async (t) => {
  const { config } = await localServer(t, (request, response) => {
    if (request.url === "/exact") return response.end(Buffer.alloc(64, 65));
    if (request.url === "/whole") return response.end(Buffer.alloc(65, 65));
    response.write(Buffer.alloc(40, 65));
    setImmediate(() => response.end(Buffer.alloc(40, 65)));
  });
  assert.equal((await requestLocal(config, "/exact", { maxBytes: 64 })).text.length, 64);
  for (const path of ["/whole", "/chunks"]) {
    await assert.rejects(requestLocal(config, path, { maxBytes: 64 }), { code: "RESPONSE_TOO_LARGE" });
  }
});

test("requestLocal 将提前断开的响应报告为失败而非部分成功", async (t) => {
  const { config } = await localServer(t, async (_request, response) => {
    response.writeHead(200, { "Content-Length": "1000" });
    response.write("partial");
    await delay(20);
    response.destroy();
  });
  await assert.rejects(requestLocal(config, "/"), { code: "ECONNRESET" });
});

test("httpFailure 仅包含状态与本地诊断，不需要上游错误正文", () => {
  for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
    const error = httpFailure(status, "单元测试");
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`HTTP ${status}`));
    assert.match(error.message, /单元测试失败/);
  }
});
