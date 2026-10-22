# Refined Viewer workflow — candidate checkpoint

## Latest state — September 30, 04:12 UTC

This section supersedes earlier release/deployment status below; historical test
checkpoints remain evidence for their stated scope, not current completion claims.

- The restarted Viewer returned HTTP 200 at `/api/v1/health`, revision
  `9b2a6d790afbf2c790be356c23d8bb78180607af`, schema 38. Its release workflow
  `36651663873` passed and promoted the verified image digest
  `sha256:5d39f4c6e1dce6f74cc88eada0e05975d257ebff29fb78c954915f3da457a279`.
- Live node QA exposed native ODM `enum` domains being populated but disabled in
  the shared task/preset editor. PR 6 fixes bounded string enum choices while
  preserving unsupported/file restrictions and server validation. Its exact head
  `87c39679e6beefd9d355c96204d4a5f01ea07196` passed 2,028 source tests
  (15 skipped, zero failed) and 138 exact-image tests (zero skipped/failed).
  The local real-browser suite also passed 16/16.
- PR 6 merged as `86c10a6b5ba97fb32ee841dbda0a06f7b482eaee`. Main release
  workflow `36667732671` completed successfully: 2,028 source tests passed
  (15 skipped, zero failed), and 138 exact-image tests passed without skips or
  failures. It promoted digest
  `sha256:32cf03fce236dac27bc87bee629b74e522afab90c05806b77f54677b4309b401`.
  The downloaded attestation binds that digest to the merge, schema 38 and the
  exact workflow SHA; its file hash matches the accompanying checksum. This is
  publication evidence, not deployment of that merge.
- The existing Hickory Grove tab reports 6,828,524 visible points, active 7.5M
  of 10M requested, 153 nodes and LOD 0–5. It subsequently entered access renewal
  and hid personal measurements. These are browser diagnostics, not independent
  GPU measurements or successful session-renewal acceptance.
- Live sharing retry remains unverified: Operations launch inspection timed out,
  and a fresh Viewer workspace requires an Operations launch. Earlier client-grant
  and share-eligibility errors occurred around the nginx outage; await the
  requested status/error logs and recheck before attributing them to code.
- A new focused run passed 49 profile/source/cache/timing tests without skips or
  failures. The 64-point synthetic LAZ diagnostic measured cold total 448.303 ms
  versus warm 4.771 ms, with warm decode/grid zero and full-result equality.
  This does not establish representative client latency; a larger isolated
  benchmark is in progress.
- The user explicitly deferred live Operations silent-refresh acceptance until
  the other agent's rollout. The full goal is not complete. No live presets,
  links, client grants, measurements or processing jobs were changed.

### Post-restart follow-up — September 30, 04:19 UTC

A fresh Operations tab successfully launched the authenticated Viewer workspace,
without reloading the existing model tab. The task share dialog still defaults to
Internal client. Public-link eligibility now loads, saved settings are summarized,
and Copy link returned the visible `Link copied` status without creating a new
link. The existing Edit settings dialog exposes password/expiry/views/features;
it was closed without saving. Operations client access still reports that it
could not be loaded; this failure remains separate from the now-working public
sharing path and requires the requested upstream status/error evidence.
Opening the saved public link loaded the Hickory Grove model, all five allowed
view buttons, camera controls and a measurement list with zero staff records.
No new measurement was created and no existing share settings were saved.

The opt-in `node scripts/benchmark-measurement-profile.mjs` now exercises
1,048,576 unique binary-EPT points across five nodes, a native 0.25 m grid, and a
native tiled 1024-by-1024 TIFF through independent bounded calculation children.
Root verification passed full cold/warm volume and profile equality, parent-grid
reuse, complete counts/coverage and same-size source-tampering rejection.

For that root run, EPT profile child time was 384.193 ms cold and 146.647 ms warm;
verified source I/O plus hashes was 22.096/22.743 ms, decode/grid 232.715/0 ms,
and sampling 1.518/1.899 ms. TIFF profile child time was 114.556/116.109 ms,
including source hashing 4.050/4.283 ms and raster reads 5.199/4.982 ms.
These are synthetic local timings, not live latency, large-LAZ decoding evidence,
queue wait measurements or persistent raster-cache claims. The benchmark bypasses
the queue and explicitly records its wait as unknown. Existing queue timing and
rapid-input coalescing remain covered by their scoped tests. A further root run
passed 37 preset/profile-control tests without failures or skips.

