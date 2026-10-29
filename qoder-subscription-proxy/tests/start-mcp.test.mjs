import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, writeFile, rm, access, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { loadConfig } from "../bridge/config.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";
import { processIdentity, probeBridge } from "../bridge/bridge-process.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, "scripts", "start-mcp.ps1");
const entry = join(root, "scripts", "mcp-server.mjs");
const systemRoot = process.env.SystemRoot || "C:\\Windows";
const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const execFileAsync = promisify(execFile);
const windowsOnly = process.platform !== "win32" ? "启动器仅支持 Windows" : false;
const nativeWindowsOnly = windowsOnly || nativeCoreSkip;

async function waitUntil(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error("PowerShell 启动器测试等待超时");
}

async function powerShellJson(script) {
  const { stdout } = await execFileAsync(powerShell, ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); ${script}`], {
    windowsHide: true, timeout: 10000, maxBuffer: 32768,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ""));
}

async function cleanupHarness(child, harnessPath) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  try {
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 5000);
    return;
  } catch {
    const encoded = Buffer.from(harnessPath).toString("base64");
    await powerShellJson(`$ErrorActionPreference='Stop'; $path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $root=Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; if(-not $root){'true'; exit}; if(-not $root.CommandLine.Contains($path)){throw 'Refuse to stop unrelated harness'}; $all=@(Get-CimInstance Win32_Process); $owned=@($root); for($i=0;$i -lt $owned.Count;$i++){ $owned+=@($all | Where-Object { $_.ParentProcessId -eq $owned[$i].ProcessId }) }; [Array]::Reverse($owned); foreach($expected in $owned){ $handle=Get-Process -Id $expected.ProcessId -ErrorAction SilentlyContinue; if(-not $handle){continue}; $null=$handle.Handle; $now=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$expected.ProcessId); if(-not $now){continue}; if($now.CreationDate -ne $expected.CreationDate -or $now.CommandLine -ne $expected.CommandLine -or $now.ExecutablePath -ne $expected.ExecutablePath){throw 'Process identity changed'}; $handle.Kill(); $null=$handle.WaitForExit(5000) }; 'true'`);
  }
}

async function terminateCapturedProcess(identity) {
  if (!identity) return;
  const encoded = Buffer.from(JSON.stringify(identity)).toString("base64");
  await powerShellJson(`$ErrorActionPreference='Stop'; $e=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $p=Get-Process -Id $e.pid -ErrorAction SilentlyContinue; if(-not $p){'true'; exit}; $null=$p.Handle; $c=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$e.pid); if(-not $c){'true'; exit}; if($c.ExecutablePath -ne $e.executablePath -or $c.CommandLine -ne $e.commandLine -or $c.CreationDate.ToUniversalTime().ToString('o') -ne $e.creationDate){throw 'Refuse to terminate unrelated process'}; $p.Kill(); if(-not $p.WaitForExit(5000)){throw 'Test process did not exit'}; 'true'`);
}

async function launcherSession(t, runtime, { noNodePath = false, killWrapper = false, startupFailure } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "subscription-launcher-中文 空格-"));
  const harnessPath = join(directory, "启动器 harness.mjs");
  const env = {
    ...process.env, BRIDGE_DATA_DIR: join(directory, "隔离 data"), BRIDGE_BIN: join(directory, "never-start.exe"),
    BRIDGE_HOST: "127.0.0.1", BRIDGE_MGMT_KEY: "123456",
    BRIDGE_API_KEY: "launcher-test-secret-do-not-return",
  };
  if (noNodePath) {
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    env.PATH = [join(systemRoot, "System32"), systemRoot, join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";");
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  let config;
  let serverIdentity;
  let bridgeIdentity;
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  assert.ok(![8787, 19787].includes(port));
  env.BRIDGE_PORT = startupFailure === "invalid-config" ? "invalid" : String(port);
  if (killWrapper) {
    env.BRIDGE_BIN = join(directory, "隔离 订阅代理.exe");
    await copyTestCore(env.BRIDGE_BIN);
    config = await loadConfig({ pluginRoot: root, env });
  } else if (!startupFailure || startupFailure === "missing-paused") {
    // 暂停期间不准备或执行核心；同时覆盖可用和缺失的自定义文件。
    if (!startupFailure) await copyFile(process.execPath, env.BRIDGE_BIN);
    config = await loadConfig({ pluginRoot: root, env });
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(config.pausedPath, "Test keeps bridge paused\n");
  }
  await writeFile(harnessPath, `import {spawn} from 'node:child_process';
