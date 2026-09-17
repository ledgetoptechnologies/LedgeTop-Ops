# API-v2 connection incidents and owner alerts

Status: local implementation and automated verification complete; not enabled
in production.

Latest release evidence: the focused native-control suite passed all 43 tests,
the real-D1 durability suites passed all 27 tests, the production build and
TypeScript checks passed, and an independent security review closed all 23
changed runtime files with no findings. The deployment switches, native-control
origin, recipient, and permission grant remain unset/default-off. Live
failure/recovery, physical-mail, and ambiguous-delivery reconciliation remain
activation gates rather than merge gates.

Administration wiring: the authenticated native worker control/read routes are
implemented and tested, but no Administration panel or navigation entry is
mounted in this release. The monitor therefore cannot be activated through the
ordinary Operations UI. That is intentional for this default-off foundation:
grant administration, an operator reconciliation surface, and live acceptance
must be completed before activation. No deployment occurred.

Latest acceptance: the scheduler-selection and native-control suites include
positive probes, exact stale-pin conflicts, unchanged retired heads, mixed
enabled/disabled connection configurations, authorization/revocation fences,
and post-await session-expiry checks. Scheduler configuration is captured once
before the first await and reused for selection and cycle execution. The release
evidence above supersedes older chronological implementation notes below where
they describe these automated checks as pending; it does not imply UI or live
production acceptance.

Root transport review also identified the server's two-field apply receipt,
same-revision no-op success, response-body deadline coverage, and expiry after
POST dispatch as required regressions. Those corrections are in progress in
the dedicated client transport; expiry or a broken response after dispatch must
not be presented as proof that the mutation did not commit.

Open operator-workflow gap: `index.ts` currently obtains each scheduled cycle's
expected lifecycle revision from `PROJECT_ALPHA_API_V2_MONITOR_REVISION`. A
successful native control mutation advances the database revision but does not
change that deployment variable. Consequently an ordinary disable/re-enable
can leave scheduled checks fenced out until deployment configuration changes.
Do not present a successful control save as proof that scheduled checks are
running. Before operator UI acceptance, replace this manual revision dependency
with an authorized, attributed current-head selection matched to the complete
deployment-owned identity set, preserving the deployment kill switch and all
per-operation revision fences. The cycle must not create authority or adopt
unattributed heads automatically. Implementation and race tests remain pending.

Grant setup audit: migration 0091's `granted_by` foreign key and history triggers
record a grant's provenance but are not an authenticated grant-management API.
Existing native staff management and bootstrap-v2 commands do not cover these
integration capabilities. Add a separate explicitly authorized grant-management
path with current identity/admission and deny checks, immutable command audit,
and versioned revocation. Establish its initial administrator through a reviewed
bootstrap ceremony; neither PA ownership nor ordinary staff management implies
this authority. No bootstrap or production grant was performed by this audit.

Latest route checkpoint: the reserved `/api/native-integrations/monitor` namespace
is now mounted before legacy PA-dependent staff authentication. Exact supported
routes delegate to the native handler; unsupported methods/descendants return
404 without falling through. Dedicated control enablement remains `false` and
its origin remains blank in the checked-in configuration. Generated binding
types and the agent's TypeScript check passed. The agent's focused routing/HTTP
run passed 15 cases; routing assertions use a mocked handler, while the HTTP
suite separately exercises the real disabled handler.

Root added `NATIVE_INTEGRATION_CONTROL_ENABLED` to the dormant mutation gates
for every existing portal release profile. All 20 Node profile tests passed
(`592ed0`, exit 0), including omitted, malformed and enabled values. This is a
release-intent guard, not proof of deployed configuration. Explicit grant setup,
operator UI/readback recovery, uncertain-mail reconciliation and production
acceptance remain unfinished. Earlier statements below that mounting is pending
describe historical checkpoints and are superseded by this local mount only.

