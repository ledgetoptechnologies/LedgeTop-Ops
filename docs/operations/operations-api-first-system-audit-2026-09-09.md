# Ledge Top Operations / Project Alpha — API-first system audit

Prepared September 9, 2026. **Decision document, not an implementation or deployment approval.**

**September 10 follow-up:** [Recorded answers and revised implementation decisions](api-first-decisions-2026-09-10.md) supersede the recommendations below where noted, particularly PA-first project creation, employee review, billing recipients and expansion sequencing. The source findings and test results below remain dated audit evidence, not deployment status.

## September 22 implementation delta

This table updates implementation evidence without rewriting the September 9
baseline or treating source changes as production acceptance.

| Audit area | Current implementation evidence | Remaining proof |
| --- | --- | --- |
| F01/F02 — generic API and explicit authority | PA PR #188 at `cbabe57e` and Ops PR #107 at `e2044dc` contain generic application identity, scoped Directory/Project APIs, revision/history fences and durable receipts. PA CI is green; Ops replacement CI is still running. | Merge/deploy neither PR until joined staging and rollback acceptance pass. |
| F04/F06 — customer ownership and reconciliation | The administrator review requires explicit source-qualified PA and Operations record selection. It creates only inactive mapping and owner-claim rows; there is no name/email matching or automatic activation. | Enable one least-privilege PA staging connection and prove reservation plus explicit activation on synthetic records. |
| F08/F09 — projects and financial boundaries | One-to-one project and Directory contracts preserve PA financial authority and separate client visibility from synchronization. Mapping activation and portal/client access are separate operations. | Complete joined two-instance acceptance and later production owner-approved mappings. |
| F14 — outage behavior | Per-instance incident state, bounded queues and the greater-than-ten-minute owner-alert contract are implemented default-off. | Live failure, recovery and unambiguous email-delivery acceptance. |
| Cutover state | Staging D1 was backed up, migrations 0123–0138 were applied, and Worker `5e0e00db-a05a-4e1f-8f8f-487ffad6b582` ran the corrected reconciliation cron. | The tick attempted zero sources because no PA staging API-v2 connection is enabled. No live reservation, mapping, owner claim or activation exists. |
| Production state | Existing PA client editing, portal access, Delivery rows and public links remain unchanged. | Deploy PR #188 to both PA instances, satisfy its exact-key/attestation gates, then explicitly activate managed mode only after Operations acceptance. |

The executive warning below therefore remains valid: implementation candidates
exist for several findings, but the coordinated production authority cutover is
not yet proven.

This audit evaluates the architecture discussed today: Operations becomes the daily business and client-management hub; the separate Project Alpha installations retain financial ownership; a generic API replaces PA's custom Operations integration. It also carries forward the unfinished Incoming, portal, delivery, and UI requirements so that changing direction does not erase them.

## 1. Executive recommendation

**Proceed with this direction, but treat it as an ownership migration with a new API contract—not an authentication cleanup.** It is a better fit for running drone and website work from Operations, particularly for employees who do not need PA accounts.

- Use Operations for shared customer records, onboarding, customer organization structure, staff access, operational projects/jobs, service requests, time capture and time approval.
- Keep PA authoritative for its own users/permissions, invoices, quotes, contracts, payments, expenses, financial rates, compensation processing and financial history.
- Give each PA installation a separate, explicitly scoped machine connection. Do not give Operations an automatically expanding full-access key.
- Keep PA generic: optional externally managed resource families, normal public APIs, neutral labels and standalone behavior. No business-specific company names or mandatory Operations dependency in PA.
- Build and rehearse the replacement completely, then perform **one coordinated authority cutover**. Preparation in an isolated environment or read-only comparison is not a gradual dual-writer rollout.
- Retire the custom Operations/portal integration after every dependency has a replacement. Retain the historical records and reusable security/retry/audit primitives it currently protects.

**The current system is not ready for that cutover.** The biggest gaps are generic write APIs, independent Operations staff admission, canonical customer/project ownership, an external-worker time import, financial-document visibility, and a tested migration preserving access/history. There are also concrete retention and workforce representation issues to correct before depending on the new model.

The application code and production settings were not changed for the original
September 9 audit. Its implementation goal was subsequently replaced by the
approved [current migration register](api-first-migration-plan.md); Section 9 is
historical proposed wording, and the final section records the questions that
were later resolved in the decision addendum.

## 2. Scope, evidence and limitations

### Source baseline

- Operations reviewed checkout: [Goal-Completion][ops-root], revision `ba56d72a41cc1bfde2836c0e1ea75929f107a675`.
- PA reviewed checkout: [cron-preflight-diagnostics][pa-root], revision `a641fadc3742dff3d11eabb86c0e3797f398f989`.
- Existing local Operations reminder/configuration/test/checkpoint edits and the pre-existing PA PHPUnit cache change were preserved. Findings concern this source baseline, not an assertion that every local change is deployed.
- Parallel reviewers examined PA/API, Operations/portal, and workforce/finance. Important conclusions were reconciled against the active checkouts; recommendations that conflicted with today's decisions were not adopted.
- Reviewed code includes API authentication/scopes, dispatch, source ingestion, staff admission/ACL, customer and portal identity, projects/deletion/status, time approval/compensation, document links, notifications, relevant migrations, rollout scripts and test coverage. This is a system architecture and correctness audit—not a claim that every line, every dependency, or every possible vulnerability was exhaustively tested.
- Cloudflare and Workers review guidance informed the runtime, binding and durable-work assessment; current primary documentation is cited where relevant. This is not a new Codex Security scan or penetration-test certificate.

### Verification performed for this audit

| Check | Result | What it establishes |
| --- | --- | --- |
| PA focused suites: ProjectCloseGuardServiceTest, WorkforceCatalogCompensationTest, PublicLinkEmailReuseTest | **27 tests / 129 assertions passed; no skips** | Existing status guards, selected compensation calculations/source invariants, and public-link reuse behavior in pure/in-memory fixtures. Not the future external-worker API or production MySQL concurrency. |
| Operations source-layout, portal-rollout-manifest and release-profile suites | **35 tests passed; no skips** | Current release/configuration invariants. Some intentionally encode the old PA-owned architecture and must be replaced with equivalent new invariants. |
| Previously produced full Operations recovery report | **2,187 tests passed, zero failed/pending** | Historical local result recovered from its JSON report. It was not rerun as part of this audit and is not acceptance of the proposed design. |
| Current in-app browser discovery | **No open tabs returned** | No fresh authenticated UI, source-status or client-identity acceptance was possible in this pass. No sign-in or production writes were attempted. |
| Repository status/read-only review | Baselines recorded; existing edits preserved | No implementation, migration, branch cleanup, merge, deployment, permission change or credential access occurred. |

The [September 9 checkpoint][checkpoint] records earlier desktop checks and exact-head CI. It also records missing portal generations and an unpublished Incoming increment. Those are **dated observations**, not newly verified live state. Its newer two-source observations supersede the older September 8 audit's statements that LTT had never synchronized. Directory visibility, producer counts, successful CI and portal readiness are separate facts.

The older Downloads handoff files named earlier in the conversation were not present at their supplied paths during this pass. Current repository documents and today's conversation were used; the unavailable files were not represented as freshly reread. Viewer internals, TrueNAS live configuration, payment-provider dashboards, actual payroll and legal/tax compliance were not audited live.

## 3. Proposed ownership contract

“Source of truth” must mean **who may change which fields and actions**, not that every byte lives in one database. Financial references in PA and authorized portal read models can remain copies without becoming competing editors.

