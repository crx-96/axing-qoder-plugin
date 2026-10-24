import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { deflateRawSync, gzipSync } from "node:zlib";
import test from "node:test";
import { createCoreRuntime, ensureCore, getCoreRelease, getCoreStatus, resolveCoreBinaryPath } from "../bridge/core-runtime.mjs";

const manifest = JSON.parse(await readFile(new URL("../bridge/bin/platforms.json", import.meta.url), "utf8"));
const moduleUrl = new URL("../bridge/core-runtime.mjs", import.meta.url).href;
const binary = Buffer.from("synthetic core bytes; never executed\n".repeat(17));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function tarEntry(name, data = Buffer.alloc(0), { type = "0", linkName = "", prefix = "" } = {}) {
  const content = Buffer.from(data);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  header.write("0000755\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

function tarArchive(entries = [{ name: "cli-proxy-api", data: binary }]) {
  return gzipSync(Buffer.concat([...entries.map(({ name, data, ...options }) => tarEntry(name, data, options)), Buffer.alloc(1024)]));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries = [{ name: "cli-proxy-api.exe", data: binary }]) {
  const locals = [];
  const directory = [];
  let position = 0;
  for (const { name, data = Buffer.alloc(0), localName = name, mode = 0o100755, method = 8, descriptor = true, extra = Buffer.alloc(0) } of entries) {
    const content = Buffer.from(data);
    const packed = method === 8 ? deflateRawSync(content) : content;
    const nameBytes = Buffer.from(name);
    const localNameBytes = Buffer.from(localName);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(descriptor ? 8 : 0, 6);
    local.writeUInt16LE(method, 8);
    if (!descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(packed.length, 18);
      local.writeUInt32LE(content.length, 22);
    }
    local.writeUInt16LE(localNameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const footer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      footer.writeUInt32LE(0x08074b50, 0);
      footer.writeUInt32LE(crc, 4);
      footer.writeUInt32LE(packed.length, 8);
      footer.writeUInt32LE(content.length, 12);
    }
    const localRecord = Buffer.concat([local, localNameBytes, extra, packed, footer]);
    locals.push(localRecord);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(descriptor ? 8 : 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(position, 42);
    directory.push(Buffer.concat([central, nameBytes, extra]));
    position += localRecord.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(position, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}

async function fixture(t, { platform = "linux", arch = "x64", archive, expectedBinary = binary, download, spawnProcess, env } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qoder-core-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const bytes = archive ?? (platform === "win32" ? zipArchive() : tarArchive());
  const catalog = structuredClone(manifest);
  const entry = catalog.platforms[`${platform}-${arch}`];
  entry.archiveSha256 = hash(bytes);
  entry.binarySha256 = hash(expectedBinary);
  let calls = 0;
  const runtime = createCoreRuntime({
    manifest: catalog,
    ...(spawnProcess ? { spawnProcess, env } : { download: async (options) => {
      calls++;
      if (download) return download(options, bytes);
      await writeFile(options.destination, bytes, { flag: "wx" });
    } }),
  });
  const config = {
    dataDir: root,
    core: runtime.getCoreRelease({ platform, arch }),
    binPath: runtime.resolveCoreBinaryPath({ dataDir: root, platform, arch }),
  };
  return { runtime, config, root, archive: bytes, catalog, calls: () => calls };
}

async function assertClean(config) {
  const files = await readdir(dirname(config.binPath));
  assert.equal(files.some((name) => name.startsWith(".core-download-")), false, files.join(","));
}

function expectSafeError(code) {
  return (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, error.safeMessage);
    assert.doesNotMatch(error.message, /https?:\/\/|secret|password|token|stack|fixture/i);
    assert.equal(error.cause, undefined);
    return true;
  };
}

test("固定发行清单、五种平台选择和目标文件名一致，状态不创建目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qoder-core-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    const [platform, arch] = key.split("-");
    const core = getCoreRelease({ platform, arch });
    assert.deepEqual(core, { ...entry, version: manifest.version, key, platform, arch });
    assert.equal(Object.isFrozen(core), true);
    const binPath = resolveCoreBinaryPath({ dataDir: root, platform, arch });
    assert.equal(binPath, join(root, "runtimes", "v8.0.38", key, basename(entry.path)));
    const config = { core, dataDir: root, binPath };
    assert.deepEqual(await getCoreStatus(config), {
      state: "missing", version: manifest.version, platform: key, reason: "核心尚未下载；首次启动订阅桥时下载当前平台核心。",
    });
    assert.equal((await ensureCore(config, { allowDownload: false })).available, false);
  }
  assert.deepEqual(await readdir(root), []);
  assert.equal(getCoreRelease().key, `${process.platform}-${process.arch}`);
});

test("拒绝平台/架构错误、路径穿越和 BRIDGE_BIN 扩展支持", () => {
  for (const [platform, arch] of [["freebsd", "x64"], ["win32", "arm64"], ["linux", "ia32"], [null, "x64"], ["", "x64"], ["linux\0", "x64"], ["../linux", "x64"], ["linux", " arm64"], [[], "x64"]]) {
    assert.throws(() => getCoreRelease({ platform, arch }), /不支持的平台\/架构.*BRIDGE_BIN/);
  }
  for (const dataDir of ["", null, "a\0b"]) assert.throws(() => resolveCoreBinaryPath({ dataDir }), /配置无效/);
});

test("自定义 BRIDGE_BIN 不读文件、不下载、不 chmod，由生命周期验证", async (t) => {
  const { runtime, root, calls } = await fixture(t, { download() { throw new Error("must not download"); } });
  const custom = join(root, "custom");
  await writeFile(custom, "not an executable", { mode: 0o600 });
  const before = await lstat(custom);
  for (const core of [null, undefined]) {
    for (const binPath of [custom, join(root, "not-present")]) {
      const config = { binPath, dataDir: root, core };
      assert.equal((await runtime.getCoreStatus(config)).state, "custom");
      assert.equal((await runtime.ensureCore(config)).available, true);
    }
  }
  const after = await lstat(custom);
  assert.equal(before.mode, after.mode);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(calls(), 0);
});

for (const [platform, arch] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"]]) {
  test(`${platform}-${arch} 只下载当前平台、只提取官方核心且复用缓存`, async (t) => {
    const archive = platform === "win32"
      ? zipArchive([{ name: "LICENSE", data: "license" }, { name: "cli-proxy-api.exe", data: binary }, { name: "config.example.yaml", data: "never install" }])
      : tarArchive([{ name: "LICENSE", data: "license" }, { name: "cli-proxy-api", data: binary }, { name: "config.example.yaml", data: "never install" }]);
    let requested;
    const { runtime, config, calls } = await fixture(t, { platform, arch, archive, download: async (options, bytes) => {
      requested = options;
      await writeFile(options.destination, bytes, { flag: "wx" });
    } });
    assert.equal((await runtime.ensureCore(config)).state, "ready");
    assert.equal(requested.url, manifest.platforms[`${platform}-${arch}`].url);
    assert.ok(requested.maxBytes <= 128 * 1024 * 1024);
    assert.deepEqual(await readFile(config.binPath), binary);
    assert.deepEqual(await readdir(dirname(config.binPath)), [basename(config.binPath)]);
    const stamp = await lstat(config.binPath);
    for (let index = 0; index < 4; index++) {
      assert.equal((await runtime.getCoreStatus(config)).state, "ready");
      assert.equal((await runtime.ensureCore(config, { allowDownload: false })).available, true);
    }
    assert.equal(calls(), 1);
    assert.equal((await lstat(config.binPath)).mtimeMs, stamp.mtimeMs);
    if (process.platform !== "win32" && platform !== "win32") assert.equal(stamp.mode & 0o777, 0o755);
  });
}

test("归档 hash 错误不发布；allowDownload=false 不重试也不抛恢复异常", async (t) => {
  const { runtime, config, calls } = await fixture(t, { download: (options) => writeFile(options.destination, "wrong", { flag: "wx" }) });
  await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_ARCHIVE_HASH"));
  assert.equal((await runtime.getCoreStatus(config)).state, "error");
  for (let index = 0; index < 3; index++) assert.equal((await runtime.ensureCore(config, { allowDownload: false })).available, false);
  assert.equal(calls(), 1);
  await assert.rejects(lstat(config.binPath), { code: "ENOENT" });
  await assertClean(config);
});

test("解压后的 binary hash 错误不发布", async (t) => {
  const { runtime, config } = await fixture(t, { expectedBinary: Buffer.from("different binary") });
  await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_BINARY_HASH"));
  await assert.rejects(lstat(config.binPath), { code: "ENOENT" });
  await assertClean(config);
});

test("stat 改变使旧 hash 缓存失效，损坏缓存可原子替换", async (t) => {
  const { runtime, config, calls } = await fixture(t);
  await runtime.ensureCore(config);
  await writeFile(config.binPath, Buffer.alloc(binary.length, 65));
  assert.equal((await runtime.getCoreStatus(config)).state, "invalid");
  assert.equal((await runtime.ensureCore(config, { allowDownload: false })).available, false);
  assert.equal(calls(), 1);
  assert.equal((await runtime.ensureCore(config)).available, true);
  assert.equal(calls(), 2);
  assert.deepEqual(await readFile(config.binPath), binary);
  await assertClean(config);
});

test("下载失败保留既有损坏缓存，错误不透传路径/代理/响应正文", async (t) => {
  const { runtime, config } = await fixture(t, { download() { throw new Error("https://secret:password@example.invalid/?token=secret response body fixture"); } });
  await mkdir(dirname(config.binPath), { recursive: true });
  await writeFile(config.binPath, "old corrupt data");
  await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_DOWNLOAD"));
  assert.equal(await readFile(config.binPath, "utf8"), "old corrupt data");
  await assertClean(config);
});

test("并发调用只执行一次下载，状态显示 downloading，完成后复用结果", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { runtime, config, calls } = await fixture(t, { download: async (options, bytes) => {
    started.resolve();
    await release.promise;
    await writeFile(options.destination, bytes, { flag: "wx" });
  } });
  const attempts = Array.from({ length: 8 }, () => runtime.ensureCore(config));
  await started.promise;
  assert.equal((await runtime.getCoreStatus(config)).state, "downloading");
  assert.deepEqual(await runtime.ensureCore(config, { allowDownload: false }), { available: false, state: "downloading", reason: "正在准备当前平台核心，请稍候。" });
  release.resolve();
  assert.equal((await Promise.all(attempts)).every((result) => result.available), true);
  assert.equal(calls(), 1);
  await assertClean(config);
});

test("并发失败共享一次尝试，不重试下载", async (t) => {
  const { runtime, config, calls } = await fixture(t, { download: async () => { await delay(40); throw new Error("secret"); } });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => runtime.ensureCore(config)));
  assert.equal(results.every((result) => result.status === "rejected" && result.reason.code === "CORE_DOWNLOAD"), true);
  assert.equal(calls(), 1);
  await assertClean(config);
});

