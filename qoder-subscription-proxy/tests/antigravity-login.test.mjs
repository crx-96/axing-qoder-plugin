import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const scriptPath = fileURLToPath(new URL("../scripts/antigravity-login.ps1", import.meta.url));
const launcherPath = fileURLToPath(new URL("../Antigravity授权.cmd", import.meta.url));
const windows = process.platform === "win32";
const state = "unit-test-State_Sensitive.001";
const code = "unit-test-code-sensitive/with+symbols=";
const callbackBase = "http://localhost:51121/oauth-callback";
const callback = `${callbackBase}?code=${encodeURIComponent(code)}&state=${state}`;
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(callbackBase)}&state=${state}&response_type=code`;
const secretError = "PRIVATE_UPSTREAM_ERROR_TOKEN_must_not_be_printed";
const bootstrap = `
$ErrorActionPreference = 'Stop'
. $env:ANTIGRAVITY_TEST_SCRIPT
`;

async function powershell(source, values = {}) {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(bootstrap + source, "utf16le").toString("base64")], {
    env: { ...process.env, ANTIGRAVITY_TEST_SCRIPT: scriptPath, ...values },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const [exitCode] = await once(child, "close");
    assert.notEqual(exitCode, null, "PowerShell 测试必须在有界时间内退出");
    return { exitCode, output };
  } finally { clearTimeout(timer); }
}

async function localServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  assert.notEqual(port, 8787);
  assert.notEqual(port, 19787);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return port;
}

function assertNoSecrets(output) {
  for (const sensitive of ["123456", state, code, authUrl, callback, secretError]) {
    assert.ok(!output.includes(sensitive), `控制台不能泄露测试凭据或完整 URL: ${sensitive}`);
  }
}

function jsonResponse(response, body) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function mockService(t, { authorize, accept, status } = {}) {
  const requests = [];
  let pollCount = 0;
  const port = await localServer(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.url === "/v8/management/oauth/auth-url?provider=antigravity&is_webui=false") {
      if (authorize) return authorize(request, response);
      return jsonResponse(response, { status: "ok", url: authUrl, state });
    }
    if (request.url === "/v8/management/oauth/callback") {
      if (accept) return accept(request, response);
      return jsonResponse(response, { status: "ok" });
    }
    if (request.url === `/v8/management/oauth/status?state=${state}`) {
      pollCount++;
      if (status) return status(request, response, pollCount);
      return jsonResponse(response, { status: pollCount === 1 ? "wait" : "ok" });
    }
    response.writeHead(404).end(secretError);
  });
  return { port, requests };
}

async function runLogin(port, { pasted = callback, sessionSeconds = 300, delayInput = false, env = {} } = {}) {
  return powershell(`
