param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$ExpectedSha256,
    [Parameter(Mandatory)][string]$ArtifactParent
)
$ErrorActionPreference = 'Stop'
# Deliberate hard stop.  This draft is not authorized to launch until full payload
# pinning, held path identities, job containment, VM/volume admission and independent
# receipt reconciliation have been implemented and reviewed.
throw 'Native scale probe is disabled pending reviewed VM and process safety controls.'
if ($env:LEDGETOP_SYNTHETIC_SCALE_VM -cne '1') { throw 'This generated-only probe requires explicit VM admission.' }
if ($ExpectedSha256 -cnotmatch '\A[0-9a-f]{64}\z') { throw 'A lowercase exact executable SHA-256 is required.' }
$exe = [IO.Path]::GetFullPath($Executable)
$parent = [IO.Path]::GetFullPath($ArtifactParent)
if (-not [IO.Path]::IsPathFullyQualified($Executable) -or -not [IO.Path]::IsPathFullyQualified($ArtifactParent) -or
    $exe.StartsWith('\\') -or $parent.StartsWith('\\') -or -not [IO.File]::Exists($exe) -or -not [IO.Directory]::Exists($parent)) {
    throw 'An existing local executable and artifact parent are required.'
}
if ([IO.Path]::TrimEndingDirectorySeparator($parent) -ceq [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetPathRoot($parent)) -or
    [IO.DriveInfo]::new([IO.Path]::GetPathRoot($parent)).DriveType -ne [IO.DriveType]::Fixed) {
    throw 'The artifact parent must be an existing non-root directory on a fixed drive.'
}
foreach ($path in @($exe, $parent)) {
    $item = Get-Item -LiteralPath $path -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Aliases are not allowed in probe paths.' }
        $item = if ($item -is [IO.FileInfo]) { $item.Directory } else { $item.Parent }
    }
}
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Executable bytes differ from the reviewed test build.' }
$owned = Join-Path $parent ('LedgeTopNativeScale-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $owned) { throw 'Probe directory already exists.' }
[IO.Directory]::CreateDirectory($owned) | Out-Null
$record = @{ executableSha256 = $ExpectedSha256; generatedDataOnly = $true; productionAccess = $false; outcome = 'prepared' }
$recordPath = Join-Path $owned 'supervisor.json'
[IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $exe
$info.WorkingDirectory = [IO.Path]::GetDirectoryName($exe)
$info.UseShellExecute = $false
foreach ($arg in @('--owned-native-preview', '--native-only', '--synthetic-scale-5000')) { [void]$info.ArgumentList.Add($arg) }
$info.Environment['LEDGETOP_SYNTHETIC_SCALE_VM'] = '1'
$info.Environment['LEDGETOP_TEST_ARTIFACT_ROOT'] = $owned
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
if (-not $process.Start()) { throw 'Probe process did not start.' }
try {
    $record.pid = $process.Id
    $record.outcome = 'running'
    [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    if (-not $process.WaitForExit(600000)) {
        # Only the exact process created above is stopped; no registration is removed here.
        $process.Kill()
        if (-not $process.WaitForExit(30000)) { throw 'Owned probe did not stop; preserve the fixture and registration for reconciliation.' }
        $record.outcome = 'timed-out-registration-reconciliation-required'
        throw 'Probe exceeded its deadline; retain the exact fixture and reconcile its registration.'
    }
    $record.exitCode = $process.ExitCode
    $record.outcome = if ($process.ExitCode -eq 0) { 'process-succeeded-review-receipt' } else { 'process-failed-review-receipt' }
    if ($process.ExitCode -ne 0) { throw 'Probe failed; inspect its exact receipt and registration before cleanup.' }
} finally {
    try {
        if (-not $process.HasExited) {
            $process.Kill()
            if (-not $process.WaitForExit(30000)) { throw 'Owned probe did not stop; preserve its fixture for reconciliation.' }
            $record.outcome = 'stopped-registration-reconciliation-required'
        }
    } finally {
        try { [IO.File]::WriteAllText($recordPath, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false)) }
        finally { $process.Dispose() }
    }
}
