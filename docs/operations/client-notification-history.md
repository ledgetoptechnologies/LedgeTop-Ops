# Client notification history

The client bell reads one chronological, read-only history for the signed-in principal's exact selected workspace. It currently combines:

- service-request notices whose request and project authorization is still valid;
- legacy portal `folder_grant` delivery notices whose exact live association, account membership, and project grant (when scoped to a project) are still valid; and
- feedback-completion notices whose exact feedback target and recipient authorization is still valid.

For a selected native workspace it also includes source-qualified Project Alpha delivery-grant notices from the recipient-event ledger described below.

The response deliberately omits recipient identifiers, authorization proofs, feedback submission text, request details, and storage metadata. Notification bodies are limited to the existing notice body or the staff completion note already authorized for that recipient. Existing notification-specific `PATCH` routes remain responsible for read and dismiss actions; the history endpoint introduces no mutation.

Pagination cursors are encrypted and bound to the authenticated actor plus source, workspace, and root. Each page freezes ledger coverage, fixed per-ledger high-water marks, and an `asOf` time. Each candidate is reauthorized against current state during page construction; a final check verifies broad workspace/source/root continuity. Records found revoked or changed are skipped. This is not a transactionally frozen authorization snapshot or a guarantee that previously authorized bytes can be retracted after a concurrent revocation. An omitted ledger has a zero watermark. If an included ledger becomes unavailable during continuation, the endpoint fails closed with a refresh-required response instead of silently returning a partial page.

The cursor contract is version 3. It carries independent `requests`, `feedback`, and `nativeDelivery` coverage values and rowid watermarks; older cursor versions are rejected and must refresh before a deployment can add a ledger. In-memory ordering uses the same ASCII binary comparison as the SQL continuation predicate, including mixed-case opaque IDs.

Coverage is reported independently for requests and feedback as `included`, `omitted_feature_disabled`, or `omitted_schema_unavailable`. Native request history requires its feature flags and schema; native feedback history requires the source capability plus feedback and notification schemas. Native delivery history requires the recipient-event schema. Legacy feedback history requires its complete feedback schema. The portal displays unavailable coverage instead of presenting a partial list as complete.

Legacy per-identity `folder_grant` notices are included as `delivery` items and report `delivery: included_legacy_portal_notices`. Their read/dismiss UPDATE is fenced by live legacy association and project-grant conditions. Selected-workspace mutations also enforce current identity, workspace visibility, binding and capability authority at that UPDATE. Migrated-D1 race tests cover revocation between the route check and mutation. Full release and live acceptance remain separate gates; local source and test evidence is not proof of production deployment.

## Portal-native delivery grant notices

Authenticated Project Alpha portal-grant acceptance now has a separate, recipient-facing bell ledger. Client migration `0202_native_delivery_recipient_events.sql` creates immutable `native_delivery_recipient_events` records and the independent per-identity `native_delivery_recipient_event_state` table. The Operations intent transaction writes the recipient event with the accepted receipt, grant/version, source/workspace, folder binding/version, owner and principal/version before returning success. It does not depend on SMTP or staged-batch delivery.

The Client history endpoint merges these rows with request, feedback and legacy notices when a native workspace is selected. Native delivery coverage is reported as `included_project_alpha_grant_notices`; unavailable schema is reported explicitly. Rows are reauthorized against current source, workspace, membership, principal binding, grant, folder binding, entitlement, denial and access-term state. Read/dismiss uses a native-delivery-specific mutation route and writes only the per-identity state table. It never changes mail, batch, receipt, grant or immutable event rows.

The producer currently emits only `grant_accepted`. Native delivery bell history does not yet mean general upload subscriptions or authenticated file-change history; those require a separately accepted object-version event contract. No automatic recipient fan-out from operational contacts or email-address matching is allowed.

The bell remains subject to the ordered 0200-0203 migration sequence, the 0201 maintenance barrier and drain/readback procedure, default-off runtime flags, and live source/workspace acceptance. See [the rollout manifest](client-portal-rollout-manifest.md) for the migration-first procedure and [native recipient history](native-delivery-recipient-history.md) for the producer/consumer contract and remaining live evidence.
