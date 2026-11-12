# Separate-account staging migration contract

Owner: Merger coordinates allocation, Access/provider setup, deployment, cutover and cleanup.
This packet is **offline, incomplete and not deployable**. It does not replace the current
Workers' configuration. Do not pass `contract.json` to Wrangler or interpret placeholders as
real IDs. This packet supersedes the old provisioning packet's same-account exception only
for the proposed migration; it does not rewrite historical evidence or authorize deletion.

Target account: **Staging**, `df3f376bae6ee621f50cf972ebcc9484`.
Verified setup handed over by Merger: team `https://ledge-top-staging.cloudflareaccess.com`,
Workers.dev namespace `ledge-top-staging`. Access applications and the Ops dependency graph
still need allocation. Existing Logs and Rival Ready resources are separate; do not reuse them
as Ops storage. The new graph's Worker names are distinct even from old-account staging names.

## Proposed graph and unresolved identifiers

`contract.json` carries exact proposed names, source-file hashes, named RPC bindings,
storage references, queues, Workflows and thumbnail namespace prerequisites. Generate it with
`node scripts/staging-migration-contract.mjs` and check it with
`node --test scripts/staging-migration-contract.test.mjs`. No network/provider code is imported.
The generator requires the existing Operations TypeScript dependency to parse JSONC safely.
Source-config hashes and ordered migration-chain hashes normalize CRLF to LF so Windows and
Linux checkouts produce the same review contract. Each chain hashes sorted filename/body-hash
pairs; this pins source input and does not prove the target ledger has applied those files.

| Role | Proposed Worker | Boundary |
| --- | --- | --- |
| Operations | `ledge-top-ops-staging` | Protected staff host; Ops and Portal databases; Portal RPCs |
| Portal/delivery | `ledge-top-portal-staging` | Protected portal and narrowly reviewed public delivery paths |
| Sync | `ledge-top-sync-staging` | Service-auth-only ingress; both databases; two projection/intent RPCs |
| Retained UI assets | `ledge-top-ui-assets-staging` | Private service only; no public route |
| iOS reader | `ledge-top-ios-read-staging` | Private `IosPilotReadService`; Ops database/source authority |
| iOS edge | `ledge-top-ios-edge-staging` | Protected OAuth resource; binds only to private reader |

The proposed graph retains all service bindings in the six inspected source configs. Both
frontend Workers additionally require the retained-asset service and reviewed catalog/routing.
That addition is an intended dependency, not proof a native ASSETS binding already implements it.

**Reconciled source/live discrepancy:** Merger's fresh sanitized readback (hash recorded in
`liveEvidence`) names the five live RPCs absent from the production source config. Current
source exports and callers are checked by the offline tests. Preserve all five in the proposed
Staging graph, with their existing gates and receipt/authority semantics; do not retire them
just because Wrangler omits them. The contract records exact entrypoints, callers and rationale:

| Binding | Portal entrypoint | Current Ops caller |
| --- | --- | --- |
| `CLIENT_AUTHORITY_WORKSPACE_BINDING` | `ClientAuthorityWorkspaceBindingIngress` | `client-portal-workspace-binding-outbox.ts` |
| `CLIENT_PORTAL_ACCESS_AUTHORITY` | `OpsPortalAccessAuthorityIngress` | `client-portal-access-authority-outbox.ts` |
| `OPS_INVENTORY_CATALOG_PROMOTION` | `OpsInventoryCatalogPromotionCoordinator` | `project-alpha-catalog-staging-coordinator.ts` |
| `OPS_INVENTORY_CATALOG_STAGING` | `OpsInventoryCatalogStagingIngress` | `project-alpha-catalog-staging-coordinator.ts` |
| `VERIFIED_RECIPIENT_DELIVERY_AUTHORITY` | `VerifiedRecipientDeliveryAuthorityIngress` | `verified-recipient-delivery-authority-ledger.ts` |

