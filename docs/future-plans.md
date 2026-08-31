# Future planning proposals

> **Status:** A limited client-portal pilot is now deployed at `client.` with
> Cloudflare Access, explicit LTDS memberships/grants, controlled test data,
> and request notifications. It is not a general client launch. All expansion
> items below remain subject to product validation, security review, cost
> analysis, staging evidence, and a separate implementation decision.

Todd's application is read-only reference material. It must not be modified or
treated as an upstream dependency. Any useful interaction patterns observed
there must be independently specified and implemented within the owning LTDS
system only after validation. It is not a requirements source, code or schema
source, integration target, dependency, or authorization model.

## Client portal transition (target: August 21, 2026)

**Approved planning direction:** Move the public source layout from
`apps/delivery` to `apps/client` while initially retaining the deployed
`ltds-delivery` Worker, its resource bindings, and its runtime contracts. The
source-layout change does not authorize any Cloudflare or production change.

The intended public boundary is:

- `ops.ledgetopdroneservices.com` remains Cloudflare Access-protected and
  staff-only.
- `ops-sync.ledgetopdroneservices.com` remains internal/service-authenticated
  and exposes no client journey.
- `client.ledgetopdroneservices.com` is the authenticated client portal origin
  for portal workspaces and flight/service requests.
- `delivery.ledgetopdroneservices.com` remains the anonymous public-share and
  delivery-browsing origin. The Worker enforces the host×namespace split even
  when both custom domains point to the same Worker.

The domain migration must keep the existing Worker identity and bindings stable,
and the cutover must be independently reversible without deleting or recreating
the Worker or any bound resource. Public-share and Client Portal identities
cannot write to `client-data`; separately gated authenticated Operations staff
uploads use the Operations authorization boundary. Incoming browser uploads
stay confined to the private quarantine boundary, pass through TrueNAS
verification, and require an authorized publication step before becoming
client-browsable.

### Current implementation boundary

The deployed pilot has a Cloudflare Access verified-principal adapter,
account/project/delivery grant repositories, responsive portal shell, and
rate-limited service-request APIs. Cloudflare verifies the human email, but
LTDS independently resolves that identity to an active local membership and
grant. Access login alone is never sufficient.

The pilot does not include self-registration, password recovery, a custom MFA
database, bulk client enrollment, Project Alpha write-back, or broad billing
visibility. The request limiter reuses the existing public bulk rate-limit
binding with a distinct server-derived account key.

### Ordered hostname cutover

This source-layout PR performs none of these external actions. Execute them only
after separate review and approval of client-host-aware runtime code:

1. Merge and deploy a pinned client-host-aware version to the existing
   `ltds-delivery` Worker. Do not rename the Worker or change its D1, R2, Queue,
   Workflow, Images, Stream, rate-limit, variable, or secret bindings.
2. Record the deployed and rollback version IDs; export the current
   `delivery.` DNS/custom-domain and delivery-scoped Access administration
   application and policy configuration. Confirm that the rollback version can
   still serve `delivery.` without data or schema rollback.
3. Pass staging and pre-cutover checks for portal authentication and
   authorization, public shares, delivery browsing, request submission, and
   quarantine upload boundaries. Keep `client.` unattached until these checks
   pass.
4. Attach both reviewed custom domains to the existing Worker and create or
   enable only the client-scoped Access application/policies required by the
   authenticated portal. Keep one human client audience; the public delivery
   host uses a separate Bypass policy, not another human authority.
5. Test the real `client.` origin end to end: wrong-namespace rejection,
   unauthenticated denial, client isolation, staff/client authorization,
   request flow, quarantine-only uploads, and `/health`. Test the real
   `delivery.` origin for password-protected public shares, preview/download
   browsing, portal-namespace rejection, and absence of a human Access token.
6. Update Client `PUBLIC_SHARE_ORIGIN`/`PUBLIC_BASE_URL`, Client
   `CLIENT_PORTAL_ORIGIN`, Operations `PUBLIC_SHARE_ORIGIN`, and Operations
   `DELIVERY_BASE_URL` together. Re-run both-host smoke tests and record the
   final domain, Access policy, Worker version, variables, and resource
   inventory as cutover evidence.

### Ordered rollback

Rollback changes hostname and Worker-version selection only; it never rolls
back or deletes D1/R2 data or bound services:

1. Stop further cutover changes and preserve logs/evidence. Leave all stateful
   resources and secrets untouched.
