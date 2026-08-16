# Project Alpha implementation prompt: LTDS client portal v2

Use the following prompt for one dedicated Project Alpha coding task. It is
intentionally limited to the Project Alpha repository and does not authorize a
deployment, production migration, real email, or production data mutation.

---

Work only in the current Project Alpha repository. The reviewed compatibility
baseline is Project Alpha commit `60e735265e0d50ef880fde33e058d213a8b70c4b` on
`codex/dev-recurring-expenses`/`origin/dev`; do not silently replace it with
the divergent, non-baseline `origin/main`. If the checkout has moved, first
compare it to that commit and report the exact delta. Inspect the full
schema/migration ledger,
authorization middleware,
Service Library, quote creation, organization/department/contact screens,
portal foundation, sync v1/v2 services, audit/outbox conventions, and tests
before editing. Preserve unrelated work. Create a `codex/` feature branch, but
do not deploy, apply a remote migration, send real email, push, or merge unless
the user separately authorizes it.

Your objective is to implement Project Alpha's half of the LTDS Client Portal
v2 contract. The exact reviewed LTDS compatibility source is
`https://github.com/ledgetoptechnologies/LTDS-Ops.git` commit
`b1ee064d8e9a78ff1fbc43c671bff4c2c58d4c38`; this is the exact reviewed LTDS
implementation commit supplied with this handoff; do not substitute a branch tip
or another checkout. Treat that commit's repository-relative
`docs/client-portal-v2-architecture.md`, `docs/project-alpha.md`, and the five
fixture files below as normative. Verify these SHA-256 values before editing:

- `packages/shared/fixtures/project-alpha-portal-v2.json`:
  `808185cb582476f7e64f5a2c1f8c9c283d1bb5c4db1550227b19ff82887301bd`
- `packages/shared/fixtures/project-alpha-portal-relations-v3.json`:
  `87508874a56c76eb768e1b2a87fe77dec28b58fb06802c45d85c640685890a28`
- `packages/shared/fixtures/project-alpha-catalog-v2.json`:
  `9626ee5147ac9cd2198e6bca58eee9bb464c2105861c679a16745e1d9bf022fe`
- `packages/shared/fixtures/project-alpha-pricing-hint-v1.json`:
  `6354ad8fb2439e4463202290516a05198ec03cf0a966fbfb4bd83fcf18449d6b`
- `packages/shared/fixtures/project-alpha-draft-quote-v1.json`:
  `fc47be82960b11ab6cb705e2dcaa11f76f39ef9c5c3199ff6861e8a787034f90`

This prompt is the complete handoff; no companion message supplies missing
contract details. If that exact commit or those exact fixture bytes are
unavailable, stop and request them rather than reading another worktree or
inventing a divergent contract.

Project Alpha remains authoritative for organizations, departments, clients,
projects, portal authorization intent, the Service Library, pricing policy,
quotes/contracts/invoices/tax/payment, and all financial communication. LTDS
remains authoritative for verified Cloudflare identities, portal enrollment,
local guest membership, service-request drafts/submissions, Mapbox geometry,
request attachments, delivery folder bindings/files/shares, notifications, and
LTDS authorization audit. Do not add a Project Alpha client-facing login or
reuse PA public project links/entity links as LTDS authorization.

Implement this as additive, default-off, independently gated capabilities:

