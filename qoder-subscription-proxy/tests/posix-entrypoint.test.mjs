import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shell = process.platform === "win32"
  ? join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "sh.exe")
  : "/bin/sh";
const execute = promisify(execFile);
const shellAvailable = await access(shell).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const shellSkip = shellAvailable ? false : "没有可用的 /bin/sh 或 Git Bash sh，不能执行 POSIX 脚本测试";
const launcherText = await readFile(join(root, "scripts", "start-mcp.sh"), "utf8");
const prepareText = await readFile(join(root, "scripts", "prepare-posix-marketplace.sh"), "utf8");

function posixPath(path) {
  return process.platform === "win32" ? path.replaceAll("\\", "/").replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`) : path;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function temporary(t, label) {
  const path = await mkdtemp(join(tmpdir(), `订阅代理 中文 空格-${label}-`));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return path;
}

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function executable(path, content) {
  await put(path, `#!/bin/sh\n${content}\n`);
  await chmod(path, 0o755);
}

async function runShell(script, args = [], options = {}) {
  return await execute(shell, [posixPath(script), ...args], { timeout: 15000, windowsHide: true, ...options });
}

function isolatedEnv(bin, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  const path = process.platform === "win32"
    ? [bin, dirname(shell)].join(";")
    : `${bin}:/usr/bin:/bin`;
  return { ...env, PATH: path, ...overrides };
}

async function runtimeFixture(t, { system = "Linux", architecture = "x86_64" } = {}) {
  const directory = await temporary(t, "运行时 '单引号 $字面量");
  const scripts = join(directory, "插件", "scripts");
  const bin = join(directory, "fake-bin");
  const log = join(directory, "runtime.log");
  await mkdir(bin, { recursive: true });
  await put(join(scripts, "start-mcp.sh"), launcherText);
  await put(join(scripts, "mcp-server.mjs"), `process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => process.stdout.write(chunk));
process.stdin.on("end", () => { process.stderr.write("selected=" + process.env.POSIX_SELECTED + "\\n"); process.exitCode = Number(process.env.POSIX_TEST_EXIT || 0); });\n`);
  await executable(join(bin, "uname"), `case "$1" in -s) printf '%s\\n' ${quote(system)} ;; -m) printf '%s\\n' ${quote(architecture)} ;; *) exit 1 ;; esac`);
  await executable(join(bin, "readlink"), "exit 1");
  return { directory, scripts, bin, log, launcher: join(scripts, "start-mcp.sh"), env: isolatedEnv(bin) };
}

async function fakeRuntime(fixture, path, { name, electron = false, version, fail = false } = {}) {
  const patches = [];
  if (electron) patches.push('Object.defineProperty(process.versions,"electron",{value:"test-electron",configurable:true}); if(process.env.ELECTRON_RUN_AS_NODE!=="1") process.exit(9);');
  if (version) patches.push(`Object.defineProperty(process.versions,"node",{value:${JSON.stringify(version)},configurable:true});`);
  const preload = patches.length ? `--import ${quote(`data:text/javascript,${encodeURIComponent(patches.join("\n"))}`)} ` : "";
  await executable(path, `printf '%s|%s|%s\\n' ${quote(name)} "\${ELECTRON_RUN_AS_NODE-unset}" "$1" >> ${quote(posixPath(fixture.log))}
export POSIX_SELECTED=${quote(name)}
${process.platform === "win32" ? 'if [ "$1" != -e ]; then set -- "$(cygpath -w "$1")"; fi' : ""}
${fail ? "exit 1" : `exec ${quote(posixPath(process.execPath))} ${preload}"$@"`}`);
}

async function fakeAncestor(fixture, path) {
  await executable(join(fixture.bin, "readlink"), `case "$1" in /proc/*/exe) printf '%s\\n' ${quote(posixPath(path))} ;; *) exit 1 ;; esac`);
}

async function runtimeRoundtrip(fixture, input = '{"jsonrpc":"2.0","id":"中文 空格 \\" $字面量"}\n') {
  const promise = execute(shell, [posixPath(fixture.launcher)], { env: fixture.env, timeout: 15000, windowsHide: true });
  promise.child.stdin.end(input);
  const result = await promise;
  assert.equal(result.stdout, input);
  return result;
}

