# Staging native portal upgrade: Client 149 / Operations 194

Status: preparation only. No migration or deployment is authorized by this document itself; the user's standing staging authorization applies. Production PA, production client access, and existing public links remain untouched.

## Verified baseline

- Read-only provider queries on October 11 confirmed Operations has 190 migrations, ending in `0190_client_hub_native_project_preparation_authority.sql`; Client has 147, ending in `0228_operations_portal_native_content_start_audit.sql`. Both foreign-key checks returned zero violations.
- Staging Operations currently serves revision `f49597483b6414eb1e540136dc650b674ff1fa62`, version `c8ece7b8-b340-42ad-85ba-4cc618153745`, deployment `b2b0a081-5c8f-4a9c-a28d-223ca3872fa9` (100%). Revalidate the provider before any deployment; this is not a reusable current-state assertion.
- Local cancellation runtime/migrations are committed in `b121c1aec21d72a4a5a3f2ad3b8022b85dd60eaa`; bootstrap pins are committed in `74f33e19`. Release inventory/default-off corrections and the new migration runner require their own final review and clean candidate revision.
- Both application builds pass locally. Focused cancellation and fresh real-D1 full-chain tests pass. These do not replace live cross-Worker acceptance.

## Exact candidate and database order

- Freeze one clean candidate revision and its test results. Do not infer that this branch contains every deployed change merely from a higher migration count; compare the runtime/configuration delta against the deployed revision.
- Generate/check the isolated reviewed migration profiles with `node scripts/staging-native-migration-profile.mjs --write` and `node scripts/staging-native-migration-profile.mjs --check`.
- Seal private backups, exact ordered ledgers, schema definitions, authorization/outbox/receipt history, and one-shot attempt records using the reviewed paired runner. Do not publish private snapshots.
- Apply only Client `0229` and `0230`; reconcile exact 149-migration ledger, expected schema changes, preserved history, and foreign-key integrity.
- Only after Client readback passes, apply only Operations `0191` through `0194`; reconcile exact 194-migration ledger and the same preservation checks.
- Do not use the historical `0188–0190` runner or its markers for this upgrade. Its old revision, CI, source hashes, and ledger assumptions are intentionally incompatible.
- On an uncertain apply response, inspect the existing attempt and provider state. Never automatically retry, remove the marker, edit migration history, or manually delete a grant to make a test pass.

## Deployment and activation order

- Build from the final clean revision and record exact artifact hashes and CI results. Historical `f4959748` upload/promotion evidence is not proof for a new candidate.
- Preserve every current binding, variable, secret reference, asset binding, schedule, container application, and Durable Object configuration. No Viewer changes are part of this release.
- Upload inactive Client and Operations candidates, then independently reconcile their exact versions and configuration. Keep both cancellation flags explicitly false, along with the separately gated financial/service additions.
- Promote Client first and verify it, then Operations and verify it, using separately sealed one-shot deployment attempts and current rollback versions.
- Only after both schemas and both Workers are verified, enable the paired cancellation workflow in staging under an explicit test plan. Never enable one side alone or infer production authorization from staging success.

## Live acceptance still required

- Reconcile the existing expired, unacknowledged synthetic grant through durable Client negative proof. Preserve the previous revoked authority and all receipts. If Client instead proves commitment, acknowledge that result rather than claiming cancellation.
- Issue an explicit replacement through the normal owner flow; prove signed-in recipient list/metadata/preview/download access to the selected synthetic folder only, exclusion of unrelated data, and loss of access after revocation.
- Diagnose and resolve the ordinary organization-scoped project-preparation failure. The misleading duplicate error is not evidence of a duplicate: the preparation table was empty. A diagnostic-only catch correction does not establish successful project creation.
- Prove normal project create/update acknowledgment, canonical PA readback, same-command replay, and conflict handling with mismatched acquired PA/Ops IDs.
- Recheck financial document/payment-link authority and unchanged existing public links before the production update checkpoint.

## Owner checkpoint

- Do not request a production PA update until staging evidence supports the actual API-sync and portal prerequisites.
- At that checkpoint, provide exact PA/Ops revisions, migrations/configuration, rollback targets, and safe validation order. The owner updates both production PA instances; production client activation/cutover remains separately gated.
