# Native workforce implementation boundary

Status: inactive Operations ledger and first command slice added September 13,
2026. Workforce implementation and end-to-end financial acceptance are not complete. This
supplements M05/M06 in the migration register; it does not replace the full
agreed workforce scope.

## September 14 local manager-queue checkpoint

- A default-off native `GET /api/native-workforce/time-record/review-queue`
  now reads at most 25 current submitted, independently reviewable internal or
  active native-project time entries per page. It rechecks native admission and
  the same scoped `time.review` predicate used by the review mutation. Its
  opaque HMAC cursor is bound to the reviewer and verified Access subject; no
  job, payroll, rate, invoice, unrelated profile or raw Access-subject fields
  are returned. The matching direct `/time/review` screen supports reasoned
  approve/return, current-revision receipts and same-command uncertain-outcome
  retry. The existing review executor still requires an active beneficiary;
  former-staff pending-entry handling is an explicit policy gap, not silently
  widened by this queue.
- Local Operations production build passed, focused D1/HTTP/routing tests
  passed 22/22, and direct-page desktop/mobile browser tests passed 6/6.
  This is not production deployment, PA financial acceptance, or authority to
  enable the default-off feature.

## Current implementation evidence

- Operations `team-assigned-work.ts` uses legacy team/operations ACLs and
  `pa_operations`/`pa_operation_assignments`. It is not native time authority.
- `job-brief.ts` and migration 0017 retain PA-projected operational identity.
  Native time must not gain access merely because a projected assignment exists.
- `client-service-assignments.ts` reads service projections. It neither captures
  employee time nor independently authorizes workforce review.
- In the inspected PA checkout, `src/controllers/api/workforce_v1.php` requires
  a PA session and CSRF. It is not a generic scoped API for an Operations worker
  without a PA account.
- PA `TimekeepingService.php`, `TimeApprovalPolicy.php` and the baseline time,
  billing-allocation and earnings tables couple current time handling to PA
  users, assignments and financial processing. They cannot be reused as native
  Operations authorization merely by changing the HTTP credentials.
- Migration `0096_native_workforce_foundation.sql` adds inactive local storage
  for separate time-entry and bonus-adjustment revision/submission/review/command
  histories. It mounts no route, creates no authority or seed grant, calls PA
  nowhere, and has no payroll, invoice, earnings, payment or financial-rule
  effect. It is therefore not an activated capture or approval workflow.
- A submission references its immutable revision directly; there is no redundant
  caller-supplied JSON snapshot or digest that could claim a different version.
  The command table is only an immutable command-shape journal until a later
  transactionally fenced executor can create causal receipts; it is not proof
  that a mutation, PA call, pay or invoice action occurred.
- A returned revision cannot be resubmitted: a correction creates a new immutable
  revision and that revision must be newly attested and reviewed. Time and bonus
  revisions both carry only descriptive `internal`/`project`/`job` context.
- A time submission requires the beneficiary's attestation. A bonus proposal
  may instead be submitted by its recorded proposer or beneficiary, supporting
  owner/manager-initiated adjustments; it still requires a separate review and
  currently has no route or financial effect. Future commands must independently
  authorize the proposer and reviewer in the same write transaction.
- Its `internal`/`project`/`job` context kinds are descriptive only. A project or
  job ID is not a foreign key to a PA projection and does not authorize capture;
  native project/job authority and permanent mappings remain prerequisites to
  activation.
- Migration `0097_native_workforce_authority.sql` adds an unseeded,
  default-deny local capability catalog and scoped grant shape for internal and
  canonical native-project preflight. It has no route, no PA write, and no job
  grant scope. The read evaluator is UI/preflight evidence only: a future
  record, submit, or review mutation must recheck current admissions, grants,
  project scopes, lifecycle, and deny rows in the same D1 transaction. A
  cancelled project cannot begin a new record; historical review/correction
  policy remains a later transactionally enforced workflow decision.
