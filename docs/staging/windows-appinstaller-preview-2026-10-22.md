# Offline App Installer descriptor construction

`scripts/windows-appinstaller-preview.ps1` extends the existing unsigned package
construction rehearsal. It does not sign, install, launch, host or publish an
application, contact a URL, register an updater, or change Windows trust.
`windows-package-preview.ps1` is unchanged.

The generator reads the **actual MSIX archive manifest**, compares all identity
fields with the retained unpacked manifest, and checks the actual package SHA-256
and byte length against the existing construction receipt. It accepts only the
existing `LedgeTop.Files.PilotBuildPreview` / `CN=LedgeTop Build Preview` x64
identity. This is a temporary build-preview identity, not a selected durable
publisher or stable/pilot publication channel.

The explicit `-PreviewOnly` switch and a matching unsigned construction receipt
are required. A signed/release receipt is rejected. Descriptor/package URLs must
be explicit canonical HTTPS URLs on the same reserved `.invalid` origin without
credentials, ports, escaping, query strings or fragments. The local output ends
in `.preview.appinstaller.xml`, contains a warning comment, and cannot become a
normal hosted update channel through this tool. Existing output is never replaced.

## Run after the existing package rehearsal

Use the package rehearsal's retained directory. These `.invalid` addresses are
offline test inputs; they are not DNS or hosting proposals.

```powershell
$root = 'C:/absolute/local/package-preview-directory'
$receipt = Get-Content -LiteralPath "$root/receipt.json" -Raw | ConvertFrom-Json
pwsh -NoProfile -File scripts/windows-appinstaller-preview.ps1 -PreviewOnly `
  -PackagePath "$root/preview.msix" `
  -UnpackedManifestPath "$root/unpacked/AppxManifest.xml" `
  -ConstructionReceiptPath "$root/receipt.json" `
  -ExpectedPackageSha256 $receipt.packageSha256 `
  -DescriptorUrl 'https://installer-preview.example.invalid/windows/pilot/preview.appinstaller' `
  -PackageUrl 'https://installer-preview.example.invalid/windows/pilot/preview-0.0.0.1.msix' `
  -OutputDirectory 'C:/absolute/local/new-descriptor-directory'

pwsh -NoProfile -File scripts/windows-appinstaller-preview.test.ps1 `
  -ConstructionDirectory $root
```

The generated descriptor uses the **2021 default namespace for every element**,
`MainPackage` attributes from the packaged identity, and update settings with
12-hour on-launch checks, no prompt, no activation blocking, and automatic
background checks. `ForceUpdateFromAnyVersion` is absent. Microsoft's current
[creation guide](https://learn.microsoft.com/en-us/windows/msix/app-installer/how-to-create-appinstaller-file)
shows the 2021 namespace and requires package identity matching. The
[OnLaunch reference](https://learn.microsoft.com/en-us/uwp/schemas/appinstallerschema/element-onlaunch)
describes the launch settings, and the
[update settings guide](https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings)
describes the independent background check and higher-version behavior.

## Evidence and remaining gates

The adjacent JSON is the observed local rehearsal receipt. Checks parse the XML,
verify namespaces and package attributes, verify the descriptor SHA-256, and
exercise 18 negative cases including mismatched manifest identity, wrong package
hash, release misuse, unsafe URLs, XML injection and prohibited external entities.
XML is written through `XmlWriter`, and input XML prohibits DTD processing.

The recorded construction package is the 522-file Go/runtime-notices rehearsal
from `51a083b639f37f6810848a365cdbbb36c943564f`, 83,809,359 bytes, SHA-256
`b7c01c87461471def1a432b2554c2b734aeb9042a4a5e47e5fd00ab4b7b7e472`.
The archived descriptor SHA-256 is
`8f419370ec5548ba01702d7607aaddd7bf7146acc3e7d3a97d7c7ab1afd5414b`.

These checks are **not Microsoft XSD validation or Windows installer execution**.
The preview package remains unsigned, uninstalled and unpublished. The descriptor
does not add a package digest field to Microsoft's schema; package/descriptor
digests are in the separate evidence receipt. A production release still requires
an approved persistent signing identity and hosting origin, actual signature and
trust verification, monotonic versions, authorization-safe delivery, and real
clean-machine install/update/rollback testing. Nothing here qualifies those gates.
