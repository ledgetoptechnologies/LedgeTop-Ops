# Refined Viewer workflow — implementation evidence

The active goal remains the full September 29 scope. This is a progress ledger,
not a completion or deployment declaration. Existing unrelated root-checkout
changes are untouched; work is in the storage-diagnostics-cleanup worktree.

## Local changes verified so far

- Task options: direct effective-value editing, boolean checkboxes, reset,
  modified indicators, responsive two-column layout, reusable preset text.
- Providers: preset-focused detail, view/create/duplicate/edit/import/delete,
  capability refresh on opening with request coalescing and stale/offline notice.
  Read-only principals currently see cached capabilities because the existing
  probe endpoint requires node-management permission.
- Preset saves: explicit save, single-flight, stable retry idempotency, no late
  response replacing another dialog; incompatible stored keys require explicit
  removal rather than being silently discarded.
- Workspace API expiry: waits for verified in-flight authority renewal before
  interactive fallback, bounded to 25 seconds, at most one protected-request
  replay, unchanged upload body and idempotency headers, abort-aware.
- 27 focused tests passed across workspace-node-presets, workspace-renewal,
  workspace-fetch-renewal, workspace-task-options, workspace-renewal-api.
- Production build passed before the last preset-dialog race refinements;
  rebuild and full regression verification are still required for release.

## Open requirements / verification

### Subsequent local integration evidence

- Share backend and UI implementations are now present, including encrypted
  recovery, task-only creation, mutable settings and per-view enforcement.
  Full integration review remains pending. The legacy-copy UI must attempt
  recovery even when an encrypted token has not yet been stored.
- Staff unit review is persisted against model/version/asset/hash/manifest/CRS
  identity after authenticated preflight. Ordinary and temporary calculations
  read this server evidence; browser-supplied evidence is rejected. Cross-section
  requests retain their parent's evidence. Explicit encoded-unit conflicts still
  fail. Automatic ODM provenance and the UI source-status integration remain open.
- 51 calculation/source/profile tests passed after private API integration;
  a further dedicated staff-review API test passed in the 14-test API suite.
  After temporary API integration, 25 temporary/profile tests passed, including
  public reuse without review authority or saved measurement rows.
- Exact point grids now have bounded disk reuse across calculation children.
  Cache hits still verify source file hashes. Numerical-equivalence tests pass;
  synthetic timings are not evidence of live-user latency improvements.
- Task Save as preset/Update selected preset is implemented locally; fresh-schema
  submission and browser verification still need completion.

The items below retain the original acceptance scope; implementation presence is
not release or live verification.

- Public share management backend and UI, encrypted recoverable links,
  update/password/revocation enforcement across all public access paths.
- New task-only public sharing and default Operations sharing UI.
- Dataset-level source-unit provenance and staff ambiguity review.
- Exact cached profile surface reuse and measured cold/warm performance.
- Task scheduling Update preset action and fresh-schema submission review.
- Live point-cloud density and model/workspace session continuity checks.
- No-opener silent renewal requires the Operations grant transport described in
  OPERATIONS_SILENT_RENEWAL_HANDOFF_2026-09-29.md. Do not invent an endpoint or
  bypass expired/revoked Operations authority.
- Browser connection recovered: the signed-in Operations and Viewer dashboards
  were inspected. Automated project clicks did not expand the project, and the
  browser logged an Electron sandbox renderer error. User was asked to open the
  model manually; model density/session continuity remain unverified.
- No release has been committed/pushed/deployed for these changes yet.

Existing public project links and current latest-version semantics must remain
unchanged absent explicit user authorization. No live client measurements or
processing jobs have been modified for this work.

## Latest integration gates

- Combined local regression run: 141 tests passed, followed by additional
  focused source-unit, capability-refresh, profile and provenance tests.
- Production build passed at that combined-test checkpoint; subsequent edits
  still require the final release build.
- Fresh capability endpoint is read-authorized, server-proxied, rate-limited and
  coalesced; authorization is rechecked after provider I/O. It cannot change
  provider connection settings or start jobs. UI refreshes before submission and
  preserves incompatible drafts for explicit resolution.
- Immutable processing submission provenance is captured for new attempts;
  historical attempts remain unknown. This is not yet an audited automatic
  metric-unit producer contract.
- Profile panel retains a clearly labeled previous chart during loading/failure,
  with matching previous plan line and stale exports disabled.
- Full Linux server suite completed in a disposable network-disabled container:
  841 tests, 840 passed, one skipped, no failures. Source was mounted read-only.
  This checkpoint includes the pure ODM resolver but not its pending ingestion
  integration. The release workflow now expects schema 36, matching migrations.
- Broader non-browser frontend suite now passes: 959 tests, 949 passed, ten
  skipped, no failures. Extracted-function harnesses now include the new
  renewal/provider-refresh dependencies; original route/authorization assertions
  remain intact. Production build also passed (existing dependency/chunk warnings).
- Native ODM 3.5.6 source-unit resolver has nine passing contract tests. It is not
  yet connected to ingestion: durable returned-archive and exact submitted-input
  receipts are required. This does not establish automatic ODX/import support.
- A registry entry point now independently resolves and binds verified native
  DSM/DTM evidence to registered assets; 16 focused tests pass. This was added
  after the full-server checkpoint and requires a final combined rerun. Worker
  ingestion wiring is still pending; see ODM_INGESTION_EVIDENCE_INTEGRATION_2026-09-29.md.