- Migration `0098_native_workforce_time_record_receipts.sql` and the
  default-unmounted `native-workforce-time-record.ts` add an atomic initial
  time-record command. It creates revision 1 only, checks current actor and
  beneficiary admissions, bound subject, exact self/on-behalf capability,
  active canonical project scopes and deny precedence in the D1 write batch,
  and stores an immutable command-linked receipt. Internal context is
  supported; job context and non-active projects fail closed. Exact retries
  recover the original receipt, while an ambiguous database acknowledgment
  without one reports unknown rather than a definitive denial. Focused
  full-chain D1 tests passed 9/9, including multi-scope coverage, scoped
  deny, and rejection of accessor-owned actor/project input without invoking
  its getters; Operations TypeScript passed. The
  revocation test checks authorization after a prior revocation. A later
  adapter-controlled interleaving revokes every applicable allow before the
  real D1 batch and proves no entry/command/receipt survives; concurrent
  identical commands commit once and exactly replay once (13/13 focused D1
  cases total). These do not cover every issuer or worker race. No route, default grant, PA
  call, payment, billing or deployment is added.
  Before mounting any route, the verified Access subject and native staff ID
  must come from the trusted server-side session, never request JSON. The
  executor's current input shape is an internal command contract, not a public
  authorization boundary.
- The first-record executor now classifies a complete zero-change conditional
  INSERT acknowledgement as denial and a known duplicate entry/command key as
  conflict, after exact-receipt recovery. Malformed responses and unreadable
  acknowledgements remain unknown. A fresh full-chain D1 run passed 11/11 and
  Operations TypeScript passed. This narrows known outcomes but is not a
  controlled concurrent writer/revocation test or HTTP activation evidence.
- Migration `0099_native_workforce_time_submit_review_receipts.sql` and the
  default-unmounted submit/review executor add immutable receipts for beneficiary
  submission and independent managerial review. The write batch checks the
  current revision, status, actor admission, active project scopes, grant
  coverage and denies. A receipt insert now always executes, so a rejected
  conditional transition aborts the entire batch instead of leaving an orphan
  command audit row; a later authorized retry of that same command is possible.
  Review decision and reason are copied before asynchronous hashing, preventing
  caller mutation from changing the committed review behind a receipt. Both
  commands now snapshot only enumerable own data properties before hashing or
  writing, rejecting accessor-owned identity/reason fields. Focused full-chain
  D1 tests passed 9/9 and Operations TypeScript passed; staging
  inventory tests through 0099 passed 48/48. This is local evidence only: no
  route, default grant, PA call, payroll, invoice, deployment or live acceptance
  was added. Known rejected submit/review writes now classify as denied,
  known duplicate command keys as conflict, and unreadable acknowledgments as
  unknown; lost-ack recovery rechecks current actor admission. Controlled
  submit/review races remain required before activation. New review after project closure is
  currently denied; historical review policy needs an explicit decision.
- Migration `0100_native_workforce_authority_grant_change_receipts.sql` and a
  default-unmounted grant-change executor now provide version-checked revoke/
  reactivate transitions with immutable issuer-attributed history and exact
  replay. The transaction rechecks the still-admitted original issuer, bound
  Access subject, target state/version and valid active scope for reactivation;
  a failed conditional change cannot leave a successful history or receipt.
  Focused full-chain D1 tests passed 6/6 and TypeScript passed. Zero-change
  CAS acknowledgments are classified as denial, relevant known duplicate
  command/change/receipt keys as conflict after exact receipt recovery, and
  lost receipt recovery rechecks current issuer admission. This is not complete grant
  administration: there is no grant-create path, dedicated workforce manager
  capability, issuer ceiling, or successor/owner recovery authority. Reusing
  the unrelated staff-admin delegation would silently broaden access. The
  0100 slice has no route, seeded grant, production migration or deployment.
