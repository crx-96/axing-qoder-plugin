import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PLUGIN_VERSION,
  loadConfig,
  renderConfigYaml,
  validateExistingConfig,
} from "../bridge/config.mjs";
import { resolveCoreBinaryPath } from "../bridge/core-runtime.mjs";
import { parseConfigYaml } from "../bridge/config-yaml.mjs";

const execFileAsync = promisify(execFile);
const moduleUrl = new URL("../bridge/config.mjs", import.meta.url).href;
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qoder-subscription-proxy-config-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { BRIDGE_DATA_DIR: join(root, "data") };
  return { root, env, load: (extra = {}) => loadConfig({ pluginRoot, env: { ...env, ...extra } }) };
}

function noSecret(error, secrets) {
  const diagnostic = String(error.stack);
  for (const secret of secrets) assert.equal(diagnostic.includes(secret), false);
  return true;
}

test("默认数据目录跨安装版本稳定保留授权，隔离旧桥且不访问真实用户数据", async (t) => {
  const { root } = await fixture(t);
  const script = `
    import assert from "node:assert/strict";
    import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
    import { homedir } from "node:os";
    import { join } from "node:path";
    import { loadConfig, PLUGIN_VERSION } from ${JSON.stringify(moduleUrl)};
    assert.equal(homedir(), ${JSON.stringify(root)});
    assert.equal(PLUGIN_VERSION, "0.2.3");
    const oldDir = join(homedir(), ".zcode", "zcode-subscription-proxy", "data");
    await mkdir(join(oldDir, "auths"), { recursive: true });
    await writeFile(join(oldDir, "launcher-secrets.json"), JSON.stringify({ apiKey: "old-plugin-api", mgmtKey: "old-management" }));
    await writeFile(join(oldDir, "auths", "old-account.json"), "old-account");
    const config = await loadConfig({ pluginRoot: ${JSON.stringify(pluginRoot)}, env: {} });
    assert.equal(config.dataDir, join(homedir(), ".qoder", "qoder-subscription-proxy", "data"));
    assert.notEqual(config.apiKey, "old-plugin-api");
    assert.deepEqual(await readdir(config.dataDir), ["launcher-secrets.json"]);
    await mkdir(config.authDir);
    await writeFile(join(config.authDir, "account.json"), "current-account");
    const upgraded = await loadConfig({ pluginRoot: join(homedir(), "upgraded-plugin-install"), env: {} });
    assert.equal(upgraded.dataDir, config.dataDir);
    assert.equal(upgraded.apiKey, config.apiKey);
    assert.equal(await readFile(join(upgraded.authDir, "account.json"), "utf-8"), "current-account");
    assert.deepEqual(await readdir(upgraded.authDir), ["account.json"]);
    assert.equal(await readFile(join(oldDir, "auths", "old-account.json"), "utf-8"), "old-account");
  `;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: root, USERPROFILE: root },
    timeout: 15_000,
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("插件、市场和 MCP 对外版本保持一致", async () => {
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".qoder-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(await readFile(join(pluginRoot, "..", ".qoder-plugin", "marketplace.json"), "utf8"));
  const listing = marketplace.plugins.find((plugin) => plugin.name === manifest.name);
  assert.ok(listing);
  assert.equal(PLUGIN_VERSION, "0.2.3");
  assert.equal(manifest.version, PLUGIN_VERSION);
  assert.equal(listing.version, PLUGIN_VERSION);
  assert.equal(resolve(pluginRoot, "..", listing.source), pluginRoot);
});

test("Qoder 清单使用独立标识、根变量与 timeout 字段", async () => {
  for (const filename of [".mcp.json", ".mcp.posix.json"]) {
    const { mcpServers } = JSON.parse(await readFile(join(pluginRoot, filename), "utf8"));
    assert.deepEqual(Object.keys(mcpServers), ["qoder-subscription-proxy"]);
    const entry = mcpServers["qoder-subscription-proxy"];
    assert.equal(entry.timeout, 660000);
    assert.equal(entry.timeoutMs, undefined);
    assert.ok(entry.args.some(value => value.startsWith("${QODER_PLUGIN_ROOT}/scripts/")));
    assert.doesNotMatch(JSON.stringify(entry), /CLAUDE_PLUGIN_ROOT|zcode/i);
  }
  assert.notEqual(DEFAULT_PORT, 18787);
});

test("路径与派生地址符合接口，相对 bin/data 路径解析为绝对路径", async (t) => {
  const { root, load } = await fixture(t);
  const config = await load();
  assert.equal(PLUGIN_VERSION, "0.2.3");
  assert.equal(config.host, DEFAULT_HOST);
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 19787);
  assert.equal(config.binPath, resolveCoreBinaryPath({ dataDir: config.dataDir }));
  assert.equal(config.core.key, `${process.platform}-${process.arch}`);
  assert.equal(config.dataDir, join(root, "data"));
  assert.equal(config.endpoint, "http://127.0.0.1:19787/v1");
  assert.equal(config.managementUrl, "http://127.0.0.1:19787/management.html");
  for (const [key, suffix] of Object.entries({
    configPath: "config.yaml", authDir: "auths", pidPath: "bridge.pid", lockPath: "bridge.lock",
    pausedPath: "bridge.paused", imagesDir: "generated",
  })) assert.equal(config[key], join(config.dataDir, suffix));
  assert.deepEqual((await readdir(config.dataDir)).sort(), ["launcher-secrets.json"]);
  const relativeData = relative(process.cwd(), join(root, "relative-data"));
  const relativeBin = relative(process.cwd(), join(root, "cli-proxy-api.exe"));
  const custom = await load({ BRIDGE_DATA_DIR: relativeData, BRIDGE_BIN: relativeBin, BRIDGE_PORT: "9001" });
  assert.ok(isAbsolute(custom.binPath));
  assert.ok(isAbsolute(custom.dataDir));
  assert.equal(custom.binPath, resolve(relativeBin));
  assert.equal(custom.dataDir, resolve(relativeData));
  assert.equal(custom.endpoint, "http://127.0.0.1:9001/v1");
});

