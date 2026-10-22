# Viewer controller-origin overlap

This is a reviewable source change, not a completed container deployment or
new-domain acceptance. Viewer remains on its existing public hostname.

## Behavior

Ops signs each admin grant with the exact admitted staff request URL origin,
never the browser `Origin` header or canonical-site default. Renewal grants also
carry the target Viewer session ID. Viewer accepts only configured exact HTTPS
staff controller origins, persists the controller on the grant/session, and
requires renewal subject, controller and target session to match the presented
bearer before consuming the one-time grant. The bearer and session ID stay
unchanged. Existing client/public viewing remains separate.

SQLite migration 39 adds controller columns and a grant target-session column.
In the existing migration write transaction it pins only historical rows to the
**pre-upgrade `OPS_BASE_URL`**, verifies that value against the trusted controller
list, and records `workspace_legacy_controller_origin` in `app_state`. Reopening
the database does not backfill new null rows or rewrite the receipt. There is no
request-derived or arbitrary-client fallback. An immutable session-controller
trigger prevents renewal code from changing that association. Staging/custom
installs retain their actual configured old authority rather than receiving a
hardcoded production origin.

## Coordinated release / operator handoff

1. Keep existing `OPS_BASE_URL` unchanged during the FIRST migration startup.
   In production that is `https://ops.ledgetopdroneservices.com`. On staging or
   a custom install retain that installation's actual existing value.
2. Publish/review the paired Ops and Viewer changes. The Ops grant fields are
   additive to the old Viewer API, so deploy Ops on the OLD staff hostname
   FIRST while the old Viewer remains live. Keep new-host Viewer launches and
   canonical navigation gated. The new Viewer intentionally rejects new signed
   grants missing `controllerOrigin`; Viewer-first is not a compatible order.
   The isolated local proof script below loads the original unmodified API
   source from base `43f31609`, validates its SHA-256, and exercises signed new
   fields through grant issuance and same-bearer renewal on the old controller.
   This is actual prior HTTP handler evidence with synthetic current storage,
   not a claim that the previous container image was deployed or tested live.
3. The operator updates both API and worker using the published image from
   `ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer`, retaining the existing tag
   policy, mounts, database, secrets, providers and Viewer public hostname.
4. Add this non-secret exact staff list in the existing container settings:
   `OPS_CONTROLLER_ORIGINS=https://ops.ledgetopdroneservices.com,https://ops.ledgetoptechnologies.com,https://ops.ledgetop.app`.
   This preserves both currently configured staff aliases; known production
   client/portal origins are rejected even if accidentally copied into this list.
   If another existing staff origin genuinely launches Viewer, preserve that
   individually reviewed origin too; maximum four, no wildcards or portal hosts.
5. Preserve existing `ALLOWED_EMBED_ORIGINS` and add exactly
   `https://ops.ledgetop.app` and `https://portal.ledgetop.app`. Embedding is
   separate from staff processing/controller authority. Existing public/legacy
   portal origins must remain for old links. This setting alone cannot grant
   staff processing access.
6. Keep `PUBLIC_BASE_URL`, `EXPECTED_HOST`, `OPS_AUTOMATION_BASE_URL` (the existing
   incoming host), reverse proxy/Access configuration, credentials and storage
   unchanged. No TrueNAS access or configuration change was performed by this
   implementation.
7. Verify an already-open old Ops Viewer session renews without changing its
   origin/session/bearer. Launch a separate new Ops session; verify background
   renewal, protected processing API requests and exact CORS. Verify client
   portal embedding works but cannot mint a staff grant. Exercise one existing
   public view/download, ensuring its host and permissions remain unchanged.

An invalid controller list fails startup/admission closed. Removing an origin
from it intentionally disables sessions pinned to that origin; retain old
controllers throughout overlap. `OPS_BASE_URL` can move later for navigation
and ready-event links after live acceptance; persisted old session controllers
remain unchanged. Never change it before the initial historical migration.

## Rollback and limits

The migration is additive. Do not drop columns, undo receipts, rewrite signing
keys or alter client links to roll back. Disable new-origin navigation first.
An old Viewer binary advertises its single global controller and cannot retain
new-origin session pins, so rolling back to it may require new-origin users to
reopen Viewer from the retained old staff host. The reviewed new binary can keep
both origins while navigation rolls back.

Local focused tests cover signed-body tampering, untrusted/missing controllers,
both origins, unchanged bearer/session on renewal, target-session substitution,
no grant consumption on mismatch, CORS/CSP separation, pre-upgrade custom-origin
migration and new null-row denial. Linux storage/processing suites and live
container/browser acceptance remain release gates; Windows lacks `/proc` mount
metadata used by those storage tests.


## Recorded local verification

- Ops: 47 focused service-body signing, initial-grant, actual Worker renewal
  routing and cross-service contract tests passed; TypeScript passed.
- Viewer: 78 focused session/security/transport/CORS/CSP/runtime/public-share
  and client-grant regression tests passed,
  one Windows symlink test skipped. The existing real isolated-browser CSP test
  and three concurrent/upgrade migration checks passed. Vite build passed.
- `node apps/viewer/scripts/verify-controller-rollout-compatibility.js` passed
  against API source revision `43f31609960af14b060964b1ca53d875f4d9eac2`, SHA-256
  `4fd14bddfdb1ddec4273eb5859eece34a3100f53342367565727bb2a7cd94e99`.
  This optional local release check requires that immutable Git object; it is
  not an image/runtime or network migration command.
- The broad Linux storage suite was attempted locally but requires `/proc`
  mount metadata unavailable on Windows. Two unrelated corrupt/terminal-state
  cases in the broader migration suite encounter Windows file cleanup EPERM.
  Those failures remain disclosed; they are not counted as passing coverage.

No image was published, container restarted, NAS accessed or production setting
changed by this candidate. The parent release must run Linux CI and record the
published image revision plus live old/new browser acceptance before cutover.