0. **Authenticated Delivery audience and revocation contract**
   - LTDS migration `0136_portal_v2_identity_denials.sql` owns global,
     workspace, hierarchy, folder, and contact denials. Project Alpha does not
     create, revoke, restore, or mirror those records. PA must publish enough
     current hierarchy, principal, and entitlement state for LTDS to evaluate a
     denial against the current lineage on every request.
   - LTDS migration `0137_authenticated_delivery_grants.sql` owns staff-created
     authenticated folder grants. A grant targets one opaque PA organization,
     department, client, project, or principal and captures the selected PA
     source version plus the LTDS folder-binding source version. It is distinct
     from Operations `/s/...` bearer shares and client-owned
     `/client-share/...` bearer shares.
   - Group grants are dynamic: LTDS intersects the current verified identity,
     active workspace membership, current `delivery.view` entitlement, current
     hierarchy/lineage, current entity/source versions, folder binding, and
     applicable denial on every request. PA must not publish a static email
     recipient list as authorization. A newly entitled verified member may
     qualify without rewriting the LTDS grant; a moved, tombstoned, revoked,
     denied, expired, or source-stale member must stop qualifying immediately.
   - Exact-person grants additionally require the same current PA principal
     public ID/source version to remain bound to the same LTDS-verified
     identity. PA email is nomination/display metadata only. Changing an email
     must never transfer the principal public ID or entitlement to another
     Cloudflare Access subject.
   - PA must publish `delivery.view` at the narrowest intended organization,
     department, client, project, or workspace scope. Allow and deny precedence
     must be deterministic. A folder grant never widens a PA entitlement; it
     only associates that folder with an audience already authorized for its
     current owner scope.
   - Entity moves, tombstones, project cancellation, entitlement revocation,
     identity unbinding, and principal source-version changes must emit ordered
     authoritative state that makes the old LTDS authorization fail closed on
     the next request. Replay or an older generation must never reactivate it.
   - LTDS revoke is terminal history. Restore creates a new grant version only
     after revalidating current PA identity, hierarchy, entitlement, source
     versions, expiry, and deny state. A restored PA entity or entitlement does
     not by itself resurrect an old LTDS grant.
   - A client-created public share remains subordinate to its current live
     authenticated source grant. PA removal or revocation must therefore cause
     LTDS to suspend the descendant bearer path without PA learning or storing
     the bearer token.

1. **Stable hierarchy and explicit portal authority**
   - Ensure organization, department, department-contact assignment, client,
     project, portal principal, portal entitlement, and portal-safe Service
     Library resources have immutable opaque public IDs and opaque immutable
     source versions that change whenever portal-visible content changes.
     `sourceSequence`, not `sourceVersion`, is the contiguous monotonic field.
     Numeric database IDs must never cross the integration boundary.
   - Build on the existing default-off portal foundation instead of using
     employee roles, billing recipients, `entity_links`, email equality, or a
     department `is_primary` flag as authorization.
   - Add an explicit audited portal-manager workflow capable of representing
     multiple organization administrators, department heads scoped to one
     department, project managers scoped to one project, and members. Add the
     missing department-scoped entitlement model or a generic scoped model.
     A UI may suggest the primary department contact, but primary status alone
     must grant nothing.
   - PA staff, through the audited PA authority screen, appoint or replace
     organization administrators, department heads, and project managers.
     PA publishes the `member.manage` entitlement intent; LTDS owns the guest
     invitation and warning UX. Portal managers may invite ordinary LTDS-local
     guests only within a scope where their PA entitlement already grants
     `member.manage`; an invitation can never grant `member.manage` or create a
     PA-backed manager. Project scope is always the safe default.
     Organization-wide guest scope requires an explicit LTDS warning and
     confirmation.
   - Removing/reparenting/deactivating a source entity or entitlement must emit
     authoritative state that immediately removes the affected authorization
     intent. Changing a contact's email must not silently bind a different
     person.
   - Repair the current department mutation route permission mapping and make
     hierarchy/entitlement mutations transactionally audited; a failed audit or
     outbox write must fail the sensitive mutation rather than silently pass.

2. **Portal-v2 hierarchy projection publisher**
   - Implement the signed, ordered, complete-generation snapshot and
     incremental event publisher for LTDS
     `POST /api/internal/project-alpha/portal-v2` exactly as documented.
   - Publish strict schema v3 only for the separately gated relation contract.
     Resources include organization, standalone client, department, client,
     contact, project, versioned `contains`/`contact_assignment` edges, one
     lifecycle record per active project, portal principal, and scoped
     entitlement. Include active/tombstone state and stable public IDs.
   - Emit only the normative directed edges: `contains` permits organization to
     department/client/project, standalone client to project, and
     department/client to project; `contact_assignment` permits organization,
     standalone client, department, client, or project to contact. LTDS rejects
     every other direction. Entity and workspace tombstones are single
     authoritative events: LTDS closes their dependent graph, lifecycle, and
     PA-derived authorization atomically.
   - Map PA project lifecycle exactly: `not_started`, `active`, and `overdue`
     publish `active` with `completedAt: null`; `completed` publishes
     `completed` with an authoritative `completed_at` that is immutable for
     that completed source version/event; `cancelled`
     publishes the project inactive/tombstoned and immediately closes its
     dependent authorization graph. Add `completed_at` rather than deriving it
     from `updated_at`. A higher-version reopening event clears `completed_at`
     and publishes `active`.
   - Persist mutation plus outbox event in the same database transaction.
     Delivery must be idempotent and retryable; per-workspace sequences are
     contiguous and monotonic. Interrupted snapshots must be resumable without
     declaring an incomplete generation active.
   - Keep existing v1 consumers unchanged. Add parity reports and do not enable
     the new publisher until snapshot/event convergence is demonstrated.
   - Import or copy byte-for-byte
     `packages/shared/fixtures/project-alpha-portal-v2.json` from LTDS and run
     every positive and negative specimen through PA producer contract tests.
     Emit the separate `snapshotActivate` envelope exactly; do not add resource
     arrays to it. Schema-v2 remains unchanged. Do not publish schema-v3 until
     `packages/shared/fixtures/project-alpha-portal-relations-v3.json` is copied
     byte-for-byte and every positive/negative specimen is exercised in PA
     contract tests, a full snapshot is accepted in staging, and the LTDS
     relation flag is separately approved.