async function sourceFixture(t) {
  const directory = await temporary(t, "市场 '引号 $字面量");
  const repository = join(directory, "源仓库 中文 空格");
  const plugin = join(repository, "qoder-subscription-proxy");
  const target = join(directory, "目标市场 中文 空格 '保持字面量'");
  const catalog = { name: "axing-qoder-plugins", owner: { name: "crx-96" }, plugins: [{ name: "qoder-subscription-proxy", source: "./qoder-subscription-proxy", version: "0.2.2" }] };
  await put(join(repository, ".qoder-plugin", "marketplace.json"), JSON.stringify(catalog, null, 2) + "\n");
  await put(join(repository, "README.md"), "市场安装说明 fixture\n");
  await put(join(repository, "LICENSE"), "市场许可证 fixture\n");
  await put(join(plugin, ".qoder-plugin", "plugin.json"), JSON.stringify({ name: "qoder-subscription-proxy", version: "0.2.2", mcpServers: "./.mcp.json" }));
  await copyFile(join(root, ".mcp.posix.json"), join(plugin, ".mcp.posix.json"));
  await copyFile(join(root, ".mcp.json"), join(plugin, ".mcp.json"));
  for (const file of ["README.md", "LICENSE", "DISCLAIMER.md", "THIRD_PARTY_NOTICES.md", "Antigravity授权.cmd", "bridge/panel/LICENSE", "bridge/panel/management.upstream.html", "bridge/bin/LICENSE", "bridge/bin/README.md", "bridge/bin/README_CN.md", "bridge/bin/config.example.yaml", "bridge/bin/platforms.json", "bridge/bin/qoder-plugin-subscription-proxy.exe", "bridge/config.mjs", "bridge/core-runtime.mjs", "bridge/posix-supervisor.mjs", "scripts/antigravity-login.ps1", "scripts/image-preview.ps1", "scripts/mcp-server.mjs", "scripts/proxy-supervisor.ps1", "scripts/proxy-supervisor.mjs", "scripts/ProxyJob.cs", "scripts/start-mcp.ps1"]) {
    await put(join(plugin, file), `fixture: ${file}\n`);
  }
  for (const platform of ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
    const binary = join(plugin, "bridge", "bin", platform, "qoder-plugin-subscription-proxy");
    await put(binary, `#!/bin/sh\n# fake binary ${platform}\nexit 0\n`);
    await chmod(binary, 0o644);
  }
  await put(join(plugin, "scripts", "start-mcp.sh"), launcherText);
  const prepare = join(plugin, "scripts", "prepare-posix-marketplace.sh");
  await put(prepare, prepareText);
  for (const file of ["data/auth.json", "bridge/data/auth.json", "tests/temporary/private.json", "unknown.tmp", "scripts/unknown.tmp", "bridge/unknown.tmp", "bridge/bin/unknown.tmp", "bridge/bin/CLIProxyAPI_8.0.38_windows_amd64.zip", "bridge/bin/CLIProxyAPI_8.0.38_linux_amd64.tar.gz", "bridge/bin/linux-x64/unknown.tmp", "bridge/panel/unknown.tmp", ".qoder-plugin/unknown.tmp"]) {
    await put(join(plugin, file), "must-not-copy-private-fixture\n");
  }
  return { directory, repository, plugin, target, prepare, catalog };
}

async function snapshot(directory) {
  const entries = {};
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = join(path, name);
      const metadata = await lstat(file);
      if (metadata.isDirectory()) await walk(file, relative);
      else entries[relative] = { bytes: (await readFile(file)).toString("base64"), mode: metadata.mode };
    }
  }
  await walk(directory);
  return entries;
}

test("POSIX 清单显式 sh 调用且默认 Windows 清单保留；新脚本 LF", async () => {
  const posix = JSON.parse(await readFile(join(root, ".mcp.posix.json"), "utf8"));
  const windows = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
  assert.equal(windows.mcpServers["qoder-subscription-proxy"].command, "powershell.exe");
  assert.equal(windows.mcpServers["qoder-subscription-proxy"].timeout, 660000);
  assert.deepEqual(posix.mcpServers["qoder-subscription-proxy"], { type: "stdio", command: "/bin/sh", args: ["${QODER_PLUGIN_ROOT}/scripts/start-mcp.sh"], timeout: 660000 });
  assert.ok(!launcherText.includes("\r"));
  assert.ok(!prepareText.includes("\r"));
});

test("Git Bash/fake Linux：PATH Node 22+、中文空格路径和 stdin/stdout 原样传递", { skip: shellSkip }, async (t) => {
  const fixture = await runtimeFixture(t);
  await fakeRuntime(fixture, join(fixture.bin, "node"), { name: "path-node" });
  const result = await runtimeRoundtrip(fixture);
  assert.equal(result.stderr, "selected=path-node\n");
  assert.match(await readFile(fixture.log, "utf8"), /path-node\|unset\|-e/);
});

