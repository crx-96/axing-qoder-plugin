param(
    [string]$OwnerPid,
    [string]$BinPath,
    [string]$ConfigPath,
    [string]$WorkingDirectory,
    [string]$LogPath,
    # Native web port; the gateway address comes from the core environment.
    [ValidateRange(1, 65535)][int]$ManagementPort,
    # Private JSON environment for the core; the supervisor itself compiles with the host environment.
    [string]$CoreEnvPath
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

    [Console]::Error.WriteLine('proxy-supervisor stage=start')
    # Windows PowerShell 5.1 compiles this source with the .NET Framework compiler.
    # Keep compiler diagnostics and PowerShell object formatting off the MCP pipes.
    Add-Type -Path (Join-Path $PSScriptRoot 'ProxyJob.cs') -ErrorAction Stop | Out-Null
    [Console]::Error.WriteLine('proxy-supervisor stage=compiled')
    if ($CoreEnvPath) {
        if (-not (Test-Path -LiteralPath $CoreEnvPath)) { throw 'Core environment file is missing.' }
        $coreEnv = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($CoreEnvPath, [Text.Encoding]::UTF8))
        foreach ($name in @([Environment]::GetEnvironmentVariables().Keys)) {
            try { [Environment]::SetEnvironmentVariable([string]$name, $null) } catch { }
        }
        foreach ($property in $coreEnv.PSObject.Properties) {
            [Environment]::SetEnvironmentVariable([string]$property.Name, [string]$property.Value)
        }
        try { [IO.File]::Delete($CoreEnvPath) } catch { }
    }
    [Console]::Error.WriteLine('proxy-supervisor stage=core')
    $result = [Qoder.SubscriptionProxy.ProxyJob]::Run(
        $OwnerPid, $BinPath, $ConfigPath, $WorkingDirectory, $LogPath, $ManagementPort
    )
    [Console]::Error.WriteLine('proxy-supervisor stage=returned')
    exit $result
}
catch {
    # Paths, source diagnostics and exception messages may contain private data.
    try { [Console]::Error.WriteLine('Proxy supervisor initialization failed.') } catch { }
    exit 1
}