Readback acceptance: all 19 cases across the real local D1 readback and mocked
HTTP suites passed (`30742e`, exit 0). The unmounted handler includes
`GET /api/native-integrations/monitor/state`, guarded by native authentication,
same-origin/custom-header checks and rate limiting. It returns only revision,
enabled state and explicit attribution status; the database read enforces the
current native monitor grant/deny boundary in one primary snapshot. Unavailable
reads do not return a default-disabled state. The deny and allow-revocation
tests are independent, and reads do not create lifecycle/audit changes.
Root TypeScript passed (`135ba2`). Disabled-by-default application mounting,
explicit grant setup, operator UI/recovery and live acceptance remain pending.

Native HTTP handler checkpoint: the unmounted handler now accepts a native
session/CSRF flow and exact expected-revision/enabled command, captures the
server connection configuration before awaits, and returns no connection data.
All eight mocked HTTP tests passed (`8a4d31`), after correcting a test that
compared expiry against a newly generated timestamp (`feb359`, 7/8).
Root review found that the store mapped all D1 failures to authorization denial.
It now uses typed confirmed-denial and unknown-outcome errors, while preserving
the typed lifecycle conflict. HTTP classification no longer matches message text;
all nine updated mocked cases passed (`f295e2`), including lookalike messages.
The frozen eleven-case real local D1 suite passed (`b382c1`, session 11349,
exit 0), verifying commit-then-lost-ack behavior and retained rollback protections.
The committed head/audit survive acknowledgement loss; the old revision
conflicts and an authorized current-revision no-op creates no duplicate audit.
These tests exercise the real local store with an injected transport failure,
not production network behavior. Do not infer
rollback from a 503 or retry using a guessed revision: authorized readback and
operator recovery wiring remain necessary before mounting.
No route/config mount, grant issuance, or production enablement occurred.

September 13 native-control acceptance: all nine real local D1 tests passed
(`0bd548`, session 3240, exit 0), loading the complete Operations migration
chain through 0091. Coverage includes no automatically seeded authority,
explicit deny, stale identity/session rejection, revoke-and-regrant fencing,
current authorization on unchanged-settings requests, attributed takeover,
and rollback of lifecycle, incident retirement and audit after a late failure.
This verifies the store, not an authenticated HTTP route, grant administration,
Wrangler migration discovery, or production activation. Those remain pending.

Independent review after this run identified a stronger schema invariant still
needed: the writer's batch requires the audit, but a separate internal SQL
update could supply a fresh command ID without its audit row. A deferred
head-to-audit reference and direct-write regression have now been added to
unreleased migration 0091. It also rejects reuse of an older audited command.
The nine-case run `770997` overlapped the final edit and is provisional. The
frozen rerun passed all ten cases (`138dd7`, session 35949, exit 0), including
rejection of a fresh unpaired command and reuse of an older audited command.
The legitimate two-statement lifecycle/audit batch still commits successfully.
The future HTTP route must also use the existing server-configuration
command builder; the store's identity arguments are not browser input.

Latest transport verification: the timeout race described below is corrected.
All 38 mocked SMTP/dispatcher/cycle/scheduler cases passed (`19def4`), with no
unhandled test errors. SMTP now has a cumulative 45-second deadline, a maximum
20-second wait per operation, and bounded server replies; timeout closes the
socket while preserving the timeout result. After payload writing starts, an
unknown transport outcome is not a definite rejection. The outage dispatcher
retains that attempted claim for reconciliation instead of automatic resend.
This does not establish exactly-once delivery or alter the retry policies of
other existing mail callers. Binding delivery still has no proven cancellation.
The operator reconciliation/control workflow and live acceptance remain needed.

