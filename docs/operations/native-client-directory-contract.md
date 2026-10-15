# Native everyday Client Hub contract

Status: implementation in progress; not a production authority switch.

## Built record-entry checkpoint — September 12

- The repaired signed-JWT/full-migration-chain D1 test passed (`3c98f1`): real
  management disable/enable receipts, admission version 3, stale-version edit
  returning opaque unknown outcome, no head/revision/audit/intent/fence residue,
  and successful exact receipt replay under freshly verified authority. Earlier
  race-fixture failures below are historical diagnosis, not the current result.

- Both exact list and record browser routes are now mounted locally. Record
  components are keyed by canonical selector and query/hash material is removed.
  The native onboarding review queue now returns to the native directory instead
  of the old PA-dependent Client Hub; its eight desktop/mobile tests passed
  (`df3adf`). Existing external/public routes were not redirected.
- A fresh application build passed (`0dc59f`). Eight desktop/mobile built-entry
  tests passed (`6bcff9`), including native-only list bootstrap, exact record
  reads, versioned edits, unavailable-server handling and legacy-selector
  read-only behavior. These tests mock API replies, not browser components.
- The record panel separately passed 16 desktop/mobile component cases. It
  clears visible private data when denied, expires any retained pending command,
  freezes uncertain edits for exact retries and refuses to infer edit permission
  from a list entry. Live server authorization is still required on every edit.
- Worker namespace mounting uses a separate default-off gate. Routing and HTTP
  tests are being reviewed independently; neither the build nor component tests
  substitute for the full-D1 signed-session test or production acceptance.

## Built list-entry checkpoint — September 12

- Subsequent independent root verification passed 43 pure tests across native
  HTTP, browser transport, cursor sealing and route selection (`fd1c53`). This
  includes final admission/profile epoch checks for session issuance and reads.
- Edit error categories do not prove rollback: a prior attempt may commit before
  access is revoked or a retry conflicts. The editor must not silently replace
  the pending command with a fresh mutation. Keep recovery references explicit,
  while wiping private profile data at authorization expiry or access loss.
- A later signed-HTTP D1 diagnostic (`4f2ede`) verified the real management
  disable/enable commands and active admission version 3. The stale request
  returned 503 rather than the fixture's expected 404. Exact error-body and
  no-partial-write assertions are being added before accepting that conservative
  unknown-outcome response as the expected database-fence behavior.

- The actual Operations entry now mounts `/clients/directory` independently of
  the legacy PA-owned application. Query/hash material is removed; existing
  client, onboarding, public delivery and Viewer routes retain their matching.
- A fresh local production build passed (`43013a`), as did TypeScript (`eb826a`).
  Four built-entry desktop/mobile browser cases passed (`86039d`): native-only
  bootstrap, initial null cursor, no horizontal overflow, and no legacy fallback
  when native endpoints are unavailable. API replies were synthetic; this does
  not prove Worker mounting or production authentication.
- The isolated directory panel separately passed 14 desktop/mobile cases with
  actual styles and browser transport. Record detail/edit implementation and
  final read/session admission-version checks are still in progress.
- Focused 0085 write-authority and retired-route tests passed 20/20 (`f122ef`),
  with TypeScript passing (`47cec2`). The joined signed-HTTP/full-D1 fixture is
  not yet green: its synthetic management race returned 503. Do not count this
  as acceptance or replace real management actions with trigger bypasses.
- Client address writes already reject state over 2/postal code over 20 in the
  canonical command snapshot; HTTP preflight classifies this as invalid input.
  Browser/read support is broader. This remains a coordinated PA/native address
  contract issue, not evidence of an unsendable committed outbox. No truncation.
- No production deployment, live configuration change, or PA release occurred.

## Ownership and entry

- Operations canonical records are the normal customer editor. The old
  source-qualified `/clients` views remain compatibility projections until the
  coordinated cutover; they are not the authority for this new editor.
- The native shell must authenticate an existing Operations staff admission,
  independently of PA login, legacy staff roles, or invitation keyrings.
- A staff login is not a directory grant. Reuse current native allow/deny,
  business-area, division, assignment, resource and inactive-parent evaluation.
- Native onboarding review links should return to this shell once it exists.
  Do not redirect working public delivery or Incoming links into staff login.

## List and pagination

- List both canonical contacts and organizations; names and emails are display
  and search fields, never automatic identity-linking evidence.
- Bound candidate scanning and visible results independently. An empty visible
  page can still have continuation when denied records occupy the candidate
  page. The UI must allow continuing rather than claim the directory is empty.
