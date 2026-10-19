# Onboarding submission notices

The previous version of this document described experimental implementations that
are absent from current main. Those historical test claims are not current
acceptance evidence. The implementation described here is the bounded replacement;
no production mail activation or actual mailbox delivery is implied.

## Runtime

`client-onboarding-notifications.ts` runs in its own awaited
`11-56/15 * * * *` scheduled cycle, independently of delivery notices. The existing
notification migration-maintenance control pauses it. Deployment must first apply
migrations 0094, 0095 and 0213. No historical submission is backfilled.

Configuration is deployment-owned:

- `CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED` defaults to `false`.
- `CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE` is a fixed UTC ISO rollout cutoff.
- `CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS` is a JSON list of at most 16 unique
  native staff IDs. No submitted client email becomes a staff recipient.
- `CLIENT_ONBOARDING_ADMIN_ORIGIN` is the exact HTTPS Operations origin.

The existing SMTP or Cloudflare binding transport is reused. No provider, DNS,
mail domain or credential is created. Transport readiness is checked before any
claim. Configuration and SQL failures have a fixed public diagnostic; recipient
profiles and provider responses are never logged.

## Authority and delivery

A submission trigger creates one durable event. Bounded fanout resolves current
native staff profiles, admission versions, and the same all-scope allow/deny
review authority used by the staff inbox. Recipient insertion and the final
attempt update recheck that authority atomically. Approval, inactive staff,
revocation, a changed profile/admission, or a matching deny suppresses dispatch.
The public recipient link and its bearer secret are never notification content.

Events and frozen recipients use durable scan checkpoints. Each cycle examines
at most eight event and eight delivery candidates; wrapping resumes a bounded
scan rather than discarding pending work. Mail contains generic text and
`/administration/client-onboarding?submission=<id>`, which requires staff sign-in.
The authorized onboarding inbox is the in-app review queue; connecting its badge
and selection behavior to Claude's UI remains a separate acceptance item.

Every transport attempt is recorded under a versioned lease before the send.
Definitive pre-acceptance transport failures may retry, capped at three attempts.
Opaque errors, binding failures, timeouts, and an expired lease after an attempt
remain `reconciliation_required`; they never authorize an automatic resend.
Successful provider acceptance followed by a lost database acknowledgement also
retains the attempted lease for reconciliation. This does not claim exactly-once
email transport. Disabling dispatch leaves retained rows intact; it sends nothing.

## Verification boundary

Migrated D1 tests use an in-process fake transport, never an external mailbox.
They cover a single generic staff-only notice, repeated cycles without duplicates,
uncertain delivery, a deny invalidating an already read authority witness,
transport-unavailable no-claim behavior, the fixed cutoff, and inactive staff.
Review/inbox routing tests cover existing authorization and approval replay.
Real staging scheduler, SMTP acceptance, UI notifications and production activation
must be verified before enabling the deployment flag.