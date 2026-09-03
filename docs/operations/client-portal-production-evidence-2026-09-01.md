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
  links, Back/Forward, and mixed-host navigation. For each domain, separately
  record successful sign-in, hard refresh, same-origin Access logout,
  unauthorized/unprovisioned identity denial, cross-tenant denial, and
  membership/grant revocation, plus session-expiry denial on each host. Also
  read back and record that both destinations
  still use the same Access application, audience, and policy set. Hostname is
  never authorization, and a passing result on one domain is not evidence for
  the other.
- The acceptance packet must reference the exact post-change Access
  application/audience/destination/policy readback and the retained pre-change
  Access/custom-domain rollback snapshot. Neither reference is committed here
  yet, so this checkpoint remains incomplete.
- Recheck the canonical public-link boundary in the same acceptance packet:
  an anonymous current link remains reachable without Access on
  `client.ledgetopdroneservices.com`, no Access assertion reaches that Worker
  request, password/expiry/revocation still apply, and the equivalent public
  namespace remains unavailable on `portal.ledgetoptechnologies.com`.

## 2026-09-02 migration and Client Hub follow-up

This follow-up narrows two uncertainties from the September 1 checkpoint. It
does not activate Project Alpha portal projection or establish signed-in portal
acceptance.

- Remote Wrangler migration readback reported no pending Operations migrations
  against the current main migration directory, which now ends at
  `0051_client_hub_internal_notes.sql`.
- Remote Wrangler migration readback reported no pending Client migrations
  against the current main migration directory, which now ends at
  `0190_portal_contact_assignments_v4.sql`.
- In the live signed-in Operations Client Hub, internal notes loaded for both an
  organization root and a standalone-client root. The panel clearly stated that
  notes are staff-only and are neither shown in the client portal nor
  synchronized to Project Alpha. No browser warnings or errors were observed.
- At a 375-pixel viewport, the internal-notes region and both actions remained
  within the viewport with no horizontal overflow. The viewport override was
  reset after the check.
- Live Client Hub search reduced the 22-record directory to the single expected
  organization while typing, without submitting the Search button, and emitted
  no browser warning or error.
- The focused migrated-D1 notes test passed create, update, audited soft-delete,
  immutable history, idempotent replay, and exact source/root isolation. No
  synthetic note was written to production during this read-only acceptance.

These observations establish migration parity and read-only usability for this
Client Hub slice. They do not replace a deliberate production mutation test for
note create/edit/delete, and they do not change the portal-projection blockers
below.

### Windows full-suite transport limitation

The post-`0191` monolithic Client suite on Windows did not produce a clean
package-level result. Two unrelated concurrent Miniflare tests failed at the
loopback transport with `fetch failed`; a repeated projection-file run exposed
the underlying cause as `connect EADDRINUSE 127.0.0.1:49202`. At that point the
host had 2,043 loopback sockets in `TIME_WAIT` inside Windows' 16,384-port
dynamic range. This is a test-runtime transport limit, not a D1 assertion or
portal state failure.

The exact portal staging race passed 10/10 in fresh isolated processes, the
invitation publication race passed 4/4, and both exact cases passed together
2/2. The focused portal projection group also passed 34/34 after the wire
contract fix. Do not add automatic retries around these mutations: a transport
failure is commit-ambiguous and a retry could hide an actual safety defect. A
Linux CI run, or bounded Windows Miniflare partitions with socket recovery
between them, remains required for an authoritative complete-package gate.

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

The exact dependency and rollback order is now maintained in
[client-portal-rollout-manifest.md](client-portal-rollout-manifest.md). This
production record remains the only place to add observed live results.

## 2026-09-02 receiver release checkpoint

This checkpoint records receiver readiness only. It did not enable a dormant
portal capability, create a membership, send a notification, or modify a
Project Alpha onboarding, approval, project, contract, or document workflow.

- LTDS commit `55452115549ed8a1872f94791176bd3ceb06d0bf` was fast-forwarded to
  `main` after its focused type, build, unit, browser, migration, wire-contract,
  and source-layout gates passed.
- Client Worker version `dcbca970-7510-44d5-9ec6-f53b4e9dcf76` and Operations
  Worker version `847030a1-a9b9-4497-a15b-de28e41a2a82` each reached 100%
  traffic.
- Client migrations `0191_portal_projection_wire_contract_claim.sql` and
  `0192_contact_assignment_billing_independence.sql` were applied after a D1
  Time Travel bookmark was captured. A subsequent migration list was empty and
  `PRAGMA foreign_key_check` returned no rows.
- The canonical schema-v4 fixture has exact-file SHA-256
  `C545EEBF02CEC56013EDE3EBE0DCC1C7C11947DC8E5592905C3A9D36FFDA434B`,
  snapshot hash `fa787865c479b1cbdfaba7361d9dd15e8fa9f7d9ffcdad25fa232e1004f71cfa`,
  and pinned LF line endings.
- The composed Project Alpha producer remains unpublished on
  `codex/portal-auto-onboarding`. It is a strict descendant of Project Alpha
  main `11fca5ff` and preserves the newer onboarding, approval, project,
  contract, and document work. Its full composed gate passed 750 tests with
  6,100 assertions and 91 expected skips. Publication still requires the
  protected feature-branch and pull-request workflow.
- Client schema-v4 receiver coverage passed 35 focused tests. Operations contact
  adapter browser coverage passed 16 desktop/mobile cases, including bounded
  pagination, malformed pages, authorization invalidation, cancellation, and
  late-response fencing.
- The post-`0192` monolithic Windows Client run passed 924 of 926 tests. The two
  failures were isolated Miniflare loopback `EADDRINUSE` transport collisions;
  both exact cases passed in isolated and paired reruns. Linux CI or bounded
  fresh-process partitions remain the authoritative complete-package gate.

Project Alpha contact assignments remain a default-off, informational read
surface. They do not authorize portal access, delivery, requests, billing, or
notifications. This checkpoint therefore improves safe receiver compatibility
without changing any client's effective access.