| Resource or action | Proposed owner | Other system's responsibility |
| --- | --- | --- |
| Customer identity, contact information, onboarding approval | Operations | PA receives a linked billing-customer copy; issued documents retain their historical snapshots. |
| Customer organizations, divisions/branches/departments, memberships | Operations | PA receives the structure it needs through a versioned generic contract. Membership is not an automatic financial or file grant. |
| Portal eligibility, individual login association, grants, revocations | Operations domain, enforced by the Client service | Default eligibility with verified sign-in and explicit content permissions; preserve current denials. |
| Operations staff accounts, role presets, business-line/division scopes | Operations | PA does not create, reactivate, disable or promote them after cutover. Cloudflare Access authenticates; Operations authorizes. |
| PA accounts, login allowlists, PA ACLs | Each PA instance | Manually administered there. Ops account creation never creates a PA login. |
| Worker/payee reference | Explicit link from Ops worker to PA worker profile | PA may have a worker without a PA login. Compensation and settlement remain PA-owned. |
| Shared project name, operational status, jobs/tasks, client collaboration | Operations | PA keeps a linked financial project. Importing a PA project does not automatically publish it to the client. |
| Invoices, project invoices, quotes, contracts, payments, expenses | PA | Operations/portal show authorized summaries and PA action links. No second accounting or payment engine. |
| Time entry, submission, review and operational approval | Operations | PA accepts immutable approved revisions; imported time is read-only locally. Financial processing is still allowed in PA. |
| Client pricing and compensation rules | PA, recommended | Operations chooses authorized presets and shows versioned previews; request-service availability is separately managed in Operations. |
| Financial email: invoice notices, payment receipts, financial reminders | PA | Operations may add deduplicated in-app activity, not a second email. |
| Requests, delivery/upload notices, feedback and work notifications | Operations/Client, by event type | One producer per event/channel; no historical notification flood during migration. |
| Delivery bytes and completed downloadable archives | Existing storage/delivery subsystem | Preserve object keys, public links, revocation and resume contracts. Customer renames do not move files. |
| Viewer sessions/models/processing | Existing Viewer boundary | Operations supplies the properly scoped identity/authorization contract; no Viewer implementation changes in this work. |

The Operations database should own the canonical business graph. The Client service can retain its own enforcement/read model, updated through a private, versioned internal contract. Avoid direct ad-hoc writes to both databases throughout UI handlers. A stale portal read model must never override a newer denial.

## 4. Findings and discrepancies

Priority here indicates importance to the proposed cutover, not a vulnerability severity score. **Critical** means cutover must not proceed without resolution; **High** means required implementation or regression work; **Medium** means product/operational clarity that needs explicit acceptance. “Verified” describes source behavior, not proof that production has encountered damage.

### F01 — Critical: replacing keys alone does not replace the integration

- **Verified:** PA's generic scope catalog is predominantly read-only. Client/project/invoice lists and snapshots exist, but generic client, organization-unit, project and approved-time upserts do not. Workforce's API-shaped endpoint requires a PA session and CSRF; it is not a machine-key import endpoint. See [API scopes][pa-scopes], [API authentication][pa-auth], [Workforce API][pa-workforce-api] and [snapshot v2][pa-snapshot-v2].
- **Impact:** Issuing a stronger key cannot make missing write operations or their transactional rules exist. Calling web form handlers with a service key or manufacturing an admin session would create unsafe coupling.
- **Required:** Introduce generic service-principal command/read services with explicit schemas, scopes, object checks, expected versions, durable idempotency and audit. Reuse domain services instead of duplicating form logic.
- **Acceptance:** An Ops-only employee can complete the entire intended workflow without a PA browser session; an API caller cannot obtain unrelated PA user-administration, payment or document-send powers.

### F02 — Critical: legacy API-key semantics are unsafe to extend blindly

- **Verified:** `full` is described as allowing current and future endpoints. The normalizer also maps legacy `read` and `write` spellings to `full`. Existing keys have revocation and optional exact-IP restrictions, but the inspected schema/authenticator does not enforce an expiry or a customer-organization scope; `organization_id` metadata is not carried into the service principal. See [scope normalization][pa-scopes], [key schema][pa-key-schema] and [authentication][pa-auth].
- **Impact:** Adding generic writes could silently give old keys new powers. A key's display name or stored `organization_id` is not evidence of record-level isolation.
- **Required:** Snapshot/version legacy key capabilities at upgrade or require explicit reauthorization for new sensitive scopes. Do not translate a legacy read key into a new read/write key. Add stable machine identities, independently revocable/rotatable credentials, explicit scopes, optional bounded lifetime and useful last-use/audit information.
- **Required:** Authorization is the intersection of installation, resource/action and allowed records. Operations enforces the logged-in staff/client's narrower permissions before using its service credential; PA independently enforces the machine's contract.
- **Acceptance:** An old full/read-alias key cannot mutate new resource families merely because PA was updated. Revoking one instance's key affects neither the other instance nor existing document encryption.

A PA API key and a Cloudflare Access service credential are different controls. Retiring HMAC/Ed25519 application-event signatures does not require removing Access or HTTPS. Credentials belong in server-side secrets, never browser storage, URLs, reports or repository files. API keys alone are not a complete authorization model; this aligns with [OWASP REST security guidance](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html).

### F03 — Critical: staff admission still depends on PA and a scheduled writer

- **Verified:** Ops authentication validates a human Access assertion, finds an active local staff record by email and binds its subject. PA ingestion populates/changes staff rows and roles. Most ordinary PA work visibility requires the staff member's PA user ID. See [staff authentication][ops-auth], [PA projection][ops-projection], [visibility filters][ops-visibility] and [ACL evaluator][ops-acl].
- **Verified:** Ops Sync's Access-group reconciler derives permitted emails from primary PA users/entitlements plus the protected owner. Its configured schedule runs every five minutes. See [Access reconciliation][ops-access-group] and [Sync configuration][ops-sync-config].
- **Impact:** A local-role UI alone will not make staff independent. The old reconciler could remove newly admitted Operations-only employees or restore PA-derived membership.
- **Required:** Migrate staff admission, protected-owner recovery and role provenance; replace or retire both webhook and scheduled PA staff writers in the same ownership cutover. Keep email-change and identity-rebinding workflows reviewed, rather than merging accounts automatically by email.
- **Clarification:** This is a **PA-to-Ops dependency** today, not a claim that Ops currently creates PA login accounts. Separate accounts may share an email without sharing permissions.
- **Acceptance:** Create an Ops-only worker; let scheduled reconciliation run; the worker can still sign in and see exactly assigned work. Disabling them blocks access despite a valid Access session. Changing their PA account cannot silently change Ops authority.

### F04 — Critical: the current customer graph is a projection, not the proposed CRM owner

- **Verified:** Operations has business-party grouping, local/account concepts, reviewed source links and source-qualified directory pages. Those are useful foundations, but current authoritative client collections still depend on PA records, connector visibility and PA-produced portal generations. See [business parties][ops-parties] and [Client Hub collection proof][ops-collections].
- **Impact:** Renaming projection tables or enabling every workspace bypasses the actual migration. Grouping two source records for display does not merge their people, departments, financial documents or grants.
- **Required:** Canonical customer, person, organization unit, membership and service-relationship IDs; explicit PA instance/resource mappings; controlled import and review of ambiguous matches. Preserve existing local records as well as both PA sources.
- **Required:** One person can belong to multiple customer units with different roles. Shared contact info, login identity, billing contact and delivery recipient are distinct relationships. Client-edited login email needs verification; changing a billing email must not transfer account ownership.
- **Acceptance:** A reviewed customer present in both instances has one useful Ops view, two correctly routed financial relationships, and no accidental cross-service sharing. A website-only customer receives no drone folders merely by signing in on the drone-branded hostname.

### F05 — Critical: default-on portal access needs an explicit ownership handoff

- **Verified:** Portal workspaces, source generations, principals/entitlements and identity-denial history already exist. Authorization relies on those proofs, not just a client directory row. See [workspace hierarchy][portal-hierarchy], [PA portal projection schema][portal-projection-schema] and [identity denials][portal-denials].
- **Impact:** The old and new systems cannot both repair membership from their own idea of truth. In particular, a migration or resync must not turn previously revoked people back on.
- **Required:** Preserve workspace handles where possible; otherwise use explicit old-to-new mappings covering grants, requests, feedback, Viewer identity, notifications and history. Copy and verify denials before admitting new allows. Introduce an ownership version that prevents old PA jobs from changing migrated roots.
- **Required:** Create portal eligibility/workspace automatically from an approved Ops customer, with **no launch/welcome email**. Verification and explicit resource grants remain required. Revoking a person or entire customer takes precedence over future import, restore or service changes until an authorized explicit restoration.
- **Acceptance:** Test existing revoked users, existing live links, new customers, historical imports and a customer linked to both PA instances. No notification is sent solely because the workspace was migrated.

