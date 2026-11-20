import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyTestCore, nativeCoreSkip } from "./helpers/native-core.mjs";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:net";
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

test("插件和市场使用相同的管理入口名称，版本与 MCP 一致且端口固定", async () => {
  const manifest = JSON.parse(await readFile(new URL("../.qoder-plugin/plugin.json", import.meta.url)));
  const marketplace = JSON.parse(await readFile(new URL("../../.qoder-plugin/marketplace.json", import.meta.url)));
  const listing = marketplace.plugins.find(p => p.name === manifest.name);
  assert.equal(PLUGIN_VERSION, "2.0.1");
  assert.equal(manifest.version, PLUGIN_VERSION);
  assert.equal(listing.version, PLUGIN_VERSION);
  assert.equal(manifest.displayName, "订阅代理管理");
  assert.equal(listing.displayName, manifest.displayName);
  assert.equal(listing.displayName_i18n["zh-CN"], manifest.displayName);
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

test("先识别独立 Magpie 根、XDG 配置及缓存，拒绝时不落盘凭据", async t => {
  const { root, load } = await fixture(t);
  for (const [index, parts] of [["settings.json"], ["providers.json"], ["logins.json"],
    ["magpie", "settings.json"], ["magpie", "providers.json"], ["cache", "magpie"], ["dial", "settings.json"]].entries()) {
    const dir = join(root, `foreign-${index}`);
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
    const sentinel = join(dir, ...parts);
    await writeFile(sentinel, "independent instance");
    await assert.rejects(load({ BRIDGE_DATA_DIR: dir }), /独立 Magpie/);
    assert.deepEqual(await readdir(dir), [parts[0]]);
    assert.equal(await readFile(sentinel, "utf8"), "independent instance");
  }
});

test("配置和缓存即使尚未创建，也不能将其共享 XDG 根或子目录作为插件目录", async t => {
  const { root, load } = await fixture(t);
  for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    const other = join(root, name);
    for (const dir of [other, join(other, "magpie"), join(other, "magpie", "nested")]) {
      await assert.rejects(load({ [name]: other, BRIDGE_DATA_DIR: dir }), /重叠/);
      await assert.rejects(lstat(other), { code: "ENOENT" });
    }
  }
});

test("POSIX 凭据只通过原文件收紧到 0600，拒绝其他用户可写的数据目录", { skip: process.platform === "win32" }, async t => {
  const { load, env } = await fixture(t);
  const config = await load();
  const file = join(env.BRIDGE_DATA_DIR, "launcher-secrets.json");
  await chmod(file, 0o644);
  assert.equal((await load()).apiKey, config.apiKey);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  await chmod(env.BRIDGE_DATA_DIR, 0o777);
  try { await assert.rejects(load(), /其他用户不能写入/); }
  finally { await chmod(env.BRIDGE_DATA_DIR, 0o700); }
});

test("已发布旧插件的目录可以保留账号设置和客户端密钥并升级公共管理密码", async t => {
  const { load, env } = await fixture(t);
  const dir = env.BRIDGE_DATA_DIR;
  await mkdir(join(dir, "magpie"), { recursive: true });
  const text = JSON.stringify({ lang: "zh", port: DEFAULT_PORT, noAutoDownload: true, noAutoUpdate: true });
  await writeFile(join(dir, "magpie", "settings.json"), text);
  const file = join(dir, "launcher-secrets.json");
  await writeFile(file, JSON.stringify({ mgmtKey: "123456", apiKey: "old-api-key" }), { mode: 0o644 });
  const config = await load();
  assert.equal(config.apiKey, "old-api-key");
  assert.match(config.mgmtKey, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(config.configPath, "utf8"), text);
  if (process.platform !== "win32") assert.equal((await lstat(file)).mode & 0o777, 0o600);
});

test("拒绝链接凭据，保留目标的权限、内容及原目录条目", async t => {
  const { root, env, load } = await fixture(t);
  await mkdir(env.BRIDGE_DATA_DIR);
  const file = join(env.BRIDGE_DATA_DIR, "launcher-secrets.json");
  const external = join(root, "external.json");
  const text = JSON.stringify({ apiKey: "external-api", mgmtKey: "a".repeat(64) });
  await writeFile(external, text, { mode: 0o644 });
  const mode = (await lstat(external)).mode;
  await link(external, file);
  await assert.rejects(load(), /链接/);
  assert.equal((await lstat(file)).nlink, 2);
  await unlink(file);
  await t.test("文件符号链接与悬空链接", async sub => {
    for (const target of [external, join(root, "missing")]) {
      try { await symlink(target, file, "file"); }
      catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") return sub.skip("此 Windows 用户无创建文件符号链接权限");
        throw error;
      }
      await assert.rejects(load(), /链接/);
      assert.ok((await lstat(file)).isSymbolicLink());
      await unlink(file);
    }
  });
  assert.equal(await readFile(external, "utf8"), text);
  assert.equal((await lstat(external)).mode, mode);
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

test("核心路径跟随链接后复查 .app 外层，普通独立目录仍可初始化", async t => {
  const { root, load } = await fixture(t);
  const bundleRoot = join(root, "distribution");
  const macOS = join(bundleRoot, "Magpie.APP", "Contents", "MacOS");
  await mkdir(macOS, { recursive: true });
  const bin = join(macOS, "magpie");
  await writeFile(bin, "fixture");
  const alias = join(root, "bin-alias");
  await symlink(macOS, alias, process.platform === "win32" ? "junction" : "dir");
  const config = await load({ BRIDGE_BIN: join(alias, "magpie") });
  await writeFile(join(bundleRoot, ".portable"), "");
  await assert.rejects(ensureMagpieConfig(config), /portable/);
  await unlink(join(bundleRoot, ".portable"));
  await mkdir(join(macOS, "data"));
  await assert.rejects(ensureMagpieConfig(config), /portable/);
  await rm(join(macOS, "data"), { recursive: true });
  await ensureMagpieConfig(config);
});

test("AppImage 只采用包含实际核心的挂载点对应的镜像目录", { skip: process.platform !== "linux" }, async t => {
  const { root, load } = await fixture(t);
  const mount = join(root, "mount");
  const binDir = join(mount, "usr", "bin");
  await mkdir(binDir, { recursive: true });
  const bin = join(binDir, "magpie");
  await writeFile(bin, "fixture");
  const config = await load({ BRIDGE_BIN: bin });
  const appImage = join(root, "Magpie.AppImage");
  await assert.rejects(ensureMagpieConfig(config, { APPIMAGE: appImage, APPDIR: mount }), /portable/);
  await ensureMagpieConfig(config, { APPIMAGE: appImage, APPDIR: join(root, "moun") });
});

test("启动前拒绝指向其他实例的私有 HOME、缓存及待迁移配置", async t => {
  const { root, load } = await fixture(t);
  const config = await load();
  const external = join(root, "external");
  await mkdir(external);
  for (const sub of ["home", "cache"]) {
    const alias = join(config.dataDir, sub);
    await symlink(external, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(ensureMagpieConfig(config), /目录/);
    await unlink(alias);
  }
  await mkdir(config.profileDir);
  await writeFile(join(config.profileDir, "move-to.json"), JSON.stringify({ To: external }));
  await assert.rejects(ensureMagpieConfig(config), /迁移/);
  assert.deepEqual(await readdir(external), []);
});

test("原生核心在隔离数据中识别宿主客户端，只读列表不改写设置且显式选择仍有效", { skip: nativeCoreSkip }, async t => {
  const { root, load } = await fixture(t);
  const binDir = join(root, "bin");
  await mkdir(binDir);
  const binPath = await copyTestCore(join(binDir, process.platform === "win32" ? "magpie.exe" : "magpie"));
  if (process.platform !== "win32") await chmod(binPath, 0o700);
  const options = { BRIDGE_BIN: binPath };
  for (const key of ["BRIDGE_PORT", "BRIDGE_MANAGEMENT_PORT"]) {
    const guard = createServer(socket => socket.destroy());
    guard.listen(0, "127.0.0.1");
    await once(guard, "listening");
    t.after(() => new Promise(resolve => guard.close(resolve)));
    options[key] = String(guard.address().port);
  }
  const config = await load(options);
  await ensureMagpieConfig(config);
  const external = join(root, "simulated-host");
  const hostQoder = join(external, "global");
  const hostChina = join(external, "china");
  const hostCodex = join(external, "custom-codex");
  const hostEnv = {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT,
    HOME: external, USERPROFILE: external, APPDATA: join(external, "AppData", "Roaming"),
    LOCALAPPDATA: join(external, "AppData", "Local"), CODEX_HOME: hostCodex, MAGPIE_NO_ACCOUNTS: "1",
    GEMINI_CLI_HOME: join(external, "gemini-home"),
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    QODER_CONFIG_DIR: hostQoder, QODERCN_CONFIG_DIR: hostChina,
  };
  const env = magpieEnvironment(config, hostEnv);
  // 使用非 Magpie 的模型名，验证只读命令不会顺带迁移任何客户端设置。
  const oldModel = JSON.stringify({ model: { name: "probe/old" }, providers: {} });
  for (const dir of [hostQoder, hostChina]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), oldModel);
  }
  await mkdir(hostCodex, { recursive: true });
  await writeFile(join(hostCodex, "config.toml"), 'model = "fixture"\n');
  // 非白名单客户端目录必须保持不可见；上游即使迁移 Codex，也不能触及它。
  const externalClient = join(external, "gemini-home");
  await mkdir(externalClient, { recursive: true });
  await writeFile(join(externalClient, "legacy-catalog"), "sentinel");
  await writeFile(join(externalClient, "settings.json"), "{}");
  const oldCache = join(external, "cache", "dial");
  await mkdir(oldCache, { recursive: true });
  await writeFile(join(oldCache, "legacy-catalog"), "outside-cache");
  const query = (args = ["accounts", "discovery"], childEnv = env) => promisify(execFile)(binPath, args,
    { env: childEnv, cwd: root, timeout: 20000, windowsHide: true });
  assert.match((await query()).stdout, /account discovery is off:/);
  // 只读列表应识别宿主 Qoder 与 Qoder CN；未列入白名单的客户端目录保持原样。
  const listed = (await query(["ls"])).stdout;
  assert.match(listed, /Qoder/);
  assert.match(listed, /Qoder CN/);
  const globalSettings = join(hostQoder, "settings.json");
  const chinaSettings = join(hostChina, "settings.json");
  assert.equal(await readFile(globalSettings, "utf8"), oldModel);
  assert.equal(await readFile(chinaSettings, "utf8"), oldModel);
  assert.equal(await readFile(join(externalClient, "legacy-catalog"), "utf8"), "sentinel");
  assert.equal(await readFile(join(externalClient, "settings.json"), "utf8"), "{}");
  assert.deepEqual(await readdir(oldCache), ["legacy-catalog"]);
  await assert.rejects(lstat(join(env.XDG_CACHE_HOME, "magpie", "legacy-catalog")), { code: "ENOENT" });
  // 显式选择只开放 Qoder CN；国际版回落到私有目录，普通列表命令不改写两个客户端。
  const optedIn = await load({ ...options, BRIDGE_QODER_CLIENT: "qoder-cn" });
  const selectedEnv = magpieEnvironment(optedIn, hostEnv);
  const home = join(config.dataDir, "home");
  assert.equal(selectedEnv.QODER_CONFIG_DIR, join(home, ".qoder"));
  assert.equal(selectedEnv.QODERCN_CONFIG_DIR, hostChina);
  await query(["agents"], selectedEnv);
  assert.equal(await readFile(globalSettings, "utf8"), oldModel);
  assert.equal(await readFile(chinaSettings, "utf8"), oldModel);
  const settings = JSON.parse(await readFile(config.configPath, "utf8"));
  await writeFile(config.configPath, JSON.stringify({ ...settings, noAccountDiscovery: false }));
  await ensureMagpieConfig(config);
  assert.match((await query()).stdout, /account discovery is on:/);
});

test("子进程使用隔离配置和明确监听，未识别的客户端仍回落到私有目录", async t => {
  const { load } = await fixture(t);
  const config = await load({ BRIDGE_PORT: "21001", BRIDGE_MANAGEMENT_PORT: "21002" });
  const hostHome = join(config.dataDir, "host-home");
  const env = magpieEnvironment(config, {
    PATH: "keep-path", HOME: hostHome, USERPROFILE: hostHome,
    MAGPIE_ADDR: "0.0.0.0:1", magpie_web_url: "https://example.invalid", MAGPIE_TRUST_PROXY: "1",
  });
  assert.equal(env.PATH, "keep-path");
  const home = join(config.dataDir, "home");
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.CODEX_HOME, join(home, ".codex"));
  assert.equal(env.QODER_CONFIG_DIR, join(home, ".qoder"));
  assert.equal(env.QODERCN_CONFIG_DIR, join(home, ".qoder-cn"));
  assert.equal(env.BRIDGE_NESTED_CORE_ENV, "1");
  assert.equal(env.MAGPIE_ADDR, "127.0.0.1:21001");
  assert.equal(env.XDG_CONFIG_HOME, config.dataDir);
  assert.equal(env.MAGPIE_WEB_KEY, config.mgmtKey);
  assert.equal(env.MAGPIE_TRUST_PROXY, undefined);
  assert.equal(env.magpie_web_url, undefined);
  assert.equal(env.MAGPIE_NO_ACCOUNTS, undefined);
  assert.equal(env.DO_NOT_TRACK, "1");
  assert.deepEqual(magpieArguments(config), ["serve", "--web=127.0.0.1:21002"]);
});

