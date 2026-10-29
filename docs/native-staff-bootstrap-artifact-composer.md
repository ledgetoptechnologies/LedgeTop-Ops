# Native staff bootstrap artifact composer

This module assembles the exact JSON artifact shape consumed by
`native-staff-bootstrap-owner-approval.mjs` and
`prepareNativeStaffBootstrapD1`. It performs no network calls, credential reads,
signing, approval, file writes, or D1 mutations.

## Input and output

Call `readNativeStaffBootstrapSnapshot(db, proposedStaffIds)` from
`native-staff-bootstrap-d1.mjs` against a freshly reviewed 225-migration database
snapshot, then pass that returned value to `composeNativeStaffBootstrapArtifact`
with:

- the selected staff IDs (selection is by staff ID only; the matching stored
  Access subject is copied from that exact `staff_users` row);
- the exact control-plane candidate IDs returned by the snapshot API;
- explicit owner and kstirn preservation IDs;
- a short decision/reference label for traceability; and
- any proposed policy rows, written explicitly for the proposed cohort or the
  narrowly defined initial owner package below.

The result contains `artifact`, `planSha256`, `bindingSha256`, and preservation
digests. The artifact has the four existing consumer fields:
`canonicalPlanJson`, `bindingEvidenceJson`, `reviewedSnapshot`, and `commandId`.
It is deeply frozen in memory. The composer does not persist it; any later
private persistence must use a separately reviewed owner-only location and
exclusive-create path.

## Refusal and preservation rules

The composer accepts only the exact 225-migration name digest ending at
`0225_native_staff_lifecycle_bridge.sql`; a 221-migration snapshot, unknown
chain, or future migration is rejected. Selected identities must be active and
have a stored Access subject, email, and display name. Profile display fields
are copied from the row selected by staff ID; email matching never selects an
identity.

The explicit owner and kstirn rows must be active and carry their existing
stored Access subjects. The owner must already have the matching native
admission and profile. If kstirn has neither native row, the composer can add
only an admission and profile copied from that exact existing staff ID's
subject, email, and display name; partial or mismatched native state is refused.
That identity-only copy does not infer a role or grant. The binding evidence
records hashes for each person's snapshot-linked Ops state and for inactive
staff history. The owner cannot be an install target, and kstirn cannot be an
authority actor or target in supplied policy rows. Authority rows are not
inferred. Ordinary supplied policy rows must be explicit, install-table-shaped
rows for the proposed cohort and are included in the binding hash.

There is one owner-actor exception: when the observed snapshot has no
control-plane candidate for the preserved owner, the plan may include that
owner in `plannedControlPlaneStaffIds` only alongside the complete explicit
initial owner package: nine global management delegations and eleven global
delegation ceilings. The observed IDs remain exactly those from the snapshot;
the package does not add the owner to the employee cohort or re-admit or
re-profile the owner. The package is validated for its exact capabilities,
scope, provenance, and ceiling links, and is bound as explicit policy. It does
not grant authority to kstirn or infer any employee authority. See the
[canonical owner-package and observed/planned control-plane rules](operations/native-staff-bootstrap-artifact-composer.md#observed-and-planned-control-plane)
for the complete requirements. Directory grant and directory assignment rows
are excluded so the plan cannot alter client access or client assignments.

The existing installer is insert-only and its atomic snapshot guard remains the
write boundary. This composer does not prove or assert that client records were
read; it constrains the plan so it contains no client record mutations. The
snapshot and rows themselves remain sensitive because they carry staff identity
and access-subject data.

## Approval remains separate

The binding evidence is marked `draft-not-approved`. Its decision reference is
not an authorization, and a plan hash is not owner consent. The existing owner
approval flow must still validate the pinned current owner session and native
identity, compare the live cohort to the reviewed snapshot, display the exact
plan delta, and obtain the existing exact typed consent before signing. Trust
key generation, Windows trust-config provisioning, protected artifact storage,
approval signing, and D1 execution remain separate operations. The current
source pins stay default-off until those source and owner-specific values are
reviewed and provisioned independently.

The current approved authority matrix for any new employee is not inferred by
this composer. A human owner must review any explicit policy rows and the root
must verify the protected owner/kstirn IDs and preservation digests against the
current source of truth before artifact signing.
