# Project history and collaborator access terms

Status: locally verified checkpoint on `codex/client-workspace-foundation`.
Not released, migrated or enabled in production. This is part of the full
client-workspace goal, not a replacement for its remaining acceptance criteria.

## Reviewed access, not a new identity category

A person may be a customer on one project and a collaborator on another.
Terms therefore belong to an exact project grant or invitation entitlement,
within its existing source/workspace. They do not label the global identity,
merge workspaces, create memberships from business contacts, or replace the
existing source, recipient, entitlement, deny and resource checks.

New reviewed terms support:

| Recipient / option | Lifetime |
| --- | --- |
| Customer | Completed-project history remains available until the grant is revoked or another authorization requirement fails. |
| Collaborator / specific date | Access stops at the reviewed UTC instant. |
| Collaborator / project end | Seven days after the first authoritative completion observed for these terms. |
| Collaborator / until revoked | No time-based expiration; existing revocation and other authorization checks remain mandatory. |

Invitation links still have a separate seven-day acceptance window. Accepting
an invitation does not restart or extend its project-access lifetime. Expiry
removes that delegation, not the account or an independent grant.

Project discovery must follow those same live terms. A collaborator with a
still-valid specific-date or until-revoked grant must not lose the project from
the directory merely because the legacy thirty-day history cutoff elapsed.
The exact live project grant supplies only that retention exception; independent
directory permission, source ownership, version checks and denies still apply.
Unclassified historical grants receive no inferred exception.

Specific dates use explicit UTC timestamps. Authorization uses the existing
database's second-granularity time comparisons: a fractional-second expiry can
close less than one second early, never later. Signed project completion dates
are normalized UTC timestamps by the projection contract; local browser time is
not used to decide when access ends.

Reopening a project does not extend an already latched completion deadline.
Renewal requires a new explicit authorization. The review UI must explain this.
Project-end terms require a published, source-qualified schema-v3 lifecycle;
staging rows, another source's receipt and an unknown completion date are not
substitutes. Where the source cannot supply that contract, choose a date or
manual revocation explicitly.

## Existing data and rollout

Migration `0164_project_access_terms.sql` is additive. Existing grants have
`access_terms_id = NULL` and retain their previous behavior; none is inferred
to be a customer or collaborator. Old API clients may omit terms for
compatibility. New project-invitation and native-sharing UI submits explicit
terms. A reviewed new grant is the path for assigning terms, not rewriting
immutable historical records.

Terms and the first completion deadline are immutable. The grant's existing
revocation workflow remains the control for ending access. Native staff
authorization receipts include the reviewed operation and current lifecycle
proof. Terms are inserted in the same Delivery transaction as the pending
grant, and publication rechecks the lifetime and current authority. Reads
enforce expiry without waiting for a scheduled cleanup or notification job.

Deploy the additive migration before code that depends on its columns/views.
Do not drop the migration to roll back the UI: new terms must remain enforced
by any rollback build. Reverting to a pre-terms reader could ignore expiration
and is not a safe rollback. Validate both Operations and Client readers before
activating this increment. No production rollout is authorized by this file.

The coordinated release must update terms-aware Client authorization readers
before enabling the new Operations grant producers. Apply and verify the
additive migration first, deploy the verified Client build, verify existing and
explicit-term reads, then deploy Operations and verify preview/create/revoke.
Do not enable a new producer against an old reader that ignores `access_terms_id`.
If creation must be rolled back, stop new term issuance while retaining a
terms-aware reader for every already-issued grant; deleting terms or reverting
the consumer to pre-terms code is not a rollback strategy.

## Remaining full-goal requirements

- Primary and secondary staff grant creation now have the same explicit
  Customer/Collaborator terms, verified locally with browser coverage. Their
  coordinated release remains pending. Terms-aware readers do not reclassify existing or
  newly unclassified grants as customers.
- Existing-grant review/renewal workflow beyond issuing a new explicit grant.
- Source-created Project Alpha delivery intents need an explicit access-terms
  contract and producer/consumer verification. Their legacy grants are not
  automatically customer grants merely because they came from Alpha.
- Organization policy administration and the actual staff approval workflow;
  `require_approval` must not silently approve a new client invitation.
- Completion notices, the 24-hour warning, and collaborator/inviter expiry
  notices, with durable deduplication and current authorization checks.
