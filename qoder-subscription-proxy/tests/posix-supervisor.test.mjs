import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CONTROL_MESSAGE_LIMIT, createPosixControlMessage, queryPosixSupervisor, spawnPosixSupervisor,
} from "../bridge/posix-supervisor.mjs";

const supervisorUrl = new URL("../scripts/proxy-supervisor.mjs", import.meta.url).href;
const unixOnly = process.platform === "win32" ? "Unix 信号处理与文件权限须在 macOS/Linux 验证" : false;

async function waitUntil(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw new Error("隔离 supervisor 测试等待超时");
}

function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("未收到 supervisor 公告")), 8000);
    function finish(error, value) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error); else resolve(value);
    }
    function onData(chunk) {
      buffer += chunk.toString();
      if (buffer.includes("\n")) {
        try { finish(null, JSON.parse(buffer.split("\n", 1)[0])); }
        catch (error) { finish(error); }
      }
    }
    function onExit() { finish(new Error("supervisor 在公告前退出")); }
    function onError(error) { finish(error); }
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function closeLease(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
}

async function fixture(t, { ignoreTerm = false, owner = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "posix-supervisor-中文 空格-")));
  const dataDir = join(directory, "数据 data");
  const panelDirectory = join(directory, "受控 panel");
  await mkdir(dataDir);
  await mkdir(panelDirectory);
  const config = { binPath: join(directory, "模拟 核心.mjs"), configPath: join(dataDir, "配置 config.yaml"), dataDir };
  const observedPath = join(dataDir, "fake-observed.json");
  const trigger = join(dataDir, "fake-exit.trigger");
  await writeFile(config.configPath, "isolated fake configuration; no credentials\n");
  await writeFile(config.binPath, `
    import { writeFileSync, existsSync } from 'node:fs';
    writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
      pid:process.pid, cwd:process.cwd(), args:process.argv.slice(2),
      panel:process.env.MANAGEMENT_STATIC_PATH, electron:process.env.ELECTRON_RUN_AS_NODE
    }));
    console.log('fake-core stdout'); console.error('fake-core stderr');
    ${ignoreTerm ? "process.on('SIGTERM',()=>{});" : "process.on('SIGTERM',()=>{writeFileSync('term-seen','yes');process.exit(0)});"}
    setInterval(()=>{if(existsSync(${JSON.stringify(trigger)}))process.exit(0)},20);
  `);
  const runner = join(directory, "测试 supervisor.mjs");
  await writeFile(runner, `
    import {spawn} from 'node:child_process';
    import {runPosixSupervisor} from ${JSON.stringify(supervisorUrl)};
    const config=${JSON.stringify(config)};
    process.exitCode=await runPosixSupervisor(config,${JSON.stringify(panelDirectory)},{
      spawnChild:(bin,args,options)=>spawn(process.execPath,[bin,...args],options)
    });
  `);
  let target = runner;
  if (owner) {
    target = join(directory, "独立 owner.mjs");
    await writeFile(target, `
      import {spawn} from 'node:child_process';
      const supervisor=spawn(process.execPath,[${JSON.stringify(runner)}],{
        stdio:['pipe','pipe','pipe'],env:process.env,windowsHide:true
      });
      supervisor.stderr.pipe(process.stderr);
      let buffer='';
      supervisor.stdout.on('data',chunk=>{buffer+=chunk; if(buffer.includes('\\n')) {
        const identity=JSON.parse(buffer.split('\\n',1)[0]);
        process.stdout.write(JSON.stringify({...identity,supervisorPid:supervisor.pid})+'\\n');
        supervisor.stdout.removeAllListeners('data');
      }});
      process.stdin.resume();
      process.stdin.on('end',()=>supervisor.stdin.end());
      supervisor.on('exit',code=>process.exit(code??1));
    `);
  }
  const child = spawn(process.execPath, [target], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MANAGEMENT_STATIC_PATH: "must-be-overridden" },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.on("error", () => {});
  let identity;
  t.after(async () => {
    await closeLease(child);
    if (identity) {
      await waitUntil(() => exited(identity.pid));
      if (identity.supervisorPid) await waitUntil(() => exited(identity.supervisorPid));
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  identity = await firstLine(child);
  const record = { ...identity, binPath: config.binPath, configPath: config.configPath };
  await waitUntil(async () => {
    try { return JSON.parse(await readFile(observedPath, "utf8")); }
    catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return false; throw error; }
  });
  return { config, record, child, directory, panelDirectory, observedPath, trigger, stdout: () => stdout, stderr: () => stderr };
}

async function rawRequest(record, message) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: record.controlPort });
    let output = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw 控制请求超时")); }, 8000);
    socket.on("data", (chunk) => { output += chunk.toString(); });
    socket.once("connect", () => socket.write(message));
    socket.once("error", () => {});
    socket.once("close", () => { clearTimeout(timer); resolve(output); });
  });
}