test("Git Bash/fake Linux：精确 Qoder 祖先优于 PATH，探测及 exec 均设置 Electron Node 模式", { skip: shellSkip }, async (t) => {
  const fixture = await runtimeFixture(t);
  const ancestor = join(fixture.directory, "真实进程 中文", "Qoder CN");
  await fakeRuntime(fixture, ancestor, { name: "ancestor-electron", electron: true });
  await fakeRuntime(fixture, join(fixture.bin, "node"), { name: "unused-node" });
  await fakeAncestor(fixture, ancestor);
  assert.equal((await runtimeRoundtrip(fixture)).stderr, "selected=ancestor-electron\n");
  const log = await readFile(fixture.log, "utf8");
  assert.match(log, /ancestor-electron\|1\|-e/);
  assert.doesNotMatch(log, /unused-node/);
});

test("Git Bash/fake Linux：真实 Node 祖先可复用且非 Qoder 名称不会当 Electron 执行", { skip: shellSkip }, async (t) => {
  for (const basename of ["node", "NotQoder", "Qoder Helper"]) {
    const fixture = await runtimeFixture(t);
    const ancestor = join(fixture.directory, "祖先", basename);
    await fakeRuntime(fixture, ancestor, { name: "ancestor-node" });
    await fakeRuntime(fixture, join(fixture.bin, "node"), { name: "path-node" });
    await fakeAncestor(fixture, ancestor);
    assert.equal((await runtimeRoundtrip(fixture)).stderr, `selected=${basename === "node" ? "ancestor-node" : "path-node"}\n`);
    if (basename !== "node") assert.doesNotMatch(await readFile(fixture.log, "utf8"), /ancestor-node/);
  }
});

test("Git Bash/fake Linux：拒绝内置旧 Node 及并非 Electron 的同名进程后回退", { skip: shellSkip }, async (t) => {
  for (const options of [{ electron: true, version: "20.11.0" }, { electron: false }]) {
    const fixture = await runtimeFixture(t);
    const ancestor = join(fixture.directory, "祖先", "Qoder");
    await fakeRuntime(fixture, ancestor, { name: "invalid-ancestor", ...options });
    await fakeRuntime(fixture, join(fixture.bin, "node"), { name: "path-node" });
    await fakeAncestor(fixture, ancestor);
    assert.equal((await runtimeRoundtrip(fixture)).stderr, "selected=path-node\n");
  }
});

test("Git Bash/fake Linux：Node <22 或无有效运行时只向 stderr 清晰失败", { skip: shellSkip }, async (t) => {
  for (const options of [{ version: "21.9.0" }, { fail: true }]) {
    const fixture = await runtimeFixture(t);
    await fakeRuntime(fixture, join(fixture.bin, "node"), { name: "unavailable", ...options });
    await assert.rejects(runtimeRoundtrip(fixture), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /没有可用的 Node\.js 22\+/);
      return true;
    });
  }
});

test("Git Bash/fake Unix：拒绝不支持的 OS/架构并传递 MCP 退出码", { skip: shellSkip }, async (t) => {
  for (const options of [{ system: "MINGW64_NT" }, { architecture: "i686" }]) {
    const fixture = await runtimeFixture(t, options);
    await assert.rejects(runtimeRoundtrip(fixture), (error) => error.code === 1 && error.stdout === "" && /仅支持/.test(error.stderr));
  }
  const fixture = await runtimeFixture(t);
  await fakeRuntime(fixture, join(fixture.bin, "node"), { name: "path-node" });
  fixture.env.POSIX_TEST_EXIT = "7";
  await assert.rejects(runtimeRoundtrip(fixture), (error) => error.code === 7);
});

test("Git Bash/fake Darwin：HOME 标准 Qoder 候选仍执行版本探测", { skip: shellSkip || (process.platform !== "win32" ? "此项专门模拟 Git Bash 的 Darwin 分支；真实 macOS 在独立 smoke 测试验证" : false) }, async (t) => {
  const fixture = await runtimeFixture(t, { system: "Darwin", architecture: "arm64" });
  fixture.env.HOME = posixPath(join(fixture.directory, "独立 HOME"));
  await fakeRuntime(fixture, join(fixture.bin, "node"), { name: "old-node", version: "20.0.0" });
  const runtime = join(fixture.directory, "独立 HOME", "Applications", "Qoder.app", "Contents", "MacOS", "Qoder");
  await fakeRuntime(fixture, runtime, { name: "home-electron", electron: true });
  assert.equal((await runtimeRoundtrip(fixture)).stderr, "selected=home-electron\n");
});

