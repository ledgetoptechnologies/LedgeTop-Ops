# Client workspace goal: remaining acceptance

Audit date: August 26, 2026. Audit base: `ccba9c0` on
`codex/client-workspace-foundation`. **The overall goal is not complete.**
This is a remaining-work inventory, not a new authorization policy or release
approval. It supersedes neither the [roadmap](client-workspace-roadmap.md) nor
the narrower implementation runbooks. Historical passing gates verify their
tested increments, not every workflow in the original handoff.

## Acceptance map

Numbers refer to sections of the August 24 development handoff.
The table and code-boundary findings describe audit base `ccba9c0`; subsequent
local implementation and verification are recorded below. They are not claims
that newer local fixes are missing, or that those fixes are deployed.

| Handoff | Available foundation | Work still required for the requested outcome |
| --- | --- | --- |
| 1: separate Alpha sources, unified customer | Local source-qualified business ingestion, connector registry, recovery and explicitly reviewed business-party links. | Secondary portal/catalog ingress, native client authorization and source-owned request/outbound routing. Business grouping must not merge identities or grants. |
| 1, 20: service-driven portal | Source-qualified catalog storage, client-safe category/service request UI and draft/version checks. | Explicit per-customer service enablement and its owner/write contract; service-driven UI backed by authorization. A global service catalog is not a customer's entitlement. |
| 2: Client Hub | Local bounded directory/search, source filters, dedicated detail routes and progressive collections. | End-to-end acceptance with both real sources and the remaining workflows; meaningful activity currently covers source organization/client/project records, not all operational events. |
| 3, 4: client/project workspace and contacts | Read-only source-qualified business-project detail and factual linked-contact channels. | Organization/project role assignments, multiple site contacts, preferences/arrival instructions and authorized editing. The single projected `client_id` is not a role list. |
| 5: project memory and field use | Operation-owned Job Briefs, private attachments, revisions and existing crew read access. | Project-owned plans/outcomes/observations, approved contribution permissions, field-friendly access and project attachments. An operation brief is not project memory. |
| 6: recurrence and selective copy | Existing immutable brief revisions and source/project visibility checks are reusable. | Actual selective copy/preview/provenance and destination authorization; authoritative next-project creation or approved Alpha navigation. Never copy access, billing state or notice recipients implicitly. |
| 7: ordinary client history | Staff business-project history is separate from portal grants. Completed-project Client reads now preserve established Project Alpha and migrated legacy project access, while explicit collaborator terms still expire. | Coordinated release and joined live acceptance remain pending. Ambiguous Operations and old invitation grants intentionally retain the legacy cutoff until reviewed. |
| 8: native delivery | Existing authenticated delivery, scoped grants and Alpha delivery intents. | Complete staff client-to-destination-to-recipient workflow, including secondary sources; verify fresh uploads, grant changes, revocation and exact deep links together. |
| 9: staged delivery notices | Local legacy folder-change batching plus new exact-principal Alpha delivery-intent batching, five-minute quiet period, Send Now/Cancel and bounded retries. | Native general-upload subscriptions and explicit recipient/group/contact policy. New native batches do not automatically cover staff-created grants or all uploads. |
| 10: staff notification center | Local inbox for authorized requests, feedback, pending delivery notices and reported Alpha connection failures. | Wire additional meaningful operational events when their producers exist; this is not a universal event/audit log. |
| 11, 16: scoped collaboration/inheritance | Invitations, authenticated acceptance, current grants/denies, ancestor checks and separate delegated bearer links exist. | Organization invitation policy/approval, named collaborator lifecycle and end-to-end inheritance/override tests. A bearer link is not a named collaborator membership. |
| 12: multiple client admins | Multiple manager entitlements, last-manager suspension protection and staff recovery/transfer for eligible local members exist. | Client-side peer appointment/demotion and explicit authority ceilings. Existing invitation capabilities exclude `member.manage`; Alpha-managed authority remains Alpha-owned. |
| 13: reusable address book | Projected business contacts and request-specific on-site fields. | Reusable scoped contact CRUD/picker and invitation reuse without converting contact records into login identities. |
| 14: external expiry | Expiry fields and seven-day invitation acceptance lifetime exist. | External-collaborator classification, project-end-plus-seven access expiry, overrides/reopening and notices. Acceptance expiry is not access expiry; accepted invitation grants currently omit an access expiry. |
| 15: audit | Membership/share/request/feedback/notification events and delegated public content-read hooks exist. | Unified filtered client/project authorization/content timeline, ordinary authenticated preview/download audit and explicit visibility/retention policy. |
| 17–19: feedback and completion | Locally verified authenticated project/folder/file feedback, New/In Progress/Done, explicit completion and private notices. | Live acceptance and further authoring only as separately scoped. Viewer annotations are deferred; no automatic deployment-completion notices. |
| 21: dashboard | Requested navigation/layout increments; dashboard remains low priority. | Avoid a new dashboard redesign before workflow acceptance. |
| 22: daily end-to-end use | Focused backend and responsive browser gates exist per increment. | Joined onboarding, new project, field work, recurrence, delivery, feedback and collaborator-expiry acceptance; local isolated tests are not that final proof. |