2. If `delivery.` has already been removed, restore its exported DNS/custom
   domain and delivery-scoped Access administration application/policies on the
   same `ltds-delivery` Worker.
3. Restore the recorded pre-cutover Worker version or host configuration needed
   to serve `delivery.` while retaining the same bindings and resource IDs.
4. Verify `delivery.` health, expected-host behavior, Access administration,
   public-share authorization, browsing, previews, and downloads.
5. Only after `delivery.` is healthy, detach `client.` and disable its new
   Access application/policies. Record the rollback version and hostname/policy
   inventory. Do not delete `client.` records until the restored path is proven.

### Minimum usable scope

- Invitation-only authenticated portal with explicit client memberships and
  delivery grants.
- A user-approved identity provider or Access pattern, with verified server-side
  identity context and staging login/logout/denial evidence.
- Flight/service request submission and status visibility.
- Existing delivery browsing, preview, and download behavior.
- Existing password-protected public share links.
- Resumable quarantine uploads reachable from the client origin.
- Staff provisioning, request triage, and publication authorization on Ops.

### Deferred beyond the minimum

Self-registration, a custom password/reset/MFA stack, automatic Project Alpha
write-back, automated quarantine publication, electronic proposal acceptance,
and redirect/dual-host compatibility behavior are outside the minimum August 21
scope. The authorized clean hostname cutover is an operational release step,
not an MVP runtime feature.

## Architectural boundary

- **Project Alpha** remains authoritative for clients, projects, teams,
  operations, tasks, assignments, and related business workflow.
- **LTDS Ops** owns operational views, delivery associations, authorization
  enforcement, client shares, and controlled transfer orchestration.
- **TrueNAS** remains the source of truth and normal media-processing path.
- **Cloudflare R2** remains delivery/object storage, not the authoritative
  project-management database.
- Cross-system identifiers must be explicit, stable, ownership-checked, and
  auditable. A filename, folder name, map shape, or R2 key alone is not
  authorization.

## Client-side KML and map-based project scoping

**Potential value:** Let staff load or draw KML-compatible boundaries in the
browser to locate or narrow candidate Project Alpha projects, operations,
delivery areas, or R2 folder associations.

**Architectural fit:** Parse and render geometry client-side where practical.
Project Alpha should own any accepted project or operation boundary. LTDS Ops
may use a read-only synchronized geometry or bounded spatial query to suggest
matches, but must require an authorized explicit selection before associating
delivery content. TrueNAS and R2 should receive only the resulting approved
project/job identifier or manifest relationship.

**Security and operational constraints:**

- Treat KML as untrusted XML: disable external entities and network retrieval,
  reject executable/HTML content, and bound bytes, features, coordinates,
  nesting, parse time, and render time.
- Normalize coordinate assumptions and reject invalid or extreme geometry when
  it could affect automated matching.
- Never grant project, client, or object access because a submitted shape
  overlaps it; server-side role and assignment checks still apply.
- Keep raw filenames and sensitive site geometry out of logs.
- Define whether geometry is transient, retained, or promoted into Project
  Alpha, including retention and deletion ownership.
- Test pathological KML, overlapping/ambiguous matches, antimeridian and polar
  coordinates, malformed XML, and mobile rendering limits.

**Dependencies:** Product matching rules; a reviewed mapping/KML library; a
Project Alpha geometry contract or read-only query; server authorization for
every result; and staging performance/privacy tests.

**Recommended priority: medium.** Validate the selection workflow with staff
before designing persistence or automatic matching.

## Presigned S3-compatible upload URLs

**Potential value:** Allow an authorized browser or controlled client to upload
large files directly to an isolated R2 intake boundary without proxying file
bodies through a Worker. Multipart presigned URLs can improve reliability and
reduce Worker memory and request-duration pressure.

**Architectural fit:** This fits the existing inbound-request design only as a
deliberately enabled, quarantine-first capability. LTDS Ops authorizes and
checkpoints an upload; R2 receives bytes in a private intake bucket or prefix;
TrueNAS verifies, scans, and promotes accepted content; Project Alpha supplies
authoritative project/job context. It must not bypass the default-off
direct-upload gate or write directly into client-visible delivery prefixes.

**Security and operational constraints:**

- Issue short-lived, method-, bucket-, key-, part-, and size-bound signatures
  only after ownership, quota, and request-state checks.
- Use opaque object keys without personal data and strict CORS
  origins/headers.
