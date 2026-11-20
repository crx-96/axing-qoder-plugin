import { readFile } from "node:fs/promises";
import { PLUGIN_VERSION } from "./config.mjs";
import { blockedManagementPorts } from "./bridge-ports.mjs";

/** 宿主在工具发现与资源读取时使用的稳定页面地址。 */
export const MANAGEMENT_APP_URI = "ui://qoder-subscription-proxy/management.html";
/** 指示宿主使用隔离的 MCP App 容器渲染 HTML。 */
export const MANAGEMENT_APP_MIME = "text/html;profile=mcp-app";


/** 生成自包含的全屏管理页，所有业务数据在宿主握手后按需读取。 */
export async function managementAppResource() {
  const [script, updateScript, installedScript, updateSection, portsScript, portsSection, icon] = await Promise.all([
    readFile(new URL("./panel/management-app.js", import.meta.url), "utf8"),
    readFile(new URL("./panel/core-update.js", import.meta.url), "utf8"),
    readFile(new URL("./panel/installed-cores.js", import.meta.url), "utf8"),
    readFile(new URL("./panel/core-update.html", import.meta.url), "utf8"),
    readFile(new URL("./panel/bridge-ports.js", import.meta.url), "utf8"),
    readFile(new URL("./panel/bridge-ports.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/entrypoint.png", import.meta.url), "base64"),
  ]);
  const logo = `<img class="logo" alt="" width="44" height="44" src="data:image/png;base64,${icon}">`;
  // 将服务端的禁用端口表内联到自包含页面，表单可在确认前给出与写入入口一致的提示。
  const bootstrap = `const pluginVersion=${JSON.stringify(PLUGIN_VERSION)};\nconst blockedManagementPorts=${JSON.stringify(blockedManagementPorts)};`;
  return {
    uri: MANAGEMENT_APP_URI,
    mimeType: MANAGEMENT_APP_MIME,
    text: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅代理管理</title>
<style>
:root {
  color-scheme:light dark; font:15px/1.55 system-ui,"Microsoft YaHei",sans-serif;
  --bg:light-dark(#f4f6f6,#14191b); --surface:light-dark(#fff,#1b2225);
  --ink:light-dark(#162a2e,#edf3f3); --muted:light-dark(#506266,#adbec0);
  --line:light-dark(#cdd7d7,#3b4a4e); --accent:light-dark(#08645d,#8cd9cd);
  --accent-ink:light-dark(#fff,#102c29); --error:light-dark(#973d25,#ffb29a);
  --active:light-dark(#225a96,#95c7ff); --focus:light-dark(#005dbe,#a2ceff);
}
* { box-sizing:border-box } [hidden] { display:none!important }
body { margin:0; background:var(--bg); color:var(--ink); overflow-wrap:anywhere }
main { max-width:850px; margin:auto; padding:clamp(18px,4vw,46px) clamp(14px,4vw,40px) }
header,.identity,.actions,.heading { display:flex; align-items:center }
header { justify-content:space-between; gap:12px; margin-bottom:24px }
.identity { gap:12px } .logo { flex:none; border-radius:10px }
h1,h2,p,dl,dd { margin:0 } h1 { font-size:clamp(1.25rem,3vw,1.65rem); line-height:1.25 }
.version,.hint,dt,summary { color:var(--muted) } .version { font-size:.86rem; white-space:nowrap }
.surface { background:var(--surface); border:1px solid var(--line); border-radius:14px }
section { padding:clamp(16px,3vw,28px) } section+section { border-top:1px solid var(--line) }
.heading { gap:10px } .heading::before { content:""; width:10px; height:10px; border-radius:50%; background:var(--muted); flex:none }
[data-tone=ready] .heading::before { background:var(--accent) } [data-tone=working] .heading::before { background:var(--active) }
[data-tone=error] .heading::before { background:var(--error) } [data-tone=error] .heading { color:var(--error) }
#status { font-size:clamp(1.2rem,3vw,1.55rem); line-height:1.35 } .hint { margin-top:7px; max-width:72ch }
.actions { flex-wrap:wrap; gap:8px; margin-top:18px } button { font:inherit; font-weight:550; min-height:44px; padding:7px 14px;
  border:1px solid var(--line); border-radius:7px; background:var(--surface); color:var(--ink); cursor:pointer; max-width:100% }
button[data-primary=true] { background:var(--accent); border-color:var(--accent); color:var(--accent-ink) }
button:hover:enabled,summary:hover { border-color:var(--accent); text-decoration:underline; text-underline-offset:.22em }
button:active:enabled { transform:translateY(1px) } button:disabled { opacity:.55; cursor:default }
:focus-visible { outline:3px solid var(--focus); outline-offset:3px } ::selection { background:var(--accent); color:var(--accent-ink) }
#notice:not(:empty) { margin-top:10px; font-size:.93rem } #download { margin-top:14px }
#amount,.version,dd { font-variant-numeric:tabular-nums } #amount { font-size:.92rem; color:var(--active) }
progress { display:block; width:100%; height:7px; margin-top:6px; accent-color:var(--active) }
progress[value] { appearance:none; border:none; border-radius:4px; overflow:hidden; background:var(--line) }
progress[value]::-webkit-progress-bar { background:var(--line) } progress[value]::-webkit-progress-value { background:var(--active) }
progress[value]::-moz-progress-bar { background:var(--active) }
@media(prefers-reduced-motion:reduce) { progress:indeterminate { opacity:0 } }
#overview h2 { font-size:1.05rem; margin-bottom:10px } dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); column-gap:30px }
.fact { display:grid; grid-template-columns:6em minmax(0,1fr); align-items:baseline; gap:8px; padding:9px 0; border-top:1px solid var(--line) }
dt { font-size:.9rem } dd { font-weight:540 } details { margin-top:12px } summary { cursor:pointer; width:fit-content; max-width:100%; padding:9px 0 }
#more { grid-template-columns:1fr } #more dd { font-size:.92rem; font-weight:400 } .usage { margin-top:12px; color:var(--muted); font-size:.92rem }
@media(max-width:600px) { dl { grid-template-columns:1fr } header { margin-bottom:16px } .logo { width:36px; height:36px } .actions { gap:6px } }
#core-update h2,#installed-cores h2 { font-size:1.05rem } #installed-cores ul { padding:0; margin:.6rem 0; list-style:none }
#installed-cores li { display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding:.65rem 0; border-bottom:1px solid var(--line) }
#installed-cores li>span { margin-inline-end:auto; font-variant-numeric:tabular-nums } #installed-cores li>div { flex-basis:100% }
#installed-cores li>div p { margin-block:.45rem } #installed-cores button { min-height:36px; font-size:.92rem }
@media(max-width:420px) { .browser-label { display:none } #installed-cores li>span { flex-basis:100% } }
</style></head>
<body><main><header><div class="identity">${logo}<h1>订阅代理管理</h1></div><span class="version">插件 v${PLUGIN_VERSION}</span></header>
<div class="surface"><section id="runtime" aria-labelledby="status">
<div role="status" aria-live="polite" aria-atomic="true"><div class="heading"><h2 id="status">正在连接 Qoder…</h2></div><p id="detail" class="hint"></p></div>
<div id="download" hidden><span id="amount"></span><progress id="progress" aria-label="核心下载进度" aria-describedby="amount"></progress></div>
<div class="actions"><button id="start" hidden disabled>启动核心</button><button id="open" aria-label="打开原生管理页（浏览器）" disabled>打开原生管理页<span class="browser-label">（浏览器）</span></button><button id="refresh" disabled>刷新状态</button><button id="reconnect" hidden disabled>重新连接</button></div>
<p id="notice" role="status" aria-live="polite"></p></section>
<section id="overview" aria-labelledby="diagnostics" hidden><h2 id="diagnostics">诊断概览</h2><dl id="facts"></dl>
<details><summary>配置与使用详情</summary><dl id="more"></dl><p class="usage">在 Qoder 添加自定义模型时，填写这里的模型端点和原生管理页中的 Model ID。需要用「Agent」写入 Qoder 或 Qoder CN 时，请按插件使用指南设置 BRIDGE_QODER_CLIENT。此代理随 Qoder 启停；多工具长期共用时，建议单独运行 Magpie。</p></details>
</section>${portsSection}${updateSection}<section id="installed-cores" hidden aria-label="已安装版本"></section></div></main><script>${[bootstrap, updateScript, installedScript, portsScript, script].join("\n").replaceAll("</script", "<\\/script")}</script></body></html>`,
    _meta: {
      "qoder/ui": { availableDisplayModes: ["fullscreen"], preferredDisplayMode: "fullscreen" },
    },
  };
}