All target `ledge-top-portal-staging`, not the legacy Worker. Preserve
`OPS_CATALOG_PROMOTION_WORKFLOW` as `ledge-top-catalog-promotion-staging` /
`ProjectAlphaCatalogPromotionWorkflow`, which the current Ops index exports. No Env caller
for that binding was found; it is a control-plane-dispatched Workflow. Absence of an Env
caller does not authorize dropping accepted histories or starting a new run. The exact old
name is `ledgetop-ops-catalog-promotion-staging`; the proposed new name is an identity change,
not a transfer of its executions/history across accounts. Keep old instances/history in place
until Merger reconciles their outcomes, backups and any explicitly approved new-instance
mapping. Do not blindly replay accepted operations. This identity/history migration is an
explicit hold in the contract. Source has four Workflows,
while the readback has five. This remains a review contract, not an asserted complete live
deployment manifest; fresh full binding/route/data readback is still required at cutover.

Merger allocated target D1 `ledge-top-ops-staging` =
`a58ea102-f04d-417a-bfd1-b0654cfeb503` and `ledge-top-portal-staging` =
`15d02028-8c52-40b2-9979-d67abf7d5bbf`. All database references now use those exact Staging IDs.
R2 `ledge-top-delivery-staging` (WNAM) and `ledge-top-incoming-staging` (ENAM) are allocated;
readback confirms their managed public domains are off and custom domains empty. The contract
pins the sanitized allocation/readback receipts, not secret material. **No schema/data import
has occurred.** Queue/namespace IDs, Access audiences and protected origins remain conspicuous
`REQUIRES_ALLOCATION:` placeholders. No production IDs or audiences are copied into the contract.
Do not inherit production vars/secrets or merge source configs as a way to fill gaps.

Workers.dev, previews, routes, schedules and queue consumers stay off during preparation.
Protected hostname/Access review must precede any exposure. The current production-owned
staging custom domains cannot simply be attached across accounts. Merger must approve the
replacement host plan and any narrowly scoped compatibility routing. Private reader/assets
Workers must remain private after that review as well.

## iOS source/live reconciliation is a hard gate

Merger's fresh readback confirms both existing live iOS edge and reader have
`IOS_MANAGED_PILOT_ENABLED=true`; the inspected source Wrangler configs set it false.
Neither value is automatically the desired target.
Record fresh readback of the source Worker/version/flags and the approved target behavior;
preserve the working old sign-in until the replacement is accepted. Do not silently disable
the live pilot, enable a new pilot, or claim copying source false reproduces live functionality.

Edge and reader now import one frozen source-reviewed origin list from
`ios-pilot-reviewed-origins.ts`, retaining only `https://ios-pilot-staging.ledgetop.app`.
New env vars cannot extend it. Merger's verified provider/resource details and coordinated
iOS app pins are required before a replacement origin is added. The old broader
`staging-ios-pilot-entrypoint.ts` remains unchanged. The proposed private reader now selects
`staging-ios-private-read-entrypoint.ts`: its bundled exports are only `IosPilotReadService`
and an always-404 default handler, with no Operations app or write/Workflow exports. No
current deployed/source Wrangler config selects that candidate, and no live gate changed.
Local bundle/API checks do not prove deployed Workerd/RPC or real provider acceptance.

Preserve the exact public-client callback:
`com.ledgetoptechnologies.ops.pilot://auth/callback`. Require PKCE and verify actual provider
metadata, authorization/token endpoints, resource origin and issuer; validate audience on the
server. A client-supplied audience, email, account name or arbitrary callback is not identity.
The iOS owner must update Info.plist, LivePilot.swift, MobilePilot.swift,
ManagedPilotData.swift, ManagedOAuthTransport.swift and auth fixtures together once those
values are verified. Do not change its live pins from this proposal.

The existing acceptance source `project-alpha:staging` and synthetic organization
`797929b4-a4e4-48a1-bdf6-e427c5799153` / project
`37965806-220f-437a-a378-d393245d9f2a` require owner-confirmed preservation or an explicitly
approved migrated mapping. They are continuity references, not permission to create records,
memberships or grants. Do not manufacture replacement authority from an email address.

