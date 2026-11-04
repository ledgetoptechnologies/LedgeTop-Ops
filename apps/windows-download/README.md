# LedgeTop Files Windows pilot

The Windows app provides a settings/activity window, a system-tray lifecycle,
branded File Explorer navigation, and a read-only Cloud Files provider for
employee Company files. Local additions and edits are not uploaded. Client
routing is unavailable in this release; two-way NAS/R2 sync is not implemented.

Unsigned, per-user test packages are staged in `S:\LedgeTop Operations\Sync App`.
Use `CURRENT-STAGING-STATUS.txt` for current package and test status; versioned
receipts retain historical observations. Authenticode signing is off. The
in-app update feed is disabled in current candidate 0.5.37, so this build
updates only through its installer.

## Current verification — November 3, 2026

- Commit `187cd89d` fixes the cache ownership-pin disposal race by synchronizing
  pin registration with coordinator disposal, and uses managed ownership checks
  on non-Windows hosts. It is the source for optional candidate 0.5.37. The
  exact installer was installed and launched in the staging VM, but connected
  sign-in, real downloads, Explorer actions and tray appearance were not tested.
- Current uncommitted diagnostics add numeric Activity fields for quota-gate
  wait/hold, recursive cache-walk time and reservation-scan time. The closed
  diagnostic parser accepts those exact optional fields while retaining its
  existing stored schema. The current Core run passed 196/196 groups, the
  focused timing and quota-gate runs passed 3/3 each, and `git diff --check`
  passed. Desktop AppTests then passed 87/87 with a short synthetic artifact
  path. These harnesses do not exercise live sign-in or installed virtual files.
  This change does not alter cache ownership or capacity checks and is not yet
  packaged.
- Source inspection shows each cold miss scans the cache tree and reservation
  records while holding the shared quota gate. Concurrent cold files therefore
  serialize these checks; this is a plausible performance contributor, not a
  proven cause of the remaining VM stall or a measured live-file bottleneck.
- Diagnostic `899f6320` compares reopening a fixed synthetic marker with
  reading a retained handle while another native request is held pending. Its
  local tests and independent review passed; a VM run was requested. It does
  not exercise reservation accounting or prove physical file identity.
- The test-only retained-handle prototype through `5cb16c90` passed an
  ordinary Windows controlled owner-process termination and reopen check.
  Independent review confirmed unidentified child/cleanup outcomes are treated
  as uncertain; its managed watchdog is not a hard wall-clock guarantee if
  startup or scheduling stalls. This is not an OS-crash or Cloud Files test.
- Test-only `998544de` passed ordinary Windows retained-handle identity,
  sharing, replacement-refusal and exact cleanup checks. It does not exercise
  Cloud Files, provider concurrency, a process crash or adversarial ancestor
  races, and does not establish a safe production reservation implementation.
- Unshipped installer change `e92e3f46` distinguishes a missing legacy
  Preview ownership receipt from verified removal, without deleting unknown
  entries. The updated NSIS template suite passes 30/30, including busy-branch
  mutation and silent-default checks; the change is not in staged 0.5.36 and
  has not been executed as an installer in a VM.
- Claude reports `ec631825` synthetic fail-fast VM trace attributed three
  callbacks to the two test reader PIDs; both readers eventually succeeded.
  The extra callback invalidated the strict comparison, so the fixture was
  preserved. Process IDs do not identify an operating-system filter or prove
  why the earlier file open returned; no production change follows from this.
- Claude reports `4d253d8a` synthetic fail-fast VM test observed one native
  unavailable completion and a subsequent third callback; both readers later
  succeeded. Because the required reader failure and callback counts did not
  match, the harness correctly returned failure and preserved the fixture.
  Timing is suggestive but does not prove what released the blocked open or
  identify a Windows filter; no production fail-fast behavior was enabled.
- Claude reports the two-reader `e1382c10` serial synthetic control also
  failed with the availability scanner disabled and progress enabled; one
  reader passed. Disabling the scanner was insufficient in that comparison.
  No Defender setting was changed and no production fix is established.
- Claude reports synthetic serial control `e1382c10` passed one reader but
  failed two in two attempts; four was not run. A dump showed the exclusive
  holder in a Windows file-open call during reservation cleanup while another
  callback waited for admission. Consequently serialization is not a proven
  mitigation, and no production concurrency change was made. The operating
  system or filter responsible for the wait remains unidentified.
- Claude reports the `d0be6fd4` two-reader VM trace stalled in the reservation
  record read while quota was held. A synthetic provider process dump showed
  the holder in the Windows file-open call from `ReadReservation` and another
  worker waiting for quota. The one-reader control passed. This identifies the
  immediate wait, not the responsible Windows filter or a safe fix; the failed
  fixture and reservation were preserved.
- Unshipped `17ea9fc9` extracts cache preparation without adding early timeout
  or changing the lock order. Independent review found the entry/admission
  lease, failure settlement and download cleanup ordering preserved. Core
  195/195 and app 87/87 synthetic groups passed; this is not a native or live
  performance fix and is not in staged 0.5.36.
- Claude reports `b880473d` VM reservation tests with pre-created ownership
  markers passed with one reader but stalled with two, this time inside the
  quota-protected reservation accounting routine. The exact blocked operation
  and filesystem cause remain unknown; the synthetic reservation and native
  registration were preserved. This is not a production fix.
- The VM retained several older installed-version folders. Installer review
  found that retention is deliberate: the current per-session maintenance lock
  and available ownership evidence do not prove every old folder is unused or
  safe to delete. Do not prune by version name or run an old uninstaller.
- At `b880473d`, the transfer runner passed 194/194 synthetic groups, plus a
  read-only Windows ordinary-file metadata probe. It did not register a sync
  root, hydrate a native placeholder, mutate a pin, or access a live source.
  This is source verification, not an installed 0.5.36 acceptance result.
- The unsigned 0.5.36 candidate from `be680a84` has a 524-file inventoried
  payload and independently checked installer and source hashes; its DLL
  version is 0.5.36.0. Claude reports that the exact installer upgraded an
  unconnected VM from 0.5.35 and launched Settings. It is staged as an
  optional test, not verified with connected files or a multi-file fix.
- Claude reports synthetic `9c7eb5c3` prewarmed scope/entry ownership passed
  one reader but stalled with two; the trace did not identify the precise
  operation after reservation quota acquisition. Its reservation record and
  native registration were left for inspection. This does not prove an AV or
  other filesystem cause.
- Claude reports `0a196162` still stalled with two synthetic readers after
  initial ownership checks moved outside quota; the later read of a scope
  ownership marker under quota did not return. One reader passed. The failing
  native registration remains unverified and its fixture was preserved. This
  comparison intentionally permits stale checks and is not a production fix;
  the cause of the filesystem wait remains unproven.
