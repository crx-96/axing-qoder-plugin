import http from "node:http";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AcpConnection, acpError } from "./acp-connection.mjs";
import { ensureAcpRuntime, assertAcpRuntimeUnchanged } from "./acp-runtime.mjs";
import { AcpTurn, modelOptions, newAcpSession, validateAcpRequest } from "./acp-turn.mjs";
import { configureAcpProvider } from "./acp-provider.mjs";

const services = new Map();
export function getAcpService(config) { return services.get(config.dataDir); }

export function createAcpService(config, { initialModels = [], prepareRuntime = ensureAcpRuntime, verifyRuntime = assertAcpRuntimeUnchanged, Connection = AcpConnection, Turn = AcpTurn, onModels = async () => {} } = {}) {
  const key = randomBytes(32).toString("hex");
  const controlKey = randomBytes(32).toString("hex");
  const turns = new Map();
  let server, runtime, control, preparing, stopping, startupController, closeWork, closing = false;
  let models = structuredClone(initialModels), state = "not_connected", failure = null, selectedAuthMethod;
  let activeRequests = 0;
  const workspace = join(config.dataDir, "acp-workspace");
  const notifyModels = async signal => onModels(models.map(item => ({ ...item, id: "acp/" + item.id })), service.endpoint, key, signal);
  const status = () => ({ state, ready: state === "ready", runtime: runtime ? { source: runtime.source, version: runtime.version } : null,
    models: models.map(item => ({ id: "acp/" + item.id, name: item.name })), activeTurns: turns.size, error: failure });

  async function connect({ authenticate = false, methodId = "oauth-personal", signal } = {}) {
    if (closing) throw acpError("ACP_CLOSED", "ACP 管理服务已关闭。");
    if (preparing || stopping) throw acpError("ACP_BUSY", "ACP 正在准备、登录或停止，请等待当前操作完成。");
    if (turns.size) throw acpError("ACP_BUSY", "请先结束或停用活动回合，再重新连接或切换认证。");
    startupController = new AbortController();
    signal = signal ? AbortSignal.any([signal, startupController.signal]) : startupController.signal;
    preparing = (async () => {
      try {
        failure = null;
        runtime = await prepareRuntime(config, { signal, allowDownload: true, onState: value => { state = value; } });
        signal?.throwIfAborted();
        if (closing) throw acpError("ACP_CLOSED", "ACP 已停止。");
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        await control?.close();
        signal.throwIfAborted();
        runtime = { ...runtime, authMethod: authenticate ? methodId : selectedAuthMethod ?? runtime.authMethod };
        control = new Connection(runtime);
        const info = await control.initialize(signal);
        if (authenticate) {
          if (!info.authMethods?.some(method => method.id === methodId)) throw acpError("ACP_AUTH_METHOD", "官方程序不支持所选认证方式。");
          state = "authenticating";
          await control.call("authenticate", { methodId }, { signal, timeoutMs: 300000 });
          selectedAuthMethod = methodId;
        }
        state = "discovering";
        const session = await newAcpSession(control, workspace, [], signal);
        signal.throwIfAborted();
        models = modelOptions(session).models;
        if (!models.length) throw acpError("ACP_MODELS_EMPTY", "官方 ACP 尚未返回可用模型，请检查授权和套餐。");
        await notifyModels(signal);
        signal.throwIfAborted();
        state = "ready";
        return status();
      } catch (error) {
        state = error.code === "ACP_AUTH_REQUIRED" ? "authentication_required" : "error";
        failure = { code: error.code ?? "ACP_FAILED", message: error.safeMessage ?? "ACP 准备失败，请检查官方程序与网络。" };
        throw acpError(failure.code, failure.message);
      } finally { await control?.close(); control = null; }
    })();
    try { return await preparing; } finally { preparing = null; }
  }

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      state = "stopped";
      startupController?.abort();
      await control?.close();
      if (preparing) await preparing.catch(() => {});
      state = "stopped";
      await Promise.all([...turns.values()].map(turn => turn.close()));
      turns.clear(); models = [];
      await notifyModels();
    })();
    try { await stopping; } finally { stopping = null; }
  }

  async function ensureConnected(signal) {
    if (preparing) {
      await new Promise((resolve, reject) => {
        const abort = () => reject(acpError("ACP_CANCELLED", "等待 ACP 连接时已取消请求。"));
        signal.addEventListener("abort", abort, { once: true });
        preparing.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    } else if (state === "not_connected" && models.length) await connect({ signal });
    signal.throwIfAborted();
    if (closing || state !== "ready" || !runtime) throw acpError("ACP_NOT_READY", "ACP 尚未就绪，请先从管理入口连接；不会回退旧 Google 通道。");
  }

  async function manage(operation, args = {}, signal) {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "methodId") ||
        args.methodId !== undefined && !["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"].includes(args.methodId)) {
      throw acpError("ACP_INVALID_REQUEST", "ACP 管理参数无效。");
    }
    if (operation === "stop") await stop();
    else if (["connect", "authenticate"].includes(operation)) await connect({ authenticate: operation === "authenticate", methodId: args.methodId, signal });
    else if (operation !== "status") throw acpError("ACP_INVALID_REQUEST", "ACP 管理操作无效。");
    return status();
  }

  async function handle(req, res) {
    const isControl = req.url?.startsWith("/control/");
    const credential = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from("Bearer " + (isControl ? controlKey : key));
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.origin !== undefined ||
        credential.length !== expected.length || !timingSafeEqual(credential, expected)) { res.writeHead(401).end(); return; }
    if (isControl) {
      const operation = req.url.slice("/control/".length);
      if (!(operation === "status" && req.method === "GET") &&
          !(["connect", "authenticate", "stop"].includes(operation) && req.method === "POST")) { res.writeHead(404).end(); return; }
      const controller = new AbortController();
      res.once("close", () => { if (!res.writableEnded) controller.abort(); });
      res.setHeader("Content-Type", "application/json");
      try {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 4096) throw acpError("ACP_INPUT_LIMIT", "ACP 管理请求过大。"); }
        res.end(JSON.stringify(await manage(operation, JSON.parse(raw || "{}"), controller.signal)));
      } catch (error) {
        if (!res.destroyed) res.writeHead(400).end(JSON.stringify({ error: { code: error.code ?? "ACP_INVALID_REQUEST", message: error.safeMessage ?? "ACP 操作未完成，请检查状态。" } }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ object: "list", data: models.map(item => ({ id: "acp/" + item.id, object: "model", owned_by: "antigravity-acp" })) })); return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    if (activeRequests >= 8) { res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "ACP_BUSY", message: "ACP 在途请求已达上限。" } })); return; }
    activeRequests++;
    const abort = new AbortController();
    res.once("close", () => { if (!res.writableEnded) abort.abort(); });
    let turn;
    try {
      if (closing) throw acpError("ACP_CLOSED", "ACP 管理服务已关闭。");
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw acpError("ACP_INPUT_LIMIT", "请求超过容量限制。");
      }
      const request = JSON.parse(raw);
      validateAcpRequest(request);
      await ensureConnected(abort.signal);
      const last = request.messages.at(-1);
      if (last.role === "tool") {
        turn = [...turns.values()].find(candidate => candidate.toolIds.includes(last.tool_call_id));
        if (!turn) throw acpError("ACP_SESSION_LOST", "工具对应的 ACP 会话不存在或已过期；不会重放工具。");
        turn.resume(request);
      } else {
        const limit = request.tools?.length && request.tool_choice !== "none" ? 4 : 6;
        await verifyRuntime(runtime);
        abort.signal.throwIfAborted();
        if (closing || state !== "ready") throw acpError("ACP_NOT_READY", "ACP 已停止，未创建新回合。");
        if (turns.size >= limit) throw acpError("ACP_BUSY", "ACP 活动会话已达上限，请等待或停止旧任务。");
        turn = new Turn(runtime, request, workspace, { onClose: () => turns.delete(turn.id) });
        turns.set(turn.id, turn);
        await turn.start(abort.signal);
      }
      const envelope = { id: "chatcmpl-" + randomUUID(), created: Math.floor(Date.now() / 1000), model: request.model };
      const stream = (delta, finish_reason = null) => {
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        if (res.writableLength > 4 * 1024 * 1024) { abort.abort(); throw acpError("ACP_SLOW_CLIENT", "客户端未及时读取响应，已取消生成。"); }
        res.write(`data: ${JSON.stringify({ ...envelope, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      };
      const result = await turn.round(abort.signal, request.stream ? text => stream({ role: "assistant", content: text }) : undefined);
      if (request.stream) {
        if (result.message.tool_calls) stream({ role: "assistant", tool_calls: result.message.tool_calls.map((call, index) => ({ index, ...call })) });
        stream({}, result.finish_reason);
        res.end("data: [DONE]\n\n");
      } else res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ...envelope, object: "chat.completion", choices: [{ index: 0, ...result }] }));
      if (result.finish_reason !== "tool_calls") { turns.delete(turn.id); await turn.close(); }
    } catch (error) {
      if (turn) { turns.delete(turn.id); await turn.close(); }
      const code = error.code ?? "ACP_INVALID_REQUEST";
      const statusCode = ["ACP_NOT_READY", "ACP_BUSY"].includes(code) ? 503 : 400;
      const failure = { error: { code, type: "acp_error", message: error.safeMessage ?? "ACP 请求无效或未完成，不会回退到旧通道。" } };
      if (!res.destroyed) {
        if (res.headersSent) res.end(`data: ${JSON.stringify(failure)}\n\n`);
        else res.writeHead(statusCode, { "Content-Type": "application/json" }).end(JSON.stringify(failure));
      }
    } finally { activeRequests--; }
  }

  const service = {
    endpoint: null,
    configure: text => configureAcpProvider(text, models.map(item => ({ ...item, id: "acp/" + item.id })), service.endpoint, key),
    status, connect, stop, manage,
    get controlEndpoint() { return server?.listening ? { port: server.address().port, key: controlKey } : null; },
    async listen() {
      if (server) return;
      server = http.createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }); });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      service.endpoint = `http://127.0.0.1:${server.address().port}/v1`;
      services.set(config.dataDir, service);
    },
    close() {
      if (closeWork) return closeWork;
      closing = true;
      startupController?.abort();
      closeWork = (async () => {
        await control?.close();
        if (preparing) await preparing.catch(() => {});
        await Promise.all([...turns.values()].map(turn => turn.close()));
        turns.clear();
        server?.closeAllConnections();
        if (server?.listening) await new Promise(resolve => server.close(resolve));
        if (services.get(config.dataDir) === service) services.delete(config.dataDir);
      })();
      return closeWork;
    },
  };
  return service;
}