Public-view QA found generic `Saved measurements` copy despite the collection
being page-only. The follow-up now labels temporary collections and explains
refresh/close lifetime, project non-persistence and exports; staff persistent
collections retain their original wording. Forty-eight focused tests passed,
the production build passed, and an isolated local in-app-browser preview showed
the temporary heading, accessible region and visible notice correctly. This
changes copy only, not authority or persistence. It is not deployed yet.

Subsequent live public QA created one page-only orthophoto distance. Its card and
status explicitly reported `Temporary — resets on refresh`; reloading only that
public tab returned its list to zero. No calculation was started and no staff
measurement was edited. The pending copy update remains separate from this
verified deployed non-persistence behavior.

PR 7's first CI run (`36668849284`) found one stale test-only store double:
`measurement-overlay-performance.test.mjs` omitted the real store's `persistent`
method. The fixture now provides that method and checks that saved staff wording
survives loading/retry recovery. Fifty-six combined overlay/cross-view/list tests
passed with no failures or skips. A fresh full CI run is required; the failed run
did not publish an image. The Operations client-access diagnostic handoff is in
`OPERATIONS_CLIENT_ACCESS_DIAGNOSTICS_2026-09-30.md`.

## Implemented locally

- Stable in-place workspace renewal, including the Operations credentialed CORS
  challenge/grant path when an opener is absent or unresponsive. No Viewer bearer
  is sent to Operations; session identity and origin remain pinned.
- Internal/Public task sharing, existing-link recovery/editing/revocation, view
  restrictions, password and expiry updates, and server-side permission checks.
  New public project sharing is disabled; existing project links are preserved.
- Direct typed task/preset controls and node preset management with fresh capability
  checks and explicit preset saves.
- Source-bound persistent unit evidence: staff review, audited fresh ODM inference,
  and physical explicit DSM/DTM/EPT metadata on imports and processing results.
  Feet remain feet with an explicit factor; units do not prove datum or accuracy.
- Verified point-grid cache, phase timing and profile request coalescing with a
  last-good chart while a replacement is pending.

## Verification at this checkpoint

- Schema-38 checkpoint (`6646032`): Linux server suite, 936 tests,
  935 passed, one skipped, zero failures.
- Non-browser frontend suite: 998 tests, 988 passed, ten skipped, zero failures.
- Production build passes (existing LAZ module/chunk-size warnings remain).
- Synthetic desktop browser QA covered direct preset editing and link creation,
  re-copy after reload, password changes, permissions, per-view restrictions and
  project-versus-task sharing. It found and fixed two CSS visibility/style issues.
- Windows-native import tests are not an applicable gate: storage mount identity
  checks require Linux `/proc`. Those suites passed in the isolated Linux image.

## Deployment and unresolved checks

This document does not attest to a deployed release. The current working-tree
migration target is schema 38: immutable EPT conversion receipts. Back up the
database before deployment. Historical EPT outputs receive no invented receipts;
only a successful, verified local conversion can establish inherited unit evidence.
Preserve the configured session secret: encrypted public-link recovery uses a
domain-separated key derived from it. Existing hash-only links without recoverable
receipt data are left active and reported unrecoverable, never silently replaced.

Operations renewal requires its own endpoint release/feature flag and Access/CORS
configuration. No Operations code is changed in this checkpoint. Verify live expiry
with uploads/drafts/camera/edit state and genuine signed-out recovery after deploy.

The native LAZ-to-derived EPT proof chain is implemented with immutable conversion
receipts and synthetic worker recovery tests. Verification against the installed
real converter remains outstanding; synthetic tests do not establish that result.

Remaining goal work: audited ODX worker versions/provenance; historical untagged
import policy; mobile UI QA; live point-cloud
zoom density and real profile/session performance. Do not treat these gaps as done
because the local test suite is green. No live client data or jobs were changed.

Draft PR: https://github.com/ledgetoptechnologies/3D-Viewer/pull/4.
The PR runs the candidate image checks without merging, publishing release tags,
or deploying. Its checks must be inspected separately from these local results.

## PR candidate CI result

