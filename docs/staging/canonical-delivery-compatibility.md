# Canonical delivery compatibility candidate

Base: `origin/main` at `92b688f2014b92bd2bfa1972d1d653fb7921ebbd`.
This source candidate changes no deployed settings, routes, Access policies,
credentials, assets, data or Viewer configuration. The redirect helper is
mounted only by the later default-off browser navigation control. See
`canonical-navigation-mount.md` for handler behavior and the unresolved
Operations asset-routing gate. No redirect is enabled by this declaration.

The finite new Client tuple is `EXPECTED_HOST=delivery.ledgetop.app`,
`PUBLIC_BASE_URL=PUBLIC_SHARE_ORIGIN=https://delivery.ledgetop.app`,
`CLIENT_PORTAL_ORIGIN=https://portal.ledgetop.app`, with the exact
`NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE` assertion. The profile preserves
the existing physical Worker/database and the old LTDS private byte origin.
All three public tuple values and the profile must match. An old profile with a
new public host fails closed. Release tooling must independently verify physical
resources; this assertion is not permission or an introspection mechanism.

During compatibility, `CLIENT_PORTAL_ORIGINS` can retain the exact old LTDS portal
alongside portal.app, and `LEGACY_CLIENT_ORIGINS` retains the exact old public
LTDS portal and client hosts. The old combined portal keeps its existing private
and public namespaces. No other alias receives that overlap exception. The new
portal.app host cannot be configured as a legacy public alias in this tuple;
its `/s` and `/client-share` paths stay denied. Machine ingress stays private
primary only. The new delivery host gets no private portal API or byte admission.

`canonicalDeliveryEntryRedirect` handles only explicitly enabled fresh GET/HEAD
document navigations on the two exact historical public hosts, and only after
the new canonical public tuple and source compatibility admission exist. It
preserves the exact public entry path and query and returns a non-cacheable 302.
Its Location omits a fragment so the browser inherits the source link's private
fragment without exposing it to the server. Cookie, Authorization, Origin,
Range and If-Range headers prevent the redirect. APIs, POST, media, assets,
Viewer, onboarding and private pages are excluded. Browsers without Fetch
Metadata remain local. Cookies and request bodies are never forwarded.

Existing host-only delivery and bulk-resume cookies cannot move between domains.
Public delivery sessions last 12 hours and renew within a 2-hour window, so a
12-hour wait alone does not drain active sessions. Keep old public API/media/
POST/session endpoints and old controller origins until a separately reviewed
handoff/drain or reauthentication plan is accepted. Do not remove these host
admissions as part of enabling this helper. Business email policies are unrelated.

## Release gates still required

1. Independently capture current installed Worker versions, full settings/assets,
   domain/Access destinations and old-controller evidence. Re-read current Hub
   decisions; preserve the active Client video hotfix and exact retained asset
   union. The recorded retention floor is 2026-10-26 20:23:21 UTC; any later served
   release extends its own 48-hour window. No automatic pruning.
2. Review the finite `delivery-public-canonical` recognition/settings draft from
   `portal-entry-canonical`. It changes exactly five Client scalars: expected
   public host, both public origin fields, legacy public overlap, and the exact
   native deployment profile. Operations public-link generation changes only
   in the separate `delivery-links-canonical` phase after Client acceptance.
3. Add and verify delivery.app routing and public-path Access coverage without
   placing a staff/private login gate on public shares. Keep existing staff and
   client token audiences; Operations verifies `OPERATIONS_AUD`, private portal
   verifies `CLIENT_ACCESS_AUD`/`CLIENT_ACCESS_AUDS`. Domain changes are not
   authority to replace those audiences or copy unrelated email policies.
4. Verify Viewer exact embed origins include delivery.app where public embeds
   require it. Keep Viewer hostname, per-session controller pins, subject,
   audience and original bearer unchanged. Old staff controller admission must
   remain for old pinned sessions; embedding and controller authority differ.
5. Test synthetic first-use fragment and legacy single-token links, existing
   old cookies, access-code exchange, delegated shares, expired/revoked denial,
   thumbnail/PDF/media, Range/If-Range/HEAD, ZIP/bulk resume, and cloud OAuth
   callbacks/resume origins. R2 presigned URLs bind their own bucket host and
   must not be rewritten. Verify active old/new asset bytes, private native byte
   access and deny cases. Local policy tests cannot establish live acceptance.
6. Enable a reviewed mount only after paired acceptance. Separately design the
   final old-host API/session retirement; retain rollback state and assets.

## Local validation

- `node --test scripts/canonical-delivery-compatibility.test.mjs scripts/domain-migration-compatibility.test.mjs scripts/canonical-domain-navigation.test.mjs`: 25 passed.
- `node --test scripts/canonical-delivery-browser.test.mjs`: Chromium fragment
  inheritance passed with two local-only HTTP listeners; target authority is
  mapped to loopback. This proves browser redirect semantics, not live TLS,
  Access, Cloudflare routing or production session exchange.
- Client TypeScript check passed.
- Existing Client deployment, portal-origin migration and native delivery route
  suites: 66 passed across three files.

Relevant source history: domain source `47e77f15`; release merge `77eb072a`;
navigation draft `f3c2d4a8`; scalar transition preparation `c0abb6fb`; manifest
alias qualification `55d54bf6`. These prepared compatibility/recognition tools,
not evidence of live canonical redirects. Scalar transition notes document a
held writer/runtime-export qualification, so do not replay those writers merely
because an old branch contains them.

## Offline finite transition drafts

`scripts/production-delivery-domain-transition.mjs` supplies pure offline
builders; importing or calling them performs no reads or writes outside the
provided in-memory snapshots. There is no executor, credential reader or CLI
entry point. The existing guarded CLI recognizes both phase names; recognizing
a name does not publish its scalar values, relax frontend/asset/resource gates,
mount a redirect or satisfy live acceptance.

`compileDeliveryDomainTransition(snapshot)` requires the complete old
`portal-entry-canonical` profile and returns a complete Client settings draft
plus expected snapshot. It preserves every original settings field/binding,
resource, cron, asset association, Operations and Sync state. It retains all
three current private portal origins, including the LTT compatibility alias.
Only the five listed Client scalars differ. Private native expected-host pins
and original Viewer controller origins remain unchanged.

`compileDeliveryPublicLinkTransition(snapshot)` is a distinct next-step builder
requiring the complete Client delivery phase. Only Operations
`PUBLIC_SHARE_ORIGIN` changes; private `DELIVERY_BASE_URL`, incoming/internal
URLs, all Client settings and all Sync settings remain exact. Its returned
`clientPublicAcceptanceRequiredBeforeApply: true` records an unresolved release
gate, not a claim that acceptance happened. Neither builder applies settings.

The fresh redacted operator observation at 2026-10-25 00:12:11 UTC agrees with
the prior Client public tuple and the three private portal origin strings used
by these phases. It reports active Client `4b763af4`, Operations `79621b47` and
Sync `6f8e224c`. This does not update the historical committed profile's runtime,
resource or asset hashes. Full actual installed baseline reconciliation must
remain a separate reviewed operation; builders reject unexplained newer state
instead of deriving an approved baseline from whatever happens to be installed.
No private snapshot, credential value or client record is included here.

Validation: five new offline recognition/transition tests and all 52 existing
production deployment tests pass. Tests prove unchanged resources/assets and
complete settings binding preservation with synthetic snapshots. No new
production observation, update, upload or activation was performed.