- Return profile summaries only after current native authorization. Search
  metacharacters are literal, not an invitation to expand a SQL wildcard.
- The service's keyset cursor is server-internal. The HTTP adapter must not
  disclose an unauthorized candidate's ID merely to support pagination.
- Browser continuation must be authenticated and confidential, bound to the
  native subject, query, kind, origin and a short expiration no later than the
  verified session deadline. Opening a continuation still rechecks current
  admission and record permissions; it grants no access of its own.

## Detail and edit

- Detail uses the canonical record ID and revision, not a PA numeric ID.
- Show relationship, enrolled PA destination and delivery information only
  through independently authorized, bounded projections. Never return connector
  secrets, raw outbox commands or financial documents through this profile API.
- Initial editing is profile-only. Relationship, enrollment, billing access and
  staff permissions are separate explicit workflows, not extra form fields.
- The server reloads existing enrollment destinations. A browser cannot choose
  a destination, actor or authorization context for a normal profile update.
- Require expected revision and a stable mutation ID. Exact retry returns the
  original receipt; different content under that ID conflicts. Refreshing stale
  data must not silently discard a user's edits or mint another retry command.
- A local save and remote delivery are distinct. Show saved locally, pending,
  partially synchronized, rejected/conflicted and acknowledged states honestly.
  PA outage must not force normal native work back into PA or erase queued work.

## Address compatibility prerequisite

- Preserve PA's established form layout and field semantics. The current native
  client command limit of two characters for state conflicts with its public
  onboarding field. Do not silently truncate, reinterpret or drop that value.
- Complete the generic PA/Ops address-contract review and required preserving
  migration before claiming full onboarding-to-edit acceptance. PA changes
  remain subject to the owner's production review/update gate.

### Reviewed mismatch and repair scope

- The intended common address contract is state 100, postal code 32 and country
  100 characters for both contacts and organizations. Reject excess input;
  never silently abbreviate a state or truncate a postal code.
- Current shared onboarding accepts state 100 but postal code 20. Native client
  commands and PA transport still enforce state 2/postal code 20; the approval
  service explicitly rejects incompatible addresses. These guards must remain
  until both destination schemas and their command validation can preserve the
  complete value. A green form test alone cannot prove delivery compatibility.
- PA's public form permits postal code 32, while its submission controller
  currently cleans to 20. Its client and archived-client columns need a
  preserving widening alongside generic command validation; organization
  columns already support the wider contract. This is a PA release prerequisite,
  not permission to modify either production database from Operations.
- Update shared fields, canonical commands, review builders/options, approval,
  HTTP validation and outbound projection/command validation together. Verify
  exact round trips and 100/32 versus 101/33 boundaries through both PA instances
  before enabling delivery of the widened values. Keep historical values intact.

## Local checkpoint — September 12

- The list service exists with internal keyset pagination. Three full-chain
  D1 tests through migration 0084 passed (`0f2d8c`), and TypeScript passed
  (`8fbdb4`). Root read the implementation and tests; they cover denied-page
  continuation, literal `%_` searches, both record kinds and inactive admission.
  Additional visible-page-cap and malformed input coverage is being added.
- The native HTTP adapter is being prepared but is not mounted. Review requires
  reuse of the validated profile reader, native admission-version fencing,
  server-owned destinations and explicit invalid-input versus uncertain-write
  responses before wiring it into the Worker.
- Its first eight mock-boundary tests passed (`e17e0e`), followed by TypeScript
  (`a088ef`). The adapter now uses the validated canonical reader and binds its
  separate CSRF token to the admission version. This is not yet an atomic
  write fence: the store and SQL authorization view must compare the admission
  version observed at authentication against the current version. Revoking and
  readmitting the same subject must invalidate the old in-flight request.
  Fresh authentication may still recover an exact previously committed receipt;
  do not put the changing admission version into the immutable mutation hash.
- Root reran canonical command/read and delivery cycle/scheduled-wrapper
  regressions: four files, 22 tests passed (`7d8add`). The read fixture uses a
  partial historical schema; this supports profile validation and snapshot
  behavior, not full current migration or live PA acceptance. Additional HTTP
  expiry/configuration/rate-limit coverage is in progress.
- Expanded HTTP coverage now passes 11 tests, independently rerun by root
  (`10102f`). It checks expiry after enrollment lookup before saving, expiry
  before releasing a profile, configuration capture across authentication awaits,
  rate-limit failure/denial and bounded request bodies. These use mocked native
  authentication and store dependencies; real signed-session plus current-schema
  acceptance is still required.
