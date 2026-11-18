import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_HOST, DEFAULT_PORT, MANAGEMENT_PORT, PLUGIN_VERSION, loadConfig, ensureMagpieConfig, validateMagpieSettings, magpieArguments, magpieEnvironment } from "../server/config.mjs";
import { getCoreRelease, resolveCoreBinaryPath } from "../server/core-runtime.mjs";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "qoder-magpie-config-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { BRIDGE_DATA_DIR: join(root, "data"), ...extra };
  const load = (values = {}) => loadConfig({ pluginRoot, env: { ...env, ...values } });
  return { root, env, load };
}

test("插件、市场与MCP版本一致，固定端口保持不变", async () => {
  const manifest = JSON.parse(await readFile(new URL("../.qoder-plugin/plugin.json", import.meta.url)));
  const marketplace = JSON.parse(await readFile(new URL("../../.qoder-plugin/marketplace.json", import.meta.url)));
  assert.equal(PLUGIN_VERSION, "1.1.2");
  assert.equal(manifest.version, PLUGIN_VERSION);
  assert.equal(marketplace.plugins.find(p => p.name === manifest.name).version, PLUGIN_VERSION);
  assert.equal(manifest.mcpServers, "./mcp.json");
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(DEFAULT_PORT, 19787);
  assert.equal(MANAGEMENT_PORT, 19788);
});

test("新版本复用本机密钥但隔离Magpie配置，不读取或改写旧授权", async t => {
  const { load, env } = await fixture(t);
  const config = await load();
  await mkdir(join(config.dataDir, "auths"));
  await writeFile(join(config.dataDir, "auths", "old.json"), "private-old-token");
  await writeFile(join(config.dataDir, "config.yaml"), "legacy-config: invalid-but-preserved");
  const upgraded = await loadConfig({ pluginRoot: join(pluginRoot, "different-install"), env });
  assert.equal(config.apiKey, upgraded.apiKey);
  assert.equal(config.mgmtKey, upgraded.mgmtKey);
  assert.notEqual(config.apiKey, config.mgmtKey);
  assert.equal(config.configPath, join(config.dataDir, "magpie", "settings.json"));
  assert.equal(config.binPath, resolveCoreBinaryPath({ dataDir: config.dataDir }));
  assert.equal(config.endpoint, "http://127.0.0.1:19787/v1");
  assert.equal(config.managementUrl, "http://127.0.0.1:19788/");
  await ensureMagpieConfig(config);
  assert.equal(await readFile(join(config.dataDir, "config.yaml"), "utf8"), "legacy-config: invalid-but-preserved");
  assert.equal(await readFile(join(config.dataDir, "auths", "old.json"), "utf8"), "private-old-token");
});

test("五平台选择固定Magpie资产，自定义核心不会隐式下载", async t => {
  const { root, env } = await fixture(t);
  for (const key of ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
    const [platform, arch] = key.split("-");
    const config = await loadConfig({ pluginRoot, env, platform, arch });
    assert.equal(config.core.key, key);
    assert.equal(config.core.version, getCoreRelease({ platform, arch }).version);
    const custom = await loadConfig({ pluginRoot, env: { ...env, BRIDGE_BIN: join(root, "custom") }, platform, arch });
    assert.equal(custom.core, null);
    assert.equal(custom.binPath, join(root, "custom"));
  }
  await assert.rejects(loadConfig({ pluginRoot, env, platform: "win32", arch: "ia32" }), /不支持的平台/);
});

test("所有环境输入先校验，非法端口、监听、密钥不创建数据", async t => {
  const { root, load } = await fixture(t);
  for (const key of ["BRIDGE_PORT", "BRIDGE_MANAGEMENT_PORT"]) {
    for (const value of ["", "0", "65536", "80x", "80.0", "8e3", " 80", "-1", "80\n", 80, null]) {
      await assert.rejects(load({ [key]: value }), new RegExp(key));
    }
  }
  for (const host of ["localhost", "::1", "0.0.0.0", "127.0.0.2", ""]) await assert.rejects(load({ BRIDGE_HOST: host }), /BRIDGE_HOST/);
  await assert.rejects(load({ BRIDGE_PORT: "19788" }), /端口不能相同/);
  await assert.rejects(load({ BRIDGE_API_KEY: "secret value" }), /BRIDGE_API_KEY/);
  await assert.rejects(load({ BRIDGE_MGMT_KEY: "secret" }), /BRIDGE_MGMT_KEY/);
  assert.deepEqual(await readdir(root), []);
});