### F06 — High: “externally managed” must be independent of a token and enforced everywhere

- **Verified:** Clients, organizations, departments, project editors and onboarding approvals remain local PA mutation paths. Payment-provider imports and some service functions can also create/change client records. Existing outbound hooks describe changes; they do not prevent local edits. See [client update][pa-client-update], [onboarding approval][pa-onboarding], [department controller][pa-departments] and [processor import][pa-processor-import].
- **Required:** Optional managed mode per resource family, tied to a stable external application identity. Enable it only through explicit PA admin confirmation after compatibility/backfill checks. Keep it unchanged when a credential expires or rotates.
- **Required:** A subtle badge and “Manage in connected application” link; hide relevant create/edit/delete controls, but keep authorized detail viewing and PA financial actions. Enforce the same restriction in domain services, imports, alternate controllers, background jobs and bulk actions.
- **Required:** Decide exceptions at field/action level: for example, PA may link a processor customer ID without overwriting Ops-owned contact details. An import encountering a new unmatched customer should create a reconciliation item, not silently create a competing canonical record.
- **Failure rule:** Loss of connection does not automatically unlock PA editing. Provide an audited owner-only recovery procedure, preventing a second writer before switching management modes.
- **Acceptance:** A standalone PA installation remains fully usable. A managed installation rejects forbidden local mutations even when a stale form or direct POST is used; token revocation does not unlock the client list.

### F07 — Critical: project deletion does not currently meet the promised history protection

- **Verified:** PA's [project delete controller][pa-project-delete] deletes project-document mappings and the project directly; it does not invoke the close-out guard or check linked financial dependencies there. The inspected baseline sets ordinary [invoice][pa-invoice-project-fk], [quote][pa-quote-project-fk] and [contract][pa-contract-project-fk] project references to null on deletion, but **project invoices and dependent items/payments cascade**. See [project-invoice][pa-project-fks], [item][pa-project-item-fk] and [payment][pa-project-payment-fk] foreign keys.
- **Impact:** “Delete only in PA” is not an adequate safety policy. It could remove project billing history or detach documents, depending on the installed schema and related data. No destructive production test was performed, and this is not a claim that unauthenticated deletion is possible.
- **Required before cutover:** A shared deletion/retention guard and a migration that preserves established project links and financial records. Ops and its API expose archive/complete/cancel, not permanent deletion of established projects. PA must protect them too.
- **Draft exception:** Only an unused, unlinked draft with no requests, documents, deliveries, hours or audit-dependent references can be discarded under a reviewed rule. Submitted requests can be withdrawn without erasing evidence.
- **Acceptance:** Attempt removal with a contract, ordinary invoice, monthly project invoice, payment, time entry and delivery. The established identity and all required financial/history links survive. Do not rely only on UI-hidden buttons or the status guard.

### F08 — High: one shared project needs explicit lifecycle and financial-link semantics

- **Verified:** PA's [close guard][pa-close-guard] supports stored `not_started`, `active`, `overdue`, `completed`, `cancelled`. The client-project selector `pa_active_project_filter_for_client` includes only active/not_started, excluding stored overdue; this does not establish behavior of every project-selection screen. The guard can block completion/cancellation for open contracts when enabled, while recording rather than blocking outstanding receivables. See [project selection][pa-project-selection].
- **Required:** One shared name, one immutable Ops project ID, explicit customer context. Duplicate names are allowed; matching names/addresses must never create links. PA's local numeric ID is qualified by its installation.
- **Proposed lifecycle:** Client draft → proposed → staff acceptance → confirmed project with PA link pending/linked. Operational not-started/active/completed/cancelled is separate from client display/archive and financial close-out. “Overdue” becomes a derived deadline warning, with a reviewed migration for existing stored overdue projects—not blindly resetting all of them to active.
- **Required:** New client drafts do not create billing projects. At acceptance, create or link the chosen PA record idempotently. A PA-created project can enter Ops as a staff-only import until explicitly published. Neither creation nor billing linkage automatically shares files or documents.
- **Required:** When work is complete but PA contract close-out is blocked, display that financial exception rather than bouncing the shared work status between systems. Existing financial document snapshots keep their original names; current shared project labels can change once in Ops.
- **Acceptance:** Football 2027 can contain multiple jobs and monthly invoices under one shared name. A one-time request can omit a project. A client hiding a completed project changes only their view, not another person's access or PA records.

### F09 — High: staff divisions and customer departments must not become one hierarchy

- **Verified:** PA customer departments are flat under an organization. Ops staff scopes are global/division/assigned/own, with PA business-unit references; normal projected-work filtering also depends on PA assignments. PA's snapshot includes a worker-unit collection whose current query returns no memberships. See [departments schema/controller][pa-departments], [PA snapshot][pa-snapshot], [Ops ACL][ops-acl] and [PA workforce access][pa-workforce-access].
- **Verified:** PA's “assigned” client-directory scope is not identical to “assigned” job scope: one can use business-unit membership while the other uses an explicit work assignment. Labels currently hide meaningful differences.
- **Required:** Two independent models:
  - Customer organization → typed customer units (division, branch, department), optional nesting, explicit membership and sharing rules.
  - Your staff → business-line permissions, internal division scope, assignments and actions. A drone division manager is not a website administrator.
- **Required:** Stable IDs, cycle/invalid-parent prevention, active dates, unit-move history and no silent flattening on an older PA API. A customer unit move must not automatically grant the new parent all historical restricted documents.
- **Required:** One shared policy definition for navigation, lists, search counts, individual reads, exports and mutations. Default deny; explicit denials win within the specified scope; temporary access expires; inherited scope is shown in an effective-access summary.
- **Acceptance:** Colin can manage the authorized drone division, create/assign himself work and send PA documents under his separate PA rights, without website visibility or permission to edit his pay. Another worker sees only assigned work. Changing a role never silently changes compensation.

### F10 — Critical: approved time cannot yet be imported for a worker without a PA login

- **Verified:** Worker profiles permit an optional user relationship, but existing time and approval paths still carry interactive user/approver IDs and join PA user data. Ops snapshots do not include a general time/earning import. See [time/worker schema][pa-time-schema], [time approval][pa-time-approval] and [Workforce API][pa-workforce-api].
- **Required:** Explicit external worker mapping and a generic approved-time import with Ops worker ID, assignment/job, actual intervals or duration, breaks, approval identity, immutable revision and rule references. PA validates the trusted service's authority without inventing a PA user or impersonating an administrator.
- **Required:** Imported time capture/approval becomes read-only in PA for this deployment, while billing allocations, pay review, invoice assembly and settlement remain financial actions there. Do not make the entire workforce module read-only.
- **Required:** Keep the original reviewer identity as external audit attribution; do not require a PA approver login for every Ops reviewer. The service principal remains the authenticated actor, and supplied human metadata must never expand its scopes.
- **Acceptance:** An Ops-only employee submits time; an authorized reviewer approves; PA receives the same approved revision once. A retry, changed payload under the same key, repeated approval, correction, or revoked mapping cannot create duplicate billable/payable records.

### F11 — High: compensation has useful primitives, but incomplete end-to-end proof