September 13 uncertain-outcome acceptance: all 10 real local D1 alert-store
tests passed (`818cc3`). A current attempted lease cannot be automatically
reclaimed; its expired state reports `reconciliation_required`. An unattempted
fresh claim remains reclaimable even after an older recorded failure increased
the cumulative attempt count. Late acceptance can settle only its exact claim.
The joined mocked run passed dispatcher, cycle and scheduler suites, but its
SMTP cumulative-deadline test exposed a timeout-versus-close race (`065760`,
37/38 cases passed). The 38-case result above supersedes that failed run;
the remaining operator workflow still prevents release readiness. Root TypeScript passed
(`bce19f`). These tests did not contact PA or send real email.

Latest verification: the full-chain local D1 run passed five files / 25 tests
(`bf008b`, session 91313), covering lifecycle, observations, alert transitions,
and joined health/dispatch. The portal release profile explicitly requires the
monitor disabled (16 Node tests, independently verified `3a5ad4`). No live mail,
production migration or activation is implied. Unknown delivery outcomes and
SMTP cumulative transport bounds are being addressed before activation;
an authorized lifecycle control action with operator attribution is still needed.

## User-visible contract

- Native Operations remains usable during a PA outage, including after ten
  minutes. Ten minutes is the owner-alert threshold, not a shutdown deadline.
- Each configured PA instance has independent health. A successful LTDS probe
  must never clear LTT's incident, or vice versa.
- A continuous unhealthy interval strictly greater than 600,000 milliseconds
  makes an owner alert eligible. Scheduled execution determines the actual send
  time; this is not a guarantee of email arrival at the exact threshold.
- Transport failures, rejected credentials, incompatible contracts and rate
  limits have distinct labels. Changing between them does not reset the interval.
- Only a verified, correctly pinned response confirms recovery. Intentional
  disabling suppresses pending alerts but must not be presented as recovery.
- Cached financial information includes its last verified time. An expired
  entitlement must not be extended merely because PA cannot be reached.

## Native operator control boundary

- Use the native Operations Access session and current admission version, not
  PA accounts, legacy role assignments, an email match, or an implied owner role.
- Require explicit global `integrations.monitor.manage` for a lifecycle change.
  Reserve `integrations.alerts.reconcile` for a separately audited uncertain-send
  decision. A deny overrides an allow; neither capability is automatically
  granted by a migration or by enabling monitoring.
- Keep PA connections configured in server-side secrets. The eventual control
  action accepts only an expected revision and enabled state, not credentials
  or browser-selected source identities. Freeze configuration before awaits.
- Recheck the admitted subject, admission version, session deadline and current
  grants in the same transaction as lifecycle CAS and immutable operator audit.
  A failed permission check or audit insertion must roll back the whole change.
- Keep the existing last-staff-control-plane invariant unchanged. Initial
  integration grants require explicit reviewed bootstrap/maintenance authority;
  a general staff-management grant must not silently gain this capability.
- Preserve identical idempotent lifecycle requests without another revision,
  but still require current authorization. An old authenticated request must not
  regain access after revocation and re-enablement.
- Reconciliation is not a blind resend button. A still-running or unknown
  provider operation must not be marked failed merely to release its claim.
  Evidence and the exact incident/claim must be recorded before settling it.

Implementation status: the native monitor-control route, attributed store,
policy, lifecycle command, and readback have passed their focused local tests,
including real-D1 coverage. No grant issuance or production activation is yet
accepted; the route remains inert while its deployment switch and origin are
unset. The low-level lifecycle primitive alone is not an authorized public
control action.

## Durable implementation requirements

- Pin the complete non-secret connection identity: local source ID, application
  ID, HTTPS origin, expected PA instance ID and expected history epoch. Never
  persist API keys or Access secrets in incident records, emails or diagnostics.
- Probe configured connections even when their command queues are empty. A
  directory dispatch count of zero is not evidence of healthy connectivity.
- Order observations by probe start/generation, not response completion. A slow
  old success cannot close an incident created by a newer observation.
- Persist state with optimistic revision checks. Atomically record an eligible
  incident's notification intent under a unique incident key. Overlapping cron
  invocations must not create separate logical owner alerts.