- Peer organization administrators, a reusable address book, and the unified
  filtered access/content audit timeline.
- Joined real-source/client workflow acceptance and coordinated release.
  The current producer's independent lifecycle and entity versions support
  completion-only updates, as detailed below. A rename or reparent changes the
  owner version and still requires the existing explicit revalidation flow;
  the completed-history fixture does not prove recovery for every real producer
  update. Do not remove owner-version checks to force continuity.

## Local verification, August 26

The first native-producer run exposed a D1 expression-depth failure in the
transaction guard (13 passed, 22 failed). The guard now materializes the full
current proof inside the same write statement and aggregates to exactly one
guard row. A missing proof must fail the named constraint, not silently skip the
guard insert while subsequent grant writes commit. All original permission,
source, scope, capacity, deny and lifetime predicates remain in force.

A subsequent targeted native-producer run passed five cases: ordinary legacy
publication/replay, explicit customer history beyond thirty days, independent
customer access after collaborator expiry, completion changing during
publication, and a recipient denial during publication. Thirty other cases
were intentionally unselected. This verifies the targeted correction, not the
whole integration. The full native producer/resource gate and invitation/read/UI
gates were then started separately.

The complete native producer/resource gate subsequently passed **62 of 62**
tests across two files in 651.48 seconds (35 native producer, 27 native portal
resource cases). This includes actual signed snapshot activation and login,
customer history after completion, current hierarchy and file checks,
independent grants, source isolation, revocation, and publication-time fences.
The source-suspension stage case also confirms that a missing materialized proof
rolls back the new terms and binding rather than allowing a zero-row guard.
Invitation/read and responsive UI gates remain pending. These results do not
validate the primary producer changes being implemented concurrently.

The core invitation/access-terms gate passed **15 of 15** tests in 94.19 seconds,
including first-completion latching, reopening, separate invitation acceptance
and access lifetimes, organization policy blocks, future denials becoming live
at the write fence, and historical rows not consuming active authorization
capacity. The six-file Client reader regression gate subsequently passed
**102 of 102** tests in 416.04 seconds. That frozen-code run predates the
reader parity changes below and must not be used as proof of those changes.
The initial primary producer/read/route gate passed **31 of 31** tests in
272.34 seconds (19 producer, seven staff-read, five route cases). This includes
all three explicit history modes, direct/prefix parity, revoked/denied access,
legacy history, owner-version changes and publication-time authority changes.
It predates the final accumulated-entitlement fixes below; their expanded
producer regression gate is separate. Browser gates remain pending.

The follow-up static review identified reader parity work still to verify:
exclude expired explicit grants before bounded candidate selection, use the
same current authorization rules for primary direct-file and prefix-list
readers, and retain discoverability for any explicit live project terms rather
than only the customer label. The queued changes preserve unclassified grants,
independent directory permission and owner-version fences. They require their
own regressions after the in-flight reader gate; the earlier 62-test result is
not evidence for these later changes.

The primary form's specific-date validation is being aligned with the shared
explicit project-term contract: any valid future expiry, without silently
applying the legacy nonproject five-minute/one-year limits. The legacy limits
remain unchanged for unclassified nonproject grants. The UI review also found
that the global feature flag is not staff authorization: nonadministrator
sharers must retain ordinary sharing without an unusable authenticated-grant
form or a silent fallback to the legacy grant producer. Primary revoke actions
must reflect the existing revoke permission. These UI corrections require the
responsive browser regression gate; backend authority is not being broadened.

The acceptance audit also found two concrete lifetime regressions to fix before
release. Expired explicit invitation entitlements keep a null legacy expiry,
so bounded read/delegation queries must exclude those expired allows before
their current-rule limit without excluding any deny. A later accepted
invitation must receive its own entitlement version and terms rather than being
silently ignored by the old version-one uniqueness constraint. Renewal must
remain an explicit new invitation, with deterministic replay-safe entitlement
IDs; it must not rewrite the earlier terms or extend them automatically.
The earlier 15/102-test gates did not cover these accumulated-history and
second-invitation cases. Expanded regressions are required.

