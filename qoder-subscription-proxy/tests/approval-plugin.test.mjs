import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareApprovalRouter, inspectApprovalRouter, ensureApprovalPluginConfig, assertApprovalPluginRegistered } from "../server/approval-plugin.mjs";
import { parseConfigYaml } from "../server/config-yaml.mjs";
import { ensureApprovalRouting } from "../server/approval-routing.mjs";
import { probeApprovalRouter } from "../server/supervisor.mjs";

const platform = `${process.platform}-${process.arch}`;
const file = `qoder-approval-router.${process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so"}`;
const bytes = Buffer.from("isolated native library fixture, never executed");
const digest = createHash("sha256").update(bytes).digest("hex");

async function fixture(t, { source = false, missing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qoder-approval-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "server"));
  const artifact = source ? join(root, ".approval-build", platform) : join(root, "server", "approval-router");
  const config = { dataDir: join(root, "data"), port: 8317 };
  const manifest = { abiVersion: 1, platform, file, sha256: digest };
  if (!missing) {
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(artifact, file), bytes);
  }
  return { root, artifact, config, manifest, options: { pluginRoot: root }, directory: join(config.dataDir, "approval-router", digest) };
}

async function makeLink(t, target, path, type) {
  try { await symlink(target, path, type); return true; }
  catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
      t.skip("当前 Windows token 不允许创建符号链接");
      return false;
    }
    throw error;
  }
}

test("安装结果仅含独立库，返回接口固定且并发/重复安装幂等", async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => prepareApprovalRouter(f.config, f.options)));
  for (const result of results) assert.deepEqual(result, { directory: f.directory, sha256: digest });
  assert.deepEqual(await readdir(f.directory), [file]);
  assert.deepEqual(await readFile(join(f.directory, file)), bytes);
  if (process.platform !== "win32") {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.directory, file))).mode & 0o777, 0o600);
  }
});

for (const [target, extension] of [["win32-x64", "dll"], ["darwin-x64", "dylib"], ["darwin-arm64", "dylib"], ["linux-x64", "so"], ["linux-arm64", "so"]]) {
  test(`五平台固定文件映射：${target}`, async t => {
    const f = await fixture(t);
    const targetFile = `qoder-approval-router.${extension}`;
    await rm(join(f.artifact, file));
    await writeFile(join(f.artifact, targetFile), bytes);
    await writeFile(join(f.artifact, "manifest.json"), JSON.stringify({ ...f.manifest, platform: target, file: targetFile }));
    const result = await prepareApprovalRouter(f.config, { ...f.options, platform: target });
    assert.deepEqual(await readdir(result.directory), [targetFile]);
  });
}

test("随包目录不存在才使用源码本平台产物", async t => {
  const f = await fixture(t, { source: true });
  assert.equal((await prepareApprovalRouter(f.config, f.options)).sha256, digest);
  await mkdir(join(f.root, "server", "approval-router"));
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /缺失.*拒绝回退/);
});

test("源码未构建明确提示构建命令，不下载不生成库", async t => {
  const f = await fixture(t, { missing: true });
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /node scripts\/build-approval-router\.mjs/);
  assert.deepEqual(await readdir(f.root), ["server"]);
});

for (const [label, patch] of [
  ["ABI", { abiVersion: 2 }], ["平台", { platform: "linux-other" }],
  ["路径逃逸", { file: "../qoder-approval-router.dll" }], ["其他库", { file: "other.dll" }],
  ["非规范摘要", { sha256: "A".repeat(64) }], ["额外字段", { url: "https://invalid.example" }],
  ["内容摘要", { sha256: "a".repeat(64) }],
]) {
  test(`拒绝 manifest ${label}`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.artifact, "manifest.json"), JSON.stringify({ ...f.manifest, ...patch }));
    await assert.rejects(prepareApprovalRouter(f.config, f.options), /manifest|SHA256/);
  });
}

test("拒绝损坏 JSON 和不支持的平台", async t => {
  const f = await fixture(t);
  await writeFile(join(f.artifact, "manifest.json"), "{");
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /manifest/);
  await assert.rejects(prepareApprovalRouter(f.config, { ...f.options, platform: "win32-arm64" }), /不支持/);
});

