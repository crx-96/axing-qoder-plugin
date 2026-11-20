import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Windows 使用系统 PowerShell 持有原生 Job 和三个 stdio 句柄，直到 MCP 或宿主退出。 */
function startWindowsMcp() {
  // 指定系统程序和当前解释器的绝对路径，避免从用户 PATH 重新选择运行时。
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const wrapper = fileURLToPath(new URL('./start-mcp.ps1', import.meta.url));
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', wrapper, '-RuntimePath', process.execPath, '-LauncherPid', String(process.pid)], {
    stdio: 'inherit', windowsHide: true,
  });
  // stdout 完全属于 MCP。启动失败只给出 stderr 摘要，正常关闭则透传服务退出码。
  child.once('error', () => { process.stderr.write('qoder-subscription-proxy: 无法启动 Windows PowerShell。\n'); });
  child.once('close', code => { process.exitCode = code === null || code < 0 ? 1 : code; });
}

// Electron 须将 Node 模式传给复用 execPath 的后续解释器；普通 Node 沿用宿主环境。
if (process.versions.electron) process.env.ELECTRON_RUN_AS_NODE = '1';
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('qoder-subscription-proxy: 需要 Node.js 22 或以上的 Qoder 运行时。\n');
  process.exitCode = 1;
} else if (process.platform === 'win32' && process.arch === 'x64') {
  startWindowsMcp();
} else if (['darwin', 'linux'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch)) {
  // POSIX 直接在宿主所启动的进程内服务，保留 PID、信号、字节流和 EOF 语义。
  await import('../server/mcp-server.mjs');
} else {
  process.stderr.write(`qoder-subscription-proxy: 不支持 ${process.platform}-${process.arch}。\n`);
  process.exitCode = 1;
}