async function fakeControl(t, response) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", (chunk) => { if (response) socket.end(response(chunk.toString())); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const config = { binPath: process.execPath, configPath: join(tmpdir(), "only-synthetic-config.yaml") };
  const record = {
    pid: process.pid, creationDate: randomUUID(), commandLine: JSON.stringify([config.binPath, "-config", config.configPath]),
    executablePath: config.binPath, controlToken: randomBytes(32).toString("hex"),
    controlPort: server.address().port, ...config,
  };
  return { server, record, config };
}

test("中文空格路径的身份协议、日志隔离、cwd、受控面板及 Electron 环境继承", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const identity = await queryPosixSupervisor(f.record, f.config);
  assert.equal(identity.pid, f.record.pid);
  assert.match(identity.creationDate, /^[0-9a-f-]{36}$/);
  assert.match(identity.controlToken, /^[0-9a-f]{64}$/);
  assert.equal(identity.commandLine, JSON.stringify([f.config.binPath, "-config", f.config.configPath]));
  const observed = JSON.parse(await readFile(f.observedPath, "utf8"));
  assert.equal(observed.cwd, f.config.dataDir);
  assert.deepEqual(observed.args, ["-config", f.config.configPath]);
  assert.equal(observed.panel, f.panelDirectory);
  assert.equal(observed.electron, "1");
  const log = await readFile(join(f.config.dataDir, "bridge.log"), "utf8");
  assert.match(log, /fake-core stdout/);
  assert.match(log, /fake-core stderr/);
  assert.ok(!log.includes(identity.controlToken));
  assert.ok(!log.includes(identity.commandLine));
  assert.equal(f.stdout().trim().split("\n").length, 1);
  assert.equal(f.stderr(), "");
  await closeLease(f.child);
  assert.equal(f.child.exitCode, 0);
  assert.equal(await queryPosixSupervisor(f.record, f.config), null);
});

test("错误 token、instance、pid、路径或命令不得停止持有核心", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  for (const changed of [
    { controlToken: "0".repeat(64) }, { creationDate: randomUUID() }, { pid: process.pid },
    { executablePath: process.execPath }, { commandLine: "not a command" },
    { binPath: process.execPath }, { configPath: join(tmpdir(), "wrong.yaml") },
  ]) {
    await assert.rejects(queryPosixSupervisor({ ...f.record, ...changed }, f.config, { stop: true }), { code: "BRIDGE_NOT_READY" });
    assert.equal((await queryPosixSupervisor(f.record, f.config)).pid, f.record.pid);
  }
  for (const changed of [
    { operation: "exec" }, { binPath: process.execPath }, { configPath: join(tmpdir(), "wrong.yaml") },
    { executablePath: process.execPath }, { commandLine: "wrong" }, { controlPort: 1 },
  ]) {
    const signed = createPosixControlMessage(f.record, f.config, {
      direction: "request", nonce: randomBytes(32).toString("hex"), operation: "stop",
    });
    const response = await rawRequest(f.record, JSON.stringify({ ...signed, ...changed }) + "\n");
    assert.deepEqual(JSON.parse(response), { error: "CONTROL_REJECTED" });
    assert.ok(!response.includes(f.record.controlToken));
  }
  assert.equal((await queryPosixSupervisor(f.record, f.config)).pid, f.record.pid);
});

test("停止只在实际 exit 后响应，status 为 null，重复停止幂等", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const stopped = await queryPosixSupervisor(f.record, f.config, { stop: true });
  assert.equal(stopped.stopped, true);
  assert.equal(exited(f.record.pid), true);
  assert.equal(await queryPosixSupervisor(f.record, f.config), null);
  assert.deepEqual(await queryPosixSupervisor(f.record, f.config, { stop: true }), stopped);
  await closeLease(f.child);
  assert.equal(await queryPosixSupervisor(f.record, f.config), null);
  assert.equal(await queryPosixSupervisor(f.record, f.config, { stop: true }), null);
});