- Microsoft documents concurrent Cloud Files callbacks and progress reporting
  that resets the FETCH_DATA timeout. A provider-owned timeout cannot assume
  that a blocked cache operation has stopped or that its leases can be released.
  Partial cancellation may cover only a range. See [callback types](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ne-cfapi-cf_callback_type),
  [progress](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/nf-cfapi-cfreportproviderprogress),
  and [callback parameters](https://learn.microsoft.com/en-us/windows/win32/api/cfapi/ns-cfapi-cf_callback_parameters).
- Claude reports `2222c29b` still stalled in the two-reader VM reservation
  control; one reader passed. The owner remained inside a quota-protected
  filesystem check, and the bounded waiter did not resolve that operation.
  The failing synthetic root was preserved with registration unverified. This
  does not establish the filesystem wait's cause or a full product fix.
- Separate source review found the legacy lease performs a filesystem open
  under a process-wide cache coordination lock. A blocked open could affect
  unrelated roots. This is not established as the observed quota stall; a
  safe change needs explicit ownership and late-completion handling, including
  the distinction between opening an existing lock and creating one.
- Unshipped cache-wait mitigation `a07daf53`/`abb0285d` bounds waits for the
  in-process quota monitor. Focused synthetic tests cover contention, retained
  reservation recovery and busy eviction; it cannot interrupt a filesystem call
  already holding the monitor and is not a proven multi-file fix. A package
  guard for cache-race test hooks was added in `2222c29b`. An isolated Core
  race-enabled to normal packaged incremental build using the same output did
  not retain six tested hook names; this is not a full installer audit. Native
  VM validation remains pending.
- Unshipped employee authorization retry `af532771`/`dc5f328e` retries only
  selected typed temporary HTTP responses after rechecking authorization. Each
  pre- or post-download phase has its own cooperative 15-minute deadline shared
  by its attempts. Tests use synthetic responses; native/live behavior is not
  verified. Automatic retry of an ambiguous Keep failure remains unimplemented.
- Claude reports `d1f89cfb` passed a VM native pin/hydration test after an
  intentionally simulated first Keep-worker failure: the explicit provider
  retry completed, the pinned file was no longer offline, and synthetic bytes
  matched. Native registration cleanup was verified. This does not test a
  real network/Windows failure, the Activity button, or connected staging.
- Claude reports synthetic `4e5dc9d2` still stalled with two readers even
  after releasing the entry lease before reservation. One callback waited for
  quota while another held quota inside a scope ownership filesystem check.
  This control rules out holding that entry lease as necessary for this
  observed stall, but does not identify the filesystem wait's cause. The
  failing fixture and unverified registration were preserved. One reader passed.
- Diagnostic `d1f89cfb` prepares an isolated native pin/retry test with a
  simulated first Keep-worker failure. Its cleanup-evidence tests pass; it has
  not run in the VM and cannot prove a real Windows or network failure retry.
- The full desktop app test runner passed 87/87 groups after the availability
  check change. These use demo data and test doubles; they do not verify live
  authentication, installed upgrades or native Cloud Files behavior.
- Claude reports `169a17f8` synthetic VM capacity controls passed with two
  readers, while adding the entry lease and reservation stalled with two;
  one-reader reservation passed. One worker waited for quota while another
  held it and was inside a filesystem check. The underlying filesystem wait
  and a complete lock cycle are not yet proven. Native cleanup timed out for
  the failing run, so its exact registered fixture was preserved. This was
  synthetic, not a connected-file or production-fix result.
- Unshipped commits `e586fbc1` and `d11f59fa` add an Activity action to check
  failed Keep/Free requests again, without changing pin state or signing in.
  Focused fake worker, UI and session tests passed; the action has not been
  tested with native Windows failures and is not in staged 0.5.35. Automatic
  per-file transient recovery remains unimplemented.
- Claude reports `c47d3143` VM controls passed one and two synthetic readers
  through selected real cache admission, root ownership, legacy lease, quota,
  and scope/entry ownership operations. The comparison omits authorization,
  capacity reservations and the downloader. Native registration cleanup was
  verified; this does not resolve the full multi-file stall or prove live sync.
- Unshipped commit `03332cc2` changes the FETCH_DATA completion message to
  “Downloaded data for” because Windows may request only part of a file.
  The focused activity test passed; this does not establish full offline
  availability and is not included in the staged 0.5.35 installer.
- Claude reports `6e23d696` VM synthetic controls passed with one and two
  readers creating, writing, flushing and closing distinct cache-side files;
  the two flushes overlapped. All native registrations were verified removed.
  This single comparison does not recreate the full production cache path or
  establish a live-file result; the original multi-file stall remains open.
- Claude reports the corrected `a181c73e` VM run passed synthetic no-marker
  one-reader and shared-marker one- and two-reader controls. Both readers
  exited zero and all three native registrations were verified removed; fixture
  directories remain. Simple shared marker reads therefore did not reproduce
  the stall in this run. This does not test real cache downloads or live files.
- Our `fb7fd2a2` synthetic VM memory probe passed the no-marker one- and
  two-reader controls and the shared-marker one-reader control. The two-reader
  shared-marker run exited without its final receipt. Windows logged one reader
  failing because its cloud provider had exited, but recorded no separate
  provider crash in the inspected window; the cause and wrapper exit remain
  unknown. The exact synthetic registered root remains in place, with no blind
  cleanup. Diagnostic `36a77322` adds flushed phases for future investigation;
  it does not change the shipped provider or establish a performance fix.
- Follow-up found no short external scheduler or launch timeout for that run.
  A separate harmless Windows PowerShell 5.1 reproduction showed that its
  wrapper's `ErrorActionPreference=Stop` with native stderr redirected can
  terminate the wrapper before a child finishes and skip the exit receipt.
  `Continue` allowed the same child to finish. This is a plausible explanation
  for the missing receipt, not proof of what happened to the VM test or its
  registration. Diagnostic `a181c73e` adds reader and process exit evidence.
- Claude reports the diagnostic `d0f00a7a` synthetic memory provider passed
  native external-reader runs with one, two and four files, with all three
  diagnostic switches off and exact test-root cleanup verified. The normal
  cache path still stalled with its availability scanner disabled. This
  narrows investigation to the cache/download path or its interaction with
  native hydration; it does not prove live access or a product fix. The
  requested Defender exclusion experiment was not run; no exclusion was added.
- After the requested temporary VM Defender comparison, a direct read-only
  `Get-MpPreference` check reported zero path and process exclusions, matching
  the previously reported empty baseline. The experiment result has not yet
  been reported, so no conclusion about Defender's role is established.
- Claude's bounded `8706e856` synthetic VM control reports concurrent Keep
  and external reads still failed with progress reporting suppressed. Three of
  four runs exceeded the test harness's disposal wait; the exact test roots were
  subsequently unregistered and verified. Suppression was diagnostic-only;
  this does not alter production progress reporting or establish a root cause.
- Claude repeated the synthetic VM comparison with the cache path explicitly
  logged on a separate temporary NTFS volume; one-file Keep passed, while two
  two-file Keep runs and one external-reader run stalled. Cloud Files filters
  were attached to the sync-root volume, not that cache volume. The temporary
  VHDX was detached and deleted. This does not identify another filter or cause.
- Claude's test-only `f67a5817` flag comparison reports cold folder Keep for
  two and four synthetic files passed once each with Cloud Files flag 8 added;
  each corresponding run failed without it. Concurrent external-reader tests
  for two and four files still failed with the flag. In-process reopen was
  denied with it, as expected. These single-run observations do not establish
  a complete fix, production compatibility, or connected-file behavior.
- Claude reports a synthetic VM run intended to put the cache on a temporary
  second NTFS volume: one file passed, two and four stalled. The harness did
  not log the actual cache path in this build, so second-volume placement is
  not independently verified. The owned VHDX was detached and deleted. A
  synthetic process dump is planned to inspect waits; no root cause is claimed.
- Claude's `12ec76b8` VM controls passed sequential native reads (two and four
  files) and 12 non-CF hydration-concurrency groups, while concurrent reads
  from separate processes failed twice for two files and once for four. The
  same-process test harness alone therefore does not explain the stall. The
  full Core suite was 188/189: one subprocess test returned access denied and
  was not investigated. Tests used synthetic data; no live transfer is claimed.
