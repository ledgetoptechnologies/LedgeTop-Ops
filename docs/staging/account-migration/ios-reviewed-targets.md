# Reviewed iOS targets in the separate Staging account

Merger owns resource creation, upload, deployment and acceptance. These are new closed
source configs; the legacy iOS Wrangler files are retained unchanged. Neither config
enables a route, workers.dev, previews, managed reads or an OAuth probe. No secrets,
private keys, source credentials, staff records or access grants are provisioned here.

| Candidate | New source config | Entry surface |
| --- | --- | --- |
| `ledge-top-ios-edge-staging` | `apps/operations/wrangler.ios-pilot-edge-staging-account.jsonc` | `staging-ios-edge-entrypoint.ts`: default guarded HTTP only |
| `ledge-top-ios-read-staging` | `apps/operations/wrangler.ios-pilot-read-staging-account.jsonc` | `staging-ios-private-read-entrypoint.ts`: `IosPilotReadService.read` and always-404 default HTTP |

The edge has exactly one service binding: `IOS_PILOT_READ` to `ledge-top-ios-read-staging`,
entrypoint `IosPilotReadService`. Only the reader binds D1 `OPS_DB`, allocated
`ledge-top-ops-staging` / `a58ea102-f04d-417a-bfd1-b0654cfeb503`, in Staging account
`df3f376bae6ee621f50cf972ebcc9484`. No broader Operations handler, write RPC or Workflow
entrypoint is exported by either candidate. Existing compatibility date/flags are retained;
no unrelated runtime-date upgrade is included.

## Reviewed public identity metadata

Both configs use issuer/team `https://ledge-top-staging.cloudflareaccess.com`.

- Pilot resource: `https://ledge-top-ios-edge-staging.ledge-top-staging.workers.dev`, Access
  app `3ebfae1c-321b-46c6-ba56-6be95f95c50f`, audience
  `17f32ab9f964a3e4c64864e06d3d0e1b128604192b9a7e457db1f8f88b8f5707`.
- Separate registered Ops resource: `https://ledge-top-ops-staging.ledge-top-staging.workers.dev`,
  app `37c5049c-a787-49cf-ac43-ba4d340bee70`, audience
  `ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84`.
  Merger's readback records a deny-everyone policy with no allow policy. This is a registered
  namespace/audience, not a working Ops sign-in or authority source.

The source-controlled frozen resource-origin list adds only the exact reviewed pilot host,
retaining `https://ios-pilot-staging.ledgetop.app`. Environment values cannot expand it.
The public audiences above are identifiers, not credentials. Receipt paths/hashes are pinned
in the offline migration contract. Provider creation and OAuth metadata were verified by
Merger; backend deployment, new source authority and synthetic acceptance remain unverified.
Keep the exact native callback `com.ledgetoptechnologies.ops.pilot://auth/callback`, public
client PKCE/S256, 24-hour app / 30-minute grant and no localhost/loopback exception. This
source change does not alter Access policies or change the installed iPad's current pins.

## Acceptance prerequisites and source limitations

1. Read actual selected module versions/settings and private binding graph in Staging before
   any new upload/activation. Use a fresh immutable packet, not an old consumed deployment
   journal. Both new candidates remain closed until a separately reviewed activation.
2. Rehearse the exact required migration chain and compare actual schema/ledger before
   applying. The allocated database is not proof of installed tables or authority. Native
   staff/session admission, verified login bindings, current roles/scopes/denials, and the
   PA projection/source-manifest/key commitments needed by the selected read path must exist.
3. Use the already approved synthetic source `project-alpha:staging`, organization
   `797929b4-a4e4-48a1-bdf6-e427c5799153` and project
   `37965806-220f-437a-a378-d393245d9f2a` only after their mapping is preserved or explicitly
   approved. Their identifiers are continuity references, not authority to create copies,
   membership or grants. No real client data or production credentials are needed here.
4. A verified Staging issuer/subject must resolve to the intended active native Ops staff
   identity and current admission/permission scope. Email equality or the Access app's
   principal allow list cannot manufacture a staff binding. Ops' registered app is deny-all;
   any later controlled human admission belongs to Merger's separate review.
5. **Business-root/project APIs are not supplied by this candidate.** The selected edge/
   reader protocol currently handles session and Operations list/detail. Existing
   `ios-pilot-business-authority.ts` still pins the legacy origin/team/Operations and pilot
   audiences and only source `project-alpha:staging`. Those hard pins are left intact.
   A separate exact reviewed tuple and matching edge/read protocol/source successor is
   required before the iPad's business APIs can work at the new target. Do not remove the
   checks or substitute an environment-widened allow list to make a test pass.
6. Business reads additionally need current Client Hub business roots, source/root mappings,
   valid organization/project projections and explicit staff permissions (`team.view` for
   roots, `projects.view` and scoped current authority for projects). Establish the minimal
   reviewed synthetic rows/issuer/source bindings from the actual selected migrations and
   matching receipts; this document does not authorize arbitrary SQL seeding or copy real data.
7. Prove actual human OAuth/PKCE, exact audience/subject mapping, authorized nonempty reads,
   wrong source/project/sibling denial, membership/scope removal, expiry/revocation and restart
   behavior. Local flag-off/predicate/artifact tests do not establish those outcomes. Keep
   old live endpoints, pins and data until replacement acceptance and explicit retirement.

Use the [ordered schema and identity/read plan](ios-schema-read-prerequisites.md) before
application. Beau waived staging backups; no vault, backup key or recovery gate is required.
Credential protection, retained data, exact authority and replacement acceptance still apply.
