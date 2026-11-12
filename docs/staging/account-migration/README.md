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

**Source/live discrepancy:** the qualified old Ops fence recorded ten service bindings,
while its production source config declares five. Five additional names are explicitly held
in `unresolvedLiveBindings`; their target entrypoints, RPC contracts and current necessity must
be read/reviewed before materializing configuration. Never silently drop them or guess a default
entrypoint. Live Workflow count also exceeded the four source Ops Workflows; account for
`ProjectAlphaCatalogPromotionWorkflow` and any runtime-only binding in the fresh graph review.
The packet lists source bindings, not an asserted complete live deployment manifest.

All database/queue/namespace IDs, Access audiences and protected origins remain conspicuous
`REQUIRES_ALLOCATION:` placeholders. Target D1 names are `ledge-top-ops-staging` and
`ledge-top-portal-staging`; R2 names are `ledge-top-delivery-staging` and
`ledge-top-incoming-staging`. No production IDs or audiences are copied into the contract.
Do not inherit production vars/secrets or merge source configs as a way to fill gaps.

Workers.dev, previews, routes, schedules and queue consumers stay off during preparation.
Protected hostname/Access review must precede any exposure. The current production-owned
staging custom domains cannot simply be attached across accounts. Merger must approve the
replacement host plan and any narrowly scoped compatibility routing. Private reader/assets
Workers must remain private after that review as well.

## iOS source/live reconciliation is a hard gate

Merger reports the existing live iOS pilot is enabled; the inspected source Wrangler configs
set `IOS_MANAGED_PILOT_ENABLED=false`. Neither value is automatically the desired target.
Record fresh readback of the source Worker/version/flags and the approved target behavior;
preserve the working old sign-in until the replacement is accepted. Do not silently disable
the live pilot, enable a new pilot, or claim copying source false reproduces live functionality.

Both `ios-pilot-edge-bridge.ts` and `ios-pilot-read-entrypoint.ts` source-pin
`https://ios-pilot-staging.ledgetop.app`. New env vars alone cannot make a replacement origin
work. After Merger supplies verified provider/resource details, coordinate source-pin changes
with the iOS owner. The broader `staging-ios-pilot-entrypoint.ts` reexports the staging HTTP
handler and other entrypoints; it is not automatically a minimal private reader artifact.
Review a dedicated private-reader bundle boundary before deploying it.

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
