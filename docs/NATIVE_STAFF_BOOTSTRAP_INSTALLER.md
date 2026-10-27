# Native staff bootstrap installer core

This module is a source-only out-of-band installer for the bootstrap described
by migration 0060. It has no Worker route, Wrangler binding, production target,
credential loader, or command-line entry point. The current production
readiness tool remains read-only.

`prepareNativeStaffBootstrapD1` accepts only already-existing canonical
plan and identity-binding evidence, a separately supplied approval envelope,
and a reviewed schema/cohort/control-plane/permission snapshot. It requires a
separately injected `verifyTrust` function. A caller-provided boolean, email,
role, or ordinary Worker credential cannot satisfy that requirement. This
repository does not yet define or provide the independent root-signature
format/verifier or an actual owner-accepted bootstrap artifact; therefore this
prototype cannot produce an executable production approval.
The prepared artifact is deep-frozen and tied to a private in-process compiled
record. Execution reparses the exact canonical plan, rechecks its digest and
review bindings, and derives every write and durable-row check from that fresh
parse; a copied or mutated prepared object is rejected before any write.

`executeNativeStaffBootstrapD1` is the concrete D1 management adapter. It
submits bounded schema, migration-ledger, full cohort, Ops ACL, and existing
native-authority equality guards before the first write in one atomic
`D1Database.batch()`. A mismatch deliberately raises a SQLite constraint or
JSON error so the batch rolls back. Each allowlisted native insert is gated on
the newly created approval; the final receipt insert checks unchanged Ops ACL
rows and the exact 0225 lifecycle control-plane set. It never edits
`staff_users`, legacy Ops/PA roles, permissions, scope grants, identity
bindings, or existing native authority rows.
The CAS intentionally ignores only `staff_users.last_seen_at`, which normal
authenticated activity refreshes independently. It remains part of the exact
schema fingerprint; status, email, access subject, profile, permission, and all
scope/control-plane changes remain guarded.

For a root-owned out-of-band transport, `executeNativeStaffBootstrapD1` accepts
an optional `submitManagementBatch` callback for the single mutating batch.
`compileNativeStaffBootstrapManagementBatch` creates one
`{batch:[{sql,params}]}` request, preserves string, finite-number, and null bind
values without SQL interpolation, rejects booleans/other types, limits the
request to 256 statements and 16 MiB, and never splits it.
`submitNativeStaffBootstrapManagementBatch` calls the injected transport
once; the caller must not automatically retry and must normalize a confirmed
API response to per-statement D1 results. A reader exposing the read operations
used for schema and snapshot verification is still required.

Cloudflare documents the management endpoint as
`POST /accounts/{account_id}/d1/database/{database_id}/query` and accepts a
`batch` object, but its current API schema describes each bound parameter as a
string. This installer plan includes numbers and nulls, so a future management
transport must validate exact number and NULL behavior against a staging D1
binding. Provider-level atomic rollback and uncertain-response
handling also require a staging probe before production. The callback seam has
no credentials, endpoint, retry, or production wiring. If a response is
uncertain, inspect the durable approval, receipt, and planned rows; do not
retry automatically. [Cloudflare D1 Query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).

## Trusted owner-session approval artifact

The owner/operator may review and execute in the same verified session; a
second approver is not required. The offline runner passes the installer a
`trustEnvelope` plus an injected `verifyTrust` callback. The callback must bind
the live authenticated owner session to the complete canonical plan, binding
evidence, current D1 snapshot, exact approval ID, and command ID. It rejects
replayed session challenges, expired or revoked approvals, or any digest that
differs from the owner's explicit review. It must obtain consent from the
owner session itself; a JSON `approved: true`, name, email, role, or ordinary
Worker credential is not sufficient. The callback and envelope are not
implemented as an HTTP route and no trust key is stored in this repository.

The runner supplies this exact input shape:

