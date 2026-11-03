import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { PLUGIN_VERSION } from "../server/config.mjs";
import { handleMessage, runMcp } from "../server/mcp-protocol.mjs";

const config = { apiKey: "private-api-value", mgmtKey: "private-management-value" };
const startResult = { started: true, ready: true, reason: "已启动" };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function handlers(overrides = {}) {
  return {
    getStatus: async () => ({ ready: true }),
    ensureRunning: async () => startResult,
    stopBridge: async () => ({ stopped: true, reason: "已停止" }),
    ...overrides,
  };
}

function request(id, method = "ping", params) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function call(id, name = "bridge_start", args = {}, meta) {
  return request(id, "tools/call", { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) });
}

function resultText(response) {
  return response.result.content[0].text;
}

function harness(t, overrides = {}, options = {}) {
  const input = new PassThrough();
  const output = options.output ?? new PassThrough();
  const messages = [];
  const events = new EventEmitter();
  let buffer = "";
  if (!options.output) {
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line) messages.push(JSON.parse(line));
        events.emit("message");
      }
    });
  }
  const done = runMcp({ config, ...options.ctx }, { input, output, handlers: handlers(overrides), prepare: options.prepare });
  t.after(async () => {
    if (!input.destroyed) input.end();
    await done;
    input.destroy();
    output.destroy();
  });
  function send(message) { input.write(`${JSON.stringify(message)}\n`); }
  function wait(predicate) {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off("message", check);
        reject(new Error("等待协议响应超时"));
      }, 2_000);
      function check() {
        const match = messages.find(predicate);
        if (!match) return;
        clearTimeout(timer);
        events.off("message", check);
        resolve(match);
      }
      events.on("message", check);
    });
  }
  return { input, output, messages, done, send, wait, response: (id) => wait((message) => message.id === id) };
}

test("输入 destroy 无 error 也会收尾并取消在途调用", { timeout: 3000 }, async (t) => {
  let signal;
  const entered = deferred();
  const h = harness(t, { ensureRunning: async (_config, options) => {
    signal = options.signal;
    entered.resolve();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return startResult;
  } });
  h.send(call(1));
  await entered.promise;
  h.input.destroy();
  await h.done;
  assert.equal(signal.aborted, true);
  assert.equal(h.input.listenerCount("close"), 0);
});

