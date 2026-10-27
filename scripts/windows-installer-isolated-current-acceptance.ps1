#requires -Version 7.4
param(
  [switch]$ExecuteReviewedAcceptance,
  [ValidateRange(0, 2147483647)][int]$ProtectedProcessId = 0,
  [ValidateSet('5c751732990614beb069160806f7d4668876ffe9')][string]$ReviewedCommit = '5c751732990614beb069160806f7d4668876ffe9'
)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteReviewedAcceptance) { throw 'Source preparation only: root review and explicit ExecuteReviewedAcceptance are required before any effects.' }
# Actual NSIS lifecycle, synthetic app + isolated namespace ONLY. Never executes
# the product app, accesses profiles/accounts, operates UI, or closes processes.
$repo = Split-Path -Parent $PSScriptRoot
$commit = $ReviewedCommit
$compiler = Join-Path $env:USERPROFILE '.codex/cache/windows-download-nsis-3.13-20261025/toolchain/nsis-3.13/Bin/makensis.exe'
$compilerPin = '65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a'
if ((Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant() -cne $compilerPin) { throw 'Compiler pin differs.' }
$protectedStart = $null
if ($ProtectedProcessId -gt 0) {
  $protected = Get-Process -Id $ProtectedProcessId -ErrorAction Stop
  $protectedStart = $protected.StartTime.ToUniversalTime().Ticks
}
$id = [Guid]::NewGuid().ToString('N')
$qaBase = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex/artifacts/LedgeTop-Files-2026-10-25'))
if (-not [IO.Directory]::Exists($qaBase)) { throw 'Existing hidden artifact root is required.' }
for ($part=$qaBase; $part; $part=[IO.Path]::GetDirectoryName($part)) {
  if (([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Artifact ancestry is an alias.' }
}
$qa = [IO.Path]::GetFullPath((Join-Path $qaBase ('windows-installer-isolated-qa-' + $id)))
if (-not $qa.StartsWith($qaBase + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'QA directory escaped.' }
if ([IO.Directory]::Exists($qa) -or [IO.File]::Exists($qa)) { throw 'Fresh GUID fixture required.' }
[IO.Directory]::CreateDirectory($qa) | Out-Null
$temp = Join-Path $qa 'SyntheticTemp'; [IO.Directory]::CreateDirectory($temp) | Out-Null
$product = Join-Path $qa 'Product Root With Spaces'
$menu = Join-Path $qa ('StartMenu-' + $id)
$registryPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesInstallerQA-' + $id
$startupPath = 'Software\LedgeTop\InstallerQA\' + $id + '\Startup'
$startupValue = 'LedgeTopFilesInstallerQA-' + $id
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
if ($registry.OpenSubKey($registryPath)) { throw 'Unique QA key already exists.' }
if ($registry.OpenSubKey('Software\LedgeTop\InstallerQA\' + $id)) { throw 'Unique QA startup namespace already exists.' }
$log = Join-Path $qa 'stub-calls.txt'
$control = Join-Path $qa 'control.ini'
$config = Join-Path $qa 'EmptyConfig'; [IO.Directory]::CreateDirectory($config) | Out-Null
$phases = [Collections.Generic.List[object]]::new()
function Assert-True([bool]$value, [string]$reason) { if (-not $value) { throw $reason } }
function Assert-OwnedPath([string]$path) {
  $resolved = [IO.Path]::GetFullPath($path)
  if (-not $resolved.StartsWith($qa + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refused path outside exact QA directory.' }
  return $resolved
}
function Escape-Nsis([string]$value) {
  if ($value.IndexOfAny([char[]]@([char]0,[char]10,[char]13,[char]34)) -ge 0) { throw 'Unsafe NSIS literal.' }
  return $value.Replace('$', '$$')
}
function Write-Utf8([string]$path, [string]$value) { [IO.File]::WriteAllText((Assert-OwnedPath $path), $value, [Text.UTF8Encoding]::new($false)) }
function Compile-Nsis([string]$script, [string]$tag) {
  $start = [Diagnostics.ProcessStartInfo]::new($compiler)
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $start.Environment['NSISDIR'] = Split-Path -Parent (Split-Path -Parent $compiler)
  $start.Environment['NSISCONFDIR'] = $config
  $start.Environment['TEMP'] = $temp; $start.Environment['TMP'] = $temp
  foreach ($argument in @('/NOCONFIG','/WX','/V3',$script)) { $start.ArgumentList.Add($argument) }
  $run = [Diagnostics.Process]::Start($start)
  $out = $run.StandardOutput.ReadToEndAsync(); $err = $run.StandardError.ReadToEndAsync()
  if (-not $run.WaitForExit(30000)) { throw "QA compiler timed out, own PID $($run.Id)." }
  Write-Utf8 (Join-Path $qa ($tag + '-compile.log')) ($out.GetAwaiter().GetResult() + $err.GetAwaiter().GetResult())
  if ($run.ExitCode -ne 0) { throw "QA compilation failed: $tag (see artifact log)." }
}
function Run-OwnedExe([string]$exe, [string]$arguments, [int]$expected, [string]$phase) {
  $null = Assert-OwnedPath $exe
  Assert-True ($arguments.StartsWith('/S', [StringComparison]::Ordinal)) 'Only silent synthetic acceptance execution is allowed.'
  $script:lastOwnedProcessTerminal = $false
  $run = Start-Process -FilePath $exe -ArgumentList $arguments -Environment @{TEMP=$temp;TMP=$temp} -WindowStyle Hidden -PassThru
  if (-not $run.WaitForExit(30000)) { throw "QA process timed out, own PID $($run.Id)." }
  $script:lastOwnedProcessTerminal = $true
  if ($run.ExitCode -ne $expected) { throw "$phase returned $($run.ExitCode), expected $expected." }
  if ([IO.File]::Exists($log)) { Assert-True (-not ([IO.File]::ReadAllText($log).Contains('FORBIDDEN-NORMAL-LAUNCH|'))) 'Silent installation launched the normal synthetic app.' }
  $phases.Add(@{phase=$phase;exitCode=$run.ExitCode})
}
function Set-Codes([int]$check, [int]$remove) { Write-Utf8 $control "[Codes]`r`nCheck=$check`r`nRemove=$remove`r`n" }
function Read-Activation {
  $key = $registry.OpenSubKey($registryPath)
  if ($null -eq $key) { return $null }
  try { return @{version=$key.GetValue('DisplayVersion');location=$key.GetValue('InstallLocation');publisher=$key.GetValue('Publisher')} }
  finally { $key.Dispose() }
}
function Count-CleanupCalls {
  if (-not [IO.File]::Exists($log)) { return 0 }
  return @([IO.File]::ReadAllLines($log) | Where-Object { $_ -like '--installer-remove-connections|*' }).Count
}
function Assert-InstalledAnchors([string]$target) {
  Assert-True ((Get-FileHash -LiteralPath (Join-Path $target 'installed-payload-inventory.json')).Hash.ToLowerInvariant() -ceq $manifestHash) 'Installed exact inventory bytes differ.'
  $markerText = [IO.File]::ReadAllText((Join-Path $target 'installer-owned.ini'))
  foreach ($line in @('[Installer]','Owner=LedgeTop.Files.UnsignedPilotInstaller/1',('Version=' + (Split-Path -Leaf $target)),"PayloadManifestSha256=$manifestHash","SourceCommit=$commit")) {
    Assert-True ([regex]::Matches($markerText, ('(?m)^' + [regex]::Escape($line) + '\r?$')).Count -eq 1) 'Installed owner/version/source/manifest marker differs.'
  }
}
function Read-Startup {
  $key = $registry.OpenSubKey($startupPath)
  if ($null -eq $key) { return $null }
  try {
    if ($key.GetValueNames() -cnotcontains $startupValue) { return $null }
    return @{value=$key.GetValue($startupValue,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$key.GetValueKind($startupValue).ToString()}
  } finally { $key.Dispose() }
}
function Payload-Snapshot([string]$target) {
  $snapshot = @{}
  foreach ($name in @('LedgeTop.Files.exe','Notices\notice.txt','installed-payload-inventory.json','installer-owned.ini','uninstall.exe')) {
    $file = Assert-OwnedPath (Join-Path $target $name)
    $snapshot[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  }
  return $snapshot
}
function Assert-PayloadUnchanged([string]$target, [hashtable]$snapshot) {
  $current = Payload-Snapshot $target
  foreach ($name in $snapshot.Keys) { Assert-True ($snapshot[$name] -ceq $current[$name]) "Payload bytes changed: $name" }
}
function Run-Uninstaller([string]$target, [int]$expected, [string]$phase) {
  $null = Assert-OwnedPath $target
  $original = Join-Path $target 'uninstall.exe'
  $runner = Join-Path $qa ('runner-' + $phase + '.exe')
  # Standard documented NSIS waiting pattern: copy to isolated temp, then _?=
  # prevents a second asynchronous relaunch and allows deleting the original.
  [IO.File]::Copy($original, (Assert-OwnedPath $runner), $false)
  Run-OwnedExe $runner ('/S _?=' + $target) $expected $phase
}
try {
  $gitStart = [Diagnostics.ProcessStartInfo]::new('git')
  $gitStart.WorkingDirectory = $repo; $gitStart.UseShellExecute = $false; $gitStart.RedirectStandardOutput = $true
  $gitStart.ArgumentList.Add('show'); $gitStart.ArgumentList.Add($commit + ':apps/windows-download/Packaging/UnsignedInstaller.nsi')
  $git = [Diagnostics.Process]::Start($gitStart)
  $bytes = [IO.MemoryStream]::new(); $git.StandardOutput.BaseStream.CopyTo($bytes); $git.WaitForExit()
  Assert-True ($git.ExitCode -eq 0) 'Exact committed template could not be read.'
  $originalBytes = $bytes.ToArray(); $source = [Text.Encoding]::UTF8.GetString($originalBytes)
  $templateHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData($originalBytes))
  Assert-True ($templateHash -ceq '7dee786a53f301ab41187cd2e3866950161f5190b7f9a1dc2f6a2e6071be7200') 'Current exact-commit template hash differs.'
  $replacements = @(
    @{From='$LOCALAPPDATA\Programs\LedgeTop Files Pilot'; To=(Escape-Nsis $product); Count=1},
    @{From='Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesPilot'; To=$registryPath; Count=1},
    @{From='$SMPROGRAMS\LedgeTop Files Pilot'; To=(Escape-Nsis $menu); Count=7},
    @{From='Local\LedgeTopFilesPilotInstaller'; To=('Local\LedgeTopFilesInstallerQA-' + $id); Count=3},
    @{From='!define STARTUP_KEY "Software\Microsoft\Windows\CurrentVersion\Run"'; To=('!define STARTUP_KEY "' + $startupPath + '"'); Count=1},
    @{From='!define STARTUP_VALUE "LedgeTopFilesPilot"'; To=('!define STARTUP_VALUE "' + $startupValue + '"'); Count=1}
  )
  foreach ($replacement in $replacements) {
    $count = [regex]::Matches($source, [regex]::Escape($replacement.From)).Count
    Assert-True ($count -eq $replacement.Count) "Unexpected template replacement count for $($replacement.From): $count"
    $source = $source.Replace($replacement.From, $replacement.To)
    Assert-True (-not $source.Contains($replacement.From)) 'Real product integration literal remains.'
  }
  Assert-True (-not ($source -match '\$SMPROGRAMS|\$LOCALAPPDATA|\\LedgeTopFilesPilot"|Local\\LedgeTopFilesPilotInstaller|Software\\Microsoft\\Windows\\CurrentVersion\\Run|!define STARTUP_VALUE "LedgeTopFilesPilot"')) 'Real integration namespace remains.'
  Write-Utf8 (Join-Path $qa 'adapted-template.nsi') $source

  $stubSource = @'
Unicode true
!include "FileFunc.nsh"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "QA synthetic maintenance stub"
Function .onInit
  ${GetParameters} $0
  StrCmp $0 "--installer-check" stub_check
  StrCmp $0 "--installer-remove-connections" stub_remove
  FileOpen $2 "@LOG@" a
  FileWrite $2 "FORBIDDEN-NORMAL-LAUNCH|$0$\r$\n"
  FileClose $2
  SetErrorLevel 20
  Quit
  stub_check:
    ReadINIStr $1 "@CONTROL@" "Codes" "Check"
    Goto stub_log
  stub_remove:
    ReadINIStr $1 "@CONTROL@" "Codes" "Remove"
  stub_log:
    FileOpen $2 "@LOG@" a
    FileWrite $2 "$0|$1$\r$\n"
    FileClose $2
    SetErrorLevel $1
    Quit
FunctionEnd
Section
SectionEnd
'@
  $stub = Join-Path $qa 'LedgeTop.Files.exe'
  $stubSource = 'OutFile "' + (Escape-Nsis $stub) + '"' + "`r`n" + $stubSource.Replace('@CONTROL@', (Escape-Nsis $control)).Replace('@LOG@', (Escape-Nsis $log))
  $stubScript = Join-Path $qa 'stub.nsi'; Write-Utf8 $stubScript $stubSource; Compile-Nsis $stubScript 'stub'
  $notice = Join-Path $qa 'notice.txt'; Write-Utf8 $notice 'Synthetic QA notice; no app or client data.'
  $inventory = @([ordered]@{path='LedgeTop.Files.exe';bytes=(Get-Item -LiteralPath $stub).Length;sha256=(Get-FileHash -LiteralPath $stub).Hash.ToLowerInvariant()},[ordered]@{path='Notices/notice.txt';bytes=(Get-Item -LiteralPath $notice).Length;sha256=(Get-FileHash -LiteralPath $notice).Hash.ToLowerInvariant()})
  $manifest = ConvertTo-Json -InputObject $inventory -Depth 4 -Compress
  Write-Utf8 (Join-Path $qa 'payload-manifest.json') $manifest
  $sidecar = Join-Path $qa 'installed-payload-inventory.json'; Write-Utf8 $sidecar $manifest
  $manifestHash = [Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($manifest)))
  $include = @'
!macro InstallPayload
  SetOutPath "$INSTDIR"
  File /oname=LedgeTop.Files.exe "@STUB@"
  SetOutPath "$INSTDIR\Notices"
  File /oname=notice.txt "@NOTICE@"
  SetOutPath "$INSTDIR"
  File /oname=installed-payload-inventory.json "@SIDECAR@"
!macroend
!macro ValidatePayloadPaths
  Push "$INSTDIR"
  Call un.CheckPayloadPath
  Push "$INSTDIR\Notices"
  Call un.CheckPayloadPath
  Call un.CheckInventorySidecarPath
!macroend
!macro DeletePayload
  Delete "$INSTDIR\LedgeTop.Files.exe"
  Delete "$INSTDIR\Notices\notice.txt"
  Delete "$INSTDIR\installed-payload-inventory.json"
!macroend
!macro RemovePayloadDirectories
  RMDir "$INSTDIR\Notices"
!macroend
'@
  $includePath = Join-Path $qa 'payload.nsh'
  Write-Utf8 $includePath ($include.Replace('@STUB@', (Escape-Nsis $stub)).Replace('@NOTICE@', (Escape-Nsis $notice)).Replace('@SIDECAR@', (Escape-Nsis $sidecar)))
  $installers = @{}
  foreach ($version in @('1.0.0.0','1.1.0.0')) {
    $output = Join-Path $qa ('install-' + $version + '.exe')
    $prefix = '!define APP_VERSION "' + $version + '"' + "`r`n" + '!define OUTPUT_FILE "' + (Escape-Nsis $output) + '"' + "`r`n" +
      '!define PAYLOAD_MANIFEST_SHA256 "' + $manifestHash + '"' + "`r`n" + '!define PAYLOAD_INCLUDE "' + (Escape-Nsis $includePath) + '"' + "`r`n"
    $prefix += '!define SOURCE_COMMIT "' + $commit + '"' + "`r`n"
    $entry = Join-Path $qa ('install-' + $version + '.nsi'); Write-Utf8 $entry ($prefix + $source)
    Compile-Nsis $entry ('installer-' + $version); $installers[$version] = $output
    Assert-True ([Diagnostics.FileVersionInfo]::GetVersionInfo($output).Comments -ceq "LedgeTop.Files.Payload/1:${manifestHash}:$commit") 'Synthetic installer PE anchor differs.'
  }
  $old = Join-Path $product 'versions\1.0.0.0'; $current = Join-Path $product 'versions\1.1.0.0'
  $notes = Join-Path $qa 'local-notes.txt'; Write-Utf8 $notes 'Preserve local notes outside every payload.'
  $profileFixture = Join-Path $qa 'SyntheticProfileFixture'; [IO.Directory]::CreateDirectory($profileFixture) | Out-Null
  $profileData = Join-Path $profileFixture 'fixture.json'; Write-Utf8 $profileData '{"synthetic":true,"preserve":true}'
  Set-Codes 10 0
  Run-OwnedExe $installers['1.0.0.0'] '/S' 10 'running-preflight-refusal'
  Assert-True (-not [IO.Directory]::Exists($old) -and $null -eq (Read-Activation) -and -not [IO.Directory]::Exists($menu)) 'Initial refusal changed fixed integration.'
  Set-Codes 0 0
  Run-OwnedExe $installers['1.0.0.0'] '/S' 0 'retry-normal-install'
  $activation = Read-Activation
  Assert-True ($activation.location -ceq $old -and $activation.version -ceq '1.0.0.0' -and $activation.publisher -ceq 'Ledge Top Technologies LLC') 'Normal HKCU activation differs.'
  Assert-True ([IO.File]::Exists((Join-Path $old 'installer-owned.ini')) -and [IO.File]::Exists((Join-Path $old 'uninstall.exe'))) 'Normal installer receipts missing.'
  Assert-InstalledAnchors $old
  Assert-True ($null -eq (Read-Startup)) 'Installation created a startup opt-in.'
  $ownedOldStartup = '"' + (Join-Path $old 'LedgeTop.Files.exe') + '" --startup-saved-source-v1 employee'
  $ownedNewStartup = '"' + (Join-Path $current 'LedgeTop.Files.exe') + '" --startup-saved-source-v1 employee'
  $startup = $registry.CreateSubKey($startupPath)
  try { $startup.SetValue($startupValue,$ownedOldStartup,[Microsoft.Win32.RegistryValueKind]::String) } finally { $startup.Dispose() }
  $shell = New-Object -ComObject WScript.Shell
  $appShortcut = Join-Path $menu 'LedgeTop Files Pilot.lnk'
  Assert-True ([IO.File]::Exists($appShortcut) -and $shell.CreateShortcut($appShortcut).TargetPath -ieq (Join-Path $old 'LedgeTop.Files.exe')) 'Actual shortcut target differs.'
  Run-OwnedExe $installers['1.1.0.0'] '/S' 0 'newer-upgrade'
  Assert-InstalledAnchors $current
  Assert-True ((Read-Startup).value -ceq $ownedNewStartup -and (Read-Startup).kind -ceq 'String') 'Exact isolated startup opt-in did not migrate.'
  Assert-True ((Read-Activation).location -ceq $current -and [IO.File]::Exists((Join-Path $old 'LedgeTop.Files.exe'))) 'Upgrade failed to retain old version.'
  Assert-True ($shell.CreateShortcut($appShortcut).TargetPath -ieq (Join-Path $current 'LedgeTop.Files.exe')) 'Upgrade shortcut not activated.'
  $calls = Count-CleanupCalls
  Run-Uninstaller $old 20 'old-uninstaller-refusal'
  Assert-True ((Count-CleanupCalls) -eq $calls -and (Read-Activation).location -ceq $current) 'Old uninstaller invoked cleanup or changed activation.'
  Set-Codes 0 20
  $beforeCleanup = Payload-Snapshot $current
  Run-Uninstaller $current 20 'cleanup-refusal'
  Assert-PayloadUnchanged $current $beforeCleanup
  Assert-True ((Count-CleanupCalls) -eq ($calls + 1) -and [IO.File]::Exists((Join-Path $current 'LedgeTop.Files.exe')) -and (Read-Activation).location -ceq $current) 'Cleanup refusal changed payload or activation.'
  $calls = Count-CleanupCalls
  $noticeDir = Join-Path $current 'Notices'
  $savedNotice = Join-Path $qa 'saved-notice.txt'; [IO.File]::Move((Join-Path $noticeDir 'notice.txt'), (Assert-OwnedPath $savedNotice))
  [IO.Directory]::Delete((Assert-OwnedPath $noticeDir))
  $outsidePayload = Join-Path $qa 'OutsidePayloadSentinel'; [IO.Directory]::CreateDirectory($outsidePayload) | Out-Null
  $sentinel = Join-Path $outsidePayload 'notice.txt'; Write-Utf8 $sentinel 'Preserve sentinel outside payload.'
  New-Item -ItemType Junction -Path $noticeDir -Target $outsidePayload | Out-Null
  Set-Codes 0 0
  try {
    Run-Uninstaller $current 20 'nested-junction-refusal'
    Assert-True ((Count-CleanupCalls) -eq $calls -and [IO.File]::ReadAllText($sentinel) -ceq 'Preserve sentinel outside payload.' -and (Read-Activation).location -ceq $current) 'Nested alias refusal failed.'
  } finally {
    # Never alter a payload path after timeout/unknown process lifetime.
    if ($script:lastOwnedProcessTerminal) {
      $junction = Get-Item -LiteralPath $noticeDir -Force
      Assert-True ($junction.LinkType -ceq 'Junction' -and @($junction.Target).Count -eq 1 -and @($junction.Target)[0] -ieq $outsidePayload) 'Exact owned junction identity changed; retained.'
      [IO.Directory]::Delete((Assert-OwnedPath $noticeDir)) # exact own junction only, nonrecursive
    }
  }
  [IO.Directory]::CreateDirectory($noticeDir) | Out-Null
  [IO.File]::Move($savedNotice, (Assert-OwnedPath (Join-Path $noticeDir 'notice.txt')))
  $residual = Join-Path $current 'user-added-unknown.txt'; Write-Utf8 $residual 'Preserve unknown residual in version directory.'
  Run-Uninstaller $current 0 'exact-active-uninstall'
  Assert-True ($null -eq (Read-Activation) -and -not [IO.File]::Exists($appShortcut) -and -not [IO.File]::Exists((Join-Path $menu 'Uninstall.lnk'))) 'Uninstall retained active integration.'
  foreach ($file in @('LedgeTop.Files.exe','Notices\notice.txt','installed-payload-inventory.json','installer-owned.ini','uninstall.exe')) {
    Assert-True (-not [IO.File]::Exists((Join-Path $current $file))) "Owned file retained unexpectedly: $file"
  }
  Assert-True ($null -eq (Read-Startup)) 'Owned isolated startup command retained after uninstall.'
  Assert-True (-not ([IO.File]::ReadAllText($log).Contains('FORBIDDEN-NORMAL-LAUNCH|'))) 'Silent Finish launched a normal stub.'
  Assert-True ([IO.File]::ReadAllText($residual) -ceq 'Preserve unknown residual in version directory.' -and [IO.File]::ReadAllText($notes) -ceq 'Preserve local notes outside every payload.' -and [IO.File]::ReadAllText($profileData) -ceq '{"synthetic":true,"preserve":true}' -and [IO.File]::ReadAllText($sentinel) -ceq 'Preserve sentinel outside payload.') 'User/sentinel fixture changed.'
  $protectedUnchanged = $false
  if ($ProtectedProcessId -gt 0) {
    $protectedAfter = Get-Process -Id $ProtectedProcessId -ErrorAction Stop
    Assert-True ($protectedAfter.StartTime.ToUniversalTime().Ticks -eq $protectedStart) 'Protected PID identity changed.'
    $protectedUnchanged = $true
  }
  $receipt = @{schema=1;sourceCommit=$commit;templateSha256=$templateHash;adaptedTemplateSha256=[Convert]::ToHexStringLower([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($source)));
    compilerSha256=$compilerPin;qaRoot=$qa;registryKey=$registryPath;startupKey=$startupPath;startupValue=$startupValue;registryAbsent=$true;syntheticPayloadOnly=$true;actualProductInstallation=$false;nativeConnectionAcceptance=$false;
    payloadInventorySha256=$manifestHash;sidecarIncluded=$true;sourceMarkerVerified=$true;installerPeAnchorVerified=$true;silentFinishNormalLaunchObserved=$false;startupMigrationVerified=$true;startupOwnedValueRemoved=$true;
    protectedPid=$(if ($ProtectedProcessId -gt 0) { $ProtectedProcessId } else { $null });protectedPidStartUnchanged=$protectedUnchanged;
    processProtectionChecked=($ProtectedProcessId -gt 0);unknownResidualAndFixturesPreserved=$true;olderPayloadRetained=$true;phases=@($phases.ToArray())}
  Write-Utf8 (Join-Path $qa 'receipt.json') ($receipt | ConvertTo-Json -Depth 6)
  $receipt | ConvertTo-Json -Depth 6
} catch {
  Write-Utf8 (Join-Path $qa 'failure.txt') ($_ | Out-String)
  throw "Isolated installer QA failed: $($_.Exception.Message) Artifacts: $qa"
} finally {
  # Never hide a failed/uncertain outcome by deleting remaining activation metadata.
  # The actual isolated uninstaller must remove its key. Failure leaves exact evidence.
  if ($registryPath -cne ('Software\Microsoft\Windows\CurrentVersion\Uninstall\LedgeTopFilesInstallerQA-' + $id)) { throw 'Cleanup namespace differs.' }
  $registry.Dispose()
}