const hold=${killWrapper} ? setInterval(()=>{},1000) : null;
process.stdin.on('end',()=>clearInterval(hold));
const child=spawn(${JSON.stringify(powerShell)}, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${JSON.stringify(launcher)}], {env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
process.stderr.write(JSON.stringify({harness:true,pid:process.pid,powerShellPid:child.pid,runtime:process.execPath,electron:process.versions.electron || null,path:process.env.PATH || process.env.Path || ''})+'\\n');
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on('error',()=>{});
child.on('error',(error)=>{process.stderr.write(error.code+'\\n');process.exitCode=1;});
child.on('exit',(code)=>{process.exitCode=code ?? 1;if(hold)process.stdin.resume();});
`);
  const child = spawn(runtime, [harnessPath], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let errors = "";
  let harness;
  let failure;
  const waiters = new Map();
  const responses = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.on("error", (error) => { failure = error; });
  child.stdin.on("error", (error) => {
    if (!startupFailure || !["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) failure = error;
  });
  child.once("close", () => {
    for (const finish of [...waiters.values()]) finish(null);
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
    const firstLine = errors.split("\n", 1)[0];
    try { harness = JSON.parse(firstLine); } catch { /* 元信息可能跨数据块。 */ }
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line);
        assert.equal(response.jsonrpc, "2.0", "PowerShell stdout 只能包含 MCP JSON-RPC");
        responses.push(response);
        waiters.get(response.id)?.(response);
      } catch (error) { failure = error; }
    }
  });
  t.after(async () => {
    await cleanupHarness(child, harnessPath);
    if (killWrapper) {
      await terminateCapturedProcess(serverIdentity);
      if (!bridgeIdentity) {
        try { bridgeIdentity = JSON.parse(await readFile(config.pidPath, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await terminateCapturedProcess(bridgeIdentity);
      await waitUntil(async () => (await probeBridge(config)).state === "offline");
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function request(id, method, params, { allowStartupFailure = false } = {}) {
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(failure || new Error(`启动器 ${method} 超时；${errors}`)); }, 20000);
      const finish = (response) => { clearTimeout(timer); waiters.delete(id); resolve(response); };
      waiters.set(id, finish);
      if (child.exitCode !== null || child.signalCode !== null) finish(null);
    });
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }
    const response = await pending;
    if (failure) throw failure;
    if (allowStartupFailure) return response;
    assert.ok(response, `MCP 在 ${method} 响应前退出：${errors}`);
    assert.equal(response.error, undefined);
    return response.result;
  }
  const initializeParams = {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "中文测试客户端", version: "1" },
  };
  if (startupFailure === "invalid-config") {
    const initialized = await request("中文握手", "initialize", initializeParams, { allowStartupFailure: true });
    child.stdin.end();
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
    await waitUntil(() => child.stdout.readableEnded && child.stderr.readableEnded);
    assert.notEqual(child.exitCode, 0, "准备失败必须由实际 PowerShell 启动链非零退出");
    assert.equal(child.signalCode, null);
    if (failure) throw failure;
    assert.equal(responses.some((response) => response.result?.serverInfo), false, "失败不能先报告握手成功");
    if (initialized) {
      assert.equal(initialized.id, "中文握手");
      assert.equal(initialized.result, undefined);
      assert.ok(Number.isInteger(initialized.error?.code));
      assert.equal(typeof initialized.error.message, "string");
    }
    assert.equal(harness?.harness, true);
    assert.equal(buffer, "");
    const diagnostics = errors.trim().split(/\r?\n/).slice(1).join("\n");
    assert.ok(diagnostics.trim(), "快速配置失败至少写出安全 stderr 摘要");
    assert.doesNotMatch(JSON.stringify(responses) + diagnostics, /launcher-test-secret-do-not-return|Error:|\bat .*\(|Bearer |https?:\/\//);
    assert.equal(diagnostics.includes(directory), false, "安全摘要不得暴露测试目录或二进制路径");
    if (config) {
      assert.equal((await probeBridge(config)).state, "offline");
      await assert.rejects(access(config.pidPath), { code: "ENOENT" });
      assert.equal(await readFile(config.pausedPath, "utf8"), "Test keeps bridge paused\n");
    }
    if (startupFailure === "invalid-config") await assert.rejects(access(env.BRIDGE_DATA_DIR), { code: "ENOENT" });
    return;
  }
  const initialized = await request("中文握手", "initialize", initializeParams);
  assert.equal(initialized.serverInfo.version, "0.2.5");
  assert.equal(initialized.protocolVersion, "2025-06-18");
  assert.deepEqual(await request("中文往返-引号\"-反斜杠\\", "ping"), {});
  const tools = await request("工具清单", "tools/list");
  assert.equal(tools.tools.length, 4);
  assert.match(tools.tools.find((tool) => tool.name === "bridge_generate_image").description, /图片/);
  if (killWrapper) {
    await waitUntil(async () => {
      const status = await request("后台自动启动", "tools/call", { name: "bridge_status", arguments: {} });
      assert.notEqual(status.isError, true, JSON.stringify(status));
      return JSON.parse(status.content[0].text).ready;
    }, 30000);
    bridgeIdentity = JSON.parse(await readFile(config.pidPath, "utf8"));
  } else if (startupFailure === "missing-core") {
    await waitUntil(async () => {
      const status = await request("核心缺失", "tools/call", { name: "bridge_status" });
      const failed = JSON.parse(status.content[0].text);
      assert.equal(failed.ready, false);
      return Boolean(failed.startupError);
    });
    assert.deepEqual(await request("失败后仍存活", "ping"), {});
  } else {
    const status = await request("保持主动暂停", "tools/call", { name: "bridge_status", arguments: {} });
    assert.notEqual(status.isError, true, JSON.stringify(status));
    const paused = JSON.parse(status.content[0].text);
    assert.equal(paused.ready, false);
    assert.equal(paused.autoRecoveryPaused, true);
    assert.equal(paused.startupError, undefined, "主动暂停不是初始化故障");
    const generated = await request("中文参数", "tools/call", {
      name: "bridge_generate_image", arguments: { prompt: "画一只红色小猫，招牌写\"你好\"。\n路径字符 C:\\隔离\\图片" },
    });
    assert.equal(generated.isError, true, "暂停代理必须拒绝实际图片请求");
    assert.match(generated.content[0].text, /未就绪/);
    assert.equal((await probeBridge(config)).state, "offline");
    await assert.rejects(access(config.pidPath), { code: "ENOENT" });
  }
  assert.doesNotMatch(JSON.stringify(responses) + errors, /launcher-test-secret-do-not-return/);
  assert.equal(buffer, "");
  assert.equal(harness?.harness, true);
  const descendants = await powerShellJson(`$rows=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${harness.powerShellPid}' | Select-Object ProcessId,ExecutablePath,CommandLine); ConvertTo-Json -InputObject $rows -Compress`);
  const server = descendants.find((process) => process.CommandLine?.includes(entry));
  assert.ok(server, "应观察到 PowerShell 创建实际 MCP 子进程");
  serverIdentity = await processIdentity(server.ProcessId);
  assert.ok(serverIdentity);
  if (noNodePath) {
    assert.ok(harness.electron, "测试祖先必须是实际 Qoder 的 Electron Node 模式");
    assert.equal(resolve(harness.runtime).toLowerCase(), resolve(runtime).toLowerCase());
    const encodedPath = Buffer.from(harness.path).toString("base64");
    const commands = await powerShellJson(`$env:Path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $found=@(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }); ConvertTo-Json -InputObject $found -Compress`);
    assert.deepEqual(commands, [], "内置运行时场景 PATH 中必须找不到 node.exe");
    assert.equal(resolve(server.ExecutablePath).toLowerCase(), resolve(runtime).toLowerCase(), "启动器必须复用祖先 Qoder.exe 而不是全局 node");
    t.diagnostic(`Node-mode ancestor ${harness.runtime}; Electron ${harness.electron}; server PID ${server.ProcessId}; PATH without node.exe`);
  }
  if (killWrapper) {
    const wrapperIdentity = await processIdentity(harness.powerShellPid);
    assert.equal(resolve(wrapperIdentity.executablePath).toLowerCase(), resolve(powerShell).toLowerCase());
    assert.ok(wrapperIdentity.commandLine.includes(launcher));
    await terminateCapturedProcess(wrapperIdentity);
    assert.equal(child.exitCode, null, "强杀包装器时测试宿主必须仍然活跃");
    assert.equal(child.stdin.writableEnded, false, "测试宿主 stdin 必须保持打开，不能借 EOF 清理");
    await waitUntil(async () => await processIdentity(serverIdentity.pid) === null && await processIdentity(bridgeIdentity.pid) === null);
    assert.equal((await probeBridge(config)).state, "offline");
    const encodedConfig = Buffer.from(config.configPath).toString("base64");
    const remaining = await powerShellJson(`$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedConfig}')); $ids=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($path) } | ForEach-Object { [int]$_.ProcessId }); ConvertTo-Json -InputObject $ids -Compress`);
    assert.deepEqual(remaining, [], "包装器退出后 supervisor 与代理均不能残留");
    assert.equal(child.exitCode, null, "验证清理完成前宿主未退出");
  }
  if (killWrapper) {
    const harnessIdentity = await processIdentity(child.pid);
    assert.ok(harnessIdentity.commandLine.includes(harnessPath));
    await terminateCapturedProcess(harnessIdentity);
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
  } else {
    child.stdin.end();
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal(child.exitCode, 0, errors);
    assert.equal(child.signalCode, null);
  }
  if (startupFailure === "missing-core") assert.match(errors, /BRIDGE_BIN 不存在或没有执行权限/);
  else assert.equal(errors.trim().split("\n").length, 1, "stderr 除测试harness元信息外不得有启动器或协议错误");
  assert.equal(buffer, "");
  if (!killWrapper && startupFailure !== "missing-core") {
    assert.equal(await readFile(config.pausedPath, "utf8"), "Test keeps bridge paused\n");
    await assert.rejects(access(config.pidPath), { code: "ENOENT" });
    await assert.rejects(access(config.configPath), { code: "ENOENT" });
  }
}

