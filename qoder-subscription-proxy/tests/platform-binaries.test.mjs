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
const notices = await readFile(join(pluginRoot, "THIRD_PARTY_NOTICES.md"), "utf-8");
const expected = {
  "win32-x64": {
    path: "qoder-plugin-subscription-proxy.exe",
    archive: "CLIProxyAPI_8.0.60_windows_amd64.zip",
    binarySha256: "9740e396a97eb7d6b7a7e65bc3ea681cce1114a888e39213cafa0175151cde0f",
    archiveSha256: "c81a2c51aeab819c6e4840ad62f8d8f4143706b9fa7682f4a769683e0044fff1",
  },
  "darwin-x64": {
    path: "darwin-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.60_darwin_amd64.tar.gz",
    binarySha256: "c2d3379393e983cda72fd52dc363bf066c3de8fde168d9b27599ad56e4635704",
    archiveSha256: "8892224d75f3d29a33efd0e4b8a00bb97505266cf2b9bc80d1adb3a787d89910",
  },
  "darwin-arm64": {
    path: "darwin-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.60_darwin_aarch64.tar.gz",
    binarySha256: "2a7a43305a0907d9d9959c6d628a6206f2304b6b2069338135300a0442152672",
    archiveSha256: "9be68e64fc614a5474b98d310bb9057d6bdecb619cedec01febbb4073fdb19df",
  },
  "linux-x64": {
    path: "linux-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.60_linux_amd64.tar.gz",
    binarySha256: "bf1b39243401f60086fbee58f36f158d2f84c3ef915e035a0bab13fd174b85aa",
    archiveSha256: "34720cd10deef235481e80625e0c02dee934eefdd03dc8bc4f327156fa766211",
  },
  "linux-arm64": {
    path: "linux-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.60_linux_aarch64.tar.gz",
    binarySha256: "79806c610d8495d6aad6cc147b21e2b67880cf2d8a0c5314d1b7b937f8e7068a",
    archiveSha256: "1c45a42770b5307a52599a2668645face8fb95c0f2dc6ee610e0992592c643d8",
  },
};

test("分发清单固定上游 v8.0.60 和五种平台，不包含 no-plugin 或 Windows ARM64", async () => {
  assert.equal(metadata.upstream, "router-for-me/CLIProxyAPI");
  assert.equal(metadata.version, "v8.0.60");
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
    assert.equal(entry.url, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.60/${pinned.archive}`);
    assert.equal(release.url, entry.url);
    assert.doesNotMatch(entry.archive, /no-plugin/);
    const dataDir = join(tmpdir(), "isolated-platform-path-check");
    assert.equal(resolveCoreBinaryPath({ dataDir, platform, arch }),
      join(dataDir, "runtimes", "v8.0.60", key, basename(pinned.path)));
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
