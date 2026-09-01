# Client portal production evidence — 2026-09-01

This record captures the production state observed after the dual-domain
Cloudflare Access change. It contains no identities, tokens, public-share IDs,
or secret values. It is evidence for the current rollout only; it is not a
claim that the complete client-portal goal is live accepted.

## Cloudflare Access admission

- The existing `LTDS Client Portal` Access application was updated in place.
  Its application ID, audience, allow policy, and 24-hour session duration were
  preserved.
- The application protects these destinations:
  - `client.ledgetopdroneservices.com/portal*`
  - `client.ledgetopdroneservices.com/api/client*`
  - `portal.ledgetoptechnologies.com/portal*`
  - `portal.ledgetoptechnologies.com/api/client*`
- An aggregate Cloudflare Access policy test completed with four evaluated
  identities: one allowed, three blocked, and zero evaluation errors. Individual
  identity details were deliberately not exported into this repository.
- Anonymous requests to `/portal` and `/api/client/workspace` on both domains
  redirect to the same Access application. This proves edge admission, not LTDS
  workspace authorization.
- Existing public-share applications remain canonical-host-only bypasses for
  `/s/*`, `/client-share/*`, and `/api/public/shares/*`. A sampled active public
  link continued to load on `client.ledgetopdroneservices.com`; the Technologies
  portal hostname returned not found for the same public namespace.

## Database and deployment state

- Operations production migrations through `0050` and Client production
  migrations through `0186` were applied and their remote migration lists were
  empty afterward.
- Time Travel bookmarks were captured before the migration run and retained in
  the private release session. They are not credentials and are intentionally
  not committed here.
- Operations and Client code at commit `ce0d7aa356603e7dc53db62ee7ae8975a82e4868`
  passed the relevant local migration, unit, browser, build, and security gates.
- Production Client Hub indexing reported ready and contained 22 active roots.
  At the same checkpoint, no root was linked to a portal workspace.
- Client production contained one active verified identity but zero active
  portal workspaces and zero active workspace memberships. Authentication alone
  therefore cannot grant a usable workspace.
- The Operations exact-source connector registry contained zero active
  connectors. The visible legacy Project Alpha integration must not be described
  as enrolled exact-source portal authority.

## Deliberate blockers

- Deployed secret-name inventory did not contain
  `PROJECT_ALPHA_CONNECTOR_CREDENTIALS` on Operations or Client. Client also did
  not expose the paired Project Alpha portal HMAC secret name. Secret values were
  never read. Do not infer or reuse the legacy read-only Project Alpha API key as
  connector, event, portal, or draft-quote authority.
- Keep Project Alpha projection, hierarchy, membership, invitation, delegated
  access, authenticated-delivery, notification, request, attachment, peer-admin,
  deny-management, and address-book rollout flags off until each dependency in
  `client-portal-goal-acceptance.md` is live proven.
- Request attachments additionally require a pinned scanner, a restricted
  scanner receipt secret, least-privilege R2 signing credentials, and a readback
  of a consolidated production CORS policy that retains Operations staff upload
  access while allowing both exact portal origins.
- Signed-in acceptance remains outstanding. It must cover both domains, direct
  links, hard refresh, Back/Forward, mixed-host navigation, an unprovisioned
  identity, explicit workspace membership, cross-tenant denial, revocation, and
  session expiry. Hostname is never authorization.

## Next safe activation sequence

1. Provision the reviewed connector credential envelope independently to every
   required Worker and enroll the existing primary producer using its exact,
   reviewed identity. Do not infer fields from historical projections.
2. Prove signed projection parity and recovery, then enable hierarchy read-only.
3. Explicitly create one workspace and one membership for a reviewed pilot
   identity. Access allow-policy membership alone must not create either record.
4. Run the joined two-domain and tenant-isolation acceptance suite, including
   revocation during reads.
5. Enable later capabilities one closed dependency window at a time, retaining
   the false flag and rollback evidence for every window.