test("平台/架构只选择当前平台缓存路径，BRIDGE_BIN 显式禁用自动下载", async (t) => {
  const { root, env } = await fixture(t);
  for (const [platform, arch, path] of [
    ["win32", "x64", "qoder-plugin-subscription-proxy.exe"],
    ["darwin", "x64", "darwin-x64/qoder-plugin-subscription-proxy"],
    ["darwin", "arm64", "darwin-arm64/qoder-plugin-subscription-proxy"],
    ["linux", "x64", "linux-x64/qoder-plugin-subscription-proxy"],
    ["linux", "arm64", "linux-arm64/qoder-plugin-subscription-proxy"],
  ]) {
    const config = await loadConfig({ pluginRoot, env, platform, arch });
    assert.equal(config.binPath, join(config.dataDir, "runtimes", "v8.0.42", `${platform}-${arch}`, path.split("/").at(-1)));
    assert.equal(config.core.key, `${platform}-${arch}`);
    assert.equal(config.core.version, "v8.0.42");
    for (const bin of [join(root, "自定义 core"), relative(process.cwd(), join(root, "relative core"))]) {
      const custom = await loadConfig({ pluginRoot, env: { ...env, BRIDGE_BIN: bin }, platform, arch });
      assert.equal(custom.binPath, resolve(bin));
      assert.equal(custom.core, null);
    }
    const upgraded = await loadConfig({ pluginRoot: join(root, "other-install"), env, platform, arch });
    assert.equal(upgraded.binPath, config.binPath);
  }
});

test("不支持的平台/架构在任何写入前失败，BRIDGE_BIN 不得绕过支持边界", async (t) => {
  const { root, env } = await fixture(t);
  for (const [platform, arch] of [
    ["win32", "arm64"], ["win32", "ia32"], ["linux", "arm"], ["linux", "riscv64"],
    ["darwin", "ia32"], ["freebsd", "x64"], ["aix", "ppc64"], ["android", "arm64"],
    ["constructor", "prototype"], ["Linux", "x64"],
  ]) {
    for (const bin of [undefined, join(root, "explicit-core")]) {
      await assert.rejects(loadConfig({ pluginRoot, env: { ...env, BRIDGE_BIN: bin }, platform, arch }), (error) => {
        assert.match(error.message, /不支持的平台\/架构/);
        assert.ok(error.message.includes(`${platform}/${arch}`));
        assert.match(error.message, /BRIDGE_BIN/);
        return true;
      });
    }
  }
  for (const value of [null, false, 1, {}, [], "", " ", "bad\0input"]) {
    await assert.rejects(loadConfig({ pluginRoot, env, platform: value, arch: "x64" }), /platform/);
    await assert.rejects(loadConfig({ pluginRoot, env, platform: "linux", arch: value }), /arch/);
  }
  assert.deepEqual(await readdir(root), []);
});

