import { readFile } from "node:fs/promises";
import { PLUGIN_VERSION } from "./config.mjs";

export const MANAGEMENT_APP_URI = "ui://qoder-subscription-proxy/management.html";
export const MANAGEMENT_APP_MIME = "text/html;profile=mcp-app";

export async function managementAppResource() {
  const script = await readFile(new URL("./panel/management-app.js", import.meta.url), "utf8");
  const bootstrap = `const pluginVersion=${JSON.stringify(PLUGIN_VERSION)};`;
  return {
    uri: MANAGEMENT_APP_URI,
    mimeType: MANAGEMENT_APP_MIME,
    text: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅代理管理</title>
<style>:root{color-scheme:light dark;font:15px system-ui}*{box-sizing:border-box}body{margin:0;background:light-dark(#fafafa,#171717);color:light-dark(#202020,#eee)}main{max-width:960px;margin:auto;padding:24px}h1{font-size:24px}p{line-height:1.7;overflow-wrap:anywhere}.muted{color:light-dark(#595959,#bbb)}button{font:inherit;min-height:44px;max-width:100%;padding:9px;border:1px solid #8888;border-radius:6px;background:light-dark(#fff,#242424);color:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}:focus-visible{outline:2px solid #508bff;outline-offset:3px}[hidden]{display:none!important}.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}#status{white-space:pre-wrap}@media(max-width:480px){main{padding:14px}}</style></head>
<body><main><h1>订阅代理管理</h1>
<p class="muted">查看核心状态；账号登录、服务商、模型与路由设置请使用 Magpie 原生管理页。</p>
<div class="actions"><button id="open" disabled>打开原生管理页（浏览器）</button><button id="start" hidden disabled>启动核心</button><button id="refresh" disabled>刷新状态</button><button id="reconnect" hidden disabled>重新连接</button></div>
<p id="status" role="status" aria-live="polite">正在连接 Qoder…</p>
</main><script>${(bootstrap + script).replaceAll("</script", "<\\/script")}</script></body></html>`,
    _meta: {
      "qoder/ui": { availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" },
    },
  };
}