- Source review identified that the synthetic busy/read harness opens its
  test files from the provider process itself. Microsoft documents a separate
  flag for blocking implicit self-hydration; the app does not currently use
  it. A separate-process reader is needed to distinguish harness behavior from
  Explorer behavior. This alone does not explain the explicit folder Keep
  failure; no production connection flags were changed.
- Claude reports that candidate `12ec76b8` did not resolve the synthetic VM
  multi-file stall: one-file passed, two-file failed three times and four-file
  failed twice. The observed wait moved past the new-marker verification to
  later cache filesystem operations. A serialized control and test-volume
  comparison are pending; the result does not prove a cause or live behavior.
- Claude reports the 0.5.35 startup control toggled on and off correctly on
  the unconnected, previously used VM, creating and removing its exact Run
  value. It initially appeared off. The code defaults on when preference is
  unset, but uninstall retains that preference while removing the Run value;
  the VM's prior preference and fresh-install default remain unverified. Do
  not recreate an absent or foreign startup value without ownership evidence.
- On diagnostic commit `ddc4da0b`, Claude reports the synthetic two-file VM
  stall inside scope-directory ownership creation or verification, after the
  cache-size scan and while holding quota. One-file Keep passed. The cache and
  Explorer root were siblings, not nested. Follow-up diagnostic `80c98038`
  distinguishes filesystem operations; its VM result is pending.
- Claude reports that the hash-verified local 0.5.35 candidate installed over
  0.5.34 on the isolated VM. Settings displayed 0.5.35.0 and enabled the
  Windows startup control. While the app ran, uninstall offered graceful stop,
  the app exited, and uninstall completed. The checkbox state and startup after
  sign-in were not tested. Old version directories remained. No live sign-in,
  connected files or native transfer was tested for this candidate.
- Claude's `9c327520` synthetic VM trace narrowed the two-file stall to
  directory setup while one callback holds the cache quota lock; the other
  waited for that lock. The precise blocked operation is not established.
  Follow-up diagnostic commit `ddc4da0b` separates those operations, but has
  not yet been verified in the VM. Neither diagnostic build is a release.
- November 3: Claude's `b00085f9` synthetic native VM trace passed one-file
  Keep and timed out with two files. Both observed callbacks passed initial
  authorization but did not reach post-download authorization or transfer.
  Reported cache-preparation timing was approximately 60 seconds. The trace
  is aggregate and cannot correlate every event to a specific file; finer
  cache markers are needed before attributing the stall to a particular lock.
- November 3: Claude reports a synthetic VM upgrade from 0.5.25 to 0.5.34
  completed and launched, with the installer's graceful stop prompt working.
  No account sign-in was performed. The installed Settings screen reported
  version 1.0.0.0 and disabled Windows startup; the published 0.5.34 app DLL
  indeed has assembly version 1.0.0.0. Startup ownership checks require the
  assembly version to match the installed version. This explains the refusal
  but the fix has not yet been verified in an installed app.
- Claude reports that 0.5.34 uninstall on the VM refused while the app ran;
  after an orderly quit it removed the active app, registrations and Start
  Menu entry. It warned about unverifiable old Preview ownership on a VM with
  no Preview entry, and retained two old version directories. Silent
  reinstallation then succeeded without launching the app. No live files or
  account sign-in were involved.
- Unshipped commits `cf1741ef` and `ce955599` enforce installer/assembly version
  agreement and stamp connected pilot build versions. A Release app build
  reports assembly and file versions 0.5.35.0. Installer validation and
  synthetic version-guard tests passed; this is not an installed 0.5.35 release.
- Unshipped diagnostic commit `b00085f9` adds sampled native transfer and
  authorization boundary markers. A synthetic blocked-call test passed; an
  unsampled call cannot be ruled out from an absent trace entry. The installer
  refuses packaged native diagnostics. VM results are pending.
- November 3: Claude reports that a synthetic native four-file folder Keep
  test timed out in all three runs on each of `1748c845` and `5291f907` on the
  staging VM. Both builds left all four test files pinned but offline. Exact
  test registrations were removed afterward. The dedicated Keep worker did not
  resolve this observed stall; its cause and live-file impact remain unproven.
- November 3: unshipped source commit `5291f907` moves the Keep scanner's
  synchronous hydration call to dedicated threads after the existing four-slot
  admission. The dedicated hydration, bounded availability, availability
  intent, local availability operation and Company source-gate synthetic suites
  passed. Native multi-file behavior and performance remain unverified.
- November 3 VM report from Claude: with CldFlt manually attached, native
  connected-preflight, empty-inventory and connected-root acceptance passed
  on build `a832fab4` using synthetic sources. A four-file busy/retry native
  test timed out; repeated comparisons are still in progress. The clean-VM
  first-registration failure below remains unresolved. These results do not
  establish live account access or qualify the staged 0.5.34 installer.
- November 3: source commit `963e2ed9` passed all 87 synthetic desktop-app
  groups, including the connected coordinator's 28 isolated cases. These are
  demo or fake sources and do not establish live sign-in, installation, native
  Explorer registration or connected-file hydration. The staged 0.5.34 ZIP
  below predates this commit and was not changed.
- November 3 VM finding: on a clean Windows volume with no CldFlt filter
  instance, the first native Explorer registration preflight returned
  `0x80070001` and stopped before the broker registration call. The app had
  already persisted a registration-intent receipt; retain it for review rather
  than retrying or deleting it. The cause and a standard-user remedy are under
  investigation; this observation is from one VM, not all clean Windows PCs.