```js
{
  approval: {
    approvalId, approvedOperatorStaffId, approvedOperatorAccessSubject,
    issuedByStaffId, issuedByAccessSubject, issuedAt, expiresAt
  },
  canonicalPlanJson,       // exact canonical JSON, including selected Ops staff and initial native rows
  bindingEvidenceJson,     // independently verified identity-binding evidence
  reviewedSnapshot,        // returned by readNativeStaffBootstrapSnapshot
  commandId,               // one-shot command identifier
  trustEnvelope            // opaque session-verifier input
}
```

The `trustEnvelope` object has an exact, closed schema: `schemaVersion: 1`,
`action: "install-operations-native-staff-bootstrap"`, `ownerSessionId`,
`authorizationChallenge`, `approvalId`, `commandId`,
`approvedOperatorStaffId`, `approvedOperatorAccessSubject`, `issuedByStaffId`,
`issuedByAccessSubject`, `authorizedAt`, `expiresAt`,
`reviewedSnapshotSha256`, `canonicalPlanSha256`, `bindingEvidenceSha256`, and
`consentPhrase: "I approve this exact Operations staff cohort and native authority plan"`.
The trusted-session verifier must issue those fields after the signed-in owner
reviews the displayed cohort, preserved legacy access, exact initial native
grants/delegations, and one-shot expiry. It must bind the challenge to that
session and reject reuse or a changed digest. The installer also checks every
envelope field against its supplied approval, plan, evidence, snapshot, and
command before invoking the verifier.

The owner-run procedure is to read the exact cohort and row-level plan from the
review snapshot, display complete legacy permissions and the native authority
delta, then obtain explicit confirmation in an already-authenticated management
session. That session issues the `approval` and closed `trustEnvelope` values
above with fresh unique approval, command, session, and challenge IDs and a
short expiry. The independent identity-binding step emits
`bindingEvidenceJson` for that same cohort. Hash the canonical plan and binding
evidence into the envelope, then call `prepareNativeStaffBootstrapD1` and
`executeNativeStaffBootstrapD1` only from an isolated management runner.

The injected verifier must validate the authenticated owner identity, issued
consent, IDs, digests, expiry, revocation state, and challenge state on every
invocation. It must be repeatable for the same pending command until the durable
D1 receipt is confirmed; the D1 command and approval constraints consume a
successful install one-shot. If the batch outcome is uncertain, inspect the
exact approval, receipt, and planned rows; do not automatically retry or roll
back. The D1 adapter also rechecks expiry in the atomic first insert. It does
not implement the owner session, challenge store, signature verifier, or
binding verifier. Root must supply those artifacts and a concrete verifier
before any live invocation; no production verifier or approval source is wired
here.

`canonicalPlanJson` has exactly `kind`, `reviewedSnapshotSha256`, `approvalId`,
`staffCohort`, `controlPlaneStaffIds`, and `rows`. `staffCohort` lists only the
employees receiving new admission/profile rows. An already admitted owner or
operator may be listed separately as an existing control-plane member or have
explicitly reviewed additive delegation/ceiling rows in the plan; existing
owner admission/profile, Directory grants, consumed approvals, and receipts
remain snapshot-guarded and are never reinserted or replaced. Rows contain only initial
admissions, profiles, explicit target memberships, management/admin
delegations and ceilings, Directory grants/assignments, or business-area scope
rows from the fixed allowlist. Each selected identity must match an existing
active Operations `staff_users` row exactly. The plan does not create or sync
employee records. The owner review must state that existing Beau and Kollins
Operations role/override/access rows and their access subjects stay unchanged;
Project Alpha staff remain independent.

Directory grant history/generation triggers append their required derived rows
for the new planned grant. Tests permit only that exact plan-owned event and
compare every preexisting generation/history row byte-for-byte. Tests use
synthetic test-only trust fixtures and the actual Operations D1
migrations through 0225. They compare effective Ops permissions and user
status/identity bindings before and after; include deny overrides, scoped
legacy access, and existing native allow/deny grants; and check stale
cohort/schema/authority, a concurrent `last_seen_at` refresh, status/subject
drift, missing trust, reused IDs, and late failure rollback.
They do not create owner acceptance or authorize a live execution.
