# Project access expiry notifications

Status: locally verified, default off, not migrated or enabled in production.

Migration `0169_project_access_expiry_notifications.sql` adds separate durable
collaborator and companion outboxes with immutable audit history to the
Client/Delivery database. Operations owns the bounded scheduled processor. A
collaborator send and an inviter/access-creator send have independent state,
leases, retries, audit identities, and stable Message-IDs. This feature observes existing explicit
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

## Companion recipient policy

One generic companion notice is eligible only when its creation origin remains
exact and current:

- Invitation access follows `access term -> invitation entitlement -> accepted
  invitation -> invited_by_identity_id`. The inviter must still be an active
  portal identity with a live membership in that same workspace and no active
  applicable identity denial. The current collaborator authority must belong
  exactly to the invitation's `accepted_by_identity_id`; an unrelated identity
  on the same term does not preserve the invitation origin. A separately
  recorded staff approval actor is never treated as the inviter.
- Authenticated access follows `access term -> exact-principal grant ->
  created_by_staff_id`. The grant must still bind the same active project folder
  and source version, retain a current exact principal recipient, and have one
  current active Operations staff creator. The mail describes that person as
  the access creator, never as a manager.

Multiple invitation origins for one term, or multiple active matching grants
from one creator, are ambiguous and fail closed. Group/dynamic, legacy,
unlinked, revoked, inactive, cross-workspace, cross-source, and cross-project
origins are excluded. Both origin and actor are checked again immediately
before delivery, and the final read supplies the current verified email. If
that address is already a current collaborator recipient address for the term,
the companion row is terminally suppressed as `duplicate-recipient` rather
than sending the person two messages. The same rule applies across inviter and
access-creator rows: a deterministic inviter-first ordering selects one current
recipient. Dispatch first uses a short-lived, token-fenced SHA-256 reservation;
an unsent reservation is released if that actor's final address changes. Only
the stable address is promoted to an immutable SHA-256 recipient claim
immediately before SMTP. That claim suppresses later duplicates, including an
accepted-but-not-yet-acknowledged retry, without sharing delivery state or
storing the address.

Migration 0169 also makes both `invited_by_identity_id` and
`accepted_by_identity_id` immutable after an invitation is accepted or linked
to explicit project access terms, and blocks `INSERT OR REPLACE` from bypassing
that provenance. A pending, unlinked invitation can still be corrected, the one
legitimate pending-to-accepted identity assignment remains allowed, and
workspace cascades remain unaffected.

## Delivery safety

The processor is inert unless
`PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED=true`. The checked-in Wrangler
configuration sets it to `false`. It shares the existing five-minute
notification invocation but each isolated ledger has bounded work: at most 100
reconciliation candidates and 20 dispatch candidates per invocation. A claimed notice has a
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

After a companion wins its normalized-email reservation, dispatch verifies its
live lease and performs another complete origin, authority, denial, membership,
and recipient-email read. A changed email releases the unsent reservation and
is re-evaluated; denial or membership loss suppresses the row. Once the final
email matches its reservation, dispatch creates the immutable claim, composes
the message, and performs one final joined outbox-token, lease, reservation,
and claim fence immediately before SMTP. The address captured before the final
read is never used for delivery, and an expired or reclaimed owner cannot send.

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

The collaborator-focused twelve-case Miniflare/real-D1 suite covers populated migration and
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

The companion-focused real-D1 suite additionally covers populated migration
replay, immutable companion history, exact invitation and principal-grant
origins, approval-actor exclusion, ambiguous and dynamic-origin rejection,
accepted-identity mismatch, inviter-denial and inactive/revoked/cross-project
rejection, immutable accepted invitation provenance, cross-role normalized-email
deduplication, current inviter/staff email reads, preflight-to-final and
post-claim email/denial/membership races, and
independent capped retry state with redacted errors and stable Message-ID.

Remaining acceptance is a joined staging run with the actual mail transport,
current Client reader, and Project Alpha projection. Staff with the current exact Client Hub
scope and portal-management permission can read the allowlisted, redacted notice
lifecycle in the unified client/project timeline after migration 0169 is ready.
That timeline is notification history only: it exposes no recipient, identity,
outbox, error or authority detail and does not infer access revocation or mail
receipt. Client-facing notice history remains outside this workflow.