- Candidate **0.5.34.0** is built from source commit
  `0c1fc1f1ed9f8edc496e3481620f37f49a66d716`. ZIP SHA-256 is
  `310ada59054aeb398f8ea8cb173549b60d494f89604aee95ccf4e480922bad5a`;
  installer SHA-256 is
  `011a84e50838638cdd730bc33a85b3dc37af42aaeb003036b30971e0780c3e09`.
- A clean-source build completed with zero warnings and errors. Synthetic
  verification passed: Core 188/188 groups, desktop app 87/87, employee-only
  startup/source isolation 5/5, plus six non-native Explorer policy suites.
  These checks do not exercise live sign-in, native Explorer registration, or
  real-file hydration.
- On November 2, 0.5.34 was installed on the main PC after approval to preserve
  the existing connection and files. The 0.5.34 process is running and Settings
  opens, but Settings says **Reconnect your files folder**. Explorer shows
  `LedgeTop Files — Company files`; the old Preview folder still exists. The
  app’s saved connection was not reconnected, and no files were downloaded or
  changed during this check.
- The read-only Test Data grant could not be confirmed. On November 3 the
  Operations MCP connection check again returned the active staff identity,
  with writes disabled, but it does not verify this Company-files grant. The
  0.5.34 live hydration, Keep, Free, and batch-speed checks remain pending.
- On November 3, read-only inspection of the main PC's saved generation
  selector and Explorer registry found two branded Company files entries. The
  selector identifies one as the previous root and the other as the published
  current root; both Explorer registrations have the same visible label. This
  observation does not prove either root is safe to unregister or that the
  current root is connected. Distinguishing or retiring the previous entry
  requires an ownership-checked migration and native Explorer verification.
- The existing Windows test VM was found on staging host `192.168.50.90` and
  started through `ledgetop-sync-vm.service` on November 2. Its Windows 11
  Enterprise Evaluation desktop opened the branded LedgeTop Files settings
  window; **Start with Windows** was checked. The app is not connected: Activity
  says “Waiting for browser sign-in to finish.” Edge's first-run setup stopped
  the flow at privacy choices; no choice was made, no sign-in completed, and no
  files were accessed. Tray lifecycle and File Explorer acceptance were not
  verified. The VM console uses a restricted Unix socket; its temporary SSH/VNC
  relay was stopped after the session, while the VM itself was left running.
  The SanDisk archive volume was left untouched.

## Historical verification — October 28, 2026

- Shared candidate **0.5.10.0**, source `d4d2cabeeed418724a4077816d4f744a2c2d66d2`,
  passed Windows CI `40725723008`. Its 524 payload files and 288 source entries
  were independently verified. The installer SHA256 is
  `b4f9401c3ff3978ef10757013ed05ebd721f73037fd03b6f4f950ab4c04e016e`.
  Version 0.5.9 is retained in `Archive\0.5.9` for rollback.
- Company-file hydration removes four redundant session probes: synthetic HTTP
  tests verify three requests rather than seven for a cold download. Both file
  resolutions remain, including principal, expiry, current authority, version,
  length and SHA checks. Portal and unknown sources retain their session checks.
  Actual-adapter/lifetime/source-gate tests cover denial, account changes,
  cancellation and pause/epoch changes. Activity wraps complete timing lines.
- Isolated native tests of both 0.5.8 and the candidate source passed ordinary
  download, exact-byte verification, Keep, Free/cache cleanup, redownload, final
  payload release and exact owned native unregister for the approved
  57,788,851-byte photo. Both tests used fresh hidden native roots, the same
  existing human staging access and pinned helper; neither created a Shell
  sidebar entry nor changed the installed connection.
- That sequential one-photo comparison did **not** demonstrate a speedup.
  Baseline cold read/hash took 11.187 and 9.541 seconds; candidate took 11.715 and
  10.628 seconds. Warm local read/hash took 27 ms in both. Queue time was zero;
  retained authorization/resolution and download phases dominated. Download
  timing includes disk writes and downloader checks, not just network time.
  This is not a statistical benchmark, laptop test or Photos-rendering result.
- The last main-PC process observation found **0.5.10.0**, with all 524 payload
  files matching the published inventory. Executor registry reads still reported
  0.5.7 activation, while its Run command pointed to 0.5.10. The running app's own
  registry read remains unobserved; no activation repair was attempted.
  Desktop control timed out opening Settings and exposed no LedgeTop window.
  User screenshots show downloads and Keep succeeding in 0.5.8. Warning-free
  cache cleanup passed in the isolated executable test; installed UI acceptance
  remains distinct.
- The cache correction handles long application-owned paths at the native
  file-open boundary without changing Windows policy. Its emitted-executable
  regression reproduced five failures before the fix and passes all eight
  cases afterward. CI explicitly tests that host because the dotnet host had
  masked the defect.

## Remaining acceptance and scope

The shared 0.5.10 Windows candidate removes manual Pause/Resume from connected settings
and the tray, and resumes saved pauses after fresh same-account validation.
Startup defaults on after source selection and verified installation ownership;
explicit opt-outs and conflicting Run entries remain preserved. Interactive
setup offers graceful shutdown of a verified supporting app and waits for its
actual exit. Builds through 0.5.9 lack that protocol, so their first upgrade uses
tray Quit followed by Retry within the still-open installer. Silent setup keeps
its busy refusal. These changes have focused and integrated synthetic tests;
installed acceptance remains separate from those tests and SMB publication.

Commit `400c557f` adds reviewed, synthetic-tested unified sign-in source preparation:
an account-bound discovery coordinator, one sign-in window, and saved-profile
routing policy. Hosted Windows CI `40732633194` passed for that exact commit.
It is not wired into production startup or the published installer.
The server discovery contract, native bootstrap and cross-audience account binding
remain pending; the current installer still offers the client/company chooser.

Commit `cee9bec0` wires startup to reopen exactly one verified owned saved
connection without the chooser, retaining its prepared principal and performing
fresh cached reconnect. New or ambiguous connections still need discovery.
Its Windows CI `40735518515` passed.

Beau subsequently narrowed the first installed release to employees. Commit
`84c3d4a5` opens employee Settings directly, without the client/company chooser.
The installed backend factory and reserved startup/resume admission refuse
client routing, with an explicit client-unavailable notice. Existing client
profiles and local files are not probed or removed. Employee sign-in still uses
the existing authoritative staff admission, principal and file-grant checks;
admitted employees with an empty inventory remain connected. Five focused test
groups, an independent source review, a separate packaged Pilot build and Windows
CI `40759058157` passed. Unsigned 0.5.11 contains this source and passed independent
524-file installed verification. Its actual main-PC upgrade offered graceful
closure and opened directly to employee Settings. However, cached reconnect
subsequently paused during source-session checks, so connected acceptance is
incomplete and no new installed speed result is available. The SMB status labels
it a test candidate. The common signed discovery preparation remains inactive
for any later multi-role release.

