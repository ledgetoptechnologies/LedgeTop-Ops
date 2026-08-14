# Project Alpha implementation prompt: LTDS client portal v2

Use the following prompt for one dedicated Project Alpha coding task. It is
intentionally limited to the Project Alpha repository and does not authorize a
deployment, production migration, real email, or production data mutation.

---

Work only in the current Project Alpha repository. Inspect current
`origin/main`, the full schema/migration ledger, authorization middleware,
Service Library, quote creation, organization/department/contact screens,
portal foundation, sync v1/v2 services, audit/outbox conventions, and tests
before editing. Preserve unrelated work. Create a `codex/` feature branch, but
do not deploy, apply a remote migration, send real email, push, or merge unless
the user separately authorizes it.

Your objective is to implement Project Alpha's half of the LTDS Client Portal
v2 contract. Treat the LTDS documents
`C:\Users\fstor\.codex\worktrees\6d08\LTDS-Ops\docs\client-portal-v2-architecture.md`
and
`C:\Users\fstor\.codex\worktrees\6d08\LTDS-Ops\docs\project-alpha.md`
as the normative wire contract. Their repository-relative paths are
`docs/client-portal-v2-architecture.md` and `docs/project-alpha.md`. If this
checkout cannot read them, stop and request their exact contents rather than
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

1. **Stable hierarchy and explicit portal authority**
   - Ensure organization, department, department-contact assignment, client,
     project, portal principal, portal entitlement, and portal-safe Service
     Library resources have immutable opaque public IDs and monotonic source
     versions. Numeric database IDs must never cross the integration boundary.
   - Build on the existing default-off portal foundation instead of using
     employee roles, billing recipients, `entity_links`, email equality, or a
     department `is_primary` flag as authorization.
   - Add an explicit audited portal-manager workflow capable of representing
     multiple organization administrators, department heads scoped to one
     department, project managers scoped to one project, and members. Add the
     missing department-scoped entitlement model or a generic scoped model.
     A UI may suggest the primary department contact, but primary status alone
     must grant nothing.
   - Organization administrators may appoint department heads/project
     managers; department heads may appoint project managers; project managers
     may add project members only. Project scope is always the safe default.
     Organization-wide scope requires an explicit warning and confirmation.
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
   - Add an immutable public ID and monotonic portal-visible version to each
     Service Library item/package needed by LTDS.
   - Add an explicit `portal_request_enabled`-style control. Every published
     item must contain exactly `publicId`, `sourceVersion`, `name`, nullable
     `summary`, non-empty `category` (maximum 100 characters), integer
     `displayOrder` (0–1,000,000), `geometryRequirement` (`none`, `optional`, or
     `required`), and 0–10 declarative client questions. The only question types
     are the contract's text, bounded number, boolean, select, and multi-select
     forms with stable field IDs.
   - Never publish unit prices by default, private formulas, margins, costs,
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
   - Reauthorize every organization/client/project/service public ID and their
     relationships. Recalculate actual draft pricing only in PA from current
     business rules, then snapshot the catalog/request source into the draft.
   - Store a durable unique key scoped to integration principal plus canonical
     payload hash. Equal replay returns the same draft; changed reuse is 409;
     concurrent delivery creates exactly one draft. Add a stable quote public
     ID and return only draft status/version, receipt/correlation ID, and a
     same-origin relative editor path or strictly allowlisted PA URL.
   - The command may create **only a draft**. It must never approve, publish,
     send, sign, create a contract/invoice, charge/pay, or notify a client.
   - Reject redirects on outbound/inbound integration hops as applicable and
     ensure ambiguous timeout retry resolves via the receipt without creating
     a duplicate.
   - Import or copy byte-for-byte
     `packages/shared/fixtures/project-alpha-draft-quote-v1.json` from LTDS.
     Run its valid request/response and every invalid request/response through
     the PA receiver tests. Reject extra keys, numeric legacy authorization
     IDs, mismatched area nullability, non-draft results, and non-relative
     editor paths exactly as the shared corpus requires.

6. **Integration security and operations**
   - Use separate credentials/scopes/secrets for portal projection, catalog
     projection, pricing preview, and draft creation. A broad/full key must not
     implicitly inherit the write scope.
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