test("预先取消不下载、不创建 runtime 目录", async (t) => {
  const { runtime, config, root, calls } = await fixture(t);
  const controller = new AbortController();
  controller.abort("secret cancellation reason");
  await assert.rejects(runtime.ensureCore(config, { signal: controller.signal }), expectSafeError("CORE_CANCELLED"));
  assert.deepEqual(await readdir(root), []);
  assert.equal(calls(), 0);
});

test("最后一个调用者取消会终止下载并清理；后续显式调用可重新开始", async (t) => {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  let first = true;
  const { runtime, config, calls } = await fixture(t, { download: async (options, bytes) => {
    if (first) {
      first = false;
      await writeFile(options.destination, "partial", { flag: "wx" });
      started.resolve();
      await new Promise((resolveAbort) => options.signal.addEventListener("abort", resolveAbort, { once: true }));
      stopped.resolve();
      throw new Error("secret abort body");
    }
    await writeFile(options.destination, bytes, { flag: "wx" });
  } });
  const controller = new AbortController();
  const attempt = runtime.ensureCore(config, { signal: controller.signal });
  await started.promise;
  controller.abort("secret");
  await assert.rejects(attempt, expectSafeError("CORE_CANCELLED"));
  await stopped.promise;
  for (let count = 0; count < 100 && (await runtime.getCoreStatus(config)).state === "downloading"; count++) await delay(5);
  await assertClean(config);
  await assert.rejects(lstat(config.binPath), { code: "ENOENT" });
  assert.equal((await runtime.ensureCore(config)).available, true);
  assert.equal(calls(), 2);
});

