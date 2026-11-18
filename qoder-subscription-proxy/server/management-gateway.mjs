import { spawn } from "node:child_process";
import { join } from "node:path";
import { getManagementLoginKey } from "./supervisor.mjs";

async function openSystemBrowser(url) {
  const windows = process.platform === "win32";
  const program = windows ? join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe")
    : process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  const child = spawn(program, windows ? ["url.dll,FileProtocolHandler", url] : [url],
    { windowsHide: true, detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("error", () => reject(Object.assign(new Error(), { safeMessage: "无法打开系统默认浏览器。" })));
    child.once("spawn", resolve);
  });
  child.unref();
}

export async function openManagement(config, { signal, launchBrowser = openSystemBrowser, loginKey = getManagementLoginKey } = {}) {
  signal?.throwIfAborted();
  const key = await loginKey(config, signal);
  signal?.throwIfAborted();
  const url = new URL(config.managementUrl);
  url.searchParams.set("k", key);
  await launchBrowser(url.href);
}