- Bound file count, bytes, part count/size, outstanding uploads, and per-client
  concurrency; expire and abort abandoned multipart uploads.
- Verify completion size, part identities, expected object identity, and
  checksum where supported before marking completion.
- Keep uploads quarantined until TrueNAS malware and integrity checks succeed.
- Make retry, completion, cancellation, pickup, and cleanup idempotent and
  auditable; object presence alone must not imply acceptance.
- Separate staging and production credentials, buckets, signing scope, CORS,
  lifecycle rules, budgets, and alerts.

**Dependencies:** Approved intake scope; isolated R2 intake storage and
lifecycle policy; least-privilege S3 credentials; multipart checkpoints;
TrueNAS pickup/verification contract; Turnstile and rate limits if public; cost
monitoring; and large/interrupted-upload staging tests.

**Recommended priority: medium-high after the existing inbound boundary is
accepted.** Keep it disabled until the complete quarantine and recovery path is
proven.

## Proposal PDF generation

**Potential value:** Generate a consistent, branded proposal artifact from
approved client, project, scope, pricing, schedule, and terms data for review,
sharing, and archival.

**Architectural fit:** Project Alpha should own proposal source records,
lifecycle state, pricing, and client/project relationships. A dedicated Project
Alpha service or bounded document-generation Worker should render a versioned
snapshot. LTDS Ops may display or deliver an authorized final artifact; R2 may
store the immutable PDF and manifest. TrueNAS may back up/sync artifacts but
should not become the proposal database or renderer.

**Security and operational constraints:**

- Render only authorized, schema-validated data and approved templates; disallow
  arbitrary HTML, remote URLs, scripts, and local-file access.
- Escape client-provided text and constrain images, fonts, page count, memory,
  CPU, and render time.
- Record template/source/generator versions, checksum, creator, time, and
  authorization scope.
- Separate drafts from issued proposals and never silently replace an issued
  version.
- Keep financial/client information out of logs and public object keys.
- Define retention, legal-record, correction, accessibility, and recovery
  requirements before production use.

**Dependencies:** Project Alpha proposal schema/state model; approved
brand/legal templates; bounded renderer and font assets; immutable artifact
contract; R2 ownership/retention rules; authorization tests; and business
review.

**Recommended priority: medium.** Begin with a manually reviewed prototype only
after data ownership and legal content are settled.

## Opt-in proposal acceptance

**Potential value:** Let a specifically invited client contact acknowledge or
accept an issued proposal, creating a traceable handoff into scheduling or
project initiation without treating ordinary document viewing as consent.

**Architectural fit:** Acceptance should be a Project Alpha business event
against an immutable proposal version. LTDS Ops or Delivery could host a
narrowly scoped client experience, but the server must validate the invitation
and send a signed, idempotent command to Project Alpha. R2 stores the accepted
artifact and receipt evidence; TrueNAS may back up artifacts but does not own
acceptance state.

**Security and operational constraints:**

- Acceptance is explicitly opt-in; viewing, downloading, email delivery, or
  opening a link must never count as acceptance.
- Bind a short-lived, single-purpose invitation to the contact, proposal ID,
  exact version/checksum, allowed action, and expiry.
- Require a clear confirmation step showing the version and terms, with safe
  decline and request-changes paths.
- Prevent replay and races with one-time state and idempotency keys.
- Record UTC time, proposal version, invited/authenticated identity, consent
  text version, safe request metadata, and the resulting Project Alpha event.
- Do not claim electronic-signature or contract enforceability until counsel
  defines identity assurance, disclosure, attribution, retention, and
  correction requirements.
- Provide staff notification and reconciliation when downstream Project Alpha
  processing fails.

**Dependencies:** Approved legal/product meaning of acceptance; Project Alpha
proposal state machine and idempotent API; client identity/invitation model;
versioned consent text; notification/reconciliation; audit retention; and
security/legal acceptance testing.

**Recommended priority: low until proposal generation and legal requirements
are established.** Design the state model alongside proposals, but do not use
acceptance as a shortcut around identity or legal review.

## Validation sequence

Before any candidate becomes roadmap scope:

1. Confirm the user problem with staff and representative clients.
2. Assign the authoritative system and data owner.
3. Write a threat model, privacy/retention decision, and abuse/cost limits.
4. Define API, event, identity, idempotency, and recovery contracts.
5. Build an isolated prototype with no production data or traffic.
6. Record staging acceptance evidence and operational ownership.
7. Obtain separate roadmap and implementation approval.
