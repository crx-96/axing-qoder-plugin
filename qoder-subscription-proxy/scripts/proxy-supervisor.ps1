param(
    [string]$OwnerPid,
    [string]$BinPath,
    [string]$ConfigPath,
    [string]$WorkingDirectory,
    [string]$LogPath,
    # Native web port; the gateway address comes from the isolated parent environment.
    [ValidateRange(1, 65535)][int]$ManagementPort
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'

try {
    if ($args.Count -ne 0 -or -not [Environment]::Is64BitProcess) {
        throw 'Invalid supervisor invocation.'
    }

    # Windows PowerShell 5.1 compiles this source with the .NET Framework compiler.
    # Keep compiler diagnostics and PowerShell object formatting off the MCP pipes.
    Add-Type -Path (Join-Path $PSScriptRoot 'ProxyJob.cs') -ErrorAction Stop | Out-Null
    $result = [Qoder.SubscriptionProxy.ProxyJob]::Run(
        $OwnerPid, $BinPath, $ConfigPath, $WorkingDirectory, $LogPath, $ManagementPort
    )
    exit $result
}
catch {
    # Paths, source diagnostics and exception messages may contain private data.
    try { [Console]::Error.WriteLine('Proxy supervisor initialization failed.') } catch { }
    exit 1
}
