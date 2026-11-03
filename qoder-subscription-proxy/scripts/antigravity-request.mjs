/** Windows 授权助手的私有管道子进程，只向已验证归属的核心发送一次 OAuth 操作。 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.mjs";
import { requestOwned } from "../server/supervisor.mjs";

/** 控制台输入最长 16 KiB；为 JSON 转义和协议字段保留空间。 */
const MAX_INPUT_BYTES = 128 * 1024;

/** 从匿名管道读取一个有界 JSON 对象，拒绝截断、超长及未知操作，不记录内容。 */
async function readRequest() {
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > MAX_INPUT_BYTES) throw new Error("Invalid request");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 验证管道消息，选用固定的管理操作，仅向调用者返回该步骤需要的字段和状态。 */
async function performRequest() {
  const { operation, port, state, code, deadline } = await readRequest();
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isSafeInteger(deadline) || deadline > Date.now() + 15_000 ||
      !["auth-url", "callback", "status"].includes(operation)) throw new Error("Invalid request");
  if (operation !== "auth-url" &&
      (typeof state !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(state) || state.includes(".."))) throw new Error("Invalid state");
  if (operation === "callback" && (typeof code !== "string" || !code.trim() || code.length > 16384)) throw new Error("Invalid callback");

  // -Port 仅选择本机目标，已有配置中的监听、授权目录及凭据均由与 MCP 相同的入口核验。
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const config = await loadConfig({ pluginRoot, env: { ...process.env, BRIDGE_PORT: String(port) } });
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error("Expired");

  // 认证头、回调正文都必须在核实同一条 TCP 连接归属后发送。固定路径禁止重定向或重试。
  const path = operation === "auth-url" ? "/v8/management/oauth/auth-url?provider=antigravity&is_webui=false"
    : operation === "status" ? `/v8/management/oauth/status?state=${encodeURIComponent(state)}`
    : "/v8/management/oauth/callback";
  const response = await requestOwned(config, path, {
    management: true, timeoutMs, signal: AbortSignal.timeout(timeoutMs), maxBytes: 65536,
    ...(operation === "callback" ? { method: "POST", body: { provider: "antigravity", state, code } } : {}),
  });
  if (response.status < 200 || response.status >= 300) return { error: "http", status: response.status };
  // 上游正文可能含敏感诊断，只将成功响应的协议字段交给父进程继续校验。
  let result;
  try { result = JSON.parse(response.text); } catch { return { error: "response", status: response.status }; }
  if (typeof result?.status !== "string") return { error: "response", status: response.status };
  return { result: operation === "auth-url" ? { status: result.status, url: result.url, state: result.state } : { status: result.status } };
}

// 唯一输出目标是 PowerShell 私有管道。异常堆栈、源码和响应正文均不写入终端。
try { process.stdout.write(JSON.stringify(await performRequest())); }
catch { process.stdout.write('{"error":"transport"}'); }