test("一个并发等待者取消不影响另一个等待者", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let downloadSignal;
  const { runtime, config, calls } = await fixture(t, { download: async (options, bytes) => {
    downloadSignal = options.signal;
    started.resolve();
    await release.promise;
    await writeFile(options.destination, bytes, { flag: "wx" });
  } });
  const controller = new AbortController();
  const cancelled = runtime.ensureCore(config, { signal: controller.signal });
  await started.promise;
  const surviving = runtime.ensureCore(config);
  controller.abort();
  await assert.rejects(cancelled, expectSafeError("CORE_CANCELLED"));
  assert.equal(downloadSignal.aborted, false);
  release.resolve();
  assert.equal((await surviving).available, true);
  assert.equal(calls(), 1);
});

const unsafeTarCases = [
  ["父目录路径", [{ name: "../escape", data: "x" }]],
  ["绝对路径", [{ name: "/escape", data: "x" }]],
  ["Windows 盘符", [{ name: "C:/escape", data: "x" }]],
  ["反斜杠穿越", [{ name: "..\\escape", data: "x" }]],
  ["符号链接", [{ name: "alias", type: "2", linkName: "cli-proxy-api" }]],
  ["硬链接", [{ name: "alias", type: "1", linkName: "cli-proxy-api" }]],
  ["特殊设备", [{ name: "device", type: "3" }]],
  ["重复目标", [{ name: "cli-proxy-api", data: binary }]],
  ["PAX 路径覆盖", [{ name: "PaxHeaders/core", type: "x", data: "18 path=../escape\n" }]],
  ["前缀路径穿越", [{ name: "escape", prefix: "..", data: "x" }]],
];
for (const [label, extras] of unsafeTarCases) {
  test(`tar 拒绝${label}，归档摘要正确也不能绕过`, async (t) => {
    const { runtime, config } = await fixture(t, { archive: tarArchive([{ name: "cli-proxy-api", data: binary }, ...extras]) });
    await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_ARCHIVE"));
    await assertClean(config);
  });
}

