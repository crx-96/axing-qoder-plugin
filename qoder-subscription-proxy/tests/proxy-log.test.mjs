import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const csc = join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const windowsOnly = process.platform !== "win32";
const secret = "synthetic-管理-key-0123456789";
const body = "普通中文🙂大日志内容\n".repeat(100000);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "proxy-log-中文-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runner = join(dir, "runner.exe");
  const core = join(dir, "core.exe");
  const config = join(dir, "config.json");
  const log = join(dir, "bridge.log");
  await writeFile(config, "{}");
  await writeFile(join(dir, "runner.cs"), `using System;
using System.Diagnostics;
using Qoder.SubscriptionProxy;
class Runner {
  static int Main(string[] a) {
    int loops = Int32.Parse(a[5]);
    int before = 0, after = 0;
    int result = 0;
    for (int i = 0; i < loops; i++) {
      result = ProxyJob.Run(a[0], a[1], a[2], a[3], a[4] == "-" ? null : a[4], 18787);
      GC.Collect(); GC.WaitForPendingFinalizers();
      using (Process current = Process.GetCurrentProcess()) after = current.HandleCount;
      if (i == 0) before = after;
    }
    Console.WriteLine("HANDLES=" + (after - before));
    return result;
  }
}`);
  await writeFile(join(dir, "core.cs"), `using System;
using System.IO;
using System.Text;
using System.Threading;
class Core {
  static void Put(Stream stream, string value) { byte[] b = Encoding.UTF8.GetBytes(value); stream.Write(b, 0, b.Length); stream.Flush(); }
  static void Main() {
    Thread.Sleep(150);
    Stream output = Console.OpenStandardOutput(), error = Console.OpenStandardError();
    string secret = Environment.GetEnvironmentVariable("MAGPIE_WEB_KEY") ?? "";
    if (Environment.GetEnvironmentVariable("PROXY_TEST_BOUNDARY") == "1") {
      Put(output, new String('a', 4090));
      Put(output, secret.Substring(0, 4000)); Thread.Sleep(50);
      Put(error, secret.Substring(4000) + "|" + secret + "尾");
      return;
    }
    Put(output, "开始\\n");
    if (secret.Length >= 2) {
      Thread.Sleep(50);
      Put(output, "🙂" + new String('z', secret.Length - 2)); Thread.Sleep(50);
      Put(output, "\\n");
    }
    for (int i = 1; i < secret.Length; i++) {
      Put(output, "stdout:"); Put(output, secret.Substring(0, i)); Thread.Sleep(25);
      Put(output, secret.Substring(i)); Put(error, "|stderr:" + secret + "\\n");
    }
    byte[] text = Encoding.UTF8.GetBytes("普通中文🙂大日志内容\\n");
    for (int i = 0; i < 100000; i++) output.Write(text, 0, text.Length);
    output.Flush();
    byte[] split = Encoding.UTF8.GetBytes("末尾中文🙂");
    for (int i = 0; i < split.Length; i++) { output.WriteByte(split[i]); output.Flush(); Thread.Sleep(15); }
    Put(error, "|tail:" + secret);
    if (Environment.GetEnvironmentVariable("PROXY_TEST_HOLD") == "1") {
      Put(output, "|ready:" + new String('x', 100));
      Thread.Sleep(60000);
    }
  }
}`);
  await exec(csc, ["/nologo", "/target:exe", "/platform:x64", `/out:${runner}`, join(root, "scripts", "ProxyJob.cs"), join(dir, "runner.cs")], { timeout: 30000, windowsHide: true });
  await exec(csc, ["/nologo", "/target:exe", "/platform:x64", "/codepage:65001", `/out:${core}`, join(dir, "core.cs")], { timeout: 30000, windowsHide: true });
  return { dir, runner, core, config, log };
}

