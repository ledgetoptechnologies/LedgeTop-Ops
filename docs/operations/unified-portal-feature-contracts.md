# Unified portal feature contracts (design proposal)

Status: **proposal only**, with the unused local data-shape foundation noted
below. No end-to-end feature or new authority is implemented, enabled, or
deployed by this document. It does not authorize database,
schema, runtime, route, configuration, identity, recipient, permission, public
link, Project Alpha (PA), or production changes.

## Local data-shape foundation

`packages/shared/src/website-monthly-report.ts` provides provisional, pure
staff-draft and Client-publication DTO parsers plus scoped period-overlap checks.
It has no runtime route imports or package export-barrel entry. Implementer and
independent QA each passed all 12 focused contract tests; Client typecheck also
passes. Regressions cover impossible calendar dates, fractional month
boundaries, invalid unchecked overlaps, equivalent timezone aliases, detached
input copies, DST, leap years, and year boundaries. Unknown metrics remain
`null`; staff/internal fields and withdrawn-publication shapes are rejected.

This is not a report feature or authority/publication proof. Source ownership,
website and recipient bindings, reviewed publish commands, current revision and
withdrawal lookup, storage uniqueness/CAS, provenance correctness, and live
acceptance remain unimplemented dependencies. Before persistence, pin a timezone
normalization policy/version across runtimes; `Intl` canonical alias spelling
can vary with ICU/tzdata versions. Validated DTOs are detached, not runtime-frozen.

## Purpose and fixed boundaries

This proposal defines the smallest explicit contracts needed for the remaining
unified-portal features: a verified person's display name, website resources and
edit requests, monthly website reports, PA-owned financial summaries and
existing action links, and joined notification identity. These are not aliases
for the current generic feedback or request-level quote features.

The `/portal` composition boundary remains unchanged:

- Operations service-home authorization is checked first. An exact valid `200`
  may start the separately authorized Client bootstrap; `404` alone preserves
  the existing legacy fallback. Denial, unavailability, malformed success, and
  transport failure must not start Client reads.
- Client session, workspace, capability, readiness, and resource checks remain
  authoritative for Client content and actions. Operations metadata never
  selects a Client workspace or grants a resource capability.
- Names, email addresses, service labels, and provider display text are not
  authority or heuristic join keys. Cross-system joins require reviewed,
  permanent bindings created by an authorized workflow. Exact source-qualified
  stable PA/provider resource IDs may participate in those explicit bindings;
  their presence alone must never select a Client workspace or grant access.
- Public links and PA financial email remain supported, independently governed
  delivery channels. This proposal neither replaces nor silently creates,
  renews, revives, broadens, or sends them.
- Offline or stale data may reduce functionality and show its age. It must not
  create access, approve a payment, restore a revoked link, publish a report, or
  overcome a current denial.

The current code demonstrates the separation that must be retained:

- The Client session resolves a legacy account only from an active exact
  issuer-and-subject identity link and membership in
  `apps/client/src/worker/client-portal/repository.ts:1012-1048`.
- `/api/client/session` exposes that session's account/workspace display name
  and capabilities in
  `apps/client/src/worker/client-portal/routes.ts:518-558`.
- The ready legacy dashboard renders the authorized account display name in
  `apps/client/src/client/ClientPortalApp.tsx:3114-3124`; native content instead
  identifies its authorized workspace in
  `apps/client/src/client/NativeWorkspaceContent.tsx:146-148`.
- Existing feedback accepts only project, folder, and file targets in
  `packages/shared/src/client-feedback.ts:4-17` and
  `apps/client/src/worker/client-portal/feedback-target.ts:22-28`.
- Existing accepted-quote presentation is request-scoped and actionless:
  `apps/client/src/client/portal-api.ts:84-90` and
  `apps/client/src/client/ClientPortalApp.tsx:665-685`.

## Domain identities and permanent bindings

These domains are deliberately distinct:

| Domain | Meaning | Must not imply |
| --- | --- | --- |
| Client principal | One verified login identity, keyed by issuer and subject | A customer, billing recipient, staff identity, or email ownership outside the identity provider |
| Customer organizational unit | The Client workspace/root whose resources the principal may access | A PA billing entity or permission to every subsidiary/project |
| PA billing entity | The PA customer/account that owns financial documents and balances | Client workspace membership or authority to receive financial email |
| Website resource | One managed website with a stable resource ID and owner binding | Ownership inferred from hostname, label, contact email, or service enrollment |
| Staff scope | The current Operations permission to route, review, publish, or administer a resource | Client authority, PA authority, or permission inherited from a visible button |
| Recipient | A currently authorized person/channel for one disclosure or delivery | Organization-wide access or durable identity linkage based on an email match |

### Proposed binding records

