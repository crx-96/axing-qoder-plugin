import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { PLUGIN_VERSION } from "../bridge/config.mjs";
import { handleMessage, runMcp } from "../bridge/mcp-protocol.mjs";

const config = { apiKey: "private-api-value", mgmtKey: "private-management-value" };
const imageResult = { content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function handlers(overrides = {}) {
  return {
    getStatus: async () => ({ ready: true }),
    ensureRunning: async () => ({ started: true, ready: true, reason: "已启动" }),
    stopBridge: async () => ({ stopped: true, reason: "已停止" }),
    generateImage: async () => imageResult,
    ...overrides,
  };
}

function request(id, method = "ping", params) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function call(id, name = "bridge_generate_image", args = { prompt: "一只猫" }, meta) {
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
  const h = harness(t, { generateImage: async (_config, _args, options) => {
    signal = options.signal;
    entered.resolve();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return imageResult;
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
  assert.equal((await h.response(5)).result.tools.length, 4);
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

test("初始化与生图工具共同声明 GPT/Gemini 模型映射、用户指定及能力边界", async () => {
  const initialized = await handleMessage(request(1, "initialize", { protocolVersion: "2025-06-18" }), { config });
  const listed = await handleMessage(request(2, "tools/list"), { config });
  const guidance = initialized.result.instructions;
  assert.equal(typeof guidance, "string");
  const tool = listed.result.tools.find(tool => tool.name === "bridge_generate_image");
  assert.ok(tool.description.startsWith(guidance));
  for (const expected of [
    /当前聊天主模型/, /Codex 订阅/, /未明确指定/, /优先使用本插件的 bridge_generate_image/,
    /GPT 会话显式传入 model=gpt-image-2\.5/, /Gemini 会话显式传入 model=gemini-3\.1-flash-image/,
    /Gemini 会话不能省略 model/, /用户明确指定的工具或通道优先/, /明确指定的图片模型优先/,
    /其他主模型或无法确认当前聊天主模型时不据此改道/, /不按待生成的图片模型判断/,
    /仅适用于文生图/, /参考图编辑不受支持/, /不擅自换工具、换模型或重试/,
    /遵守宿主工具权限/, /不改变聊天主模型/,
  ]) assert.match(guidance, expected);
  assert.match(tool.inputSchema.properties.model.description, /Gemini 会话必须传 gemini-3\.1-flash-image/);
  assert.match(tool.inputSchema.properties.model.description, /省略仍为 gpt-image-2\.5/);
});

test("工具只有 status/start/stop/generate_image，移除 login 并明确单图订阅约束", async () => {
  const response = await handleMessage(request(1, "tools/list"), { config });
  const tools = response.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["bridge_status", "bridge_start", "bridge_stop", "bridge_generate_image"]);
  for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
  const image = tools[3];
  assert.deepEqual(image.inputSchema.required, ["prompt"]);
  assert.equal(image.inputSchema.properties.prompt.maxLength, 32_000);
  assert.equal(image.inputSchema.properties.model.default, "gpt-image-2.5");
  assert.equal(image.inputSchema.properties.output_format.default, "png");
  assert.match(image.description, /已授权订阅/);
  assert.match(image.description, /一张图片/);
  assert.match(image.description, /本 MCP 不自动降级或重试/);
  assert.match(image.description, /核心仍可能按配置轮换凭据和重试/);
  assert.match(image.description, /单次调用不保证上游只执行一次/);
  assert.match(image.description, /可能消耗订阅额度或产生费用/);
  const missing = await handleMessage(call(2, "bridge_login", {}), { config }, { handlers: handlers() });
  assert.equal(missing.error.code, -32602);
});

test("全部工具参数在调用依赖前严格校验，不接受未知参数、路径或 URL 输入字段", async () => {
  let invoked = 0;
  const injected = handlers({ generateImage: async () => { invoked++; return imageResult; } });
  const invalid = [
    null, [], "prompt", {}, { prompt: "" }, { prompt: " \n\t" }, { prompt: 3 },
    { prompt: "a".repeat(32_001) }, { prompt: "猫", model: 8 }, { prompt: "猫", model: "" },
    { prompt: "猫", model: "m".repeat(201) }, { prompt: "猫", size: "1x1" },
    { prompt: "猫", quality: "ultra" }, { prompt: "猫", background: "none" },
    { prompt: "猫", output_format: "svg" }, { prompt: "猫", path: "C:\\secret.png" },
    { prompt: "猫", url: "https://example.test/image.png" }, { prompt: "猫", n: 2 },
    JSON.parse('{"prompt":"猫","__proto__":{"admin":true}}'),
  ];
  for (const args of invalid) {
    const response = await handleMessage(call(1, "bridge_generate_image", args), { config }, { handlers: injected });
    assert.equal(response.error?.code, -32602, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(invoked, 0);
  for (const name of ["bridge_status", "bridge_start", "bridge_stop"]) {
    for (const args of [null, [], { force: true }]) {
      const response = await handleMessage(call(2, name, args), { config }, { handlers: injected });
      assert.equal(response.error.code, -32602);
    }
  }
});

test("图片默认值、Unicode 长度边界与全部枚举选项到达同一 handler", async () => {
  const seen = [];
  const signal = new AbortController().signal;
  const injected = handlers({ generateImage: async (...args) => { seen.push(args); return imageResult; } });
  const response = await handleMessage(call(1), { config }, { handlers: injected, signal });
  assert.equal(response.result, imageResult);
  assert.equal(seen[0][0], config);
  assert.deepEqual(seen[0][1], { prompt: "一只猫", model: "gpt-image-2.5", output_format: "png" });
  assert.equal(seen[0][2].signal, signal);
  await handleMessage(call(2, "bridge_generate_image", { prompt: "猫", model: "gpt-image-2.5-flare" }), { config }, { handlers: injected });
  assert.equal(seen[1][1].model, "gpt-image-2.5-flare");
  const gemini = await handleMessage(call(3, "bridge_generate_image", { prompt: "猫", model: "gemini-3.1-flash-image" }), { config }, { handlers: injected });
  assert.equal(gemini.result, imageResult);
  assert.deepEqual(seen[2][1], { prompt: "猫", model: "gemini-3.1-flash-image", output_format: "png" });
  const tools = (await handleMessage(request(2, "tools/list"), { config })).result.tools;
  for (const [key, rule] of Object.entries(tools[3].inputSchema.properties)) {
    for (const value of rule.enum ?? []) {
      assert.ok((await handleMessage(call(3, "bridge_generate_image", { prompt: "猫", [key]: value }), { config }, { handlers: injected })).result);
    }
  }
  assert.ok((await handleMessage(call(4, "bridge_generate_image", { prompt: "🐈".repeat(32_000), model: "m".repeat(200) }), { config }, { handlers: injected })).result);
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

test("start/stop 抛错统一标 isError，图片失败不自动重试或切换模型", async () => {
  for (const [name, handlerName] of [["bridge_start", "ensureRunning"], ["bridge_stop", "stopBridge"], ["bridge_generate_image", "generateImage"]]) {
    let count = 0;
    const injected = handlers({ [handlerName]: async (_config, args) => {
      count++;
      if (name === "bridge_generate_image") assert.equal(args.model, "gpt-image-2.5-flare");
      throw Object.assign(new Error("private failure"), { code: "ECONNREFUSED" });
    } });
    const args = name === "bridge_generate_image" ? { prompt: "猫", model: "gpt-image-2.5-flare" } : {};
    const response = await handleMessage(call(1, name, args), { config }, { handlers: injected });
    assert.equal(response.result.isError, true);
    assert.match(resultText(response), /ECONNREFUSED/);
    assert.equal(count, 1);
  }
});

test("安全错误码和 safeMessage 可解释且脱敏，普通 message/stack/body 不透传", async () => {
  const error = Object.assign(new Error(`raw ${config.apiKey} https://upstream.test/?token=hidden body`), {
    code: "IMAGE_CONNECTION_FAILED", safeMessage: `无法连接，${config.apiKey} ${config.mgmtKey} https://upstream.test/?token=hidden`,
    body: "private-response-body",
  });
  const response = await handleMessage(call(1), { config }, { handlers: handlers({ generateImage: async () => { throw error; } }) });
  assert.equal(response.result.isError, true);
  assert.match(resultText(response), /无法连接/);
  assert.match(resultText(response), /IMAGE_CONNECTION_FAILED/);
  assert.match(resultText(response), /本 MCP 未自动重试；核心仍可能按配置重试/);
  assert.doesNotMatch(JSON.stringify(response), /private-|upstream|hidden|raw |stack|body/);
  const unknown = await handleMessage(call(2), { config }, { handlers: handlers({ generateImage: async () => { throw Object.assign(error, { safeMessage: undefined, code: "secret-token-value" }); } }) });
  assert.doesNotMatch(JSON.stringify(unknown), /secret-token|private-|upstream|raw |body/);
  const long = await handleMessage(call(3), { config }, { handlers: handlers({ generateImage: async () => { throw { safeMessage: "错".repeat(2_000) }; } }) });
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
  h.send(call(7, "bridge_generate_image", { prompt: "" }));
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
  const h = harness(t, { generateImage: async () => {
    if (++calls === 1) throw Object.assign(new Error("private-message"), { code: "ETIMEDOUT" });
    return imageResult;
  } });
  h.send(call(1));
  const error = await h.response(1);
  assert.equal(error.result.isError, true);
  assert.match(resultText(error), /ETIMEDOUT/);
  assert.doesNotMatch(resultText(error), /private-message/);
  h.send(call(2));
  h.send(request(3));
  assert.deepEqual((await h.response(2)).result, imageResult);
  assert.deepEqual((await h.response(3)).result, {});
});

test("长图片调用不阻塞 ping 或 status，完成顺序可与请求顺序不同", async (t) => {
  const image = deferred();
  const entered = deferred();
  const h = harness(t, { generateImage: async () => { entered.resolve(); return image.promise; } });
  h.send(call("image"));
  await entered.promise;
  h.send(request("ping"));
  h.send(call("status", "bridge_status", {}));
  await h.response("ping");
  await h.response("status");
  assert.equal(h.messages.some((message) => message.id === "image"), false);
  image.resolve(imageResult);
  assert.deepEqual((await h.response("image")).result, imageResult);
});

test("取消仅 abort 对应 ID（包括 0），其他调用继续，通知本身没有响应", async (t) => {
  const entered = deferred();
  const signals = [];
  const h = harness(t, { generateImage: async (_config, _args, { signal }) => {
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
  const h = harness(t, { generateImage: async (_config, _args, options) => {
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
  const h = harness(t, { generateImage: async () => { invoked++; return imageResult; } });
  h.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "bridge_generate_image", arguments: { prompt: "猫" } } });
  h.send({ jsonrpc: "2.0", method: "ping" });
  h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  h.send(call(1, "bridge_generate_image", { prompt: "猫" }, { progressToken: {} }));
  h.send(request(2));
  await h.response(2);
  assert.equal((await h.response(1)).error.code, -32602);
  assert.equal(invoked, 0);
  assert.equal(h.messages.length, 2);
});

test("同时工具执行上限为 8，拒绝额外调用但 ping 可用，结束后释放名额", async (t) => {
  const entered = deferred();
  const releases = [];
  const h = harness(t, { generateImage: async () => {
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
  releases[0].resolve(imageResult);
  await h.response(1);
  await nextTurn();
  h.send(call(11));
  await nextTurn();
  assert.equal(releases.length, 9);
  for (const release of releases) release.resolve(imageResult);
  await h.response(11);
});

test("带 progressToken 的长调用每 10 秒心跳，结束后不再发送", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred();
  const image = deferred();
  const h = harness(t, { generateImage: async () => { entered.resolve(); return image.promise; } });
  h.send(call(1, "bridge_generate_image", { prompt: "猫" }, { progressToken: 0 }));
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
  image.resolve(imageResult);
  await h.response(1);
  t.mock.timers.tick(30_000);
  await nextTurn();
  assert.equal(h.messages.filter((message) => message.method === "notifications/progress").length, 2);
});

test("取消立即停止心跳，即使图片实现尚未结束；背压不阻止取消输入", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = deferred();
  const image = deferred();
  const writes = [];
  const callbacks = [];
  let signal;
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    writes.push(JSON.parse(chunk.toString()));
    callbacks.push(callback);
  } });
  const h = harness(t, { generateImage: async (_config, _args, options) => {
    signal = options.signal;
    entered.resolve();
    return image.promise;
  } }, { output });
  h.send(call(1, "bridge_generate_image", { prompt: "猫" }, { progressToken: "progress" }));
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
  image.resolve(imageResult);
  await nextTurn();
  assert.equal(writes[1].result.isError, true);
  callbacks.shift()();
  await nextTurn();
});

test("EOF 取消在途请求，忽略取消的 handler 也不会使会话无限等待", async (t) => {
  const entered = deferred();
  let signal;
  const h = harness(t, { generateImage: async (_config, _args, options) => {
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
  const h = harness(t, { generateImage: async (_config, _args, options) => {
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

test("stdout 断管不抛出未处理错误，并取消在途图片", async (t) => {
  const entered = deferred();
  let signal;
  const output = new Writable({ write(_chunk, _encoding, callback) {
    callback(Object.assign(new Error("private-broken-pipe"), { code: "EPIPE" }));
  } });
  const h = harness(t, { generateImage: async (_config, _args, options) => {
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
