# Client portal migration barriers: Client 0196–0228

This is an operator planning aid, not authority to migrate, deploy, or enable a
feature. Current live D1 state must be read from Cloudflare immediately before
any action. Never infer it from this checkout, an example evidence file, or a
prior staging note. Keep portal and authority flags off while establishing the
schema/code compatibility window.

## Hard stop before any staging Worker upload

The checked-in `apps/client/wrangler.staging.json` currently sets the portal,
native enrollment, native authority, native delivery, and content-audit paths
to `true`. Meanwhile `docs/staging/release-evidence.json.example` records the
0215–0228 set as not applied and its second list as not empty. Those are
configuration intent and an unfilled template, respectively—not proof of live
state. Other repository notes also disagree about whether staging has reached
0228. Therefore:

1. Obtain fresh, read-only exact migration ledgers for Client and Operations,
   database identities, Worker versions, and effective vars from the staging
   services. If auth is unavailable, stop here.
2. If a migration is pending, do not deploy the current staging config. Prepare
   a reviewed staging config with all dependent gates false, compare its full
   binding/database identity to the canonical staging config, and use only the
   isolated migration profile after export, preflight, and explicit identity
   confirmation.
3. Apply schema in order, verify migration ledger, trigger/view/table readback,
   `PRAGMA foreign_key_check`, and relevant row counts. Then deploy compatible
   readers/writers with gates still false. Only then open one narrowly scoped
   staging acceptance window and read back the effective flags.
4. Do not roll back by deleting schema, migration rows, immutable history, or
   receipts. Roll back code/flags only where that migration's notes below say
   this is safe; several transitions are forward-only after first use.

No statement in this file proves the staging databases currently have or lack
these migrations.

## Per-migration compatibility and rollback gates