Each cross-domain binding should have an opaque binding ID, binding type,
source-system ID, destination-system ID, owning organizational unit, version,
state, effective time, optional expiry, creating command ID, approving actor and
scope proof, created/revoked timestamps, and immutable audit history. Active
bindings must be unique for the exact relationship. Rebinding requires an
explicit reviewed command; it must never occur because labels, names, emails,
hostnames, or provider text happen to match.

At minimum, the model needs separate binding types for:

1. customer organizational unit to website resource;
2. customer organizational unit to PA billing entity;
3. project to PA project, when project-scoped finance is supported;
4. Client principal to verified person profile;
5. financial document to an already-existing PA action-link identity; and
6. notification event to each authorized delivery-channel attempt.

A binding's revocation immediately prevents new reads and actions. Historical
audit records may retain opaque IDs and prior decisions, but must not become an
alternate authorization path.

## 1. Verified person display name

### Proposed contract

Add an optional `personProfile` to the independently authorized Client session:

```text
personProfile: {
  profileId: opaque stable ID,
  displayName: verified display string,
  source: approved identity/profile source,
  version: monotonic source version,
  verifiedAt: timestamp
} | null
```

The server may return it only when the exact issuer-and-subject principal has an
active, version-current profile binding. A workspace/account name remains
separate and must continue to label the resource context. The UI may say
`Hello, <person display name>` only when `personProfile` is present; otherwise it
should use neutral copy or clearly identify the account/workspace instead of
pretending that its name is a person's name.

### Revocation and stale handling

- Profile revocation or source-version mismatch removes `personProfile` on the
  next session read; cached UI must be cleared with the rest of Client state.
- An unavailable profile source yields `null`, not a name inferred from email,
  account, workspace, Operations metadata, or a previous browser session.
- The profile adds presentation only. It grants no workspace, financial,
  website, staff, or recipient permission.

### Concrete next work

Define the source of verified names, ownership/update workflow, normalization
and maximum length, version/revocation model, session DTO parser, and neutral UI
fallback. Extend the existing session path at
`apps/client/src/worker/client-portal/routes.ts:518-558` only after the binding
and source contract are approved. Do not reinterpret `displayName` returned by
`repository.resolveSession` as a human identity.

## 2. Website resources and edit requests

### Proposed website resource contract

A website is a first-class source-owned resource, not a service label. Proposed
read fields are:

```text
website: {
  websiteId: opaque stable ID,
  owningOrganizationalUnitId: opaque binding target,
  canonicalHostLabel: display-only normalized hostname,
  displayName: string,
  lifecycle: active | paused | retired,
  sourceVersion: string,
  capabilities: { view: boolean, requestEdit: boolean, viewReports: boolean }
}
```

The Client reader must require the exact principal, workspace, active website
binding, current website version, and resource capability. Hostname, customer
name, email, and Operations `serviceId`/label are never authorization inputs.

### Proposed edit-request contract

Website edits require their own command and lifecycle:

```text
websiteEditRequest: {
  requestId, websiteId, commandId, expectedWebsiteVersion,
  requestedItems: [{ itemId, kind, description, clientReference? }],
  status: submitted | triaged | in_progress | client_review |
          completed | declined | cancelled,
  routing: { owningTeamId, routeVersion },
  revision, createdAt, updatedAt
}
```

Submission must reauthorize the principal and exact website resource, enforce a
bounded strict payload, pin the website and routing versions, and be idempotent
by command ID plus canonical payload digest. Staff routing must be derived from
an explicit resource/team binding and current staff scope, never from free text.
Every status transition needs an actor class, expected revision, allowed state
transition, timestamp, and audit event. Item-level completion must identify the
exact requested item; completing one item must not silently complete another.

The existing feedback writer at
`apps/client/src/worker/client-portal/feedback-routes.ts:177-221` and its
`new | in_progress | done` lifecycle are not this contract. Existing service
requests may continue to represent ordinary authorized catalog work through
`loadPortalRequestReadiness`, `loadPortalServiceCatalog`, and
`createPortalServiceRequest` in
`apps/client/src/client/portal-api.ts:703-847`; a catalog label containing
“website” does not establish a website resource or edit-request workflow.

### Revocation and stale/offline handling

- Revoking workspace membership, website binding, or `requestEdit` capability
  denies creation and mutation immediately.
- Historical requests may remain read-only only under an explicit history
  permission; they must not preserve a live website action path.
- Route/team unavailability returns pending/unavailable without rerouting to an
  arbitrary staff member. A stale website version requires re-review.
- Offline submission must not fabricate acceptance. Exact retry may recover a
  durable receipt; changed content requires a new command.

## 3. Monthly website reports

### Proposed report contract