## Concrete code boundaries

Paths below are repository-relative evidence, not instructions to enable gates.

- `apps/client/src/worker/client-portal/service-catalog-page.ts` explicitly
  describes a global client-safe catalog, not per-client service entitlement.
  `request-readiness.ts` checks current eligibility/request authority and catalog
  readiness; it does not implement service assignments.
- `apps/operations/src/worker/client-hub.ts` returns staff ACL capabilities such
  as directory/requests/delivery/viewer. Those are not purchased customer services.
- `apps/operations/src/worker/client-hub-business-project-detail.ts` returns
  `not_projected` for site contacts, billing contacts and project memory.
  `BusinessProjectWorkspace.tsx` has no mutation workflow for them.
- `apps/operations/src/worker/job-brief.ts` requires `operations.manage` for
  writes. `job-brief-route.test.ts` deliberately rejects assigned-pilot writes.
  `packages/shared/src/index.ts` has no project-memory contribution permission.
- `apps/client/src/worker/client-portal/workspace-memberships.ts` restricts
  `INVITABLE_CAPABILITIES` to view/delivery/request capabilities. Staff
  `transferClientWorkspaceManager` is a recovery path, not client peer-admin UI.
- `apps/client/src/worker/client-portal/workspace-v2.ts` inserts accepted
  invitation memberships and entitlements without an access expiry.
  `hierarchy-relations.ts` applies `completed_at + 30 days` in hierarchy reads.
- `apps/operations/src/worker/client-business-activity.ts` declares coverage
  `source_records_only`; sync/page views are not meaningful business activity.
- `apps/operations/src/client/staff-inbox.ts` enumerates four producer types.
  [Native delivery notifications](native-delivery-notifications.md) records the
  exact supported producers and deliberately unsupported audience fan-out.

## Decisions and implementation order

The existing requirements already settle keeping Alpha instances separate,
preserving ordinary client history, supporting multiple client admins and
offering project-end-plus-seven expiry. Do not reopen those requirements as
questions or mistake their present absence for a configuration issue.

The pending question is whether assigned crew may add/edit their own project
observations while managers control plans, assignments and other people's notes.
No response has been received; an automatic goal continuation is not approval
to broaden write permissions. Detailed contact/copy questions and conservative
proposals are in [project memory design](project-memory-design.md).

The next feature slices must resolve their actual authority choices before
changing writes or access:

1. Approve the crew contribution/contact ownership boundary, then implement
   project contacts and versioned memory through a crew-accessible route that
   does not require global client-directory permission. Extend to selective
   recurrence with immutable source history and no accidental disclosure.
