# Ledge Top platform gap audit — 2026-09-06

Status: durable planning checkpoint. This document reconciles the two supplied
handoffs with the current Operations repository. It is an audit and sequencing
plan, not a claim that every local change is deployed or live-verified.

The handoffs are product inputs, not literal code instructions. Existing
authority, migrations, compatibility contracts, and security boundaries win
when a handoff proposes a duplicate model or a broader write path.

## Executive decision

Operations remains the orchestration and client-experience layer over separate
Project Alpha installations. Project Alpha remains authoritative for clients,
organizations, projects, documents, services, pricing, contracts, invoices,
and financial workflows. Operations may present a bounded, source-qualified
summary and coordinate work; it must not recreate those business systems.

The current small vertical-slice strategy is retained. Finish and live-verify
the current Client Hub, notification/history, responsive-layout, and generic
deployment-name release first. Then strengthen the cross-source client and
capability contracts before adding the service-principal/API foundation for
Hermes or website/context workflows. Do not start a broad portal rewrite, a
second business database, or Viewer work as part of this audit.

## Findings

### Verification checkpoint — September 6 continuation

- Deployment-name alignment is pushed in commit `113a3e6` on Operations PR
  #26. The three production builds, deployment dry runs, TypeScript checks,
  generated binding checks, and release preflight passed locally. Existing
  storage and protocol identifiers were preserved.
- The focused authenticated-delivery access-terms suite passed all 30 cases.
  This does not replace the incomplete full Operations suite evidence.
- GitHub run `34047071207` started no test steps. Its annotation states that
  recent account payments failed or the spending limit must be increased.
  Cloudflare build `52ab3d0a-a545-45d0-9aa7-5ca49ad73e4d` also failed, but its
  error log is not yet available. Neither failure is recorded as a code pass.
- Service-assignment recovery is fixed locally in `d1b037a`: unavailable
  results retain refresh/error/retry controls. All 12 service-assignment
  browser cases passed across desktop and mobile, including recovery from
  unavailable projection through a temporary request failure.
- Linked customer workspaces now include up to five service assignments per
  source, using the existing exact-source reader, context checks, readiness
  results, and links to the owning source's full service list. Unavailable
  services can be refreshed locally. Linking still does not combine access.
  The focused workspace tests passed 7/7 and TypeScript passed. The combined
  linked-customer/service browser run passed 58 cases; two new cases initially
  had an ambiguous error locator. After scoping that locator to Services, both
  desktop/mobile cases passed on rerun. Production build passed. These are
  local results, pending the release blockers above.

### Implemented or locally verified

- Client Hub/detail, source-qualified business-party linking, portal identity
  and scoped grants, folder delivery, share lifecycle, incoming-upload
  metadata, notifications, feedback, service-request readiness, project
  memory, SOPs, and bounded audit/history slices exist in Operations.
- Source ownership and isolation work is represented in the connector, catalog,
  business-party, delivery, portal, notification, request, feedback, and
  snapshot-recovery runbooks. These are local/repository claims unless a
  runbook records a separate production/live gate.
- The navigation and Client Hub presentation direction is established: Client
  Hub owns client-facing operational context, recent links are scoped, and
  dangerous revocation controls are separated from routine content.
- `portal.ledgetopdroneservices.com` is the canonical portal origin and
  `portal.ledgetoptechnologies.com` is an alternate origin. Existing
  `client.*` links are compatibility-only and must redirect or remain narrowly
  supported until their replacement path is proven.
- Project Alpha synchronization is designed around the existing one External
  Operations/Ops Sync connection and signed `portal.projection` envelopes. A
  portal hostname is not a second Project Alpha connection.

### Partial, gated, or not live-proven

- The second Project Alpha producer (Ledge Top Technologies) remains a
  separately gated enrollment. Do not infer that source-scoped code means the
  second production source is active.
- Default-on portal eligibility/workspace creation has local evidence in parts
  of the Client flow, but production reconciliation, revocation, and both
  domains still require an explicit live acceptance gate. A contact record is
  not itself a login or access grant.