The accumulated-history correction now uses one deny-preserving live-term
predicate in bounded Client reads, invitation delegation and both staff grant
producers. Only expired explicit allows stop consuming current-rule capacity;
denies and unclassified rules retain their existing behavior and limits.
The final frozen-code Client regression gate passed **122 of 122** tests across
seven files in 558.92 seconds (eighteen core and 104 reader cases). This covers
second-invitation versions and replay, independent project shells, expired
explicit entitlement capacity, preserved denies, current-rule overflow and the
existing hierarchy/request/feedback/primary delivery readers. Client type
checking also passed after those changes.

The subsequent ordinary-history correction is deliberately read-only and
provenance-aware. Explicit project-scoped `project_alpha` authorization and
migrated project-scoped `legacy` delivery authorization may continue to read
completed projects after 30 days. Workspace-wide authorization, unclassified
`operations`, and `client_invitation` authorization do not gain indefinite
project access, and mutation capabilities retain the legacy cutoff. Explicit
customer and collaborator terms remain authoritative. Primary and
secondary/native Project Alpha adapters use the same policy; pre-terms schemas
keep the prior 30-day behavior during rolling deployment. No data rewrite or
migration is required.
The final frozen-code Operations producer/resource gate passed **84 of 84**
tests across three files in 959.04 seconds: twenty primary producer,
thirty-six native producer and twenty-eight native resource cases. Both new
producer regressions verify that 202 expired explicit invitation allows no
longer exhaust current-rule capacity and that a current deny still blocks
review and reads. The resource gate covers collaborator-until-revoked history
after the legacy completion cutoff. The Operations browser gate also includes
the staff-permission corrections and now contains 88 cases; Client has 170.
The final Client browser gate passed **170 of 170** cases in 3.5 minutes, with
zero skips: 76 primary portal, 64 native portal and 30 project-access-term
cases. Client type checking passed in 4.51 seconds and its build passed in
4.91 seconds. The gate includes invitation review/cancellation, uncertain
operation retry, source/workspace switching and existing mocked Viewer
integrations; it does not run or modify the Viewer runtime. Both reviewers
inspected final 375px/1280px invitation and native-workspace screenshots.

The first Operations browser run had 84 passes and four disabled-option
assertion failures. The rendered options were disabled; Playwright's
`toBeDisabled` followed the label to its enabled select. Tests now assert the
option's native `disabled` property while retaining the empty-selection,
unavailable-reason, disabled-review and explicit-alternative checks. The
correction does not enable unsupported terms or change application behavior.
Screenshot review then identified undersized primary audience/Refresh controls
and the primary suggestion list's fixed offset. Their scoped styling and
375px/1280px geometry checks passed in a subsequent 88/88 Operations run (1.1
minutes). Candidate-open screenshots then exposed white-on-white suggestion
text despite passing geometry and interaction checks. A primary-panel-only
color correction and explicit candidate text checks passed the final primary
browser suite: **34 of 34** in 31.4 seconds, with no skips. Normal, hover and
keyboard-focus candidate text and child text are checked, as are input/list
geometry and minimum 44px controls. Final 375px/1280px candidate screenshots
were inspected and are readable without clipping. The final Operations build
passed (worker 1.87 seconds, client 7.24 seconds); type checking passed after
the geometry changes. The unchanged 54 native cases passed in the preceding
88-case run; the final primary-only color rule did not require another native
run. Backend code is unchanged by these UI fixes.

Read-only producer audit: Project Alpha checkout `b847852b`, clean
`src/services/PortalProjectionService.php` and `PortalSourceVersion.php`.
The project entity hash includes its type, public ID, parent public ID, display
name, active flag and primary-contact flag; its lifecycle hash separately
includes project public ID, completion status and completion timestamp. A
completion-only update therefore leaves the project entity version unchanged,
consistent with the signed snapshot fixture. Rename/reparent updates do not.
This records the inspected source, not the version deployed on any server, and
is not a substitute for the joined real-producer release test.

The primary-source creation flow is included in the final 84-case gate, not
inferred from native-only results. The Viewer and thumbnail runtimes remain
outside this change. No production migration, source activation, email, push or
deployment was performed for this increment.

These are focused local gates, not a whole-monorepo run or joined production
acceptance. The migration and transactional write fences were verified through
the database-backed suites; Cloudflare D1 guidance informed the atomic current
authority checks and terms-aware reader-before-producer rollout. Existing
unclassified grants, denial precedence and tenant boundaries were preserved.
