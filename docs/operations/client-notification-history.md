# Client notification history

The client bell reads one chronological, read-only history for the signed-in principal's exact selected workspace. It currently combines:

- service-request notices whose request and project authorization is still valid; and
- legacy portal `folder_grant` delivery notices whose exact live association, account membership, and project grant (when scoped to a project) are still valid; and
- feedback-completion notices whose exact feedback target and recipient authorization is still valid.

The response deliberately omits recipient identifiers, authorization proofs, feedback submission text, request details, and storage metadata. Notification bodies are limited to the existing notice body or the staff completion note already authorized for that recipient. Existing notification-specific `PATCH` routes remain responsible for read and dismiss actions; the history endpoint introduces no mutation.

Pagination cursors are encrypted and bound to the authenticated actor plus source, workspace, and root. Each page freezes both ledger-coverage modes, fixed per-ledger high-water marks, and an `asOf` time. Each candidate is reauthorized against current state during page construction; a final check verifies broad workspace/source/root continuity. Records found revoked or changed are skipped. This is not a transactionally frozen authorization snapshot or a guarantee that previously authorized bytes can be retracted after a concurrent revocation. An omitted ledger has a zero watermark. If an included ledger becomes unavailable during continuation, the endpoint fails closed with a refresh-required response instead of silently returning a partial page. The current cursor contract is version 2; version-1 cursors are rejected on refresh so a deployment cannot inject newly supported delivery rows into an in-flight page. In-memory ordering uses the same ASCII binary comparison as the SQL continuation predicate, including mixed-case opaque IDs.

Coverage is reported independently for requests and feedback as `included`, `omitted_feature_disabled`, or `omitted_schema_unavailable`. Native request history requires its feature flags and schema; native feedback history requires the source capability plus feedback and notification schemas. Legacy feedback history requires its complete feedback schema. The portal displays unavailable coverage instead of presenting a partial list as complete.

Legacy per-identity `folder_grant` notices are included as `delivery` items and report `delivery: included_legacy_portal_notices`. Their read/dismiss UPDATE is fenced by live legacy association and project-grant conditions. At checkpoint 51c951f, selected-workspace mutations also enforce current identity, workspace visibility, binding and capability authority at that UPDATE. Migrated-D1 race tests cover revocation between the route check and mutation. Full release and live acceptance remain separate gates; this source implementation is not evidence of production deployment.

Staged/native delivery mail remains intentionally omitted and reports `delivery: omitted_no_explicit_grant_authority`. Batch and outbox rows are dispatch records, not recipient-facing portal notices: they lack a portal identity/read-dismiss lifecycle and cannot safely be adapted as history. A later feature requires a separate recipient-facing projection ledger with an exact identity/principal/version authorization fence; it must not repurpose email-batch state for bell mutations.

## Remaining goal requirement: native delivery in the bell

September 6 source audit distinguishes the existing producers:

- `apps/operations/src/worker/client-folder-notification-batches.ts` writes
  `client_portal_notifications`; these are the legacy delivery items covered here.
- `portal-delivery-notification-batches.ts` stages native intent batches/items.
- `authenticated-delivery-change-notifications.ts` stages exact opted-in grant
  change batches/object versions and dispatch state. It does not create a
  recipient-facing bell record.

Therefore the legacy adapter does **not** complete the overall portal-native
notification requirement. The next implementation must publish an idempotent
recipient-facing record for authorized native delivery events, independent of
SMTP success, with source/workspace, individual recipient, exact grant/version,
and target authority retained for reauthorization. Read/dismiss state must be
independent of batch Send Now/Cancel and mail retries. Tests must cover duplicate
events, source-ID collisions, revoked/replaced grants, identity rebinding,
mail failure without lost bell history, and a single merged client bell.
No automatic fan-out from operational contacts or email-address matching is
authorized by this audit, and no live client mail was sent to test it.

### Native delivery implementation boundary (not yet implemented)

The accepted portal-intent transaction in
`apps/operations/src/worker/project-alpha-delivery-intents.ts` already inserts
the receipt, grant/audit and granted outbox row in one D1 batch. A new
recipient-facing projection should attach there, before optional email staging,
not to email success/failure or batch status transitions. Its unique event key
must survive receipt replay; its individual recipient must come from the exact
source/workspace principal binding, never an address-book email match.

Persist grant ID/version, receipt, binding ID/version/owner, source/workspace,
principal ID/version and individual identity. Both history reads and the atomic
read/dismiss UPDATE must reauthorize those coordinates against current source,
membership, delivery entitlement/denial, access terms and grant expiry. Use a
native delivery-specific mutation route; do not reinterpret legacy request
notification IDs. Add a separate cursor watermark/coverage entry and reject
older cursor versions when introducing this ledger.

Two lifecycle cases still need implementation decisions backed by existing
contracts: a grant accepted before an individual identity is bound must not
silently lose its later portal notification, and actual file-change notices
need their own accepted object-version event projection. The intent-granted
event alone does not implement file-change history. Email batch rows are not
a substitute for either lifecycle. Migration numbering must be chosen against
current main (this checkout already contains Client migration 0201).
