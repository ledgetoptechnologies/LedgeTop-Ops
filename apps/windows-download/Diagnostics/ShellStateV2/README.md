# Company-files Shell diagnostic, revision 2

Source only. This is not a new published laptop download. The existing staged
revision 1 ZIP remains unchanged and supports the current schema3 pilot.

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

The unchanged drag-and-drop CMD is retained as future packaging source. It uses a
process-only execution-policy bypass inherited from revision 1; it does not change
persisted Windows policy and cannot override organization policy. CI uses the
PowerShell wrapper directly without that override. Review and qualify a new
versioned ZIP before distributing it; do not replace an existing version in place.
