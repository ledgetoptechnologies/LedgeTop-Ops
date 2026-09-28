# Recipient enrollment: existing staging lineage review

This records the locally implemented and tested schema-v7/schema-v8 design. It does not prove or authorize a remote D1 mutation, grant, activation receipt, portal binding, deployment, or production change.

## Observed bounded state

The reviewed staging owner has two inactive `directory.profile.edit` allow grants:

- the global native-bootstrap grant, with one immutable history revision;
- the business-area-scoped staging-onboarding-profile grant, with three immutable history revisions.

Both rows must retain their exact IDs, staff ID, scope columns, business-area binding, `granted_by`, inactive state, and complete history. Aggregate readback found one inactive native admission and no existing-directory binding activation receipt; exact admission versions and prior approval/receipt lineage still need private readback.

## Why current packet modes correctly reject it

`staging-native-authority-packet.mjs` treats `v3-profile-only-inactive` as exactly one inactive global profile grant and no identity-link grant. The v5 after-fixture path instead expects an inactive global profile grant plus an inactive business-area `directory.enrollment.manage` grant. Neither state describes an additional business-area `directory.profile.edit` grant.

The v6 recipient-enrollment packet also requires exact inactive v4 acquisition authority: one global profile grant, one resource-scoped identity-link grant, exact history counts, and no enrollment-manage grant. Allowing the current extra profile row without explicitly pinning it would weaken the unexpected-row fence; deleting, renaming, rescoping, or substituting that row would destroy lineage.

## Smallest preservative transition

Add one fixed-purpose, staging-only packet lineage rather than broadening the existing v3/v4 predicates. A suitable purpose is `existing-directory-acquisition-preserving-onboarding-profile` with a distinct schema version and an exact state such as `v7-profile-plus-onboarding-inactive`.

The packet must accept only `reactivate` and must pin:

- the existing global profile grant ID and exact history version `1`;
- the existing onboarding profile grant ID, exact business-area ID, and exact history version `3`;
- the exact per-revision `grant_generation` sequence for every preserved or reactivated grant history, taken from sanitized private readback rather than inferred from an aggregate generation;
- the reviewed staff admission/profile/project-grant versions and generations;
- one exact reviewed Directory record ID, kind, and current version;
- absence of every other Directory grant, active grant, pending authority command, and prior packet receipt for this transition.

Provision may reactivate the admission and global profile grant and create the one exact resource-scoped `directory.identity.link` grant. It must leave the onboarding profile row inactive and byte-for-byte equivalent in authority fields; its exact immutable history remains version 1 inactive, version 2 active, and version 3 inactive, with each reviewed `grant_generation` unchanged. Revocation must deactivate only the global profile and identity-link grants, increment their normal history/generation state in deterministic explicit order, and return admission to inactive. It must again prove that the onboarding row and all three history revisions are unchanged.

The resulting acquisition state therefore contains exactly three inactive Directory grants: global profile, resource identity-link, and preserved business-area onboarding profile. It is not equivalent to current `v4-acquisition-inactive`, so it requires the isolated schema-v8 purpose `recipient-enrollment-portal-access-preserving-onboarding-profile`, not a broadening of schema v6. Schema v8 includes the preserved onboarding row in exact row/history counts while activating only a resource-scoped `directory.portal_access.manage` grant. Portal revoke deactivates only that portal grant and preserves all three prior grants and histories.

## Required activation sequence

1. Generate, independently review, and apply the fixed-purpose acquisition provision packet.
2. Exercise the existing acquisition/review/activation workflow through `project-alpha-existing-directory-acquisition-coordinator.ts` and `project-alpha-existing-directory-binding-review-consumer.ts`. Do not insert an activation receipt directly.
3. Read back the immutable activation receipt and exact record version.
4. Revoke the temporary acquisition packet, proving the preserved onboarding lineage remains unchanged.
5. Generate schema-v8 portal access only against that exact inactive acquisition lineage and exact activation receipt.
6. Run recipient enrollment through the mounted owner/recipient workflow. Do not insert a 0103 binding directly.

Acquisition authority, Directory binding activation, portal-access authority, and recipient enrollment remain separate approvals and receipts.

## Sanitizable readback packet

Before generation, capture the following into an ignored/private values file. Published manifests and logs should contain hashes or bounded counts, not email, Access subject, raw record IDs, activation IDs, or tokens.

- Admission: exact staff ID, active state, version, admitted-by ID, and hash of bound Access subject.
- Profile: exact version and hashes of email/display name.
- Project authority: exact grant ID/shape/state/version and generation.
- Directory generation: exact current generation.
- Directory grants: count and, for both known grants, exact ID, permission/effect, scope kind, nullable scope columns, active state, and granted-by ID.
- Directory history: per-grant count, minimum/maximum/contiguous versions, and exact immutable shape/state for every revision.
- Business area: exact ID exists and is active.
- Target record: exact ID, kind, current version, and source-qualified acquisition/review state.
- Activation receipts: exact count and identities; the current expected count is zero before the normal activation workflow.
- Packet evidence: prior authority migration names, approval/receipt identities and canonical-plan hashes, without raw identity values.
- Negative state: no unexpected grant rows, active Directory/project authority, live command proofs, write fences, pending/leased outbox work, portal authority work, or active/revoking recipient enrollment for the target.

Abort generation if any count, version, history row, scope, business-area binding, grant ID, or activation count differs.

## Required local tests

- Reproduce exactly two inactive profile grants with global history `1` and business-area history `3`; acquisition provision/revoke succeeds and preserves the latter byte-for-byte and at history `3`.
- Reject another permission, effect, scope, business area, ID, grant row, active state, missing/non-contiguous history revision, or changed history count.
- Reject attempts to use existing `v3-profile-only-inactive`, v5 fixture, or ordinary v4 state names for this lineage.
- Prove only global profile and identity-link histories advance during acquisition; onboarding history never advances.
- Require the real acquisition/review/activation path and reject zero, wrong-record, wrong-version, wrong-reviewer, duplicate, or forged activation receipts before schema v8.
- Schema v8 accepts only the new exact inactive acquisition state, activates only the resource portal grant, and preserves all prior rows/histories through portal revoke; schema v6 remains unchanged.
- Repeated portal access reuses the same portal grant and contiguous history; it creates no parallel grant.
- Normal acquisition/activation and recipient commands: lost-response/idempotent replay returns the recorded result without repeating a mutation. Packet SQL itself remains one-shot behind its dedicated migration ledger; a raw SQL replay must not repeat its grant mutation.
- Joined acceptance reaches recipient enrollment without direct 0103 insertion and proves full revoke/reconcile removes home access.
