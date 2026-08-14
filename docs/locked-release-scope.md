# Locked LTDS release scope

This checklist is the release traceability record for the Operations, Client
Portal, delivery, request, and Project Alpha compatibility work reviewed on
2026-08-13. A checked implementation still requires the staging and external
gates below; no item authorizes a production deployment or remote migration.

## Staff navigation and mobile usability

- Operations primary navigation exposes Dashboard, Operations, Client
  Requests, SOP Library, Airspace, Delivery, and Administration. Team is a
  permission-filtered Administration child, not gated by the Administration
  permission itself.
- Client primary navigation exposes Home, Projects, Deliveries, and Requests;
  Account remains in the profile/drawer.
- At 960 px and below, both authenticated shells use an accessible hamburger
  drawer with route links, active state, 44 px targets, Escape/outside/resize
  close, focus containment/return, and background scroll lock.
- Critical table fields are never hidden by a global nth-column rule. Narrow
  content uses scoped overflow or purpose-built responsive layouts.
- Dialogs, notification panels, sticky toolbars, long names/emails, 320 px,
  390 px, tablet, landscape, keyboard-only, and 200% zoom remain release tests.

## Operations execution and procedures

- Client Requests is a first-class navigation destination while preserving the
  existing `/operations/client-requests[/id]` deep links.
- Team is a directory/assigned-work entry point. Local security overrides and
  manager recovery belong in Administration; Project Alpha remains the source
  for workforce assignments.
- SOPs attach to work, never to a person. Operation job briefs pin immutable
  published revisions, show Quick SOP chips near the heading, retain archived
  pinned guidance, and require both work visibility and `sops.view`.
- Project and Task cards expose their own direct Quick SOP chips. Each link is
  pinned to one immutable published revision; it never inherits between a
  Project, Task, Operation, or person. Reads require target visibility plus
  `sops.view`, while changes additionally require the target's scoped manage
  permission and optimistic-concurrency version.
- Staff request geometry opens read-only. Edit is explicit, versioned,
  reasoned, optimistic-concurrency protected, audited, and preserves the
  original client geometry. Authorized staff can export original or current
  effective geometry as KML.

## Delivery browsing and thumbnails

- Grid three-dot controls have a visible white backing over light or dark
  media, retain keyboard focus styling, and remain visible on touch devices.
- File/photo/document cards use rounded clipped visual surfaces. Loaded public
  thumbnails cannot cover the Download action.
- Operations and public delivery render the first bounded page before media
  enrichment or later pages, keep at most one page request in flight, append
  without duplicates, abort stale navigation, and clear protected caches on
  authorization/not-found expiry responses.
- Image/PDF rendering stays on the Cloudflare container path. Video jobs stay
  pending for the private TrueNAS renderer claim path; the queue consumer
  acknowledges video messages without marking them unsupported.
- The private renderer claim/heartbeat/complete/fail contract, supported video
  extensions/content types, strict lease ownership, and the one-shot bounded
  legacy-video recovery remain intact. Deployment evidence must prove the real
  TrueNAS client echoes the opaque lease and can claim a pending video.

## Client workspace hierarchy and delegated access

- Project Alpha owns organization, department, client/contact, project, and
  portal authorization intent. Primary-contact or email matching alone grants
  nothing. LTDS owns verified identities, workspace membership/enrollment,
  local guests, effective enforcement, folder bindings, bearer shares, and
  portal audit.
- A workspace has exactly one PA organization or standalone-client root. One
  verified identity may join multiple workspaces without data merging.
- PA staff appoint PA-backed organization/department/project managers. Portal
  managers invite ordinary scoped guests only; invitations cannot grant
  `member.manage`. Project is the safe default and broader scope requires an
  explicit warning/confirmation.
- Accepted invitations must reach the authorized project/files/requests—not
  merely create shadow hierarchy rows. Revocation, suspension, source removal,
  completed-project expiry, explicit deny, and manager replacement must take
  effect without email-based rebinding or cross-workspace leakage.
- Staff provisions opaque folder targets/delegations. Client-created links use
  independent random bearer material and the isolated `/client-share/`
  namespace, never reuse or reveal a staff/root link, and reauthorize current
  workspace, membership, entitlement, delegation, target, binding, and source
  lineage on every request.
- Client-created share scope is a strict descendant by default. Exact-root
  sharing requires explicit staff approval. Map access is separately
  fail-closed; delegated bulk ZIP/cloud-copy remains unavailable until a
  separate job/quota/auth contract exists.

## Service requests and Project Alpha handoff

- Request v2 supports 1–10 current PA service public IDs, bounded declarative
  questions, one shared Mapbox work area, autosave/versioning, and a five-step
  accessible review flow with Edit actions before idempotent submit.
- Clients never upload/import/export KML. Server-validated Mapbox GeoJSON is the
  only client geometry input; the server computes authoritative square metres
  and acreage.
- Supporting files are limited to 10 files, 25 MiB each and 100 MiB total;
  JPEG/PNG/WebP/HEIC/HEIF/PDF only. ZIP/archive/active content is rejected.
  Direct multipart upload uses a dedicated least-privilege R2 credential,
  quarantine, real malware-scan acceptance, immutable submit linkage, and
  same-origin authorized download.
- The final client review clearly presents services/answers, work area,
  contacts, schedule, deliverables, files, coverage, and any non-binding price
  hint. Pending/failed scans or stale catalog versions block submit with a
  precise recovery state.
- Project Alpha alone evaluates price policy. LTDS shows only PA-returned
  `Starting at`, `Typical range`, or no amount with the exact planning-only
  disclaimer. Preview failure never blocks request submission.
- Operations can create only an idempotent private PA draft quote through the
  dedicated command. It cannot approve/send/sign/invoice/charge/notify. The PA
  editor handoff is `/quotes/{encodeURIComponent(quotePublicId)}/edit`; numeric
  IDs never cross the machine contract.

## Required production gates

- All additive migrations apply to isolated staging exports, a second list is
  empty, foreign-key checks pass, backups and fix-forward recovery are recorded,
  and production remains unchanged until separately approved.
- All three staging Wrangler configs, Access applications/audiences/routes,
  DNS/TLS, queues/bindings/secrets, strict host admission, and the signed
  release-evidence packet pass the checked-in preflight.
- Project Alpha implements and proves the pinned portal-v2/v3, catalog-v2,
  pricing-v1, and draft-quote-v1 fixtures with ordered/replay/idempotency/parity
  evidence.
- A real attachment scanner, staging-specific R2 CORS/lifecycle, invitation
  email sender, dedicated Access enrollment/reconciliation, staff manager
  recovery, delegated-share signer/service binding, projection alerts, and
  TrueNAS renderer are configured and exercised with controlled identities.
- Full typecheck, unit/integration, production build, desktop/mobile browser,
  migration, staging-gate, and security-diff suites pass on the exact release
  commit. Flags remain false until the matching external gate is current.