3. **Sanitized Service Library projection**
   - Add an immutable public ID and opaque immutable source version that changes
     whenever portal-visible content changes to each Service Library service
     needed by LTDS. Only delivery `sourceSequence` is contiguous and monotonic.
     Catalog schema v2 is intentionally
     flat: publish only `entry_type=service`. Fees and bundles remain PA-only;
     do not flatten package composition until a later versioned wire contract
     defines its composition and pricing semantics.
   - Add an explicit `portal_request_enabled`-style control. Every published
     item must contain exactly `publicId`, `sourceVersion`, `name`, nullable
     `summary`, non-empty `category` (maximum 100 characters), integer
     `displayOrder` (0–1,000,000), `geometryRequirement` (`none`, `optional`, or
     `required`), and 0–10 declarative client questions. The only question types
     are the contract's text, bounded number, boolean, select, and multi-select
     forms with stable field IDs.
   - Never publish unit prices, private formulas, margins, costs,
     tax rules, fulfillment notes, work activities, compensation, credentials,
     raw HTML/JavaScript, arbitrary regexes, or numeric database IDs.
   - Implement the separately authenticated catalog-v2 complete snapshot and
     ordered event publisher exactly as documented for
     `POST /api/internal/project-alpha/catalog-v2`. Reject same-version content
     changes; a source version is immutable evidence.
   - Treat
     `packages/shared/fixtures/project-alpha-catalog-v2.json` in the LTDS repo as
     the machine-readable compatibility fixture and run it through PA producer
     tests byte-for-field before enabling catalog sync.

4. **Non-binding pricing preview**
   - Implement the dedicated server-only
     `POST /api/v2/integrations/ltds/pricing-hints` contract and least-privilege
     `portal.pricing.preview` scope. The browser must never call it.
   - Accept only current service public IDs/versions and LTDS server-computed
     canonical square metres. Never trust browser acreage or money and do not
     accept raw KML/GeoJSON for pricing.
   - Require the exact `authorizationContext` from
     `packages/shared/fixtures/project-alpha-pricing-hint-v1.json`: one opaque
     workspace root (`organization` or `standalone_client`) plus one opaque
     project public ID. Reject numeric legacy IDs and reauthorize that the
     active project belongs beneath that active root before applying policy.
     Never accept LTDS-local workspace/account/project/identity IDs as a
     substitute.
   - Return one PA-calculated aggregate for the complete selection using only
     `none`, `starting_at`, or `typical_range`, decimal-string amounts,
     allowlisted currency, bounded expiry, source versions, and the exact
     non-binding disclaimer from the contract. There is no exact-price mode.
   - If policy is missing, stale, outside bounds, or needs staff judgment,
     return no amount/custom review. Do not extrapolate or make request
     submission depend on preview availability.