| Client migration | Required order / compatibility barrier | Rollback constraint |
| --- | --- | --- |
| `0196_bulk_download_archive_cache` | Additive schema; apply before Workers/Workflows that query the new cache tables or fingerprint column. Existing code can ignore it. | Never drop cache/generation rows while cached R2 objects or fingerprinted jobs remain. |
| `0197_portal_root_access_policy` | Apply before enabling root policy in either Client or Ops. Verify active/revoked policy and audit triggers. | Turning the policy flag off can bypass enforcement; retain an enforcing reader and the audit rows. |
| `0198_incoming_upload_owner_notifications` | Apply before upload-completion writers/drainers use digest receipts. | Drain dispatch and retain all pending/sent/failed generations; old writer rollback stops new digest creation. |
| `0199_incoming_upload_pickup_lifecycle` | Apply before dependent Ops endpoints and scheduled pickup worker. | Stop claims and resolve leases before code rollback; never reset claim tokens. |
| `0199_native_viewer_grants` | Both distinct `0199_*` files are required in exact ledger order. Apply before Viewer grant use/enablement. | Disable new issuance first; preserve grants, revocations, receipts, and audit. |
| `0200_native_feedback_workspace_history` | Additive index only; no writer drain. Apply before relying on the optimized history query. | Dropping it only regresses query performance; retain unless separately reviewed. |
| `0201_native_draft_quote_notifications` | Maintenance barrier on both Workers: pause notification producers/dispatch, drain processing and max 15-minute leases, prove no processing rows, back up, rebuild tables, deploy compatible readers/writers, then resume jointly. | Do not downgrade CHECK constraints or delete queued notices/receipts to fit old code. |
| `0202_native_delivery_recipient_events` | Apply before Ops grant acceptance using the event writer and before Client history reads. Missing schema must fail closed. | Pause acceptance before old-writer rollback; preserve immutable events/state. |
| `0203_primary_delivery_authority` | Apply before authority coordinator code; keep registry transition separately gated and coordinated with Ops. | After registry mode begins, old scalar-only writer is unsafe; retain monotonic authority version and row. |
| `0204_delivery_change_receipts` | Apply in a paused capture/dispatch window before compatible accepted-change writer. | Stop capture and dispatch together; preserve receipts, targets, seals. |
| `0205_authenticated_delivery_change_sequence` | Strictly after 0204 in same paused window; sequence-aware writer only after schema. | Stop capture before code rollback; retain sequence data and trigger. |
| `0206_delivery_index_provider_identity` | Before provider-aware writer in same window; legacy writes clear stale provider identity fail-closed. | Stop capture before rollback; never remove revision tombstones. |
| `0207_delivery_change_projection` | After 0204–0206 while capture paused; deploy projector with recovery/notification flags off. | Stop claims; retain pending/completed/failed jobs. Never rebuild targets from current index. |
| `0208_authenticated_delivery_change_batch_provider_identity` | Before provenance-aware batch publisher in same window. Null/null legacy writes are rollout-compatible, not acceptable after activation. | Stop batching/publication before old publisher rollback; retain provenance. |
| `0209_authenticated_delivery_change_recipient_events` | Finish 0204–0209 pause window; coordinate Ops publisher/dispatcher and Client reader before activation. | Drain leases; preserve batches, events, recipient state, and controls. |
| `0210_client_delegated_share_expiry_health` | Additive health row; expiry worker tolerates missing schema. Apply before relying on durable health. | Code rollback loses observability only; retain health row and do not equate stale health with disabled expiry. |
| `0211_incoming_upload_verification_lifecycle` | Apply before verification routes/callbacks and before selecting new server modes. Drain verifier claims before old-route rollback. | Preserve exact-object proofs; never manufacture proofs for prior accepted uploads. |
| `0212_incoming_upload_archive_inventory` | After 0211; coordinate Client schema with matching Ops/TrueNAS callbacks. Enable inventory only after acceptance. | Disable inventory reads/callbacks first; inventory failure must not rewrite pickup/verification state. |
| `0213_incoming_rclone_promotion` | Before promotion Worker binding or `INCOMING_RCLONE_PROMOTION_ENABLED`; inspect leased/publishing work. | Disable promotion and drain ambiguity; preserve journal/outbox and ready objects. |
| `0214_ops_inventory_catalog_staging` | Client schema first; all Client/Ops catalog coordinator and promotion flags off. Explicitly provision/read back exact source before staging. | Disable coordinators first; preserve staged snapshots. Never auto-enroll or promote to simulate rollback. |
| `0215_operations_portal_access_authority_shadow` | Additive, no DML; apply before the shadow reader/writer gate. Keep gate off until exact readback. | Only empty state is trivially reversible; populated receipts/audit must be retained. |
| `0216_client_authority_workspace_ownership_claim` | Apply with 0217 before claim writer. Preflight exact workspace/source/generation. A claim is an authority cutover, not inert metadata. | Forward-only after claim/release; never delete/reactivate release tombstones. |
| `0217_client_authority_workspace_claim_evidence` | Must precede 0216 claim writer; writer atomically records head, audit, and receipt. | Do not remove replay/lost-response proof after writes. |
| `0218_client_authority_workspace_binding` | After 0216 schema and before binding writer/status. Preflight exact source/root/checkpoint; no access is granted by the inactive binding alone. | Downstream 0219/0221 FKs make used rows forward-only. |
| `0219_operations_portal_authority_v2` | After 0218; initial grant needs exact inactive 0218 receipt. Keep writer/status off until readback. | Retain grant CAS state, audit, receipts; do not delete used authority. |
| `0220_operations_portal_authority_v3_permissions` | In-place trigger/column compatibility change. Disable/drain authority writer; apply; deploy v3-compatible code before re-enable. | Once v3 data exists, pre-0220 writers are unsafe. Forward-fix; do not revert schema. |
| `0221_verified_recipient_delivery_authority` | Apply together with 0222 before deploying current recipient writer; preflight exact active home receipt, folder generation, project, terms, root policy, and staff publication proof. | Grants/audit/collision fences are durable; disable issuance before code rollback. |
| `0222_verified_recipient_delivery_cross_manager_revoke` | Mandatory read-only preflight for existing revision-1 head/audit/receipt completeness; drain writer, apply, deploy compatible code before re-enable. | Forward-only after provenance writes; old writer lacks required actor/provenance fields. |
| `0223_operations_portal_workspace_publications` | Additive immutable publication ledger; writer remains off until exact target/snapshot/hash/source-sequence preflight. | After publication, later authority depends on current receipt/snapshot; preserve history. |
| `0224_operations_portal_native_recipient_authority` | Requires acknowledged 0223 publication. Apply before any enabled native-authority writer/status Worker. | Used authority is required by 0227; disable writer then retain state. |
| `0225_operations_portal_workspace_publication_cancellations` | Apply before cancellation-capable code; pause/drain publication writer around guard change. | Tombstone deletion can resurrect late publication; no destructive rollback. |
| `0226_operations_portal_native_workspace_cleanup` | After 0224, before workspace cleanup writer; disable/drain producer while replacing guards. | Forward-only after committed closure; do not database-rollback. |
| `0227_operations_portal_native_delivery_authority` | Requires 0223–0224 current publication/home receipts plus exact live Ops physical-folder proof. Apply/read back views and guards before writer/status/read gates. | Disable read/writer, drain and revoke active heads before code rollback; retain ledger. |
| `0228_operations_portal_native_content_start_audit` | Before content path can start; verify schema and audit secret; drain in-flight starts during migration. | Never roll back to unaudited content starts or delete immutable telemetry. |

## Current conclusion

The main immediate risk is configuration drift, not a missing local migration
test: the staging config is permissive for portal and authority paths, while
the checked-in example evidence is explicitly incomplete. No current source
file can settle the live D1 migration ledgers or deployed vars. The next valid
action is a fresh, read-only Cloudflare inspection. Until that succeeds, no
staging Worker upload, migration apply, user enrollment, or client-access test
is authorized by this document. Production remains out of scope.

### Fresh read-only staging state (2026-10-07 UTC)

The Cloudflare D1 binding connector has since provided authoritative read-only
ledger results: Client staging is at migration `0228` and Operations staging
is at `0173`. Operations currently has zero `pa_connectors` and zero
`client_hub_roots`. These readings supersede the earlier uncertainty above,
but do not prove that the current source candidate is deployed or that a
recipient can sign in and read a workspace. Before any staging deployment,
re-check the exact Worker versions and effective flags; before enabling any
portal path, verify the source connection, linked-root materialization, and
the specific dependent migration/feature gates. All conclusions remain
staging-only; production PA and existing public links remain untouched.