test("owner stdin EOF 回收核心和 supervisor，未发布前 EOF 不遗留资源", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await closeLease(f.child);
  assert.equal(exited(f.record.pid), true);
  assert.equal(f.child.exitCode, 0);
  const child = spawnPosixSupervisor({ ...f.config, binPath: process.execPath }, f.panelDirectory);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end();
  await waitUntil(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0);
  assert.equal(output, "");
});

test("强杀独立 owner 后租约关闭，supervisor 回收 fake 核心并退出", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { owner: true });
  assert.equal(exited(f.record.pid), false);
  assert.equal(f.child.kill("SIGKILL"), true);
  await waitUntil(() => f.child.exitCode !== null || f.child.signalCode !== null);
  await waitUntil(() => exited(f.record.pid));
  await waitUntil(() => exited(f.record.supervisorPid));
  assert.equal(await queryPosixSupervisor(f.record, f.config), null);
});

test("核心自然退出可认证离线，supervisor 退出后的 stale 记录可恢复", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await writeFile(f.trigger, "exit the isolated child");
  await waitUntil(() => exited(f.record.pid));
  assert.equal(await queryPosixSupervisor(f.record, f.config), null);
  await closeLease(f.child);
  assert.equal(await queryPosixSupervisor(f.record, f.config), null);
});

test("同步 spawn 接口只传路径，缺失二进制启动失败不发布身份", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "posix-start-failure-中文 空格-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const config = { dataDir: directory, binPath: join(directory, "missing-executable"), configPath: join(directory, "not-read.yaml"), apiKey: "synthetic-do-not-pass" };
  const child = spawnPosixSupervisor(config, directory);
  t.after(() => closeLease(child));
  assert.equal(child.spawnfile, process.execPath);
  assert.deepEqual(child.spawnargs.slice(2), [config.binPath, config.configPath, directory, directory]);
  assert.ok(!child.spawnargs.join(" ").includes(config.apiKey));
  assert.ok(child.stdin.writable);
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  child.stdin.on("error", () => {});
  await waitUntil(() => child.exitCode !== null);
  assert.equal(child.exitCode, 1);
  assert.equal(output, "");
  assert.equal(errorOutput.trim(), "POSIX supervisor initialization failed.");
  assert.throws(() => spawnPosixSupervisor(config, undefined), { code: "BRIDGE_NOT_READY" });
});

test("拒绝连接但 PID 存活，或 EPERM 时不能假报离线", { timeout: 15000 }, async (t) => {
  const f = await fakeControl(t);
  await new Promise((resolve) => f.server.close(resolve));
  await assert.rejects(queryPosixSupervisor(f.record, f.config), { code: "BRIDGE_NOT_READY" });
  const originalKill = process.kill;
  const mocked = t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, f.record.pid);
    assert.equal(signal, 0);
    throw Object.assign(new Error("synthetic denied"), { code: "EPERM" });
  });
  await assert.rejects(queryPosixSupervisor(f.record, f.config), { code: "BRIDGE_NOT_READY" });
  mocked.mock.restore();
  assert.equal(process.kill, originalKill);
});

test("无效记录、非回环地址与非法端口在连接前拒绝", async (t) => {
  const f = await fakeControl(t);
  for (const changed of [
    { pid: 0 }, { pid: "123" }, { creationDate: "2026-10-22" }, { controlToken: "short" },
    { controlPort: 0 }, { controlPort: 65536 }, { controlPort: "1234" }, { controlPort: 1.5 },
    { controlHost: "example.com" }, { controlHost: "::1" },
    { binPath: undefined }, { configPath: "relative.yaml" }, { executablePath: "relative" },
  ]) await assert.rejects(queryPosixSupervisor({ ...f.record, ...changed }, f.config), { code: "BRIDGE_NOT_READY" });
  await assert.rejects(queryPosixSupervisor(f.record, f.config, { stop: "yes" }), { code: "BRIDGE_NOT_READY" });
});

