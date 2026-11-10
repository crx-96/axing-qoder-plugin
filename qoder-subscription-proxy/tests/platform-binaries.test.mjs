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
    archive: "CLIProxyAPI_8.0.63_windows_amd64.zip",
    binarySha256: "167119451351dac1b63331e781b1f96810f84755275b3352cdccfac070e05de0",
    archiveSha256: "5d8c7a093580c25cace076344dd650c9318ecb9990d9e2147bcee0c515a24b2a",
  },
  "darwin-x64": {
    path: "darwin-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.63_darwin_amd64.tar.gz",
    binarySha256: "beab0ccec3b1ca68745d6e43c14e9d5c015b0d0c040754446de9beb44277f7e1",
    archiveSha256: "1dd6eb617e3be3a34b3395c8fa6b57e71ea298c7816eadd4e6ce0f025d1234d5",
  },
  "darwin-arm64": {
    path: "darwin-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.63_darwin_aarch64.tar.gz",
    binarySha256: "6f408592dbd635bc25c71c38bc71bde024d25bc24611268087c6171081c8b74b",
    archiveSha256: "1336299530082d655fbdfdae866836d070aeec9379a77ef1c5cc25c432b6653a",
  },
  "linux-x64": {
    path: "linux-x64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.63_linux_amd64.tar.gz",
    binarySha256: "1d681a08041dace3bc754133f7bf3df38019e862ea0b9eeb203967c1b7ca8fdd",
    archiveSha256: "bce20e7eb3f985f9f03b72be21d99f0427c25247248d4e614493ed57ce71e9e5",
  },
  "linux-arm64": {
    path: "linux-arm64/qoder-plugin-subscription-proxy",
    archive: "CLIProxyAPI_8.0.63_linux_aarch64.tar.gz",
    binarySha256: "7faed9a938d80383dfb73984f973b4fb682913c93d0c28da5f56c3c1cc6906a6",
    archiveSha256: "f32091a2281be9170861ec81bb70f3541b5c1c8659f10baa70d015e1c1a93aed",
  },
};

test("分发清单固定上游 v8.0.63 和五种平台，不包含 no-plugin 或 Windows ARM64", async () => {
  assert.equal(metadata.upstream, "router-for-me/CLIProxyAPI");
  assert.equal(metadata.version, "v8.0.63");
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
    assert.equal(entry.url, `https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.0.63/${pinned.archive}`);
    assert.equal(release.url, entry.url);
    assert.doesNotMatch(entry.archive, /no-plugin/);
    const dataDir = join(tmpdir(), "isolated-platform-path-check");
    assert.equal(resolveCoreBinaryPath({ dataDir, platform, arch }),
      join(dataDir, "runtimes", "v8.0.63", key, basename(pinned.path)));
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
