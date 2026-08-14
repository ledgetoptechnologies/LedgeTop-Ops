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
  path families are `/`, `/s/*`, `/client-share/*`, `/api/public/*`, `/health`, and `/assets/*`;
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
2. Export both staging D1 databases. List migrations and confirm the exact
   Delivery release set `0096`-`0112`, `0114`-`0133`, plus Operations
   `0014`-`0023`. Migration `0113` is intentionally reserved and absent. The
   release evidence validator compares the complete filename sets; do not
   shorten them to a range or infer success from a local migration run.
3. After migration approval, apply Delivery migrations first and Operations
   `0014`-`0023` second. Record the list/apply output and confirm production
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

## Independent portal-v2 activation gates

Release preparation keeps every new capability explicitly `false`. Before any
flag is enabled, the evidence packet must include a current, referenced staging
result for every dependency below, even when Project Alpha or an infrastructure
operator owns that dependency:

- complete Project Alpha hierarchy and Service Library projection, pricing
  hints, and draft-quote command contracts;
- a real malware scanner plus quarantine lifecycle and alert ownership;
- attachment-specific R2 credentials, exact-origin CORS, and an out-of-scope
  PUT denial test;
- invitation email delivery, verified Access enrollment, and staff manager
  recovery;
- the private Operations delegated-share signer binding and complete public
  authorization path;
- projection parity/staleness monitors and alerts.
- PA relation/lifecycle contract fixtures, many-to-many scope parity, deny
  precedence, completed-project day-30 cutoff, and reopen restoration. Keep
  `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=false` until all are recorded.

The exact staging attachment policy is
`docs/staging/request-attachments-r2-cors.json`; the preflight reads that file
and rejects wildcard origins/headers or method drift. Apply it only to
`client-data-staging` after separate R2 approval, then record `cors list` plus
allowed-origin and denied-origin browser results.

Autonomous invitation email is additionally blocked by
`CLIENT_PORTAL_ACCESS_ENROLLMENT_READY=false`. Do not assert readiness from a
manually enrolled tester or the legacy account-scoped Access outbox. Evidence
must identify a dedicated internal workspace reconciler and prove that every
email lease has a live receipt bound to the exact invitation, workspace,
normalized-email hash, current invitation-token hash, and monotonic enrollment
version. It must also prove receipt revocation at the lease/send boundary,
retention while another workspace remains eligible, removal after final
eligibility, and zero staff-group mutation. Until that external component
exists, invitation creation may remain locally testable but scheduled email
delivery stays fail-closed.

`staging:evidence:check` rejects a packet that omits any one of these gates.

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
4. Do not reverse any migration in the recorded release set. Use a
   reviewed forward fix. Do not delete D1/R2 data, queues, workflows, secrets,
   groups, or audit/outbox evidence during incident handling.
5. Re-run public-share and Delivery health checks and record the final route,
   version, policy, and feature-flag state.

Production uses a separate authorization, audience, group, hostname evidence
packet, and rollback review. Staging success is necessary but never production
authorization.