Monthly reports are source-owned publications with explicit provenance:

```text
websiteReport: {
  reportId, websiteId,
  period: { startInclusive, endExclusive, timezone },
  provenance: [{ metricId, sourceId, sourceRevision, collectedAt }],
  metrics: bounded typed values,
  narrative: reviewed content,
  state: draft | in_review | published | withdrawn,
  revision, preparedBy, reviewedBy?, publishedAt?, withdrawnAt?,
  visibility: { organizationalUnitId, audienceVersion }
}
```

Periods must be non-overlapping or explicitly superseding for one website and
timezone. Metrics must carry real sources and collection times; unknown data is
unknown, not zero. Draft and review content is staff-only. Publication requires
current publisher scope, current website binding/version, an exact reviewed
revision, and an audience snapshot. Client reads require both current website
view/report authority and published visibility; withdrawal or access revocation
removes the report from new Client reads.

There is currently no portal report API, authority model, or UI. The absence is
also recorded in `docs/operations/unified-portal-composition-gaps.md:117-120`
and `docs/operations/operations-api-first-system-audit-2026-09-09.md:341`.
Fixture strings containing “monthly” are not reports or acceptance evidence.

### Concrete next work

Approve metric sources, timezone ownership, late-data correction/supersession,
manual narrative review, publisher roles, visibility rules, retention/export,
and withdrawal behavior. Then design staff draft/review/publish commands plus
separate Client list/detail DTOs with bounded cursors. Do not add report UI
until these server-owned controls exist.

## 4. PA-authoritative financial summaries and existing action links

### Proposed summary contract

PA remains the financial system of record. A Client-facing summary is a bounded
projection, not a second ledger:

```text
financialSummary: {
  billingEntityBindingId,
  scope: account | project,
  scopeId,
  currency,
  asOf, sourceRevision, freshness: fresh | stale | unavailable,
  totals: { invoiced, paid, credited, refunded, outstanding, overdue },
  documents: [{ documentId, kind, number, state, issuedAt, dueAt?,
                originalAmount, outstandingAmount, currency,
                existingActionLink: { linkId, url, state, expiresAt? } | null }]
}
```

Amounts must account once for direct invoices, monthly rollups and their child
charges, partial payments, credits, refunds, reversals, and overdue derivation.
Every response needs explicit currency and freshness. Client authorization must
bind the exact principal and organizational unit to the PA billing entity, then
apply document recipient/visibility policy. `viewBilling` alone is not evidence
that an unbound PA account belongs to the workspace.

The existing request-level `PortalAcceptedQuote` contains only document number,
status, amount, currency, and verification time
(`apps/client/src/client/portal-api.ts:84-90`). Its repository projection and UI
remain valid only within their current request authorization
(`apps/client/src/worker/client-portal/repository.ts:513-526,598-638` and
`apps/client/src/client/ClientPortalApp.tsx:665-685`). It must not be relabeled
as an account financial summary.

### Existing action-link rule

The proposed read contract may return only an already-existing, current,
recipient-authorized PA action link whose scheme/host/path satisfy an approved
allowlist and whose PA document/billing-entity binding matches the response.
Reading a summary must never call a reuse-or-create helper. If no authorized
link exists, return `null`/unavailable. Creating, renewing, reviving, emailing,
or changing a link remains a separate PA-authorized command with explicit
recipient, document, idempotency, audit, and approval controls.

Existing PA financial email remains unchanged. Portal presentation is an
additional authorized read channel, not proof of email delivery and not a
replacement for existing public links.

### Revocation and stale/offline handling

- Current PA or local revocation wins over cached summaries and links.
- While PA is offline, a last-known summary may be shown only with `stale`, its
  `asOf` time, and actions disabled. Unknown balances must never become zero.
- A known revoked/expired action link is removed even when the surrounding
  summary is cached. Stale data cannot approve payment or establish settlement.
- Cross-currency totals must not be combined without an approved conversion
  contract; the default is separate currency groups.

The required finance semantics and link separation are consistent with
`docs/operations/operations-api-first-system-audit-2026-09-09.md:194-199`.

## 5. Notification ownership and logical deduplication

### Proposed logical-event contract

Each business event that may appear in-app or by email needs one immutable
logical notification ID created by its owning domain:

```text
notificationEvent: {
  logicalEventId,
  ownerDomain,
  eventType,
  resource: { type, stableId, sourceVersion },
  recipientBindingId,
  audienceVersion,
  occurredAt,
  payloadRevision
}

deliveryAttempt: {
  logicalEventId,
  channel: in_app | email,
  channelMessageId,
  attempt, state, attemptedAt, acceptedAt?, failedAt?
}
```