- Keep claim, attempt, transport acceptance and final acknowledgement distinct.
  Use lease-token fencing and bounded retry/backoff. Missing mail configuration
  or a thrown send must not be recorded as sent.
- Recheck current connection configuration, incident generation and eligibility
  before sending. Recovery or deliberate disablement cancels pending alerts.
  A mail already accepted by the provider cannot be recalled by a local update.
- Use the existing failure-reporting notification mailer, not `sendAdminAlert`,
  whose current interface silently skips missing configuration and swallows
  failures. Select the owner recipient from explicit deployment configuration or
  verified native owner policy; do not infer it from a PA contact or arbitrary
  client input.
- A stable SMTP Message-ID helps correlate retries but does not guarantee
  exactly-once delivery. Provider acceptance followed by a lost local receipt is
  an ambiguous outcome; do not promise physical-email deduplication without a
  provider-supported idempotency contract.
- Preserve queued writes and their original command identities throughout the
  outage. The incident monitor never grants write authority or manufactures an
  acknowledgement for an uncertain PA commit.

## Acceptance gates

- Synthetic clock tests: 9:59.999, exactly 10:00, and 10:00.001; failure-category
  changes; recovery and a new incident; stale responses; disabled/re-enabled
  connections; independent instances and changed pinned identities.
- Database tests: concurrent observers, revision conflicts, restart persistence,
  one notification intent per incident, recovery/claim races and lease fencing.
- Mail tests: missing configuration, transient rejection, ambiguous acceptance,
  retry and cancellation; sanitized content with no client data or credentials.
- Scheduler tests: empty queues still probed, bounded work and failures isolated
  per instance, and native writes retained while PA remains unhealthy.
- Owner-approved live acceptance: controlled per-instance failure, owner email,
  recovery, and native Operations usability. Do not disconnect production merely
  to satisfy a test without a separately agreed maintenance window.

## Current evidence

- Activation blocker from the transport-budget review: SMTP currently applies
  its 20-second timeout per read/write, not across the complete send, and the
  email binding has no proven cancellation. An attempted send may therefore
  remain live beyond the alert store's 60-second lease plus 30-second reclaim
  delay. Do not enable automatic reclaim of an ambiguous attempted claim.
  Distinguish it explicitly as requiring reconciliation; retain automatic
  reclaim for a claim that crashed before its own attempt, and ordinary retry
  after a recorded send failure. Use the current claim's `alertAttemptedAt`,
  not cumulative `attempt_count`, to distinguish these cases. Cumulative SMTP
  deadlines and bounded response bytes/lines are also pending. A Promise.race
  timeout alone is not proof that a provider cancelled or rejected a message.
  Current database tests are frozen while running and do not resolve this gap.

- Atomic retirement migration 0090 passed all four real local-D1 cases
  (`ee749a`): disable/re-enable starts a new interval and invalidates old claims,
  unchanged sources retain their outage interval, history failure rolls back
  lifecycle and incident changes together, and initial enrollment retires a
  matching preexisting incident. The first full-chain attempt failed because
  bundled D1 rejected an UPDATE target alias accepted by Node SQLite (`adc59b`).
  The failing combined run was stopped; fully qualified references replaced
  the aliases without removing checks. The focused D1 rerun proves that fix;
  the other database suites still require their integrated rerun.
- The actual Worker scheduled-handler boundary and mocked composition suites
  passed 35 tests (`98451b`). A distinct five-minute cron is registered in local
  configuration, with monitoring false and revision/recipient blank by default.
  Disabled execution touches no bindings; enabled execution requires a strict
  positive pinned revision and explicit owner mailbox, awaits its own cycle,
  and sanitizes errors. Generated bindings were refreshed using Wrangler
  (`1fca11`), and TypeScript passed (`ee247f`). No deployment or remote cron
  change occurred. Explicit authorized lifecycle setup and physical-email/live
  acceptance remain required before enabling the feature.

