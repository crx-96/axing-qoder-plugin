$ErrorActionPreference = 'Stop'

try {
    if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'Windows x64 is required.'
    }

    # Resolve only the actual ancestor executable, never a guessed install/cache path.
    $current = $PID
    $seen = @{}
    $runtime = $null
    $ownerPidText = $null
    while ($current -gt 0 -and -not $seen.ContainsKey($current) -and $seen.Count -lt 128) {
        $seen[$current] = $true
        $ancestor = Get-CimInstance Win32_Process -Filter "ProcessId = $current"
        if (-not $ancestor) { break }
        if ($ancestor.ExecutablePath -and [IO.Path]::GetFileName($ancestor.ExecutablePath) -iin @('Qoder.exe', 'Qoder CN.exe')) {
            if (-not $runtime) { $runtime = $ancestor.ExecutablePath }
            $ownerPidText = [string]$ancestor.ProcessId
        }
        $current = [int]$ancestor.ParentProcessId
    }
    $electron = $null -ne $runtime
    if (-not $runtime) {
        $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $node) { throw 'Launch this plugin inside Qoder; no Node runtime was found.' }
        $runtime = $node.Source
    }

    # Only this wrapper's environment changes; the host and system remain untouched.
    if ($electron) { $env:ELECTRON_RUN_AS_NODE = '1' }
    # Atomically place Node in a private kill-on-close job, including when this
    # wrapper is forcibly killed. Native stdio duplicates bypass PowerShell's pipeline.
    Add-Type -Path (Join-Path $PSScriptRoot 'ProxyJob.cs') -ErrorAction Stop | Out-Null
    $result = [Qoder.SubscriptionProxy.ProxyJob]::RunMcp(
        $ownerPidText, $runtime, (Join-Path $PSScriptRoot 'mcp-server.mjs')
    )
    exit $result
} catch {
    [Console]::Error.WriteLine('qoder-subscription-proxy: runtime unavailable. Requires Windows x64, Windows PowerShell 5.1 and Qoder Desktop (or Node.js 22+ for development).')
    exit 1
}
