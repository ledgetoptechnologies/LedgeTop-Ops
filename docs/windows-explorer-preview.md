# Windows Explorer generated-data preview

This development milestone adds a settings/activity window, system tray lifecycle,
and a persistent, current-user Windows Cloud Files preview. It does not connect the
Explorer provider to live Operations, upload local files, or provide two-way sync.
The existing connected manual downloader remains a separate route.

Build the app with `LedgeTopDeveloperBuild=true` and launch `--explorer-demo`.
Registration starts only after the person clicks **Start Explorer preview**.
The default profile is `%LOCALAPPDATA%/LedgeTopFilesExplorerPreview/v2`; the first
unused `LedgeTop Files Preview` directory under the user profile becomes its root.
Existing directories are never adopted. Preview registration uses the supported
StorageProviderSyncRootManager broker. Exact native context, root file ID,
HKLM provider metadata and generated HKCU namespace identity are checked;
negative WinRT enumeration results do not prove absence.

Files are generated immutable README, CSV, SVG and nested text samples. Ordinary
reads hydrate verified bytes using the existing download and transfer pipeline.
Native pin intent drives a bounded serial worker for recursive keep/free actions.
Source revocation denies hydration even when verified bytes are cached. Modified
local files are preserved and excluded from native management. No upload occurs.
Subset cancellation and broader native cancellation stress remain unqualified.

The next source revision also accepts an explicit directory inventory, including
empty nested folders and entirely empty authorized roots. The combined file and
directory inventory is bounded to 1,000 entries, 32 components per path and 180
relative characters. File/directory collisions and identities above the native
4 KiB ceiling are refused before connecting or creating placeholders. These
changes are separate from the already published v2 ZIP.

Closing Settings hides to a working tray. Explicit Quit disconnects and retains
the profile, registration and local files. Relaunch then Start reconnects the exact
existing placeholders; paused state persists. **Remove Explorer preview** drains,
checks owned placeholders, journals intent and calls the supported unregister once.
It verifies native, HKLM and linked HKCU absence and preserves local files. A new
Start uses a fresh generation and directory.

Interrupted or foreign ownership states fail closed. Verified partial registration
pins are retained. An uncertain partial unregister is observed without replaying
the mutation and needs an exact ownership review. A crash before the first profile
marker is saved can leave an unowned empty profile directory that requires review;
the app deliberately refuses to adopt arbitrary pre-existing directories.

Validation on the Windows development machine:

- Core: 127 test groups passed, including range normalization and copied duplicate
  FETCH callback retirement, with cancellation and stop fencing.
- App: 48 groups passed, including tray, single instance and settings lifecycle.
- Full brokered native acceptance: 14 phases passed, including unaligned open,
  full hashes, recursive folder keep/free, zero-byte sample, dirty-file protection,
  offline pinned reads, reconnect, revocation denial and exact removal/absence.
- Separate-process persistent session acceptance passed: seed, paused restart,
  cached read, resume hydration, removal preserving a local note, fresh generation.
- Subsequent explicit-directory native acceptance passed 15 phases. Separate
  empty-inventory acceptance passed seven phases for empty and directory-only
  roots, native folder pin/free attribute readback, reconnect and exact cleanup;
  five malformed manifests were refused without native registration.
- Notice composition verifies the exact .NET runtime packages and Windows SDK
  projection binaries with eight vendor notices. It does not assert complete
  third-party attribution for every bundled component.

Beau subsequently confirmed the published v2 build on his laptop: the LedgeTop
Explorer entry and both native context-menu actions appeared; keeping Samples,
freeing its space and reopening sample.csv completed successfully. This is human
acceptance of the generated-data v2 sequence, distinct from the API receipts and
from connected staging. The desktop computer-use session remains stopped after
Escape; no assistant on-screen control was resumed. No production
deployment, clean-machine installer, trusted signing, live sign-in or real upload
has been qualified by this preview.

## Verified cache reclamation

After native dehydration succeeds, Free up space also reclaims the exact
verified hydration-cache file. This local operation makes no authentication,
catalog or download calls. It checks the connection's channel, source, origin
and principal, requires existing ownership markers and cache leases, and verifies
length and SHA256 before deleting through the same open Windows file handle.
Missing entries are a no-op; changed bytes, foreign ownership, aliases and active
leases are preserved or refused. Placeholder and locally edited files are never
deleted by this cache operation.

Hydration and cache reclamation share serialization and leases, so an active
transfer finishes or cancels before its verified cache can be removed. The native
oplock closes before waiting for those leases. Shutdown stops availability-work
admission, cancels and disconnects the provider, and joins admitted operations
before disposal completes. The online-only activity receipt follows successful
cache reclamation. A later authorized open downloads missing cache bytes again;
fresh source authorization is still required before reusing any retained cache.

Validation: 147 Core groups and 61 App groups passed. The seven focused cache
groups passed again after the portable-fixture and Windows BOOLEAN ABI changes.
The latest native-only generated-data fixture passed 16 phases, including actual
cache absence, zero source calls during offline free space, a fresh download on
reopen, recursive reclamation, dirty-file protection and exact unregistration.
An explicit free-space request was pending when shutdown began; disposal joined
it and refused later availability work. This remains generated-source acceptance,
separate from installation and authenticated staging-file transfer.
