# Project access expiry notifications

Status: locally verified, default off, not migrated or enabled in production.

Migration `0169_project_access_expiry_notifications.sql` adds a durable notice
outbox and immutable audit history to the Client/Delivery database. Operations
owns the bounded scheduled processor. This feature observes existing explicit
project access terms; it never grants, extends, revokes, expires, or cleans up
membership, entitlements, authenticated grants, delegations, or shares.

## Eligible access

A notice requires all of the following at reconciliation and again immediately
before mail dispatch:

- an explicit `collaborator` access term with a known effective expiry;
- the exact active workspace, Project Alpha source reservation, and active
  projected project named by that term;
- one exact active identity-backed entitlement, or an exact-principal
  authenticated delivery grant whose immutable recipient still matches the
  current Project Alpha principal version;
- an active workspace membership and portal identity with a verified email;
- no active applicable identity denial when the denylist feature is enabled.

Group and other dynamic grant audiences have no recipient row and are never
staged. Project-end terms remain ineligible until their signed completion
deadline has been latched. Customer, until-revoked, unclassified, address-book,
and email-matched access is not inferred. An email is notification metadata,
not an authority key.

The current mutually exclusive stage is selected from the effective deadline:

| Window | Event |
| --- | --- |
| More than 24 hours and at most 7 days | `warning_7d` |
| More than 0 and at most 24 hours | `warning_24h` |
| Deadline elapsed | `expired` |

If a pending earlier warning becomes obsolete, it is terminally suppressed.
Sent history remains immutable. Each term, identity, event, and effective
deadline has one deterministic outbox identity and one stable SMTP Message-ID.

## Delivery safety

The processor is inert unless
`PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED=true`. The checked-in Wrangler
configuration sets it to `false`. It shares the existing five-minute
notification invocation but has its own bounded work: at most 100 reconciliation
candidates and 20 dispatch candidates per invocation. A claimed notice has a
five-minute token-fenced lease. Delivery is attempted at most three times; an
abandoned third lease is terminally failed.

Only bounded public codes such as `authority-changed`, `obsolete-window`,
`mail-disabled`, `lease-expired`, and `delivery-attempt-failed` are persisted.
Provider errors, credentials, recipient addresses, client names, and project
names are not written to the outbox or audit log. Mail contains a generic
authenticated portal link, not a bearer link or project data.

This notice processor requires the SMTP transport (`SMTP_NOTIFICATIONS_ENABLED`
exactly `true`, plus valid host, username, password, and from-address settings).
It deliberately refuses the Cloudflare email-binding-only configuration because
the shared binding adapter does not carry the outbox `messageIdKey` into a stable
RFC Message-ID. Binding-only or incomplete SMTP configuration terminally
suppresses the notice as `mail-disabled`; it does not fall back to a delivery
whose retry identity cannot be preserved.

Migration 0169 also adds missing update guards to the older
`portal_v2_membership_audit` and `client_delegated_share_events` ledgers.
Existing writers only append to those tables. Delete guards are deliberately
not added because both legacy schemas use workspace cascade deletes; blocking
those cascades would not be safely upgrade-compatible.

## Rollout and rollback

1. Apply all Client/Delivery migrations through 0169 while the flag remains
   false. Verify foreign keys, integrity, and that old membership/share events
   remain readable.
2. Deploy the matching Operations build with the flag still false. Verify the
   ordinary notification cron remains healthy.
3. In staging, configure and verify SMTP first, then enable the flag and inspect
   the immutable staged/suppressed/sent audit rows for exact test identities.
4. Enable production only after joined Client and Operations acceptance.

Disabling the flag stops both staging and delivery immediately without losing
history and is the operational rollback. Do not roll back to a build that
deletes or rewrites the new tables. No production migration, mail, deployment,
or flag enablement is authorized by this document.

## Verified locally

The focused twelve-case Miniflare/real-D1 suite covers populated migration and
replay, immutable old and new histories, default-off behavior, exact-recipient
and tenant isolation, dynamic-audience exclusion, deterministic replay,
obsolete warning suppression, authority revocation before send, expired-term
mail, stable Message-ID, no access mutation, three-attempt retry limits,
redacted failures, current denials, and abandoned lease recovery. It also
proves that more than 100 far-future authorities and more than 100 already
reconciled notices cannot occupy the bounded page ahead of due work. Recipient
race coverage changes the verified email between preflight and final authority
reads and proves that only the final address can be sent. Transport coverage
proves binding-only configuration is refused and the SMTP adapter renders the
stable outbox key as the RFC Message-ID.

Remaining acceptance is a joined staging run with the actual mail transport,
current Client reader, and Project Alpha projection. The processor intentionally
does not notify inviters separately and does not display notice history in the
staff or client UI; both require an explicitly approved product workflow.
