# Finite domain recognition proposal

This declaration contains no settings writer. The guarded backend CLI accepts only an explicit finite `--domain-phase <name>` option, defaulting to baseline. It never automatically selects a state or changes installed scalar values. The selected phase recognizes an already-installed exact state before the existing backend upload/activation path may run. Every installed resource, secret binding, scalar name, flag, cron, runtime setting, public-share namespace, frontend hash and opaque asset association remains exact. Domain state changes need separately reviewed control-plane application and live acceptance.

| State | Exact differences from original installed profile |
| --- | --- |
| baseline | None. |
| ops-alias-preparation | Only Operations `OPERATIONS_ORIGINS` and `CLIENT_PORTAL_ORIGINS` add the exact new browser hosts while retaining all old ones. Private generated URLs remain old. |
| client-private-overlap | Retain Ops alias preparation and old private generated URLs. Client `CLIENT_PORTAL_ORIGIN`, `CLIENT_PORTAL_ORIGINS`, both native expected-host settings and exact native physical deployment profile become the new portal tuple with old LTDS private byte overlap. |
| portal-entry-canonical | After Client acceptance, change only Operations `DELIVERY_BASE_URL` to `https://portal.ledgetop.app`, retaining the prior overlap state. |
| staff-canonical | All portal-entry-canonical differences, plus Operations `PUBLIC_BASE_URL`, `EXPECTED_HOST`, and `CLIENT_ONBOARDING_ADMIN_ORIGIN` use `https://ops.ledgetop.app` (host-only EXPECTED_HOST). |

Exact values are returned by `domainPhaseValues`; `domainRecognitionDiff` returns these nonsecret values and a hash of the unchanged complete resource/asset/runtime settings shape. No arbitrary scalar override, missing name, unknown phase or extra deployment mode is accepted. Existing synthetic adapter tests run each finite state and reject changed public-share namespace and physical resources. Partial states do not satisfy the complete chosen state's scalar hashes.

Private-entry URL audit: Operations `DELIVERY_BASE_URL` currently builds private `/portal/deliveries`, feedback and access notifications and supplies recipient-enrollment authority origins. Public links are constructed with `publicShareOrigin(env.PUBLIC_SHARE_ORIGIN)` (`delivery.ts` shareUrl, delegated share signer and notifications). The reviewed private-entry phase changes DELIVERY_BASE_URL only after Client new-host acceptance. Earlier phases retain old generated private links. Public canonical origins and original cookies remain unchanged. Explicit finite intermediate states account for separately published Worker settings; an Ops new-entry/old-Client combination fails recognition.

## Required paired live acceptance

1. Capture current sole active/latest versions, resource/scalar hashes, entire opaque assets association, schedules, custom domains, complete bucket CORS, and existing Access apps before changes. Reject unexplained drift; an approved source declaration is not live evidence.
2. Deploy tested backend compatibility with retained opaque UI/assets before domain scalar transition. Deploy paired Viewer support for old/new controller pins first; existing Viewer sessions must keep renewing with their original controller.
3. Add exact Worker custom domains `ops.ledgetop.app`→`ledgetop-ops` and `portal.ledgetop.app`→`ledgetop-clients`, retaining all existing domains. Access additive destinations are already saved; verify audiences/policies/paths remain unchanged. No blanket root human gate on public-share APIs.
4. Advance only one reviewed finite state at a time after its code is active: Ops aliases, then Client private overlap, then (after acceptance) Ops generated private entry, and staff canonical last after Viewer acceptance. A Client new-primary transition must be atomic with both expected-host fields and the exact physical profile; current code retains old LTDS private byte/API requests under that profile. Preserve all public origins, cookies, IDs, grants, flags and secrets.
5. Test new portal signed-out authentication→normal verified-email login→one authorized synthetic client's files; test an unrelated client denied. Test identical finite bytes and ranges on both old/new native private origins, revoked grants, stale proof and unauthenticated denial; old open sessions must continue working.
6. Exercise each old public-link form on its original host, including fragment-first exchange, existing host-only cookie, access code, revoked/expired shares, ranges and ZIP. No API/body/cookie forwarding or cross-host redirect.
7. Review actual bucket CORS before additive exact-origin update: retain every installed rule/header/method and add only the new appropriate portal/staff origin. Complete an authorized synthetic multipart upload from each new host, preflight/PUT/ETag/finalize/readback; deny arbitrary origins. Source CORS intent is not an authoritative live inventory.
8. On old and new Ops, launch Viewer and observe silent renewal under the same identity and original per-grant controller/subject/resource pins; test wrong-origin and expired/revoked denial. Normal app HTML or DNS health alone cannot pass this gate.
9. Only after acceptance may private generated URLs and staff canonical fields be promoted. Redirects remain a separate unmounted draft. Roll back to captured Worker version and exact scalar/CORS/domain state on failure while preserving old hosts/assets and all data; reconcile uncertain writes by readback rather than retry.

## Explicit guarded CLI

After review and CI, an operator can inspect the exact installed state using the existing conventional Build environment:

```sh
node scripts/production-deploy.mjs --inspect --domain-phase client-private-overlap
```

This path uses the existing official GET-only metadata reader, validates all three Workers against the explicitly chosen state, and prints only recognized phase, active version IDs, hashes and booleans. It never invokes native upload/deploy, creates a private journal or prints snapshots/scalar/secret values. Unknown/malformed arguments fail before credentials or network. Current candidate fingerprint and process-environment guards still apply. The new mode has not been run live at source-review time.

A backend deployment can explicitly recognize an already-installed finite state:

```sh
node scripts/production-deploy.mjs --worker client --mode backend --execute --domain-phase client-private-overlap
```

Omitting `--domain-phase` preserves the original baseline behavior. This option cannot publish phase values, bootstrap an installation, change routes/CORS, upload browser assets, bypass unknown scalar/resource drift or select an arbitrary profile file. UI mode remains denied. Applying control-plane phase values and doing the paired acceptance are separate reviewed operations.