test("配置解析不检查、执行或修复核心文件权限", async (t) => {
  const { root, env } = await fixture(t);
  const installedRoot = join(root, "isolated-plugin");
  const path = resolveCoreBinaryPath({ dataDir: env.BRIDGE_DATA_DIR, platform: "linux", arch: "x64" });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not-an-executable", { mode: 0o600 });
  const before = await stat(path);
  const config = await loadConfig({ pluginRoot: installedRoot, env, platform: "linux", arch: "x64" });
  assert.equal(config.binPath, path);
  assert.equal((await stat(path)).mode, before.mode);
  assert.equal(await readFile(path, "utf-8"), "not-an-executable");
});

test("纯十进制端口边界有效，非法输入必须报错而非部分解析或回退", async (t) => {
  const { load } = await fixture(t);
  for (const raw of ["1", "65535", "8787", "008787"]) {
    assert.equal((await load({ BRIDGE_PORT: raw })).port, Number(raw));
  }
  for (const raw of ["", "0", "65536", "-1", "+80", "80x", "80.0", "8e3", "0x50", " 80", "80 ", "80\n", "１２３", "99999999999999999999", 80, null, false]) {
    await assert.rejects(load({ BRIDGE_PORT: raw }), /BRIDGE_PORT/);
  }
});

test("仅允许 127.0.0.1，输入错误不创建密钥文件", async (t) => {
  const { env, load } = await fixture(t);
  for (const host of ["0.0.0.0", "localhost", "::1", "[::1]", "127.0.0.2", "192.168.1.3", "127.0.0.1 ", "", 123]) {
    await assert.rejects(load({ BRIDGE_HOST: host }), /BRIDGE_HOST/);
  }
  await assert.rejects(stat(env.BRIDGE_DATA_DIR), { code: "ENOENT" });
});

test("环境变量类型与空字符串均严格校验，不拼接原始输入", async (t) => {
  const { env } = await fixture(t);
  for (const name of ["BRIDGE_BIN", "BRIDGE_DATA_DIR", "BRIDGE_HOST", "BRIDGE_PORT", "BRIDGE_API_KEY", "BRIDGE_MGMT_KEY"]) {
    for (const value of [false, 123, {}, [], null, "", " ", "sensitive-input\0"]) {
      await assert.rejects(loadConfig({ pluginRoot, env: { ...env, [name]: value } }), (error) => {
        assert.ok(error.message.includes(name));
        return noSecret(error, ["sensitive-input"]);
      });
    }
  }
  for (const value of [undefined, 42, "", "\0"]) {
    await assert.rejects(loadConfig({ pluginRoot: value, env }), /pluginRoot/);
  }
  for (const value of [null, "string", [], false]) {
    await assert.rejects(loadConfig({ pluginRoot, env: value }), /env/);
  }
  await assert.rejects(stat(env.BRIDGE_DATA_DIR), { code: "ENOENT" });
});

test("仅持久化随机 API 密钥，固定管理密码独立且环境覆盖不轮换默认密钥", async (t) => {
  const { root, load } = await fixture(t);
  const first = await load();
  assert.match(first.apiKey, /^[0-9a-f]{64}$/);
  assert.equal(first.mgmtKey, "123456");
  assert.notEqual(first.apiKey, first.mgmtKey);
  const secretsPath = join(first.dataDir, "launcher-secrets.json");
  const before = await readFile(secretsPath, "utf-8");
  assert.deepEqual(JSON.parse(before), { apiKey: first.apiKey });
  if (process.platform !== "win32") assert.equal((await stat(secretsPath)).mode & 0o777, 0o600);
  const repeated = await load();
  assert.equal(repeated.apiKey, first.apiKey);
  assert.equal(repeated.mgmtKey, first.mgmtKey);
  const overridden = await load({ BRIDGE_API_KEY: "explicit-api", BRIDGE_MGMT_KEY: "123456" });
  assert.equal(overridden.apiKey, "explicit-api");
  assert.equal(overridden.mgmtKey, "123456");
  assert.equal(await readFile(secretsPath, "utf-8"), before);
  const other = await load({ BRIDGE_DATA_DIR: join(root, "other") });
  assert.notEqual(other.apiKey, first.apiKey);
  assert.equal(other.mgmtKey, first.mgmtKey);
});