- The bounded monitor-cycle composition now joins health checks and eligible
  owner alerts while retaining an explicitly pinned monitor revision; it never
  creates or upgrades lifecycle authority. Disabled invocation performs no I/O,
  malformed connection configuration fails before effects, and one dispatch
  failure does not suppress another connection. Only sanitized outcome counts
  cross this boundary. Four integrated mocked files passed 28 tests (`454538`),
  and root TypeScript passed (`36c67c`). This includes the post-final-async-check
  lease regression and new health-store revision input; the full D1 rerun after
  these fences and retirement migration is still pending. No cron registered.

- The explicit monitor lifecycle store (0089) passed seven real local D1 tests
  (`cb074f`, exit 0), covering inactive defaults, canonical/idempotent identity
  sets, competing CAS transitions, disable/re-enable with stale revisions,
  removed pins, credential/accessor/conflicting-identity rejection, atomic
  history rollback, and fail-closed reads of malformed persisted state. Root
  corrected initial TypeScript narrowing errors before this test run. This
  store never automatically adopts whichever deployment environment calls last.
- Observation and alert claim/attempt SQL fences are being integrated with this
  explicit revision. Their combined regression remains pending. Retiring old
  incident intervals on configuration transitions, same-millisecond ordering,
  the authorized lifecycle control entry point and scheduler registration remain
  launch gates. A successful lifecycle-store test does not prove those callers
  use it, and no production monitoring state was created.

- The isolated dispatcher and existing SMTP acceptance path passed 16 tests
  across three files from frozen source (`4dd565`, exit 0); root TypeScript
  passed (`3160dc`). Coverage includes missing recipient/configuration,
  recovery and final-read configuration changes, lease expiry before sending,
  preparation errors versus mail errors, bounded acknowledgement contention,
  and a committed SENT whose receipt was lost. The joined real-D1 test proves
  that an accepted slow send can be acknowledged after lease expiry, despite a
  concurrent observation advancing the head, without sending twice. It also
  proves subsequent dispatch sees the persisted sent state and sends nothing.
  Mail is mocked; the fixture freezes the store baseline through 0088 and is
  not evidence of monitoring lifecycle/scheduler or physical-mail acceptance.
- Independent review identified the post-acceptance lease distinction: expiry
  forbids starting another send, while the exact unchanged claim may still
  acknowledge a send already accepted. The durable token/claim check, not the
  earlier pre-send deadline, controls that acknowledgement. A provisional
  11-case run overlapped this correction and is superseded by the frozen rerun.

- The existing SMTP transport now treats final DATA `250` as acceptance, without
  letting a failed QUIT/cleanup turn that accepted message into a failed send.
  Three mocked-socket tests passed (`c30b31`): acceptance with rejected cleanup,
  final DATA rejection, and authentication rejection. TypeScript passed
  (`dd49dd`). This fixes a known false-failure retry path; it does not eliminate
  provider-acceptance/lost-receipt ambiguity or prove physical delivery.
- Lifecycle review found that removed/replaced identities also need retirement.
  Before scheduled activation, persist a bounded non-secret configured identity
  set and lifecycle fence; assert that fence in observation and send-attempt CAS.
  Its revision must come from an explicit authorized configuration transition,
  not whichever Worker invocation last observes its own deployment environment.
  Otherwise an old invocation could reinstall stale configuration. Retire only
  the previously configured identities, preserve immutable history, and ensure
  disable/re-enable ordering works even within the same clock millisecond.

- September 13 joined verification passed all 39 tests across six files
  (`7b0788`, session 2713, exit 0). This includes both real local D1 stores,
  the real readiness parser joined to D1 through synthetic HTTP responses,
  and the pure policy/parser/orchestration cases. Migration 0088 now enforces
  durable alert leases, delayed retries, expired pre-attempt claim recovery,
  exact claim fencing, one logical intent per incident, and atomic rollback
  if the final event assertion fails. All 88 migrations also loaded in empty
  Node SQLite with no foreign-key violations (`829630`).