if ($env:ANTIGRAVITY_TEST_SYSTEM_PROXY) {
    [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy($env:ANTIGRAVITY_TEST_SYSTEM_PROXY)
}
function Start-Process {
    param([string]$FilePath, [string]$ErrorAction)
    if ($FilePath -cne $env:ANTIGRAVITY_TEST_AUTH_URL) { throw 'Unexpected browser destination' }
    Write-Host 'TEST_BROWSER_OPENED'
}
function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'Callback must use secure input' }
    Write-Host 'TEST_INPUT_HIDDEN'
    if ($env:ANTIGRAVITY_TEST_DELAY_INPUT -eq 'yes') { Start-Sleep -Milliseconds 1100 }
    return (ConvertTo-SecureString $env:ANTIGRAVITY_TEST_CALLBACK -AsPlainText -Force)
}
$exitCode = Invoke-AntigravityLogin -Port ([int]$env:ANTIGRAVITY_TEST_PORT) -SessionTimeoutSeconds ([int]$env:ANTIGRAVITY_TEST_SESSION_SECONDS) -PollIntervalMilliseconds 10
exit $exitCode
`, {
    ANTIGRAVITY_TEST_PORT: String(port), ANTIGRAVITY_TEST_AUTH_URL: authUrl,
    ANTIGRAVITY_TEST_CALLBACK: pasted, ANTIGRAVITY_TEST_SESSION_SECONDS: String(sessionSeconds),
    ANTIGRAVITY_TEST_DELAY_INPUT: delayInput ? "yes" : "no", ...env,
  });
}

test("Antigravity 启动器仅依赖 Windows PowerShell，脚本使用可兼容 WinPS5.1 的 ASCII", async () => {
  const source = await readFile(scriptPath);
  const launcher = await readFile(launcherPath, "utf8");
  assert.ok([...source].every((byte) => byte < 128));
  assert.match(launcher, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(launcher, /%~dp0scripts\\antigravity-login\.ps1/);
  assert.doesNotMatch(launcher, /\bnode(?:\.exe)?\s/i);
  assert.doesNotMatch(source.toString(), /HttpListener|TcpListener/);
});

test("Antigravity URL 校验拒绝非 Google、非预期回调、重复参数和错 state", { skip: !windows }, async () => {
  const goodAuth = { status: "ok", url: authUrl, state };
  const invalidAuth = [
    { ...goodAuth, url: authUrl.replace("https:", "http:") },
    { ...goodAuth, url: authUrl.replace("accounts.google.com", "accounts.google.com.evil.invalid") },
    { ...goodAuth, url: authUrl.replace("accounts.google.com", "accounts.google.com:444") },
    { ...goodAuth, url: authUrl.replace("accounts.google.com", "user@accounts.google.com") },
    { ...goodAuth, url: authUrl.replace("accounts.google.com", "@accounts.google.com") },
    { ...goodAuth, url: authUrl.replace(encodeURIComponent(callbackBase), encodeURIComponent("http://127.0.0.1:51121/oauth-callback")) },
    { ...goodAuth, url: `${authUrl}&state=${state}` },
    { ...goodAuth, url: `${authUrl}&%73tate=${state}` },
    { ...goodAuth, url: `${authUrl}&redirect_uri=${encodeURIComponent(callbackBase)}` },
    { ...goodAuth, url: authUrl.replace(state, state.toLowerCase()) },
    { ...goodAuth, url: `${authUrl}#` },
    { ...goodAuth, state: "" },
    { ...goodAuth, state: "bad..state" },
    { ...goodAuth, state: "bad/state" },
    { ...goodAuth, state: "a".repeat(129) },
    { ...goodAuth, state: [state] },
    { ...goodAuth, status: ["ok"] },
    { ...goodAuth, status: "OK" },
  ];
  const invalidCallbacks = [
    callback.replace("http:", "https:"),
    callback.replace("localhost", "127.0.0.1"),
    callback.replace("localhost", "localhost.evil.invalid"),
    callback.replace("localhost", "user@localhost"),
    callback.replace("localhost", "@localhost"),
    callback.replace("51121", "51122"),
    callback.replace("/oauth-callback?", "/other/../oauth-callback?"),
    callback.replace("/oauth-callback?", "/oauth-callback/?"),
    callback.replace("/oauth-callback?", "/%6fauth-callback?"),
    callback.replace("/oauth-callback?", "\\oauth-callback?"),
    `${callback}#`, `${callback}#fragment`,
    `${callback}&error=access_denied`, `${callback}&error=`,
    `${callback}&code=other`, `${callback}&%63ode=other`,
    `${callback}&state=${state}`, `${callback}&%73tate=${state}`,
    callback.replace(state, state.toLowerCase()),
    `${callbackBase}?code=x&state=`, `${callbackBase}?code=x`,
    `${callbackBase}?code=&state=${state}`, `${callbackBase}?code=%20&state=${state}`,
    `${callbackBase}?code=%ZZ&state=${state}`, `${callbackBase}?code=%0a&state=${state}`,
    `${callback}&flag`, ` ${callback}`, `${callback}\n`,
  ];
  const result = await powershell(`
$cases = $env:ANTIGRAVITY_TEST_CASES | ConvertFrom-Json
Assert-AntigravityAuthorization $cases.goodAuth
$decoded = ConvertFrom-AntigravityCallback $cases.goodCallback $cases.state
if ($decoded -cne $cases.code) { throw 'Code decoding changed the OAuth code' }
foreach ($candidate in $cases.invalidAuth) {
    $rejected = $false
    try { Assert-AntigravityAuthorization $candidate }
    catch { $rejected = $true; if (-not $_.Exception.Data['AntigravitySafeError']) { throw 'Unsafe validation error' } }
    if (-not $rejected) { throw 'Unsafe authorization URL accepted' }
}
$index = 0
foreach ($candidate in $cases.invalidCallbacks) {
    $rejected = $false
    try { $null = ConvertFrom-AntigravityCallback $candidate $cases.state }
    catch { $rejected = $true; if (-not $_.Exception.Data['AntigravitySafeError']) { throw 'Unsafe validation error' } }
    if (-not $rejected) { throw ('Unsafe callback URL accepted at test index ' + $index) }
    $index++
}
Write-Host 'URL_VALIDATION_PASSED'
`, { ANTIGRAVITY_TEST_CASES: JSON.stringify({ goodAuth, goodCallback: callback, state, code, invalidAuth, invalidCallbacks }) });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /URL_VALIDATION_PASSED/);
  assertNoSecrets(result.output);
});

