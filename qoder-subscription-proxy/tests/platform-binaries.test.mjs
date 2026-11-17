import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getCoreRelease, resolveCoreBinaryPath } from "../server/core-runtime.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binRoot = join(pluginRoot, "server", "bin");
const metadata = JSON.parse(await readFile(join(binRoot, "platforms.json"), "utf-8"));
const expected = {
  "win32-x64": { path: "magpie.exe", archive: "magpie-cli-windows-amd64.exe",
    sha256: "9b7b1dcd64413a13c75c162c53367fde312da9d2c0df3caffa616e7c1a4aa43c", size: 94537728 },
  "darwin-x64": { path: "darwin-x64/magpie", archive: "magpie-cli-darwin-amd64",
    sha256: "43d83512ac84bfbda41e4e1bf1b2d932d281d43c6a96e1a516b670e12e83080e", size: 93795184 },
  "darwin-arm64": { path: "darwin-arm64/magpie", archive: "magpie-cli-darwin-arm64",
    sha256: "2d77eeb55b9fe207e7a6b27efde2aeba264be9aad1bbcb5f8b997bb45eb9db7b", size: 87084802 },
  "linux-x64": { path: "linux-x64/magpie", archive: "magpie-cli-linux-amd64",
    sha256: "adb1fef9af35ee3b27d06960f41b124c04a2f1f116751e429344c595451a564f", size: 92315810 },
  "linux-arm64": { path: "linux-arm64/magpie", archive: "magpie-cli-linux-arm64",
    sha256: "07aa97614a1f9aa20d4d2acf1cbe261dae9c3de224f2ecb8d5fd5250dd719815", size: 85000354 },
};

test("分发清单固定 Magpie v0.1.4330 五平台，源码不携带二进制或旧 YAML", async () => {
  assert.equal(metadata.upstream, "yetone/magpie");
  assert.equal(metadata.version, "v0.1.4330");
  assert.deepEqual(Object.keys(metadata.platforms).sort(), Object.keys(expected).sort());
  const entries = await readdir(binRoot, { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(), [
    "LICENSE", "README.md", "README_CN.md", "platforms.json",
  ]);
  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    assert.deepEqual(await readdir(join(binRoot, entry.name)), [], "源码不得留下任何平台核心或归档");
  }
  assert.equal(entries.some((entry) => entry.isSymbolicLink()), false);
  assert.match(await readFile(join(binRoot, "LICENSE"), "utf8"), /Copyright \(c\) 2026 yetone/);
});

test("CI 仅准备当前 Magpie 核心，保留五平台测试且不引用旧 Rust 构建", async () => {
  for (const workflow of ["subscription-proxy-tests.yml", "release.yml"]) {
    const source = await readFile(join(pluginRoot, "..", ".github", "workflows", workflow), "utf8");
    assert.doesNotMatch(source, /rustup|cargo\s|approval-router|build-approval/);
    for (const runner of ["windows-latest", "ubuntu-24.04", "ubuntu-24.04-arm", "macos-15-intel", "macos-15"]) {
      assert.ok(source.includes(runner), `${workflow}: ${runner}`);
    }
    assert.match(source, /node --test --test-concurrency=1 qoder-subscription-proxy\/tests\/\*\.test\.mjs/);
    const scripts = [...source.matchAll(/\bnode (qoder-subscription-proxy\/scripts\/[\w-]+\.mjs)/g)];
    assert.ok(scripts.length > 0, workflow);
    for (const [, script] of scripts) {
      assert.equal((await lstat(join(pluginRoot, "..", script))).isFile(), true, script);
    }
    assert.match(source, workflow === "release.yml" ? /scripts\/fetch-core\.mjs/ : /scripts\/prepare-test-core\.mjs/);
  }
});

for (const [key, pinned] of Object.entries(expected)) {
  test(`${key} 原始资产、随包路径、缓存路径和双 SHA256 固定，离线检查不执行核心`, () => {
    const entry = metadata.platforms[key];
    const [platform, arch] = key.split("-");
    const release = getCoreRelease({ platform, arch });
    for (const field of ["path", "archive"]) {
      assert.equal(entry[field], pinned[field], `${key}.${field}`);
      assert.equal(release[field], pinned[field]);
    }
    for (const field of ["binarySha256", "archiveSha256"]) {
      assert.equal(entry[field], pinned.sha256, `${key}.${field}`);
      assert.equal(release[field], pinned.sha256);
    }
    assert.equal(entry.url, `https://github.com/yetone/magpie/releases/download/v0.1.4330/${pinned.archive}`);
    assert.equal(release.url, entry.url);
    assert.doesNotMatch(entry.archive, /\.(zip|gz)$/);
    assert.equal(new Set(Object.values(metadata.platforms).map((item) => item.path)).size, 5);
    const dataDir = join(tmpdir(), "isolated-platform-path-check");
    assert.equal(resolveCoreBinaryPath({ dataDir, platform, arch }),
      join(dataDir, "runtimes", "v0.1.4330", key, basename(pinned.path)));
    if (platform !== "win32") assert.equal(entry.mode, "0755");
  });
}

test("显式准备的 Magpie 核心摘要、大小与文件架构一致，校验不执行核心", { skip: nativeCoreSkip }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "subscription-core-architecture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pinned = expected[`${process.platform}-${process.arch}`];
  assert.ok(pinned);
  const path = await copyTestCore(join(directory, basename(pinned.path)));
  assert.equal((await lstat(path)).isFile(), true);
  const binary = await readFile(path);
  assert.equal(binary.length, pinned.size);
  assert.equal(createHash("sha256").update(binary).digest("hex"), pinned.sha256);
  if (process.platform === "win32") {
    assert.equal(binary.subarray(0, 2).toString("ascii"), "MZ");
    const peOffset = binary.readUInt32LE(0x3c);
    assert.equal(binary.readUInt32LE(peOffset), 0x00004550);
    assert.equal(binary.readUInt16LE(peOffset + 4), 0x8664);
  } else if (process.platform === "darwin") {
    assert.equal(binary.readUInt32LE(0), 0xfeedfacf);
    assert.equal(binary.readUInt32LE(4), process.arch === "x64" ? 0x01000007 : 0x0100000c);
  } else {
    assert.equal(binary.subarray(0, 4).toString("hex"), "7f454c46");
    assert.equal(binary[4], 2);
    assert.equal(binary[5], 1);
    assert.equal(binary.readUInt16LE(18), process.arch === "x64" ? 62 : 183);
  }
});