- Migration `0101_native_workforce_grant_issuer.sql` adds a separate, unseeded
  workforce manager delegation and exact-tuple issuer ceiling schema. It has
  no grant creation executor, governed revocation integration, bootstrap,
  route, flag, PA call or deployment. The focused full-chain schema suite
  passed 5/5, including revoked-issuer reactivation denial. The proposed issuer/ceiling transaction and recovery rules are
  recorded in `native-workforce-grant-governance-design.md`; no issuer power is
  activated merely by the table existing.
- `native-workforce-grant-issuer-policy.ts` is a strict, pure preflight over
  supplied manager and ceiling rows. Its 6/6 focused tests cover default deny,
  exact target, effect/capability/operation matching, area/division/project
  containment, and overlapping-deny precedence. It does not load current D1
  rows, check admission or project lifecycle, or authorize a mutation. A future
  issuer executor must repeat the policy and version checks at the primary D1
  write point.
- Migration `0102_native_workforce_grant_issuance.sql` and an unseeded issuer
  command now form an initial grant-create path. The same D1 batch inserts the
  grant, immutable issuer proof and exact-retry receipt; aborting guards recheck
  actor/target admission versions, manager delegation, issuer ceiling, matching
  denies and live scope. The combined real-D1 schema/policy/issuance suites
  passed 14/14 after malformed project-scope JSON regressions were added;
  Operations TypeScript passed. The original single guard hit
  SQLite's expression-depth limit in the first executable test; it was split
  into two aborting guards and rerun successfully. The project-scope guard now
  denies missing fields, extra fields and primitive JSON elements without
  recording a grant or receipt. Four new real-D1 interleaving cases revoke the
  manager, issuer ceiling, actor admission, or target admission after preflight
  but before the write batch. The complete issuance test file passed 7/7;
  each interleaving leaves no grant, issuance proof, or receipt. This is local
  evidence only:
  issuance has no enabled route, seed, default-on flag or deployment, and issuer
  bootstrap, broader race/denial QA and governed successor recovery still
  block activation.

## HTTP activation boundary

September 14 submit/review race checkpoint: the real-D1 submit/review suite now
passes 12/12. New deterministic interleavings revoke the submit or review grant
after initial command preparation but immediately before the atomic write;
both deny and leave no submission/review, audit command or receipt. A concurrent
identical submit creates one durable submission and returns one original plus
one exact replay. These tests strengthen the mutation boundary but do not
replace controlled independent-manager review, beneficiary/actor admission
races, conflicting decisions, worker UI/HTTP, PA finance integration or live
acceptance. No endpoint or deployment was added by this checkpoint.

September 14 continuation: the exact `/api/native-workforce/time-record` POST,
`/submit` POST, `/review` POST and `/session` GET namespace is now reserved
before legacy `/api/*` staff auth.
The native Access/admission resolver supplies actor identity; strict body,
origin, CSRF and shared D1 IP/subject rate limits guard the existing atomic
0098/0099 executors. Submit accepts only command ID, entry ID and expected
revision; review additionally requires an explicit approval/return decision
and reason. Client JSON cannot provide an actor, beneficiary for transition,
or alternate authority. The D1 executor, not the HTTP route, enforces
self-attestation versus independent-manager review at the primary write.
`NATIVE_WORKFORCE_TIME_RECORD_ENABLED` is independently
`false` and its origin is blank in production and staging config. Disabled
requests return 404; no grant, migration, PA call, UI, activation or deployment
was added by the HTTP wiring. Focused HTTP/router and 0098/0099 D1 suites
passed 40/40 and Operations TypeScript passed after this route extension.
Earlier 40 release/staging preflight checks and generated Worker types passed
before this extension and have not been rerun for it. This is not a complete
time-capture workflow: submit/review have no UI, project/job capture and
bonuses remain incomplete, and controlled acceptance plus governed grant
bootstrap are still required.