- The strengthened list suite passes five tests (`604a30`) and TypeScript
  (`9bc23e`), including primitive-only kind validation without coercion and
  continuation after ten visible results. The initial three-test checkpoint
  above is retained only as earlier evidence.
- Cursor review found the first draft's grammar rejected the empty encrypted-key
  segment used by direct-encryption compact JWE. Do not integrate that draft.
  Correction and round-trip tests are underway, including issuer/audience,
  admission, subject, query and origin binding. Normal renewed sessions may
  continue an unexpired cursor without extending its original expiry; a shorter
  current authorization deadline must still constrain it.
- Read and list support canonical identifier grammar broader than the current
  UUID-only mutation contract. Reconcile actual migrated identifier requirements
  before claiming every visible record is editable; do not silently invent
  replacement identities or broaden write validation without store tests.
- Browser cursor sealing, the mounted everyday directory screen and live
  acceptance remain unfinished. None of this checkpoint changes existing
  public client links, production flags or PA configuration.

### Native editor release gate

- The full migration-chain suite through 0085 passed all three tests (`ea3a2c`),
  including clean initialization and preservation of populated canonical history.
  In the same run, the joined native HTTP case failed at its revoke/readmit
  simulation: a forbidden direct admission update produced a quota error. That
  is not revocation-fence acceptance. The fixture is being changed to execute
  real authorized management commands and assert the resulting active/version
  state before checking the stale request's denial.
- Browser edit transport now snapshots the complete profile command before any
  await, requires the caller's stable mutation ID and expected revision, checks
  exact receipt correlation, and never retries or generates a replacement ID.
  Invalid input, conflict, denial and unknown outcome are distinguished without
  exposing server diagnostics. Its eight session/list/read/edit tests passed
  (`e6a7d5`), including lost-response plus explicit same-command retry. These are
  synthetic HTTP responses, not proof of server-side transaction replay.

- Root added the browser session/list transport with fixed same-origin native
  endpoints, bounded JSON responses, no redirects or automatic retries, strict
  summary validation and abort handling. Empty visible pages retain their
  encrypted continuation. Combined route, browser transport, cursor and native
  HTTP mock-boundary suites passed 38 tests (`e9e5fd`); TypeScript passed
  (`2117ea`) after correcting a test getter's declared type. This is local
  contract evidence, not live browser/database acceptance.
- The 0001–0085 migration-chain regression now includes the new admission fence
  and scheduler checkpoint, checks that no temporary upgrade guard remains,
  and preserves populated historical records without automatic enrollment.
  That expanded full-chain run is pending behind the single database-test runner.

- The exact native route parser/path builder now exists for `/clients/directory`
  and canonical record detail selectors. Three pure tests passed (`46c201`),
  covering identifier round trips and rejection of traversal, encoding aliases,
  query/hash material and unrelated legacy/public/Viewer routes. This helper is
  not mounted yet and does not grant record access or prove browser acceptance.
- Root compared the 0085 draft live-write view against the existing 0058 view:
  it changes only the admission-version equality (`39061c`). The migration also
  rejects open transient write fences instead of deleting them. Database upgrade,
  stale in-flight writes and replay tests are still being completed; the source
  comparison is not their substitute.

- The old `/api/directory/records/:recordId` PATCH handler depends on the legacy
  principal and cannot supply the admission version captured by native JWT
  verification. The selected local transition is to fail-close that PATCH
  handler and replace editing with the separately authenticated native adapter;
  retain GET compatibility. Do not perform a later admission lookup merely to
  make a stale legacy principal pass the new version fence.
- This is not a deployable partial cutover: finish the native route, real
  signed-session/store regressions and mounted editor before releasing the old
  handler's retirement. Preserve conflict/replay behavior in replacement tests.
  Public delivery, Incoming and Viewer endpoints are outside this retirement.

## Acceptance gates

- Real-D1 scoped list tests, including denied pages followed by permitted rows,
  inactive admission/parent scopes, literal searches and stable pagination.
- Native signed-session HTTP tests without any legacy principal fallback;
  cross-origin, expired session, cursor tampering and subject/query mismatch.
- Exact profile edit retry, stale version and current grant-revocation tests;
  source-qualified intents remain server-owned.
- Mounted desktop/mobile list, detail, edit and onboarding navigation, including
  uncertain saves and session expiration with private data hidden.
- Both-PA delivery and outage behavior remain covered by the separate durable
  scheduler acceptance. Neither list visibility nor a local save proves PA
  delivery or grants client portal/file access.
