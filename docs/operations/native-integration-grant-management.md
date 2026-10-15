# Native integration permission management

Status: implementation in progress. No production grants or administrator
bootstrap have been performed. This is part of the API-first migration, not a
replacement for its broader staff and customer authorization work.

Target discovery checkpoint: a native-only paginated reader and HTTP list route
pass sixteen focused HTTP/full-chain D1 cases (terminal session `36261`, 130.06
seconds), including root's authorization-gated row join and ascending-order
corrections. The client transport passes five cases (`6384a1`) for bounded,
forward-only pages, canonical cursors, inactive targets, denial and expiry.
The base selector is now locally mounted. Twelve desktop/mobile selector checks
pass (`309d5e`), including the actual built base route, URL cleanup, paging,
expiry, denial, duplicate display names and populated long-text layout. Root
inspected the populated mobile screenshot. Build (`cf8ca2`), root typecheck
(`76a7fb`) and the three reserved-namespace routing tests (`4f6b81`) also pass.
The initial screenshot-after-unmount check was insufficient and is superseded
by these populated-layout checks. This list requires
`integrations.grants.manage`, not a PA administrator role. No management grant is
created by discovering a target.

Latest editor acceptance: the isolated panel passed 16 desktop/mobile cases
(`fc0dc1`) plus six changed-case checks (`8b0d59`), including an active target at
the version limit and a late old-target receipt while a newer command is pending.
Root inspected the mobile screenshot. The application build passed (`84e056`),
and all six built-entrypoint desktop/mobile route cases passed (`e5bf9a`): exact
target loading, query/fragment cleanup, explicit load and denial with no legacy
PA fallback. This supersedes earlier pending local UI statements below. It does
not prove live native identity/bootstrap, full staff-directory navigation or
production grant readback. Those release requirements remain outstanding.

Latest joined checkpoint — September 13: the reader passes five full-chain
Miniflare D1 cases (terminal session `82877`) and eight unit cases. The tests
distinguish the manager's grants from the requested target's grants, cover
empty/inactive targets, and fence stale admission/profile/subject authority.
The browser transport and mounted Worker routing pass 16 tests across two
files (`d2f26f`); Operations type checking passes (`ef72a6`). The local route is
behind the existing default-off native control flag and never reads PA
connection configuration or falls back to PA authentication. Transport checks
cover exact target/receipt correlation, bounded replies, expiry and uncertain
write outcomes. These are local tests, not a deployed workflow: operator UI,
reviewed administrator bootstrap and live acceptance remain unfinished.