- The Client Hub still needs the remaining bounded-query, activity, project
  memory, service-assignment, delivery, and unified-audit slices called out in
  `client-workspace-roadmap.md`.
- Live browser acceptance is separate from local tests. After an approved
  deploy, verify both portal origins, the Ops dashboard, permissions, refresh,
  errors/retry, and scoped delivery with synthetic or approved test records.
- Repository and Worker branding is being generalized from `LTDS-*` to
  `LedgeTop-*`. This is a deployment/configuration migration, not permission
  to change protocol IDs, database names, event types, or compatibility aliases.

### Missing from both the code and the durable Operations contract

- A first-class Hermes machine API: Access service-token authentication,
  service-account status/scopes, audit of every mutation, rate limits, and a
  small `/api/agent/*` surface. The service token must map `common_name` (the
  configured service-token identity), not an arbitrary JWT `sub`, and must
  remain separate from human staff authentication.
- Client context notes, website registry, website metrics/monthly reports, and
  website change requests with item-level completion. The host retains Google
  OAuth, report generation, Git operations, and deployment work; Operations
  stores bounded metadata and workflow state.
- A complete approval/onboarding-to-both-Project-Alpha workflow remains a
  separate authority gate. No agent API should create or mutate Project Alpha
  business records until that phase is explicitly designed and tested.
- A verified live runbook for automatic workspace provisioning and manual
  deny/revocation, including the last-manager and source-removal cases.
- Cross-domain Access cleanup and deployment verification after the hostname
  rename. The two `portal.*` origins should share one application/policy model;
  legacy `client.*` should not become a second long-term tenant.

### Superseded or rejected directions

- “Client portal provisioning” is a product-specific label and is superseded by
  generic language such as “connected workspace synchronization” or “external
  application connection” in Project Alpha. Project Alpha is open source and
  vendor-neutral; LTDS/LTT-specific labels belong in configuration, not its
  product contract.
- A direct Project Alpha connection to `portal.*` is rejected. All source events
  use the one configured Ops Sync endpoint; Ops routes portal projections
  internally.
- `client.*` is not the canonical portal. Preserve legacy redirects/links while
  migrating; do not delete legacy records or Access policy until both canonical
  origins and existing links are proven.
- Viewer runtime/model sharing is excluded from this work while Hermes owns the
  Viewer changes. Operations may preserve an explicit Viewer contract and
  authority boundary, but must not modify the Viewer repository here.
- “Business parties” are currently a presentation/linking layer. Linking two
  source records must not merge identities, memberships, billing authority, or
  content grants.

## Dependency-ordered roadmap

### Phase 0 — preserve boundaries and release safety

1. Keep the existing primary Ops Sync endpoint and source authority unchanged.
2. Inventory current `portal.*`/legacy `client.*` routes, Access applications,
   compatibility redirects, Worker names, protocol IDs, and migration levels.
3. Record local tests, deployed versions, migrations, and live browser evidence
   separately. No production migration or Access mutation follows from a local
   test.

### Phase 1 — current client release and cross-source foundation

1. Finish, publish, migrate, and live-verify the existing Client Hub,
   notification/history, responsive-layout, and portal-access work.
2. Migrate the repository and Worker deployment names to generic `LedgeTop-*`
   naming while preserving internal protocol identifiers and compatibility
   aliases.
3. Define the canonical cross-source client reference and service-capability
   contract without turning presentation-only business-party links into access
   grants.
4. Keep the Technologies Project Alpha producer disabled until paired-source
   isolation and reconciliation gates pass.

### Phase 2 — Hermes API foundation

1. Add a migration strategy that reuses existing `integration_keys`,
   `audit_events`, and idempotency/receipt machinery where compatible; do not
   create parallel secret, audit, or retry stores without a documented reason.
2. Add service-account identity/status/scopes and Access service-token
   verification. Map the token by `common_name`, fail closed on missing,
   suspended, or revoked accounts, and keep service auth separate from staff
   JWT auth.