Commit `9e8b7bb3` adds bounded connection action/phase/reason diagnostics, retaining
the original typed cached-session failure instead of converting it to Unknown.
It changes no requests, authorization checks, pause/drain policy or file delivery.
Focused tests, independent review and Windows CI `40765679148` passed. Unsigned
0.5.12 was installed on the main PC: the real graceful-stop prompt, checked Start
option at Finish, new process and all 524 installed payload files were verified.
The saved employee index is unchanged. Connected acceptance remained pending
because computer control could not bind the new app window or activate Explorer.
Beau subsequently authorized terminating the exact running process and installing
the successor. No new photo-speed or successful reconnect claim follows from
installation alone.

Commit `f82aa0d4` adds two tracked availability workers and two concurrent distinct
hydrations per process/cache root. Per-entry leases, conservative durable quota
reservations, both authority checks and full SHA verification remain. Windows CI
`40739881077` passed. The Release build passed 172 Core groups, five Explorer
groups, and actual Windows-native generated-data Keep/Free/reopen, local-edit
preservation, reconnect, drain and exact unregister checks.

One real staging comparison of the same approved 57.8 MB and 114.8 MB photos
completed recursive Keep in **23.077 seconds with 0.5.10 versus 20.496 seconds
with f82aa0d4** (11.18% shorter). Both variants passed full hashes before ordinary
reads, Free/cache removal, reopen and exact cleanup. Callback overlap was one
versus two; source-download/network overlap was not measured. Both used Release
DLLs in the same framework host, not the installed app or Photos. This single
baseline-first pair does not establish a general speedup. Cold rehydration of
the smaller photo still took 8.802 versus 8.161 seconds. These source successors
have not been published as a new installer; the shared download remains 0.5.10.

Commit `7afc01ea` adds bounded attribute-change hints to wake the frozen inventory
scan, retaining the two-second fallback, fixed manifest and two-worker limit.
Windows CI `40747907653` passed. A generated-data native comparison with two
workers in both variants measured first Downloading callback at 1,724 ms with
f82 versus 126 ms with 7afc, and batch completion at 1,873 versus 257 ms.
Both passed full pin/cache hashes before reads, Free/cache removal, drain and
exact unregister checks. These timings measure provider callbacks for generated
data; they do not establish real-photo transfer speed or Explorer rendering time.
This successor also remains unpublished.

Actual installed tray close/quit/reconnect, full uninstall and legacy sidebar
cleanup, logon startup, authenticated update replacement, and current laptop
acceptance remain to be completed or rechecked against the intended release.
The historical laptop LoginRequired failure is not independently resolved by a
successful test on the main PC. Current Client-deliveries behavior needs its own
approved account/source acceptance; Company tests do not qualify it.

The main PC's stale 0.5.7 activation metadata was corrected to its independently
verified 0.5.10 payload by a separate, narrowly scoped support action. It required
the exact approved installer, an uninstaller independently reconstructed from
those installer bytes, a normal Quit of the verified pipe peer, actual process
exit and singleton ownership. All three participating HKCU64 pointers read back
as 0.5.10, with a flushed completion journal. No connection, local file, source
permission or normal startup guard changed. This proves executor-visible HKCU64
reconciliation only; it does not establish the application's prior registry view
or qualify another version's installation/update behavior.

After actual 0.5.11 installation, the same pinned read-only probe observed correct
0.5.11 product/version/uninstall/Run values in the desktop context, but older
product pointers in the executor context. SID, session, bitness and native key
metadata matched; the mechanism remains unknown. These observations do not
justify another registry repair or establish that the app reads the executor's
view. In-app update acceptance must observe the actual desktop path.

The prior read-only Test Data access expired October 28 at 20:33:11 UTC. Beau
approved the same read-only folder through October 29 at 20:33:00 UTC. A supported
human-authenticated successor command was accepted and its exact scope, expiry
and 14 payload/actor/gateway predicates were verified. This does not establish
loaded gateway enrollment or successful data-plane access. No other folder or
upload permission was added.
Installation does not renew access. No grant expansion, backend activation or
NAS change accompanied publication of 0.5.10. Operations subsequently verified
the minimal public-JWKS resolver reuse on staging at October 28, 21:32 UTC:
active version `b1023692-2ef2-4004-9187-4cb8b9bb9b65`, module SHA256
`f5c51d80fdae674718144c45738469f1af5a936882f6fb3a4eca217f5a4db379`.
Runtime configuration, assets and the current same-folder grant witness were
preserved. The 870-second manifest headroom remains unchanged. Public signing
keys have a bounded 600-second cache and 30-second unknown-key cooldown;
JWT expiry and current identity/admission/grant checks still apply per request.
This is staging activation evidence, not a new Windows file-download speed result.

Before that activation, a one-attempt metadata diagnostic used the exact 0.5.12 Core and pinned
installed helper with the existing cached sign-in. Both current-session checks
matched the saved employee principal and valid expiry, with cumulative elapsed
times of 2,562 and 3,169 ms. No browser login, catalog, Resolve, content, registry
or native operation was performed. This executor-context result does not prove
that the installed Explorer session recovered.

Commit `bb6a8c4b` corrects a source-proven recovery dead end: the existing 60-second
timer may recheck only confirmed transient session failures on the same owned,
newly paused generation. Fresh account/expiry checks and the engine's own source
gate precede resume. Permanent denial, expired sign-in, malformed metadata,
manual pause and uncertain local/native ownership remain held. Read-only UI
observations and fenced engine events preserve failure holds across races.
Twenty coordinator cases, focused regressions and independent source review
passed. Installed acceptance of this successor remains pending.

The successor also keeps one bounded local connection-failure record at
`%LOCALAPPDATA%\LedgeTop\Files\pilot\connected-explorer-pilot-employee\latest-connection-failure.json`.
It contains only a validated support code, UTC time and app version, with a
fixed schema/owner marker and a 1 KB limit. Writing requires the existing owned
employee index lease and current index; unknown files and uncertain ownership
are preserved. Diagnostic IO is best effort and never determines authorization,
recovery or shutdown. The integrated source passed four focused groups and
21 coordinator cases; actual installed log capture remains pending.

Unsigned 0.5.13 installed successfully on the main PC with all 524 payload files
matching the reviewed build and the saved employee index unchanged. Actual startup
then crashed with a Windows .NET Runtime 1026 `NullReferenceException` in
`CanReconnectCached`, called by a concurrent Settings refresh. Installation is
therefore not connected acceptance. The repair captures the engine, saved index
and observation epoch together, evaluates only that generation outside the view
lock, and rejects a changed or disposed generation before publishing a UI hint.
Both cached-reconnect and empty-inventory hints retain their existing ownership
and manifest requirements; connection operations still perform their authoritative
checks. The same deterministic regression reproduces the null-reference failure
against the preceding source and passes with the repair. Four focused groups and
22 coordinator cases pass, including six observation/reconnect/disposal races.
Replacement installer and live Explorer acceptance remain separate gates.

