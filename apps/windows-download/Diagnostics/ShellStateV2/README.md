# Company-files Shell diagnostic, revision 2

Packaged on October 27, 2026 as `LedgeTop-Files-Explorer-Diagnostics-v2.zip`
alongside Pilot 0.5.4 in the existing staging share. The three collector/wrapper
source files match the immutable installer source commit
`97186ac096b9d4627555fe99417c9d04d2855284`. The existing revision 1 ZIP remains
unchanged and supports only schema3. Live v2 collection on the laptop is still
unverified; its report is the next diagnostic after successful Company connection.

This Windows PowerShell 5.1 diagnostic admits only the current user's fixed pilot
Company-files index and its derived credentialless profile path. Schema3 requires
the original exact keys and legacy `LedgeTop Files Preview` label. Schema4 requires
the same keys plus the exact `LedgeTop Files — Company files` display name. Other
schemas, extra or duplicate keys, null labels and Client-deliveries labels refuse.
Labels never replace index/source/principal, SID, context, native root identity or
selected-child association checks. Profile and index contents are not returned.

The report schema is `LedgeTop.Files.ShellDiagnostic/2`. Its only additional
observation is `Registration.DisplayNameMatchesReceipt`, a boolean read from the
same exact provider key already inspected by revision 1. The underlying native
provider name and ID remain unchanged. No package identity query, parent-folder
observation, namespace activation or expanded registry scope is included.

`Collect` retains the original metadata-only physical-path and selected-placeholder
fences. It never reads file bodies, hydrates, invokes menus, registers a provider,
changes settings or uploads a report. Fast-property absence remains inconclusive.
`SaveReport` creates a new redacted JSON under the existing pilot Diagnostics
directory. A report is a snapshot, not proof that Explorer displays its native menus.

For source validation only, run this exact wrapper in a fresh Windows PowerShell
5.1 process with a private temporary directory:

```powershell
powershell.exe -NoProfile -File .\Read-LedgeTopShellState.ps1 -PureTestsOnly
```

This compiles the same collector source and runs synthetic schema3/schema4 profile,
authority-tamper, path, JSON and ABI fixtures. It does not call `ReadBinding`,
`Collect` or `SaveReport`, inspect a real profile, query registry/Shell/native file
metadata, or create a provider. Successful pure tests do not qualify live collection.

The unchanged drag-and-drop CMD is included in the versioned ZIP. It uses a
process-only execution-policy bypass inherited from revision 1; it does not change
persisted Windows policy and cannot override organization policy. CI uses the
PowerShell wrapper directly without that override. The published ZIP was inspected
and its source hashes checked before sharing. Future changes require a new
versioned ZIP; do not replace an existing version in place.
