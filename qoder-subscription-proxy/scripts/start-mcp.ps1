# A Desktop launch supplies the exact Node-mode interpreter and the PID of this wrapper's parent.
# Direct developer invocations retain the ancestor/installed Node resolution below.
param([string]$RuntimePath, [int]$LauncherPid)
$ErrorActionPreference = 'Stop'
$failure = 'qoder-subscription-proxy: runtime unavailable. Requires Windows x64, Windows PowerShell 5.1 and Qoder Desktop (or Node.js 22+ for development).'

try {
    if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'Windows x64 is required.'
    }

    # Retain the outermost Qoder host identity separately from the interpreter used to run the server.
    $current = $PID
    $seen = @{}
    $ancestorRuntime = $null
    $ownerPidText = $null
    while ($current -gt 0 -and -not $seen.ContainsKey($current) -and $seen.Count -lt 128) {
        $seen[$current] = $true
        try {
            $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $current"
        } catch {
            $failure = 'qoder-subscription-proxy: CIM/WMI process query failed. Cannot verify Qoder process ownership; check Windows Management Instrumentation service and access permissions. No runtime was started.'
            throw
        }
        if (-not $ancestor) { break }
        if ($LauncherPid -and $current -eq $PID -and $ancestor.ParentProcessId -ne $LauncherPid) {
            throw 'Launcher must be the immediate parent.'
        }
        if ($ancestor.ExecutablePath -and [IO.Path]::GetFileName($ancestor.ExecutablePath) -iin @('Qoder.exe', 'Qoder CN.exe')) {
            if (-not $ancestorRuntime) { $ancestorRuntime = $ancestor.ExecutablePath }
            $ownerPidText = [string]$ancestor.ProcessId
        }
        $current = [int]$ancestor.ParentProcessId
    }

    if ($LauncherPid) {
        # The common launcher already selected the interpreter and set Electron's child environment.
        if (-not $seen.ContainsKey($LauncherPid) -or -not [IO.Path]::IsPathRooted($RuntimePath)) {
            throw 'Unverified launcher or missing interpreter.'
        }
        if ($ownerPidText -and [int]$ownerPidText -ne $LauncherPid) {
            # An outer host can exit while another process still holds stdin. Pin its process handle
            # before the Job starts. Exiting this dedicated wrapper closes its private Job handle.
            $hostProcess = [Diagnostics.Process]::GetProcessById([int]$ownerPidText)
            $null = $hostProcess.Handle
            $watch = [PowerShell]::Create()
            $null = $watch.AddScript('param($hostProcess) $hostProcess.WaitForExit(); [Environment]::Exit(0)').AddArgument($hostProcess).BeginInvoke()
        }
        # The native wait also covers a forced kill of the host-visible launcher with stdin still open.
        $ownerPidText = [string]$LauncherPid
    } elseif ($ancestorRuntime) {
        $RuntimePath = $ancestorRuntime
        $env:ELECTRON_RUN_AS_NODE = '1'
    } else {
        $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw 'Launch this plugin inside Qoder; no Node runtime was found.' }
        $RuntimePath = $node.Source
    }

    # RunMcp starts the child without a console, assigns it atomically to the kill-on-close Job
    # and duplicates native stdio without PowerShell text transcoding.
    Add-Type -Path (Join-Path $PSScriptRoot 'ProxyJob.cs') -ErrorAction Stop | Out-Null
    $result = [Qoder.SubscriptionProxy.ProxyJob]::RunMcp(
        $ownerPidText, $RuntimePath, (Join-Path $PSScriptRoot '..\server\mcp-server.mjs')
    )
    # A dedicated wrapper must exit even if its background host wait is still pending.
    if ($LauncherPid) { [Environment]::Exit($result) }
    exit $result
} catch {
    [Console]::Error.WriteLine($failure)
    if ($LauncherPid) { [Environment]::Exit(1) }
    exit 1
}