2. Specify the registered capabilities for each Alpha source, retaining primary
   staff authority. Implement authenticated secondary portal/catalog and
   outbound routing before claiming a unified multi-source client portal.
   A bounded next slice can implement secondary native projection and read-only
   resource navigation for an independently authorized existing global identity,
   without deciding crew-note rights or activating a production source. Preserve
   separate workspaces and keep unsupported requests, finance, feedback, mail
   and Viewer paths unavailable. Test colliding producer IDs, stale contexts and
   source-local revocation; do not merely remove primary-only predicates.
3. Implement named collaborators and peer-admin controls with explicit ceilings,
   the authoritative project-end date, unknown-date/reopening behavior and
   ordinary-history separation. Add reusable contacts and scoped audit together
   with those user workflows, not as automatic grants from an address book.
4. Complete native upload recipient/subscription policy and per-client service
   assignments. Neither a business link nor a notification creates access.
5. Run joined local acceptance, coordinated release checks, then authorized live
   validation. Retain explicit, per-slice evidence and a rollback plan.

### Next access-lifecycle slice: audit findings

Implementation is now locally verified after checkpoint `4a77f6d`.
[Project access terms](project-access-terms.md) records the exact new-grant
contract, additive migration, existing-grant behavior, coordinated rollout
boundary and still-missing approval/notification workflows. The final Client
backend gate passed 122/122 and Operations producer/resource gate passed 84/84.
Both app typechecks and builds passed. Operations browser coverage passed 88/88
before a primary-only contrast correction, then the final primary suite passed
34/34 after that correction; the unchanged 54 native cases retain their earlier
coverage. Client browser coverage passed 170/170. Final mobile/desktop screenshots
were inspected, including recipient suggestions and invitation review. This is
focused local evidence, not release evidence, and does not mark sections 7, 11
or 14 complete. The broader workflows and coordinated rollout remain open.

The initial August 26 read-only trace confirmed that changing the global 30-day
cutoff to seven days would be incorrect. The completed-history correction now
removes that cutoff only for read capabilities backed by existing Project Alpha
authority or a migrated legacy project grant. Ambiguous Operations rules and
unclassified invitation grants keep the old behavior. Feedback authoring,
service requests and Viewer-share creation do not inherit read-only history.

Implement explicit, versioned access terms on the exact project delegation,
not on the global person or their workspace membership. One person may be a
customer on one project and an external collaborator on another. Customer
history must retain existing authorization checks without a completion cutoff;
collaborators need the requested specific-date, completion-plus-seven and
until-revoked options. Apply the same recipient-specific terms in hierarchy,
file/media, feedback and publication checks. Enforce expiry on reads even if
the audit/notification scheduler is delayed. Expiring one delegation must not
revoke an independent customer grant or delete the person's account.

Signed schema-v3 lifecycle records provide `completedAt` for completed projects
and clear it on reopening. Do not fabricate a completion date for an older
source without that contract. The remaining decisions concern classification
of existing unclassified grants and reopening behavior; safe proposals are to
preserve existing grants until reviewed and require explicit renewal after
expiry. The local implementation now preserves established Project Alpha and
migrated legacy project history without reclassifying ambiguous grants, and
latches the first authoritative completion for new explicit terms;
reopening does not renew those terms. This is not approval to rewrite existing
access. Test exact time boundaries, separate invitation/access expiry,
independent projects/sources, missing lifecycle support and concurrent changes.

## Release and latest UI state

- Navigation/scoped-link increment `28827c4` was previously recorded as released.
  Current-view count `5e2ec18` and subsequent feature increments are local, not
  evidence of deployed behavior. The counter shows the current listing's folder
  and file count, not descendant totals; partial listings say **loaded** and
  search/loading/error states are explicit.