After the staging public-key-cache activation, one direct API test of the approved
57,788,851-byte photo passed both Resolve checks, downloader and independent SHA
verification, and private-duplicate cleanup. The verified download took 6,651 ms;
Resolve-before and Resolve-after took 1,420 and 1,194 ms. Preparation took another
2,318 ms. This is one API observation, not a native Explorer test or a controlled
before/after performance comparison.

## Earlier evidence

Earlier real Company native tests covered the largest approved photo
(126,453,788 bytes), while generated provider tests covered recursive Keep/Free,
edited-file preservation and shutdown. The user confirmed the installer Finish
option starts the app in 0.5.4. Main-PC 0.5.6 testing established a branded Company
root, 19 authorized photos, open/Keep/Free/reopen and oracle hashes for two photos.
These are version- and scope-specific observations, not substitutes for the
remaining release acceptance above. Consult historical receipts for older
0.5.2–0.5.5 installation, package-context and laptop diagnostics.

Files appear in Explorer; the app supplies connection controls and activity.
Closing Settings keeps the tray connection running; Quit drains the provider.
Reconnect restores the saved inventory. Explicit Remove and a new connection
prepare a fresh inventory/logo generation while preserving old local files.
An owned empty catalog offers an explicit sign-in/refresh action; nonempty
catalogs are not automatically replaced.

### Resident-update staging candidate

The draft includes installed-payload verification, authenticated metadata and
download checks, graceful drain, an authenticated helper and fixed installed
relaunch. Scheduled checks run every six hours with an initial delay, skip busy
or disconnected sessions, and pause after uncertain helper outcomes. Settings
can disable automatic attempts. These preferences contain no account or token.

The Start with Windows control manages only the exact owned pilot HKCU
Run value. Forward setup preserves its source choice; uninstall removes only an
exact owned value. A checked interactive Finish option launches the installed
app after setup; silent updates never use that launch path. Neither startup nor
update reconnect opens a browser or substitutes another source/account.

Local synthetic schedule, startup, resume, cancellation and settings tests pass.
Twenty actual isolated NSIS registry cases passed against a new private test
key; this is not real startup/logon, interactive Finish or installed upgrade
acceptance. The backend feed remains default-off. Candidate 0.5.4 has manual
Finish-launch acceptance; this does not qualify startup, lifecycle or update delivery.
Actual connected replacement/relaunch/reconnect and Shell-menu repair remain
release gates. Automatic client/employee discovery is under backend contract
review; it is not a deployed endpoint or a reason to guess roles from email.

### Legacy Preview cleanup candidate

The sidebar label alone does not identify the old demo: candidate 0.5.3 also uses
`LedgeTop Files Preview` for connected roots. Later draft source gives newly
created connected roots source-specific Company files / Client deliveries names
and records the exact label in connected profile schema 4. Existing schema-3
connections retain their legacy label; generated schema-2 previews are unchanged.
Other valid source aliases use the generic `LedgeTop Files` label, with existing
source authorization checks unchanged. Reconnect and removal verify the exact
recorded label as well as root/context/namespace ownership.

Older binaries and the shared v1 diagnostic do not understand schema 4. Do not
publish a schema-4 candidate without a compatible diagnostic and forward-only
upgrade instructions; do not downgrade it into an older binary. Shared 0.5.4
includes the compatible v2 diagnostic; the older installer and v1 diagnostic
remain unchanged. This naming change does not fix or
verify native Explorer menu visibility.

The older portable `LedgeTop Files Preview` has a separate generated V2 ownership
receipt, so uninstalling older 0.5.2 does not remove it. Candidate 0.5.3's explicit
uninstall path now includes that exact recorded preview after checking ownership;
ordinary installation/startup does not migrate or start the demo. Uninstall keeps
local folders and all downloaded, modified and added files. It does not download
online-only files or promise that unhydrated placeholders become local copies.

The draft also accepts `--installer-remove-legacy-preview` in a packaged pilot to
remove only that recorded demo, without preparing/removing Company or Client
connections. Both applications must be quit first. This command is present in
the 0.5.3 and 0.5.4 candidates. The optional shared cleanup ZIP checks exact
0.5.3 installed bytes and must not be used against 0.5.4. The 0.5.4 uninstaller
contains the owned cleanup path; actual laptop cleanup is not yet accepted.
Missing/invalid receipts are refused for this dedicated
repair; do not delete registry entries or restart an unknown old demo to recreate
ownership. Normal uninstall handles known receipts only and cannot prove that an
untracked old entry is absent.

Retries verify the saved physical-root identity and exact native/Shell absence
without repeating unregister. A changed, missing or uncertain root is refused.
Compilation and injected lifecycle tests pass. A separate explicit generated-only
native acceptance registered and hydrated a fresh private preview, retained its
downloaded/modified/added files through one owned removal, then passed fresh and
repeated exact absence verification with an unchanged receipt. This does not
qualify the fixed legacy wrapper against an actual old installation or a real
uninstall; those remain release gates. Native acceptance is opt-in through
`--generated-removed-absence-acceptance`; normal tests never run it. Do not replay
an uncertain native run or use the default user profile as a test fixture.

The proposed NAS/R2 replacement is described in
[`nas-r2-bidirectional-sync-design.md`](../../docs/nas-r2-bidirectional-sync-design.md).
It is source-only; this pilot still has no upload or bidirectional engine.

The harness commands below use synthetic identities and handlers; they do not
install software or establish live-source acceptance. Core uses the SDK alone;
the Windows desktop and Explorer projects also require the exact Windows SDK
reference package described below.

The Explorer UI offers **Client deliveries** or **Company files** before sign-in.
The earlier transfer window remembers an offered choice per release channel. Switching stops and saves
the previous transfers before opening the other source; a denied sign-in never
falls back to the other mode. The preference grants no access. Each service
still checks its own current identity and grants.

The historical desktop checkpoint `3250e1ed` passed 38/38 synthetic App groups on
2026-10-23, including selection, switching, pause/resume and shutdown races.
That result does not qualify a live login, installed package or files on demand.
Run the desktop harness on Windows with the pinned SDK and local feed prepared
below:

```powershell
dotnet run --project AppTests/WindowsDownload.App.Tests.csproj -c Release -p:UseSharedCompilation=false -p:RestoreConfigFile="$sdkConfig"
```

## Run the synthetic acceptance harness

Use the reviewed .NET SDK `10.0.402`. From this directory:

```powershell
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
dotnet run --project Tests/WindowsDownload.Tests.csproj -c Release
```

`global.json` pins the SDK. Core and its console harness target `net10.0`;
the WPF app and its harness target `net10.0-windows`. `NuGet.Config` clears
external package sources. Core tests inject synthetic HTTP handlers; they do
not create a listener, use cookies, access R2, contact a server or read credentials.
They create isolated temporary folders and clean only their owned trees.
Windows reparse tests use unprivileged temporary directory junctions, without
changing developer mode or requesting elevation. Unix uses symbolic links.
Windows file-symlink creation is not tested on machines without that privilege.