test("tar 必须有唯一根级官方名称，不按 basename 或可执行权限猜测", async (t) => {
  const { runtime, config } = await fixture(t, { archive: tarArchive([{ name: "nested/cli-proxy-api", data: binary }]) });
  await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_ARCHIVE"));
});

test("tar 接受无路径语义的 PAX 时间戳与普通安全目录", async (t) => {
  const { runtime, config } = await fixture(t, { archive: tarArchive([
    { name: "docs/", type: "5" }, { name: "PaxHeaders/core", type: "x", data: "11 mtime=0\n" }, { name: "cli-proxy-api", data: binary },
  ]) });
  assert.equal((await runtime.ensureCore(config)).available, true);
  await assertClean(config);
});

const unsafeZipCases = [
  ["父目录路径", { name: "../escape", data: "x" }],
  ["绝对路径", { name: "/escape", data: "x" }],
  ["替代数据流", { name: "file:stream", data: "x" }],
  ["符号链接", { name: "alias", data: "cli-proxy-api.exe", mode: 0o120777 }],
  ["特殊文件", { name: "device", mode: 0o020600 }],
  ["本地头名称不一致", { name: "safe.txt", localName: "evil.txt", data: "x" }],
  ["重复核心", { name: "cli-proxy-api.exe", data: binary }],
  ["未知扩展", { name: "safe.txt", data: "x", extra: Buffer.from([0x6e, 0x75, 0, 0]) }],
];
for (const [label, extra] of unsafeZipCases) {
  test(`zip 拒绝${label}，不提取任何成员`, async (t) => {
    const { runtime, config } = await fixture(t, { platform: "win32", archive: zipArchive([{ name: "cli-proxy-api.exe", data: binary }, extra]) });
    await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_ARCHIVE"));
    await assertClean(config);
  });
}

