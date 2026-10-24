# Manual Antigravity OAuth handoff for Windows machines where port 51121 is reserved.
# This helper never opens a callback listener and never exchanges a code with Google.
# The local CLIProxyAPI management service owns the OAuth session and token exchange.
# Contract reference (wait/ok/error and the five-minute session lifetime):
# https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.38/internal/api/handlers/management/auth_files_provider_oauth.go
[CmdletBinding()]
param(
    # Local management port; the host is deliberately not configurable.
    [ValidateRange(1, 65535)][int]$Port = 19787
)

function Stop-AntigravityLogin {
    <# Raise a controlled diagnostic without including URLs, state, codes or response bodies. #>
    param(
        # Only these locally defined reasons may become user-visible messages.
        [ValidateSet('auth-url', 'callback-url', 'state', 'expired', 'rejected', 'response', 'http', 'transport', 'browser')]
        [string]$Reason,
        # Zero means no HTTP response was available; otherwise report only the status number.
        [ValidateRange(0, 599)][int]$HttpStatus = 0
    )
    # Keep diagnostics independent of exception messages returned by HTTP and JSON libraries.
    $messages = @{
        'auth-url' = 'The service returned an invalid Google authorization URL.'
        'callback-url' = 'The pasted callback URL is invalid or contains an OAuth error.'
        'state' = 'The OAuth state is missing, invalid, or does not match this attempt.'
        'expired' = 'This authorization attempt timed out. Start the helper again when ready.'
        'rejected' = 'The service reported authorization failure or an expired session.'
        'response' = 'The local service returned an unexpected response.'
        'http' = 'The local management request was rejected.'
        'transport' = 'The local management request failed or timed out; it was not retried.'
        'browser' = 'The default browser could not be opened; no callback was submitted.'
    }
    $message = $messages[$Reason]
    if ($HttpStatus -gt 0) { $message += ' HTTP ' + $HttpStatus + '.' }
    $failure = New-Object System.InvalidOperationException($message)
    $failure.Data['AntigravitySafeError'] = $true
    throw $failure
}

function Test-AntigravityState {
    <# Check the upstream state grammar before comparing or sending a session identifier. #>
    param(
        # JSON values must actually be strings, not values coerced from arrays or numbers.
        [AllowNull()][object]$State
    )
    return ($State -is [string] -and $State -cmatch '\A[A-Za-z0-9_.-]{1,128}\z' -and -not $State.Contains('..'))
}

function ConvertFrom-AntigravityQuery {
    <# Parse query parameters once, rejecting ambiguous duplicates and malformed escapes. #>
    param(
        # The URI query, including its leading question mark.
        [string]$Query,
        # Select the safe diagnostic for the caller, never the rejected query text.
        [ValidateSet('auth-url', 'callback-url')][string]$FailureReason
    )
    $values = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
    if ([string]::IsNullOrEmpty($Query) -or -not $Query.StartsWith('?')) {
        Stop-AntigravityLogin $FailureReason
    }
    # Decode names before checking uniqueness so encoded names cannot bypass validation.
    foreach ($part in $Query.Substring(1).Split('&')) {
        $pieces = $part -split '=', 2
        if ($pieces.Length -ne 2 -or $pieces[0].Length -eq 0 -or $part -match '%(?![0-9A-Fa-f]{2})') {
            Stop-AntigravityLogin $FailureReason
        }
        $name = [Uri]::UnescapeDataString($pieces[0].Replace('+', ' '))
        $value = [Uri]::UnescapeDataString($pieces[1].Replace('+', ' '))
        if ($values.ContainsKey($name) -or $name -match '[\x00-\x1f\x7f]' -or $value -match '[\x00-\x1f\x7f]') {
            Stop-AntigravityLogin $FailureReason
        }
        $values.Add($name, $value)
    }
    return ,$values
}