Editor route preparation: the exact staff-selector path is
`/administration/integration-permissions/<encoded-staff-id>`. The route builder
and parser pass three focused tests (`7a5d37`, approved local-only rerun after
esbuild's sandbox ancestor-directory failure). They reject aliases, malformed
encoding, traversal, extra segments and query/fragment material, and leave
existing public/onboarding/administration routes distinct. This parser is not
yet accepted end to end. The local application now mounts a lazy wrapper,
removes query/fragment data before rendering, and keys the editor by target
identity; the path is never authority. Root TypeScript passed (`a90b77`).
Three built-entrypoint browser cases were added for exact-target loading,
URL cleanup and denial without PA fallback, but have not run yet.

Independent editor review found an uncertain-save recovery defect: expiry or
a failed refresh discarded the exact command needed to recover a lost receipt.
The editor is being corrected to retain that command while clearing expired
authority and current permission data. Review also requires stale responses to
check their generation before mutating in-flight references. Do not accept the
panel until expiry-during-write, explicit same-ID retry, stale-response and
desktop/mobile behavior pass. No production activation occurred.

Latest executor checkpoint: the corrected 0092/executor suite passed all 16
full-chain real-D1 cases (September 13, 395 seconds). The additional
controlled stale-create, stale-update and zero-row-CAS cases prove that a
mutation changed by another writer cannot acquire this command's receipt or
leave an orphan command fence. The receipt guard aborts the D1 batch when its
immediately preceding grant mutation changed zero rows. Canonical finite
verification deadlines and the fresh-primary replay authority check are also
covered. This is local evidence only; no manager was bootstrapped or grant
seeded, and no production configuration was changed.

The exact HTTP/routing/read and browser-transport regressions were rerun after
the executor correction: six focused files passed 43/43 tests. Two additional
real-D1 read/target files passed 10/10 in 256 seconds. This checks the local
adapter, database reader and transport wiring, not a bootstrapped manager,
deployed Access identity, or production command execution.

Earlier executor checkpoint: the expanded 0092/executor suite passed all 14
full-chain real-D1 cases (`69156c`, exit 0). The added cases preserve the original
creator while auditing a different current manager, reject a profile-version
change between read and commit, and deny replay when management authority is
revoked after initial reads but before the final fresh-primary check. This
test-only follow-up changes no production code or authority. Read-service SQL,
HTTP, routing and browser acceptance remain separate requirements.

Earlier executor checkpoint: the corrected 0092/executor suite passed all 11
full-chain real-D1 cases (`a25139`, exit 0); TypeScript passed (`ec2b92`). The
transaction now checks the exact before-grant state, preventing another writer's
matching result from acquiring a false command receipt. Auth is validated before
I/O, version conflicts follow current actor/management validation, and replay's
final authorization query starts a fresh primary session. Tests cover late audit
rollback, lost acknowledgement, manager revoke/deny, actor/target deactivation
between reads and commit, malformed replay auth and unauthorized stale versions.
Different-creator provenance, a mid-request profile-version change and a final
replay-read revocation race are being added as separate coverage. These results
do not prove a routed API, administrator bootstrap or live acceptance.

Root independent policy expansion passed all 11 cases (`c26ee3`, exit 0).
Coverage now includes both supported capabilities with allow and deny effects,
creation/revocation identity preservation, inactive-target revocation, active
target reactivation, version overflow and mismatched actor admission/profile
witnesses. This is pure policy acceptance, not database authorization acceptance.
The atomic executor and migration 0092 are being implemented separately.

Direct D1 maintenance remains privileged: this implementation must protect the
application command path and persist immutable receipts, but does not claim
that a database administrator is subject to HTTP authorization. Existing
synthetic grant seeding remains explicit test setup, not runtime bootstrap.

Local policy review checkpoint: the corrected command planner and five focused
unit tests passed (`9a5a53`); TypeScript passed (`81f0f1`). Root found shared mutable test fixtures and an
unsupported subject-binding assertion: a management row keyed only by staff ID
cannot independently prove that a supplied Access subject matches the current
admission. Tests must use fresh fixtures and validate a real admission witness
or explicitly leave that binding check to atomic execution. A detached pure
plan must never be described as a committed or independently authorized grant.
The corrected input now includes a separate trusted actor admission/profile
snapshot and compares its subject, active state, versions and email to the
authenticated identity. Fixtures are detached per test. This remains advisory:
the executor must read those witnesses itself and recheck them at commit time.

## Authority boundaries

- `integrations.monitor.manage` controls the persisted monitor lifecycle.
- `integrations.alerts.reconcile` is reserved for reviewed uncertain-email
  recovery; it does not authorize monitor configuration or ordinary retries.
- A separate `integrations.grants.manage` authority administers those two grants.
  Neither PA ownership, legacy Operations integration management, nor ordinary
  native staff management implicitly provides this authority.
- Initial management authority requires an explicitly reviewed bootstrap tied
  to an independently verified native staff identity. Do not expand existing
  bootstrap-v1/v2 approvals, seed every owner, or expose bootstrap as a public API.
- Managing monitor/alert grants cannot create another grant administrator.
  Management-authority provisioning and recovery remain a separate ceremony.

## Command contract

- Accept only command ID, target native staff ID, one of the two supported
  capabilities, allow/deny effect, desired active state, expected grant version,
  and a bounded human-readable reason.
- Derive the actor and management witnesses server-side. Never accept authority
  witnesses, PA roles, a wildcard capability, or arbitrary SQL from the browser.
- New grants require expected version zero, no existing grant for that exact
  target/capability/effect, and active state true. Changes preserve grant identity
  and increment its version only for a real active-state change.
- Revocation is a versioned deactivation, not deletion. Revoking an existing
  grant must remain possible after the target's admission is disabled.
- Replay requires the same immutable command identity and payload, together with
  current actor authority. It must not recreate a grant or undo a later revocation.

## Database execution requirements

- Recheck the actor's exact subject, active admission, admission/profile versions,
  verified deadline, current dedicated allow version and absence of an active
  management deny in the same atomic operation as the mutation and receipt.
- Fence the target admission and current grant versions. A preflight pure
  policy result is not sufficient authorization at commit time.
- Persist immutable actor, target, management witness, reason, before/after
  version and request-hash evidence. Existing `granted_by` identifies original
  creation provenance; it cannot stand in for the current command's actor.
- On timeout or lost acknowledgement, report uncertainty. Read a currently
  authorized receipt/state before retrying; do not infer rollback from transport
  failure. Revocation of either admission or management authority must fence replay.
- No destructive migration, current public-link change, or automatic grant is
  part of implementing this path.

## Native HTTP and operator workflow

Implement a separate default-off native boundary before mounting it in the
Worker. Reuse native Access authentication, same-origin checks, bounded bodies,
rate limits and CSRF protections, but domain-separate grant-management CSRF
tokens from monitor-control tokens. There is no connection-registration form
and no browser-supplied PA configuration.

| Request | Purpose and authority |
| --- | --- |
| `GET /api/native-integrations/grants/session` | Establish the native session/CSRF envelope. A session is not a management grant. |
| `GET /api/native-integrations/grants/staff[?cursor=<encoded-staff-id>]` | List up to 25 native staff under dedicated management authority, including inactive targets. Only one canonical cursor is allowed; response contains staff ID, display name, active state and next cursor. |
| `GET /api/native-integrations/grants/staff/<encoded-staff-id>` | Read one exact native target and at most four monitor/reconciliation allow/deny rows under current dedicated management authority. |
| `POST /api/native-integrations/grants` | Submit the exact command contract above; the executor independently reads and checks authority. |

- Reject query strings, fragments, unsupported methods and unknown descendants;
  never fall through to legacy PA authentication. A target identifier is only
  a selector, not authority. No target names, emails, PA identities, credentials
  or arbitrary grant-management witnesses are returned in this bounded read.
- The target read uses one fresh primary snapshot covering current actor
  admission/profile, management allow/deny, target state and target grants.
  An inactive target remains readable by a manager so grants can be revoked.
- A missing allow/deny row means the create command expects version zero; it
  does not mean that capability is allowed. Effective access requires active
  target admission, an active allow and no active deny for that capability.
- Require explicit confirmation and a reason for mutations. Preserve an unknown
  command outcome for reviewed retry with the same command ID; do not silently
  submit a new command ID. Disable double submission while a request is pending.
- A replayed receipt describes the historical command outcome, even if a later
  command revoked it. Reload the target's current permissions after every
  successful or replayed mutation before showing effective access.
- Bootstrap and management-authority recovery are not available through these
  endpoints. The administrator must already hold separately reviewed authority.

Read service, HTTP adapter, local Worker routing and browser transport are now
implemented and tested as recorded above. Browser controls, bootstrap and live
acceptance remain separate pending steps.

HTTP checkpoint: the unmounted adapter passes all 10 mocked boundary tests
(`24917b`, approved local-only run) and Operations TypeScript (`600482`). These
cover exact methods/encoded selectors, same-origin/native authentication, rate
limits, purpose-separated CSRF, strict bounded command fields, sanitized typed
outcomes, dependency snapshotting and expiry after a committed executor result
being reported as unknown rather than falsely denied/rolled back. Reader tests
that return a mocked `authorized` value do not establish database authorization;
the separate full-chain D1 reader suite subsequently passed as recorded above.

## Acceptance still required

### Executor review gates — September 13

The first executor and migration 0092 are present locally, but are not yet
accepted for routing or production activation. Independent source review found
the following conditions that the implementation and real-D1 tests must resolve:

- Validate the complete detached native identity and a finite, canonical future
  deadline before database access, including receipt replay. An invalid date
  must not pass merely because `NaN <= now` evaluates to false.
- Read replay authority and its receipt in one consistent database snapshot.
  A previously committed receipt is evidence of history, not permission to
  disclose it after the caller loses current authority.
- Check the exact grant's **before** version/state inside the write transaction.
  A receipt that only checks the desired **after** state is insufficient: another
  request might already have produced that result, leaving this request's update
  with zero affected rows. Such a request must not acquire a successful receipt
  attributing the other request's mutation to itself.
- Treat a zero-row grant CAS as an unknown outcome, never a successful command:
  desired after-state equality alone is not evidence that this command made the
  change. The receipt trigger aborts that D1 batch (including its fence) when
  SQLite's immediately preceding grant mutation changed anything other than one
  row. The executor also validates its deadline as finite canonical UTC at
  every authorization-sensitive read.
- Exercise admission, target and management-authority changes between preflight
  reads and batch execution, not only changes made before calling the executor.
- Return a version conflict for a currently authorized stale command, while
  preserving denial for callers without authority and an unknown outcome when
  transport failure prevents proving what committed. Do not classify errors by
  matching database error strings.

The executor agent owns these corrections and its focused tests. No route,
management bootstrap, production grant or deployment is authorized by this
review checkpoint. Successful replay returns the historical command result;
callers must separately reload current effective access before displaying it.

- Pure policy tests: exact shapes, detached snapshots, unsupported authority,
  explicit deny, expiry, create/update version checks and inactive-target revoke.
- Real-D1 tests: actor/target/grant changes between preflight and commit, late
  audit failure rollback, duplicate commands, lost acknowledgement and revocation
  before replay. Load the complete migration chain.
- Native HTTP and browser tests: explicit confirmation, no legacy-auth fallback,
  no browser-supplied authority and clear effective-access/denial display.
- Reviewed bootstrap, production permission readback and operator acceptance
  before enabling the monitor control or uncertain-email recovery workflows.
