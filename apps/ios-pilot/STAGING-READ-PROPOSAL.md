# iPad read-only staging origin proposal

Status: proposal only, 2026-10-30. No provider configuration, rollout, database migration, or activation is authorized by this document. Repeat inventory and reconcile the current release with the Operations owner before changes.

## Dedicated boundary

- Proposed origin: `https://ios-pilot-read-staging.ledgetop.app`.
- Proposed new Worker: `lt-ops-ios-read-edge-staging`, with its own custom domain, no workers.dev or preview exposure, and no assets, database, queues, schedules, or unrelated routes.
- Proposed new self-hosted Access application: `LT Ops iPad Read-Only Staging`, covering exactly that hostname. Its audience must be the new application's provider-issued AUD; it does not exist yet. Enable managed OAuth only after reviewing an exact least-privilege human allow policy, the existing pilot callback `com.ledgetoptechnologies.ops.pilot://auth/callback`, session lifetimes, and revocation behavior. Do not substitute the existing synthetic or production Access audience.
- Edge binding: `IOS_PILOT_READ` as a named RPC service binding to Worker `ledgetop-ops-staging`, entrypoint `IosPilotReadService`. Keep the pilot disabled and reviewed origin allowlists empty until release and security gates are met. Configure the exact proposed origin and the newly issued audience only in the approved activation; pin the Cloudflare team domain to the verified account.
- The target's existing `OPS_DB` must remain the staging database `ltds-ops-staging` (`78b34173-b168-4e3d-9832-bb9d245cc6b8`). Do not attach a database to the edge. The Operations release owner must confirm that the active deployed version actually exports the named entrypoint and is compatible before binding. A prior owner report says version `1ffe4525-7e29-4ea2-a407-726abf7f10c6` does not export it; do not assume that version is current.

A separate hostname and audience avoid converting previously issued synthetic-test grants into business-data access and preserve the existing working test. The origin is a proposed choice, not an existing service. Actual routes, settings and names must be checked against the reviewed implementation, not created from this document blindly.

## Read-only inventory, 2026-10-30

The Cloudflare account named **Ledge Top**, ID `846c924bf17bf4f3dd15c97a4c5d1d51`, owns the `ledgetop.app` zone, the staging Operations Worker, the synthetic pilot Worker, and the listed staging database. Do not infer ownership from names; a separate account named Staging also exists. Zone ID: `4301f5748241d683471ef45bac0da34f`.

The zone DNS UI showed four Worker records: `delivery`, `ios-pilot-staging`, `ops`, and `portal` under `ledgetop.app`. No exact candidate record or wildcard DNS appeared; the zone Workers Routes page showed no routes. Search of the account Workers and Pages UI for the exact proposed Worker name returned no projects. A subsequent authenticated account-wide Workers Domains API inventory returned 29 records on one page with no exact or matching wildcard candidate. This is point-in-time evidence, not proof against future changes or external usage. Repeat checks immediately before any registration or change.

Existing `ios-pilot-staging.ledgetop.app` belongs to synthetic Worker `lt-ops-ios-oauth-probe-staging` and its existing `LT Ops iPad OAuth Test` Access application. Production Operations Access lists `ops.ledgetop.app` among its explicit destinations. Neither should be repointed or modified for this proposal. The Access dashboard listed 18 applications on one page; all multi-destination popovers were expanded and showed no exact or wildcard destination matching the candidate. This UI inventory is point-in-time and should be repeated before activation; it is not proof against hidden API-only resources or later changes. The existing test app has managed OAuth and the callback above; that fact does not authorize or configure the new application.

In one provider-backed test on the existing synthetic host, Worker version
`8734b328-9671-4b75-ae38-9aacc7693346` independently validated the signed
assertion and compared its subject and email with runtime Access identity;
Beau reported the iPad showed a match. That is evidence for the observed
request only, not for every identity or for the proposed new read-only host.

Later on October 30, the Operations staging migration ledger advanced to 228;
do not rely on the older ledger-225 baseline. A fresh read-only structural
preflight against the verified staging database found native reconciliation
disabled, all five alternate-login tables absent, and both connectors with
matching active revision rows. The required staff, operation, project and
division query shapes compiled with zero reported writes. This does not prove
the human identity binding, current permissions, connector-manifest alignment,
or deployed pilot RPC; no identity or record values were returned. Recheck the
ledger and actual active deployment immediately before release.

## Gates before activation

1. Confirm all Access destination patterns, account custom domains, DNS and Worker names are collision-free, verify exact account and target ownership again, and inspect the actual Operations deployment and staging database binding. Coordinate the change with the shared Operations release owner; do not replace the shared staging deployment independently.
2. Verify the target release, schema, source eligibility, and the signed-in person's matching active legacy staff record and read permissions. The Operations owner reported native reconciliation disabled and alternate-login tables absent in the current staging environment; this must be reconciled with the actual deployed version and source, without changing data or granting access as a shortcut.
3. Review narrowly scoped Access policy, token audience and trusted identity verification, and server-side endpoint/method restrictions. Verify the edge receives the Access context directly; service bindings do not automatically propagate it. Validate allowed request types against the actual reviewed implementation.
4. Run negative tests for missing, expired, wrong-audience, wrong-subject, unauthorized or disabled identity, and non-read requests. Verify a valid pilot credential cannot invoke ordinary Operations writes, and verify no normal read causes an unintended mutation. Investigate the observed refresh-token replay and revoke limitations before relying on refresh or claiming provider-side revocation.
5. Only after the above, exercise the human-authorized staging reads and correct empty/error states, then deliver the updated app in place. Production data, broader authorization, and write operations remain out of scope.

References: [Access on Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), [Service binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).