test("zip 同时支持 store 与 deflate、数据描述符与精确尺寸本地头", async (t) => {
  for (const method of [0, 8]) {
    const { runtime, config } = await fixture(t, { platform: "win32", archive: zipArchive([{ name: "cli-proxy-api.exe", data: binary, method, descriptor: false }]) });
    assert.equal((await runtime.ensureCore(config)).available, true);
  }
});

test("错误/截断归档只返回安全错误", async (t) => {
  for (const [platform, archive] of [["win32", Buffer.from("bad zip")], ["linux", Buffer.from("bad gzip")], ["linux", gzipSync(Buffer.alloc(512))]]) {
    const { runtime, config } = await fixture(t, { platform, archive });
    await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_ARCHIVE"));
    await assertClean(config);
  }
});

test("默认缓存若为目录、硬链接则拒绝，损坏对象不盲删", async (t) => {
  const directory = await fixture(t);
  await mkdir(directory.config.binPath, { recursive: true });
  assert.equal((await directory.runtime.ensureCore(directory.config, { allowDownload: false })).available, false);
  await assert.rejects(directory.runtime.ensureCore(directory.config), expectSafeError("CORE_PATH"));
  assert.equal((await lstat(directory.config.binPath)).isDirectory(), true);
  assert.equal(directory.calls(), 0);
  const linked = await fixture(t);
  const outside = join(linked.root, "original");
  await writeFile(outside, binary);
  await mkdir(dirname(linked.config.binPath), { recursive: true });
  await link(outside, linked.config.binPath);
  await assert.rejects(linked.runtime.ensureCore(linked.config), expectSafeError("CORE_PATH"));
  assert.deepEqual(await readFile(outside), binary);
  assert.equal(linked.calls(), 0);
});

test("runtime 父目录链接或 junction 不可绕过缓存归属", async (t) => {
  const { runtime, config, root, calls } = await fixture(t);
  const target = join(root, "elsewhere");
  await mkdir(target);
  await symlink(target, join(root, "runtimes"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await runtime.ensureCore(config, { allowDownload: false })).available, false);
  await assert.rejects(runtime.ensureCore(config), expectSafeError("CORE_PATH"));
  assert.deepEqual(await readdir(target), []);
  assert.equal(calls(), 0);
});

test("配置不能修改官方 URL/摘要，也不能把默认缓存写到插件目录", async (t) => {
  const { runtime, config, calls } = await fixture(t);
  for (const field of ["url", "binarySha256", "archiveSha256", "path", "version", "key"]) {
    await assert.rejects(runtime.ensureCore({ ...config, core: { ...config.core, [field]: "https://secret:password@example.invalid" } }), expectSafeError("CORE_CONFIG"));
  }
  // 使用模块 URL 的解码路径避免中文路径或 Windows 盘符影响归属判断。
  const { fileURLToPath } = await import("node:url");
  const pluginDir = fileURLToPath(new URL("../", import.meta.url));
  const inside = { ...config, dataDir: pluginDir, binPath: runtime.resolveCoreBinaryPath({ dataDir: pluginDir, platform: "linux", arch: "x64" }) };
  await assert.rejects(runtime.ensureCore(inside), expectSafeError("CORE_PATH"));
  assert.equal(calls(), 0);
});

function mockCurl(output, { exit = 0, failStart = false, hang = false } = {}) {
  const observed = [];
  const implementation = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => {
      observed.at(-1).killed = true;
      child.stdout.destroy();
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    observed.push({ command, args, options, killed: false });
    queueMicrotask(() => {
      if (failStart) {
        child.emit("error", new Error("secret curl startup error"));
        child.stdout.destroy();
        child.emit("close", null);
      } else if (hang) child.stdout.write("partial");
      else {
        child.stdout.end(output);
        queueMicrotask(() => child.emit("close", exit));
      }
    });
    return child;
  };
  return { implementation, observed };
}

