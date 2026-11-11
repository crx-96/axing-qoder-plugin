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
    archive: "CLIProxyAPI_8.0.67_windows_amd64.zip",
    binarySha256: "562f90dfc7f4948d5036996bb7c7a6e6ab699cc353adc00ebb5206010036e57e",
    archiveSha256: "7863ad44d3b75c7c4af7bcae3d87e28c9bb2985a47295dba6d110e33c9e51077",
  },
  "darwin-x64": {
    path: "darwin-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.67_darwin_amd64.tar.gz",
    binarySha256: "407bee373439c3a980c59d9e978763ed1f51ab638e2e92950b9cba5530bc360b",
    archiveSha256: "ca0600e743748afd6103d1fc57be93b59b211fa88d9215e1ff3462ab58ad4214",
  },
  "darwin-arm64": {
    path: "darwin-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.67_darwin_aarch64.tar.gz",
    binarySha256: "4765347d70eb8034ec0562451362f7f4782bae285c96c252fdd65e5c27fe0e3b",
    archiveSha256: "ea5bc14e874f422b0049ada5bcc0552636340fab0fac791d7dda6af4fe70fccf",
  },
  "linux-x64": {
    path: "linux-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.67_linux_amd64.tar.gz",
    binarySha256: "6b1f68e1571dd9af3b504dee885b9ac7fdb436cd08bdc3ff540accb88ec701e9",
    archiveSha256: "5edaf5180be7d1aa31a0aaae0fc115d715b43001b7572c69709ed155f3a7d876",
  },
  "linux-arm64": {
    path: "linux-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.67_linux_aarch64.tar.gz",
    binarySha256: "619aa2343a6f56c0a4c69e03204c31d22bfdcae2c02ff9d39cfd6dc2770aa8ee",
    archiveSha256: "716744c8e41762e4621eea841138be908c0ffbe373a31d5674331def8d700ad7",
  },
};

test("分发清单固定上游 v8.0.67 和五种平台，不包含 no-plugin 或 Windows ARM64", async () => {
  assert.equal(metadata.upstream, "router-for-me/CLIProxyAPI");
  assert.equal(metadata.version, "v8.0.67");
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
    assert.equal(entry.url, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.67/${pinned.archive}`);
    assert.equal(release.url, entry.url);
    assert.doesNotMatch(entry.archive, /no-plugin/);
    const dataDir = join(tmpdir(), "isolated-platform-path-check");
    assert.equal(resolveCoreBinaryPath({ dataDir, platform, arch }),
      join(dataDir, "runtimes", "v8.0.67", key, basename(pinned.path)));
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