The owner domain creates the logical event once. Channel dispatchers use
`logicalEventId + recipientBindingId + channel + payloadRevision` as the
idempotency/deduplication identity. Provider acceptance means only channel
acceptance; mailbox delivery and user read state remain separate facts. In-app
read/dismiss mutations must not mark email delivered, and email retry must not
create another in-app business event.

Logical deduplication does not guarantee exactly-once SMTP delivery. Preserve
durable transport-attempt markers and reconciliation holds for ambiguous
acceptance or failed receipt persistence; do not blindly resend an uncertain
attempt merely because the application lacks a successful sent receipt.

Current notification action paths are reauthorized Client paths rather than
authority tokens; for example feedback completion paths are built in
`apps/client/src/worker/client-portal/feedback-routes.ts:228-256`, and the joined
history rechecks current records and constructs bounded portal paths in
`apps/client/src/worker/client-portal/notification-history.ts:479-500`.
Preserve that property. A future website-report, website-edit, or finance notice
must point only to a route that independently reauthorizes the exact resource.

### Revocation and stale handling

- Resolve recipient authority before each dispatch and again on action-path
  access. Revocation suppresses unsent attempts and disables the action; it does
  not rewrite immutable event history.
- No recipient may be inferred from a matching email/name. Use the approved
  recipient binding and audience version.
- Cross-channel dedupe must not suppress a required channel merely because a
  different channel succeeded. Channel policy explicitly selects channels.

## Acceptance plan

### Local contract acceptance

For every proposed contract, use real parsers and local D1 migrations with
synthetic identities and colliding names/IDs. Required cases include:

- same email/name under different issuers and organizations remains separate;
- same website hostname/label under different owners never correlates;
- binding creation, version change, revocation, rebind attempt, and historical
  read behavior;
- exact recipient allowed, wrong recipient denied, and audience revision races;
- late response after revocation cannot restore UI or cached authority;
- report timezone/period boundaries, corrections, publish/withdraw races, and
  missing provenance;
- monthly rollup/child-charge non-duplication, partial payment, credit, refund,
  reversal, overdue, multi-currency, stale/unavailable PA, and revoked links;
- read endpoints never create or revive financial links or send email;
- logical notification dedupe across retries while preserving independent
  in-app/email outcomes; and
- metadata-only Operations mode performs none of these Client reads.

Parser, unit, Miniflare, and intercepted browser tests prove local contracts,
not live enrollment or provider delivery.

### Staged acceptance

Use separately approved synthetic stage organizations, websites, billing
entities, staff scopes, and recipients. Verify both portal domains, current
Access identity, exact bindings, revocation during reads, PA outage/staleness,
report publish/withdraw, website request routing/completion, existing financial
action links, PA email coexistence, and notification channel attempts/readback.
Record source revisions and read back every mutation. Do not use production
customers, create new grants opportunistically, or treat provider/email
acceptance as end-recipient delivery.

## Explicitly out of scope

- Production deployment, configuration or data migration.
- Creating or changing identities, grants, recipients, staff roles, PA billing
  entities, public links, email policy, or service enrollments.
- New secrets or credentials.
- Replacing PA financial email or public links.
- Joining domains through names, email addresses, labels, hostnames, provider
  text, or example fixture content.

## Unresolved decisions and recommendations

1. **Verified person-name source:** choose the authoritative profile owner and
   update/revocation workflow. **Recommendation:** use an identity-provider or
   explicitly reviewed Client profile binding keyed by issuer+subject; keep the
   organizational display name separate.
2. **Customer-to-PA ownership:** decide whether one organizational unit may bind
   to multiple billing entities and how project overrides work.
   **Recommendation:** allow versioned many-to-many records only through an
   approval workflow, with one explicit binding selected per response scope.
3. **Website ownership and staff routing:** choose the website registry owner and
   route owner/team model. **Recommendation:** one stable website registry with
   explicit organizational-unit and staff-team bindings; never route by label.
4. **Report timezone and correction model:** decide who owns timezone and whether
   a published month is replaced or superseded. **Recommendation:** pin timezone
   per website/report and supersede published revisions without destructive
   overwrite.
5. **Financial recipient policy:** decide which organizational roles may see
   summaries/documents and existing action links. **Recommendation:** use a
   dedicated finance-view grant plus exact PA recipient/document policy; do not
   equate manager status or `viewBilling` alone with every financial disclosure.
6. **Action-link destinations:** approve PA hosts, schemes, path shapes, expiry,
   and readback behavior. **Recommendation:** server-side exact allowlist and
   opaque link identity; never accept arbitrary URLs from projection data.
7. **Notification channel policy:** decide which events require in-app, email,
   or both, and retention for channel attempts. **Recommendation:** domain-owned
   logical IDs with per-channel policy and independently recorded outcomes.