test("管理密码不可覆盖，API 密钥不可复用公共密码，拒绝时不写文件或回显输入", async (t) => {
  const { env, load } = await fixture(t);
  for (const value of ["PRIVATE-MGMT-OVERRIDE", "123456 ", " 123456", "123456\n"]) {
    await assert.rejects(load({ BRIDGE_MGMT_KEY: value }), (error) => {
      assert.match(error.message, /BRIDGE_MGMT_KEY/);
      return noSecret(error, [value]);
    });
  }
  await assert.rejects(load({ BRIDGE_API_KEY: "123456" }), /BRIDGE_API_KEY/);
  await assert.rejects(stat(env.BRIDGE_DATA_DIR), { code: "ENOENT" });
  const config = await load();
  const secretsPath = join(config.dataDir, "launcher-secrets.json");
  const before = await readFile(secretsPath, "utf-8");
  await assert.rejects(load({ BRIDGE_MGMT_KEY: "PRIVATE-MGMT-OVERRIDE" }), /BRIDGE_MGMT_KEY/);
  await assert.rejects(load({ BRIDGE_API_KEY: "123456" }), /BRIDGE_API_KEY/);
  assert.equal(await readFile(secretsPath, "utf-8"), before);
});

test("YAML 字符串使用安全转义，换行/引号/反斜杠/Unicode 不注入字段", async (t) => {
  const { load } = await fixture(t);
  const apiKey = 'api-"\\\nserver:\n  host: 0.0.0.0\t#quote\u0085\u2028\u2029';
  const mgmtKey = "mgmt-'\"\\\r\n: secret\t#escaped";
  const config = await load({ BRIDGE_API_KEY: apiKey });
  const rendered = renderConfigYaml({ ...config, mgmtKey });
  const defaults = renderConfigYaml(config);
  assert.match(defaults, /  secret-key: "123456"\n/);
  assert.match(defaults, /  allow-remote: false\n/);
  assert.match(defaults, /  disable-control-panel: false\n/);
  assert.match(rendered, /multimedia:\n(?:  #[^\n]*\n)?  disable-image-generation: "passthrough"\n/);
  assert.equal(rendered.split("\n").filter((line) => line === "server:").length, 1);
  const apiLine = rendered.split("\n").find((line) => line.startsWith("    - "));
  const mgmtLine = rendered.split("\n").find((line) => line.startsWith("  secret-key: "));
  const authLine = rendered.split("\n").find((line) => line.startsWith("  auth-dir: "));
  assert.equal(JSON.parse(apiLine.slice(6)), apiKey);
  assert.equal(JSON.parse(mgmtLine.slice(14)), mgmtKey);
  assert.equal(JSON.parse(authLine.slice(12)), config.authDir);
  assert.doesNotMatch(rendered, /[\u0085\u2028\u2029]/);
  assert.doesNotThrow(() => validateExistingConfig(config, rendered));
  const synthetic = { ...config, authDir: config.authDir + '-"\n\t#injected' };
  assert.doesNotThrow(() => validateExistingConfig(synthetic, renderConfigYaml(synthetic)));
});

test("已存在 YAML 允许 API key 列表包含当前密钥与上游管理哈希", async (t) => {
  const { load } = await fixture(t);
  const config = await load({ BRIDGE_API_KEY: "test-api" });
  const text = renderConfigYaml(config)
    .replace('  host: "127.0.0.1"', "  host: 127.0.0.1 # loopback")
    .replace('  secret-key: "123456"', '  secret-key: "$2a$10$already-hashed"')
    .replace('    - "test-api"', "    - 'other-key'\n    - 'test-api' # current")
    .replace(JSON.stringify(config.authDir), JSON.stringify(config.authDir.replace(/\\/g, "/")));
  assert.doesNotThrow(() => validateExistingConfig(config, text));
  assert.doesNotThrow(() => validateExistingConfig(config, text.replace(/    - /g, "  - ")));
  await writeFile(config.configPath, text, { flag: "wx", mode: 0o600 });
  assert.equal((await load({ BRIDGE_API_KEY: "test-api" })).mgmtKey, "123456");
  assert.equal(await readFile(config.configPath, "utf-8"), text);
});

test("接受上游回写的数字开头普通密钥、四空格缩进及无额外缩进列表", async (t) => {
  const { load } = await fixture(t);
  const config = await load({ BRIDGE_API_KEY: "7a123456" });
  const text = [
    "config-version: 8",
    "server:",
    "    host: 127.0.0.1",
    "    port: 19787",
    "    tls:",
    "        enable: false",
    "management:",
    "    secret-key: $2a$10$upstreamhash",
    "    allow-remote: false",
    "access:",
    "    api-keys:",
    "    - 7a123456",
    "oauth:",
    `    auth-dir: ${JSON.stringify(config.authDir)}`,
    "multimedia:",
    "    disable-image-generation: passthrough",
  ].join("\r\n");
  assert.doesNotThrow(() => validateExistingConfig(config, text));
});

test("管理页保存的模型别名和供应商映射列表可在新会话重新加载", async (t) => {
  const { load } = await fixture(t);
  const config = await load();
  for (const listIndent of [4, 6]) {
    const pad = " ".repeat(listIndent);
    const text = renderConfigYaml(config).replace("oauth:\n", [
      "oauth:", "  model-alias:", "    codex:",
      `${pad}- name: gpt-5`, `${pad}  alias: primary-model`, `${pad}  fork: true`,
      `${pad}- name: gpt-6-sol`, `${pad}  alias: secondary-model`, "",
    ].join("\n")) + [
      "api-keys:", "  openai-compatibility:", "    - name: custom-provider",
      '      base-url: "https://api.example.test/v1"', "      api-key-entries:",
      '        - api-key: "isolated-provider-key"', "      models:",
      "        - name: custom-model", "          alias: custom-alias", "",
    ].join("\n");
    assert.doesNotThrow(() => validateExistingConfig(config, text));
    await writeFile(config.configPath, text);
    assert.equal((await load()).apiKey, config.apiKey);
    assert.equal(await readFile(config.configPath, "utf8"), text);
    assert.throws(() => validateExistingConfig(config, text.replace("alias: primary-model", "alias: primary-model\n" + pad + "  alias: duplicate")), /结构不受支持/);
  }
});

test("列表内映射不能冒充核心安全字段，错误缩进和标量后的子键仍被拒绝", async (t) => {
  const { load } = await fixture(t);
  const config = await load();
  const original = renderConfigYaml(config);
  for (const text of [
    original.replace('  host: "127.0.0.1"', '  - host: "127.0.0.1"'),
    original.replace(`    - ${JSON.stringify(config.apiKey)}`, `    - key: ${JSON.stringify(config.apiKey)}`),
    original + 'extra:\n  - server:\n      host: 127.0.0.1\n',
  ]) {
    if (text.startsWith(original)) {
      assert.doesNotThrow(() => validateExistingConfig(config, text));
      assert.throws(() => validateExistingConfig(config, text.replace('  host: "127.0.0.1"', '  host: "0.0.0.0"')), /server.host/);
    } else assert.throws(() => validateExistingConfig(config, text));
  }
  for (const suffix of [
    "extra:\n  - name: first\n   alias: wrong-indent\n",
    "extra:\n  - scalar\n    nested: invalid\n",
    "extra:\n  - name: first\n  alias: mixed-list-map\n",
  ]) assert.throws(() => validateExistingConfig(config, original + suffix), /结构不受支持/);
});

test("已有 YAML 核心字段不一致/缺失必须拒绝，不泄露输入正文或密钥", async (t) => {
  const { root, load } = await fixture(t);
  const apiKey = "PRIVATE-API-MARKER";
  const mgmtKey = "123456";
  const config = await load({ BRIDGE_API_KEY: apiKey });
  const original = renderConfigYaml(config);
  for (const text of [
    original.replace('  host: "127.0.0.1"', '  host: "0.0.0.0"'),
    original.replace("  port: 19787", "  port: 8788"),
    original.replace(apiKey, "OTHER-SECRET-MARKER"),
    original.replace(JSON.stringify(config.authDir), JSON.stringify(join(root, "foreign-auths"))),
    original.replace("  port: 19787\n", ""),
    original.replace("config-version: 8", "config-version: 7"),
    original.replace(JSON.stringify(config.authDir), '"auths"'),
  ]) {
    assert.throws(() => validateExistingConfig(config, text), (error) =>
      noSecret(error, [apiKey, mgmtKey, "OTHER-SECRET-MARKER", original, text]));
  }
  await writeFile(config.configPath, original, { flag: "wx", mode: 0o600 });
  await assert.rejects(load({ BRIDGE_API_KEY: apiKey, BRIDGE_PORT: "9000" }), /server.port/);
  await assert.rejects(load({ BRIDGE_API_KEY: "NEW-SECRET-MARKER" }), (error) => {
    assert.match(error.message, /access.api-keys/);
    return noSecret(error, [apiKey, mgmtKey, "NEW-SECRET-MARKER"]);
  });
  assert.equal(await readFile(config.configPath, "utf-8"), original);
});

test("已有 YAML 必须显式禁用远程管理，缺失或伪布尔值在加载和直接校验时均拒绝", async (t) => {
  const { load } = await fixture(t);
  const config = await load();
  const original = renderConfigYaml(config);
  const unsafe = [
    original.replace("  allow-remote: false\n", ""),
    ...["true", '"false"', "'false'", "null", "~", "0", "[]", "{}"].map((value) =>
      original.replace("  allow-remote: false", `  allow-remote: ${value}`)),
    original.replace("  allow-remote: false", "  allow-remote:\n    nested: false"),
  ];
  for (const text of unsafe) {
    assert.throws(() => validateExistingConfig(config, text), /management\.allow-remote/);
    await writeFile(config.configPath, text, { mode: 0o600 });
    await assert.rejects(load(), (error) => {
      assert.match(error.message, /management\.allow-remote/);
      return noSecret(error, [config.apiKey, config.mgmtKey, text]);
    });
    assert.equal(await readFile(config.configPath, "utf-8"), text);
  }
  assert.doesNotThrow(() => validateExistingConfig(config,
    original.replace("  allow-remote: false", "  allow-remote: false # local only")));
});

test("不假装支持通用 YAML：拒绝重复键、锚点、合并、标签、流式和多行结构", async (t) => {
  const { load } = await fixture(t);
  const config = await load({ BRIDGE_API_KEY: "PRIVATE-YAML-API" });
  const original = renderConfigYaml(config);
  for (const text of [
    `${original}server:\n  host: 0.0.0.0\n`,
    original.replace("  port: 19787", "  port: 19787\n  port: 9000"),
    original.replace("  allow-remote: false", "  allow-remote: false\n  allow-remote: true"),
    original.replace("  allow-remote: false", "  allow-remote: true\n  allow-remote: false"),
    original.replace("server:", "server: &listener"),
    original.replace("server:", "server:\n  <<: *listener"),
    original.replace('  host: "127.0.0.1"', "  host: !!str 127.0.0.1"),
    original.replace('  host: "127.0.0.1"', "  host: |\n    127.0.0.1"),
    original.replace('  host: "127.0.0.1"', '  host: "127.0.0.1\n    "'),
    original.replace('    - "PRIVATE-YAML-API"', '    - { key: "PRIVATE-YAML-API" }'),
    original.replace('  api-keys:\n    - "PRIVATE-YAML-API"', '  api-keys: ["PRIVATE-YAML-API"]'),
    original.replace("  port: 19787", "  port: 19787\n   unknown: value"),
    `${original}---\nserver:\n  host: 0.0.0.0\n`,
    `${original}unknown: !secret PRIVATE-YAML-API\n`,
    original.replace('"PRIVATE-YAML-API"', '"PRIVATE-YAML-API\\q"'),
  ]) {
    assert.throws(() => validateExistingConfig(config, text), (error) => {
      assert.match(error.message, /结构不受支持/);
      return noSecret(error, [config.apiKey, config.mgmtKey]);
    });
  }
});

test("共享 YAML 读取支持引号路径键且按解码后的真实片段隔离", async (t) => {
  const { load } = await fixture(t);
  const config = await load();
  const condition = 'messages.#(role=="system")#.content';
  const suffix = [
    "payload:", "  rules:", '    - "params":',
    `        ${JSON.stringify(condition)}: "keep"`,
    "        'it''s.a.path': 'single'", "        reasoning.effort: low",
    '"server.host": "0.0.0.0"',
    '"server[0].host": "other"',
    "logging:", "  level: debug", "  file: '/tmp/old.log'", "",
  ].join("\n");
  const text = renderConfigYaml(config) + suffix;
  const { values, lines } = parseConfigYaml(text);
  assert.equal(values.get(JSON.stringify(["payload", "rules", 0, "params", condition])), "keep");
  assert.equal(values.get(JSON.stringify(["payload", "rules", 0, "params", "it's.a.path"])), "single");
  assert.equal(values.get(JSON.stringify(["payload", "rules", 0, "params", "reasoning.effort"])), "low");
  assert.equal(values.get(JSON.stringify(["server", "host"])), "127.0.0.1");
  assert.equal(values.get(JSON.stringify(["server.host"])), "0.0.0.0");
  assert.equal(values.get(JSON.stringify(["logging", "file"])), "/tmp/old.log");
  assert.equal(lines.join("\n"), text);
  assert.doesNotThrow(() => validateExistingConfig(config, text));
  const unsafe = text.replace('  host: "127.0.0.1"', '  host: "0.0.0.0"')
    .replace('"server.host": "0.0.0.0"', '"server.host": "127.0.0.1"');
  assert.throws(() => validateExistingConfig(config, unsafe), /server.host/);
  assert.throws(() => validateExistingConfig(config, text.replace('  host: "127.0.0.1"\n', '') +
    'extra:\n  - "server":\n      "host": "127.0.0.1"\n'), /server.host/);
  await writeFile(config.configPath, text);
  await load();
  assert.equal(await readFile(config.configPath, "utf8"), text);
});

test("共享 YAML 读取拒绝解码重复键、控制字符键及合并等扩展", () => {
  for (const text of [
    'server: 1\n"server": 2', "server: 1\n'server': 2",
    '"server": 1\n"\\u0073erver": 2',
    "extra:\n  - name: one\n    'name': two",
    ...["\0", "\n", "\t", "\u007f", "\u0085", "\u2028"].map((key) => `${JSON.stringify(key)}: value`),
    '"<<": {}', "'<<': {}", "<<: *anchor", "extra: &anchor value", "extra: *anchor",
    "extra: !tag value", "extra: [one]", "extra: {one: two}", "extra: |\n  value",
  ]) assert.throws(() => parseConfigYaml(text), /结构不受支持/);
});

test("共享 YAML 节点定位覆盖两/四空格、无额外缩进列表及 CRLF", () => {
  for (const width of [2, 4]) {
    for (const extra of [0, width]) {
      const pad = " ".repeat(width);
      const listPad = " ".repeat(width + extra);
      const lines = ["root:", `${pad}items:`, `${listPad}- name: first`, `${listPad}  alias: second`,
        `${listPad}- scalar`, `${pad}empty:`, "next: true", ""];
      const { nodes, values, newline, lines: parsedLines } = parseConfigYaml(lines.join("\r\n"));
      assert.equal(newline, "\r\n");
      assert.deepEqual(parsedLines, lines);
      const node = (...path) => nodes.get(JSON.stringify(path));
      assert.deepEqual(node(), { line: -1, end: 8, indent: -1, childIndent: 0, kind: "map", raw: undefined });
      assert.deepEqual(node("root"), { line: 0, end: 6, indent: 0, childIndent: width, kind: "map", raw: undefined });
      assert.deepEqual(node("root", "items"), { line: 1, end: 5, indent: width, childIndent: width + extra, kind: "list", raw: undefined });
      assert.deepEqual(node("root", "items", 0), { line: 2, end: 4, indent: width + extra, childIndent: width + extra + 2, kind: "map", raw: undefined });
      assert.deepEqual(node("root", "items", 0, "name"), { line: 2, end: 3, indent: width + extra + 2, childIndent: null, kind: null, raw: "first" });
      assert.deepEqual(node("root", "items", 1), { line: 4, end: 5, indent: width + extra, childIndent: null, kind: null, raw: "scalar" });
      assert.deepEqual(node("root", "empty"), { line: 5, end: 6, indent: width, childIndent: null, kind: null, raw: undefined });
      assert.deepEqual(values.get(JSON.stringify(["root", "items"])), [null, "scalar"]);
      assert.equal(values.get(JSON.stringify(["root", "items", 1])), "scalar");
      assert.equal(node("next").end, lines.length);
    }
  }
});

test("损坏的 secrets 不重新生成且异常不回显敏感内容", async (t) => {
  const { env, load } = await fixture(t);
  await mkdir(env.BRIDGE_DATA_DIR);
  const path = join(env.BRIDGE_DATA_DIR, "launcher-secrets.json");
  for (const text of [
    '{"apiKey":"PRIVATE-JSON-SECRET", malformed',
    JSON.stringify({ apiKey: "PRIVATE-JSON-SECRET", mgmtKey: "PRIVATE-JSON-SECRET" }),
    JSON.stringify({ apiKey: "PRIVATE-JSON-SECRET", mgmtKey: false }),
    JSON.stringify({ apiKey: "PRIVATE-JSON-SECRET", mgmtKey: "123456" }),
    JSON.stringify({ apiKey: "123456" }),
    JSON.stringify({ apiKey: false }),
    JSON.stringify({ apiKey: "" }),
    JSON.stringify({ apiKey: "PRIVATE-JSON-SECRET\0" }),
    JSON.stringify({ mgmtKey: "123456" }),
    "{}", "null", "[]",
  ]) {
    await writeFile(path, text, { mode: 0o600 });
    await assert.rejects(load(), (error) => noSecret(error, ["PRIVATE-JSON-SECRET", text]));
    assert.equal(await readFile(path, "utf-8"), text);
  }
});

test("首次同进程并发加载只发布一组完整密钥并清理临时文件", async (t) => {
  const { load } = await fixture(t);
  const configs = await Promise.all(Array.from({ length: 24 }, () => load()));
  assert.equal(new Set(configs.map((config) => config.apiKey)).size, 1);
  assert.equal(new Set(configs.map((config) => config.mgmtKey)).size, 1);
  assert.notEqual(configs[0].apiKey, configs[0].mgmtKey);
  assert.deepEqual(await readdir(configs[0].dataDir), ["launcher-secrets.json"]);
});

test("首次跨进程并发加载原子发布密钥，无半份文件或互相覆盖", { timeout: 20_000 }, async (t) => {
  const { root, env, load } = await fixture(t);
  const startAt = Date.now() + 1000;
  const script = `
    import { createHash } from "node:crypto";
    import { loadConfig } from ${JSON.stringify(moduleUrl)};
    await new Promise(resolve => setTimeout(resolve, Math.max(0, ${startAt} - Date.now())));
    const config = await loadConfig({ pluginRoot: ${JSON.stringify(pluginRoot)}, env: ${JSON.stringify(env)} });
    process.stdout.write(createHash("sha256").update(config.apiKey + ":" + config.mgmtKey).digest("hex"));
  `;
  const results = await Promise.all(Array.from({ length: 8 }, () => execFileAsync(
    process.execPath, ["--input-type=module", "-e", script], { cwd: root, timeout: 15_000 },
  )));
  assert.equal(new Set(results.map((result) => result.stdout)).size, 1);
  for (const result of results) {
    assert.match(result.stdout, /^[0-9a-f]{64}$/);
    assert.equal(result.stderr, "");
  }
  const config = await load();
  const secrets = JSON.parse(await readFile(join(config.dataDir, "launcher-secrets.json"), "utf-8"));
  assert.equal(config.apiKey, secrets.apiKey);
  assert.equal(config.mgmtKey, "123456");
  assert.deepEqual(Object.keys(secrets), ["apiKey"]);
  assert.notEqual(config.apiKey, config.mgmtKey);
  assert.deepEqual(await readdir(config.dataDir), ["launcher-secrets.json"]);
});
