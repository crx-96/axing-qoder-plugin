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
    sha256: "b8f7ed6cfa6a5e161dfaf3776ce4f97d0c10d4cf35cc33d0be1d8cf35bf1163a", size: 97077760 },
  "darwin-x64": { path: "darwin-x64/magpie", archive: "magpie-cli-darwin-amd64",
    sha256: "24b075c72ae11aaeb772c19b30e33aab2bfb98bd29da167d6b24dd643f01a406", size: 96329648 },
  "darwin-arm64": { path: "darwin-arm64/magpie", archive: "magpie-cli-darwin-arm64",
    sha256: "3187ee06bb2fdd11d05c6624eda017ef567793bf4916c160086bf26df55dede4", size: 89408018 },
  "linux-x64": { path: "linux-x64/magpie", archive: "magpie-cli-linux-amd64",
    sha256: "6b233b7b74364bf0205687ebc186adb223f2403bcc7f1d89f01af54ba24f8408", size: 94818466 },
  "linux-arm64": { path: "linux-arm64/magpie", archive: "magpie-cli-linux-arm64",
    sha256: "185948a63ebf9fb1efffcc079b3e513baf66ac350d403f45adcef08f03b74729", size: 87294114 },
};

test("分发清单固定 Magpie v0.1.4582 五平台，源码不携带二进制或旧 YAML", async () => {
  assert.equal(metadata.upstream, "yetone/magpie");
  assert.equal(metadata.version, "v0.1.4582");
  assert.deepEqual(Object.keys(metadata.platforms).sort(), Object.keys(expected).sort());
  const entries = await readdir(binRoot, { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(), [
    "LICENSE", "README.md", "README_CN.md", "legacy-releases.json", "platforms.json",
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
    assert.match(source, /scripts\/prepare-test-core\.mjs/);
    assert.doesNotMatch(source, /scripts\/fetch-core\.mjs/);
  }
});

test("Release 在草稿上传并核对远端资产后才公开，重跑已公开版本只校验", async () => {
  const workflow = await readFile(join(pluginRoot, "..", ".github/workflows/release.yml"), "utf8");
  const steps = workflow.split(/\r?\n      - name: /);
  const create = steps.findIndex(step => /gh release create "\$TAG" --draft\b/.test(step));
  const upload = steps.findIndex(step => step.includes('gh release upload "$TAG"'));
  const verify = steps.findIndex(step => step.includes('gh release view "$TAG" --json assets'));
  const publish = steps.findIndex(step => step.includes('gh release edit "$TAG" --draft=false'));
  assert.ok(create >= 0 && create < upload && upload < verify && verify < publish);
  for (const step of [steps[upload], steps[publish]]) assert.match(step, /if: steps\.draft\.outputs\.upload == 'true'/);
  assert.doesNotMatch(steps[verify], /\n        if:/);
});

for (const [key, pinned] of Object.entries(expected)) {
  test(`${key} 原始资产的大小、缓存路径和双 SHA256 与固定版本一致`, () => {
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
    assert.equal(entry.sizeBytes, pinned.size);
    assert.equal(release.sizeBytes, pinned.size);
    assert.equal(entry.url, `https://github.com/yetone/magpie/releases/download/v0.1.4582/${pinned.archive}`);
    assert.equal(release.url, entry.url);
    assert.doesNotMatch(entry.archive, /\.(zip|gz)$/);
    assert.equal(new Set(Object.values(metadata.platforms).map((item) => item.path)).size, 5);
    const dataDir = join(tmpdir(), "isolated-platform-path-check");
    assert.equal(resolveCoreBinaryPath({ dataDir, platform, arch }),
      join(dataDir, "runtimes", "v0.1.4582", key, basename(pinned.path)));
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
