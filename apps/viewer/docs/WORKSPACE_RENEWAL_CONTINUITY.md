# Workspace renewal and model-controller continuity

## Verified failure mechanisms

- A workspace without its original Operations opener has no proactive workspace-grant transport. At expiry it intentionally navigates through Operations `/viewer/reauthorize` and returns with a fresh one-time grant. This is the visible sign-in/return navigation, not a model rendering fault.
- Model renewal channels were tracked only in workspace memory. A reload or the reauthorization round trip lost those records while model tabs kept their old random BroadcastChannel names. Posting to a channel with no listener succeeds; the model then times out and retries rather than receiving a new grant.
- Workspace grant redemption cleared its request marker and watchdog before the network/body read completed. Focus could start a second request. A late completion after controller disposal could install a session callback and schedule new timers.
- A stalled model-grant issuance request could hold its controller's pending flag indefinitely. The model's own response timeout did not release issuance, so later renewal requests were rejected while the original fetch remained pending.

These mechanisms were reproduced against the actual controller classes using controlled timers/transports. They do not prove that every observed production stall has this cause.

## Viewer-side changes

- Keep at most the last 32 non-secret model-channel descriptors in this workspace tab's sessionStorage, retained for up to 24 hours since successful controller activity. This limits reload continuity, not the number of models that may be opened during the active workspace lifetime. Fields are the random channel, immutable model/version/review-or-published context, timestamp and authenticated Operations subject. No bearer, grant, capability URL, or permissions are stored in these descriptors.
- Restore descriptors only after the workspace server authenticates the same subject. A surviving model's first correlated expiry request reconnects its controller state. Browser metadata grants no access: the current authenticated server endpoint must issue a fresh grant, and the existing response checks must match the exact mode/model/version/attempt context.
- Known workspace expiry can preserve routing across reauthorization. Explicit sign-out/revocation, subject change and authoritative model renewal denial clear routing. Duplicate authorization-clear callbacks cannot create multiple redirects or erase an already-preserved expiry handoff.
- Workspace grant redemption remains single-flight, has a bounded abort deadline, and ignores late disposed/timed-out generations. Active model resources and camera state are not recreated by these changes.
- Model-grant issuance now has a 10-second deadline and passes an AbortSignal to the workspace request. A deadline releases the pending state through the existing bounded retry schedule (2, 5, then 15 seconds). A closed, suspended or revoked controller aborts its issuance; late responses cannot deliver grants. Only one issuance is active per controller. Aborting the browser request cannot guarantee that the server did not already mint an unused, expiring grant; no late grant is redeemed or delivered by this path.

## Authorization boundaries unchanged

Workspace grants still originate from Operations authorization. `/api/v1/admin-grants` requires the server-to-server authorized HMAC path; `/api/v1/admin-sessions/redeem` requires a fresh one-time grant, enforces subject continuity and caps expiry by Operations authorization. Model grants are issued by the existing authenticated review/published endpoints, enforce immutable output scope and remain capped by the current workspace authorization. Nothing extends token lifetimes or suppresses terminal denial.

This patch does **not** implement silent grant issuance for an openerless workspace. That needs an Operations-authorized transport with its session/CSRF/origin contract explicitly supported by Operations. The Viewer must not invent such an endpoint, silently embed a sign-in page, or convert an expired Viewer bearer into fresh Operations authorization.

## Verification / remaining checks

Focused tests cover same-subject restoration, wrong subject, explicit disposal, authoritative denial, malformed/aged descriptors, early and foreign requests, exact version rejection, published/review contexts, pending redemption timeout, duplicate focus, and late disposed responses. A strict same-channel/model controller-ready advisory accelerates an already-due renewal after workspace restoration. It grants no access, does not interrupt an in-flight redemption, and never clears authoritative denial. Older open model tabs without this handler still reconnect on their existing retry schedule. Real production token-lifetime and cross-tab reauthorization soak tests remain necessary.

The issuance follow-up adds deterministic stalled-transport, late-success, close/revocation, invalid-navigation and synchronous-failure/bounded-retry checks. The controller, Viewer recovery and workspace renewal suites pass 48/48 tests together. This confirms the local liveness fix, not the cause of the observed production expiry. Distinguishing an absent workspace listener, missing Operations opener, stalled issuance and failed redemption still requires token-free session diagnostics and HTTP route/status evidence from the affected session.

## Silent renewal across sites (2026-11-23)

Operations moved to a different registrable domain than Viewer. The credentialed renewal request became cross-site, so browsers that restrict third-party cookies, or any non-`None` SameSite setting on the Access cookie, stop it reaching Operations; Access then answers with a cross-site sign-in redirect that a page cannot read. Operations' strict `Cross-Origin-Opener-Policy` also severed the opener channel. Both silent transports could fail while the Operations sign-in was still valid.

Order of silent attempts now:

1. An approved Operations host on Viewer's own site, when `OPS_CONTROLLER_ORIGINS` has one. Viewer returns it as `renewalOrigin`. Operations already admits only the renewal routes there. The request names the session's pinned controller; Operations accepts only its own request origin or its one canonical origin, and Viewer still requires the grant's controller, subject and target session to match.
2. The pinned controller, exactly as before.
3. The opener, now preserved because the Operations HTML shell sends `same-origin-allow-popups`.

Renewal runs about 60% of the way through a session (12 minutes before a 30-minute expiry, with jitter), and on focus, visibility, pageshow and online once due. A duplicated tab shares its session and renews once (Web Locks); the others re-read their own session from Viewer.

The sign-in dialog appears only when Operations itself answers that the sign-in ended, or when, after real expiry, two attempts fail unreadably and Viewer confirms the session is over. Readable outages and offline periods never prompt. Silent attempts continue behind the dialog and close it when one succeeds.

Nothing extends access: every renewal is a fresh one-use grant issued after Operations re-checks Access, staff binding and permissions, capped at 30 minutes and at the Access expiry. Sign-out, revocation and lost permission therefore end the workspace within 30 minutes, as before.

Configuration this relies on and does not change: the staff Access application covers the same-site Operations host with the same audience and sets its cookie there at sign-in; CORS preflight passes through Access for that host; any zone redirect of the retired host leaves `/api/viewer/workspace/session-renewal*` alone; and Viewer lists that host in `OPS_CONTROLLER_ORIGINS`. Without them step 1 fails quietly and steps 2 and 3 apply.