test("真实 PowerShell 启动器在持久暂停下透传中文 JSON-RPC、工具参数与 EOF，不执行核心", { skip: windowsOnly, timeout: 45000 }, async (t) => {
  await launcherSession(t, process.execPath);
});

for (const startupFailure of ["invalid-config", "missing-core", "missing-paused"]) {
  test(`真实 PowerShell 启动器 ${startupFailure} 区分配置连接失败和后台核心故障，不泄露密钥`, { skip: windowsOnly, timeout: 45000 }, async (t) => {
    await launcherSession(t, process.execPath, { startupFailure });
  });
}

test("父宿主 stdin 保持打开时强杀 PowerShell 包装器，Job 回收 MCP、代理与 supervisor", { skip: nativeWindowsOnly, timeout: 60000 }, async (t) => {
  await launcherSession(t, process.execPath, { killWrapper: true });
});

test("无全局 node 时从实际 Qoder 或 Qoder CN 祖先选择内置运行时，仅启动 Node 模式", { skip: windowsOnly, timeout: 45000 }, async (t) => {
  const runtime = process.env.QODER_TEST_RUNTIME;
  if (!runtime) { t.skip("未设置 QODER_TEST_RUNTIME，不能验证实际 Qoder 内置运行时"); return; }
  await access(runtime);
  await launcherSession(t, runtime, { noNodePath: true });
});