- User authorized a read-only ODX worker version check. The sole configured SSH
  host, 192.168.68.86, timed out on port 22; local Docker had no running containers.
  Correct cluster host/connectivity is needed. No remote state was changed.

## Scheduled-ingestion integration checkpoint

- Migration 37 freezes submitted-file roles/inventory and records initialization
  generations plus immutable archive receipts. Ambiguous initialization retries
  cannot qualify as proven fresh processing.
- Scheduled ingestion now captures/verifies full archive bytes and inventories,
  inspects native DSM/DTM metadata and persists qualifying ODM evidence under a
  current job lease. Missing historical receipts, unknown versions/ODX and
  conflicts remain unknown. Imported archives and derived EPT still need their
  own contracts; this is not completion of automatic units across all sources.
- Full Linux server rerun: 864 tests, 863 passed, one skipped, no failures.
  Raster/ingestion-preparation checks: eight passed. Five additional Linux
  processIngest tests passed with real repositories, HTTP ZIP transfer and native
  TIFF metadata (positive DSM/DTM, missing receipts, unknown engine, explicit feet).
  Non-browser frontend suite rerun: 967 tests, 957 passed, ten skipped, no failures.
  Release workflow expects schema 37. Nothing committed, pushed or deployed yet.
- Read-only inspection of the Operations chat shows renewal transport implementation
  and focused tests in progress on its own checkout; no deployment reported. Do
  not treat that as a confirmed released endpoint or change the other agent's code.

### Renewal transport and preset browser QA checkpoint

- Added no-opener credentialed CORS renewal against the actual Operations challenge
  and grant contract. Controller/Viewer origins, correlation and redemption identity
  are pinned; no Viewer bearer is sent to Operations. Existing opener renewal stays
  compatible, with timed-out opener fallback. Unknown/HTML/network/challenge errors
  remain transient rather than being called revocation. Live deployment still needs
  the Operations endpoint flag and Access/CORS verification.
- Combined focused renewal, request continuity, options and preset tests: 46 passed,
  zero failures. Production build and diff whitespace checks passed.
- In-app browser synthetic fixture verified node detail preset management, refresh on
  editor open, direct number/checkbox/choice controls, and modified indicators.
  Corrected the fixture's obsolete integer type to native float/int/bool/string
  examples. Visual QA found shared preset fieldsets lacked task-editor styling;
  moved equivalent styling onto shared editor selectors and verified rebuilt UI.
  This is desktop synthetic QA, not complete mobile/live verification.
- Known SSH cluster address 192.168.68.86 timed out again; exact running ODX worker
  versions remain unverified. No live jobs or client records changed. No release yet.

### Sharing desktop browser QA checkpoint

- Extended the synthetic manual fixture with stored editable share settings and
  recoverable same-origin URLs (not a substitute for server authorization tests).
- In-app browser verified Internal client default; task-only public creation;
  saved-entry Copy link after reload; password set/remove; camera permission change;
  individual Orthophoto-only restriction; summaries reflecting saved settings; and
  project sharing offering only authenticated Operations client access.
- Found and fixed author CSS overriding the hidden New password field. Conditional
  managed-form fields now honor hidden; styled available-view fieldsets consistently.
  Rebuilt and re-opened the editor: field absent until Set/replace is selected.
  Added a targeted stylesheet guard; direct-sharing suite passes.
- Operations chat still working on renewal implementation/verification; no release
  confirmed. No live sharing or client records changed. Desktop synthetic QA does not
  prove deployed asset enforcement, mobile layout, or live renewal continuity.

### Combined verification and next unit work

- Latest combined Linux server suite: 869 tests, 868 passed, one skipped, no failures.
- Latest non-browser frontend suite: 977 tests, 967 passed, ten skipped, no failures.
- Concrete import and derived-point-cloud gaps are recorded in
  `UNIT_LINEAGE_IMPLEMENTATION_GAPS_2026-09-29.md`; explicit-unit persistence and
  LAZ-to-EPT conversion receipts are implementation work, not deployment blockers.
- Full objective remains incomplete. No commit/push/deployment at this checkpoint.

### Explicit source-unit implementation checkpoint

- Added physical DSM/DTM/EPT unit inspection with hash/size binding, full EPT tree
  digest verification, bounded EPT metadata, raster metadata preflight, and source
  identity checks. Handles metre, international/survey foot and supported GDAL
  centimetre/millimetre/kilometre units without assuming horizontal units imply Z.
  WKT-only supported EPT frames use the existing strict horizontal parser.
- Registry now persists original units and factors for exact registered sources.
  Raster/point calculation consumers independently re-read encoded metadata and
  compare factors; this evidence cannot fill missing metadata or become a metre
  override. Existing staff/ODM records remain immutable.
- 52 focused unit/volume/transect/UI-choice checks passed. Import registration hooks
  are in progress; scheduled explicit-metadata wiring and full combined verification
  remain pending. This checkpoint is not a deployed automatic-import feature.

- Import hooks now implemented for catalog and WebODM registration with a live
  operation-lease check after inspection. Preparation is shared with scheduled
  processing; explicit metadata is recorded before any inferred ODM evidence.
  65 Linux import/helper tests passed, including real metre/foot/survey-foot imports,
  WKT-only EPT, changed sources, conflicts, staff precedence and lease loss.
- Scheduled integration uncovered EPT registration dropping its header hash and
  using `files` instead of the repository's `manifestFiles`. Corrected both; 14
  Linux ingestion/provider checks passed. Encoded feet now persist independently
  of producer inference. Final combined rerun still pending after these changes.