For a fresh Windows checkout, bootstrap `Microsoft.Windows.SDK.NET.Ref`
`10.0.22621.57` into a new local feed. The script downloads only that official
NuGet package, verifies its pinned length/SHA256 and NuGet signature, and retains
the qualified SDK/CsWinRT licenses. It does not change global NuGet settings:

```powershell
$sdkFeed=Join-Path $env:TEMP ('ledgetop-sdk-'+[Guid]::NewGuid().ToString('N'))
../../scripts/windows-bootstrap-sdk-reference.ps1 -OutputDirectory $sdkFeed -DotnetPath (Get-Command dotnet).Source
$sdkConfig=Join-Path $sdkFeed 'NuGet.Config'
```

Use `-p:RestoreConfigFile="$sdkConfig"` on desktop, Explorer and retained live
acceptance builds. For offline reuse, pass `-SourcePackagePath` to the bootstrap
script with the already qualified package; the same hash and signature checks
still apply. The workflow starts with an isolated NuGet cache and uses this
explicit local feed; a previously populated user cache is not a prerequisite.
For self-contained notice verification, add `-IncludeRuntimePacks` to download
the three exact signed `10.0.13` Windows runtime packs requested by SDK restore.
Their lengths, hashes and bundled licenses are checked as well. An explicit
`-RuntimePackageDirectory` can reuse those public NuGet package files offline.
The WPF payload deploys the .NET Core and Windows Desktop runtimes; the ASP.NET
pack is a restore prerequisite and is not deployed by this app. These steps only
build files; they never execute or install the generated application.

The console prints its acceptance groups and returns nonzero on failure.
They cover interruption/resume, strict version/range checks, hash mismatch,
truncation and overflow bounds, cancellation, unsafe names/origins, redirects,
existing and late-created destinations, reparse paths, exclusive transfers,
state corruption, oversized-response retry and post-promotion cleanup failure.
Additional groups cover explicit sign-in versus cached-token lookup, pinned
executable integrity, origin confinement, bounded subprocess output, authenticated
discovery/folders/manifests, safe renewal and credentialless transfer state.

On Windows, run the separate desktop acceptance harness with:

```powershell
dotnet run --project AppTests/WindowsDownload.App.Tests.csproj -c Release -p:UseSharedCompilation=false -p:RestoreConfigFile="$sdkConfig"
```

For an interactive synthetic preview, explicitly build the developer variant:

```powershell
dotnet run --project App/WindowsDownload.App.csproj -c Release -p:LedgeTopDeveloperBuild=true -p:UseSharedCompilation=false -- --demo
```

The preview uses generated demo content, not client files. A plain Release build
does not opt into developer/demo behavior. Packaged builds use compiled trusted
profiles and ignore arguments and developer settings; this command is not a
client installer or live sign-in acceptance.

Offline installer-input and release-offer tests take explicit fixture paths;
they do not default to an operator's private release artifacts. The optional
`scripts/windows-release-test-fixture.ps1` helper accepts an explicit reviewed
commit, pinned public cloudflared binary, pinned NSIS compiler, SDK path and
locally built Core assembly. It creates a synthetic metadata assembly and an
Abort-only test PE in a new directory. It never executes either generated file
or cloudflared. Pass its returned directories to
`scripts/windows-app-release-offer.test.ps1`; these checks qualify validation
contracts, not a usable installer or a published release.

## Authenticated portal adapter

Company-file acceptance above does not qualify the current Client deliveries
path or its files-on-demand behavior. Each source needs its own current grants
and acceptance evidence.

`CloudflareAccessSession` runs an absolute, hash-pinned official cloudflared
binary directly, without a shell. Only `ExplicitLoginAsync` can launch its human
browser login. Cached-token lookup uses the same fixed protected application URL,
such as `https://portal.ledgetopdroneservices.com/portal`; the bare hostname is not
assumed to discover a path-scoped Access application. API requests carry the token
only to that exact HTTPS origin. Redirects, ambient cookies and default system
credentials are disabled. Authentication expiry and grant denial are distinct.

cloudflared owns its normal per-user token cache. The app neither inspects nor
copies that cache and stores no token itself. Local JWT decoding checks expiry
only; Cloudflare and the portal validate identity and current resource grants.
The token retains the person's portal authority. The adapter's GET-only interface
is a local restriction, not a new server-enforced download-only credential.
The pilot bundles the reviewed, hash-pinned official cloudflared helper and its
license. Compiled release profiles select the application and helper pin;
current source-specific live acceptance remains separate from packaging.

`PortalClient` uses the existing native delivery discovery and folder routes.
Each portal metadata request has one 60-second linked cancellation deadline
covering cached-token lookup, response headers and every bounded response-body
read. `ResponseHeadersRead` alone does not bound body consumption. A deadline
failure stays a generic timeout; explicit caller cancellation remains cancellation.
Controlled synthetic streams test a valid header/prefix followed by a permanent
stall, upstream cancellation and response disposal, plus token/header stalls.
The accompanying server `download-manifest` route returns an opaque logical ID,
upload version, SHA-256, length, strong ETag, safe name and short-lived relative
download route after current human authorization. A fresh encrypted handle pins
the upload version and digest. Metadata and acquired bytes both check these pins,
including same-ETag replacements. Logical ID plus upload version identifies local
partial state, so renewing a handle cannot append a different upload version.

The server currently requires R2's stored full-file SHA-256. A missing checksum
returns `download-checksum-unavailable`; it does not trigger a large download in
a Worker or substitute an ETag. Older and multipart files still need a separate
version-fenced checksum backfill/ingest implementation before broad acceptance.
Employee server-folder access has a separate explicit read grant and private
Docker gateway. The current staging test covers only its approved Test Data
root; installation alone grants no access to other folders. Broader deployment
and Client deliveries qualification are separate from this test.

Employee ownership is independent: Ops manages Ops staff, and each PA manages
its own people. PA employee snapshots/entitlements cannot provision or change
Ops staff. Windows file reads require current native Ops admission plus an
explicit file grant; a PA account or matching email is insufficient. Client
profiles remain synchronized only to their selected PA destinations.

## Transfer contract

The authenticated portal adapter supplies `DownloadSpec`: an opaque logical
resource identity, a fresh HTTPS content URI, a safe output basename, exact
length, canonical strong ETag and trusted full-file SHA-256. The hash must come
from trusted server metadata. Calling the transfer library directly does not
establish authorization. An R2 ETag is not a substitute for SHA-256.

The production constructor uses an exact HTTPS origin allowlist and an
`HttpClientHandler` with automatic redirects, cookies, default credentials and
decompression disabled. GETs carry `If-Match`; resumed GETs additionally carry
`Range` and `If-Range`. Resume requires exactly `206`, the expected strong ETag,
remaining Content-Length and exact Content-Range. A `200` during resume, changed
version, redirect, content encoding or malformed range is refused. Reads are
bounded by the trusted remaining length plus one overflow-probe byte, with a
64 KiB buffer and a configurable maximum file size (1 TiB by default).

