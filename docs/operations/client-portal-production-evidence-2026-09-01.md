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
- The fixture-driven J2 joined receiver test
  `joined-portal-metadata-authority.test.ts` passed against the full local Client
  migration chain through `0192`. One signed schema-v4 hierarchy/contact
  generation and one exact-source service-assignment generation were activated,
  tombstoned, and root-revoked while membership, authenticated delivery grant,
  service-request, delivery-notification, and portal-notification authority
  tables remained empty throughout.
- The fixture-driven J1 joined Operations test
  `joined-business-party-isolation.test.ts` passed with two Project Alpha
  organizations that deliberately shared both display name and contact email.
  Source-qualified pages and cursors remained independent; a reviewed
  business-party link changed presentation only; source loss, archive, restore,
  unlink, and relink followed the reviewed lifecycle; and the two portal
  identities, workspaces, memberships, entitlements, and immutable source-ID
  mappings remained unchanged and distinct.
- The fixture-driven J3 joined Operations test
  `joined-operational-memory-copy-forward.test.ts` passed against the canonical
  local migration chain. Organization and project contacts, terminal versioned
  memory, historical reads, and explicitly selected recurring content copied
  forward; attachments, billing, project status, access authority, invitations,
  and notifications did not. A destination reassignment between preview and
  commit failed closed, and stale terminal amendments were rejected.
- The fixture-driven J4 joined Client test
  `joined-membership-delegated-access.test.ts` passed against the current full
  migration chain. Named invitation/acceptance, manager recovery, independent
  delegated-link revocation, project-term completion and expiry, notices, and
  audit isolation remained fail closed. It exposed and now regresses a
  current-schema SQLite expression-depth failure in peer-admin changes; the
  repaired authorization snapshot and atomic fence retain exact principal,
  capacity, deny, CAS, last-manager, and concurrency checks.
- The fixture-driven J5 joined Operations test
  `joined-native-delivery-notifications.test.ts` passed for primary and signed
  secondary sources. It covered exact folder binding, reviewed grant preview
  and publication, portal read, five-minute coalescing, Send Now/Cancel,
  revocation, same-email recipient isolation, leased-binding invalidation,
  lost and legacy receipt denial, unchanged public links, and foreign keys.
- The fixture-driven J6 joined Client test
  `joined-feedback-service-requests.test.ts` passed four cases spanning native
  project/folder/file feedback, completion notice, service catalog and
  assignment filtering, drafts, attachments, review/estimate, immutable exact
  Project Alpha quote handoff, notification, cancellation, and replay. It
  rechecked authority after page load and covered collisions, revocation,
  destination rotation, scan cancellation, and feedback/request independence.
- The post-`0192` monolithic Windows Client run passed 924 of 926 tests. The two
  failures were isolated Miniflare loopback `EADDRINUSE` transport collisions;
  both exact cases passed in isolated and paired reruns. Linux CI or bounded
  fresh-process partitions remain the authoritative complete-package gate.

Project Alpha contact assignments remain a default-off, informational read
surface. They do not authorize portal access, delivery, requests, billing, or
notifications. This checkpoint therefore improves safe receiver compatibility
without changing any client's effective access.

### Signed-in dual-domain read-only follow-up

A signed-in pilot session was inspected without creating or changing any
workspace, membership, grant, request, client, or Project Alpha record.

- `https://portal.ledgetopdroneservices.com/portal` and
  `https://portal.ledgetoptechnologies.com/portal` rendered the same pilot
  workspace and navigation without console warnings or errors.
- Both home pages rendered the personalized heading
  **Hello, LTDS Client Portal Pilot** rather than a generic greeting.
- Direct navigation to `/portal/projects` and a hard refresh preserved the
  project route and the same visible project on both domains.
- At a 375-by-812 viewport, the Technologies portal rendered its mobile
  navigation dialog, Home/Projects/Deliveries/Feedback/Account links, and
  personalized home cards without horizontal document overflow. The viewport
  override was reset after the check.
- The signed-in Operations Client Hub still rendered the canonical navigation,
  dynamic search result, portal-workspace coverage, and exact Project Alpha
  source label without a console error during this observation.
- `https://ops.ledgetoptechnologies.com/clients?q=Delsman` rendered the same
  signed-in Client Hub result as the Drone Services Operations host. A hard
  refresh preserved both the `/clients` route and the `Delsman` query/value,
  and the page emitted no console warning or error.

This is partial J7 evidence only. It does not prove initial Access sign-in,
logout, session expiry, unauthorized or unprovisioned denial, cross-tenant
denial, revocation during an active read, or the post-change Access
application/audience/policy readback. Those cases remain required before J7 is
live accepted.

## 2026-09-02 connection-authority clarification

This checkpoint separates the healthy legacy business-record synchronization
from authenticated portal enrollment. It did not create a connector, provision
a secret, activate a portal capability, or change a client's effective access.

- A signed-in, read-only Operations check showed that the existing primary
  Project Alpha business synchronization remained healthy, with a current
  successful attempt. No exact-source connector card was present.
- A read-only Wrangler secret-name inventory found the legacy
  `PROJECT_ALPHA_API_KEY`, but did not find
  `PROJECT_ALPHA_CONNECTOR_CREDENTIALS` on Operations or Client. The Client
  deployment also did not list the dedicated Project Alpha portal HMAC secret.
  No secret values were read.