test("拒绝发布目录额外文件与缺失库", async t => {
  const f = await fixture(t);
  await writeFile(join(f.artifact, "other.so"), "user");
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /混入/);
  await rm(join(f.artifact, "other.so"));
  await rm(join(f.artifact, file));
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /缺失/);
});

for (const item of ["manifest.json", file]) {
  test(`拒绝源码文件符号链接：${item}`, async t => {
    const f = await fixture(t);
    const target = join(f.root, "outside");
    await writeFile(target, item === file ? bytes : JSON.stringify(f.manifest));
    await rm(join(f.artifact, item));
    if (!await makeLink(t, target, join(f.artifact, item), "file")) return;
    await assert.rejects(prepareApprovalRouter(f.config, f.options), /符号链接/);
  });
}

test("拒绝随包目录链接且不回退源码", async t => {
  const f = await fixture(t, { source: true });
  if (!await makeLink(t, f.artifact, join(f.root, "server", "approval-router"), "junction")) return;
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /符号链接/);
});

test("拒绝硬链接、空文件与目录伪装动态库", async t => {
  const f = await fixture(t);
  await link(join(f.artifact, file), join(f.root, "hardlink"));
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /硬链接/);
  await rm(join(f.root, "hardlink"));
  await writeFile(join(f.artifact, file), "");
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /空文件/);
  await rm(join(f.artifact, file));
  await mkdir(join(f.artifact, file));
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /文件异常/);
});

test("已有版本内容损坏或混入用户文件不覆盖不删除", async t => {
  const f = await fixture(t);
  await prepareApprovalRouter(f.config, f.options);
  await writeFile(join(f.directory, file), "user changed");
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /不匹配/);
  assert.equal(await readFile(join(f.directory, file), "utf8"), "user changed");
  await writeFile(join(f.directory, file), bytes);
  await writeFile(join(f.directory, "user.so"), "user");
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /混入/);
  assert.equal(await readFile(join(f.directory, "user.so"), "utf8"), "user");
});

test("已有空版本目录或安装根链接均拒绝，不接管外部目录", async t => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true });
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /缺失/);
  await rm(join(f.config.dataDir, "approval-router"), { recursive: true });
  const outside = join(f.root, "external");
  await mkdir(outside);
  if (!await makeLink(t, outside, join(f.config.dataDir, "approval-router"), "junction")) return;
  await assert.rejects(prepareApprovalRouter(f.config, f.options), /符号链接/);
  assert.deepEqual(await readdir(outside), []);
});

test("只读检查不创建目录，核心生成的普通 .shadow 缓存不妨碍复用", async t => {
  const f = await fixture(t);
  await assert.rejects(inspectApprovalRouter(f.config, f.options), /尚未加载/);
  await assert.rejects(stat(f.config.dataDir), { code: "ENOENT" });
  const installed = await prepareApprovalRouter(f.config, f.options);
  const shadow = join(f.directory, ".shadow");
  await mkdir(shadow);
  await writeFile(join(shadow, `cliproxy-plugin-qoder-approval-router-${digest.slice(0, 32)}.${file.split(".").at(-1)}`), bytes);
  assert.deepEqual(await inspectApprovalRouter(f.config, f.options), installed);
  assert.deepEqual(await prepareApprovalRouter(f.config, f.options), installed);
  await rm(shadow, { recursive: true });
  await writeFile(shadow, "not a directory");
  await assert.rejects(inspectApprovalRouter(f.config, f.options), /不是普通目录/);
  await rm(shadow);
  const external = join(f.root, "external-shadow");
  await mkdir(external);
  if (!await makeLink(t, external, shadow, "junction")) return;
  await assert.rejects(inspectApprovalRouter(f.config, f.options), /符号链接/);
});