test("prepare：生成独立市场、原样 catalog、POSIX 清单，不复制任何平台核心与归档，源文件不变", { skip: shellSkip }, async (t) => {
  const fixture = await sourceFixture(t);
  const before = await snapshot(fixture.repository);
  const result = await runShell(fixture.prepare, [posixPath(fixture.target)]);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /axing-qoder-plugins/);
  assert.match(result.stdout, /未自动注册、安装或启用/);
  assert.deepEqual(await snapshot(fixture.repository), before);
  assert.deepEqual(await readFile(join(fixture.target, ".qoder-plugin", "marketplace.json")), await readFile(join(fixture.repository, ".qoder-plugin", "marketplace.json")));
  for (const file of ["README.md", "LICENSE"]) {
    assert.deepEqual(await readFile(join(fixture.target, file)), await readFile(join(fixture.repository, file)));
  }
  const copy = join(fixture.target, "qoder-subscription-proxy");
  assert.deepEqual(await readFile(join(copy, ".mcp.json")), await readFile(join(fixture.plugin, ".mcp.posix.json")));
  assert.equal(JSON.parse(await readFile(join(fixture.plugin, ".mcp.json"))).mcpServers["qoder-subscription-proxy"].command, "powershell.exe");
  const copied = await snapshot(copy);
  assert.ok(copied["bridge/posix-supervisor.mjs"]);
  assert.ok(copied["scripts/proxy-supervisor.mjs"]);
  assert.ok(copied["Antigravity授权.cmd"]);
  assert.ok(copied["scripts/antigravity-login.ps1"]);
  assert.ok(copied["scripts/start-mcp.ps1"]);
  for (const file of Object.keys(copied)) assert.doesNotMatch(file, /(^|\/)data\/|(^|\/)tests\/|unknown\.tmp/);
  assert.ok(copied["bridge/core-runtime.mjs"]);
  assert.deepEqual(Object.keys(copied).filter((file) => file.startsWith("bridge/bin/")), [
    "bridge/bin/LICENSE", "bridge/bin/README.md", "bridge/bin/README_CN.md",
    "bridge/bin/config.example.yaml", "bridge/bin/platforms.json",
  ]);
  for (const file of Object.keys(copied)) assert.doesNotMatch(file, /\.(?:exe|zip|gz)$|bridge\/bin\/(?:darwin|linux)-/);
});

