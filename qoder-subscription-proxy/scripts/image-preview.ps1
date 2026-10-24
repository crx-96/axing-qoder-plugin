param(
    [Parameter(Mandatory=$true)][string]$InputPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$image = $null
try {
    $image = [Drawing.Image]::FromFile($InputPath)
    if ([long]$image.Width * [long]$image.Height -gt 40000000) { throw 'Image too large' }
    $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    # Fit the MCP inline limit; keep the original transparent image unchanged.
    foreach ($edge in @(512, 384, 256, 128)) {
        $scale = [Math]::Min(1.0, $edge / [double][Math]::Max($image.Width, $image.Height))
        $width = [Math]::Max(1, [int]($image.Width * $scale))
        $height = [Math]::Max(1, [int]($image.Height * $scale))
        $bitmap = New-Object Drawing.Bitmap($width, $height)
        $graphics = $null
        $parameters = $null
        try {
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            $graphics.Clear([Drawing.Color]::White)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($image, 0, 0, $width, $height)
            $parameters = New-Object Drawing.Imaging.EncoderParameters(1)
            $parameters.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, [long]65)
            $bitmap.Save($OutputPath, $codec, $parameters)
        } finally {
            if ($parameters) { $parameters.Dispose() }
            if ($graphics) { $graphics.Dispose() }
            $bitmap.Dispose()
        }
        if ((Get-Item -LiteralPath $OutputPath).Length -le 140000) { exit 0 }
    }
    throw 'Preview exceeds inline limit'
} finally {
    if ($image) { $image.Dispose() }
}
