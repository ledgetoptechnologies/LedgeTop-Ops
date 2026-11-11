param()
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$repo=Split-Path -Parent $PSScriptRoot;$template=Join-Path $repo 'apps/windows-download/Packaging/UnsignedInstaller.nsi';$text=[IO.File]::ReadAllText($template)
$functions=@();foreach($name in @('ClassifyInitialStartup','CheckObservedMigratedStartup')){$match=[regex]::Matches($text,'(?ms)^Function '+[regex]::Escape($name)+'\r?\n.*?^FunctionEnd');if($match.Count-ne 1){throw 'Expected one classifier.'};$functions+=$match[0].Value}
$compiler=Join-Path $env:USERPROFILE '.codex/cache/windows-download-nsis-3.13-20261025/toolchain/nsis-3.13/Bin/makensis.exe';if((Get-FileHash $compiler).Hash.ToLowerInvariant()-cne'65343c225ec88393cc4453b0963caf63f763f42f48cb55736d51893ff2e29d4a'){throw 'Compiler mismatch.'}
$base=[IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.codex/tmp'));$work=Join-Path $base ('startup-classifier-'+[Guid]::NewGuid().ToString('N'));[IO.Directory]::CreateDirectory($work)|Out-Null
$script=Join-Path $work 'test.nsi';$exe=Join-Path $work 'test.exe';$result=Join-Path $work 'result.txt';$config=Join-Path $work 'empty';[IO.Directory]::CreateDirectory($config)|Out-Null
$header=@'
Unicode true
RequestExecutionLevel user
SilentInstall silent
!define PRODUCT_BASE "C:\synthetic\pilot"
Var ExistingVersion
Var StartupInitial
Var StartupReadable
Var StartupText
Var StartupFailed
'@
$cases=@'
Section
  StrCpy $INSTDIR "C:\synthetic\pilot\versions\2.0.0.0"
  StrCpy $ExistingVersion "1.0.0.0"
  StrCpy $StartupReadable 1
  StrCpy $StartupText '"${PRODUCT_BASE}\versions\$ExistingVersion\LedgeTop.Files.exe" --startup-saved-source-v1 employee'
  Call ClassifyInitialStartup
  FileOpen $0 "$EXEDIR\result.txt" w
  FileWrite $0 "initial=$StartupInitial$\r$\n"
  StrCpy $StartupText '"$INSTDIR\LedgeTop.Files.exe" --startup-saved-source-v1 employee'
  Call CheckObservedMigratedStartup
  FileWrite $0 "matching=$StartupFailed$\r$\n"
  StrCpy $StartupReadable 0
  Call CheckObservedMigratedStartup
  FileWrite $0 "missing=$StartupFailed$\r$\n"
  StrCpy $StartupReadable 1
  StrCpy $StartupText 'foreign'
  Call CheckObservedMigratedStartup
  FileWrite $0 "changed=$StartupFailed$\r$\n"
  Call ClassifyInitialStartup
  Call CheckObservedMigratedStartup
  FileWrite $0 "foreign=$StartupFailed$\r$\n"
  StrCpy $StartupReadable 0
  Call ClassifyInitialStartup
  Call CheckObservedMigratedStartup
  FileWrite $0 "absent=$StartupFailed$\r$\n"
  StrCpy $StartupReadable 1
  StrCpy $StartupText '"${PRODUCT_BASE}\versions\$ExistingVersion\LedgeTop.Files.exe" --startup-saved-source-v1 portal'
  Call ClassifyInitialStartup
  StrCpy $StartupText '"$INSTDIR\LedgeTop.Files.exe" --startup-saved-source-v1 portal'
  Call CheckObservedMigratedStartup
  FileWrite $0 "portal=$StartupFailed$\r$\n"
  FileClose $0
SectionEnd
'@
[IO.File]::WriteAllText($script,$header+"`nOutFile `"$exe`"`n"+($functions -join "`n")+"`n"+$cases,[Text.UTF8Encoding]::new($false))
$start=[Diagnostics.ProcessStartInfo]::new($compiler);$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.Environment['NSISDIR']=Split-Path -Parent (Split-Path -Parent $compiler);$start.Environment['NSISCONFDIR']=$config;foreach($a in @('/NOCONFIG','/WX','/V2',$script)){$start.ArgumentList.Add($a)}
$p=[Diagnostics.Process]::Start($start);$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync();if(-not$p.WaitForExit(30000)){try{$p.Kill($true)}catch{};if(-not$p.WaitForExit(5000)){throw "Compiler exit uncertain: $($p.Id)"};throw 'Compiler timed out.'};if($p.ExitCode-ne 0){throw ('Compiler failed: '+$out.GetAwaiter().GetResult()+$err.GetAwaiter().GetResult())};$p.Dispose()
$run=Start-Process -FilePath $exe -WindowStyle Hidden -PassThru;try{if(-not$run.WaitForExit(30000)){try{$run.Kill($true)}catch{};if(-not$run.WaitForExit(5000)){throw "Probe exit uncertain: $($run.Id)"};throw 'Probe timed out.'};if($run.ExitCode-ne 0){throw 'Probe failed.'}}finally{$run.Dispose()}
$expected=@('initial=employee','matching=0','missing=1','changed=1','foreign=0','absent=0','portal=0');$actual=[IO.File]::ReadAllLines($result);if(($actual -join '|')-cne($expected -join '|')){throw ('Startup classifier output differs: '+($actual -join ','))}
[IO.File]::Delete($result);[IO.File]::Delete($exe);[IO.File]::Delete($script);[IO.Directory]::Delete($config);[IO.Directory]::Delete($work)
'PASS exact NSIS startup classifiers: matching, removed, foreign, initially foreign/absent and portal; synthetic only.'