test("Antigravity 安全 HTTP 全流程仅一次初始化、一次回调，并精确等待 wait -> ok", { skip: !windows }, async (t) => {
  let proxyRequests = 0;
  const proxyPort = await localServer(t, (_request, response) => { proxyRequests++; response.end("proxy"); });
  const { port, requests } = await mockService(t);
  const proxy = `http://127.0.0.1:${proxyPort}`;
  const result = await runLogin(port, { env: {
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: "",
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: "",
    ANTIGRAVITY_TEST_SYSTEM_PROXY: proxy,
  } });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(proxyRequests, 0);
  assert.match(result.output, /TEST_BROWSER_OPENED/);
  assert.match(result.output, /TEST_INPUT_HIDDEN/);
  assert.match(result.output, /authorization completed successfully/);
  assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "GET", "GET"]);
  assert.deepEqual(JSON.parse(requests[1].body), { provider: "antigravity", state, code });
  assert.match(requests[1].headers["content-type"], /^application\/json/);
  assert.ok(requests.every(({ headers }) => headers.authorization === "Bearer 123456" && headers.host === `127.0.0.1:${port}`));
  assertNoSecrets(result.output);
});

test("Antigravity 管理接口重定向不能转发 Bearer，错误正文不输出且不重试", { skip: !windows }, async (t) => {
  let destinationRequests = 0;
  const destination = await localServer(t, (_request, response) => { destinationRequests++; response.end(secretError); });
  const { port, requests } = await mockService(t, { authorize: (_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${destination}/stolen` });
    response.end(secretError);
  } });
  const result = await runLogin(port);
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /HTTP 302/);
  assert.equal(destinationRequests, 0);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(result.output, /TEST_BROWSER_OPENED|TEST_INPUT_HIDDEN|completed successfully/);
  assertNoSecrets(result.output);
});

test("Antigravity 拒绝服务返回的危险授权地址，不打开浏览器", { skip: !windows }, async (t) => {
  const { port, requests } = await mockService(t, { authorize: (_request, response) => jsonResponse(response, {
    status: "ok", state, url: authUrl.replace("accounts.google.com", "evil.invalid"),
  }) });
  const result = await runLogin(port);
  assert.equal(result.exitCode, 1, result.output);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(result.output, /TEST_BROWSER_OPENED|TEST_INPUT_HIDDEN/);
  assertNoSecrets(result.output);
});

test("Antigravity 错 state 和重复参数在回调提交前终止", { skip: !windows }, async (t) => {
  for (const pasted of [callback.replace(state, state.toLowerCase()), `${callback}&code=duplicate`]) {
    const { port, requests } = await mockService(t);
    const result = await runLogin(port, { pasted });
    assert.equal(result.exitCode, 1, result.output);
    assert.equal(requests.length, 1);
    assert.doesNotMatch(result.output, /Callback accepted|completed successfully/);
    assertNoSecrets(result.output);
  }
});

test("Antigravity 回调被接受不等于成功，status=error 时安全失败", { skip: !windows }, async (t) => {
  const { port, requests } = await mockService(t, { status: (_request, response) => jsonResponse(response, { status: "error", error: secretError }) });
  const result = await runLogin(port);
  assert.equal(result.exitCode, 1, result.output);
  assert.equal(requests.length, 3);
  assert.match(result.output, /Callback accepted/);
  assert.doesNotMatch(result.output, /completed successfully/);
  assertNoSecrets(result.output);
});

test("Antigravity 回调 HTTP 失败不重发、不轮询且不泄露正文", { skip: !windows }, async (t) => {
  const { port, requests } = await mockService(t, { accept: (_request, response) => response.writeHead(500).end(secretError) });
  const result = await runLogin(port);
  assert.equal(result.exitCode, 1, result.output);
  assert.equal(requests.length, 2);
  assert.match(result.output, /HTTP 500/);
  assert.doesNotMatch(result.output, /Callback accepted|completed successfully/);
  assertNoSecrets(result.output);
});

test("Antigravity 非契约状态不能误判成功，包括大小写和数组", { skip: !windows }, async (t) => {
  for (const badStatus of ["OK", "pending", ["ok"]]) {
    const { port, requests } = await mockService(t, { status: (_request, response) => jsonResponse(response, { status: badStatus }) });
    const result = await runLogin(port);
    assert.equal(result.exitCode, 1, result.output);
    assert.equal(requests.length, 3);
    assert.doesNotMatch(result.output, /completed successfully/);
    assertNoSecrets(result.output);
  }
});

test("Antigravity 手动输入耗时计入会话期限，超时不提交 callback", { skip: !windows }, async (t) => {
  const { port, requests } = await mockService(t);
  const result = await runLogin(port, { sessionSeconds: 1, delayInput: true });
  assert.equal(result.exitCode, 1, result.output);
  assert.equal(requests.length, 1);
  assert.match(result.output, /timed out/);
  assertNoSecrets(result.output);
});

test("Antigravity 连续 wait 在总时限内终止，不重复 auth 或 callback", { skip: !windows }, async (t) => {
  const { port, requests } = await mockService(t, { status: (_request, response) => jsonResponse(response, { status: "wait" }) });
  const result = await runLogin(port, { sessionSeconds: 2 });
  assert.equal(result.exitCode, 1, result.output);
  assert.equal(requests.filter(({ url }) => url.includes("auth-url")).length, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith("/callback")).length, 1);
  assert.ok(requests.length > 2);
  assert.match(result.output, /timed out/);
  assertNoSecrets(result.output);
});

test("Antigravity 请求总超时包含持续分块响应，不无限等待", { skip: !windows }, async (t) => {
  let requests = 0;
  const port = await localServer(t, (_request, response) => {
    requests++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"status":"wait","error":"');
    const interval = setInterval(() => response.write("."), 15);
    response.once("close", () => clearInterval(interval));
  });
  const result = await powershell(`
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
    $null = Invoke-AntigravityLocalRequest -Port ([int]$env:ANTIGRAVITY_TEST_PORT) -Operation 'auth-url' -TimeoutMilliseconds 250
    throw 'Request unexpectedly completed'
} catch {
    if (-not $_.Exception.Data['AntigravitySafeError']) { throw 'Unexpected error classification' }
    if ($clock.ElapsedMilliseconds -gt 3000) { throw 'Timeout was extended by response bytes' }
    Write-Host $_.Exception.Message
}
`, { ANTIGRAVITY_TEST_PORT: String(port) });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(requests, 1);
  assert.match(result.output, /timed out/);
  assertNoSecrets(result.output);
});

test("Antigravity 禁止空 state 发起 status 请求，dot-source 不执行登录", { skip: !windows }, async (t) => {
  let requests = 0;
  const port = await localServer(t, (_request, response) => { requests++; jsonResponse(response, { status: "ok" }); });
  const result = await powershell(`
try {
    $null = Invoke-AntigravityLocalRequest -Port ([int]$env:ANTIGRAVITY_TEST_PORT) -Operation 'status' -State ''
    throw 'Empty state was accepted'
} catch {
    if (-not $_.Exception.Data['AntigravitySafeError']) { throw 'Unexpected error classification' }
    Write-Host 'EMPTY_STATE_REJECTED'
}
`, { ANTIGRAVITY_TEST_PORT: String(port) });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(requests, 0);
  assert.match(result.output, /EMPTY_STATE_REJECTED/);
  assertNoSecrets(result.output);
});