The same disabled namespace now also reserves `GET /entries` for the current
native staff beneficiary's own time history. Its reader takes staff ID and
Access subject only from the verified server-side session, rechecks the exact
active admission within the D1 read, returns at most 25 current-revision
entries per page, and uses a validated opaque cursor. It returns no other
staff member's entries, payroll figures, PA financial records or manager
review notes. The session response supplies only the current staff ID needed
for future self-record UI; it grants no time capability. The combined
time-record, submit/review, self-history and HTTP/router suites passed 46/46,
including cross-staff pagination, malformed cursor, revoked admission, and
no-CSRF read behavior; Operations TypeScript passed. This is local source
evidence at that checkpoint, not a mounted UI or seeded permission,
deployment or live acceptance. Manager review-queue reads need a separate
resource-scoped authorization contract; this self-history route must not be
repurposed to list other workers' time.
An independent read-only QA pass found no concrete access-control, pagination,
or response-shape defect in this local slice; it confirmed the checked-in
activation flag and origin remain false/blank. That review does not replace
staging or production acceptance.

September 14 UI follow-up: a direct-only `/time` page is now routed before the
legacy Operations application. It bootstraps only through the separately
default-off native workforce session and displays beneficiary-only paginated
history. Its first entry form records self/internal time using the native
session's staff ID; it never asks the browser for another beneficiary or uses
the legacy CSRF/session helper. An ambiguous POST retains the exact command and
entry IDs for explicit same-staff retry, and a definitive receipt is not
invalidated by a later history-refresh failure. Expiry clears displayed
private records; a changed staff identity cannot replay a prior attempt.
Independent QA found a loose history parser, which was tightened to the
server's ID, revision, calendar-date and page-size bounds; the fixture now
covers a preexisting project entry and malformed-row rejection. Operations
TypeScript and build passed, and the rebuilt desktop/mobile browser suite
passed 12/12. This is local and unlinked from normal navigation; no deployment,
grant, project/job capture form, on-behalf UI, bonus UI, submit/review UI or
financial processing is claimed.

September 14 beneficiary-submission continuation: the local `/time` page now
offers an explicit "Submit for manager review" action on the current staff
member's draft entries only. It sends the entry ID, exact revision and a new
command ID to the existing default-off native submit route with native-session
CSRF; the server supplies and checks the actor. A network/5xx ambiguity holds
that exact command in memory for an explicit same-staff reauthenticated retry.
After a verified receipt the UI removes the draft action before refreshing
history, so a failed follow-up read cannot invite a new submission. Live
401/403 denial clears private history and controls; a 409 conflict disables the
stale draft until an authoritative history refresh succeeds. An unresolved
submission also blocks keyboard form submission of a new entry. This is
self-attestation, not independent managerial approval; returned entries still
need a separate correction-revision flow. Operations TypeScript and build pass,
the focused desktop/mobile `/time` browser suite passes 24/24, and the existing
HTTP, D1 submit/review and self-history backend suites pass 30/30. This is
local/default-off only: no manager review queue or UI, project/job/on-behalf
capture, bonus entry, grant seeding, deployment or PA finance integration is
claimed.

The legacy `/api/*` middleware authenticates a different staff principal and
must not authorize native workforce commands. An exact, grant-issuance-only
`/api/native-workforce/grant-issuance` boundary now intercepts before that
middleware. It uses the native Access-JWT/admission-version resolver, same-origin
and CSRF checks, strict body/method parsing, IP/subject rate limits, and a
dedicated default-off flag with an empty origin. The trusted server session
supplies both actor staff ID and verified Access subject; neither comes from
request JSON. The command's conditional D1 write remains the final authorization
check. Exact replay maps to success, conflicts to 409, denial to 403, and
unresolved acknowledgments to retryable 503 without claiming rollback. The
focused HTTP and root-router suites passed 8/8, regenerated Worker types now
match the configuration, Operations TypeScript passed, and 82 staging/release
checks require the route flag to remain false with an empty origin. This is
not an activation decision: no issuer was seeded, no deployment was made, and
governed grant changes, native job authority, controlled race tests,
readiness/preflight, route isolation, and project lifecycle/historical-review
rules still require implementation and tests.

