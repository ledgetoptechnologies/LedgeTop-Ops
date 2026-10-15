# Onboarding submission notices

Status: local submission-to-notification pipeline implemented and mounted behind
default-off job and mail flags. Migrations 0094/0095 provide recipient state and
durable paging. Joined D1 acceptance uses a synthetic mail binding; production
activation and actual mailbox delivery remain unverified.

## Latest local verification

- Joined full-schema D1 acceptance passed three cases (`12f4a6`), with TypeScript
  passing (`de036a`). It exercises real invitation issuance and submission,
  fanout, claims, attempted-state persistence, adapter dispatch, settlement and
  repeated scheduled cycles. One generic notice is accepted without a second
  send; provider uncertainty and expired attempted leases remain unretried.
  A recipient sealed while authorized is denied before the cycle and receives
  no email. A later fixed cutoff independently excludes old submissions.
  Root reviewed the test source. All mail is an in-process fake binding: this
  does not prove SMTP delivery, production grants or deployed scheduler health.
- Cycle orchestration passed nine tests (`7c6c2f`) and scheduled Worker routing
  passed four (`66ddae`), including the empty wrapped-cursor reset. These focused
  suites complement, rather than replace, the joined database acceptance.
- Root found and requested correction of the cycle test's default paging mock:
  paging options are the second argument, not the database argument. The corrected
  suite passes nine cases (`ad3cf1`) and asserts both phases' exact cutoff, clock
  and 32-item bound; TypeScript passes (`b62799`). This supersedes the earlier
  orchestration run without changing production behavior.
- Staging preflight, evidence and scaffold suites pass all 48 tests in root's
  independent run (`99c306`). Notification/native flags, schedules and related
  resources now match the checked-in staging examples. Activation remains
  disabled and release finalization false; no deployed transport is established.
- Activation-fenced store tests now pass all seven full-chain D1 cases
  (`97ea00`, 36.22 seconds). Root corrected a proposed test's cutoff to use the
  current event rather than an older event and required a sealed-but-unclaimed
  recipient regression, so the tests exercise the SQL cutoff rather than just
  the absence of a recipient. Fanout, claim and attempt boundaries are covered;
  expired-attempt maintenance remains independent of the cutoff.
- Migration 0095 adds durable fanout/delivery scan checkpoints. The release
  inventory, evidence example and exact expected migration lists now include
  it; all 42 preflight/evidence tests pass (`bef577`). The initial two inventory
  expectation failures were corrected without weakening the assertions.
  This validates release bookkeeping, not the new scanner's runtime behavior
  or deployment. Release finalization remains false.
- The exact-recipient dispatcher and deployment parser passed 12 tests across
  two files (`ead694`). The dispatcher prepares generic text/escaped HTML,
  requires the fixed activation cutoff at claim and pre-send authorization,
  handles definitive rejection separately from uncertain provider acceptance,
  and does not resend after a simulated accepted-send/lost-database-acknowledgement.
  Dependencies are mocked; this is not a joined database/SMTP acceptance test.
- Config-independent maintenance passed two full-chain D1 cases (`dbad76`,
  32.13 seconds). Tests exercise repeated bounded batches, attempted expired
  and revoked leases, unattempted revoked notices, preserved sent/uncertain
  rows, and an expired unattempted live lease that remains retryable. Root
  reviewed the bounded atomic UPDATE. Typecheck passed (`6be6aa`) after the
  concurrent fixture signature changes; the earlier intermediate errors below
  do not describe the latest completed check.
- The adapter, durable candidate paging and scheduled handler are implemented
  locally. No real send, release or production activation is implied by these
  results. Original PA financial emails remain unchanged.

### Scheduled composition checkpoint

The Worker now awaits this cycle only for `11-56/15 * * * *`, separate from
other notification and maintenance jobs. `CLIENT_ONBOARDING_NOTIFICATION_JOBS_ENABLED`
and `CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED` are both `false` in checked-in
configuration. `CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE` is blank and
`CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS` is `[]`; the trusted review origin
uses `CLIENT_ONBOARDING_ADMIN_ORIGIN`. No production settings were changed.
Wrangler regenerated types (`f4372b`) and root typecheck passed (`d7ab57`).
The latest local adapter timeout suite passed six tests (`01d812`), and scanner
full-chain D1 tests passed three (`51933e`). Worker routing and joined cycle
acceptance now pass as recorded above; staged activation evidence remains open.

`client-onboarding-notification-cycle.ts` now composes configuration snapshots,
independent maintenance, recipient fanout, durable candidate paging, the mail
adapter and revision-checked cursor advancement. It inspects at most 32 candidates
per phase, advances past ineligible/removed recipients, and retains the current
candidate on uncertain storage/send outcomes. It reserves 50 seconds before
starting mail within a 120-second invocation budget. This limits new work, not
database-call latency; the mail adapter has a tested 45-second send timeout.
A timeout is uncertain acceptance, not permission to resend the same notice.