## Storage, authority and key custody

1. Merger captures fresh exact source graph/settings/versions, data ownership and in-flight
   queue/Workflow state. Old snapshots are pointers, not current deployment authority.
2. Take private consistent D1 backups and R2/object-metadata inventories; record safe hashes,
   database ledger/schema and relationship counts. Do not put row data, object names or secret
   values in this packet. Preserve protected rollback copies and exact provenance.
3. Restore only the approved staging dataset into newly allocated Staging storage. Verify
   source IDs, external identities, account roots, binding generations, membership/grants,
   expiry/revocation state, replay receipts and foreign-key integrity. Preserve Windows roots,
   modified files and hydration state through its owner's separate acceptance.
4. Compare each actual migration-ledger entry and SQL hash against the selected commit's
   `apps/operations/migrations` and `apps/client/migrations`. Do not infer schema from the
   numerically highest filename or reapply a migration blindly. Rehearse on a restore first;
   read back the actual chain after apply. Logs migrations/storage remain separate.
5. Opaque Worker secrets cannot be assumed transferable. Generate isolated staging-only
   credentials through Merger's protected custody process, coordinate matching connector,
   receiver, Viewer/gateway and signature verification keys with each owner, and verify
   rotation/revocation behavior. Preserve current authority until replacement is tested.
   Never read production secrets to populate staging; do not reuse production PA, HMAC,
   OAuth, R2 or account API credentials. Names/required pairings can be reviewed separately.
6. Reconcile durable thumbnail state explicitly; do not assume a new namespace preserves
   pending jobs. Verify Staging Containers entitlement before using the source container.
   Keep source crons/consumers disabled until backlog/idempotency/ownership is reconciled.
   Stream, rate-limit namespaces, email sender bindings, CORS, object notifications and any
   runtime-only bindings also need account-local review; source services alone are insufficient.

## Retained assets and fresh deployment order

- Capture every frontend release served during the previous **48 hours**, old URL paths,
  exact asset bytes, SHA-256, content types, catalog entries and routing behavior. Copy all
  unexpired bodies into the target active namespace, including historical `/_ui` paths.
  A rollback version, manifest, route declaration or physical files without catalog entries
  is not a successful browser-compatibility proof.
- Use a newly reviewed immutable deployment packet for this account, binding graph and
  asset set. Never replay the consumed old Client upload/registration attempts or reuse their
  selector IDs as target-account authority. The old-account proof helper is on migration hold.
- Allocate private targets first; the Ops/Portal dependency cycle requires a deliberate
  bootstrap-and-binding sequence. Retained UI assets must be uploaded and byte-proven before
  a frontend references them. Keep gated capabilities closed during bootstrap.
- Before cutover, verify actual deployed revision/module hashes, complete bindings, actual
  migrations, private/public route scope and old/new byte responses. Document actual cutover
  time and earliest permitted pruning time, carrying retained assets into later releases.
  Do not schedule automatic pruning. Rollback must preserve new grants/receipts/data safely;
  reverting code alone is not a database or authority rollback.
- Delete old staging resources only through Merger's exact dependency-aware cleanup after
  replacement acceptance, recovery backup verification and all retention requirements.

## Required acceptance evidence

Use existing approved synthetic records; no real-client access is created by this packet.
Verify protected staff/portal sign-in, unprovisioned-email recovery, request submission/owner
review, direct Viewer list/open/revocation and public-link compatibility. Test the iOS PKCE
callback, authorized source/record reads and these negative cases: wrong issuer, wrong
audience, unauthorized record, expired grant, revoked membership, unsupported method and
ordinary write. Recheck after restart and after revocation; list/detail/error bodies must stay
within their existing bounded contracts. Confirm backend and app pins match actual provider
metadata. Frontend success, synthetic fixtures and green CI are not live acceptance.

References: [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
[Workers practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