3. Ship read-only health/client/context primitives first, then bounded writes
   for context, websites, change requests, shares, uploads, and metrics. Every
   mutation is actor-scoped, idempotent, audited, and rate-limited.
4. Add a token rotation/runbook and synthetic acceptance tests. Never accept
   browser sessions or credentials in query strings on agent routes.

### Phase 3 — website/context vertical slice

1. Add client context notes and website registry with no secrets in D1.
2. Add website change-request lifecycle and item-level completion. GitHub and
   Cloudflare deployment remain host/manual responsibilities initially.
3. Add report/metrics metadata and a separate website-reports R2 bucket only
   after the core request workflow is stable.

### Phase 4 — portal lifecycle and unified UX

1. Finish default-on workspace reconciliation and explicit deny/revoke UX;
   verify source removal archives rather than deletes the Ops client.
2. Verify portal domains, legacy redirects, refresh-safe routes, Access policy
   parity, and shared identity behavior in live browser tests.
3. Consolidate client-facing websites, drone data sharing, uploads, requests,
   reports, and notifications under Client Hub subpages without duplicating PA
   business logic.

### Phase 5 — multi-source and future capabilities

1. Enable LTT only after source-scoped snapshots, receipts, role sync,
   portal ownership, and collision/replay tests pass in a paired rollout.
2. Add bounded Project Alpha document summaries/links, service assignments,
   monthly reports, and broader activity only with explicit source authority.
3. Revisit Viewer integration only through a separate handoff and contract gate.

## Non-negotiable invariants

- Separate Project Alpha instances remain separate sources of truth.
- Hostname, brand, email, or display-name matching never grants access or
  merges identities.
- Explicit deny/revocation wins over eligibility, organization membership, or
  service assignment; contacts do not grant login access.
- The local server remains authoritative for source-managed client data.
  Hermes and future agent routes receive no bucket-wide mutation capability.
  Before changing existing staff move/delete or thumbnail behavior, inventory
  which paths are source-managed versus Operations-owned artifacts, reserve
  explicit internal prefixes, and adopt a reviewed synchronization contract.
  Incoming uploads remain separate and retain status metadata after ingestion.
- No secrets in D1, logs, browser state, URLs, or generated client content.
- Reuse versioned shares, `integration_keys`, `audit_events`, and durable
  idempotency/receipt semantics; uncertain writes retry with the same exact key
  and payload, and conflicting reuse fails.
- Every source mutation is source-qualified, transactionally fenced, auditable,
  recoverable, and safe under replay/concurrent writers.
- Generic LedgeTop repo/Worker names are preferred, but protocol IDs, event
  types, migration IDs, and compatibility aliases remain stable during rename.
- Viewer runtime changes stay out of this roadmap until its owner hands back a
  reviewed contract.

## Decisions needing user confirmation

1. Approve the service-principal scope set for Hermes (read clients/context,
   context/websites/change-request/share writes, uploads read, metrics write)
   before creating production Access credentials.
2. Decide whether a separate `website-reports` R2 bucket is acceptable. Do not
   put reports into Client Data R2 unless the read-only mirror contract is
   deliberately changed and re-approved.
3. Confirm the live acceptance accounts and synthetic records that may be used
   for dual-domain browser checks; do not use real client data for destructive
   or broad-access testing.

## Audit conclusion

The repository contains a substantial, well-tested local foundation, but the
handoffs overstate completion of Hermes/API, website, monthly-report,
multi-source live enrollment, and production portal reconciliation. The safest
next move is to finish the current Client Hub release and generic deployment
rename, then land the cross-source client/capability foundation before a small
read-only service-principal slice and one website/context slice. Preserve the
one Ops Sync endpoint, generic PA language, portal-domain compatibility, the
local-server data authority, and the Viewer freeze. This document should be
updated at each release gate with the actual commit, migration, deployment, and
live-evidence references.