test("核心下载期间仍响应 ping/status，取消通知与 EOF 传递给启动任务", { timeout: 5000 }, async (t) => {
  const signals = [];
  let entered = deferred();
  const h = harness(t, { ensureRunning: async (_config, { signal }) => {
    signals.push(signal);
    entered.resolve();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  h.send(call(1, "bridge_start", {}));
  await entered.promise;
  h.send(request(2));
  assert.deepEqual((await h.response(2)).result, {});
  h.send(call(3, "bridge_status", {}));
  assert.equal(JSON.parse(resultText(await h.response(3))).ready, true);
  h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
  assert.equal((await h.response(1)).result.isError, true);
  assert.equal(signals[0].aborted, true);
  entered = deferred();
  h.send(call(4, "bridge_start", {}));
  await entered.promise;
  h.input.end();
  await h.done;
  assert.equal(signals[1].aborted, true);
});

test("本地配置准备完成后initialize成功，之前拒绝工具且不重复读取配置", async (t) => {
  const ready = deferred();
  let prepared = 0;
  let invoked = 0;
  const h = harness(t, { getStatus: async () => { invoked++; return { ready: true }; } }, {
    prepare: async () => { prepared++; await ready.promise; },
  });
  h.send(request(1, "initialize", { protocolVersion: "2025-06-18" }));
  h.send(request(2, "tools/list"));
  h.send(call(3, "bridge_status", {}));
  assert.equal((await h.response(2)).error.code, -32002);
  assert.equal((await h.response(3)).error.code, -32002);
  assert.equal(invoked, 0);
  assert.equal(h.messages.some((message) => message.id === 1), false);
  h.send(request(4, "initialize", { protocolVersion: "2025-06-18" }));
  assert.equal((await h.response(4)).error.code, -32600);
  ready.resolve();
  assert.ok((await h.response(1)).result.serverInfo);
  h.send(request(5, "tools/list"));
  assert.equal((await h.response(5)).result.tools.length, 6);
  assert.equal(prepared, 1);
});

test("本地配置失败的initialize是协议错误，后续不发布成功且结束连接", async (t) => {
  const ready = deferred();
  const h = harness(t, {}, { prepare: async () => { await ready.promise; throw { safeMessage: "本地配置不可用", code: "BRIDGE_START_FAILED" }; } });
  h.send(request(1, "initialize", { protocolVersion: "2025-06-18" }));
  ready.resolve();
  const failed = await h.response(1);
  assert.equal(failed.error.code, -32001);
  assert.match(failed.error.message, /本地配置不可用/);
  assert.equal(failed.result, undefined);
  await h.done;
});

test("initialize取消和EOF均取消准备，清理完成前不返回成功", async (t) => {
  for (const mode of ["cancel", "eof"]) {
    const entered = deferred();
    let signal;
    const h = harness(t, {}, { prepare: async (value) => {
      signal = value;
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    h.send(request(1, "initialize", { protocolVersion: "2025-06-18" }));
    await entered.promise;
    if (mode === "cancel") h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    else h.input.end();
    await h.done;
    assert.equal(signal.aborted, true);
    assert.ok(!h.messages.some((message) => message.result?.serverInfo));
  }
});

test("准备已完成但initialize被取消时仍结束连接，不等待额外EOF", async (t) => {
  const h = harness(t, {}, { prepare: async () => {} });
  await nextTurn();
  h.input.write(JSON.stringify(request(1, "initialize", { protocolVersion: "2025-06-18" })) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }) + "\n");
  const result = await h.response(1);
  assert.equal(result.error.code, -32001);
  assert.equal(result.result, undefined);
  await h.done;
});

test("initialize 协商已知版本，未知版本不回显，服务版本来自 config", async () => {
  for (const protocolVersion of ["2025-06-18", "2025-03-26", "2024-11-05", "2099-12-31"]) {
    const response = await handleMessage(request(0, "initialize", { protocolVersion }), { config });
    assert.equal(response.id, 0);
    assert.equal(response.result.protocolVersion, ["2025-06-18", "2024-11-05"].includes(protocolVersion) ? protocolVersion : "2025-06-18");
    assert.equal(response.result.serverInfo.version, PLUGIN_VERSION);
    assert.deepEqual(response.result.capabilities, { tools: {} });
  }
  assert.equal((await handleMessage(request(1, "initialize", {}), { config })).error.code, -32602);
});

test("工具发现公布管理与生图工具，旧生图调用按未知工具拒绝", async () => {
  const initialized = await handleMessage(request(1, "initialize", { protocolVersion: "2025-06-18" }), { config });
  assert.equal(initialized.result.instructions, undefined);
  const { result } = await handleMessage(request(2, "tools/list"), { config });
  assert.deepEqual(result.tools.map(tool => tool.name), ["bridge_status", "bridge_start", "bridge_stop", "bridge_open_management", "image_gen_gpt", "image_gen_gemini"]);
  for (const tool of result.tools.filter((entry) => entry.name.startsWith("bridge_"))) {
    assert.deepEqual(tool.inputSchema, { type: "object", properties: {}, additionalProperties: false });
    for (const args of [null, [], { force: true }]) {
      assert.equal((await handleMessage(call(3, tool.name, args), { config })).error.code, -32602);
    }
  }
  for (const tool of result.tools.filter((entry) => entry.name.startsWith("image_gen_"))) {
    assert.deepEqual(tool.inputSchema.required, ["prompt"]);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const removed = await handleMessage(call(4, "bridge_generate_image", { prompt: "test" }), { config });
  assert.equal(removed.error.code, -32602);
});

test("start 传递取消信号，start/stop 投影结果并标识未就绪", async () => {
  const signal = new AbortController().signal;
  for (const ready of [true, false]) {
    const response = await handleMessage(call(1, "bridge_start", {}), { config }, { signal, handlers: handlers({ ensureRunning: async (...args) => {
      assert.deepEqual(args, [config, { signal }]);
      return { started: true, ready, reason: "受控原因", child: { secret: "不可输出" } };
    } }) });
    assert.deepEqual(JSON.parse(resultText(response)), { started: true, ready, reason: "受控原因" });
    assert.equal(response.result.isError === true, !ready);
  }
  for (const stopped of [true, false]) {
    const response = await handleMessage(call(2, "bridge_stop", {}), { config }, { handlers: handlers({ stopBridge: async (...args) => {
      assert.deepEqual(args, [config]);
      return { stopped, reason: "受控原因", internal: "不可输出" };
    } }) });
    assert.deepEqual(JSON.parse(resultText(response)), { stopped, reason: "受控原因" });
    assert.equal(response.result.isError === true, !stopped);
  }
});

test("管理入口只在用户调用时执行一次，原始票据不进入返回值", async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const injected = handlers({ openManagement: async (actual, options) => {
    assert.equal(actual, config);
    assert.equal(options.signal, signal);
    calls++;
    return "http://127.0.0.1/management.html#sensitive-test-ticket";
  } });
  const result = await handleMessage(call(1, "bridge_open_management", {}), { config }, { handlers: injected, signal });
  assert.equal(calls, 1);
  assert.equal(resultText(result), "已请求系统浏览器打开授权与账号管理页。");
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|sensitive-test-ticket/);
});

test("管理与启停工具抛错标 isError，失败只调用一次", async () => {
  for (const [name, handlerName] of [["bridge_start", "ensureRunning"], ["bridge_stop", "stopBridge"], ["bridge_open_management", "openManagement"]]) {
    let count = 0;
    const injected = handlers({ [handlerName]: async () => {
      count++;
      throw Object.assign(new Error("private failure"), { code: "ECONNREFUSED" });
    } });
    const response = await handleMessage(call(1, name, {}), { config }, { handlers: injected });
    assert.equal(response.result.isError, true);
    assert.match(resultText(response), /ECONNREFUSED/);
    assert.equal(count, 1);
  }
});

test("安全错误码和 safeMessage 可解释且脱敏，普通 message/stack/body 不透传", async () => {
  const error = Object.assign(new Error(`raw ${config.apiKey} https://upstream.test/?token=hidden body`), {
    code: "ECONNRESET", safeMessage: `无法连接，${config.apiKey} ${config.mgmtKey} https://upstream.test/?token=hidden`,
    body: "private-response-body",
  });
  const response = await handleMessage(call(1), { config }, { handlers: handlers({ ensureRunning: async () => { throw error; } }) });
  assert.equal(response.result.isError, true);
  assert.match(resultText(response), /无法连接/);
  assert.match(resultText(response), /ECONNRESET/);
  assert.match(resultText(response), /检查代理状态/);
  assert.doesNotMatch(JSON.stringify(response), /private-|upstream|hidden|raw |stack|body/);
  const unknown = await handleMessage(call(2), { config }, { handlers: handlers({ ensureRunning: async () => { throw Object.assign(error, { safeMessage: undefined, code: "secret-token-value" }); } }) });
  assert.doesNotMatch(JSON.stringify(unknown), /secret-token|private-|upstream|raw |body/);
  const long = await handleMessage(call(3), { config }, { handlers: handlers({ ensureRunning: async () => { throw { safeMessage: "错".repeat(2_000) }; } }) });
  assert.ok(resultText(long).length < 600);
});

test("启动故障与可疑生命周期 reason 不泄露配置密钥", async () => {
  const startupError = { code: "ENOENT", safeMessage: `启动不可用 ${config.apiKey}` };
  const status = await handleMessage(call(1, "bridge_status", {}), { config, startupError }, { handlers: handlers() });
  assert.match(resultText(status), /启动不可用/);
  assert.doesNotMatch(resultText(status), /private-api-value/);
  for (const reason of [`失败 ${config.apiKey}`, "token=abcdef", "https://example.test/?key=secret", "Error\n at privatePath"]) {
    const response = await handleMessage(call(2, "bridge_stop", {}), { config }, { handlers: handlers({ stopBridge: async () => ({ stopped: false, reason }) }) });
    assert.equal(JSON.parse(resultText(response)).reason, "未能停止");
  }
});

test("非法 JSON、非法信封及参数之后仍能处理 ping 与工具请求", async (t) => {
  const h = harness(t);
  h.input.write("{broken\nnull\n[]\n\n");
  h.send({ jsonrpc: "1.0", id: 5, method: "ping" });
  h.send(request(6, "tools/call", []));
  h.send(call(7, "bridge_start", { prompt: "" }));
  h.send(request(8, "missing-method"));
  h.send(request(9));
  assert.deepEqual((await h.response(9)).result, {});
  assert.equal((await h.response(6)).error.code, -32602);
  assert.equal((await h.response(7)).error.code, -32602);
  assert.equal((await h.response(8)).error.code, -32601);
  assert.ok(h.messages.some((message) => message.error?.code === -32700 && message.id === null));
  assert.ok(h.messages.filter((message) => message.error?.code === -32600).length >= 3);
  h.send(call(10, "bridge_status", {}));
  assert.deepEqual(JSON.parse(resultText(await h.response(10))), { ready: true });
});

test("未换行的超长请求在继续接收时即被拒绝，丢弃到换行后恢复", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 17; i++) h.input.write("x".repeat(64 * 1024));
  const rejected = await h.wait((message) => message.error?.code === -32600);
  assert.match(rejected.error.message, /过长/);
  h.input.write("discard this too\n");
  h.send(request(2));
  assert.deepEqual((await h.response(2)).result, {});
  assert.equal(h.messages.filter((message) => message.error).length, 1);
});

test("UTF-8 跨数据块、CRLF 与 EOF 无换行的完整请求仍能正确解析", async (t) => {
  const h = harness(t);
  const bytes = Buffer.from(JSON.stringify(request("中文🐈")) + "\r\n");
  for (const byte of bytes) h.input.write(Buffer.from([byte]));
  assert.deepEqual((await h.response("中文🐈")).result, {});
  h.input.end(JSON.stringify(request("EOF")));
  await h.done;
  assert.deepEqual((await h.response("EOF")).result, {});
});

test("工具异常是 isError，随后同一连接继续处理工具和 ping", async (t) => {
  let calls = 0;
  const h = harness(t, { ensureRunning: async () => {
    if (++calls === 1) throw Object.assign(new Error("private-message"), { code: "ETIMEDOUT" });
    return startResult;
  } });
  h.send(call(1));
  const error = await h.response(1);
  assert.equal(error.result.isError, true);
  assert.match(resultText(error), /ETIMEDOUT/);
  assert.doesNotMatch(resultText(error), /private-message/);
  h.send(call(2));
  h.send(request(3));
  assert.deepEqual(JSON.parse(resultText(await h.response(2))), startResult);
  assert.deepEqual((await h.response(3)).result, {});
});

test("长启动调用不阻塞 ping 或 status，完成顺序可与请求顺序不同", async (t) => {
  const start = deferred();
  const entered = deferred();
  const h = harness(t, { ensureRunning: async () => { entered.resolve(); return start.promise; } });
  h.send(call("start"));
  await entered.promise;
  h.send(request("ping"));
  h.send(call("status", "bridge_status", {}));
  await h.response("ping");
  await h.response("status");
  assert.equal(h.messages.some((message) => message.id === "start"), false);
  start.resolve(startResult);
  assert.deepEqual(JSON.parse(resultText(await h.response("start"))), startResult);
});

test("取消仅 abort 对应 ID（包括 0），其他调用继续，通知本身没有响应", async (t) => {
  const entered = deferred();
  const signals = [];
  const h = harness(t, { ensureRunning: async (_config, { signal }) => {
    signals.push(signal);
    if (signals.length === 2) entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  h.send(call(0));
  h.send(call("0"));
  await entered.promise;
  h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0, reason: "private token" } });
  assert.equal((await h.response(0)).result.isError, true);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  h.send(request(3));
  assert.deepEqual((await h.response(3)).result, {});
  assert.equal(h.messages.some((message) => !Object.hasOwn(message, "id")), false);
  h.input.end();
  await h.done;
  assert.equal(signals[1].aborted, true);
});

test("重复的在途 ID 被拒绝，不覆盖原请求的取消控制器", async (t) => {
  const entered = deferred();
  let signal;
  let invoked = 0;
  const h = harness(t, { ensureRunning: async (_config, options) => {
    invoked++;
    signal = options.signal;
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  h.send(call(1));
  await entered.promise;
  h.send(call(1));
  assert.equal((await h.wait((message) => message.id === 1 && message.error)).error.code, -32600);
  h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
  assert.equal((await h.wait((message) => message.id === 1 && message.result)).result.isError, true);
  assert.equal(invoked, 1);
  assert.equal(signal.aborted, true);
});

test("无 id 的通知不执行工具、不回包，非法 progressToken 被拒绝", async (t) => {
  let invoked = 0;
  const h = harness(t, { ensureRunning: async () => { invoked++; return startResult; } });
  h.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "bridge_start", arguments: {} } });
  h.send({ jsonrpc: "2.0", method: "ping" });
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  h.send(call(1, "bridge_start", {}, { progressToken: {} }));
  h.send(request(2));
  await h.response(2);
  assert.equal((await h.response(1)).error.code, -32602);
  assert.equal(invoked, 0);
  assert.equal(h.messages.length, 2);
});

test("八个常规任务满载时仍可查状态并停止，控制通道也限制重复调用", async (t) => {
  const entered = deferred();
  const releases = [];
  const status = deferred();
  const stop = deferred();
  const h = harness(t, { getStatus: () => status.promise, stopBridge: () => stop.promise, ensureRunning: async () => {
    const release = deferred();
    releases.push(release);
    if (releases.length === 8) entered.resolve();
    return release.promise;
  } });
  for (let i = 1; i <= 8; i++) h.send(call(i));
  await entered.promise;
  h.send(call(9));
  h.send(request(10));
  assert.equal((await h.response(9)).result.isError, true);
  assert.equal(releases.length, 8);
  await h.response(10);
  h.send(call(12, "bridge_status", {}));
  h.send(call(13, "bridge_stop", {}));
  h.send(call(14, "bridge_status", {}));
  h.send(call(15, "bridge_stop", {}));
  assert.equal((await h.response(14)).result.isError, true);
  assert.equal((await h.response(15)).result.isError, true);
  status.resolve({ ready: true });
  stop.resolve({ stopped: true });
  assert.equal(JSON.parse(resultText(await h.response(12))).ready, true);
  assert.equal(JSON.parse(resultText(await h.response(13))).stopped, true);
  releases[0].resolve(startResult);
  await h.response(1);
  await nextTurn();
  h.send(call(11));
  await nextTurn();
  assert.equal(releases.length, 9);
  for (const release of releases) release.resolve(startResult);
  await h.response(11);
});

test("带 progressToken 的长调用每 10 秒心跳，结束后不再发送", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred();
  const start = deferred();
  const h = harness(t, { ensureRunning: async () => { entered.resolve(); return start.promise; } });
  h.send(call(1, "bridge_start", {}, { progressToken: 0 }));
  await entered.promise;
  t.mock.timers.tick(9_999);
  await nextTurn();
  assert.equal(h.messages.length, 0);
  t.mock.timers.tick(1);
  const first = await h.wait((message) => message.method === "notifications/progress");
  assert.equal(first.params.progressToken, 0);
  assert.equal(first.params.progress, 1);
  t.mock.timers.tick(10_000);
  await h.wait((message) => message.params?.progress === 2);
  start.resolve(startResult);
  await h.response(1);
  t.mock.timers.tick(30_000);
  await nextTurn();
  assert.equal(h.messages.filter((message) => message.method === "notifications/progress").length, 2);
});

