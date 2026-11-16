import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter, resolve } from "node:path";
import { ensureAcpRuntime, hostAcpCandidates, assertAcpRuntimeUnchanged } from "../server/acp-runtime.mjs";

async function fixture(t) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "qoder-acp-runtime-")));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, port: 19787 };
}

test("宿主查找不执行工作目录或相对 PATH 项中的同名程序", () => {
  const trusted = join(tmpdir(), "acp-host");
  const paths = hostAcpCandidates({ env: { PATH: [process.cwd(), ".", "", trusted].join(delimiter) } });
  assert.ok(paths.length);
  assert.ok(paths.every(path => path.startsWith(trusted)));
});

test("显式程序配置优先，不兼容时不静默下载安装", async t => {
  const config = await fixture(t);
  const path = join(config.dataDir, "official.exe");
  await writeFile(path, "synthetic");
  let downloads = 0;
  const probe = async runtime => { assert.equal(runtime.path, await import('node:fs/promises').then(fs => fs.realpath(path))); return { ...runtime, version: "1.5.0" }; };
  const value = await ensureAcpRuntime(config, { env: { BRIDGE_ACP_BIN: path, PATH: "" }, probe, download: async () => { downloads++; } });
  assert.equal(value.source, "host"); assert.equal(downloads, 0);
  await assert.rejects(ensureAcpRuntime(config, { env: { BRIDGE_ACP_BIN: "relative.exe" } }), { code: "ACP_CONFIG" });
  await assert.rejects(ensureAcpRuntime(config, { env: { BRIDGE_ACP_BIN: path, PATH: "" }, probe: async () => { throw Object.assign(Error(), { code: "ACP_INCOMPATIBLE" }); }, download: async () => { downloads++; } }), { code: "ACP_INCOMPATIBLE" });
  assert.equal(downloads, 0);
});

test("未授权下载安装时仅报告缺失，取消不产生下载", async t => {
  const config = await fixture(t); let downloads = 0;
  const options = { env: { PATH: "" }, download: async () => { downloads++; } };
  await assert.rejects(ensureAcpRuntime(config, options), { code: "ACP_NOT_INSTALLED" });
  await assert.rejects(ensureAcpRuntime(config, { ...options, allowDownload: true, signal: AbortSignal.abort() }));
  assert.equal(downloads, 0);
});

test("摘要错误不发布程序，临时安装目录被清理", async t => {
  const config = await fixture(t);
  await assert.rejects(ensureAcpRuntime(config, { env: { PATH: "" }, allowDownload: true,
    download: async ({ destination }) => writeFile(destination, "not the official archive"),
    probe: async () => assert.fail("must not execute unverified code") }), { code: "ACP_HASH" });
  const parent = join(config.dataDir, "runtimes", "antigravity-acp", "1.5.0");
  assert.deepEqual(await readdir(parent), []);
});

test("残缺缓存保留原文件并拒绝覆盖", async t => {
  const config = await fixture(t);
  const directory = join(config.dataDir, "runtimes", "antigravity-acp", "1.5.0", `${process.platform}-${process.arch}`);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "user-file"), "preserve");
  await assert.rejects(ensureAcpRuntime(config, { env: { PATH: "" }, allowDownload: true,
    download: async () => assert.fail("must not overwrite an incomplete installation") }), { code: "ACP_CACHE_INVALID" });
  assert.equal(await readFile(join(directory, "user-file"), "utf8"), "preserve");
});

test("Linux 缓存祖先的大小写路径链接不能绕过私有目录检查", { skip: process.platform !== "linux" }, async t => {
  const config = await fixture(t);
  await mkdir(join(config.dataDir, "cache", "data", "acp-profile"), { recursive: true });
  await symlink(join(config.dataDir, "cache"), join(config.dataDir, "CACHE"), "dir");
  await assert.rejects(ensureAcpRuntime({ ...config, dataDir: join(config.dataDir, "CACHE", "data") }, { env: { PATH: "" } }),
    { code: "ACP_RUNTIME_INVALID" });
});

test("官方归档在隔离账号目录完成安装、并发去重、离线复用与变更检测", {
  skip: !process.env.BRIDGE_TEST_ACP_ARCHIVE || process.platform !== "win32", timeout: 300000,
}, async t => {
  const config = await fixture(t);
  const home = join(config.dataDir, "isolated-home"); await mkdir(home);
  const env = { ...process.env, PATH: "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home };
  delete env.BRIDGE_ACP_BIN;
  for (const key of Object.keys(env)) if (/TOKEN|SECRET|KEY|CREDENTIAL|GOOGLE|GEMINI|ANTIGRAVITY/i.test(key)) delete env[key];
  let downloads = 0;
  const options = { env, allowDownload: true, download: async ({ destination }) => { downloads++; await copyFile(resolve(process.env.BRIDGE_TEST_ACP_ARCHIVE), destination); } };
  const [first, second] = await Promise.all([ensureAcpRuntime(config, options), ensureAcpRuntime(config, options)]);
  assert.equal(downloads, 1); assert.equal(first.path, second.path); assert.equal(first.version, "1.5.0");
  await assertAcpRuntimeUnchanged(first);
  const cached = await ensureAcpRuntime(config, { env });
  assert.equal(cached.source, "cache"); assert.equal(downloads, 1);
  const host = await ensureAcpRuntime(config, { env: { ...env, BRIDGE_ACP_BIN: first.path } });
  assert.equal(host.source, "host");
  const alternate = join(config.dataDir, "runtimes", "antigravity-acp", "1.5.0", "win32-x64", "unverified.exe");
  await writeFile(alternate, "unverified executable beside genuine official files");
  await assert.rejects(ensureAcpRuntime(config, { env: { ...env, BRIDGE_ACP_BIN: alternate } }),
    error => error.code === "ACP_INCOMPATIBLE" && /启动入口/.test(error.safeMessage));
  await rm(alternate);
  await writeFile(first.path, "changed");
  await assert.rejects(assertAcpRuntimeUnchanged(first), { code: "ACP_RUNTIME_CHANGED" });
  await assert.rejects(ensureAcpRuntime(config, { env }), { code: "ACP_CACHE_INVALID" });
});
