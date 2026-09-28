# Recipient enrollment staging authority plan

This plan adds one governed staging-only authority phase for recipient
enrollment. It does not activate a Worker flag, apply SQL, create a recipient
identity binding, or authorize production.

## Why a separate phase is required

The schema-v3 native-authority packet is the only existing tool that can create
the first native admission and profile from an independently reviewed Access
subject. It deliberately grants only global `directory.profile.edit` and
`project.shared.sync`. The onboarding packet cannot create the first admission,
and neither packet grants `directory.portal_access.manage`.

Owner role is not portal-management authority. Workspace selection, dispatch,
and recipient enrollment all require an explicit native Directory allow and
honor applicable denies. No route may infer that allow from owner/admin status,
an Operations role permission, a name or email match, or an existing PA
mapping.

## Two independently reviewed phases

1. **Identity/bootstrap and acquisition.** Use the existing schema-v3 packet
   after an ordinary Operations Access sign-in has bound the exact reviewed
   subject: `mode: "create"` only when authority is absent, otherwise
   `mode: "reactivate"` with the exact independently read admission/profile
   and grant versions. Revoke it after the exact-scope staging work. If a
   current synthetic activation receipt does not already exist, use the
   existing record-pinned schema-v4 acquisition packet and the default-off
   private administrator acquire/activate routes, then revoke that packet.
   The resulting admission, profile, inactive grants, immutable grant history,
   and activation receipt remain durable.
2. **Portal-access activation.** Use schema v6 with the fixed purpose
   `recipient-enrollment-portal-access`. It accepts exactly one reviewed
   Directory record and exact activation-receipt UUID, requires the exact
   inactive schema-v4 authority state,
   reactivates only the admission, and inserts one resource-scoped
   `directory.portal_access.manage` allow for that record. The existing
   profile-edit, identity-link, and Project grants remain inactive. Generate
   and independently review both provision and revoke artifacts before this
   phase starts.

Schema v6 never accepts a permission name, effect, or scope from input. Global,
business-area, division, and assigned portal-access grants are therefore not
representable. The packet also rejects additional Directory grants, any active
Directory grant, a stale record or activation receipt, a non-owner actor,
admission/profile drift, grant-generation drift, grant-history drift, and
pending actor work.

Schema v6 intentionally accepts only the two-row inactive schema-v4 lineage
(`directory.profile.edit` plus the exact resource `directory.identity.link`). A
schema-v5 lineage containing the durable inactive enrollment grant is rejected
as an unexpected third row. Supporting that lineage would require a separate
reviewed contract with its exact business-area identity and history; it is not
silently tolerated by this packet.

## Confirmed existing-lineage variants

The reviewed staging actor instead has the deterministic global bootstrap
profile grant at immutable history version 1 and the deterministic
business-area onboarding profile grant at immutable history version 3. Two
separate fixed-purpose contracts support only that exact lineage:

- Schema v7, `existing-directory-acquisition-preserving-onboarding-profile`,
  accepts either the first two-grant state
  `v7-profile-plus-onboarding-inactive` (global history exactly 1, onboarding
  history exactly 3, identity absent) or its own repeatable three-grant state
  `v7-acquisition-plus-onboarding-inactive`. Provision activates only the
  global profile grant and the exact resource identity-link grant. Revoke
  deactivates those two. The deterministic onboarding grant ID is derived from
  the reviewed staff and business-area IDs; its row and all three contiguous
  immutable history revisions must remain unchanged. Its exact history is
  version 1 inactive, version 2 active, and version 3 inactive; only the
  current onboarding grant remains inactive throughout the new phases.
- Schema v8,
  `recipient-enrollment-portal-access-preserving-onboarding-profile`, consumes
  only `v7-acquisition-plus-onboarding-inactive` plus the exact normal-workflow
  activation receipt. It activates only the deterministic resource-scoped
  portal-access grant. The global profile, resource identity-link, onboarding
  profile, and Project grants remain inactive and unchanged.

Use `staging-existing-directory-acquisition-preserving-onboarding-authority.json.example`
for schema v7 and
`staging-recipient-enrollment-preserving-onboarding-authority.json.example`
for schema v8. Their packet IDs produce separate immutable approval/receipt
lineages. Never substitute these inputs into schema v4 or v6.