test("客户端拒绝伪造响应、过大响应及没有完整响应的 EOF", async (t) => {
  for (const mutate of [
    (r) => ({ ...r, mac: "0".repeat(64) }),
    (r) => ({ ...r, creationDate: randomUUID() }),
    (r) => ({ ...r, pid: r.pid + 1 }),
    (r) => ({ ...r, configPath: join(tmpdir(), "different.yaml") }),
    (r) => ({ ...r, nonce: "0".repeat(64) }),
    (r) => ({ ...r, state: "stopped" }),
    (r) => ({ ...r, state: "unknown" }),
  ]) {
    let record;
    let config;
    const f = await fakeControl(t, (text) => {
      const request = JSON.parse(text);
      const signed = createPosixControlMessage(record, config, {
        direction: "response", nonce: request.nonce, operation: request.operation, state: "running",
      });
      return JSON.stringify(mutate(signed)) + "\n";
    });
    ({ record, config } = f);
    await assert.rejects(queryPosixSupervisor(record, config), { code: "BRIDGE_NOT_READY" });
  }
  for (const response of ["x".repeat(CONTROL_MESSAGE_LIMIT + 1), "", "{\"unfinished\":"] ) {
    const f = await fakeControl(t, () => response);
    await assert.rejects(queryPosixSupervisor(f.record, f.config), { code: "BRIDGE_NOT_READY" });
  }
});

test("复用端口的 echo 服务得不到 token，也不能伪造 running/stopped 或反射请求签名", async (t) => {
  for (const state of [undefined, "running", "stopped"]) {
    let received;
    const f = await fakeControl(t, (text) => {
      received = text;
      const request = JSON.parse(text);
      return JSON.stringify(state === undefined ? request : { ...request, direction: "response", state }) + "\n";
    });
    await assert.rejects(queryPosixSupervisor(f.record, f.config, { stop: state === "stopped" }), { code: "BRIDGE_NOT_READY" });
    assert.ok(!received.includes(f.record.controlToken));
    assert.equal(Object.hasOwn(JSON.parse(received), "controlToken"), false);
  }
});

test("认证控制响应不传明文 token，客户端仍得到本地完整身份", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const signed = createPosixControlMessage(f.record, f.config, {
    direction: "request", nonce: randomBytes(32).toString("hex"), operation: "status",
  });
  const response = await rawRequest(f.record, JSON.stringify(signed) + "\n");
  assert.ok(!response.includes(f.record.controlToken));
  assert.equal(Object.hasOwn(JSON.parse(response), "controlToken"), false);
  assert.equal((await queryPosixSupervisor(f.record, f.config)).controlToken, f.record.controlToken);
});

test("控制请求有字节上限、单帧约束和绝对短超时", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  assert.equal(await rawRequest(f.record, "中".repeat(3000)), "");
  const request = JSON.stringify(createPosixControlMessage(f.record, f.config, {
    direction: "request", nonce: randomBytes(32).toString("hex"), operation: "status",
  })) + "\n";
  assert.match(await rawRequest(f.record, request + request), /CONTROL_REJECTED/);
  const start = Date.now();
  assert.equal(await rawRequest(f.record, "{"), "");
  assert.ok(Date.now() - start < 5000);
  assert.equal((await queryPosixSupervisor(f.record, f.config)).pid, f.record.pid);
  const fake = await fakeControl(t);
  await assert.rejects(queryPosixSupervisor(fake.record, fake.config), /超时/);
});

test("Unix 真实 TERM 处理、五秒后 KILL 升级及 0600 日志", { skip: unixOnly, timeout: 20000 }, async (t) => {
  const graceful = await fixture(t);
  assert.equal((await stat(join(graceful.config.dataDir, "bridge.log"))).mode & 0o777, 0o600);
  await queryPosixSupervisor(graceful.record, graceful.config, { stop: true });
  assert.equal(await readFile(join(graceful.config.dataDir, "term-seen"), "utf8"), "yes");
  const stubborn = await fixture(t, { ignoreTerm: true });
  const start = Date.now();
  await queryPosixSupervisor(stubborn.record, stubborn.config, { stop: true });
  assert.ok(Date.now() - start >= 4900);
  assert.equal(exited(stubborn.record.pid), true);
});

test("Unix supervisor 捕获 TERM/INT/HUP 后先回收持有核心", { skip: unixOnly, timeout: 20000 }, async (t) => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const f = await fixture(t);
    assert.equal(f.child.kill(signal), true);
    await waitUntil(() => f.child.exitCode !== null || f.child.signalCode !== null);
    assert.equal(exited(f.record.pid), true);
    assert.equal(f.child.exitCode, 0);
  }
});