- **Verified:** PA separates time billing allocation from worker compensation and supports fixed, hourly, base/overage, percentage and nonpayable rules. It has revisioned approvals, correction consumption and eligibility checks. See [compensation rules][pa-compensation], [time billing][pa-time-billing] and [billing consumption][pa-billing-consumer]. Reuse these rather than building a second financial calculator in Ops.
- **Verified representation defect:** For eligible direct time using a fixed or base/overage rule, Approval can calculate a rule-specific amount and then record the earning method as literal `hourly`, with duration-based quantity. See [earning creation in ApprovalService][pa-earning-write]. This is a misleading metadata/audit representation; the audit does **not** establish that the stored amount or a payment is wrong. Test method, quantity, rate, amount and calculation snapshot together.
- **Verified policy coupling:** [WorkerEarningService][pa-earnings] blocks owner relationships as well as explicit owner-no-pay policy. Admin ACL role and ownership relationship are already distinct in parts of PA, but a future co-owner's hourly/fixed compensation still needs policy independent of ownership.
- **Required:** Base/fixed pay belongs to the assignment, not each time segment. Approval must choose one authoritative earning/materialization path, preserving existing billing-consumption deduplication. Multiple days, concurrent approvals or late corrections must not charge the base twice or duplicate an earning in old and new ledgers.
- **Required:** No automatic invoice or payout merely because time was approved. Fixed-job time is still recorded as work history. Manual bonuses, mileage/travel adjustments and corrections carry reviewer, reason and version. Already invoiced/settled entries use explicit adjustments, not silent history rewrites.
- **Required:** Store money in appropriate exact decimal/minor-unit representations, duration in exact units, rule/version/effective date and timezone context. Verify midnight/DST, breaks, rounding boundaries, multiple workers and work crossing a pay period. Software calculations are not a payroll-compliance determination.

### F12 — High: finance summary and action-link APIs are incomplete

- **Verified:** The existing invoice API filters by exact stored status and does not return due date or collection mode, so it cannot independently convey PA's full overdue/collection rules. Generic snapshot v2 deliberately excludes financial data and private links. A portal-ready financial read contract is missing. PA already has document lifecycle, public links and payment receipts. See [invoice API][pa-invoice-api], [snapshot v2][pa-snapshot-v2], [public links][pa-public-links] and [payment receipts][pa-receipt].
- **Required:** Separate finance summary, document metadata and permitted action-link reads. Include stable document identity, owning PA instance, customer/project links, currency, authoritative balances, contract lifecycle and freshness. Do not return broad revenue/expense/profit data to a client-facing consumer.
- **Required:** Respect PA's finalized/draft, direct-invoice and monthly-project-invoice rules. A monthly rollup must not count its child charges again in “amount due.” Include refunds, reversals, partial payments and overdue derivation; a stored status field alone is insufficient.
- **Important link behavior:** The existing reuse-or-create helper intentionally creates a new link when only expired/revoked links remain. That is valid for an explicit authorized send/create action, but must not be reused blindly in a read endpoint. A missing authorized action link should be reported as unavailable; link creation requires a separate permission and action.
- **Additional code distinction:** PA's existing public document controller can terminalize links and normalize legacy expiry settings while serving a view. It is not a side-effect-free machine read API simply because the user is viewing a page. Implement the new read contract in a dedicated service instead of proxying that controller. See [public document controller][pa-public-view].
- **Access boundary:** A PA public link is a bearer capability. Revoking a person's Ops portal access prevents new portal reads; it cannot make an already copied PA public URL private. PA controls that URL's validity. If stronger recipient-bound revocation is required, the public-link design must change explicitly.
- **Acceptance:** Authorized clients see only their published documents. Unrelated department members do not inherit billing access. Read/refresh never sends a document, accepts a quote, charges a card, rotates a URL or revives revoked access.

### F13 — High: notification ownership must survive polling, retries and bootstrap

- **Verified:** PA owns document email/public receipt flows; Ops already has leased/deduplicated delivery notification paths with eligibility checks. These are reusable patterns, not a completed financial notification bridge. See [PA email delivery][pa-email], [Ops notifications][ops-notifications] and [Incoming notices][ops-upload-notices].
- **Required:** An event/channel ownership matrix. PA sends financial emails, Operations sends its request/delivery notices, and the portal may show in-app financial activity. Historical import establishes a baseline cursor without announcing every past invoice/payment.
- **Required:** Deduplicate by stable event/document transition, recipient, channel and source—not the poll execution time. An invoice status oscillating through refund/correction needs versioned events, not repeated “paid” messages on every refresh.
- **Acceptance:** One uploaded batch produces the intended staff notice; PA payment reconciliation produces its receipt, with at most one corresponding in-app event. Retried pulls, backfills and notification recovery do not double-email clients.

### F14 — Critical: failures between databases must be recoverable without double effects

- **Verified:** Current code already has receipt hashes, source revisions, durable outboxes, connector checks and private Worker ingress. These safeguards are distributed across integration-specific paths. See [Ops Sync routing][ops-sync], [projection application][ops-projection] and [rollout manifest][rollout].
- **Required:** Reuse the mechanisms behind a generic adapter. A successful PA create followed by an Ops timeout is not a reason to create again with a different key. Durable command identity must support lookup/readback by external ID and request fingerprint.
- **Required:** Separate connection health, command backlog, finance freshness, client workspace readiness and authorization status. One green “sync healthy” label must not hide a missing workspace or rejected command.
- **Required:** Retry transport/temporary rate limits with bounds and jitter; surface schema/validation conflicts; stop credentials/authorization failures from retrying forever. Record last success, oldest pending age and safe reason codes per instance/resource family. No raw payloads, tokens or document URLs in diagnostic logs.
- **Required:** Native Operations work should remain usable while one PA instance is offline. New finance links show pending; financial summaries show last-updated/unavailable rather than zero balance. A stale cache cannot approve payment, grant access or undo a denial.