test("prepare：源目录没有任何平台二进制仍能完整打包许可证和下载清单", { skip: shellSkip }, async (t) => {
  const fixture = await sourceFixture(t);
  await rm(join(fixture.plugin, "bridge/bin/qoder-plugin-subscription-proxy.exe"));
  for (const platform of ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
    await rm(join(fixture.plugin, "bridge/bin", platform), { recursive: true });
  }
  await runShell(fixture.prepare, [posixPath(fixture.target)]);
  const copied = await snapshot(join(fixture.target, "qoder-subscription-proxy"));
  for (const file of ["bridge/core-runtime.mjs", "bridge/bin/LICENSE", "bridge/bin/platforms.json", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(copied[file]);
  }
  assert.equal(Object.keys(copied).some((file) => /\.(?:exe|zip|gz)$|bridge\/bin\/(?:darwin|linux)-/.test(file)), false);
});

test("prepare：拒绝重复目标（包括空目录）而且保留已有目标内容", { skip: shellSkip }, async (t) => {
  const fixture = await sourceFixture(t);
  await runShell(fixture.prepare, [posixPath(fixture.target)]);
  const before = await snapshot(fixture.target);
  await assert.rejects(runShell(fixture.prepare, [posixPath(fixture.target)]), (error) => error.code === 1 && /拒绝覆盖/.test(error.stderr));
  assert.deepEqual(await snapshot(fixture.target), before);
  const empty = join(fixture.directory, "已有空目录");
  await mkdir(empty);
  await assert.rejects(runShell(fixture.prepare, [posixPath(empty)]), (error) => error.code === 1 && /拒绝覆盖/.test(error.stderr));
  assert.deepEqual(await readdir(empty), []);
});

test("prepare：支持相对中文空格路径与尾斜杠，拒绝源仓库内目标和已安装缓存", { skip: shellSkip }, async (t) => {
  const fixture = await sourceFixture(t);
  const name = "-相对 目标 中文";
  await runShell(fixture.prepare, [`${name}/`], { cwd: fixture.directory });
  await access(join(fixture.directory, name, ".qoder-plugin", "marketplace.json"));
  await assert.rejects(runShell(fixture.prepare, [posixPath(join(fixture.repository, "不可写入源目录"))]), (error) => /不能位于源码仓库内/.test(error.stderr));
  const cache = join(fixture.directory, ".qoder", "cli", "plugins", "cache");
  await mkdir(cache, { recursive: true });
  await assert.rejects(runShell(fixture.prepare, [posixPath(join(cache, "新缓存"))]), (error) => /不能位于已安装插件缓存内/.test(error.stderr));
  await assert.rejects(access(join(cache, "新缓存")), { code: "ENOENT" });
});

test("prepare：缺失平台清单等必要源文件时失败并清理本次未完成副本", { skip: shellSkip }, async (t) => {
  const fixture = await sourceFixture(t);
  const missing = join(fixture.plugin, "bridge/bin/platforms.json");
  await rm(missing);
  const before = await snapshot(fixture.repository);
  await assert.rejects(runShell(fixture.prepare, [posixPath(fixture.target)]), (error) => /分发文件缺失/.test(error.stderr));
  await assert.rejects(access(fixture.target), { code: "ENOENT" });
  assert.deepEqual(await snapshot(fixture.repository), before);
});

test("prepare：拒绝符号链接目标及源分发目录，不跟随指向真实 data 的链接", { skip: shellSkip || (process.platform === "win32" ? "Windows Git Bash 的 symlink 语义不同；需真实 POSIX 文件系统验证" : false) }, async (t) => {
  const fixture = await sourceFixture(t);
  const existing = join(fixture.directory, "已有数据");
  await mkdir(existing);
  await symlink(existing, fixture.target);
  await assert.rejects(runShell(fixture.prepare, [fixture.target]), (error) => /拒绝覆盖/.test(error.stderr));
  await rm(fixture.target);
  const marketReadme = await readFile(join(fixture.repository, "README.md"));
  await rm(join(fixture.repository, "README.md"));
  await symlink(join(fixture.repository, "LICENSE"), join(fixture.repository, "README.md"));
  await assert.rejects(runShell(fixture.prepare, [fixture.target]), (error) => /市场分发文件缺失或是符号链接/.test(error.stderr));
  await assert.rejects(access(fixture.target), { code: "ENOENT" });
  await rm(join(fixture.repository, "README.md"));
  await writeFile(join(fixture.repository, "README.md"), marketReadme);
  await rm(join(fixture.plugin, "bridge/panel"), { recursive: true });
  await symlink(existing, join(fixture.plugin, "bridge/panel"));
  await assert.rejects(runShell(fixture.prepare, [fixture.target]), (error) => /分发目录缺失或是符号链接/.test(error.stderr));
  await assert.rejects(access(fixture.target), { code: "ENOENT" });
  assert.deepEqual(await readdir(existing), []);
});

for (const platform of ["linux", "darwin"]) {
  test(`真实 ${platform}：原生祖先进程查找、MCP initialize/ping 和 EOF（非模拟）`, { skip: process.platform !== platform ? `当前为 ${process.platform}；未实测 ${platform} 原生进程发现与 Qoder 桌面运行时` : shellSkip, timeout: 20000 }, async (t) => {
    const directory = await temporary(t, "原生协议");
    const request = [
      { jsonrpc: "2.0", id: "初始化", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "posix-test", version: "1" } } },
      { jsonrpc: "2.0", id: "中文 ping", method: "ping" },
    ];
    const env = { ...process.env, BRIDGE_DATA_DIR: join(directory, "不应创建的数据"), BRIDGE_PORT: "invalid" };
    const result = execute(shell, [join(root, "scripts", "start-mcp.sh")], { env, timeout: 15000 });
    result.child.stdin.end(request.map((value) => JSON.stringify(value)).join("\n") + "\n");
    const { stdout, stderr } = await result;
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert.equal(responses[0].id, "初始化");
    assert.equal(responses[0].result.protocolVersion, "2025-06-18");
    assert.deepEqual(responses[1], { jsonrpc: "2.0", id: "中文 ping", result: {} });
    assert.equal(stderr, "");
    await assert.rejects(access(env.BRIDGE_DATA_DIR), { code: "ENOENT" });
    t.diagnostic("已验证当前测试运行时下的原生启动；独立 Qoder Desktop Electron 祖先场景仍需目标桌面环境验证。");
  });
}
