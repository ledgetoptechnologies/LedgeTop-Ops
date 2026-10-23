# Operations-owned staff lifecycle

This implementation separates Operations people from Project Alpha people.
Project Alpha user and entitlement deliveries are historical business references;
they cannot admit, disable or grant roles to Operations staff. Client profile
synchronization is separate and remains available.

**Production cutover remains blocked until a real reviewed identity/cohort
handoff exists.** Source tests and synthetic fixture approvals are not that
handoff. Migration 0225 initializes its readiness control disabled. No HTTP route
can install a bootstrap approval, bind an identity, grant management authority,
enable the readiness control or create an employee. The release gate must refuse
this new source while its actual supported management path is unready.

## Existing staff management API

Before this cutover, follow the [manual offboarding procedure](manual-staff-offboarding.md).
It covers exact local status denial, managed group removal, session revocation
and verification. PA changes do not perform those Operations steps.

`/api/native-staff` terminates before ordinary legacy staff middleware, and uses
verified human Access assertions plus exact native staff admission. Its supported
routes are:

- `GET /api/native-staff/session`: actor/version-bound CSRF token.
- `GET /api/native-staff/:staffId`: profile and current versions, requiring the
  scoped `staff.profile.read` delegation.
- `POST /api/native-staff/:staffId/profile`: `commandId`, `expectedVersion`,
  `reason`, `displayName`.
- `POST /api/native-staff/:staffId/disable` or `/enable`: `commandId`,
  `expectedVersion`, `reason`.

GETs require `X-Native-Staff-Request: 1`. Every route requires same-origin fetch
metadata; POSTs require the exact configured Origin, JSON and `X-CSRF-Token`.
There is no credentialed cross-origin surface. Staff IDs are exact server IDs;
the route never searches or binds a person by email. Commands require explicit
native management delegations with applicable denies taking precedence. Old
global owner/admin roles do not supply these delegations.

## Joined compatibility transaction

`executeOperationsStaffLifecycleCommand` composes the existing 0069 native
fenced command with 0225's additional bridge fence in one D1 batch:

1. Check enabled cutover, current authenticated actor admission/profile versions
   and unexpired verification, exact current legacy/native identity, and the
   target's reviewed subject/email/status bridge.
2. Apply existing scoped delegation and deny rules, expected target version,
   native mutation, and the corresponding legacy status/display mutation.
3. Persist the immutable command receipt and, for admission transitions, an
   immutable unique-command Access reconciliation event with a new generation.
4. Require completed bridge mutation, durable event and a surviving **usable**
   complete native control plane, then consume the additional fence.

Any failure rolls back every step. The protected owner ID and global owners
cannot be changed by this ordinary lifecycle path. `sync_protected` prevents PA
synchronization from modifying staff; it does not prevent authorized Operations
lifecycle commands. Normal native onboarding sets that flag, and lifecycle
commands preserve it. Explicit native denies still apply. Owner transfer
and identity recovery remain separately reviewed maintenance procedures. The
legacy native-only helper remains for historical isolated service tests; HTTP
management uses only the joined entrypoint.

Disable makes both native admission inactive and `staff_users.status` inactive.
Ordinary Operations and Viewer renewal now read staff admission from the primary
and require the exact active native admission once cutover is enabled;
an already-issued Access JWT cannot override the inactive status on a new
request. Windows employee and machine-principal checks additionally require the
native admission version. Re-enable advances that version again; old root grants
and machine principals do not revive. Historical rows, PA reference IDs, exact
subject binding and prior receipts remain unchanged. This is request admission,
not a promise to recall response bytes already delivered before revocation.

## Access group and release readiness

The existing Ops Sync cron reconciles only the exact joined native cohort after
0225 readiness is enabled. It never consults PA user entitlements. Lifecycle
generation and lease checks fence local outcomes; a remote Cloudflare request
cannot participate in the D1 transaction. Unknown acknowledgments stay pending,
and periodic readback converges stale remote writes. Local denial remains
authoritative even while a previously issued Access cookie or group is stale.
See `apps/ops-sync/NATIVE_STAFF_ACCESS.md` for scheduler details.

`scripts/native-staff-cutover-readiness.mjs` is a separate bounded read-only
Wrangler/D1 observer, not the production metadata API reader. It executes one
finite SELECT snapshot and produces only a count/hash receipt. It requires:

- Exact production account/database and candidate source commit.
- An externally reviewed private cohort packet matching every active legacy or
  existing native staff row, versions, names and exact subject/email bindings.
