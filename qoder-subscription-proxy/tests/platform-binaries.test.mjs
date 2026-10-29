import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getCoreRelease, resolveCoreBinaryPath } from "../bridge/core-runtime.mjs";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binRoot = join(pluginRoot, "bridge", "bin");
const metadata = JSON.parse(await readFile(join(binRoot, "platforms.json"), "utf-8"));
const notices = await readFile(join(pluginRoot, "THIRD_PARTY_NOTICES.md"), "utf-8");
const expected = {
  "win32-x64": {
    path: "qoder-plugin-subscription-proxy.exe",
    archive: "CLIProxyAPI_8.0.47_windows_amd64.zip",
    binarySha256: "90cf448b09da5b8ce03990669e8915638b12ed30abefa4f8546e42c4e7e18e7b",
    archiveSha256: "8e23cbb2f9f695411b7df46320855820b352fb886c3c3bdf45ab4634f2f14632",
  },
  "darwin-x64": {
    path: "darwin-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.47_darwin_amd64.tar.gz",
    binarySha256: "7a4652fd980d335c25ab9bfedc400bce79ed9746ea70a5fb1127bfa938ce56f3",
    archiveSha256: "2e72cb7b28905b9135563e4fc01af00009ce72a444729eb95bdb634543ce7d41",
  },
  "darwin-arm64": {
    path: "darwin-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.47_darwin_aarch64.tar.gz",
    binarySha256: "7b5a31c64ff46874d1602e40aff811e37a61ac85f438473f6f9981ed9bda1e10",
    archiveSha256: "a5b260ec0f843d2291488acd76e5595232da8f3b8ec2d334154f1570f5f3ca08",
  },
  "linux-x64": {
    path: "linux-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.47_linux_amd64.tar.gz",
    binarySha256: "167fff6edf264f71b7e28923b71f97cf1b49957db1612a6e5e8e570f42aeb112",
    archiveSha256: "2b5111dc6a0dfe0d607457787f794330d1b477bc9daa6337c26b0cd032a7827e",
  },
  "linux-arm64": {
    path: "linux-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.47_linux_aarch64.tar.gz",
    binarySha256: "e4d13e45d03fa78dbd0cb2c510034a99893a9d5630ca58f36ec506946c1f3c08",
    archiveSha256: "da1326ed4434fb6c9609927f317c093f9a4bb482a61e5451e9bea99a0dc7c4bf",
  },
};

test("分发清单固定上游 v8.0.47 和五种平台，不包含 no-plugin 或 Windows ARM64", async () => {
  assert.equal(metadata.upstream, "router-for-me/CLIProxyAPI");
  assert.equal(metadata.version, "v8.0.47");
  assert.deepEqual(Object.keys(metadata.platforms).sort(), Object.keys(expected).sort());
  const entries = await readdir(binRoot, { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(), [
    "LICENSE", "README.md", "README_CN.md", "config.example.yaml", "platforms.json",
  ]);
  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    assert.deepEqual(await readdir(join(binRoot, entry.name)), [], "源码不得留下任何平台核心或归档");
  }
  assert.equal(entries.some((entry) => entry.isSymbolicLink()), false);
  assert.equal(entries.some((entry) => /\.(?:exe|zip|gz|tmp)$/.test(entry.name)), false);
});

for (const [key, pinned] of Object.entries(expected)) {
  test(`${key} 缓存路径、官方来源与双 SHA256 保持固定，离线验证不执行或下载核心`, () => {
    const entry = metadata.platforms[key];
    const [platform, arch] = key.split("-");
    const release = getCoreRelease({ platform, arch });
    for (const field of ["path", "archive", "binarySha256", "archiveSha256"]) {
      assert.equal(entry[field], pinned[field], `${key}.${field}`);
      assert.equal(release[field], pinned[field], `下载器 ${key}.${field}`);
      assert.ok(notices.includes(pinned[field]), `第三方声明缺少 ${key}.${field}`);
    }
    assert.equal(entry.url, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.47/${pinned.archive}`);
    assert.equal(release.url, entry.url);
    assert.doesNotMatch(entry.archive, /no-plugin/);
    const dataDir = join(tmpdir(), "isolated-platform-path-check");
    assert.equal(resolveCoreBinaryPath({ dataDir, platform, arch }),
      join(dataDir, "runtimes", "v8.0.47", key, basename(pinned.path)));
    if (platform !== "win32") assert.equal(entry.mode, "0755");
  });
}

test("显式准备的当前平台核心 SHA256 与文件架构一致，校验不执行核心", { skip: nativeCoreSkip }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "subscription-core-architecture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pinned = expected[`${process.platform}-${process.arch}`];
  assert.ok(pinned);
  const path = await copyTestCore(join(directory, basename(pinned.path)));
  assert.equal((await lstat(path)).isFile(), true);
  const binary = await readFile(path);
  assert.equal(createHash("sha256").update(binary).digest("hex"), pinned.binarySha256);
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