## Required implementation, not optional substitutes

September 14 local on-behalf checkpoint: migration 0108 adds an unseeded,
exact actor-to-beneficiary selection delegation with deny precedence. A
distinct-beneficiary time-record command now checks that delegation inside
the same D1 write batch as the existing work-context `time.record.on_behalf`
grant; self records do not require a delegation. The exact-ID confirmation
route reveals only staff ID and display name when both the delegation and
current internal on-behalf authority exist, and returns a generic 404
otherwise. The `/time` screen confirms a specific Worker ID, shows a
separate on-behalf receipt, and does not pretend the record appears in the
actor's private history. Its session/history bootstrap is generation-fenced
and rechecks identity before rendering history. The new route and UI remain
default-off and undeployed. There is deliberately no seeded delegation or
issuance command: a governed, attributed administrative issuance/revocation
ceremony and production acceptance are still required before activation.

- An independent manager queue must read only current-revision, submitted
  entries whose `internal` or native-project context is covered by the current
  reviewer's active `time.review` grants, with active deny precedence and an
  active bound Access admission. The beneficiary must differ from the reviewer.
  Do not expose job-context entries until native job authority exists. The
  queue may disclose the beneficiary's stable staff ID, work date, duration,
  context and submitted description, but not Access subjects, payroll fields,
  rates, invoice data or unrelated staff profiles. Pagination must be bounded,
  scope-bound and reauthorize every page; a cursor is not an entitlement.
- Native capture must cover client/project/job work and internal work, including
  self entries and explicitly authorized on-behalf entries. Internal-only capture
  may be an intermediate development slice, not the final delivery.
- Persist worker identity separately from the actor entering the record. Pin
  and recheck both native identities and relevant scope at the transaction that
  commits an on-behalf entry.
- Keep durable revisions, immutable command receipts and submitted snapshots.
  Retries must recover the original result rather than add hours twice.
- Before route activation, complete deterministic duplicate-resource and
  denied-write classification across every command executor, and add controlled
  concurrent writer/revocation tests. The first record executor now covers
  known denial/duplicate cases; the sequential revoked-before-write case does
  not prove the concurrency boundary.
- Native grant changes need version-checked, actor-attributed revocation and
  reactivation evidence before an administrator can manage those grants live.
  The unseeded 0097 table alone does not establish governance.
- Submission/self-attestation is not independent approval. Require separate
  reviewer authority and enforce the agreed employee/owner approval boundary.
  Review must not automatically invoice, pay or create a PA login.
- Reviewer independence means a reviewer cannot review their own beneficiary
  record. A manager may have recorded an entry or adjustment on behalf of a
  different worker and still review it under a separately granted future
  reviewer authority; both identities remain durable and attributable.
- Resolve work context against native-authorized records and permanent mappings.
  Existing PA-projection helpers must not stand in for native scope checks.
  Native projects, operational jobs and assignments need an explicit authority
  contract before their IDs can authorize time capture.
- Bonuses/adjustments are separate audited financial inputs, not fabricated time
  entries. Keep fixed/hourly/mixed/no-automatic-compensation policy independent of
  role or business ownership. PA remains authoritative for compensation rules.
- Billing, compensation, work approval, invoice allocation and payment stay
  separate. Preserve fixed-fee jobs where logged time is informational, owner
  billable time with no automatic earnings, and batched multi-day invoicing.

## Cross-system acceptance

### September 14 native-job authority finding