test("未指定客户端时自动识别宿主 Qoder，两个变量指向同一目录只暴露国际版", async t => {
  const { load, root } = await fixture(t);
  const config = await load();
  const host = join(root, "host-qoder");
  const qoder = join(host, ".qoder");
  await mkdir(qoder, { recursive: true });
  await writeFile(join(qoder, "settings.json"), "{}");
  await writeFile(join(qoder, ".qoder-app-status.json"), "{}");
  const base = { HOME: host, USERPROFILE: host, APPDATA: join(host, "AppData", "Roaming"),
    QODER_CONFIG_DIR: qoder, QODERCN_CONFIG_DIR: qoder };
  const env = magpieEnvironment(config, base);
  assert.equal(env.QODER_CONFIG_DIR, qoder);
  assert.equal(env.QODERCN_CONFIG_DIR, join(config.dataDir, "home", ".qoder-cn"));
  const guardian = { dataDir: config.dataDir, port: config.port, mgmtKey: config.mgmtKey };
  assert.deepEqual(magpieEnvironment(guardian, env), env);
});

test("Qoder CN 构建按目录识别，国际版保持私有", async t => {
  const { load, root } = await fixture(t);
  const config = await load();
  const host = join(root, "host-qoder-cn");
  const china = join(host, ".qoder-cn");
  await mkdir(china, { recursive: true });
  await writeFile(join(china, "settings.json"), "{}");
  const env = magpieEnvironment(config, { HOME: host, USERPROFILE: host,
    QODER_CONFIG_DIR: china, QODERCN_CONFIG_DIR: china });
  assert.equal(env.QODER_CONFIG_DIR, join(config.dataDir, "home", ".qoder"));
  assert.equal(env.QODERCN_CONFIG_DIR, china);
});