- The Administration UI at commit
  `b0ca65bab1f548bae23a2503d21c6e70d7e3563b` now labels these as separate
  states: **Business record sync** and **Authenticated portal connector**. A
  healthy legacy sync can therefore no longer be mistaken for enrolled portal
  authority.
- The production build, source-layout invariants, and all 54 focused Project
  Alpha connection browser cases passed across desktop and mobile before the
  commit was pushed to `main`.
- Post-push Wrangler readback showed Operations version
  `9fde901f-c06e-4359-a527-3c8abcd451db` and Client version
  `b6952c1b-157d-4bd9-8578-5a5ba68bfc44` each serving 100% of traffic. The
  readback listed only secret names and bindings; no secret value was read.
- Project Alpha `main` already contains the unified portal producer and service
  assignment lifecycle from PR #165, followed by the newer contract-scope
  persistence fix in PR #166. The older
  `codex/unified-client-portal-connection` branch must not be merged: its tree
  would regress the newer contract workflow. A separate local descendant adds
  the later schema-v4 contact-assignment producer, but remains unpublished and
  is not required to prove the existing primary producer contract.

The next safe action is a coordinated credential-provisioning and disabled
preflight window against the producer already on Project Alpha `main`. Secondary
exact-source enrollment still requires its reviewed connector envelope.
Reusing the legacy read-only synchronization API key as event, portal,
connector, or draft-quote authority remains prohibited.

## 2026-09-02 resumable delivery and joined-gate checkpoint

This checkpoint changed prepared public-delivery archives and added local
acceptance evidence. It did not enable a portal authority flag, provision a
client identity, or alter an existing public-link token.

- D1 Time Travel bookmark
  `000010f2-00000004-000050db-6098b1dd4ce7d331060f02816570ed6d`
  was captured before Client migration `0193_bulk_download_parts.sql`.
- The first remote `0193` attempt failed closed with SQLite `incomplete input`
  and was not recorded in the migration ledger. Its trigger guards were
  rewritten into the D1-supported `SELECT RAISE(...) WHERE ...` form, a fresh
  local migration replay through `0193` passed, and the corrected remote
  migration then executed eight commands successfully. Remote readback
  reported no migrations pending.
- Commit `236c6b93e659f70687ecd318f88f8ef469a54919` is the exact `main`
  release. Client Worker version
  `5dc3452e-18c4-4b32-9675-349fd0b0723d` and Operations Worker version
  `546d50b5-2092-45d8-9b52-f8ccde475e59` each served 100% of traffic in the
  post-push Wrangler readback.
- Prepared public deliveries now prefer one archive, deterministically create
  independently resumable parts only when one archive cannot fit the bounded
  execution capacity, and retain explicit part links when a browser blocks
  multiple automatic downloads. Every part retains exact-path authorization,
  stable ETag, HEAD, byte-range/206 and 416 behavior for 24 hours or until the
  share expires. Fifty focused archive tests and 26 desktop/mobile public
  delivery browser tests passed.
- Joined local acceptance J1 through J6 passed sequentially in isolated
  processes against this exact release. J7 passed eight Worker tests and 16
  desktop/mobile browser cases for local dual-domain daily use. These results
  strengthen local integration evidence but do not replace the outstanding
  live Access sign-in, logout, true session-expiry, unprovisioned/cross-tenant
  denial, active-revocation, or Access policy/audience readback cases.
- A read-only view of deployed Client version 201 confirmed the intended
  ingest-only boundary: `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=true` and
  `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true`, while hierarchy-v2,
  automatic eligibility, deny management, team/membership mutation,
  authenticated delivery, requests, notifications, content audit, service
  assignment policy, and delegated shares remained false. The configured
  portal HMAC key ID was present, but Cloudflare did not list the required
  `PROJECT_ALPHA_PORTAL_HMAC_SECRET` binding. No secret value was read. Portal
  ingestion therefore remains unproven and must fail preflight until a
  dedicated matching producer/receiver secret is provisioned.

## 2026-09-03 delegated-access expiry checkpoint

This checkpoint materialized elapsed delegated-share state without granting,
restoring, or otherwise changing client authority.

- D1 Time Travel bookmark
  `000010f2-0000015e-000050db-ef73a9b812006fc4afc69f1652a01327`
  was captured immediately before Client migration
  `0194_client_delegated_share_expiry.sql`.
- The remote migration executed six commands successfully. A second migration
  ledger readback reported no migrations pending.
- Expiry reconciliation is bounded to 50 shares and 50 delegations per hourly
  pass, is workspace-scoped and idempotent, and records deterministic immutable
  `client_share.expired` and `delegation.expired` events. Failed and revoked
  shares remain terminal; active and suspended delegations can expire.
- Focused delegated-access verification passed 18 tests across expiry races,
  repeated runs, bounds, workspace isolation, membership preservation, and the
  joined delegated-access gate. Client type checking and production build also
  passed. This does not change the outstanding live portal-authority blockers
  documented above.
- Follow-up slow-client hardening extended prepared archive retention and its
  exact-path resume credential from 24 hours to seven days, still bounded by
  an earlier delivery-link expiration or immediate revocation. Forty-three
  focused archive tests, 26 desktop/mobile public-delivery browser cases,
  Client type checking, and the production build passed.
