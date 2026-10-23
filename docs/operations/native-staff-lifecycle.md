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

Any failure rolls back every step. Protected staff, the protected owner ID and
global owners cannot be changed by this ordinary lifecycle path. Owner transfer
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
  exact `cohortSha256`, and observed `controlPlaneStaffIds`; binding evidence
  identifies `operations-native-staff-binding-review-v1`, the same cohort hash
  and operator identity. Directory-only maintenance approvals cannot authorize
  this handoff retroactively.

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
