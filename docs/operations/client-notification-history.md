# Client notification history

The client bell reads one chronological, read-only history for the signed-in principal's exact selected workspace. It currently combines:

- service-request notices whose request and project authorization is still valid; and
- feedback-completion notices whose exact feedback target and recipient authorization is still valid.

The response deliberately omits recipient identifiers, authorization proofs, feedback submission text, request details, and storage metadata. Notification bodies are limited to the existing notice body or the staff completion note already authorized for that recipient. Existing notification-specific `PATCH` routes remain responsible for read and dismiss actions; the history endpoint introduces no mutation.

Pagination cursors are encrypted and bound to the authenticated actor plus source, workspace, and root. Each page freezes both ledger-coverage modes, fixed per-ledger high-water marks, and an `asOf` time, then rechecks every record and the selected workspace immediately before release. Revoked or changed records are skipped. An omitted ledger has a zero watermark. If an included ledger becomes unavailable during continuation, the endpoint fails closed with a refresh-required response instead of silently returning a partial page.

Coverage is reported independently for requests and feedback as `included`, `omitted_feature_disabled`, or `omitted_schema_unavailable`. Native request history requires its feature flags and schema; native feedback history requires the source capability plus feedback and notification schemas. Legacy feedback history requires its complete feedback schema. The portal displays unavailable coverage instead of presenting a partial list as complete.

Delivery-change notices are intentionally not included. Their older combined ledger does not provide uniform per-record current delivery-grant authority across every workspace mode. The API reports `delivery: omitted_no_explicit_grant_authority`, and the portal explains that those notices remain in the explicitly authorized delivery workflow. They may be added only after an adapter can prove the current exact grant for every released record.
