# Closed iOS reader: schema, identity and read-only acceptance plan

Reference application source: `38bf0fdc3c0ef0799e11b5b3bc978142090bdfe7`, draft
PR517 stacked on PR466. The iOS Worker/config paths have no diff from deployed
source751affa691eed085d31688bf6fe69e84dbd643a4. Merger owns schema/data application,
provider settings, grants, deployment and activation. This document grants none.
No staging backup, vault or recovery-key prerequisite applies.

## 1. Exact target and supported protocol

Account **Staging** `df3f376bae6ee621f50cf972ebcc9484`; private reader
`ledge-top-ios-read-staging`, only D1 `OPS_DB` = `ledge-top-ops-staging` /
`a58ea102-f04d-417a-bfd1-b0654cfeb503`. Edge `ledge-top-ios-edge-staging` has only
`IOS_PILOT_READ` service binding to reader entrypoint `IosPilotReadService`.
Reader default HTTP always404; named RPC only `read(string): Promise<string>`.
Neither candidate exposes the main Ops Worker, write RPC, Workflow, Portal DB or R2.

Merger's closed-deployment receipt is
`merger-ios-private-workers-receipt-20261112.json`, SHA256
`7a2d78b16e59aacf8fe9335493943385a420d8789c3a9ca67ee53cd6301777e8`:
reader268253 bytes / `7fe1bde09ea991397631d4bc70e5c27e645a7d963bbf750f0962df8a26ade14a`;
edge61277 bytes / `0526f9691feed1de0766e3cef006d8811a331bd9616a406456c3ee5fe39d24ca`.
Both workers.dev/previews and managed pilot false; edge OAuth probe false. This is
an owner-qualified deployment receipt, not data/OAuth/read acceptance. Re-read actual
versions/settings/bindings/account immediately before any later action.

| Pin | Exact value |
| --- | --- |
| Issuer/team | `https://ledge-top-staging.cloudflareaccess.com` |
| Pilot origin | `https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev` |
| Pilot Access app | `3ebfae1c-321b-46c6-ba56-6be95f95c50f` |
| Pilot audience | `17f32ab9f964a3e4c64864e06d3d0e1b128604192b9a7e457db1f8f88b8f5707` |
| Distinct Ops origin | `https://ledge-top-ops-staging.ledge-top-staging.workers.dev` |
| Ops Access app | `37c5049c-a787-49cf-ac43-ba4d340bee70` (registered deny-all) |
| Ops audience | `ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84` |
| Native callback | `com.ledgetoptechnologies.ops.pilot://auth/callback`, public-client PKCE/S256 |

These public identifiers are not credentials or admission authority. Preserve24-hour
app/30-minute grant settings, no loopback exception, installed native pins and old
endpoint until actual replacement acceptance. Access resource metadata/real OAuth
context must be checked on the actual endpoint; a registered app alone proves neither.

Selected edge/reader supports only GET `/mobile-pilot/v1/session`,
`/mobile-pilot/v1/operations` with at most one `cursor`, and `/operations/:id`.
The internal envelope is strictly `{assertion,url}`; no supplied principal, grants,
cookies, Origin or original bearer is forwarded. RPC result is
`{version:1,status,body}`; successful DTOs have `schemaVersion:1` and exact fields.
Session is readOnly=true; list returns at most50 items and an opaque base64url cursor.
The edge requires actual Access context identity matching the JWT subject/email,
and both edge and reader independently verify a current human RS256 assertion with
the exact issuer and single pilot audience. Ops/service-token audiences are denied.
See `ios-pilot-edge-bridge.ts`, `ios-pilot-read-rpc.ts`, `ios-pilot-managed-routes.ts`,
`ios-pilot-access.ts` and `ios-pilot-staff-snapshot.ts` for the complete boundary.

## 2. Ordered schema preparation, without invented partial migrations

The minimal **supported baseline** for this selected reader is the canonical ordered
Operations source chain, not a hand-picked set of CREATE statements. The read map
below identifies relevant objects; it is not an independently supported partial chain.

[Exact ordered source inventory](ios-operations-migration-inventory-38bf.json):
**235 physical SQL files**, final `0240_flight_logs_permissions.sql`, chain SHA256
`21a662da0b041e2fd6753b244b9a91d10eb7dba9ad71d4d99d06f91aa25c7d9e`.
This matches `buildContract().migrationSources` on source38bf. Each SQL hash normalizes
CRLF to LF; chain hashes `name TAB sha256 LF` in filename order. Count235 is not the
last filename number. Do not expand frozen149/199/150/205 bootstrap contracts.