test("配置保留 Codex 和普通模型参数及本插件用户字段，往返幂等", async t => {
  const f = await fixture(t);
  const original = ensureApprovalRouting('requests:\n  retries: 7\nplugins:\n  enabled: false\n  dir: plugins\n  configs:\n    qoder-approval-router:\n      priority: 3\n      custom: keep\n');
  const updated = ensureApprovalPluginConfig(original, f.config, f.directory);
  const parsed = parseConfigYaml(updated);
  const value = path => parsed.values.get(JSON.stringify(path));
  assert.equal(value(["plugins", "enabled"]), true);
  assert.equal(value(["plugins", "dir"]), f.directory);
  assert.equal(value(["plugins", "configs", "qoder-approval-router", "enabled"]), true);
  assert.equal(value(["plugins", "configs", "qoder-approval-router", "priority"]), 100);
  assert.equal(value(["plugins", "configs", "qoder-approval-router", "custom"]), "keep");
  for (const [path, before] of parseConfigYaml(original).values) {
    if (JSON.parse(path)[0] !== "plugins") assert.deepEqual(parsed.values.get(path), before);
  }
  assert.equal(ensureApprovalPluginConfig(updated, f.config, f.directory), updated);
  // 核心回写会取消普通 key 的引号；本模块新键均为 lowercase，不新增 camelCase。
  const rewritten = updated.replace(/"(enabled|priority|dir)":/g, "$1:");
  assert.equal(ensureApprovalPluginConfig(rewritten, f.config, f.directory), rewritten);
});

for (const initial of ["", "plugins: {}\n", "plugins: null\n", "plugins:\n  dir: \"\"\n  configs: {}\n", "plugins:\n  dir: ./plugins\n"]) {
  test(`缺省或空插件配置可展开：${JSON.stringify(initial)}`, async t => {
    const f = await fixture(t);
    const updated = ensureApprovalPluginConfig(initial, f.config, f.directory);
    assert.equal(ensureApprovalPluginConfig(updated, f.config, f.directory), updated);
  });
}

test("managed 升级只迁移本插件 dir，不触碰旧目录", async t => {
  const f = await fixture(t);
  const old = join(f.config.dataDir, "approval-router", "a".repeat(64));
  const original = ensureApprovalPluginConfig("", f.config, old);
  const updated = ensureApprovalPluginConfig(original, f.config, f.directory);
  assert.equal(parseConfigYaml(updated).values.get('["plugins","dir"]'), f.directory);
});

for (const initial of [
  'plugins:\n  dir: user-libs\n',
  'plugins:\n  configs:\n    other:\n      enabled: false\n',
  'plugins:\n  enabled: []\n',
  'plugins:\n  configs: []\n',
  'plugins:\n  dir: {}\n',
]) {
  test(`拒绝用户插件冲突或异常容器：${JSON.stringify(initial)}`, async t => {
    const f = await fixture(t);
    assert.throws(() => ensureApprovalPluginConfig(initial, f.config, f.directory));
  });
}

test("插件元数据必须证明 registered、effective_enabled 和独立目录身份", async t => {
  const f = await fixture(t);
  const body = { plugins_enabled: true, plugins_dir: f.directory, plugins: [{
    id: "qoder-approval-router", path: join(f.directory, file), configured: true,
    enabled: true, registered: true, effective_enabled: true, metadata: { name: "qoder-approval-router" },
  }] };
  assert.doesNotThrow(() => assertApprovalPluginRegistered(body, f.directory));
  await assert.doesNotReject(probeApprovalRouter(f.config, f.directory, { request: async (config, path, options) => {
    assert.equal(config, f.config);
    assert.equal(path, "/v0/management/plugins");
    assert.deepEqual(options, { management: true });
    return { status: 200, text: JSON.stringify(body) };
  } }));
  for (const response of [{ status: 404, text: "" }, { status: 200, text: "bad json" }]) {
    await assert.rejects(probeApprovalRouter(f.config, f.directory, { request: async () => response }), /失败|不是 JSON/);
  }
  for (const field of ["configured", "enabled", "registered", "effective_enabled"]) {
    const invalid = structuredClone(body);
    invalid.plugins[0][field] = false;
    assert.throws(() => assertApprovalPluginRegistered(invalid, f.directory), /未实际注册/);
  }
  for (const invalid of [{}, { ...body, plugins_enabled: false }, { ...body, plugins_dir: f.root },
    { ...body, plugins: [{ ...body.plugins[0], metadata: { name: "other" } }] },
    { ...body, plugins: [...body.plugins, { id: "other" }] }]) {
    assert.throws(() => assertApprovalPluginRegistered(invalid, f.directory), /未实际注册/);
  }
});