test("系统 curl 固定 HTTPS、禁用 curlrc/shell/retry；代理优先级正确且不出现在命令参数", async (t) => {
  const archive = tarArchive();
  const fake = mockCurl(archive);
  const env = { SystemRoot: "C:\\Windows", QODER_HTTP_PROXY: "http://secret:password@127.0.0.1:1234", HTTPS_PROXY: "https://other.invalid", https_proxy: "https://lower.invalid", NO_PROXY: "127.0.0.1,localhost" };
  const { runtime, config } = await fixture(t, { archive, spawnProcess: fake.implementation, env });
  assert.equal((await runtime.ensureCore(config)).available, true);
  assert.equal(fake.observed.length, 1);
  const { command, args, options } = fake.observed[0];
  assert.equal(command, process.platform === "win32" ? win32.join("C:\\Windows", "System32", "curl.exe") : "curl");
  assert.equal(args[0], "--disable");
  assert.equal(args[args.indexOf("--proto") + 1], "=https");
  assert.equal(args[args.indexOf("--proto-redir") + 1], "=https");
  assert.equal(args[args.indexOf("--connect-timeout") + 1], "60");
  assert.equal(args[args.indexOf("--max-time") + 1], "540");
  assert.equal(args[args.indexOf("--retry") + 1], "0");
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
  assert.equal(options.env.https_proxy, env.QODER_HTTP_PROXY);
  assert.equal(options.env.HTTPS_PROXY, env.QODER_HTTP_PROXY);
  assert.equal(options.env.no_proxy, env.NO_PROXY);
  assert.equal(env.https_proxy, "https://lower.invalid");
  assert.doesNotMatch(args.join(" "), /password|secret|other.invalid/);
});

test("curl 启动和 HTTP 失败安全报告且不重试", async (t) => {
  for (const [settings, code] of [[{ failStart: true }, "CORE_CURL"], [{ exit: 22 }, "CORE_DOWNLOAD"]]) {
    const fake = mockCurl(Buffer.from("secret response body"), settings);
    const { runtime, config } = await fixture(t, { spawnProcess: fake.implementation });
    await assert.rejects(runtime.ensureCore(config), expectSafeError(code));
    assert.equal(fake.observed.length, 1);
    await assertClean(config);
  }
});

test("curl 取消终止本次子进程，清理部分归档", async (t) => {
  const fake = mockCurl(null, { hang: true });
  const { runtime, config } = await fixture(t, { spawnProcess: fake.implementation });
  const controller = new AbortController();
  const attempt = runtime.ensureCore(config, { signal: controller.signal });
  for (let count = 0; count < 100 && !fake.observed.length; count++) await delay(5);
  assert.equal(fake.observed.length, 1);
  controller.abort();
  await assert.rejects(attempt, expectSafeError("CORE_CANCELLED"));
  for (let count = 0; count < 100 && (await runtime.getCoreStatus(config)).state === "downloading"; count++) await delay(5);
  assert.equal(fake.observed[0].killed, true);
  await assertClean(config);
});

