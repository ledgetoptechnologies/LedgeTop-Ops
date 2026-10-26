# Connecting authorized catalogs to Windows Explorer

This source slice connects the existing selected client/employee backend to the
Explorer provider through Settings and Activity. It is not included in the
published generated-data v2 ZIP and does not claim accepted live staging
delivery or two-way sync.

`ExplorerCatalogSnapshotBuilder.CaptureAsync` takes exactly one selected backend,
channel and expected server principal. It exhausts section/root/folder pages,
preserves empty folders, selects durable non-authorizing references, and resolves
each file to immutable version/length/ETag/SHA pins. The result contains paths and
placeholder identities, with no tokens, content URLs, continuation values or
adapter-private payloads. It performs no file downloads or filesystem/native
changes. It refuses a partial or unsafe inventory rather than silently omitting
files. Limits match the provider: 1,000 combined entries, 32 path components,
180 relative characters, 64 GiB per file and 4 KiB per encoded identity.

The builder checks the cached gateway session at capture boundaries and the
authoritative selected source session before and after metadata operations.
Configuration object replacement, source/origin/principal changes, expiry,
cancellation, repeated cursors, folder cycles, Windows case collisions and
listing/manifest mismatches all abort capture. Catalog APIs have no snapshot
revision token, so this is a bounded inventory across requests, not an atomic
remote snapshot or permission to rename/delete local content during refresh.

For the production `LiveBackend`, capture additionally leases the exact cached
credential through the same `CloudflareAccessSession` instance shared by its
catalog and queue source. The normal helper reads the credential. Every later
credential returned for an HTTP header must match an in-memory digest; an observed
change invalidates all overlapping leases, including A→B→A changes. The lease
exposes no token or digest, starts no browser and grants no authority. The server
still validates authentication and resource access on every request. A legitimate
credential renewal also aborts this bounded capture; dispose the lease and start
a new capture. Explicit browser login cannot race a pending or active lease.

Validation: full Core suite 131/131, including header-use and lease/login race
tests; targeted App catalog suite 9/9, including the real LiveBackend composition
branch's acquisition, held-operation lifetime, success/failure/cancellation
cleanup and configuration changes. These use synthetic credentials/catalogs and
prove neither server identity admission nor native Explorer acceptance.

`OwnedExplorerRootSession` shares the ownership/journal lifecycle with the
generated facade. Connected schema3 stores a canonical, digest-bound credentialless
manifest and source scope; generated schema2 remains compatible. A pre-extraction
binary seeded a schema2 profile that the extracted facade successfully resumed
in another process. Eight separate-process connected-engine phases with generated
fixtures verified persisted inventory, drift refusal, cached-auth resume and
offline removal; no real server was involved.

`ConnectedExplorerSession` constructs no backend until an explicit connection action. It signs
into one selected source, captures new inventory or reopens the saved frozen
inventory, and records its current-user cleanup index before native activation.
A different principal cannot overwrite an active connection's index. Remove
uses an authentication-denying cleanup source and preserves local files; even a
missing helper leaves the local cleanup UI available. Quit cancels pending login
or capture before draining the provider and releasing its backend. Periodic
cached-only session rechecks pause new downloads on changed identity/access;
they cannot open a browser. Full App suite passed 58/58 groups; subsequent
coordinator acceptance covers ten cases within one group, including cancellation
of default-token engine reads and durable removal recovery. Source choice,
settings and tray lifecycle are also covered.

The explicit **Reconnect saved files** action instead opens only an owned ready
frozen generation for the same cached principal. It never signs in, recaptures
inventory or rewrites the cleanup index. It compares frozen scope/digest before
and after recreating the engine and retains paused state. Absent, removed,
incomplete or corrupt generations do not offer the action. This supports a normal
relaunch without an automatic browser prompt; no automatic startup reconnect is
enabled. Eleven isolated coordinator cases and fake WPF click/cancel/quit checks
cover this path. New root generations use the approved LT icon; exact legacy
yellow-folder receipts remain compatible. See
`staging/windows-explorer-brand-icon-2026-10-25.md` for explicit migration steps.

New branded-root native preflight acceptance at
`C:/Users/fstor/AppData/Local/LedgeTopFilesConnectedPreflightTests/bdb1459a059a4c12a1d957c815f84610/receipt.json`
passed four phases: signed-out Prepared/no-registration, offline removal with no
source calls, synthetic sign-in with exact README hydration, and revoked-source
offline removal with native/HKLM/linked-HKCU absence and local files retained.
The saved Removed receipt pins the approved digest-addressed icon. This is native
synthetic acceptance, not a visual observation or connected server-byte test.
The integrated branding/reconnect/update-lifecycle revision passed all 59 App
groups (11 coordinator cases), followed by focused settings rendering after
adding a saved-connection screenshot. The rendered reconnect button is visible
without clipping. Update lifecycle tests use fake deployment/restart only; the
Windows adapter's 21 separate checks validate input and unconfigured behavior.

A connected engine persists its Prepared ownership and canonical manifest before
checking cached authorization, before creating any root or attempting Windows
registration. Four native preflight phases verified this ordering, safe offline
removal after authorization failure and later verified hydration. A saved active
index with a missing engine receipt is ambiguous and blocks both Start and
removal claims; missing directories never prove Windows integration absence.
The app retains that state for ownership review rather than recreating a root or
forgetting a possibly active registration. Confirmed removal has a durable index
marker; the engine's durable Removed phase also covers interruption before that
index update.

Current inventory is frozen rather than automatically refreshed. Changed remote
versions refuse hydration. Explicit removal then reconnect captures a fresh
generation into a new directory, keeping prior local files. Source-session
checks remain around every metadata request despite their initial-capture cost;
the token lease complements them rather than replacing admission-version checks.

On October 25 at 23:04 UTC, a finite normal cached-only staging observation
returned HTTP 302 for both client and employee queue/session requests. The strict
sources refused redirects. No destination, headers, credentials or response body
were recorded; only numeric completion status and a bounded outcome were saved.
This does not establish the redirect's cause or current file access. No new login,
permission change, grant, file byte request or remote write occurred. October 23
ordinary live-transfer acceptance is historical; its temporary grants were
revoked. A fresh explicit human session and currently approved synthetic source
authority are needed for the combined connected Explorer test.