1. Merger reads the target's actual ledger, sqlite schema and account ownership.
   Allocation/closed Worker upload does not establish installed schema. Compare every
   applied name/body and object/constraint with this inventory; uncertain drift holds.
2. Reuse the existing statement splitter and full-chain rehearsal. `0002_seed_acl.sql`
   is identity/permission-bearing seed SQL: the local Ops test transforms its owner
   into synthetic fixture IDs. That transformation is **not** approved live seed SQL,
   subject mapping or authority. Select preserved/reviewed seed handling explicitly;
   do not execute raw production owner seeds or copy synthetic test grants into target.
3. Apply only Merger's reviewed pending sequence, once. Record actual applied-body
   provenance separately for any deliberately transformed seed; never attest a raw
   source hash for different applied SQL. No blind reapply, automatic retry or reset.
4. Read back ledger/object constraints and foreign-key integrity. No import, record
   mutation or migration has been performed by this plan. Existing data stays retained.

## 3. Required read-path objects and constraints

All constraints, indexes and triggers come from the full ordered source chain above.
The following is the direct-query/FK dependency map; do not recreate loose lookalikes.

| Dependency | Migration provenance | Required invariant |
| --- | --- | --- |
| `staff_users` |0001 plus successors| id/email/display_name/access_subject/status/project_alpha_user_id; unique lowercase email, unique subject and PA user mapping, active status. Primary login requires exact stored subject; null/unbound subject does not enroll on read. |
| `roles`, `permissions`, `role_permissions`, `staff_role_assignments`, `staff_permission_overrides`; FK parents `divisions`/staff |0001/0002;0015 adds operations.view_all| Current grants with exact scope/effect/resource; global deny wins; active role assignments are separate from an email/Access allowlist. |
| `local_staff_role_assignments` |0011| Included in current ACL union; cannot omit this table even if no local grants are expected. |
| `native_staff_admissions`, `native_staff_profiles`, `native_staff_access_reconciliation` |0057/0059/0061/0225|0061 adds the admission version queried/pinned by the reader. Singleton control/valid mode; native mode requires active admission bound to canonical subject and exact profile/staff email/subject plus positive current profile/admission versions.0225 defaults disabled; missing/disabled legacy compatibility is not approval to change cohort mode. Partial/malformed state fails closed. |
| Five `staff_login_*` tables |0226| `staff_login_binding_control` singleton1/schema_version1; generations; binding intents; bindings; audit. Preserve generation/version ranges, FK RESTRICT, claimed-intent linkage, immutable identity, 15-minute intent lifetime and active/revoked transitions. All required objects listed below must exist. |
| `pa_projects`, `pa_operations`, `pa_operation_assignments` |0001/0004;0033 source columns| Active rows; project/operation source match; exact operation/project/user relation and source ownership. No source relabeling or cross-source collision inference. |
| `pa_connectors`, `pa_connector_revisions`, FK parent `pa_connector_signing_keys` |0035 plus successors| Current active revision and immutable enrolled source/context/public signing commitments must match deployment manifest. Preserve deferred connector/revision FK, revision/key uniqueness and current/previous pairing. Visible source is controlled by read_visible, not guessed from ingestion state. |
| `pa_local_division_source_heads`, `pa_local_division_mappings`, `divisions` |0215/0001| Source/identity head match, operation override beats project fallback even when null/stale; inactive division must not leak a name. These are Ops-local staff scopes, not removed PA owner divisions. Mutation journal/guard tables are not queried here but remain part of canonical schema. |
| `d1_migrations` |migration runner ledger| Exact names and actual applied-body provenance; highest numeric filename alone is insufficient. |

0226's read verifier requires these18 named objects in addition to its five tables:

```text
staff_login_intent_insert staff_login_intent_update staff_login_intent_no_delete
staff_login_binding_insert staff_login_binding_update staff_login_binding_no_delete
staff_login_binding_linked staff_login_binding_revoked
staff_login_canonical_insert_collision staff_login_canonical_update_collision
staff_login_generation_update staff_login_generation_no_delete
staff_login_audit_no_update staff_login_audit_no_delete
staff_login_control_no_update staff_login_control_no_delete
staff_login_bindings_active_email staff_login_bindings_active_subject
```