5. **Idempotent draft-quote command**
   - Implement the dedicated server-to-server
     `POST /api/v2/integrations/ltds/draft-quotes` contract with only the
     `portal.quote-draft.create` scope. Do not call or wrap the existing browser
     form controller.
   - Reauthorize every supplied non-null organization/client/project/service
     public ID and their relationships. `clientPublicId` is required;
     `organizationPublicId` and `projectPublicId` may be null exactly where the
     strict fixture/schema permits. Recalculate actual draft pricing only in PA from current
     business rules, then snapshot the catalog/request source into the draft.
   - Store a durable unique constraint on `(integration principal,
     Idempotency-Key)` and store the canonical payload hash/fingerprint as a
     separate comparison field. The same key plus the same hash returns the
     same draft; the same key plus a different hash is 409; concurrent delivery
     creates exactly one draft. Add a stable quote public ID. The exact success
     response contains top-level `receiptId` and `draftQuote` with `publicId`,
     nullable string `documentNumber`, `status: "draft"`, numeric `version`, and
     the exact public-ID editor path
     `/quotes/{encodeURIComponent(quotePublicId)}/edit`.
     Add that PA route and resolve it server-side to the internal row. Numeric query-string
     routes such as `?id=42`, absolute URLs, and paths for a different quote
     public ID are invalid.
   - The command may create **only a draft**. It must never approve, publish,
     send, sign, create a contract/invoice, charge/pay, or notify a client.
   - Reject redirects on outbound/inbound integration hops as applicable and
     ensure ambiguous timeout retry resolves via the receipt without creating
     a duplicate.
   - Import or copy byte-for-byte
     `packages/shared/fixtures/project-alpha-draft-quote-v1.json` from LTDS.
     Run its valid request/response and every invalid request/response through
     the PA receiver tests, and exercise every `errorResponses` specimen with
     its exact status and body. Reject extra keys, numeric legacy authorization
     IDs, mismatched area nullability, non-draft results, and editor paths that
     do not identify the returned quote public ID exactly as the shared corpus
     requires.

6. **Integration security and operations**
   - Use separate credentials/scopes/secrets for portal projection, catalog
     projection, pricing preview, and draft creation. Portal projection uses
     its own Access service application/token, application key, and HMAC
     secret. The exact PA API scopes are `portal.catalog.publish`,
     `portal.pricing.preview`, and `portal.quote-draft.create`; do not invent a
     shared replacement scope. A broad/full key must not implicitly inherit a
     write scope.
   - Enforce exact method/path/body signatures, current timestamps, replay
     protection, constant-time comparison, TLS, bounded request/response sizes,
     timeouts, rate limits, and redacted structured logs. Never accept a browser
     cookie, LTDS bearer share, email address, or client-supplied numeric ID as
     integration authority.
   - Add health/parity/outbox metrics and runbooks for stale generations,
     sequence gaps, delivery retries, preview failures, and command
     replay/conflicts. Every sensitive allow/deny/failure is correlated and
     audited without logging secrets, full geometry, or private pricing rules.

7. **Project Alpha staff UX**
   - Extend the organization/department UI so staff can clearly designate and
     replace portal administrators/department heads/project managers, see the
     exact effective scope, and understand that a primary contact is not
     automatically portal-authorized.
   - Make offboarding recoverable: removing one manager removes that person's
     intent without cascading workspace-owned guest access; removing the last
     manager produces a locked/recovery-required state for staff review.
   - Keep existing organization link-strategy/entity-link and Public Project
     Link features visibly separate from LTDS portal entitlements. Deleting a
     PA display link must not claim to revoke an LTDS share.

Required validation before reporting completion:

- fresh install and upgrade migration tests, checksums/ledger, FK checks, and
  rollback/fix-forward notes appropriate to PA's migration runner;
- hierarchy ACL tests for org/department/project scope, multiple managers,
  explicit removal, reparent/deactivation, primary-contact-no-authority, and
  cross-organization IDOR;
- snapshot/event contract tests for pagination, complete activation,
  tombstones, replay, gaps, out-of-order delivery, and transaction rollback;
- catalog allowlist tests proving no private/internal/pricing fields escape and
  same-version mutation is rejected;
- pricing boundary/range/decimal/expiry/failure tests and proof there is no
  browser-accessible endpoint or exact-price wording;
- draft command auth, scope mismatch, idempotent replay, conflicting replay,
  concurrency, timeout-after-commit recovery, and proof of zero
  send/approval/invoice/payment/client-email side effects;
- responsive/keyboard tests for the new PA hierarchy controls at desktop,
  tablet, 390px, and 320px widths; no overlapping controls or inaccessible
  tables;
- typecheck/lint/unit/integration/build and the repository's required security
  checks.

Do not enable any new production flag. End with an evidence table listing exact
files/migrations, commit, tests, known gaps, required LTDS contract fixture
version, and every external staging/credential/operator action still needed.
If a normative LTDS contract conflicts with current PA schema or business
behavior, stop at that boundary and report the exact conflict; do not silently
weaken the authorization or financial invariants.

---