async function run(f, { key = secret, bin = f.core, log = f.log, loops = 1, boundary = false, owner = process.pid, hold = false } = {}) {
  return exec(f.runner, [String(owner), bin, f.config, f.dir, log, String(loops)], {
    env: { ...process.env, MAGPIE_WEB_KEY: key, PROXY_TEST_BOUNDARY: boundary ? "1" : "0", PROXY_TEST_HOLD: hold ? "1" : "0" }, timeout: 20000, windowsHide: true, maxBuffer: 32768,
  });
}

function assertHandles(stdout) {
  const match = /HANDLES=(-?\d+)/.exec(stdout);
  assert.ok(match, "runner reports handle count");
  assert.ok(Number(match[1]) <= 4, `unexpected remaining handles: ${match[1]}`);
}

test("core日志在分块、UTF-8、stderr与EOF处脱敏且大日志无损", { skip: windowsOnly, timeout: 60000 }, async t => {
  const f = await fixture(t);
  await writeFile(f.log, "existing\n");
  const result = await run(f);
  const actual = await readFile(f.log, "utf8");
  const expected = "existing\n开始\n🙂" + "z".repeat(secret.length - 2) + "\n" + "stdout:[REDACTED]|stderr:[REDACTED]\n".repeat(secret.length - 1) + body + "末尾中文🙂|tail:[REDACTED]";
  assert.equal(actual.includes(secret), false);
  assert.equal(actual, expected);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^\{"pid":\d+\}/);
  assert.equal(result.stdout.includes(secret), false);
});

test("长于读取块的密钥跨stdout/stderr并在EOF完成脱敏", { skip: windowsOnly, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const key = "long-key-" + "0123456789".repeat(850);
  const result = await run(f, { key, boundary: true });
  assert.equal(await readFile(f.log, "utf8"), "a".repeat(4090) + "[REDACTED]|[REDACTED]尾");
  assert.equal(result.stderr, "");
});

test("无密钥保持普通输出；无LogPath使用NUL", { skip: windowsOnly, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const plain = await run(f, { key: "" });
  assert.equal(await readFile(f.log, "utf8"), "开始\n" + body + "末尾中文🙂|tail:");
  const nul = await run(f, { log: "-" });
  assert.equal(nul.stdout.includes(secret), false);
  assert.equal(nul.stderr, "");
});

test("重复成功调用在CLR初始化后不累积句柄且日志完整", { skip: windowsOnly, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const result = await run(f, { key: "", loops: 3 });
  assertHandles(result.stdout);
  assert.equal(result.stderr, "");
  assert.equal(await readFile(f.log, "utf8"), ("开始\n" + body + "末尾中文🙂|tail:").repeat(3));
});

test("owner退出终止核心并有界排空日志", { skip: windowsOnly, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const owner = spawn(process.execPath, ["-e", "process.stdin.resume()"], { windowsHide: true });
  t.after(() => owner.kill());
  const completion = run(f, { owner: owner.pid, hold: true });
  completion.catch(() => {});
  const deadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < deadline) {
    try { ready = (await readFile(f.log, "utf8")).includes("|ready:"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (ready) break;
    await delay(25);
  }
  assert.equal(ready, true);
  const start = Date.now();
  owner.stdin.end();
  const result = await completion;
  assert.ok(Date.now() - start < 8000, "cleanup must be bounded");
  assert.equal(result.stderr, "");
  const pid = JSON.parse(result.stdout.split(/\r?\n/)[0]).pid;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const actual = await readFile(f.log, "utf8");
  assert.equal(actual.includes(secret), false);
  assert.ok(actual.endsWith("|tail:[REDACTED]|ready:" + "x".repeat(100)));
});

test("CreateProcess失败后重复调用不泄漏日志句柄或worker", { skip: windowsOnly, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const invalid = join(f.dir, "invalid.exe");
  await writeFile(invalid, "not an executable");
  let failure;
  try { await run(f, { bin: invalid, loops: 20 }); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(failure.code, 1);
  assertHandles(failure.stdout);
  assert.equal(failure.stderr.includes(secret), false);
  assert.equal(await readFile(f.log, "utf8"), "");
});