[Run 36629496980](https://github.com/ledgetoptechnologies/3D-Viewer/actions/runs/36629496980)
completed successfully for source checkpoint `6646032` on September 29:

- Full check suite: 2,032 tests; 2,017 passed, 15 skipped, zero failures.
- Logs confirm execution of 390px and 320px workspace/project browser cases.
  This is not complete visual acceptance of the new task-link editor and preset
  layout; existing assertions do not cover every new control at those widths.
- Candidate image built and exact-image runtime verification passed: 138 tests,
  138 passed, zero skipped. Schema 38 and source identity checks passed.
- Release-tag promotion and release-attestation publication were skipped as
  intended for a pull request. No production deployment is established.

## Narrow-layout follow-up

The in-app browser exercised production-built assets in a loopback-only synthetic
workspace using 390px and 320px iframe viewports (layout QA, not touch emulation).
At 390px the standalone preset editor showed one-column resolved options and a
reachable Create preset footer. At 320px the task share dialog defaulted to
Internal client; Public link creation, saved-link password changes, disabling
camera positions, and Copy link succeeded against the synthetic API. The edit
dialog's Save link settings button was visible and reachable. Clipboard contents
and a real public-link destination were not independently verified in this pass.

Visual QA found and corrected two narrow-layout defects: header actions extending
beyond the viewport, and public-link create inputs exceeding their card's content
width. Rebuilt screenshots confirm the wrapped header and contained inputs at
320px. These checks neither mutate client data nor prove live authorization or
session continuity. Remaining narrow-dialog actions and live acceptance remain
separate gates.

At 1200px, subsequent synthetic browser QA confirmed the standalone preset
editor's two-column layout and node option order. Numeric zero and boolean edits
showed Modified state; Reset returned both controls to their node defaults and
disabled their reset buttons. Search reduced the visible options to the matching
feature-quality control. No preset was saved and no task was submitted in that
pass. This adds rendered editor evidence, not real-node schema compatibility.

Follow-up 320px synthetic QA exercised the public-link revoke confirmation and
confirmed project sharing exposes authenticated client access only. The client
grant form had the same intrinsic input-width overflow as public sharing; the
scoped width constraint now covers both forms. A rebuilt screenshot confirms the
project selector, expiry and grant button fit within the card. No real link was
revoked and no client grant was created. Focused sharing/preset tests: 48 passed,
zero skipped; production build passed. Live node inspection remains blocked by
the unauthenticated Viewer shell; the previous cluster address must not be used.

## Live worker identity check — September 29

Read-only SSH access to the user-confirmed cluster PC `192.168.50.89` succeeded
with the existing ed25519 identity selected explicitly. Container metadata reports
ClusterODX 1.5.9, image `webodm/clusterodx`, revision
`818f50bbbfcab107c41fcf4a7101e2bfcbce87e5`, digest
`sha256:b303d24a1f28d0cfa8a6626a9ce0826fc20e586398bd4279a2a70bedfbcc4afd`.
The local `node-odx-gpu` container uses `opendronemap/nodeodm:gpu`, digest
`sha256:214fe6a4421fe5283648400e9ce455457bb866c87a20a325fddfd494e4ad482a`.
Its physical `/code/VERSION` and read-only `/info` agree on ODM 3.5.6;
NodeODM reports 2.2.4. This identifies the installed engine version, but does not
retroactively establish source-bound producer receipts for historical outputs.

ClusterODX's registered workers are `node-odx-gpu:3000` and
`192.168.50.88:3004`. The latter returned `EHOSTUNREACH` when queried from the
cluster, so its engine version remains unverified. Tokens were kept inside the
container and excluded from outputs. No task or container was changed. Viewer
authentication, live renewal, real converter verification and release/deployment
remain outstanding.

The live ClusterODX `/info` response advertises API 1.5.3 (distinct from its
package version 1.5.9), ODM 3.5.6, unlimited images (`null`) and the documented
cluster resource sentinels. Its `/options` and the local worker both return 81
ordered options beginning with end-with, rerun-from, min-num-features and
feature-type. These responses match the adapter's existing detection contract.

Read-only probing found Entwine 2.2.0 in the local worker. Its `--version` exits
zero with a native usage banner, which the original identity parser rejected.
The parser now recognizes that bounded banner and stores `Entwine 2.2.0` while
retaining executable hash/stability checks and rejecting unrelated multiline
responses. In-memory execution of the corrected identity module against the
actual binary succeeded; executable SHA-256 was
`f19d354ded7796a577d68963ab60718a9aa920b0ef8b19ee4fd047b78a21417c`.
The focused Linux identity/receipt/recovery tests passed: 31 tests, zero skipped.
Subsequent real-binary QA converted the repository's 64-point synthetic LAZ with
the fixed `build -i INPUT -o OUTPUT` command. PDAL 2.4.3 read all input and output
points independently; sorted XYZ tuples were exactly equal, with all 64 points
retained. The measured build took 1,042 ms. Unique temporary test directories were
removed. This verifies that worker's conversion command on this synthetic source;
it does not verify the Viewer host's converter, historical provenance, CRS/unit
metadata propagation or performance on a client model.

Cross-repository renewal inspection at Operations `68ca140` identified required
session correlation absent from the Viewer transport. Viewer now sends and
validates the exact echoed session ID with the existing request ID and subject
checks. Forty-one focused renewal/recovery/upload-continuity tests and the
production build passed. The Operations handoff documents the existing Viewer
caller and its current strict request/response contract. Operations still gates
its endpoint to staging; production rollout and live browser acceptance remain
external release gates.

## Candidate and live density checkpoint — September 29, 23:47 UTC

[Run 36646276248](https://github.com/ledgetoptechnologies/3D-Viewer/actions/runs/36646276248)
passed for `a83fa6ba913fa4cc65731179cfba370203a04cd8`: 2,034 source tests,
2,019 passed, 15 skipped, zero failures; exact-image tests: 138 passed, zero
skipped or failed. Pull-request execution did not publish release tags or deploy.

Operations' existing Open Viewer workspace action successfully opened an
authenticated Viewer workspace. This supersedes the earlier browser access
blocker, but does not prove background renewal. Public health headers still
identify deployed revision `27b1ecd7daa942ce1a9ab67b0b87a60942792b74`, schema 33.

Read-only Hickory Grove point-cloud QA kept the requested and active point budgets
at 10M throughout. At the default 697 x 748 framebuffer, settled overview,
medium and closer views submitted 5,469,010, 7,111,535 and 8,576,241 points.
At a temporary 1599 x 910 desktop framebuffer, the same view submitted 9,992,117
points across 221 nodes; further zoom submitted 7,917,961 points across 174 nodes
and retained visible tire/ground detail. Selected detail pending was false,
visible LOD levels reached 0-5 and reported frame rate was about 144 fps. The
temporary viewport override was reset. These values are browser-reported CPU/
submission diagnostics, not independent GPU performance measurements. Lower
visible point totals after zoom do not alone imply loading failure: the visible
region changes. The earlier sparse 0.4M adaptive-budget failure did not reproduce
in this session; this is not a claim about every device or model. No measurement,
client grant, public link or processing job was changed.

Operations renewal PR 138 remained open and draft at `81e7279`; its current handler
explicitly requires staging plus the default-off feature flag. Production silent
renewal therefore still needs the separate Operations rollout and live acceptance.

## Installed converter unit-preservation QA

The actual worker's Entwine 2.2.0 / PDAL 2.4.3 converted three independent synthetic
64-point LAS 1.4 cases: horizontal EPSG:32616 with compound vertical metre,
international foot and US survey foot declarations. PDAL's LAS writer assigned
the synthetic compound CRS metadata without any reprojection filter. Independent
sorted XYZ comparisons confirmed base fixture = declared LAS = converted EPT in
every case. All 64 points and schema scale 0.01 survived. EPT SRS retained the
compound WKT and horizontal EPSG:32616; vertical factors were 1, 0.3048 and
0.304800609601219 respectively (the latter is serialized US survey feet).

Commands inside `node-odx-gpu` were `pdal translate BASE.laz INPUT.las
--writers.las.a_srs=COMPOUND_WKT --writers.las.minor_version=4
--writers.las.dataformat_id=6`, `pdal info --metadata INPUT.las`,
`pdal info --point 0-63 INPUT.las`, `/usr/bin/entwine build -i INPUT.las -o OUTPUT`,
and `pdal info --point 0-63 OUTPUT/ept.json`. Build times were 1,293 ms (metre),
1,277 ms (international foot) and 1,262 ms (US survey foot). The repository's
synthetic fixture was transmitted in memory; `/tmp/ltds-entwine-unit-C1nGm7` was
removed only after resolved parent/prefix validation, and removal was confirmed.
No installed code, container, client data or processing job was changed.

This demonstrates coordinate and declared-unit preservation for this installed
converter on synthetic inputs, not datum correctness, survey accuracy, production
performance or the configuration of a separate Viewer-host converter. It supports
retaining encoded foot elevations and applying the source factor once; it does
not justify interpreting every historical or untagged source as metres.