Partial files live below the chosen output directory in `.ltds-downloads-v1`.
The directory has an ownership marker; each descriptor has an exclusive lock,
partial file and small credentialless state record. State contains only a
hashed descriptor, version, length, ETag and SHA-256. It contains no content URL,
query string, authentication material or raw opaque resource identity. An
unowned state directory or mismatched descriptor is refused. Valid interrupted
prefixes resume by their actual file length. A rejected oversized response
removes its newly appended bytes. An unpromoted full-length partial is fetched
again because this prototype does not persist a completed-response receipt.

Only a complete matching SHA-256 is promoted, through a same-root no-overwrite
move. The verification handle denies writes through promotion on Windows.
Existing output files are never replaced, even if created after HTTP starts.
Promotion is the completion boundary: locked state metadata can remain for later
cleanup without incorrectly reporting that the verified final file failed.

## Employee read adapter

`EmployeeClient` uses the human `CloudflareAccessSession` against one fixed Ops
HTTPS origin. It discovers at most 100 explicitly granted labeled roots, reads
UTF-8-sorted directory pages of at most 200 entries, and obtains a trusted
manifest for an exact relative source path. Paths and cursors are escaped once;
traversal, malformed metadata, duplicate fields, redirects, unsafe output names
and responses exceeding the bounded JSON limits fail closed. Discovery/list
requests have a 60-second deadline; manifest preparation allows up to 15 minutes
with explicit cancellation for the initial large-file copy.

The manifest requires a content SHA-256, matching content version and quoted
SHA ETag. Download state uses logical file identity plus SHA, so renewing a
snapshot handle can resume the same version while changed content starts a
separate transfer. HTTP 401 requires explicit human login, 403 denies access,
and 404/409 requires rediscovery or manifest renewal; none launches a browser.
Synthetic acceptance includes the owned test apphost subprocess and verified
downloader. Route factories require explicit server configuration and authority.
The approved staging root is activated separately; current single-file and
full-folder acceptance status is recorded above.

## Filesystem boundary

The caller chooses an existing absolute local directory owned by the signed-in
user. Unsafe basenames, Windows device names, traversal, alternate data stream
syntax, UNC roots, symbolic links, junctions and reparse ancestors are refused.
Use a private local directory, not a shared writable folder or a folder managed
by another sync product. The BCL checks are not an OS sandbox against a hostile
local process replacing paths concurrently or forging owned metadata/hard links.
No promise of remote wiping or deletion of already-downloaded data is made.

Final hashes protect content integrity; they do not establish client identity,
current authorization or whether a future server adapter may issue a manifest.

## Durable queue core and source adapters

`TransferQueue` now persists an app-owned queue for one trusted source alias and
server-derived principal. `EmployeeQueuedDownloadSource` and
`PortalQueuedDownloadSource` obtain non-authorizing references and fresh manifests
from the configured queue APIs. No JWT, cookie, expiring byte handle or download
URL is stored in queue state. Keep the state directory private to the Windows
user; it must be an existing empty directory on first use. The UI can aggregate
multiple source queues without presenting a workspace switch.

Enqueue resolves current trusted pins. `StartAsync`/`RetryAsync` schedule one job;
`WaitForIdleAsync` awaits it, and `GetJobsAsync` returns its state after checking
the current session. Active pause/cancel signals work immediately, even while a
session request is blocked or the user has signed out. Inactive changes remain
session-gated. The start cancellation token governs admission; use pause/cancel
to stop a scheduled transfer. Progress distinguishes Receiving, Verifying and
Completed; receiving bytes are not yet integrity-verified. Completed is reported
only after hash validation and atomic promotion.

After restart, Running jobs become Paused. Every retry resolves current identity
and content pins before using existing partials. A changed content version blocks
the old job until explicit selection of a new version. If a crash occurred after
file promotion but before queue completion, exact interrupted-job recovery can
verify the existing local length/SHA and fresh identity without overwriting or
downloading it again. Missing/ambiguous owned state requires manual recovery;
the app does not guess which files to delete.

```csharp
// session, rootId/path and directories come from trusted app configuration
// and the current authorized file list. Server activation and grants are separate.
using var source = new EmployeeQueuedDownloadSource("ltds-employee", session);
var selection = await source.GetReferenceAsync(rootId, path, cancellationToken);
await using var queue = await TransferQueue.OpenAsync(stateDirectory, source, cancellationToken);
var job = await queue.EnqueueAsync(selection.ResourceReference, destination, cancellationToken);
await queue.StartAsync(job, progress, cancellationToken);
await queue.WaitForIdleAsync(cancellationToken);
var jobs = await queue.GetJobsAsync(cancellationToken);
```

See [the source API contract](../../docs/windows-queue-source-bindings.md).
The separate portal successor implementation can retain logical identity across
reviewed publication updates only while every intermediate publication preserves
the original authorized mapping. Omission followed by restoration breaks that
continuity. See the source API contract for its bounded history and independent
current authorization checks; do not infer continuity from a matching path.
Queue persistence does not establish current authorization after restart.
The saved connection must still pass the current source/session checks; it
does not refresh its catalog automatically.

## Remaining product work

- Recheck current laptop Shell verbs/status, keep/free/reopen and tray lifecycle
  against the intended release. Earlier user confirmations and failures refer
  to different builds and PCs. Full approved-folder capture has passed. Live expiry,
  identity-change and revocation scenarios still require
  their own evidence. Browser-profile copying, service tokens and bucket
  credentials are not client setup mechanisms.
- Version-fenced checksum coverage for existing and multipart files. Native
  selectors remain expiring person/grant-bound selectors, not bearer credentials
  or durable queue identifiers; the manifest supplies the separate stable ID.
- Server-controlled routing: employees read from an approved Docker/server
  gateway, while clients read only their authorized R2-backed portal content.
  Both adapters are implemented; current approved employee staging acceptance
  does not qualify unrelated roots or portal content.
- Current laptop UI/lifecycle and uninstall acceptance, broader large-media
  qualification, and publication/integration of the update channel. Signing is
  an optional future rollout decision; it is deliberately off for this pilot.
- Connected Explorer behavior for the complete approved catalog and laptop
  confirmation of branding, online-only opening, keep/free/reopen and restart.
  Cloud Files support is implemented and the bounded actual native test passed;
  those results do not substitute for these remaining acceptance checks.
- Writable employee synchronization, conflict handling and durable revisions.
  The separate Nextcloud pilot's preserved-mtime stale-overwrite failure is
  unresolved; this read-only foundation does not clear that writable gate.

Installing the package does not change a production service, TrueNAS stack,
public link or server access policy. Approved staging authority is provisioned
separately through the authenticated Operations administration API.
`CloudFilesNativeTransfer` provides the internal x64 transfer/progress boundary
used by the provider. See [native boundary limits and ABI evidence](../../docs/windows-cloud-files-native-transfer.md)
and the current verification scope above.
