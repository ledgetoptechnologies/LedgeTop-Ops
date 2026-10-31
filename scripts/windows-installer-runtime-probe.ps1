param()
$ErrorActionPreference = 'Stop'
# Isolated diagnostic only. Never executes UnsignedInstaller.nsi or touches its
# install paths, registry, app, Start menu, profiles, sync roots or live accounts.
$repo = Split-Path -Parent $PSScriptRoot
$template = Join-Path $repo 'apps/windows-download/Packaging/UnsignedInstaller.nsi'
$compiler = Join-Path $env:USERPROFILE '.codex/cache/windows-download-nsis-3.13-20261025/toolchain/nsis-3.13/Bin/makensis.exe'
$compilerPin = '65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a'
if ((Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant() -cne $compilerPin) { throw 'Compiler hash differs.' }
$base = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex/tmp'))
$work = [IO.Path]::GetFullPath((Join-Path $base ('windows-installer-runtime-probe-' + [Guid]::NewGuid().ToString('N'))))
if (-not $work.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected diagnostic path.' }
[IO.Directory]::CreateDirectory($work) | Out-Null
$targetParent = Join-Path $work 'PayloadParent'
$target = Join-Path $targetParent 'Target'
$menu = Join-Path $work 'DiagnosticMenu'
$result = Join-Path $work 'result.txt'
$exe = Join-Path $work 'probe.exe'
$script = Join-Path $work 'probe.nsi'
$config = Join-Path $work 'EmptyConfig'
[IO.Directory]::CreateDirectory($config) | Out-Null
$original = [IO.File]::ReadAllText($template)
$pathMatch = [regex]::Match($original, '(?ms)^!macro PathCheck Prefix\r?\n.*?^!macroend')
$versionMatch = [regex]::Match($original, '(?ms)^Function ValidateVersion\r?\n.*?^FunctionEnd')
$payloadMatch = [regex]::Match($original, '(?ms)^Function un.CheckPayloadPath\r?\n.*?^FunctionEnd')
if (-not $pathMatch.Success -or -not $versionMatch.Success -or -not $payloadMatch.Success) { throw 'Template helpers not found exactly once.' }
# Keep every instruction/jump position: MessageBox -> one StrCpy, Abort -> one
# Return. Thus refusal is observed without opening native UI or aborting the probe.
$pathFunction = [regex]::Replace($pathMatch.Value, '(?m)^(\s*)MessageBox[^\r\n]*', [Text.RegularExpressions.MatchEvaluator]{
  param($match)
  $phase = if ($match.Value.Contains('after registration changes began')) { 'active' } else { 'pre' }
  return $match.Groups[1].Value + 'StrCpy $ProbeResult "1;$R0;attributes=$R1;error=$R3;phase=' + $phase + '"'
})
$pathFunction = [regex]::Replace($pathFunction, '(?m)^(\s*)Abort\s*$', '$1Return')
$pathFunction = $pathFunction.Replace('$SMPROGRAMS\LedgeTop Files Pilot', '${PROBE_MENU}')
$payloadFunction = $payloadMatch.Value.Replace('Function un.CheckPayloadPath', 'Function CheckPayloadPath')
$payloadFunction = [regex]::Replace($payloadFunction, '(?m)^(\s*)MessageBox[^\r\n]*', '$1StrCpy $ProbeResult "1;$R0;attributes=$R1;error=$R3"')
$payloadFunction = [regex]::Replace($payloadFunction, '(?m)^(\s*)Abort\s*$', '$1Return')
function Escape-Nsis([string]$value) {
  if ($value.IndexOfAny([char[]]@([char]0, [char]10, [char]13, [char]34)) -ge 0) { throw 'Unexpected literal.' }
  return $value.Replace('$', '$$')
}
$versions = @(
  @{Value='0.0.0.0'; Expected=1}, @{Value='1.2.3.4'; Expected=1}, @{Value='1.10.0.0'; Expected=1},
  @{Value='65535.65535.65535.65535'; Expected=1}, @{Value=''; Expected=0}, @{Value='1.2.3'; Expected=0},
  @{Value='1.2.3.4.5'; Expected=0}, @{Value='01.2.3.4'; Expected=0}, @{Value='1.02.3.4'; Expected=0},
  @{Value='65536.0.0.0'; Expected=0}, @{Value='1.2.3.999999'; Expected=0}, @{Value='-1.2.3.4'; Expected=0},
  @{Value='1.2.3.4 '; Expected=0}, @{Value='1..3.4'; Expected=0}, @{Value='.1.2.3'; Expected=0},
  @{Value='1.2.3.'; Expected=0}, @{Value='1.2.3.1e2'; Expected=0}, @{Value='1.2.3.a'; Expected=0}
)
$header = @'
Unicode true
!include "FileFunc.nsh"
!include "WordFunc.nsh"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Isolated NSIS helper diagnostic"
Var ProbeResult
Var ProbeLog
Var ActivationStarted
'@
$generated = $header + "`r`nOutFile `"$(Escape-Nsis $exe)`"`r`n!define TARGET `"$(Escape-Nsis $target)`"`r`n!define PROBE_MENU `"$(Escape-Nsis $menu)`"`r`n" +
  $pathFunction + "`r`n!insertmacro PathCheck `"`"`r`n" + $payloadFunction + "`r`n" + $versionMatch.Value + "`r`nSection`r`n" +
  "  FileOpen `$ProbeLog `"$(Escape-Nsis $result)`" w`r`n" + @'
  StrCpy $ProbeResult 0
  StrCpy $ActivationStarted 0
  Call CheckFixedPath
  FileWrite $ProbeLog "path|$ProbeResult$\r$\n"
  StrCpy $ProbeResult 0
  StrCpy $ActivationStarted 1
  Call CheckFixedPath
  FileWrite $ProbeLog "path-active|$ProbeResult$\r$\n"
  StrCpy $ProbeResult 0
  Push "${TARGET}\Nested"
  Call CheckPayloadPath
  FileWrite $ProbeLog "payload|$ProbeResult$\r$\n"
  StrCpy $ProbeResult 0
  Push "${TARGET}Other"
  Call CheckPayloadPath
  FileWrite $ProbeLog "outside|$ProbeResult$\r$\n"
  StrCpy $ProbeResult 0
  Push "${TARGET}\..\Elsewhere"
  Call CheckPayloadPath
  FileWrite $ProbeLog "traversal|$ProbeResult$\r$\n"
'@
foreach ($v in $versions) {
  $generated += "`r`n  Push `"$($v.Value)`"`r`n  Call ValidateVersion`r`n  Pop `$0`r`n  FileWrite `$ProbeLog `"version|$($v.Value)|`$0`$\r`$\n`"`r`n"
}
$generated += "  FileClose `$ProbeLog`r`n  SetErrorLevel 0`r`nSectionEnd`r`n"
# Generated program may only inspect paths, evaluate strings and write its fixed
# diagnostic output. Protect against accidentally copying an installation section.
if ($generated -match '(?im)^\s*(WriteReg|DeleteReg|ExecWait|ExecShell|CreateShortCut|WriteUninstaller|Delete\s|RMDir\s|File\s|SetOutPath|CreateDirectory)') { throw 'Unexpected diagnostic mutation command.' }
[IO.File]::WriteAllText($script, $generated, [Text.UTF8Encoding]::new($false))
$start = [Diagnostics.ProcessStartInfo]::new($compiler)
$start.UseShellExecute = $false; $start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
$start.Environment['NSISDIR'] = Split-Path -Parent (Split-Path -Parent $compiler)
$start.Environment['NSISCONFDIR'] = $config
foreach ($arg in @('/NOCONFIG', '/WX', '/V3', $script)) { $start.ArgumentList.Add($arg) }
$process = [Diagnostics.Process]::Start($start)
$stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
if (-not $process.WaitForExit(30000)) { throw "Diagnostic compilation timed out (PID $($process.Id))." }
[IO.File]::WriteAllText((Join-Path $work 'compile.log'), $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult())
if ($process.ExitCode -ne 0) { throw "Diagnostic compilation failed; inspect $work/compile.log" }
$outcomes = [Collections.Generic.List[object]]::new()
function Run-Case([string]$name, [int]$expected, [int]$payloadExpected = $expected) {
  $run = Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
  if (-not $run.WaitForExit(30000)) { throw "Diagnostic run timed out (PID $($run.Id))." }
  if ($run.ExitCode -ne 0) { throw "Diagnostic process failed in $name." }
  $lines = [IO.File]::ReadAllLines($result)
  if (($lines[0] -split ';')[0] -cne "path|$expected") { throw "Path case $name expected $expected, got $($lines[0])." }
  if (($lines[1] -split ';')[0] -cne "path-active|$expected") { throw "Active path case $name expected $expected, got $($lines[1])." }
  if ($expected -eq 1 -and (-not $lines[0].EndsWith(';phase=pre') -or -not $lines[1].EndsWith(';phase=active'))) { throw "Path warning did not follow activation phase: $($lines[0..1])" }
  if (($lines[2] -split ';')[0] -cne "payload|$payloadExpected") { throw "Payload case $name expected $payloadExpected, got $($lines[2])." }
  if (($lines[3] -split ';')[0] -cne 'outside|1' -or ($lines[4] -split ';')[0] -cne 'traversal|1') { throw "Payload boundary check failed: $($lines[3..4])" }
  for ($i = 0; $i -lt $versions.Count; $i++) {
    $v = $versions[$i]
    if ($lines[$i + 5] -cne "version|$($v.Value)|$($v.Expected)") { throw "Version result differs: $($lines[$i + 5])" }
  }
  [IO.File]::Copy($result, (Join-Path $work ($name + '.txt')), $false)
  $outcomes.Add(@{case=$name;pathResult=$expected;payloadResult=$payloadExpected;payloadBoundariesRefused=$true;versionsPassed=$versions.Count})
}
Run-Case 'fresh' 0
[IO.Directory]::CreateDirectory($target) | Out-Null
[IO.Directory]::CreateDirectory($menu) | Out-Null
Run-Case 'ordinary' 0
[IO.Directory]::Delete($target) # known empty diagnostic directory, nonrecursive
[IO.File]::WriteAllText($target, 'owned diagnostic file')
Run-Case 'file' 1
[IO.File]::Delete($target)
$destination = Join-Path $work 'OwnAliasDestination'
[IO.Directory]::CreateDirectory($destination) | Out-Null
$sentinel = Join-Path $destination 'sentinel.txt'; [IO.File]::WriteAllText($sentinel, 'preserve')
New-Item -ItemType Junction -Path $target -Target $destination | Out-Null
try { Run-Case 'alias' 1 }
finally { [IO.Directory]::Delete($target) } # remove only owned junction, never its target
[IO.Directory]::Delete($targetParent)
New-Item -ItemType Junction -Path $targetParent -Target $destination | Out-Null
try { Run-Case 'ancestor-alias' 1 0 } # root/ancestor gate refuses; payload helper stops at fixed target
finally { [IO.Directory]::Delete($targetParent) }
[IO.Directory]::CreateDirectory($target) | Out-Null
$nested = Join-Path $target 'Nested'
New-Item -ItemType Junction -Path $nested -Target $destination | Out-Null
try { Run-Case 'payload-nested-alias' 0 1 }
finally { [IO.Directory]::Delete($nested) }
[IO.File]::WriteAllText($nested, 'owned diagnostic file')
Run-Case 'payload-nested-file' 0 1
[IO.File]::Delete($nested)
[IO.Directory]::Delete($menu)
New-Item -ItemType Junction -Path $menu -Target $destination | Out-Null
try { Run-Case 'menu-alias' 1 0 }
finally { [IO.Directory]::Delete($menu) }
if ([IO.File]::ReadAllText($sentinel) -cne 'preserve') { throw 'Diagnostic alias destination changed.' }
$receipt = @{schema=1;diagnosticOnly=$true;fullInstallerExecuted=$false;templateSha256=(Get-FileHash -LiteralPath $template -Algorithm SHA256).Hash.ToLowerInvariant();compilerSha256=$compilerPin;
  executableSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();outcomes=@($outcomes.ToArray());helperInstructionPositionsPreserved=$true;
  registryAppProfilesShortcutsChanged=$false;aliasDestinationPreserved=$true;artifacts=$work}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $work 'receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 5