test("取消立即停止心跳，即使启动实现尚未结束；背压不阻止取消输入", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred();
  const start = deferred();
  const writes = [];
  const callbacks = [];
  let signal;
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    writes.push(JSON.parse(chunk.toString()));
    callbacks.push(callback);
  } });
  const h = harness(t, { ensureRunning: async (_config, options) => {
    signal = options.signal;
    entered.resolve();
    return start.promise;
  } }, { output });
  h.send(call(1, "bridge_start", {}, { progressToken: "progress" }));
  await entered.promise;
  t.mock.timers.tick(10_000);
  await nextTurn();
  assert.equal(writes[0].method, "notifications/progress");
  h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
  await nextTurn();
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(30_000);
  callbacks.shift()();
  await nextTurn();
  assert.equal(writes.length, 1);
  start.resolve(startResult);
  await nextTurn();
  assert.equal(writes[1].result.isError, true);
  callbacks.shift()();
  await nextTurn();
});

test("EOF 取消在途请求，忽略取消的 handler 也不会使会话无限等待", async (t) => {
  const entered = deferred();
  let signal;
  const h = harness(t, { ensureRunning: async (_config, options) => {
    signal = options.signal;
    entered.resolve();
    return new Promise(() => {});
  } });
  h.send(call(1));
  await entered.promise;
  const before = performance.now();
  h.input.end();
  await h.done;
  assert.equal(signal.aborted, true);
  assert.ok(performance.now() - before < 1_800);
});

