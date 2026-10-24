# Linked Operations sign-in emails

Operations staff are independent of Project Alpha staff. A linked sign-in uses
the same Operations staff ID, profile, roles, divisions and permission overrides.
It never creates another owner or changes PA records. The main login remains
available and cannot be removed through this feature.

## Owner verification

Only a current primary sign-in with the global owner role can manage linked
emails. Add an exact email from Account → Sign-in emails. The server creates a
15-minute approval with a random 32-byte secret; only its hash is stored.
The verification URL carries the secret in its fragment, not the request path.
The verification page moves it to sessionStorage and removes the fragment.

Sign out, then sign in to Cloudflare Access with the email being added. A read-only
preview, protected by the secret and that verified email, identifies the exact
owner profile and main email before consent. Linking requires an explicit action,
the exact approval secret, and a fresh signed human
Access assertion for the configured issuer and Ops audience. A pending approval
alone grants no access. Unknown domains are never automatically admitted by Ops;
Cloudflare Access policy eligibility remains a separate prerequisite.

Claims cannot choose a staff ID, role, issuer or subject. Cross-account
email/subject collisions and primary rebinding are refused. Approved bindings,
approval evidence and audit history are durable. At most ten credentials may
be active; inventory contains all active bindings and recent revoked history.

## Authentication and revocation

Legacy Ops, native staff and Viewer renewal authenticate through the same
verified binding. Canonical staff authorization identity is separate from the
actual credential proof. Private proof is retained through native/employee and
onboarding waits, but not sent in gateway requests or opaque file selectors.

Removing a linked credential stops subsequent Ops authentication and renewal.
Native profile version and login generation advance, invalidating stale
ephemeral command contexts. Native admission version stays unchanged, preserving
existing employee grants. Sensitive reads/issuance recheck current proof after
upstream waits. Previously issued delegated Viewer authorizations retain their
existing bounded lifetime (up to thirty minutes); this is not an immediate
remote Viewer-session revocation feature.

Unclear claim results retry the same approval safely. Unclear removals retain the
same binding/version. They must not be described as no change. Expired or changed
approvals require a new link. Network failure during initial approval creation
cannot recover the raw secret, so creation is an explicit fresh action.

## HTTP and deployment

Owner routes are under /api/account/login-links and require ordinary staff
authentication and mutation CSRF. Only the exact POST /api/account/login-links/claim
and /preview-claim routes are registered before staff admission; both require exact-host/same-origin,
bounded duplicate-free JSON, signed human Access claims, an exact-target secret
and a primary-database quota. All responses are no-store.

Apply Operations migration0226 through the reviewed release process. Missing
alias tables preserve primary-only login; partial/broken storage fails closed.
No environment file or domain allowlist is introduced.

This source does not bypass the existing production staff-handoff gates, deploy
all main changes, change Cloudflare policy, create a live owner binding, or alter
public links. Any production frontend release must preserve the exact prior
48-hour asset URLs/bytes and verify old/new bytes in the active namespace. Do
not prune automatically. Credential creation in production requires the real
owner verification flow after the reviewed release is activated.