Private Worker service bindings remain appropriate internally; generic API access to PA does not require exposing internal Client/Operations RPC publicly. Cloudflare recommends [service bindings for Worker-to-Worker calls](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/). If Workflows run commands, steps must be granular and replay-safe; retries alone do not make a remote mutation idempotent. See [Cloudflare Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) and the [Stripe idempotency model](https://docs.stripe.com/api/idempotent_requests) as design references, not as claims that our new protocol exists.

### F15 — High: existing UX and Incoming work are not all live acceptance

- **Verified locally:** Responsive Client Hub layouts/search, Administration layout tests, source-aware Ledge Top portal branding, upload detail/status handling, ready-prefix publication and bounded ZIP browsing exist in the active code/tests. See [portal branding][portal-brand], [Client Hub browser tests][hub-browser], [navigation tests][nav-browser], [upload read path][incoming-read] and [Incoming runbook][incoming-runbook].
- **Not verified live in this audit:** Both PA portal workspaces, all feature gates, deployed Incoming publication, the TrueNAS remote-prefix switch, upload notice delivery, or individually identified clients using the new model.
- **Required:** Keep these as acceptance work, not “already done” because source or tests exist. Branding follows the customer's enabled services/context; hostname is presentation, never authorization.
- **Specific remaining contradiction:** The user's TrueNAS screenshot selects the incoming bucket root in hourly PULL/MOVE mode. That can download and remove internal quarantine objects before the app finishes. A lightweight check cannot solve an independent root-level MOVE race. Section 7 preserves the simple no-agent TrueNAS contract and its rollout prerequisites.

## 5. Target workflows and API design

### Client and organization workflow

- One onboarding invitation/request in Operations, with service interests selectable before or after submission. Client submission does not silently approve paid work or sign a contract.
- Staff approval creates the canonical customer and applicable PA billing-customer links. A person may be standalone or a contact of an organization; changing that relationship requires a reviewed move, not destructive replacement.
- One contact update can publish to LTDS, LTT or both according to explicit service/finance links. Billing/tax/document snapshots stay PA-owned. Sync status is per destination; one failure cannot roll back an unrelated successful service relationship.
- Existing customers import through reviewed mappings. Names/email can suggest possible duplicates but cannot merge identities or grants. A shared mailbox is not an individually identified person.
- Portal eligibility is default-on, with no announcement email. Revocation and subsequent explicit restoration are independently audited. Business/client archival is not an automatic instruction to destroy historical invoices or files.
- A customer-unit model supports All State Construction → Florida / Wisconsin when these are the same customer business; legally separate billing entities remain separate customers with an optional group relationship. Do not infer this from similar names.

### Project and request workflow

- The request form offers **No project / Existing project / Propose a project**. Do not make project creation a compulsory extra step for a one-off service.
- Staff acceptance selects/creates the actual project and appropriate PA financial link. Client-first and staff-first entry converge on the same ID/name. Show suggested possible matches; never auto-merge by name or address.
- For Wrightstown football, one project can group a season, several operational jobs, a contract, and monthly PA invoices. Both staff and client see the same current project name under clear customer context.
- By default, one operational project links to one PA financial project/instance. A customer can use both businesses without copying every project to both PA installations. Cross-business engagements require a deliberate billing arrangement, not an inferred second invoice.
- Portal hide/archive is a personal display preference. Organization-wide archival needs a separate permission. Neither action changes another user's access, cancels scheduled work or deletes PA data.
- Keep active work visible by default; completed/cancelled work moves to history. A withdrawn proposal remains distinguishable from cancelled approved work.

### Staff and financial permission workflow

- Define role presets such as assigned worker, division manager, finance manager and system administrator, backed by explicit capabilities and scope. Avoid a hardcoded Colin exception.
- Separate: create work, assign work, manage clients, view/send financial documents, discount pricing, log own time, review others' time, self-confirm time, adjust compensation, approve earnings and settle/export pay.
- Colin can run authorized drone work autonomously, select standard packages and complete jobs. He need not ask the owner to create each job, but broader work authority does not imply setting or approving his own pay.
- PA separately governs whether Colin may create/send contracts and invoices. Ops cannot grant those PA privileges. Offboarding needs a visible checklist covering both apps and the identity provider.
- A future co-owner gets whatever business permissions are explicitly granted. Their compensation policy can remain fixed/hourly or become nonpayable without changing their access role.
- Operations team creation should continue using the identity provider; do not invent a second password store merely to make accounts independent from PA.

### Time/pay examples that must become executable fixtures

| Case | Work recorded in Operations | Client billing in PA | Worker compensation in PA |
| --- | --- | --- | --- |
| Hourly employee | Four approved hours | 4 × $100 = $400, eligible for a later/batched invoice | 4 × $50 = $200 gross earning, not automatic payout |
| Fixed photo package | Actual time plus one completed assignment | $150 package | $75 fixed earning, not 50% of whatever the invoice becomes |
| Two-hour recovery | Two actual hours; one assignment with one included hour | $350 base + $50 overage = $400 | $150 base + $30 overage = $180, plus separately approved travel if applicable |
| Owner's two-hour visit | Two approved billable hours | Two hours at the chosen client rate | Explicit no-automatic-compensation policy; no wage accrual |
| Multiple days / entries | Several entries against one assignment | One base allowance across the assignment; eligible charges can join one invoice | One fixed/base earning, plus approved overage; no base per entry |
| Corrected entry after financial processing | Append a correction/reason and approved revision | Reviewed adjustment/credit or unbilled replacement, as appropriate | Reviewed adjustment, not deletion of settled history |

The difference between client revenue and gross worker earnings is **not automatically net profit**; expenses, other costs and taxes remain separate. This document defines software behavior, not employee classification, wage or tax advice.

### Minimum generic PA API contract

The names below are proposed capability families, not implemented endpoints:

- Installation identity/capabilities/version; stable supported resource and enum metadata.
- Customers, people, organizations, customer units and relationships: paginated reads plus scoped upsert/archive/restore commands with explicit management policy.
- Financial projects: read/import discovery, create-or-link, managed shared-field update and safe lifecycle commands. No permanent-delete capability granted to Ops.
- Workers: link/upsert a financial worker reference without PA account creation or ACL changes.
- Approved time/assignment completion: idempotent import, status/readback, correction and financial-processing status. No second time approval by a fabricated PA admin.
- Catalog/pricing/compensation: distinct scoped reads, versioned previews and authorized rule references; worker pay information never rides in a client catalog response.
- Documents/receivables/contracts: client-filtered metadata and current balances, action-link reads, receipt/activity status. Separate any explicit create-link or draft-quote command from reads.
- Changes: stable cursor/page boundaries, source versions and tombstones for PA-owned financial changes; no need for PA to know the Ops domain or custom webhook URL. Scheduled Ops pulls are the recommended starting transport.

Every mutation needs resource identity, payload schema, expected version, idempotency key, deterministic conflict behavior, audit attribution and a stable response/readback. Same key/same payload returns the original result; same key/different payload is rejected. Object validation, mutation, audit and command receipt commit together in PA. Retry records outlive the supported replay window; durable external mappings must prevent duplication even after old response caches are pruned.

Use a connection configuration in Worker secrets for each installation, as requested. Administration can show sanitized health/capabilities and repair actions, without a public “register a source” form. No direct MySQL access from the browser or shared database access between apps is proposed.

## 6. Removal inventory and compatibility constraints

Retire integration-specific behavior only after accounting for all its consumers. “Remove custom integration” does not authorize erasing historical evidence or unrelated financial integrations.

| Existing component family | Target treatment |
| --- | --- |
| PA External Operations settings, application key, signer/key lifecycle, event sender/outbox | Remove the feature-specific setup/runtime once generic API commands/reads replace its consumers. Drain or explicitly retire pending records with preserved outcomes; no invisible discard. |
| PA portal authority/provisioning, projection sender/reconciler | Transfer identity/membership/service ownership to Ops with migration receipts. Preserve public IDs and existing denials/history; stop both scheduled and manual PA writers. |
| Service catalog/assignment/contact projection and pricing/draft-quote contracts | Replace each with an explicit generic read/command capability. Do not assume deleting the workspace sender covers these families. |
| Ops signed event ingress and primary staff/group reconciliation | Retire PA-derived staff authority. The Sync worker may remain as a generic adapter/scheduler; it need not remain a public signed-event receiver. |
| Internal Client/Operations service bindings | Retain where useful, with a neutral internal contract. Removing public PA callbacks does not mean removing private RPC authorization. |
| Managed delivery intent transport | Inventory recipients, scheduled documents and pending delivery IDs; replace the custom application transport without dropping legitimate document/delivery work. |
| AlphaLedger and notification relay | Review separately. Their presence in the code does not prove they are deployed or exclusive to this integration. Preserve unrelated accounting/email functions unless separately approved for retirement. |
| App encryption keys, payment-provider webhooks, user sessions, public-link tokens | Retain. They solve different problems. Do not delete a shared encryption key/volume or remove payment webhook verification as part of API simplification. |
| Rollout manifests, fixtures, cron jobs, feature flags, env types, documentation | Replace the old ownership invariants coherently. Do not simply delete tests that reject the new model; add replacement isolation/retention tests first. |

Repo evidence for current routing and services is in [Ops Sync][ops-sync], [PA API scope catalog][pa-scopes], [PA projection contract][pa-portal-contract], [rollout manifest][rollout] and [root test scripts][ops-package]. Configuration names/Worker identities have moved to Ledge Top; compatibility names in database bindings or public URLs must not be renamed without a verified migration.

### Mandatory preservation ledger

- Source-qualified PA IDs, reviewed business-party links and all pre-existing local clients.
- Existing portal workspace/person identities, explicit grants, denies, expiry history and delegated-share relationships.
- Public incoming/delivery URLs, legacy client-to-portal redirects, PA financial URLs and each route's authentication policy. Redirects preserve path/query; host names never become a grant.
- R2 object keys, uploaded bytes, thumbnails, delivery versions and active resumable archive artifacts; no file move driven by a customer rename.
- Requests, approval history, draft quote linkage, feedback, uploads, notification dedupe state, operational memory, recurring-project copy-forward, SOP assignments and Viewer subject identity.
- Issued contracts/invoices, monthly project invoices/payments, time revisions, settled earnings, export history and audit trails.
- Deployment manifests and both PA web/cron process versions, shared config mounts and existing encryption material.

## 7. Previously requested work retained in scope

### Incoming uploads and the simple hourly TrueNAS task

- The chosen server model is **ordinary TrueNAS Cloud Sync/rclone**, not an extra scanner agent/container. Preserve hourly PULL/MOVE at the start of each hour and the existing destination.
- The current source contract stages private multipart uploads, performs bounded ownership/completion/size/signature sanity checks, and publishes collision-isolated filenames under `ready/`. These checks are **not an antivirus scan**, and an invite-only link does not make uploaded content automatically safe.
- Before publication is enabled, the TrueNAS remote selection must change from bucket root to **only `ready/`**. Confirm the exclusive writer and retention policy for that prefix. Do not remove the local opaque quarantine folder: its object may be the original upload, not disposable junk.
- Known current code has a disabled-by-default publication gate, durable dispatch, bounded promotion, staff detail/download and ZIP inventory navigation. It deliberately does not guess delivery success after an ambiguous publish response or missing object. See [promotion][incoming-promotion], [read authorization][incoming-read] and [runbook][incoming-runbook].
- Staff can browse a ready upload while it remains in R2; lists show immediate children, not recursive totals. Opening a ZIP lists bounded metadata rather than downloading/extracting all contents. Unsupported archive browsing is not the same as a rejected upload.
- After rclone MOVE removes the ready object, show **No longer in R2; server pickup unconfirmed** unless a separate receipt exists. Ordinary rclone has no callback, so Operations cannot prove the local copy arrived or resume a browser download from an object that was removed.
- Add a visible bounded “needs attention” state for genuinely uncertain cases. The normal path must be prompt, but rare failure ambiguity cannot safely be solved by blind republishing, which could duplicate server deliveries.
- Email the configured staff recipients when an upload is durably received, using a deduplicated upload/batch event. Do not wait for server pickup; do not describe basic validation as virus-free. Verify delivery to the intended mailbox before declaring the missing-email issue resolved.

### Client Hub, Operations and portal UX

- Keep the requested top-level order: Dashboard, Airspace, Operations, Client Hub, Models, Data, Administration. Operations focuses on projects/jobs/tasks/SOPs; the bell owns notifications, and client intake/feedback belongs under Client Hub until approved work exists.
- Client Hub provides one place for customer services, projects, delivery, websites, contacts and financial summaries. Use a compact secondary/side navigation within the customer workspace; avoid one enormous vertical detail page.
- Preserve dynamic type-to-search, source/service filters, pagination, visible current-view counts, breadcrumbs, and stable back navigation. Count immediate folders/files separately when useful, not the entire subtree.
- Preserve responsive 1/2/3/4-card layout where space allows; wide financial tables may span the grid. Test phone, tablet, desktop and ultrawide, browser zoom, keyboard focus, long names, empty data, errors and loading—not only ideal fixtures.
- Frequent actions/details appear first; revocation and destructive controls form a clear bottom danger area. Explain the scope and consequences before confirmation.
- File sharing defaults to public link with a clear mode switch to Client Workspace. Organization/department/person recipients are explicit; selecting a person must not silently broaden sharing to their entire organization. “Share current folder” belongs beside the breadcrumb/action row. Recent links follow the current folder context and do not collide with trash controls.
- Use shared Ledge Top typography/components with service accents and clear LTDS/LTT financial context. Both portal hostnames support the authorized workspace/service experience. Greet the authenticated client by their safe display name; branding alone cannot authorize or enroll a service.
- Native Viewer sharing remains in the Viewer workspace rather than returning as an extra Models dashboard grant form. Preserve fine-grained Ops model/processing/storage ACLs and the existing renewal integration boundary.

### Other retained backlog items

- Website inventory, service request details and monthly website reporting need explicit canonical customer/service links. The user allowed a manual-first report process; do not fabricate uptime, security or traffic statistics. Data provenance, reporting period, draft/review/publish state and client visibility are required. This audit did not establish a completed website-report module.
- Hermes API access remains a **separate scoped service principal**, not reuse of the powerful Ops-to-PA credential. Expose only approved Ops capabilities with audit, idempotency and suitable approval boundaries. Do not let an agent impersonate an owner or manipulate payroll/security implicitly.
- Large delivery downloads retain the existing one-pass ZIP64/completed-cache design and Range/If-Range resume. The [ZIP runbook][zip-runbook] explicitly says first trusted archive reads still produce missing CRCs; checksum-at-ingest is not universally complete. Do not promise instant first-time preparation of a 30 GB archive or resume after the underlying authorization/object expires.
- Preserve the Viewer session-continuity acceptance request: two renewal cycles, map/cloud switch, save near renewal, sleeping tab, separate real staff/client identities, stable scope, and genuine revocation/expiry. No blanket TTL extension or Viewer source edit is part of this audit.
- PA branch cleanup is postponed until after an approved release and explicit branch inventory. `main` and `dev` remain off-limits for cleanup. No branch removal is part of this document task.

## 8. Implementation plan and one-time cutover

These are dependency-ordered work packages, **not separate production authority transitions**. Several can be developed/tested in parallel after the ownership contract is approved.

### A. Finalize contracts before writes

- Resolve the questions at the bottom; record the agreed ownership/field/permission matrix.
- Write a neutral versioned API specification and shared fixtures, including source identity, customer units, worker references, finance actions and error semantics.
- Inventory all old writer paths, pending outboxes and feature gates. Mark PA-specific reference docs historical and introduce a current architecture index.
- Define the management-policy administrator, the cutover version/fence, who may restore local management, and measurable live acceptance criteria.

**Exit gate:** Each mutable field has one owner, each externally visible action one authority, and no unaccounted integration consumer.

### B. Generic PA foundation and prerequisite correctness

- Implement machine identities and scoped APIs without widening legacy keys; enforce managed-mode checks through services.
- Add stable external mapping/idempotency/version storage and actor attribution independent of PA user creation.
- Add project retention/deletion protections and migration, status/overdue normalization, hierarchy support and read-only imported-time behavior.
- Resolve compensation-method representation and verify base/overage, correction and owner-policy behavior.
- Implement minimal financial metadata/action-link/change-feed interfaces while preserving PA document, receipt and email logic.
- Keep standalone PA workflows functional with managed mode off; document API examples with neutral organization names.

**Exit gate:** MySQL-backed tests, generic service authorization tests and unchanged standalone/user-session workflows pass. No production write authority has moved yet.

### C. Operations canonical model and employee workflows

- Add customer/person/unit/service relationship storage and durable per-instance PA mappings.
- Add independent staff administration, scoped action evaluation, owner recovery and the replacement Access-admission reconciler.
- Add project proposals/approval/link status, one-off jobs, time entry/submission/review and versioned financial export commands.
- Implement API adapter queues and resumable reconciliation. Native work survives a PA outage without inventing financial success.
- Update Client Hub/admin/portal pages and optimistic-concurrency error handling, preserving existing responsive/navigation behavior.

**Exit gate:** New canonical journeys work against an isolated PA pair, including lost responses, duplicate IDs/names, revocation and cross-business scope.

### D. Portal, finance reads and compatibility migration

- Rehome workspace authority without losing identities, denials, public links, request/feedback history or delivery grants.
- Implement authorized finance reads, public-link availability and deduplicated in-app activity. Seed history silently.
- Update internal Client/Operations contracts, shared types, migrations and release manifests together.
- Build migration reports with counts, references and ambiguity lists—not client PII dumps. Require reviewed mappings for unresolved records.
- Run old-link and resume compatibility checks, plus the retained Incoming and Viewer-boundary suites.

**Exit gate:** Rehearsed migration preserves references, denial behavior, document amounts and storage identity. Client and staff acceptance is joined across services, not only mocked independently.

### E. Rehearsal and production switch

1. Take private, restorable backups of **both PA databases**, Operations D1 and Client/Delivery D1, plus required configuration/key material through an approved secure backup process. Existing backup permission does not authorize publishing any backup. Verify restore, FK integrity and reference counts in isolation.
2. Record deployed revisions/capabilities for PA web and cron plus all affected Workers. Verify both PA installations support the new contract; do not cut over one incompatible half.
3. Establish a bounded maintenance/read-only window for the records whose ownership moves. Handle client submissions predictably: queue through a supported durable path or show maintenance, never silently drop them.
4. Quiesce old PA authority writers and manual mutation entry points; record final source positions and pending-event dispositions. Retain payment webhooks and normal financial processing, with incremental capture for any allowed finance changes.
5. Apply migration/backfill, establish explicit customer/worker/project maps and seed portal read models/denials. Resolve all critical discrepancies before opening writes.
6. Activate the new Ops ownership version and PA managed policies; prevent old jobs/tokens from mutating those resource families. Replace staff group reconciliation before admitting Ops-only workers. This is coordinated across systems, not a claimed cross-database atomic transaction.
7. Prove one controlled workflow per business plus a shared customer, revoked user, Ops-only employee and preserved public link. Then open canonical writes and monitor command backlog/freshness/denials.
8. Remove the retired custom setup/runtime/configuration and obsolete narrowly scoped credentials after verified retirement. Preserve audit/tombstones and generic safeguards. Do not retain a silent legacy mutation fallback.

**Rollback boundary:** Before new canonical writes, restore the frozen state/configuration if necessary. After new writes, jobs, emails or financial actions have occurred, a blind D1/MySQL restore can lose real work or duplicate effects. Freeze affected mutations and reconcile the durable command/event ledger; use fix-forward or a tested reverse migration. Never “undo” a payment or receipt by database rollback.

### F. Final acceptance and documentation

- Record exact source/deployed versions, migration results, live outcomes and remaining limitations without secrets or client-data dumps.
- Retire old ownership docs and setup screens, add troubleshooting/rotation/offboarding/retention runbooks, update PA's generic API docs and Ops's internal connector instructions.
- Finish retained Incoming, UI/dual-brand and individual-client tests. Keep website reports and Hermes API as explicit backlog unless included and accepted in the release.
- Only mark the future goal complete when the agreed acceptance matrix passes—not when code compiles or the usage/time budget runs out.

## 9. Proposed replacement goal and task checklist

**Draft objective for discussion; not applied to the app's goal:** Make Ledge Top Operations the canonical client, organization, portal-access, staff-access and operational-work system for both business lines, while the separate Project Alpha installations remain generic financial systems with independent users. Replace PA's custom Operations integration with scoped, versioned APIs and optional externally managed resource modes through one rehearsed, recoverable authority cutover. Preserve identities, financial history, public links, denials, delivery/Viewer boundaries and outstanding Incoming/UI requirements; verify real employee/client journeys, failure recovery and both deployments before completion.

- [ ] Approve ownership matrix and final product questions.
- [ ] Specify API, mappings, management mode, scopes and legacy-key upgrade policy.
- [ ] Fix project retention and test compensation representation/assignment aggregation.
- [ ] Implement PA generic commands/reads and external worker/time import.
- [ ] Implement Operations canonical customers, units, staff ACL and project/time workflows.
- [ ] Migrate Client authority/denials and financial dashboard/activity.
- [ ] Rehearse complete data/permission migration, one switch and rollback boundary.
- [ ] Complete retained Incoming/TrueNAS rollout and notifications without adding a server agent.
- [ ] Verify responsive staff/client UX and dual-brand behavior.
- [ ] Preserve and test public links, ZIP resume/cache and Viewer session continuity.
- [ ] Record live two-instance, shared-customer, Ops-only staff and revocation acceptance.
- [ ] Retire custom integration code/settings/jobs safely; update generic PA and internal Ops docs.
- [ ] Track website reporting and scoped Hermes API as explicit deliverables, with no implied completion.

## 10. Acceptance matrix

| Area | Required cases | Pass condition |
| --- | --- | --- |
| Generic key upgrade | Legacy read/full aliases, missing scope, wrong installation, revoked/expired credential | No accidental new authority; clear recoverable diagnostics and audit. |
| Managed mode | Stale UI POST, direct API, onboarding, import, cron, token rotation/outage | Only the selected authority edits managed fields; standalone PA still works. |
| Customer identity | Same names, shared email, both PA sources, standalone → organization, unit move | Explicit stable mappings; no automatic merges, identity takeover or grant expansion. |
| Portal default-on | New/existing customer, historical deny, person/org revoke/restore | Workspace eligibility automatic and silent; login verified; denials persist and resources stay scoped. |
| Staff access | Ops-only worker, division manager, website-only worker, co-owner, offboarding | Correct list/item/action access; PA account remains independent; pay unchanged by role changes. |
| Project workflows | Client draft, staff first, PA import, duplicate name, rename, optional project | One shared name/ID; exactly one intended PA link; no automatic client publication. |
| Retention/status | Open contract, outstanding invoice, monthly invoice/payment, archive/hide/cancel/delete | No linked history loss; work, financial close-out and visibility states remain distinct. |
| Time/compensation | All examples in section 5, split entries, multiple workers, midnight/DST, corrections | Exact approved durations and rate snapshots; one base per assignment; no duplicate earning/invoice or self-pay escalation. |
| Finance portal | Draft/finalized, direct/monthly rollup, partial/refund/overdue, recipient restriction | Correct balance once, explicit currency/source, no broad financial leakage. |
| Public document actions | Missing/expired/revoked link, copied bearer URL, payment redirect | Read has no create/send/pay side effects; PA lifecycle remains authoritative. |
| Notifications | First import, repeated polling, replay, partial send, revoke before send | No historical flood or double email; sender/channel ownership is enforced. |
| Failure recovery | PA down, API 429, changed schema, PA committed/Ops timeout, out-of-order revision | Durable readback/retry or actionable conflict, not silent data loss or duplicate writes. |
| Incoming | New/old upload, lost publish response, root→ready switch, MOVE/removal, expired/revoked request | Quick bounded basic checks, safe pickup, browsable while present, no false server-delivery claim. |
| UI | Phone/tablet/desktop/ultrawide, keyboard/zoom, slow loads, empty/error state | Clean layout, consistent typography, no inaccessible controls or misleading statuses. |
| Delivery/Viewer | Existing shares, legacy redirect, large ZIP resume/cache, two renewals/sleep | Existing authorization/link identity retained; no new Viewer rights or dependency on PA login. |
| Migration | Populated backups, active denials, in-flight events, restore/replay | FK/reference integrity, no lost history, no dual writer or duplicate financial effect. |

No fresh live tests in this audit satisfy these future-design gates. Existing passing tests are baseline evidence and must be augmented, not described as proof of the new system.

## 11. Evidence references

These links use repository-relative Operations paths and commit-pinned Project
Alpha source URLs. They are source anchors for the dated findings, not a
requirement that the eventual implementation keep the same filenames.

[ops-root]: ../..
[pa-root]: https://github.com/ledgetoptechnologies/Project-Alpha/tree/a641fadc3742dff3d11eabb86c0e3797f398f989
[checkpoint]: client-portal-checkpoint-2026-09-09.md
[pa-scopes]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/utils/api_scopes.php#L3
[pa-auth]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/utils/api_auth.php#L31
[pa-key-schema]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/utils/api_keys_schema.php#L41
[pa-workforce-api]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/api/workforce_v1.php#L26
[pa-snapshot-v2]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/OpsSnapshotV2Service.php#L13
[pa-snapshot]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/OpsSnapshotService.php#L158
[ops-auth]: ../../apps/operations/src/worker/auth.ts
[ops-projection]: ../../apps/ops-sync/src/projection.ts
[ops-visibility]: ../../apps/operations/src/worker/visibility.ts
[ops-acl]: ../../apps/operations/src/worker/acl.ts
[ops-access-group]: ../../apps/ops-sync/src/access-group.ts
[ops-sync-config]: ../../apps/ops-sync/wrangler.jsonc
[ops-parties]: ../../apps/operations/src/worker/business-parties.ts
[ops-collections]: ../../apps/operations/src/worker/client-hub-collections.ts
[portal-hierarchy]: ../../apps/client/migrations/0121_client_workspace_hierarchy_v2.sql
[portal-projection-schema]: ../../apps/client/migrations/0125_project_alpha_portal_projection.sql
[portal-denials]: ../../apps/client/migrations/0136_portal_v2_identity_denials.sql
[pa-client-update]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/client/clients_update.php#L28
[pa-onboarding]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/client/client_onboarding_review.php#L130
[pa-departments]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/organization/organization_departments.php#L18
[pa-processor-import]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/PaymentProcessorImportService.php#L263
[pa-project-delete]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/project/projects_delete.php#L40
[pa-project-fks]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/database/baseline.sql#L898
[pa-project-item-fk]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/database/baseline.sql#L918
[pa-project-payment-fk]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/database/baseline.sql#L961
[pa-quote-project-fk]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/database/baseline.sql#L1044
[pa-contract-project-fk]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/database/baseline.sql#L1137
[pa-invoice-project-fk]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/database/baseline.sql#L1255
[pa-close-guard]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/ProjectCloseGuardService.php#L20
[pa-project-selection]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/utils/project_selection.php#L20
[pa-workforce-access]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/WorkforceAccessService.php#L70
[pa-time-schema]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/database/baseline.sql#L2805
[pa-time-approval]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Modules/Timekeeping/ApprovalService.php#L289
[pa-compensation]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/CompensationRuleService.php#L23
[pa-time-billing]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/TimeBillingAllocationService.php#L12
[pa-billing-consumer]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Modules/Timekeeping/BillingTimeConsumer.php#L17
[pa-earning-write]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Modules/Timekeeping/ApprovalService.php#L386
[pa-earnings]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/WorkerEarningService.php#L90
[pa-invoice-api]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/api/invoices_list.php#L7
[pa-public-links]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/utils/public_links.php#L42
[pa-public-view]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/public_view/public_doc.php#L49
[pa-receipt]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/public_view/payment_receipt.php#L6
[pa-email]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/controllers/email_send.php#L51
[ops-notifications]: ../../apps/operations/src/worker/notifications.ts
[ops-upload-notices]: ../../apps/operations/src/worker/incoming-upload-notifications.ts
[ops-sync]: ../../apps/ops-sync/src/index.ts
[rollout]: client-portal-rollout-manifest.md
[pa-portal-contract]: https://github.com/ledgetoptechnologies/Project-Alpha/blob/a641fadc3742dff3d11eabb86c0e3797f398f989/src/Services/PortalIntegrationContract.php#L97
[ops-package]: ../../package.json
[portal-brand]: ../../apps/client/src/client/portal-brand.ts
[hub-browser]: ../../apps/operations/test/browser/client-hub-directory.spec.ts
[nav-browser]: ../../apps/operations/test/browser/responsive-navigation.spec.ts
[incoming-promotion]: ../../apps/operations/src/worker/incoming-rclone-promotion.ts
[incoming-read]: ../../apps/operations/src/worker/incoming-rclone-read.ts
[incoming-runbook]: ../truenas/incoming-rclone.md
[zip-runbook]: bulk-zip-performance.md

## 12. Questions for our next discussion — with recommendations

- **Can we confirm that Operations is the only normal editor of shared customer information and customer organization structure after cutover?**
  - **Recommendation:** Yes. PA keeps finance-specific fields and issued-document snapshots. Unexpected PA-side edits become review items, not automatic bidirectional overwrites. This is much simpler than ongoing three-way field conflict resolution.

- **Should new projects normally be created in Operations once managed mode is enabled, or must Colin still create them directly in PA?**
  - **Recommendation:** Default to Operations creation for new work, then link/create PA automatically at staff confirmation. Import existing PA projects during migration. If ongoing PA-first creation is essential, make it an explicit “unlinked financial project” intake path requiring Ops review; do not silently operate two editors for linked fields.

- **Is one PA financial project per Ops project the right default, even when the customer uses both businesses?**
  - **Recommendation:** Yes. Select the billing business explicitly. Separate cross-business work into deliberately linked engagements/jobs where needed; do not duplicate the whole project or invoice into both PA instances automatically.

- **Should one approved customer have one portal workspace spanning services, or separate service workspaces behind one login?**
  - **Recommendation:** One customer-level experience with service sections and explicit person/unit/project grants. Preserve existing workspace IDs as compatibility references rather than merging grants blindly. Separate workspaces remain available where different customer entities or confidentiality require them.

- **Who can approve Colin's own work and compensation when he creates a job himself?**
  - **Recommendation:** Let his division-manager role create/assign/complete standard work and record actual time. Initially require an authorized second reviewer for payable earnings or exceptions; allow narrowly configured self-confirmation only if you choose it, without pay-rule or settlement privileges.

- **Where should standard client pricing, worker pay presets and travel adjustments be maintained?**
  - **Recommendation:** PA owns financial rules; Operations selects permitted presets and shows their versioned meaning. Keep worker pay private, independent of client discounts, and require approval for overrides. Service visibility/request availability stays in Operations.

- **Should ownership automatically mean no compensation, or should every worker have an explicit compensation policy?**
  - **Recommendation:** Explicit policy for everyone. Your own profile can remain no-automatic-compensation; Colin becoming a co-owner need not erase a fixed/hourly agreement or grant new permissions automatically.

- **Who in a customer organization can see invoices/contracts and use their public action links?**
  - **Recommendation:** Explicit billing/document recipients or a delegated billing role, not all organization members. Department/project sharing and billing access remain separate. A copied public PA link remains valid under PA's own policy; choose recipient-bound links only if that stronger requirement is needed.

- **If a financial action link is missing or revoked, may Operations create one automatically?**
  - **Recommendation:** No action on read. Show unavailable/request assistance. Permit explicit staff creation through a separately scoped command if wanted; never revive a deliberately revoked link during dashboard refresh.

- **For All State and similar customers, are geographic divisions one billing entity or separate customer entities?**
  - **Recommendation:** Use typed units under one organization only when they are genuinely one customer entity. Keep separate billing entities distinct and link them through a group when useful. Staff divisions remain unrelated to this customer tree.

- **How much financial staleness is acceptable when PA is offline?**
  - **Recommendation:** Show a timestamped last-known summary with an offline warning; refresh on entry/action and at a bounded interval. Never display unknown balance as zero or confirm payment based on browser return. Choose an explicit maximum age before displaying actions as unavailable.

- **When a client hides or archives a project, should that apply only to them or to the whole organization?**
  - **Recommendation:** Personal hide by default. Organization-wide archive is a separate permitted action; neither deletes data, cancels work or revokes existing access. Keep completed history searchable and active work visible unless intentionally hidden.

- **Do any AlphaLedger, notification-relay or managed-delivery features need to survive independently of the old custom Ops connection?**
  - **Recommendation:** Preserve unrelated finance/email functionality. Remove every part of the custom Ops integration only after its dependency inventory has a replacement or explicit retirement decision; retain encryption, audit, history and payment verification.

- **Can the Incoming task be paused briefly and changed to the ready-only prefix for its coordinated rollout?**
  - **Recommendation:** Yes, keep the existing hourly rclone task and destination, changing only its remote prefix once publication is ready. Do not add a server agent or delete already downloaded objects. Confirm this live before enabling the gate.

- **What maintenance window and rollback tolerance should we plan for the one-time authority switch?**
  - **Recommendation:** Rehearse first, then use a short scheduled read-only window with both PA instances and Worker services ready. Keep the frozen-state rollback available before new writes; after real business events, recover from the durable ledger rather than blindly restoring old databases.

- **Should this architecture replacement precede website-reporting and Hermes API expansion?**
  - **Recommendation:** Yes, stabilize identity, permissions, project/time and finance boundaries first, while completing isolated Incoming/UI maintenance safely. Keep the two expansion items explicitly queued so they are not forgotten or incorrectly marked complete.

- **When you return, can we obtain fresh authenticated acceptance sessions for both PA installations and an individually identified test client?**
  - **Recommendation:** Use the in-app browser for controlled live checks after the design and release are approved. This audit found no available tabs and does not certify current production connection/workspace health. Keep real client communications and financial actions out of tests unless specifically authorized.