test("凭据并发初始化和旧版单密钥迁移保持客户端key", async t => {
  const { load } = await fixture(t);
  const configs = await Promise.all(Array.from({ length: 6 }, () => load()));
  assert.equal(new Set(configs.map(c => c.apiKey)).size, 1);
  assert.equal(new Set(configs.map(c => c.mgmtKey)).size, 1);
  const config = configs[0];
  const file = join(config.dataDir, "launcher-secrets.json");
  await writeFile(file, JSON.stringify({ apiKey: "keep-this-api-key" }));
  const upgraded = await load();
  assert.equal(upgraded.apiKey, "keep-this-api-key");
  assert.match(upgraded.mgmtKey, /^[a-f0-9]{64}$/);
  await assert.rejects(load({ BRIDGE_API_KEY: upgraded.mgmtKey }), /不能与管理密钥相同/);
  await writeFile(file, "private-broken-secret");
  await assert.rejects(load(), error => !error.message.includes("private-broken-secret"));
});

test("Magpie初始化幂等并保留用户设置，拒绝不安全运行设置", async t => {
  const { load } = await fixture(t);
  const config = await load();
  await Promise.all([ensureMagpieConfig(config), ensureMagpieConfig(config)]);
  const settings = JSON.parse(await readFile(config.configPath, "utf8"));
  assert.equal(settings.noAccountDiscovery, true);
  assert.equal(settings.noAutoUpdate, true);
  assert.equal(settings.noAutoDownload, true);
  assert.equal(settings.noStats, true);
  settings.imageGen = "codex/gpt-image-2";
  await writeFile(config.configPath, JSON.stringify(settings));
  await ensureMagpieConfig(config);
  assert.equal(JSON.parse(await readFile(config.configPath, "utf8")).imageGen, settings.imageGen);
  for (const patch of [{ lan: true }, { https: true }, { port: 0 }, { noAutoUpdate: false }, { noAutoDownload: false }, { autoRestart: true }]) {
    assert.throws(() => validateMagpieSettings(config, JSON.stringify({ ...settings, ...patch })));
  }
  for (const text of ["private-broken-json", "[]", "null", "42"]) assert.throws(() => validateMagpieSettings(config, text));
  assert.deepEqual((await readdir(config.profileDir)).filter(f => f.endsWith(".tmp")), []);
});

test("拒绝会覆盖XDG隔离的portable自定义核心布局", async t => {
  const { root, load } = await fixture(t);
  const config = await load({ BRIDGE_BIN: join(root, "custom-core") });
  await assert.rejects(ensureMagpieConfig(config), /portable/);
  await mkdir(join(root, "bin"));
  const isolated = await load({ BRIDGE_BIN: join(root, "bin", "custom-core") });
  await writeFile(join(root, "bin", ".portable"), "");
  await assert.rejects(ensureMagpieConfig(isolated), /portable/);
});

test("原生核心默认关闭订阅，但用户显式开启后不被环境变量锁死", { skip: nativeCoreSkip }, async t => {
  const { root, load } = await fixture(t);
  const binDir = join(root, "bin");
  await mkdir(binDir);
  const binPath = await copyTestCore(join(binDir, process.platform === "win32" ? "magpie.exe" : "magpie"));
  const config = await load({ BRIDGE_BIN: binPath });
  await ensureMagpieConfig(config);
  const env = magpieEnvironment(config, { ...process.env, HOME: root, USERPROFILE: root, MAGPIE_NO_ACCOUNTS: "1" });
  const query = () => promisify(execFile)(binPath, ["accounts", "discovery"], { env, cwd: root, timeout: 15000, windowsHide: true });
  assert.match((await query()).stdout, /account discovery is off:/);
  const settings = JSON.parse(await readFile(config.configPath, "utf8"));
  await writeFile(config.configPath, JSON.stringify({ ...settings, noAccountDiscovery: false }));
  await ensureMagpieConfig(config);
  assert.match((await query()).stdout, /account discovery is on:/);
});

test("子进程使用隔离配置和明确监听，不继承宿主Magpie重定向", async t => {
  const { load } = await fixture(t);
  const config = await load({ BRIDGE_PORT: "21001", BRIDGE_MANAGEMENT_PORT: "21002" });
  const env = magpieEnvironment(config, { PATH: "keep-path", HOME: "keep-home", MAGPIE_ADDR: "0.0.0.0:1", magpie_web_url: "https://example.invalid", MAGPIE_TRUST_PROXY: "1" });
  assert.equal(env.PATH, "keep-path");
  assert.equal(env.HOME, "keep-home");
  assert.equal(env.MAGPIE_ADDR, "127.0.0.1:21001");
  assert.equal(env.XDG_CONFIG_HOME, config.dataDir);
  assert.equal(env.MAGPIE_WEB_KEY, config.mgmtKey);
  assert.equal(env.MAGPIE_TRUST_PROXY, undefined);
  assert.equal(env.magpie_web_url, undefined);
  assert.equal(env.MAGPIE_NO_ACCOUNTS, undefined);
  assert.equal(env.DO_NOT_TRACK, "1");
  assert.deepEqual(magpieArguments(config), ["serve", "--web=127.0.0.1:21002"]);
});
