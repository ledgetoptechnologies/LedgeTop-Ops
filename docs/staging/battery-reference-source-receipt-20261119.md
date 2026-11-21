# Battery reference names: release and validation notes

Battery names belong to the aircraft/battery pair. A shared canonical function
normalizes presentation and uniqueness, including optional Battery prefixes and
internal whitespace. Staff with flight_logs.import can save, rename and clear;
ordinary read access does not grant naming authority. Writes and audit are atomic.
The local keyed RPC rechecks current directory authority even on replay.

Serials remain the physical identity and remain searchable. UI labels show each
serial once using the existing masked display convention. Flight associations and
history are untouched. Overview usage and health remain one row per physical pack,
with relevant per-aircraft references shown alongside the existing pack totals.

The detail editor retries uncertain saves with the same payload and action key.
A named duplicate-name conflict is a definitive refusal and permits editing.
Pending editor input is component state; navigation or full reload does not restore
it. Server receipts remain durable. Cross-reload editor recovery is not claimed.

## Required deployment order

Migration `apps/logs/migrations/0007_battery_references.sql` is additive. Pairing
migration 0004 remains reserved and unchanged. The Logs domain and local-only
migration ledgers are separate; do not substitute one ledger for the other.

For the Cloudflare Logs Worker, confirm the actual account and bound database,
admit the database migration, apply 0007 and verify its ledger entry **before**
deploying Worker code that queries battery_references. There is no automatic D1
migration step in the image publisher. Deploying code first breaks read routes.

For logs-local, the reviewed image must include 0007. On an admitted restart the
startup migrator applies the Logs domain migrations before serving requests,
checking already-applied checksums. Verify successful migration/startup before
connecting callers. Do not edit applied migrations or replay deployment receipts.

## Validation boundaries

Focused synthetic regressions cover canonical uniqueness, cross-aircraft reuse,
fallback, rename/clear, serial/name search, pilot scope, unchanged historical
associations and per-pack metrics, authorization, atomic audit rollback, and keyed
replay/revocation. Ops route/remote and browser cases cover conflict classification,
editable/read-only views, uncertain response retry and clear.

Exact-source test receipts and independent review are release evidence maintained
outside the product repository. Syntax parsing alone is not type/runtime acceptance.
Staging acceptance still requires an admitted real-log decode/display, reference
save/rename/clear/search/health checks, and owner visual review. Reuse the approved
pilot and its existing authentication path. A healthy keyless host can remain
waiting_for_key and is not proof of real encrypted-log decode.
