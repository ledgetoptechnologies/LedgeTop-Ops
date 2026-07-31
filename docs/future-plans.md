# Future planning proposals

> **Status: exploratory only.** Nothing in this document is a committed
> roadmap, approved architecture, production capability, or active
> implementation scope. Each proposal requires product validation, security
> review, cost analysis, staging evidence, and a separate implementation
> decision.

Todd's application is read-only reference material. It must not be modified or
treated as an upstream dependency. Any useful interaction patterns observed
there must be independently specified and implemented within the owning LTDS
system only after validation.

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
