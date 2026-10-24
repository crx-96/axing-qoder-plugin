import http from "node:http";

/** 回环请求使用独立连接，不读取系统代理，也不复用切换网络前的连接。 */
export function requestLocal(config, path, {
  method = "GET", body, authenticated = false, signal,
  timeoutMs = 3000, maxBytes = 1024 * 1024,
} = {}) {
  if (config.host !== "127.0.0.1" || !path.startsWith("/") || path.startsWith("//")) {
    return Promise.reject(new Error("仅允许访问订阅桥的本机回环地址"));
  }
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { Accept: "application/json", Connection: "close" };
    if (authenticated) headers.Authorization = `Bearer ${config.apiKey}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }
    let finished = false;
    let timer;
    const req = http.request({
      hostname: config.host, port: config.port, path, method, headers, agent: false,
    });
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      const error = new Error("请求已取消");
      error.code = "ABORT_ERR";
      req.destroy(error);
    };
    req.on("error", (error) => finish(error));
    req.on("response", (res) => {
      const chunks = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = new Error("桥响应超过大小限制");
          error.code = "RESPONSE_TOO_LARGE";
          finish(error);
          res.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", (error) => finish(error));
      res.on("aborted", () => finish(Object.assign(new Error("桥连接提前断开"), { code: "ECONNRESET" })));
      res.on("end", () => finish(null, {
        status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    // 使用总时限而非空闲时限，持续输出无效字节也不能无限延长请求。
    timer = setTimeout(() => {
      req.destroy(Object.assign(new Error("桥请求超时"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else req.end(payload);
  });
}

/** HTTP 错误正文可能含账号或上游凭据，只传播状态码与本地诊断。 */
export function httpFailure(status, operation) {
  const hints = {
    401: "本地 API Key 不匹配，请核对配置",
    403: "账号或模型没有该能力的权限",
    404: "当前桥未启用此端点或模型不可用",
    429: "订阅额度或速率受限，请等待恢复后再试",
    502: "上游连接失败，检查代理节点后重试",
    503: "暂无可用账号或上游暂不可用",
    504: "上游响应超时",
  };
  return new Error(`${operation}失败（HTTP ${status}）：${hints[status] || "请在管理面板查看错误详情"}`);
}