- The completed-history read correction is local and migration-free. It keeps
  the pre-terms 30-day fallback for rolling compatibility, applies identically
  to primary and secondary/native Project Alpha sources, and preserves deny,
  revocation, exact source/workspace and local project-grant fences.
- Latest local notification checkpoint `ccba9c0` passed its focused backend,
  migration, typecheck, build and 158-test browser gate. No tests were rerun for
  this read-only audit; no whole-monorepo or production success is claimed.
- Alpha export `38dc6c81` remains unpublished after a permission-review rejection.
  Do not retry its push/PR without renewed explicit approval. Publication alone
  would not implement the remaining secondary portal/request authority paths.
- Coordinated producer/consumer migrations and deployment, current account cron
  capacity/configuration and live client/mail workflows remain release checks.
  A local migration test does not authorize applying it to production.
- Viewer and thumbnail runtime changes remain outside this work. No access,
  connection activation, production mail, migration or deployment was performed
  by this audit.

### Current-folder UI verification, August 26

The current worktree was rebuilt and the count/navigation unit suites passed
30 tests. The desktop/mobile browser suites for folder counts, recent links,
link history, responsive navigation and SOPs passed 66 tests. Desktop and mobile
screenshots were inspected: the counter sits above the listing; search controls
and the Recent client links/Trash cards have separate spacing. Counts exclude
descendants, follow searches and navigation, and label incomplete listings as
loaded. These are local fixture results, not production verification or a new
deployment of `5e2ec18`.

### Locally verified secondary portal checkpoint

The next local checkpoint adds secondary portal authority/ingress, Operations
administration coordination, explicit staff folder grants, native read routes
and the Client UI. Its separate gates below do not substitute for complete
business-workflow acceptance or production rollout.

- The initial coordination timeouts have been resolved with bounded integration
  timeouts. The expanded coordinator and administration suites passed 29 tests;
  the connection-administration desktop/mobile browser suite passed 48. Both app
  typechecks and the Operations build passed at this checkpoint.
- The staff-sharing desktop/mobile browser gate then passed 50 cases and the
  Operations build passed again. This includes safe cancellation of unpublished
  access and the existing primary sharing mode; final 375px/1280px input and
  review screenshots were inspected. The joined database gate remains separate.
- An initial native-resource gate passed 23 cases and authority passed 18 of 19.
  The one failure was a copied-source fixture using the wrong credential
  environment; its correction was verified by the later 19/19 authority run.
  The later 55-case joined gate supersedes those earlier resource results.
- The real authorized secondary staff folder-binding/grant producer, immutable
  OPS authorization receipts and Delivery publication gate now exist locally.
  The fresh frozen-code joined gate passed all 55 cases: 29 producer and 26
  native resource tests. It exercises real signed projections, explicit staff
  publication, exact client reads and revocation. Operations type checking
  passed after the fixes. The Client compatibility gate then covered 192 distinct
  passing cases across an initial 188/192 run and a fresh 19/19 rerun of the two
  corrected test-fixture files; no production change or skipped case was involved.
  Final Client type checking passed. Isolated workflow proof is not the
  full-business acceptance gate.
- After correcting two issues found by screenshot inspection, the rebuilt Client
  browser gate passed 208 cases with four pre-existing visual-duplicate skips;
  the public-download subset passed four more. All 64 native-workspace cases and
  existing mocked Viewer sharing/renewal cases are included. Native and primary
  375px/1280px screenshots were inspected, along with 640px/3440px layouts.
  Both final app builds, typechecks and generated-type checks passed. The 35
  Client UI unit cases were rerun successfully after the style changes.
- No production source was activated and no migration, deployment or push was
  performed in this checkpoint. See [secondary client portal](secondary-client-portal.md)
  for the current verification and release restrictions.

### Locally verified invitation approval checkpoint