- The joined readiness test preserves independent source states through failure,
  the strict ten-minute threshold and recovery without creating directory
  commands. These tests send no real email and contact no live PA instance.
- Mail dispatch and scheduler registration are still unfinished. In particular,
  the current disabled health-cycle branch performs no I/O: it suppresses that
  invocation but does not durably reset earlier incidents. Explicit lifecycle
  fencing for disable/re-enable and configuration replacement is required before
  enabling scheduled alerts. Historical leased rows cannot send after a recorded
  recovery/disabled observation, but that is not proof the scheduler records one.
- Earlier checkpoints below describe implementation order; their statements
  that 0088 lease enforcement is pending are superseded by the 39-test result.

- Source audit found existing `integration-health.ts` uses 26-hour legacy
  snapshot freshness. It is not this incident monitor.
- The API-v2 probe classifies bounded attempts; its caller must implement durable
  incident tracking. Existing directory outbox/checkpoint logic is reusable for
  command reliability, not as proof that outage notification already works.
- Sol implemented `project-alpha-api-v2-incident-policy.ts` and eight focused
  tests. Root reviewed complete identity pinning, continuous unhealthy duration,
  separate probe/action ordering, incident/claim sequence fencing, and same-ms
  actions. TypeScript passed (`8461e6`). The first permitted pure-test run found
  a missing callback wrapper in a throws assertion (`baa046`, 7/8 passed); root
  corrected the test and all eight passed (`f7c073`). Normal sandbox config
  loading had failed before running tests; the approved rerun was pure local
  unit testing, with no D1, live PA or email calls.
- Root added exact stored-state validation with identity/type/timestamp/lifecycle
  invariants and rejection of extra fields or accessors. Policy plus parser
  tests passed 20 cases (`17aa12`); Operations TypeScript passed (`60d214`). A
  subsequent parser hardening replaced category coercion with a strict string
  check. The later combined run below includes that hardening.
- Migration 0087 and the observation CAS store are implemented locally. The full
  87-migration chain loaded into in-memory Node SQLite with zero foreign-key
  violations (`079347`). The real local D1 suite plus policy/parser tests then
  passed all 25 cases (`c608ea`, five database cases). It exercised concurrent
  first writes, stale revision rejection, fresh-session reads, separate complete
  connection identities, immutable history, rollback when the history trigger
  fails, unknown-probe rejection and malformed persisted-state rejection.
  Operations TypeScript passed (`657b19`). No production migration was applied.
- Root review changed commit confirmation to conditional `RETURNING`, avoiding
  trigger row-count ambiguity and a false failure from a newer post-write read.
  Database errors remain sanitized. SQL pins JSON identity/timestamp to columns;
  future alert-state updates can preserve probe time while advancing revision.
- Lease expiry/reclaim, mail dispatch and scheduler wiring remain pending;
  no live acceptance claim. The in-memory
  claim sequence is not by itself a database lease or a provider idempotency key.
- Root added an isolated health-cycle composition: deployment-only enable flag,
  bounded two-at-a-time directory readiness probes across the configured list,
  no dependence on queued writes, independent-source error handling, and one
  CAS retry retaining the original probe-start timestamp. Six mocked composition
  cases plus policy/parser tests passed 27 cases (`9917f3`); TypeScript passed
  (`c53e37`). This has not been mounted on a cron or tested against live PA.
- A pure `reclaim` transition now fences the previous claim sequence and resets
  the attempt marker without inventing a failed send. The durable alert store
  must check actual lease expiry/backoff before using it; its implementation and
  database tests remain pending. The observation store test now requires 0087
  to be present rather than newest, so later migrations remain in its fixture.