Schema names alone do not establish exact DDL. Use0226 SQL hashes and full schema
comparison; its active uniqueness is `(issuer,login_email)` and `(issuer,access_subject)`.
Alternate login requires the real claimed intent, matching canonical identity/generation,
current binding version/status and original authentication-time constraints. Never
manufacture a claimed intent or bypass triggers to seed an alias.

## 4. Source and subject authority: known references versus missing proof

Known approved synthetic continuity references from the existing iPad staging handoff:
source `project-alpha:staging`, organization `797929b4-a4e4-48a1-bdf6-e427c5799153`,
project `37965806-220f-437a-a378-d393245d9f2a`. These are not proof that corresponding
rows were imported into the new Ops D1 or permission to create new membership/grants.

Still **missing** for this target: exact verified new-team Access subject and its
authorized canonical Ops staff ID; preserved/current native profile/admission/cohort
mapping; approved exact permission scope; current connector deployment manifest/registry
mapping and public key commitments; approved synthetic operation ID and row ownership
for a nonempty Operations read. Access's allowed email list, old-team subject, project
name and raw fixture owner seed cannot supply those facts. No new grants are implied.

The new reader config already sets `PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED=true`,
but supplies no `PROJECT_ALPHA_CONNECTOR_SOURCES` manifest. Therefore Operations reads
must remain unavailable until an exact reviewed manifest and matching registry exist.
Do not turn required=false or rely on legacy primary fallback to get an empty success.
`prepareProjectAlphaReadOnlySnapshot` and same-batch registry/revision verification
require the actual source/revision/read_visible/state/public commitment tuple, including
hidden/disabled sibling handling. They do not need draft-quote write secrets for this GET.

`operations.view` is mandatory. Administrators/global explicit operations.view_all use
current reviewed source visibility; ordinary assignment filtering additionally hard-pins
`project-alpha:primary` and requires project_alpha_user_id/current assignment. A staging
source assignment must not be relabeled primary just to pass. Choose the actually approved
synthetic owner/staff scope, or review a separate source-aware authorization successor.
Every final query rechecks login/admission, ACL and connector snapshot in the same batch.

**Business-root/project APIs are absent from the deployed facade.** No newer source is
needed for its existing generic session/Operations protocol, but schema/authority alone
cannot make iPad business APIs work there. The legacy `ios-pilot-business-authority.ts`
still hard-pins old origin/team/audiences and `project-alpha:staging`. Any extension needs
an exact reviewed new-tuple authority and matching edge/RPC/native protocol successor
through its source owner. Do not weaken those pins or advertise unsupported routes.

## 5. Bounded validation and next application decision

Current local qualification at38bf, no provider/record calls:

- Existing Operations full-schema test applied all235 physical SQL files and matched
  ledger names, foreign-key integrity and default-off Intel/release controls:1/1 pass,
 65.88seconds. The synthetic0002 transformation is test-only, as described above.
- Existing Client joined dual-source test applied all164 Client SQL files:7/7 pass,
 71.85seconds; explicit identity/sibling isolation, revocation and synthetic public-share
 preservation. Portal schema is not a binding dependency of the closed iOS reader.
- Prior exact751 iOS26-test qualification covers private/default404 surfaces, config
  pins, strict edge/RPC envelopes and wrong-DTO rejection. It does not prove real OAuth,
  new-team subject mapping or successful nonempty business reads. No duplicate run needed
  for this documentation-only plan. Both new emulator processes disposed; shared ones kept.

Merger's next decision is exact seed/data/subject/source mapping, not backup storage.
Once approved and installed, prove actual human OAuth/PKCE and both Access-context/JWT
checks, exact subject resolution, nonempty authorized list/detail, wrong source/project/
sibling denial, no write/malformed/query/cookie acceptance, expiry, permission/subject/
binding revocation and restart. Negative outcomes must remain distinguishable from a
successful empty list. Capture safe revision/status/correlation metadata; no tokens or
client rows in receipts. Retain old sign-in/data/pins until replacement acceptance.
This iOS readiness plan does not replace the full Ops/Portal graph, actual public-link
and48-hour frontend retention proof, Intel feed acceptance or production release.
