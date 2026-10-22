param([Parameter(Mandatory)][string]$ConstructionDirectory)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'windows-appinstaller-preview.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('ledge-top-appinstaller-tests-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$constructionPath = Join-Path $ConstructionDirectory 'receipt.json'
$construction = Get-Content -LiteralPath $constructionPath -Raw | ConvertFrom-Json
$arguments = @{
  PreviewOnly=$true;PackagePath=(Join-Path $ConstructionDirectory 'preview.msix')
  UnpackedManifestPath=(Join-Path $ConstructionDirectory 'unpacked/AppxManifest.xml')
  ConstructionReceiptPath=$constructionPath;ExpectedPackageSha256=$construction.packageSha256
  DescriptorUrl='https://installer-preview.example.invalid/windows/pilot/preview.appinstaller'
  PackageUrl='https://installer-preview.example.invalid/windows/pilot/preview-0.0.0.1.msix'
  OutputDirectory=(Join-Path $root 'descriptor')
}
$receipt = & $script @arguments | ConvertFrom-Json
$output = Join-Path $arguments.OutputDirectory 'LedgeTop.Files.preview.appinstaller.xml'
$document = [Xml.XmlDocument]::new(); $document.Load($output)
$ns = [Xml.XmlNamespaceManager]::new($document.NameTable)
$schema = 'http://schemas.microsoft.com/appx/appinstaller/2021'
$ns.AddNamespace('a',$schema)
function Assert($Condition,[string]$Reason) { if (-not $Condition) { throw $Reason } }
Assert ($document.DocumentElement.NamespaceURI -ceq $schema) 'Wrong root namespace.'
Assert ($document.SelectNodes('//*').Where({$_.NamespaceURI -cne $schema}).Count -eq 0) 'Mixed element namespaces.'
$main = $document.SelectSingleNode('/a:AppInstaller/a:MainPackage',$ns)
Assert ($null -ne $main -and $document.SelectNodes('/a:AppInstaller/a:MainPackage',$ns).Count -eq 1) 'Expected exactly one main package.'
foreach ($name in @('Name','Publisher','Version','ProcessorArchitecture')) { Assert ($main.GetAttribute($name) -ceq $receipt.identity.$name) 'MainPackage identity mismatch.' }
$launch = $document.SelectSingleNode('/a:AppInstaller/a:UpdateSettings/a:OnLaunch',$ns)
Assert ($launch.GetAttribute('HoursBetweenUpdateChecks') -ceq '12' -and $launch.GetAttribute('ShowPrompt') -ceq 'false' -and $launch.GetAttribute('UpdateBlocksActivation') -ceq 'false') 'Launch checks must stay silent/nonblocking.'
Assert ($null -ne $document.SelectSingleNode('/a:AppInstaller/a:UpdateSettings/a:AutomaticBackgroundTask',$ns)) 'Missing background checks.'
Assert ($document.SelectNodes('//*[local-name()="ForceUpdateFromAnyVersion"]').Count -eq 0) 'Downgrade permission must be absent.'
Assert ($receipt.signed -eq $false -and $receipt.published -eq $false -and $receipt.installed -eq $false) 'Preview receipt overstated readiness.'
Assert ((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $receipt.descriptorSha256) 'Descriptor hash mismatch.'
$negativeCases = [Collections.Generic.List[string]]::new()
function Denied([string]$Name,[hashtable]$Changes) {
  $candidate = $arguments.Clone()
  $candidate.OutputDirectory = Join-Path $root ('denied-' + [Guid]::NewGuid().ToString('N'))
  foreach ($key in $Changes.Keys) { $candidate[$key] = $Changes[$key] }
  $failed = $false
  try { & $script @candidate | Out-Null } catch { $failed=$true }
  Assert $failed "Unsafe case accepted: $Name"
  $negativeCases.Add($Name)
}
Denied 'preview opt-in required' @{PreviewOnly=$false}
Denied 'wrong package SHA' @{ExpectedPackageSha256=('0'*64)}
Denied 'HTTP descriptor' @{DescriptorUrl='http://installer-preview.example.invalid/preview.appinstaller'}
Denied 'live host cannot become preview release channel' @{DescriptorUrl='https://portal.ledgetop.app/preview.appinstaller'}
Denied 'userinfo' @{DescriptorUrl='https://user@installer-preview.example.invalid/preview.appinstaller'}
Denied 'port' @{DescriptorUrl='https://installer-preview.example.invalid:443/preview.appinstaller'}
Denied 'query' @{DescriptorUrl='https://installer-preview.example.invalid/preview.appinstaller?token=x'}
Denied 'fragment' @{PackageUrl='https://installer-preview.example.invalid/preview.msix#x'}
Denied 'different origin' @{PackageUrl='https://other.example.invalid/preview.msix'}
Denied 'XML URL injection' @{PackageUrl='https://installer-preview.example.invalid/preview.msix"/><Injected/>'}
Denied 'encoded path' @{PackageUrl='https://installer-preview.example.invalid/%2e%2e/preview.msix'}
Denied 'no overwrite' @{OutputDirectory=$arguments.OutputDirectory}
$originalManifest = [IO.File]::ReadAllText($arguments.UnpackedManifestPath)
foreach ($case in @(
  @{name='mismatched name';old='LedgeTop.Files.PilotBuildPreview';new='LedgeTop.Files.Stable'},
  @{name='mismatched publisher';old='CN=LedgeTop Build Preview';new='CN=Different Publisher'},
  @{name='mismatched version';old='Version="0.0.0.1"';new='Version="0.0.0.2"'},
  @{name='publisher XML injection';old='CN=LedgeTop Build Preview';new='CN=Build &quot;/&gt;&lt;Injected/&gt;'}
)) {
  $path = Join-Path $root ([Guid]::NewGuid().ToString('N')+'.xml')
  Assert ($originalManifest.Contains($case.old)) 'Negative fixture expected identity is absent.'
  [IO.File]::WriteAllText($path,$originalManifest.Replace($case.old,$case.new))
  Denied $case.name @{UnpackedManifestPath=$path}
}
$path = Join-Path $root 'xxe.xml'
[IO.File]::WriteAllText($path,'<!DOCTYPE Package [<!ENTITY xxe SYSTEM "file:///C:/not-accessed">]><Package>&xxe;</Package>')
Denied 'DTD external entity' @{UnpackedManifestPath=$path}
$altered = Get-Content -LiteralPath $constructionPath -Raw | ConvertFrom-Json
$altered.status='signed_release';$altered.signed=$true
$path = Join-Path $root 'not-preview.json';$altered | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path
Denied 'release receipt rejected' @{ConstructionReceiptPath=$path}
[ordered]@{status='offline_descriptor_checks_passed';negativeCases=@($negativeCases);negativeCaseCount=$negativeCases.Count;packageSha256=$receipt.packageSha256;descriptorSha256=$receipt.descriptorSha256;outputDirectory=$arguments.OutputDirectory;signed=$false;installed=$false;published=$false;schemaXsdValidated=$false;windowsUpdateBehaviorTested=$false} | ConvertTo-Json -Depth 4