The current time ledger's `job` context is descriptive only. Migration 0096
does not bind it to a canonical live job; migration 0097 defines no job grant
scope; the Worker command, HTTP parser and `/time` selector intentionally
accept only internal or native-project context. A form-only `job` option
would falsely imply authorization and must not be added.

Before job time capture, define a native job lifecycle and permanent scope
mapping, default-deny job grants with attributed issuance/revocation, and an
atomic D1 predicate that rechecks actor admission, beneficiary delegation,
live job status, applicable allow and deny precedence at commit. Add replay,
cross-division, transfer and revoked-grant tests. The focused existing
authority test passed 4/4; the longer combined time suite had not completed
at this checkpoint and is not reported as passing. No job route or grant was
enabled.

- Define generic PA workforce write/read capabilities, external-worker mappings
  independent of PA login, idempotency and revision behavior before delivery.
- Reconcile integer PA IDs with permanent Operations IDs through explicit
  instance-qualified mappings; never merge workers by email or assume matching
  IDs across the two PA instances.
- Test an assigned employee, an autonomous division manager, on-behalf entry,
  an independent reviewer, owner compensation policy changes, internal time,
  fixed/hourly/mixed billing, bonuses, corrections and replay after outages.
- Keep the PA owner review/deployment gate. This audit authorizes no production
  schema change, credential broadening, automatic pay or one-sided cutover.

## September 22 source-alignment checkpoint

The current branch now contains the record, beneficiary-submit and independent
review executors described below. This checkpoint supersedes only stale claims
that those Worker files were absent; all earlier release evidence, activation
gates and cross-system blockers above remain applicable.
Earlier September 14 manager-queue and UI passages are preserved as historical
evidence from another source checkpoint; no matching review-queue or time UI
source exists in this checked-out branch, so they are not current-source claims.

- `native-workforce-time-record.ts` atomically records revision one for
  `internal` or active canonical `native_project` context. It derives the actor
  from native Access admission and rechecks the exact admission version and
  bound subject, active beneficiary, scoped self/on-behalf allow with deny
  precedence, active project lifecycle and exact beneficiary-selection
  delegation in the D1 batch that creates the entry, revision, command and
  receipt.
- `native-workforce-time-transitions.ts` makes submission beneficiary-only
  attestation. An on-behalf recorder cannot submit for the beneficiary.
  Independent approve/return requires a different admitted reviewer and a
  current scoped `time.review` allow without an applicable deny. Owner or
  administrator status supplies no bypass. A returned revision remains
  immutable and cannot be resubmitted without a new correction revision.
- Record, submit and review use command-specific request hashes and immutable
  receipts. Current authority is checked before receipt or collision
  classification and again around disclosure. Mutation authorization is
  batch-atomic; replay reads are not one D1 transaction, so the final authority
  read is their disclosure linearization point and controlled interleaving QA
  remains an activation requirement. Ambiguous database outcomes without an
  exact recoverable receipt return retryable unknown rather than claiming
  rollback.
- The native boundary reserves only `GET /api/native-workforce/time-record/session`
  and `POST /api/native-workforce/time-record`, `/submit`, and `/review`. It is
  mounted before legacy staff authentication with exact origin, purpose-bound
  CSRF, bounded JSON and shared D1 rate limits. Checked-in
  `NATIVE_WORKFORCE_TIME_RECORD_ENABLED` remains `false` and its origin remains
  blank. No grant, selection, production flag, seed or deployment was added.
- The focused real-D1 and HTTP suites pass 19/19, including self/internal and
  native-project record, on-behalf selection, beneficiary-only submission,
  independent approve/return, scoped deny precedence, exact replay, collision,
  admission/grant/selection revocation and revoked mismatched-command denial.
  Operations TypeScript and production build pass. This is local source
  evidence only.

Still excluded: manager review queue/UI, correction revision authoring, native
job authority, bonuses, PA calls, payroll, billing, invoice, rate or payment
effects, governed production grant bootstrap, staging acceptance and live
activation.