The next local increment replaces the approval-required dead end with an
immutable client request, staff Inbox review, exact workspace policy controls,
and a separately published invitation. See
[invitation approval workflow](invitation-approval-workflow.md) for the authority,
retry, recovery and rollout contract. This is not peer-admin appointment,
secondary-source invitation onboarding, completion notices or final business
acceptance; those remain in the broader goal.

The initial joined gate found a real policy response/fingerprint defect before
release; that partial run is not passing evidence. After corrections, the final
joined suite passed 21/21, separate Operations authority/HTTP gates passed 53/53,
and 62 distinct Client request/workspace/email cases passed across the combined
run and a 26/26 older-schema correction rerun. The compatibility fix preserves
authorized legacy project choices without a permissive missing-table fallback.

Both app typechecks, final builds and generated-type checks passed. Operations
browser coverage has 122 distinct passing cases across the unchanged Hub/Inbox
84 and corrected invitation 38; Client browser coverage passed 140/140. Fresh
375px/1280px policy, review and request-history screenshots were inspected. On
the final bundle the folder counter passed another 5 unit and 10 browser tests,
with desktop/mobile screenshots inspected. See the workflow runbook for precise
run boundaries; these are focused local gates, not a whole-repository pass.

The additional source-layout invariant run was 5/7: its unchanged baseline
route allowlist omits the previously added secondary portal ingress, and a
thumbnail-runbook exact-text assertion fails. Those remain release follow-ups;
thumbnail behavior was not changed. This checkpoint performs no production
migration, email, invitation, source activation, deployment or push. The
overall goal and coordinated release acceptance remain open.

### Locally verified organization address-book checkpoint

The Client portal now has a default-off organization workspace address book for
reusable descriptive contact cards. It is deliberately separate from Project
Alpha contacts, portal identities, memberships, billing roles, notification
recipients and project/site assignments. Current organization managers may
create, search, edit and permanently scrub a card, and may copy its current
email into the existing invitation workflow. Invitation policy, scope, approval,
publication and identity binding remain authoritative.

The additive migrated-D1 gate passed 8/8 cases, existing invitation compatibility
passed 21/21, and workspace authorization compatibility passed 26/26 with a
realistic 15-second Miniflare test budget. Client type checking and production
build passed. The responsive address-book browser gate passed 30/30 cases, and
375px/1280px management and picker screenshots were inspected without overflow.

This checkpoint remains local and default-off. Production activation requires
the dedicated stable fingerprint secret and an approved PII backup/export/
erasure procedure. Project/site roles, crew observations, recurring-project
copy rules and completed-project amendments remain product decisions; this
checkpoint does not infer them. No migration, deployment, mail or push was
performed.

### Locally implemented peer-administrator checkpoint

The Client Portal now has a default-off peer-administrator workflow for existing
local organization members. Promotion and demotion preserve the membership and
all ordinary capabilities; only the local `member.manage` overlay changes.

The mutation requires current unlimited root authority, exact organization and
source ownership, an expected manager version, an idempotency key, and
transaction-time fences. Project Alpha-managed authority, finite/project-only
members, stale versions, explicit denies, cross-workspace targets, and
last-manager removal fail closed. The responsive UI adds a deliberate review
step, operation-specific retry after an ambiguous response, separated mobile
actions, and keeps suspension separate from role removal. See
[peer administrator workflow](peer-administrator-workflow.md).

Verification passed the 27-case workspace authorization suite, the 10-case
full migration-chain Client Portal suite, four responsive peer-administrator
browser cases, Client type checking, production build and generated-binding
drift check. Regression coverage changes actor authority inside the D1 batch,
including identity denial, source rebinding and excessive policy rows, and
proves no command commits. Independent security and UX re-reviews found no
release blocker.

This closes the client-side multiple-administrator lifecycle locally. Identity
reconciliation, authoritative per-customer service assignments, legacy grant
reclassification, expiry notices, project memory, copy-forward and a unified
audit timeline remain open. No production migration, flag change, deployment
or push is included in this checkpoint.
