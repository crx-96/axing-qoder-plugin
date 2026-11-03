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
    archive: "CLIProxyAPI_8.0.51_windows_amd64.zip",
    binarySha256: "4d172996894e99dd75f01467967212e72911fe0daa86a867bedb9c31e027b667",
    archiveSha256: "4c7e3160f821a59d4760dfdc1e4404bb213bc2b69535c3ca4c4b26474b6d2d59",
  },
  "darwin-x64": {
    path: "darwin-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.51_darwin_amd64.tar.gz",
    binarySha256: "98ca91ee453cd6d1688003948b9ef9ecbc3668a108f01c2e7207bf18bb9c4a27",
    archiveSha256: "7f68be928979c3991d097255fd8fb732edc684e72fe10faf29a365e44246cedb",
  },
  "darwin-arm64": {
    path: "darwin-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.51_darwin_aarch64.tar.gz",
    binarySha256: "297b5a87f47cb3d166dc3198790c65397e803810ad72b2e054f662721072fbf0",
    archiveSha256: "fb8e2568e98e3304a1b892c4f70a4c154c661078ad87007e63cf7ba71b4ce168",
  },
  "linux-x64": {
    path: "linux-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.51_linux_amd64.tar.gz",
    binarySha256: "19eb8f65b0a7066af51771ee1f2be8b37f0dd93c0e94f40de437c1db04a7a5f1",
    archiveSha256: "15de160e1fd97a0f9f7e0577582c765b14e040ab6a8314f514af9fae8a2c4700",
  },
  "linux-arm64": {
    path: "linux-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.51_linux_aarch64.tar.gz",
    binarySha256: "f5b72a4545429c7c15ddcb8a41bb7582ec0a3e4ce90d8612a0d09a2d84500a73",
    archiveSha256: "411aa08783c572bdb72a6ba0ffcc0a75155be27e75a1c5aef3b49d8b96da4d52",
  },
};

test("分发清单固定上游 v8.0.51 和五种平台，不包含 no-plugin 或 Windows ARM64", async () => {
  assert.equal(metadata.upstream, "router-for-me/CLIProxyAPI");
  assert.equal(metadata.version, "v8.0.51");
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
    assert.equal(entry.url, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.51/${pinned.archive}`);
    assert.equal(release.url, entry.url);
    assert.doesNotMatch(entry.archive, /no-plugin/);
    const dataDir = join(tmpdir(), "isolated-platform-path-check");
    assert.equal(resolveCoreBinaryPath({ dataDir, platform, arch }),
      join(dataDir, "runtimes", "v8.0.51", key, basename(pinned.path)));
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