test("宿主退出但 stdin 保持打开时，原生句柄回收 MCP 与全部后代", { skip: windowsOnly, timeout: 45000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qoder-owner-job-中文 空格-"));
  const stub = join(directory, "owned.mjs");
  await writeFile(stub, `import {spawn} from 'node:child_process';
setInterval(()=>{},1000);
if(process.argv[2] !== 'child') {
  const child=spawn(process.execPath,[import.meta.filename,'child'],{stdio:'ignore',windowsHide:true});
  process.stdout.write(JSON.stringify({pid:process.pid,descendant:child.pid})+'\\n');
}
`);
  const owner = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(join(root, "scripts", "ProxyJob.cs"))}; exit ([Qoder.SubscriptionProxy.ProxyJob]::RunMcp('${owner.pid}', ${quote(process.execPath)}, ${quote(stub)}))`;
  const wrapper = spawn(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let errors = "";
  let identity;
  let descendant;
  wrapper.stdout.on("data", chunk => { output += chunk; });
  wrapper.stderr.on("data", chunk => { errors += chunk; });
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill();
    await waitUntil(() => wrapper.exitCode !== null || wrapper.signalCode !== null);
    await terminateCapturedProcess(identity);
    await terminateCapturedProcess(descendant);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const started = await waitUntil(() => {
    assert.equal(wrapper.exitCode, null, errors);
    return output.includes("\n") ? JSON.parse(output.trim()) : null;
  });
  identity = await processIdentity(started.pid);
  descendant = await processIdentity(started.descendant);
  assert.ok(identity && descendant);
  assert.equal(wrapper.stdin.writableEnded, false);
  owner.kill();
  await waitUntil(() => wrapper.exitCode !== null || wrapper.signalCode !== null);
  assert.equal(wrapper.exitCode, 0, errors);
  assert.equal(wrapper.stdin.writableEnded, false, "未通过 stdin EOF 触发清理");
  await waitUntil(async () => await processIdentity(identity.pid) === null && await processIdentity(descendant.pid) === null);
});