The `profileHistoryGenerations`, `onboardingHistoryGenerations`,
`identityHistoryGenerations`, and (for schema v8) `portalHistoryGenerations`
arrays are authority provenance, not counters to infer. Each contains the
exact independently read `grant_generation` for every immutable revision in
version order. The generator rejects a missing, duplicate, non-increasing,
extra, or stale generation. The examples deliberately contain invalid readback
placeholders. Their fixed history-version counts describe only the first
supported lineage contract, not observed remote provenance; replace every
placeholder from sanitized private readback before generation.

Copy `staging-recipient-enrollment-authority.json.example` to the ignored
`.backups/staging-native-authority.json`, replace every placeholder with exact
independently reviewed readback, and generate both phases with the existing
packet commands:

```powershell
npm.cmd run staging:native-authority:generate
npm.cmd run staging:native-authority:check
npm.cmd run staging:native-authority:revoke:generate
npm.cmd run staging:native-authority:revoke:check
npm.cmd run staging:native-authority:test
```

These commands only generate/check ignored local artifacts and run tests. They
do not apply SQL.

## Normal staging sequence

### Current prerequisite status

The latest sanitized staging lineage readback reports one inactive native actor
with zero activation receipts and exactly two inactive
`directory.profile.edit` allows: the known native-bootstrap grant pattern is
global with one immutable history row at version 1, while the known onboarding
grant pattern is business-area scoped with three immutable history rows at
version 3. No identity value was read. The existing schema-v4
`v3-profile-only-inactive` transition requires exactly one Directory grant, so
it correctly rejects this current state; schema v6 also rejects it and cannot
run without an exact activation receipt.

Before any authority generation or remote flag window, obtain an independently
reviewed sanitized readback of the current admission/profile/project versions,
Directory generation, business-area ID, exact deterministic grant shapes, and
every immutable history revision and per-revision grant generation required by
schema v7. Abort on any mismatch.
Schema v7 is the purpose-pinned preservative transition for this confirmed
lineage; it does not authorize deleting, zeroing, relabeling, or activating the
onboarding grant. Zero activation receipts remains the expected pre-v7 state.
Schema v8 is unavailable until schema-v7 provision has supported the normal
acquisition/review/activation workflow and its exact receipt is read back, then
schema-v7 revoke has restored the exact three-grant inactive state.

After the applicable schema-v6 or schema-v8 portal provision, open only the independently reviewed exact-scope
workspace-binding window within the existing staging-testing authorization.
From the same authenticated owner session, obtain the owner HTTP CSRF
token, submit the exact record/activation/workspace/checkpoint tuple to
`/api/native-client-portal/workspace-binding/select`, and apply that same
selection through `/api/native-client-portal/workspace-binding/apply`. Require
an acknowledged Operations outbox and an inactive Client receipt.

Only then may the recipient-enrollment window issue an invitation. The normal
recipient bridge and ledger must create the `0103` identity-binding row after a
verified Access subject redeems the opaque handoff. Never insert or update a
`client_onboarding_recipient_identity_bindings` row directly.

Before the applicable schema-v6 or schema-v8 portal revoke, close the recipient flow normally: no active or
revoking intent may remain for the reviewed record; no workspace or authority
outbox may be pending, retrying, or dispatching; and no Directory or Project
actor work may remain. Turn off and read back the Client recipient flag, the
Operations recipient bridge flag, and the owner flag before applying revoke;
the SQL packet cannot inspect deployed Worker flags. Issued and pending intents
are not a grant of Client access and do not block authority revocation. They
remain durable audit state: there is currently no cancel/expire transition, and
an expired pending proof can remain stranded until a separately reviewed
lifecycle is implemented. Closing the recipient bridge before revoke prevents
a still-issued token from being redeemed after the authority window. Revoke
deactivates only the packet's exact
portal-access grant, increments the native Directory generation/history, and
deactivates the admission. Durable selections, receipts, enrollment audit,
inactive grants, and authority approvals/receipts are preserved.

All runtime flags remain false between independently reviewed exact-scope
windows within the existing staging-testing authorization. The packet
timestamps bound when SQL may be provisioned; native admission and grant rows
do not automatically expire and native authentication does not consult the
bootstrap approval expiry. Operators must close the flags and apply the
pre-reviewed revoke packet before declaring the live phase closed. A generated
packet is preparation evidence only; it is not evidence that authority was
provisioned, later revoked, or that recipient enrollment succeeded. A separate
emergency-revoke design remains required for compromise recovery where normal
no-in-flight-work predicates cannot be satisfied. Production activation or a
new production/security boundary remains a separate checkpoint. Do not enable
remote staging flags until the exact source/CI checkpoint is green and the
signed owner session plus normal prerequisite flow are available.