async function childRuntime(fixtureValue, mode = "ok") {
  const { catalog, config, archive } = fixtureValue;
  const script = `
    import { writeFile } from 'node:fs/promises';
    import { createCoreRuntime } from ${JSON.stringify(moduleUrl)};
    const runtime = createCoreRuntime({manifest: ${JSON.stringify(catalog)}, download: async ({destination,signal}) => {
      process.send({type:'downloading'});
      await new Promise(resolve => process.once('message', resolve));
      if (${JSON.stringify(mode)} === 'fail') throw new Error('secret provider body');
      await writeFile(destination, Buffer.from(${JSON.stringify(archive.toString("base64"))}, 'base64'), {flag:'wx'});
    }});
    try { await runtime.ensureCore(${JSON.stringify(config)}); process.send({type:'done'}); }
    catch (error) { process.send({type:'error',code:error.code}); }
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  const exited = once(child, "exit");
  const started = await Promise.race([once(child, "message").then(([message]) => message), exited.then(() => { throw new Error(stderr || "child exited early"); })]);
  assert.equal(started.type, "downloading");
  return { child, messages, exited };
}

test("不同进程共享 OS 锁和下载结果，不触碰 bridge.lock", async (t) => {
  const value = await fixture(t);
  const running = await childRuntime(value);
  t.after(() => { if (running.child.exitCode === null) running.child.kill(); });
  await writeFile(join(value.root, "bridge.lock"), "unrelated lifecycle lock");
  const follower = value.runtime.ensureCore(value.config);
  await delay(80);
  assert.equal(value.calls(), 0);
  assert.equal((await value.runtime.getCoreStatus(value.config)).state, "downloading");
  running.child.send("continue");
  assert.equal((await follower).available, true);
  assert.equal((await running.exited)[0], 0);
  assert.equal(value.calls(), 0);
  assert.equal(await readFile(join(value.root, "bridge.lock"), "utf8"), "unrelated lifecycle lock");
  await assertClean(value.config);
});

test("跨进程失败由等待者共享，不再下载重试", async (t) => {
  const value = await fixture(t);
  const running = await childRuntime(value, "fail");
  t.after(() => { if (running.child.exitCode === null) running.child.kill(); });
  const follower = value.runtime.ensureCore(value.config);
  await delay(80);
  running.child.send("continue");
  await assert.rejects(follower, expectSafeError("CORE_DOWNLOAD"));
  await running.exited;
  assert.equal(value.calls(), 0);
  await assertClean(value.config);
});

test("持锁进程退出后 OS 释放独占锁，新显式尝试可下载", async (t) => {
  const value = await fixture(t);
  const running = await childRuntime(value);
  running.child.kill();
  await running.exited;
  assert.equal((await value.runtime.ensureCore(value.config)).available, true);
  assert.equal(value.calls(), 1);
  // 崩溃进程的私有临时目录不能盲删；其锁已由 OS 释放，不阻碍恢复。
  const leftovers = (await readdir(dirname(value.config.binPath))).filter((name) => name.startsWith(".core-download-"));
  assert.equal(leftovers.length, 1);
  assert.deepEqual(await readFile(value.config.binPath), binary);
});

function lockAddress(config) {
  const keyPath = process.platform === "win32" ? resolve(config.binPath).toLowerCase() : resolve(config.binPath);
  const key = hash(keyPath);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\qoder-core-download-${key}`
    : { host: "127.0.0.1", port: 20_000 + Number.parseInt(key.slice(0, 8), 16) % 40_000, exclusive: true };
}

test("等待者尚未发送握手时下载完成，身份帧仍先于最终结果", async (t) => {
  const value = await fixture(t);
  const running = await childRuntime(value);
  t.after(() => { if (running.child.exitCode === null) running.child.kill(); });
  const socket = createConnection(lockAddress(value.config));
  t.after(() => socket.destroy());
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { received += chunk; });
  const closed = once(socket, "close");
  await once(socket, "connect");
  running.child.send("continue");
  await closed;
  assert.equal((await running.exited)[0], 0);
  const messages = received.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.state), ["downloading", "ready"]);
  assert.equal(messages[0].key, messages[1].key);
  assert.equal((await value.runtime.ensureCore(value.config)).available, true);
  assert.equal(value.calls(), 0);
});

test("下载锁地址碰撞时明确报错，不绕过并发保护或使用生命周期锁", async (t) => {
  const value = await fixture(t);
  const server = createServer((socket) => {
    socket.on("data", () => {});
    socket.end("not the core downloader\n");
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(lockAddress(value.config), resolveListen); });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  await assert.rejects(value.runtime.ensureCore(value.config), expectSafeError("CORE_LOCK"));
  assert.equal(value.calls(), 0);
});
