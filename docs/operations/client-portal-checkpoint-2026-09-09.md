# Client portal checkpoint — September 9, 2026

This is a partial acceptance record, not completion or deployment approval.

## Browser evidence

The authenticated Operations Client Hub loaded and reported 24 clients in its
first page. Both Project Alpha source filters were available. Primary-source
records displayed **Automatic workspace pending**; secondary-source records
displayed **Portal unavailable for this source**. Business-directory visibility
does not establish portal provisioning or successful source delivery.

Type-to-search was exercised without Enter or the Search button using the
operator-identified business present in both sources. The directory returned
two separately labeled, source-qualified records. Selecting the LTT source
reduced the result to its single secondary record, and the detail URL preserved
the search and source parameters. This accepts that read-only staff discovery
interaction, not cross-source linking or client portal identity/access.

A primary organization detail page was also inspected in the live browser.
At the current desktop width its overview rendered in three columns, with
business contacts, operational contacts and business projects together. Portal
revocation controls appeared after the history/administration sections. The
organization contact editor opened with its two existing business contacts as
options, and Cancel returned to read mode without saving. This is read-only
desktop smoke coverage, not mobile, persistence or authorization acceptance.

The live Administration page rendered configuration cards in a spaced two-column
grid at the current desktop width. Its source summary showed both business
connections active/healthy and the secondary portal connection active. That
does not resolve Client Hub's secondary-source portal-unavailable state; the
source admission and actual workspace delivery still need joined verification.
The following visible statuses remain open, not accepted:

- Both source token-expiry reminders: **not configured**. Obtain actual token
  expiry dates before configuring reminders; do not invent a ten-year deadline.
- Feedback, service requests and request attachments: Client runtime gates
  **unverified** in this Operations view.
- Delegated sharing/signer: Operations companion **disabled**, Client runtime
  gate **unverified**.
- Access-expiry notices: Operations companion **disabled**.
- Delivery notification recovery: **paused**, with zero displayed jobs.

No flags, reminders, source settings or client permissions were changed during
these read-only checks. Disabled components require their coordinated release
gates, not blind activation to clear the status text.

A subsequent read-only production Client D1 aggregate query confirmed the
secondary source authority is active at revision 1, with **zero** workspace
reservations, workspaces, and complete active directory generations. The API
reported zero rows written. This establishes missing secondary workspace
delivery, not merely a Client Hub label problem; it does not identify the
producer-side cause. No primary authority row was returned by this query;
primary legacy-path health must be checked separately rather than inferred
from that absence. Do not manually synthesize workspaces or weaken ownership
checks to hide the missing delivery.

A follow-up aggregate query independent of the authority table found primary
has one reservation and one receipt, but zero workspaces or complete active
directory generations. Its sole receipt is a completed `snapshot_page` dated
2026-09-07 20:26:59 UTC. The sole projection generation is still `staging`,
`complete=0`, with one expected page and one received page; there is no
activation receipt. Secondary has no receipts. These reads also wrote zero
rows. Investigate the producer's page-to-activation outbox progression and
cron prerequisites next; do not force activation or treat receipt of a page
as proof of a complete authorized workspace.

Operations D1 receipt aggregates refine the secondary diagnosis: four
`portal.projection` events reached Ops Sync but remain pending with
`client-portal-forward-failed` (latest receipt 2026-09-08 17:00:36 UTC).
Primary has one completed portal event matching the page receipt timestamp.
The secondary problem is therefore at the internal forward/receiver boundary,
not proven absence of PA emission. The current aggregate error conflates RPC
transport failure and retryable receiver responses; inspect bounded receiver
reason/configuration evidence before changing any source authority or replaying.

Read-only deployed Worker settings confirmed Ops Sync's private ingress binding
targets `ledgetop-clients` / `OpsSyncPortalProjectionIngress`, and both Workers
bind the expected Client D1 database. Workspace sync and hierarchy relations
are enabled; catalog sync and service-assignment sync are disabled, matching
the checked-in settings. Since all three families use `portal.projection`,
pending aggregate receipts do not prove that workspace events specifically
failed. A disabled family currently returns a retryable receiver result that
Ops collapses into `client-portal-forward-failed`. Determine the event family
and bounded receiver reason before attributing those four failures to transport
or enabling additional feature gates.