test("常见客户端目录按宿主位置暴露，密钥和非白名单变量仍保持隔离", async t => {
  const { load, root } = await fixture(t);
  const config = await load();
  const host = join(root, "host-clients");
  const appData = join(host, "AppData", "Roaming");
  // Zed 在 Windows 使用 Roaming AppData，在 macOS/Linux 使用 XDG 配置根。
  const zedDir = process.platform === "win32" ? join(appData, "Zed") : join(host, ".config", "zed");
  await mkdir(join(host, ".claude"), { recursive: true });
  await mkdir(join(host, ".pi", "agent"), { recursive: true });
  await mkdir(zedDir, { recursive: true });
  const base = {
    HOME: host, USERPROFILE: host, APPDATA: appData, LOCALAPPDATA: join(host, "AppData", "Local"),
    QWEN_HOME: join(host, "custom-qwen"), GEMINI_CLI_HOME: join(host, "custom-gemini"),
    OPENAI_API_KEY: "synthetic-host-token", AWS_SHARED_CREDENTIALS_FILE: join(host, "credentials"),
    QODER_CONFIG_DIR: join(host, ".qoder"), QODERCN_CONFIG_DIR: join(host, ".qoder"),
  };
  const env = magpieEnvironment(config, base);
  const home = join(config.dataDir, "home");
  assert.equal(env.CLAUDE_CONFIG_DIR, join(host, ".claude"));
  assert.equal(env.PI_CODING_AGENT_DIR, join(host, ".pi", "agent"));
  assert.equal(env.MAGPIE_ZED_CONFIG_DIR, zedDir);
  assert.equal(env.QWEN_HOME, join(host, "custom-qwen"));
  assert.equal(env.GEMINI_CLI_HOME, "");
  assert.equal(env.HOME, home);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, undefined);
  const guardian = { dataDir: config.dataDir, port: config.port, mgmtKey: config.mgmtKey };
  assert.deepEqual(magpieEnvironment(guardian, env), env);
});
