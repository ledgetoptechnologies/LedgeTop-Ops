# Client portal staging rollout and rollback

Status: plan only. No Cloudflare, DNS, Access, secret, migration, Worker, or
Project Alpha mutation is authorized by this document. The checked-in and
ignored staging configuration must end with `CLIENT_PORTAL_ENABLED=false`.

## Fixed staging topology

- Existing Worker: `ltds-delivery-staging`; do not create or rename a Worker.
- Anonymous public-share host and canonical public origin:
  `delivery-staging.ledgetopdroneservices.com`.
- Authenticated client portal host:
  `client-staging.ledgetopdroneservices.com`.
- Dedicated Access app: `LTDS Client Portal Staging`, with a new app ID and
  audience that are not any Delivery, Operations, or Ops Sync value.
- Dedicated group: `LTDS Client Portal Staging Testers`; never use the staff,
  Operations, Ops Sync, or production client group.
- Portal app destinations: `/portal`, `/portal/*`, `/api/client`, and
  `/api/client/*` on the client test host.
- Public app: `LTDS Client Public Staging`, with the anonymous delivery hostname
  as its root destination and a Bypass Everyone policy. The portal host retains
  the dedicated portal Allow policy. The release-critical public
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
   before publishing either hostname. Re-list their IDs, destinations, policies,
   group membership, and audience. Keep the client group invitation-owned and
   separate from staff ACL automation.
5. Put the single new human audience only in the ignored staging config. Set
   the exact authenticated client origin/team domain. Treat Client
   `EXPECTED_HOST`, Client and Operations `PUBLIC_SHARE_ORIGIN`, Client
   `PUBLIC_BASE_URL`, Operations `DELIVERY_BASE_URL`, and Client
   `CLIENT_PORTAL_ORIGIN` as one reviewed cutover set. The Client
   `EXPECTED_HOST` must equal the anonymous delivery hostname; never move the
   origins without it. Keep `CLIENT_PORTAL_ENABLED=false`.

## Ordered rollout

1. Run `npm.cmd run staging:check:test`, the repository tests, and build from
   the pinned commit. Record all config hashes.
2. Export both staging D1 databases. List migrations and confirm the exact
   filename sets in `REQUIRED_STAGING_MIGRATIONS`, including
   `0177_domain_neutral_delivery_notifications.sql` and
   `0178_domain_neutral_delivery_notification_contract.sql`. Migration `0113` is
   intentionally reserved and absent. The
   release evidence validator compares the complete filename sets; do not
   shorten them to a range or infer success from a local migration run.
3. Apply only Delivery migration `0177` first. It is the expand phase and keeps
   legacy `shareUrl` writers and queued notifications compatible. Deploy the
   reviewed domain-neutral Operations sender/writer while the existing host
   configuration remains unchanged. Pause notification producers, drain
   `queued`, `sending`, and retryable `failed` rows, and prove send-time URL
   materialization with the current encryption key, the configured previous
   key, and a valid legacy row whose encrypted secret is absent. A malformed
   or unrecoverable row is a stop condition, not permission to discard it.
4. Apply Delivery migration `0178` only after that drain proof. Its deterministic
   preflight aborts before deleting any active legacy URL whose referenced
   share lacks encrypted secret material. It then removes stored fragments and
   rejects old writers. Do not roll application code back to an old writer
   after `0178`; use a compatible fix-forward build. Apply the remaining
   approved Delivery migrations and Operations `0014`-`0023`, record the
   list/apply output, and confirm production migration state was not touched.
   In this release packet, `idempotentReapplyPassed` means rerunning
   `wrangler d1 migrations apply` against the same database and migration
   ledger returns `No migrations to apply`. It does **not** mean executing the
   raw SQL files a second time. Several historical migrations are deliberately
   ledger-once because SQLite does not support idempotent forms for every
   `ALTER TABLE` or `CREATE TABLE` operation. Never bypass `d1_migrations` to
   manufacture reapply evidence.
5. Upload a version with the portal false and inspect routes, bindings, vars,
   and secret names. Deploy only that reviewed version after deployment
   approval.
6. Atomically apply the reviewed hostname/origin set from prerequisite 5 with
   the corresponding DNS, routes, and Access applications. Verify both staging
   hosts' DNS/TLS and `/health`, then verify a `404` for
   disabled `/api/client/*`. Prove public namespaces fail on `client-staging`
   and portal namespaces fail on `delivery-staging`. Verify public shares are
   reachable without Access, an Access assertion is
   absent, a password-protected share still requires its password, and revoked
   or expired shares remain denied.
7. Verify `/assets/*` is Worker-first on both exact hosts because both SPAs use
   the same immutable build assets. Encoded traversal must be rejected, and an
   asset-shaped path must not reach `/portal`, `/api/client`, `/s`,
   `/client-share`, or `/api/public`. Verify the Access cookie remains
   host-local (no `Domain` attribute), the single human Access audience is used
   only on the authenticated host, and persisted notification payloads contain
   no fragment-bearing share URL.
8. Only after a separate temporary-activation approval, create a new reviewed
   staging version with the portal true. Test valid client login, invalid
   audience, unprovisioned identity, revoked membership, cross-account/project
   denial, staff/client ACL separation, team-manager restrictions, request
   idempotency/rate limiting, request status notification outbox, delivery
   handoff, logout/session expiry, and public-share isolation.
9. Restore the reviewed false configuration in a new staging version. Re-run
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
- the byte-pinned neutral `portal-integration-wire-v1.json` corpus passing in
  both repositories, including dynamic application-key command paths and the
  exact projection body/path/key-ID canonical string;
- PA relation/lifecycle contract fixtures, many-to-many scope parity, deny
  precedence, completed-project day-30 cutoff, and reopen restoration. Keep
  `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=false` until all are recorded.
- migration `0136_portal_v2_identity_denials.sql`, reviewed staff/system
  mutation ownership, immutable audit evidence, and staging tests showing that
  global and hierarchy-scoped denials take effect on the next request, expire
  as configured, and restore only authority still permitted by the live
  identity, membership, hierarchy, and entitlement state. Keep
  `CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED=false` until that mutation surface
  and evidence exist; the client Worker intentionally exposes no public
  endpoint for creating or revoking deny records.
- migration `0137_authenticated_delivery_grants.sql`, the separately disabled
  staff management and Client enforcement flags, exact-person and dynamic
  organization/department/client/project audience behavior, idempotent
  create/revoke/restore, binding/source-version invalidation, and proof that a
  revoked parent grant suspends every descendant client-created public share.
  Keep `AUTHENTICATED_DELIVERY_GRANTS_ENABLED=false` in both Workers and
  `CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED=false` in Operations until the
  same reviewed staging packet proves the Operations UI/API and Client
  enforcement together.

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
2. Deploy the recorded portal-false, contract-compatible staging version. If
   necessary, restore the prior reviewed compatible version while leaving both
   D1 databases and all bound resources intact. Restore `EXPECTED_HOST`, both
   `PUBLIC_SHARE_ORIGIN` values, Client `PUBLIC_BASE_URL`, Operations
   `DELIVERY_BASE_URL`, Client `CLIENT_PORTAL_ORIGIN`, routes, DNS, and Access
   policies as one set. Never restore an old fragment-writing build after
   migration `0178`.
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