function Get-AntigravityValidatedUri {
    <# Reject URI normalization tricks before interpreting either externally supplied URL. #>
    param(
        # Original untrusted URL text; only absolute, bounded, whitespace-free URLs are accepted.
        [AllowNull()][object]$Text,
        # The URL's role determines the diagnostic used for structural failures.
        [ValidateSet('auth-url', 'callback-url')][string]$FailureReason
    )
    $uri = $null
    # Reject raw fragments, backslashes and controls, plus malformed escapes before Uri can normalize them.
    if ($Text -isnot [string] -or $Text.Length -gt 16384 -or $Text -match '[\s\\#\x00-\x1f\x7f]' -or
        $Text -match '%(?![0-9A-Fa-f]{2})' -or
        -not [Uri]::TryCreate($Text, [UriKind]::Absolute, [ref]$uri) -or -not [string]::IsNullOrEmpty($uri.UserInfo)) {
        Stop-AntigravityLogin $FailureReason
    }
    return $uri
}

function Assert-AntigravityAuthorization {
    <# Validate the provider URL and bind its state and redirect URI to this local attempt. #>
    param(
        # The complete auth-url JSON object returned by the local management endpoint.
        [AllowNull()][object]$Authorization
    )
    if ($null -eq $Authorization -or $Authorization.status -isnot [string] -or $Authorization.status -cne 'ok') {
        Stop-AntigravityLogin 'response'
    }
    if (-not (Test-AntigravityState $Authorization.state)) { Stop-AntigravityLogin 'state' }
    $uri = Get-AntigravityValidatedUri $Authorization.url 'auth-url'
    if ($Authorization.url -notmatch '\Ahttps://accounts\.google\.com(?::443)?/' -or
        $uri.Scheme -cne 'https' -or $uri.Host -cne 'accounts.google.com' -or $uri.Port -ne 443) {
        Stop-AntigravityLogin 'auth-url'
    }
    $query = ConvertFrom-AntigravityQuery $uri.Query 'auth-url'
    if (-not $query.ContainsKey('redirect_uri') -or
        -not [string]::Equals($query['redirect_uri'], 'http://localhost:51121/oauth-callback', [StringComparison]::Ordinal)) {
        Stop-AntigravityLogin 'auth-url'
    }
    if (-not $query.ContainsKey('state') -or -not [string]::Equals($query['state'], $Authorization.state, [StringComparison]::Ordinal)) {
        Stop-AntigravityLogin 'state'
    }
}

function ConvertFrom-AntigravityCallback {
    <# Extract only a code from the expected localhost callback, with exact state matching. #>
    param(
        # The address pasted by the user, never logged or used as a network destination.
        [AllowNull()][object]$Text,
        # The original state returned by auth-url; empty or malformed states are forbidden.
        [string]$ExpectedState
    )
    if (-not (Test-AntigravityState $ExpectedState)) { Stop-AntigravityLogin 'state' }
    $uri = Get-AntigravityValidatedUri $Text 'callback-url'
    # Check the raw prefix as well as parsed components: URI dot-segment normalization is not accepted.
    if (-not $Text.StartsWith('http://localhost:51121/oauth-callback?', [StringComparison]::Ordinal) -or
        $uri.Scheme -cne 'http' -or $uri.Host -cne 'localhost' -or $uri.Port -ne 51121 -or $uri.AbsolutePath -cne '/oauth-callback') {
        Stop-AntigravityLogin 'callback-url'
    }
    $query = ConvertFrom-AntigravityQuery $uri.Query 'callback-url'
    if ($query.ContainsKey('error') -or -not $query.ContainsKey('code') -or [string]::IsNullOrWhiteSpace($query['code'])) {
        Stop-AntigravityLogin 'callback-url'
    }
    if (-not $query.ContainsKey('state') -or -not (Test-AntigravityState $query['state']) -or
        -not [string]::Equals($query['state'], $ExpectedState, [StringComparison]::Ordinal)) {
        Stop-AntigravityLogin 'state'
    }
    return $query['code']
}