Root typecheck passed after initial composition (`e0f111`), superseded by the
post-mount and joined-test results above. Focused cycle, joined database/adapter,
scanner and timeout suites have passed as noted above.
Maintenance has a jobs/schema gate separate from mail activation: once the
scheduled jobs are enabled after migration, disabling mail must not prevent
uncertain-lease cleanup. Do not enable either before staged configuration,
recipient authorization and real transport acceptance are reviewed.

## Ownership and recipients

- Operations sends the distinct operational notice that a submission is
  available for review. PA retains financial emails and receipts.
- Configure a bounded list of native staff IDs, not arbitrary email addresses or
  legacy PA owner roles. An empty list leaves the event pending.
- Resolve the recipient's current native admission, profile and address. Require
  visibility of every invitation context using the review queue's existing
  `directory.profile.view` allow/deny rules, including active business areas and
  divisions. Recheck eligibility when claiming delivery.
- Notification eligibility does not grant approval rights. The decision endpoint
  separately enforces edit, identity-link and enrollment permissions. Say
  “available for review,” not “you can approve this client.”

## Durable processing

- Stage one immutable event atomically with the actual submission insert.
  Submission replay must not stage another event; transaction rollback must
  remove the event along with the failed submission.
- Do not copy invitation bearers, submitted fields, names or raw client data
  into the event. Store private delivery addresses only where necessary, bound
  to the authorized recipient profile, and never log them.
- Seal a recipient set once and create unique submission/staff deliveries.
  Concurrent fanout and repeated scheduler runs must not duplicate those rows.
- Do not send notices for submissions already decided or invitations revoked.
  Revoked staff or lost scope must not receive pending notices.
- An expired lease with no attempted send can be retried. Once sending was
  attempted, uncertain provider acceptance requires reconciliation, not an
  automatic resend. A deterministic message identifier is not proof of provider
  deduplication or recipient delivery.
- Known rejection may use bounded backoff. Provider acceptance and recipient
  receipt are distinct outcomes; do not label one as the other.

## Activation and acceptance

### Scheduler implementation boundary — September 13

Source review of migration 0094, the notification store and the scheduled
handler identified two integration gaps before enabling delivery:

- Discovery cannot repeatedly select only the oldest pending rows. A recipient
  whose pinned admission/profile or view permission is no longer current stays
  pending when claim returns null; similarly, an unsealed event may have no
  eligible recipients. Use durable, wrapping keyset cursors and advance past
  every inspected candidate, including unsuccessful claims. Bound both fanout
  and delivery batches; do not load the entire backlog into memory.
- Expired attempted leases need a separate bounded maintenance path to
  `reconciliation_required`, including when sending is disabled or recipients
  are removed from configuration. Never turn them back into retryable sends.
  Decided/revoked submissions also need suppression maintenance. Maintenance
  must not depend on the configured recipient list or the mail activation date.

Require an explicit canonical UTC `notBefore` activation timestamp, with a blank
value disabling dispatch. Enforce the immutable event's `created_at >= notBefore`
at fanout, claim and pre-send SQL writes, not just in candidate discovery.
Do not use a moving age window: an ordinary scheduler outage must not silently
discard legitimate queued notices. Pre-activation events remain retained for
an explicit backlog decision, not silently mailed or deleted.

Use a distinct awaited scheduled cycle with its own batch/time budget, rather
than adding more SMTP work to the current shared five-minute notification
`Promise.all`. Snapshot deployment-owned origin, recipient IDs and activation
configuration before awaiting. Keep the existing transport; its SMTP path
distinguishes definitive failure from uncertain DATA acceptance, while a
Cloudflare binding send error is conservatively uncertain. A successful provider
response followed by a lost database acknowledgement must never resend mail.

Implementation is in progress: the exact-recipient dispatcher, SQL activation
fences and config-independent maintenance now have local source under review.
The local deployment parser requires the fixed timestamp, canonical Operations
origin and at most 16 unique native staff IDs. Missing activation/list settings
leave dispatch disabled; it never substitutes a rolling date or email lookup.
These new components still need final focused test evidence and composition.
The scheduler, durable discovery cursors, transport-readiness adapter, joined
database/transport tests and production activation remain unfinished. A
concurrent-edit typecheck found old store test calls awaiting the newly required
activation argument; do not report that intermediate check as passing.

- Use the existing mail transport. This work does not authorize a provider,
  domain, DNS or credential change.
- Keep notification activation separate and default-off until tested. Decide an
  explicit backlog/age policy before enabling; do not silently email every old
  pending submission at launch.
- The message should contain only generic text and the trusted Operations review
  queue link, not public invitation links or financial actions.
- Required evidence: full-chain D1 staging/replay, unique fanout, cross-area
  allow/deny, decision/revocation races, expired unattempted lease recovery, and
  attempted uncertain-delivery non-reclamation. Later dispatcher acceptance must
  also exercise definitive rejection, uncertain SMTP response, and lost database
  acknowledgement after provider acceptance without duplicate mail.
- Preserve PA's onboarding layout and fields. Notification work does not add
  another customer form or wizard.
