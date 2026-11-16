import { readFile } from "node:fs/promises";

export const MANAGEMENT_APP_URI = "ui://qoder-subscription-proxy/management.html";
export const MANAGEMENT_APP_MIME = "text/html;profile=mcp-app";

export async function managementAppResource() {
  const script = await readFile(new URL("./panel/management-app.js", import.meta.url), "utf8");
  return {
    uri: MANAGEMENT_APP_URI,
    mimeType: MANAGEMENT_APP_MIME,
    text: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅代理管理</title>
<style>:root{color-scheme:light dark;font:15px system-ui}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;background:light-dark(#fafafa,#171717);color:light-dark(#202020,#eee)}main{width:100%;max-width:520px;padding:40px 24px;text-align:center}h1{font-size:24px;line-height:1.4;margin:0 0 16px}p{line-height:1.8;margin:0 0 28px;color:light-dark(#595959,#b8b8b8);overflow-wrap:anywhere}button{font:inherit;min-height:44px;padding:10px 20px;border:1px solid #8888;border-radius:8px;background:light-dark(#fff,#242424);color:inherit;cursor:pointer}button:hover:not(:disabled){background:light-dark(#f0f0f0,#303030)}button:focus-visible{outline:2px solid #508bff;outline-offset:3px}button:disabled{opacity:.5;cursor:default}</style></head>
<body><main><h1>订阅代理管理</h1><p id="status" role="status">正在请求系统默认浏览器打开管理页…</p><button id="open" hidden disabled>再次打开管理页</button></main>
<script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    _meta: {
      "qoder/ui": { availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" },
    },
  };
}
