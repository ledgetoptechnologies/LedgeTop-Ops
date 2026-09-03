# Client Portal Access consolidation — September 3, 2026

This record covers the authorized Cloudflare Access configuration change only.
It does not establish authenticated portal workflow acceptance, provisioning,
migration readiness, or deployment of the prepared application changes. Track
those requirements in the [goal acceptance checklist](client-portal-goal-acceptance.md),
especially the joined dual-domain workflow J7.

## Verified final configuration

| Application | Protected destinations | Retained audience |
| --- | --- | --- |
| LTDS Client Portal (`34439cca-fa0b-43e2-a830-bd569e303e68`) | `/portal*` and `/api/client*` on both `portal.ledgetopdroneservices.com` and `portal.ledgetoptechnologies.com` | `0fa9c4453634e4c74d4522e2d44407a49701320b06d8f21d8a58efa21e5f947f` |
| LTDS Client Portal - Legacy Client Domain (`ce8e60fa-47a7-42e3-b38a-460c0810d173`) | `/portal*` and `/api/client*` on `client.ledgetopdroneservices.com` | `3bc9637846ccf4e1343b969cc8f14ed2cb0628956293463cf164c4080fa47e57` |

The secondary application was renamed and now owns the legacy paths instead
of the canonical portal paths. Both client audiences remain accepted by the
Worker. Do not remove the legacy audience or equate an Access sign-in with
workspace membership or delivery authority.

Policy rules were preserved; timestamps alone changed. Eight unrelated
applications, including machine/public boundaries and Operations, were
unchanged. Operations already protects both Operations domains under one
application. The temporary deny guard used for the path transfer was removed
successfully after the transfer.

## Live evidence and limits

- Six unauthenticated probes, covering portal and client API paths on all
  three hosts, returned HTTP 302 to sign-in with the expected audience.
- Public `/s/` fake-link shells returned HTTP 200 without an Access redirect.
  This proves the tested public shell remains outside Access, not that a real
  shared file was authorized or downloaded.
- Fully authenticated client workflows were **not** tested in this change.
  Sign-in completion, refresh, logout, expiration, revocation, cross-tenant
  denial, and both-domain daily workflows remain separate acceptance gates.
- No Worker deployment or container update was part of this change.

## Rollback and future edits

A protected path cannot belong to two Access applications simultaneously.
Do not attempt an add-first duplicate destination transfer or remove old
coverage without a protected transition. An interruption to private pages and
API requests was explicitly authorized for this change; obtain fresh operator
approval for a later maintenance window.

Before rollback, read back and preserve the current destinations, policies,
audiences, and independent service/public applications. Use a verified temporary
deny guard while transferring ownership. To restore the preceding topology,
return the canonical Drone Services portal paths to the secondary application
and legacy client paths to the original application; Technologies portal paths
remain on the original application. Preserve the original policy rules and both
accepted audiences. Read back complete destination and policy coverage before
removing the guard, then prove the guard is gone and repeat all six private-path
probes and public-link isolation checks. Never combine human
Access with service-auth projection or public-link bypass applications.
