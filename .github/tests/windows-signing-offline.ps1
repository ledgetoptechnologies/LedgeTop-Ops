# Offline smoke tests for the extraction and hash checks embedded in the held workflow.
# This intentionally does not run the workflow, download packages, or sign anything.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$workflowPath = Join-Path $PSScriptRoot '../workflows/windows-signing-smoke.yml'
$workflow = [IO.File]::ReadAllText([IO.Path]::GetFullPath($workflowPath))
$functionMatch = [regex]::Match($workflow, '(?ms)^ {10}function Expand-VerifiedPrefix\(.*?(?=^ {10}\$sdkDir = )')
$hashMatch = [regex]::Match($workflow, '(?ms)^ {14}if \(\(Get-FileHash -InputStream \$sdkHandle.*?^ {14}\}')
if (-not $functionMatch.Success -or -not $hashMatch.Success) { throw 'Workflow extraction or hash check could not be located.' }
$functionSource = [regex]::Replace($functionMatch.Value, '(?m)^ {10}', '')
$hashSource = [regex]::Replace($hashMatch.Value, '(?m)^ {14}', '')
Invoke-Expression $functionSource
$hashCheck = [scriptblock]::Create($hashSource)
$hold = $workflow.IndexOf("throw 'Signing smoke held: extracted payload identity is not verified through launch.'", [StringComparison]::Ordinal)
$sign = $workflow.IndexOf('& $tool sign ', [StringComparison]::Ordinal)
if ($hold -lt 0 -or $sign -le $hold) { throw 'The unconditional signing hold is absent or misplaced.' }
$base = Join-Path ([IO.Path]::GetTempPath()) ('LedgeTopSigningOffline-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($base) | Out-Null
function MakeArchive([string] $path, [string[]] $names, [bool] $link = $false) {
    $zip = [IO.Compression.ZipFile]::Open($path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $names) {
            $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
            if ($link) { $entry.ExternalAttributes = [int](-1610612736) }
            $writer = [IO.StreamWriter]::new($entry.Open())
            try { $writer.Write('abcdef') } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
}
function ExpectReject([string] $file, [string] $destination, [string] $message, [string] $expected) {
    $archive = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $rejected = $false
        try { Expand-VerifiedPrefix $archive 'bin/x64/' $destination } catch { if ($_.Exception.Message -cne $expected) { throw }; $rejected = $true }
        if (-not $rejected) { throw "$message was accepted" }
    } finally { $archive.Dispose() }
}
try {
    $ok = Join-Path $base 'ok.zip'; MakeArchive $ok @('bin/x64/a.exe')
    $sdkHandle = [IO.File]::Open($ok, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $clientHandle = [IO.File]::Open($ok, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $rejected = $false
        try { & $hashCheck } catch { if ($_.Exception.Message -eq 'A signing-tool package does not match the reviewed bytes.') { $rejected = $true } else { throw } }
        if (-not $rejected) { throw 'SDK hash mismatch was accepted.' }
        # Supply the SDK's expected hash through a narrow stub to exercise the
        # actual workflow expression's second operand with a mismatched client.
        # No real package or signing is involved.
        $sdkHashMatch = [regex]::Match($hashSource, "(?<=-cne ')[A-F0-9]{64}(?=')")
        if (-not $sdkHashMatch.Success) { throw 'SDK hash literal not found.' }
        $expectedSdkHash = $sdkHashMatch.Value
        $script:clientHashChecked = $false
        function Test-ClientHashMismatch {
            function Get-FileHash {
                param([IO.Stream] $InputStream, [string] $Algorithm)
                if ([object]::ReferenceEquals($InputStream, $sdkHandle)) { return [pscustomobject]@{ Hash = $expectedSdkHash } }
                if (-not [object]::ReferenceEquals($InputStream, $clientHandle)) { throw 'Unexpected hash stream.' }
                $script:clientHashChecked = $true
                return Microsoft.PowerShell.Utility\Get-FileHash -InputStream $InputStream -Algorithm $Algorithm
            }
            $clientHandle.Position = 0
            $clientRejected = $false
            try { & $hashCheck } catch { if ($_.Exception.Message -ceq 'A signing-tool package does not match the reviewed bytes.') { $clientRejected = $true } else { throw } }
            if (-not $clientRejected -or -not $script:clientHashChecked) { throw 'Client hash mismatch was not checked and rejected.' }
        }
        Test-ClientHashMismatch
        $writeDenied = $false
        try { $write = [IO.File]::Open($ok, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None); $write.Dispose() }
        catch [IO.IOException] { $writeDenied = $true }
        if (-not $writeDenied) { throw 'An open archive allowed a competing writer.' }
        $sdkHandle.Position = 0
        Expand-VerifiedPrefix $sdkHandle 'bin/x64/' (Join-Path $base 'ok')
        if ([IO.File]::ReadAllText((Join-Path $base 'ok/a.exe')) -cne 'abcdef') { throw 'Valid extraction failed.' }
    } finally { $sdkHandle.Dispose(); $clientHandle.Dispose() }
    foreach ($case in @('traversal', 'duplicate', 'link')) {
        $path = Join-Path $base ($case + '.zip')
        switch ($case) {
            'traversal' { MakeArchive $path @('bin/x64/../escape.exe'); $expected = 'A signing-tool package contains an unsafe entry.' }
            'duplicate' { MakeArchive $path @('bin/x64/a.exe', 'bin/x64/A.exe'); $expected = 'A signing-tool package contains duplicate entries.' }
            'link' { MakeArchive $path @('bin/x64/a.exe') $true; $expected = 'A signing-tool package contains a symbolic link.' }
        }
        ExpectReject $path (Join-Path $base $case) $case $expected
    }
    # Forge an oversized central-directory uncompressed length: the size gate
    # must reject before opening and decompressing this entry.
    $short = Join-Path $base 'short.zip'; MakeArchive $short @('bin/x64/a.exe')
    $bytes = [IO.File]::ReadAllBytes($short); $central = -1
    for ($i = 0; $i -lt $bytes.Length - 46; $i++) {
        if ($bytes[$i] -eq 0x50 -and $bytes[$i+1] -eq 0x4b -and $bytes[$i+2] -eq 0x01 -and $bytes[$i+3] -eq 0x02) { $central = $i; break }
    }
    if ($central -lt 0) { throw 'Synthetic central directory missing.' }
    $lengthBytes = [BitConverter]::GetBytes([uint32](100MB + 1))
    for ($n = 0; $n -lt 4; $n++) { $bytes[$central+24+$n] = $lengthBytes[$n] }
    [IO.File]::WriteAllBytes($short, $bytes)
    ExpectReject $short (Join-Path $base 'short') 'Oversized declared entry' 'A signing-tool package is unexpectedly large.'
    Write-Output 'PASS: both workflow hash refusals, held-stream writer exclusion, valid extraction, traversal/duplicate/link rejection, and oversized entry rejection.'
} finally {
    # The paths below are fixed names created under this invocation's unique folder.
    foreach ($name in @('ok/a.exe', 'duplicate/a.exe', 'short/a.exe', 'ok.zip', 'traversal.zip', 'duplicate.zip', 'link.zip', 'short.zip')) {
        $path = Join-Path $base $name; if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
    }
    foreach ($name in @('ok', 'traversal', 'duplicate', 'link', 'short')) {
        $path = Join-Path $base $name; if (Test-Path -LiteralPath $path -PathType Container) { Remove-Item -LiteralPath $path }
    }
    if (Test-Path -LiteralPath $base -PathType Container) { Remove-Item -LiteralPath $base }
}
