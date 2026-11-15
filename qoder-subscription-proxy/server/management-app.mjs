import { readFile } from "node:fs/promises";

export const MANAGEMENT_APP_URI = "ui://qoder-subscription-proxy/management.html";
export const MANAGEMENT_APP_MIME = "text/html;profile=mcp-app";

export async function managementAppResource() {
  const script = await readFile(new URL("./panel/management-app.js", import.meta.url), "utf8");
  return {
    uri: MANAGEMENT_APP_URI,
    mimeType: MANAGEMENT_APP_MIME,
    text: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅代理管理</title>
<style>:root{color-scheme:light dark;font:15px system-ui}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:light-dark(#fafafa,#171717);color:light-dark(#202020,#eee)}main{max-width:640px;padding:48px 24px;margin:auto}h1{font-size:24px;margin:0 0 20px}p{line-height:1.7}#status{min-height:52px}button{font:inherit;padding:10px 18px;border:1px solid #8888;border-radius:8px;background:transparent;color:inherit;cursor:pointer}button:focus-visible{outline:2px solid #508bff;outline-offset:3px}button:disabled{opacity:.5;cursor:default}</style></head>
<body><main hidden><h1>订阅代理管理</h1><p id="status" role="status"></p><button id="open" hidden disabled>重试打开浏览器</button></main>
<script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
    _meta: {
      "qoder/ui": { availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" },
    },
  };
}