PA commit `246a6ac3` prevents shared-transport configuration failures from
claiming queued projection deliveries and consuming attempts. Its regression
preserves the same queued activation while credentials are unreadable and
while the connection is disabled, then delivers it after configuration is
restored. Independent focused verification passed 76 tests / 804 assertions.
It also changes the manual sync message to report a producer preflight pause
instead of success. This fix was published in PA PR #183, merged to main as
`51e333fb2ca2e26248b3f96588b8c126f4a2832b` on September 9 at 11:26:50 UTC.
All PR checks passed, including the Linux smoke test. The Docker publication
run `34345596920` subsequently completed successfully at merge revision
`51e333fb2ca2e26248b3f96588b8c126f4a2832b`; production recreation
and source-specific recovery remain unverified. It does not reset existing
dead letters.

The independent full PA run at `246a6ac3` completed with exit 0: 808 tests,
6,540 assertions, 91 skipped. Its private JUnit report identifies skipped
cases but emits empty `<skipped />` elements rather than reasons. The skipped
classes include MySQL-backed account/security/payment/session/notification
workflows, three explicitly gated workforce-database cases, one Linux-only
log-rotation case, and one tax-fixture case. Their prerequisites remain
unverified by this run; do not describe it as full MySQL/Linux acceptance.

Both Project Alpha integration tabs retained their previously rendered status
but displayed **Session expired**. Those retained status values are not a fresh
server check. Reauthentication is required before verifying current readiness,
pending/failed projections, or initiating recovery. No keys were rotated and no
replacement snapshots were queued during this check.

The Operations Incoming page still displayed the legacy verifier-wait message
for an existing ZIP upload. The rclone-native increment is local, not deployed.
See [the Incoming runbook](../truenas/incoming-rclone.md) for its exact TrueNAS
contract and activation gates.

## Local PA diagnostic investigation

The workspace reconciliation and portal-delivery cron scripts load database
configuration directly, not the web application's dotenv loader. The web
dotenv overwrite issue is therefore not a demonstrated cause of cron-only
preflight failures. Do not rotate credentials or change environment-file
precedence on that assumption.

A local, narrowly scoped diagnostic reports fixed categories for runtime-key
presence and encrypted-credential readability only. Its test/release review is
recorded in local PA commit `b3ddd813`: 84 focused integration, Ed25519 and
provisioning tests passed with 573 assertions and no skips, using PHP 8.2.12
with the available Sodium extension enabled for that invocation. The full PA
run subsequently completed successfully: 804 tests, 6,510 assertions, with 91
skipped tests. Those skips are unverified coverage, not passing acceptance;
the run does not establish full production parity. This is not deployed
evidence or a confirmed cause. Do not
record key values, fingerprints, ciphertext or credential fields in reports.

## Remaining gates

- Restore PA browser authentication and verify fresh producer/receiver state.
- Prove primary and secondary workspace delivery independently, then exercise
  default-on historical provisioning and revocation persistence.
- Verify service-driven access and explicitly scoped delivery with individually
  identified clients; do not infer access from directory or producer counts.
- Complete the Incoming full suite and coordinated retention/migration/path
  rollout before enabling its publication gate.
- GitHub authentication was rechecked outside the restricted sandbox and is
  valid. The earlier invalid-login report was a restricted-environment result,
  not a credential blocker. No alternate credentials were extracted. PA PR
  #183 is merged; Operations draft PR #47 is pushed with Incoming publication
  still disabled. All ten CI jobs passed at PR head `86c5658`, including both
  applications' desktop/mobile browser checks and full package unit checks.
  New test-only regressions still require exact-head verification before merge.

## Incremental release review

Security scan `90f18d62-6750-472c-858c-949d21f14843` completed for immutable
diff `ce6b9b0..cdec71e`: 23 changed source files and 25 supporting artifacts
reviewed, with no confirmed vulnerabilities. This is scoped review evidence,
not proof of production configuration or complete goal acceptance. The review
identified two additional regression cases to preserve: revoked clients with
an active linked workspace, and unauthorized reads of basic-checked ready
uploads. Linked and unlinked revocation browser cases passed on desktop and
mobile (four tests); the full Client Hub directory browser file then passed
52 tests across desktop and mobile. The incoming staff route suite passed
16 tests, including ready-upload detail/download/archive denials before D1
or R2 reads and public-dispatch rejection. Source/rollout invariants passed
35 tests. These added tests and documentation do not modify runtime behavior.

The operator's screenshot confirms the enabled hourly task currently selects
the root of `ltds-incoming` in PULL/MOVE mode. A temporary pause was requested;
no pause or `ready/` cutover has been confirmed. Do not enable publication
based on this screenshot, and do not delete previously downloaded staging data.

The full [goal acceptance checklist](client-portal-goal-acceptance.md) remains
authoritative for scope. These observations do not accept its joined workflows.
