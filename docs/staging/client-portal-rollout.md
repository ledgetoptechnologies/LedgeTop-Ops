# Client portal staging rollout and rollback

Status: plan only. No Cloudflare, DNS, Access, secret, migration, Worker, or
Project Alpha mutation is authorized by this document. The checked-in and
ignored staging configuration must end with `CLIENT_PORTAL_ENABLED=false`.

## Fixed staging topology

- Existing Worker: `ltds-delivery-staging`; do not create or rename a Worker.
- Rollback/admin host: `delivery-staging.ledgetopdroneservices.com`.
- Client test host and canonical public origin:
  `client-staging.ledgetopdroneservices.com`.
- Dedicated Access app: `LTDS Client Portal Staging`, with a new app ID and
  audience that are not any Delivery, Operations, or Ops Sync value.
- Dedicated group: `LTDS Client Portal Staging Testers`; never use the staff,
  Operations, Ops Sync, or production client group.
- Portal app destinations: `/portal`, `/portal/*`, `/api/client`, and
  `/api/client/*` on the client test host.
- Public app: `LTDS Client Public Staging`, with the client test hostname as its
  root destination and a Bypass Everyone policy. The more-specific portal paths
  must retain the dedicated portal Allow policy. The release-critical public
  path families are `/`, `/s/*`, `/api/public/*`, `/health`, and `/assets/*`;
  each remains subject to the Worker's routing and authorization behavior.

The public Bypass policy is not client authentication. It exists so the
password/revocation/session-controlled share flow remains reachable without an
Access login. The Worker must receive no `Cf-Access-Jwt-Assertion` on a public
share request, and a portal delivery handoff must re-run the public-share
password and session contract. Do not configure a host-wide client Allow
policy. Cloudflare documents specific application paths and precedence in
[Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
and warns that Bypass disables Access enforcement in
[Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

## Prerequisites and hold points

1. Pin the reviewed commit and record the current staging Worker version,
   routes, bindings, Access apps/policies, and both D1 migration lists.
2. Resolve the Project Alpha payment/billing contract. It is a release
   dependency only; it does not grant an LTDS account, project, delivery,
   request, team, staff, or billing permission and cannot waive local ACLs.
3. Obtain separate approvals for Access/DNS/routes, staging migrations,
   staging deployment, and temporary portal activation. Production remains out
   of scope.
4. Create the dedicated client group, portal path app, and public Bypass app
   before publishing the hostname. Re-list their IDs, destinations, policies,
   group membership, and audience. Keep the client group invitation-owned and
   separate from staff ACL automation.
5. Put the new audience only in the ignored staging config. Set the exact
   client origin/team domain and keep `CLIENT_PORTAL_ENABLED=false`.

## Ordered rollout

1. Run `npm.cmd run staging:check:test`, the repository tests, and build from
   the pinned commit. Record all config hashes.
2. Export both staging D1 databases. List migrations and confirm only Delivery
   `0096`–`0109` and Operations `0014`–`0018` are newly expected for the current
   combined release; `0096`–`0106` and `0014`–`0017` were the original
   portal-only milestone. Client `0100` is required because a portal delivery grant must
   not make `share_version` a foreign-key parent that blocks existing
   rotation/revocation updates; authorization still compares the recorded
   version and fails closed after rotation. Client `0103` adds the request
   workspace and `0104` adds revisions, immutable operational-estimate versions,
   and the rebuilt notification dedupe contract. Client `0105` adds direct
   client-folder grants, `0106` adds thumbnail jobs, `0107`/`0108` add cleanup
   and resumable backfill, `0109` adds minimal version-bound image locations,
   Operations `0017` adds job briefs, and `0018` adds
   authenticated browser-upload intent/session state.
3. After migration approval, apply Delivery migrations first and Operations
   `0014`–`0018` second. Record the list/apply output and confirm production
   migration state was not touched.
4. Upload a version with the portal false and inspect routes, bindings, vars,
   and secret names. Deploy only that reviewed version after deployment
   approval.
5. Verify `client-staging` DNS/TLS, `/health`, and a `404` for `/api/client/*`.
   Verify public shares are reachable without Access, an Access assertion is
   absent, a password-protected share still requires its password, and revoked
   or expired shares remain denied.
6. Only after a separate temporary-activation approval, create a new reviewed
   staging version with the portal true. Test valid client login, invalid
   audience, unprovisioned identity, revoked membership, cross-account/project
   denial, staff/client ACL separation, team-manager restrictions, request
   idempotency/rate limiting, request status notification outbox, delivery
   handoff, logout/session expiry, and public-share isolation.
7. Restore the reviewed false configuration in a new staging version. Re-run
   the disabled `404` and public-share checks. Complete
   `release-evidence.json.example`; it cannot pass until the final false state,
   exact Access/public-path contract, migration evidence, and test evidence are
   all recorded.

## Rollback

Stop on unexpected access, cross-account data, missing password challenge,
Access assertion on a public path, schema error, notification leakage, or
route drift.

1. Preserve request IDs, logs, version IDs, Access/DNS exports, and D1 evidence.
2. Deploy the recorded portal-false staging version. If necessary, restore the
   prior `delivery-staging` version while leaving both D1 databases and all
   bound resources intact.
3. Remove traffic from `client-staging` only after `delivery-staging` health
   and public-share checks pass. Disable (do not silently repurpose) the client
   portal and public Bypass Access apps.
4. Do not reverse migrations 0096–0109 or 0014–0018. Use a
   reviewed forward fix. Do not delete D1/R2 data, queues, workflows, secrets,
   groups, or audit/outbox evidence during incident handling.
5. Re-run public-share and Delivery health checks and record the final route,
   version, policy, and feature-flag state.

Production uses a separate authorization, audience, group, hostname evidence
packet, and rollback review. Staging success is necessary but never production
authorization.
