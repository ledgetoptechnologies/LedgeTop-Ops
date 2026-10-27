param([string]$LiteralPath, [switch]$PureTestsOnly)
$ErrorActionPreference = 'Stop'
try {
    if (-not [Environment]::Is64BitProcess) { throw 'UnsupportedHost' }
    Add-Type -Path (Join-Path $PSScriptRoot 'LedgeTopShellState.cs')
    if ($PureTestsOnly) {
        [LedgeTopShellState]::PureTests()
        Write-Output 'Pure validation tests passed. No registry, Shell, profile, or native collector calls ran.'
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($LiteralPath)) { throw 'MissingLiteralPath' }
    $result = [LedgeTopShellState]::Collect($LiteralPath)
    # Only whitelisted scalar observations are returned; no source path/account/file name is serialized.
    $json = $result | ConvertTo-Json -Depth 8
    [LedgeTopShellState]::SaveReport($json)
    Write-Output 'Saved a new JSON report in LocalAppData\LedgeTop\Files\pilot\Diagnostics. No upload was performed.'
    exit 0
} catch {
    # Never print exception messages: native/PowerShell errors can contain the selected private path.
    Write-Output 'Diagnostic refused or unavailable. No file contents, registration, or app settings were changed.'
    exit 1
}