test("输入错误会取消调用且停止会话，不调用真实进程操作", async (t) => {
  const entered = deferred();
  let signal;
  const h = harness(t, { ensureRunning: async (_config, options) => {
    signal = options.signal;
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  h.send(call(1));
  await entered.promise;
  h.input.destroy(new Error("private-input-error"));
  await h.done;
  assert.equal(signal.aborted, true);
});

test("stdout 背压期间串行写入，drain 后继续，JSON 行不会交错", async (t) => {
  const callbacks = [];
  const chunks = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    chunks.push(chunk.toString());
    callbacks.push(callback);
  } });
  const h = harness(t, {}, { output });
  h.input.write(`${JSON.stringify(request(1))}\n${JSON.stringify(request(2))}\n`);
  await nextTurn();
  assert.equal(chunks.length, 1);
  assert.equal(h.input.isPaused(), false);
  callbacks.shift()();
  await nextTurn();
  assert.equal(chunks.length, 2);
  callbacks.shift()();
  await nextTurn();
  assert.equal(h.input.isPaused(), false);
  assert.deepEqual(chunks.map((chunk) => JSON.parse(chunk).id), [1, 2]);
});

test("stdout 断管不抛出未处理错误，并取消在途启动", async (t) => {
  const entered = deferred();
  let signal;
  const output = new Writable({ write(_chunk, _encoding, callback) {
    callback(Object.assign(new Error("private-broken-pipe"), { code: "EPIPE" }));
  } });
  const h = harness(t, { ensureRunning: async (_config, options) => {
    signal = options.signal;
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } }, { output });
  h.send(call(1));
  await entered.promise;
  h.send(request(2));
  await h.done;
  await nextTurn();
  assert.equal(signal.aborted, true);
});

test("stdout 永不 drain 时 EOF 仍有界结束", async (t) => {
  const output = new Writable({ highWaterMark: 1, write() {} });
  const h = harness(t, {}, { output });
  h.send(request(1));
  await nextTurn();
  h.input.end();
  const before = performance.now();
  await h.done;
  assert.ok(performance.now() - before < 1_800);
  assert.equal(output.destroyed, true);
});