function Invoke-AntigravityLocalRequest {
    <# Issue one bounded management request to 127.0.0.1, without proxies, redirects or retries. #>
    param(
        # Port is the only configurable destination component; no arbitrary URLs or paths are accepted.
        [ValidateRange(1, 65535)][int]$Port,
        # Map each operation to a fixed management endpoint and method.
        [ValidateSet('auth-url', 'callback', 'status')][string]$Operation,
        # Original validated state; required for callback and status operations.
        [string]$State,
        # Authorization code sent only in the callback JSON body.
        [string]$Code,
        # Per-request total deadline, bounded by the remaining OAuth session time.
        [ValidateRange(1, 15000)][int]$TimeoutMilliseconds = 15000
    )
    if ($Operation -ne 'auth-url' -and -not (Test-AntigravityState $State)) { Stop-AntigravityLogin 'state' }
    if ($Operation -eq 'callback' -and [string]::IsNullOrWhiteSpace($Code)) { Stop-AntigravityLogin 'callback-url' }
    # HttpClient buffers responses under one cancellation deadline, including streamed response bodies.
    Add-Type -AssemblyName System.Net.Http
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromMilliseconds($TimeoutMilliseconds)
    $client.MaxResponseContentBufferSize = 65536
    $request = $null
    $response = $null
    $responseText = $null
    $body = $null
    try {
        # Construct destinations exclusively from fixed paths and an encoded validated state.
        $path = '/v8/management/oauth/auth-url?provider=antigravity&is_webui=false'
        $method = [System.Net.Http.HttpMethod]::Get
        if ($Operation -eq 'status') {
            $path = '/v8/management/oauth/status?state=' + [Uri]::EscapeDataString($State)
        } elseif ($Operation -eq 'callback') {
            $path = '/v8/management/oauth/callback'
            $method = [System.Net.Http.HttpMethod]::Post
        }
        $request = New-Object System.Net.Http.HttpRequestMessage($method, ('http://127.0.0.1:' + $Port + $path))
        $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', '123456')
        $request.Headers.ConnectionClose = $true
        if ($Operation -eq 'callback') {
            $body = @{ provider = 'antigravity'; state = $State; code = $Code } | ConvertTo-Json -Compress
            $request.Content = New-Object System.Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json')
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        # Do not follow Location or interpret any HTTP failure body, even if it contains JSON.
        $status = [int]$response.StatusCode
        if ($status -lt 200 -or $status -ge 300) { Stop-AntigravityLogin 'http' $status }
        $responseText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        try { $result = ConvertFrom-Json -InputObject $responseText -ErrorAction Stop }
        catch { Stop-AntigravityLogin 'response' $status }
        if ($result -isnot [System.Management.Automation.PSCustomObject]) { Stop-AntigravityLogin 'response' $status }
        return $result
    } catch {
        # Only our own fixed diagnostics can escape; network exceptions may contain sensitive URIs.
        if ($_.Exception.Data['AntigravitySafeError']) { throw }
        Stop-AntigravityLogin 'transport'
    } finally {
        # Dispose sockets and request content on every path; release plaintext references promptly.
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        $client.Dispose()
        $handler.Dispose()
        $body = $null
        $responseText = $null
    }
}

function Get-AntigravityRemainingTimeout {
    <# Calculate a request deadline without extending the upstream five-minute session. #>
    param(
        # Monotonic clock started before the single auth-url request.
        [System.Diagnostics.Stopwatch]$Clock,
        # Shorter lifetimes support deterministic local tests; the upstream maximum is never exceeded.
        [ValidateRange(1, 300)][int]$SessionTimeoutSeconds
    )
    $remaining = ($SessionTimeoutSeconds * 1000) - $Clock.ElapsedMilliseconds
    if ($remaining -le 0) { Stop-AntigravityLogin 'expired' }
    return [int][Math]::Min(15000, $remaining)
}

function Invoke-AntigravityLogin {
    <# Run one interactive attempt. Return 0 only after status=ok, or 1 with a safe summary. #>
    param(
        # Local management service; external hosts are never accepted by this helper.
        [ValidateRange(1, 65535)][int]$Port = 19787,
        # Internal test seam may shorten, but never lengthen, the provider's five-minute deadline.
        [ValidateRange(1, 300)][int]$SessionTimeoutSeconds = 300,
        # Bounded polling delay; tests can shorten it without bypassing HTTP or URL validation.
        [ValidateRange(1, 5000)][int]$PollIntervalMilliseconds = 1000
    )
    # Convert cmdlet errors into the same safe summary path rather than rendering raw ErrorRecords.
    $ErrorActionPreference = 'Stop'
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $authorization = $null
    $secureCallback = $null
    $callbackText = $null
    $code = $null
    try {
        Write-Host 'Antigravity manual authorization. The local management service must already be running.'
        # Exactly one initialization: never retry an operation that creates an OAuth attempt.
        $timeout = Get-AntigravityRemainingTimeout $clock $SessionTimeoutSeconds
        $authorization = Invoke-AntigravityLocalRequest -Port $Port -Operation 'auth-url' -TimeoutMilliseconds $timeout
        Assert-AntigravityAuthorization $authorization
        $null = Get-AntigravityRemainingTimeout $clock $SessionTimeoutSeconds
        Write-Host 'Complete Google sign-in in your browser within five minutes.'
        Write-Host 'The localhost error page after sign-in is expected: this helper does not listen on port 51121.'
        Write-Host 'Copy the full callback address from the browser address bar. Do not share it in chat or logs.'
        try { Start-Process -FilePath $authorization.url -ErrorAction Stop | Out-Null }
        catch { Stop-AntigravityLogin 'browser' }

        # Secure input avoids echo/history; a temporary plaintext copy is required for URI parsing.
        $secureCallback = Read-Host -Prompt 'Paste the callback URL (hidden), then press Enter' -AsSecureString
        $null = Get-AntigravityRemainingTimeout $clock $SessionTimeoutSeconds
        $buffer = [IntPtr]::Zero
        try {
            $buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCallback)
            $callbackText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($buffer)
            $code = ConvertFrom-AntigravityCallback $callbackText $authorization.state
        } finally {
            if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($buffer) }
            $callbackText = $null
            if ($null -ne $secureCallback) { $secureCallback.Dispose(); $secureCallback = $null }
        }
        # Exactly one handoff. An accepted callback is not evidence of a completed login.
        $timeout = Get-AntigravityRemainingTimeout $clock $SessionTimeoutSeconds
        $accepted = Invoke-AntigravityLocalRequest -Port $Port -Operation 'callback' -State $authorization.state -Code $code -TimeoutMilliseconds $timeout
        $code = $null
        if ($accepted.status -isnot [string] -or $accepted.status -cne 'ok') { Stop-AntigravityLogin 'response' }
        Write-Host 'Callback accepted. Waiting for the service to finish authorization...'
        while ($true) {
            # Check immediately after callback so a completed state is seen within its one-minute retention.
            $timeout = Get-AntigravityRemainingTimeout $clock $SessionTimeoutSeconds
            $result = Invoke-AntigravityLocalRequest -Port $Port -Operation 'status' -State $authorization.state -TimeoutMilliseconds $timeout
            if ($result.status -isnot [string]) { Stop-AntigravityLogin 'response' }
            if ($result.status -ceq 'ok') {
                Write-Host 'Antigravity authorization completed successfully.'
                return 0
            }
            if ($result.status -ceq 'error') { Stop-AntigravityLogin 'rejected' }
            if ($result.status -cne 'wait') { Stop-AntigravityLogin 'response' }
            $remaining = Get-AntigravityRemainingTimeout $clock $SessionTimeoutSeconds
            Start-Sleep -Milliseconds ([Math]::Min($PollIntervalMilliseconds, $remaining))
        }
    } catch {
        # Never print ErrorRecord, raw exceptions, upstream error fields, URL, state or tokens.
        if ($_.Exception.Data['AntigravitySafeError']) { Write-Host ('Authorization failed. ' + $_.Exception.Message) }
        else { Write-Host 'Authorization failed. The local operation could not be completed; sensitive details were omitted.' }
        return 1
    } finally {
        $clock.Stop()
        if ($null -ne $secureCallback) { $secureCallback.Dispose() }
        $authorization = $null
        $callbackText = $null
        $code = $null
    }
}

# Dot-sourcing exposes functions for isolated tests, but cannot start a real login by itself.
if ($MyInvocation.InvocationName -ne '.') {
    exit (Invoke-AntigravityLogin -Port $Port)
}