- Enabled cutover, no bridge mismatch, a usable complete native control plane,
  no lease/error, matching applied generation and successful group readback
  within 60 seconds.
- Existing unrevoked durable bootstrap approval/receipt evidence whose original
  plan and independent binding evidence hashes match the reviewed references.
  The plan must explicitly identify `operations-native-staff-cutover-v1`, its
  original handoff `cohortSha256`, and original approved `controlPlaneStaffIds`; binding evidence
  identifies `operations-native-staff-binding-review-v1`, the same cohort hash
  and operator identity. Directory-only maintenance approvals cannot authorize
  this handoff retroactively.

### Historical handoff and current release state

The private review packet uses `schemaVersion: 3`. It separates
`handoff: { cohort, controlPlaneStaffIds }`, the immutable originally approved
snapshot, from `cohort`, the exact freshly reviewed current release snapshot,
and top-level `controlPlaneStaffIds`, the exact freshly reviewed current
administrator/control-plane set. Both sets are required independently: a change
to the current set requires a new review even with unchanged cohort and
reconciliation generation. Its IDs must be unique active current cohort members;
ordering does not change the canonical set.
Both cohorts contain staff ID, email, bound subject, display name, activity and
admission/profile versions. The bootstrap plan and binding-evidence hashes bind
the **handoff** cohort. Its operator must have been active and listed in that
original approved control plane. They need not remain active forever.

The fresh database state must still match the current reviewed cohort exactly,
including current versions, and have a currently usable control plane. An
authorized display-name edit, disable/re-enable, or reviewed administrator
succession therefore requires an updated release review, not another privileged
bootstrap. Removing an old handoff identity or changing its email/subject is
refused. Current versions cannot precede their original handoff versions.

`onboardingReceipts` lists explicit `{ commandId, resultSha256, createCommandId,
createResultSha256 }` references for staff added after handoff. Each new binding
must match immutable authorized `staff.onboarding.create` and
`staff.onboarding.approve` command results joined to the terminal approved
onboarding record. The reader verifies result/proposal hashes, exact proposed
staff ID, created email, claimed subject, command/actor/version linkage and
execution ordering. A pending row, current administrator role, matching email,
or a caller's approval boolean does not establish this provenance. The command
tables' existing authorization triggers establish authority at execution;
current permissions are not retrospectively substituted for that authority.

The observer reads these proofs in the same fixed bounded primary snapshot.
There are at most 1,024 cohort/onboarding rows and 128 bootstrap references;
over-capacity, absent, ambiguous or inconsistent evidence refuses. This does not
implement staff onboarding, identity recovery, retrospective grant validation or
a new approval writer. An existing binding change remains unsupported and
requires a separately designed reviewed recovery proof. It is not silently
accepted by updating the current cohort packet. The public readiness receipt
uses schema version 2, adding `controlPlaneSha256` over the canonical current
control-plane set, and exposes only source/target, hashes, count and
generation; no identities or command bodies are emitted.

The earlier source contract compared immutable handoff hashes to the mutable
current cohort and required the original operator to stay active. That would
have blocked later releases after ordinary authorized staff changes. Continuity
regressions now explicitly cover profile edits, admission-version advances,
onboarding with durable provenance, and retirement of the original operator.
Tests of synthetic proof data do not establish that any real handoff or new
staff approval has occurred.

The observer cannot install or execute that reviewed maintenance handoff. A
private JSON packet or a boolean alone creates no authorization. Normal builds
must not bypass the production deployment gate; root release tooling owns its
before-upload and before-activation integration. Readiness observation is not a
database lock or authority to mutate identity records during a release.

Standalone read-only invocation is `node scripts/native-staff-cutover-readiness.mjs
--read-only --review PRIVATE_REVIEW_PACKET --source EXACT_COMMIT`. It requires a
conventional environment API token and exact account, rejects TLS/proxy/Node
overrides, disables Wrangler disk logs/metrics and never opens interactive login
or reads a credential file. No real packet, token or staff inventory is committed.

## Local qualification

The joined D1 suite uses the full source migration chain, synthetic reviewed
identities and locally signed RS256 JWTs. It covers default-off behavior, exact
origin/CSRF/human authentication, native and legacy request denial, old Windows
grant invalidation across re-enable, immutable replay, concurrent commands,
stale actor/target versions, bridge mismatch, protected owners, explicit denies,
last usable control-plane preservation, and complete rollback after a late
outbox failure. A separate pure readiness suite checks drift/refusal and its
one-SELECT adapter without production credentials. These are local evidence;
they do not prove a production identity transfer, live Access group change or
Windows installer activation.
