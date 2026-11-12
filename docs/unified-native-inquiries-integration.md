# Unified client requests and history: integration candidate

This source cohort combines the existing PA request lane with explicitly authorized Operations inquiries. Clients use one request screen; current server-side authority determines the destination. It is not deployed or activated merely because these files are present.

## Source and scope

Prepared from main f7ba97b9, preserving the canonical LTDS/LTT category correction f8ad7f9f. Reuses the existing draft implementations fe9202bd,42fffd92,fc285011,643700bb,dd97852c,3f2eda53,f418ab58,287ef95f,307380b5,4d5965ea,c52846e1,a566d07c and96f2da46. Their original commits remain available; no other agent branch was rewritten.

Includes capability consent, companion dispatch/mirror, Ops inquiry storage and staff notifications, bounded merged PA/Ops history, kind-based routing, and revoke-race fixes. Logs, iOS, owner Intel and direct-folder grants are outside this cohort.

## Authority requirements

An existing service-home grant does not grant request submission. A request needs the explicit v4 `operations.request.create` companion, a current base grant and publication, exact recipient/principal pins, a verified mirror and current membership. Never infer these from an email address. Changed or revoked witnesses fail closed. Ambiguous PA accounts do not silently receive a request; the independently authorized Ops lane handles eligible triage.

Legacy v3 home-only grants remain home-only. Capability issuance, capability mirroring and customer inquiry access retain separate gates. Keep all new gates off until their schema, source, identity, binding and owner-review prerequisites are verified.

## Migration and deployment order

1. Read the actual installed migration history. The required successors are Ops0233,0234,0235 and Client0243; do not blindly reapply them or copy a different account's database identifiers.
2. Qualify both complete schemas and controlled synthetic grant/revoke/request/history workflows in the separate Staging account. Exercise uncertain retries, principal isolation, changed publication, revocation and staff notification delivery.
3. Review the effective resource profile. The Client-to-Ops `OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES` binding targets the new `OperationsNativePrincipalInquiryIngress` entrypoint. Existing Ops-to-Client recipient-authority RPC carries companion methods. Make the Ops entrypoint available before a Client deployment depends on it.
4. Review new exports, service bindings and scalar pins through the existing guarded release process. Do not bypass the exact installed-profile checks or use the raw development Wrangler files as a production deployment configuration.
5. Activate only the independently reviewed gates and synthetic recipient permissions. Then verify the real signed-in portal, merged history, classification and notifications before general rollout. Main-only Actions, PR-only changes and actual 48-hour frontend asset retention remain required.

## Scalar budget constraint

The pinned production Ops profile already has103 plain scalars and25 secret bindings:128 total. Enabling the principal-inquiry and companion-capability gates as additional independent scalars would exceed that limit. No protected flag was removed or combined here. A separately reviewed retirement of genuinely obsolete scalar names, or a reviewed Worker/configuration split, is required before activation. The new service binding itself does not consume a text/secret slot. Raw Wrangler default declarations already differ from the effective pinned profile and are not a live-state count.

A narrower candidate for that review is omitting two existing explicit-false declarations while preserving their disabled behavior: `PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED` and `PROJECT_ALPHA_DELIVERY_GUEST_ENABLED`. Both are pinned false; the inspected Ops intent/entrypoint consumers use strict `=== "true"` or `!== "true"` checks. This is an omission proposal, not permission to enable, delete or silently repin anything. Before adopting it, test absent-versus-false route/preflight behavior, external consumers and old public links, then review an exact profile transition that exchanges those two disabled declarations for the two independent inquiry gates without exceeding128. Keep the legacy code and disabled semantics; retain the maintenance barrier and all unrelated controls. No profile or provider change is included here.

## Qualification recorded so far

- All31 changed TypeScript files parsed using Node's TypeScript transformer.
- Fifteen assertions against the actual v4 grammar passed, including explicit consent, home-only legacy behavior and malformed/expired capability rejection.
- Strict migration inventory validation initially caught missing Client0243 successor admission. Its exact existing draft SHA256 was added; frozen199-Operations/149-Client inventories remain unchanged and both strict checks pass.
- SQLite3.50.4 applied all234 Ops and162 Client source SQL files in isolated in-memory databases, with zero foreign-key violations. This is SQL syntax/schema evidence, not Cloudflare D1 or real-authority acceptance.

Vitest route/RPC/notification tests, application typecheck/build, real D1 migration qualification and authenticated client acceptance remain unrun for this assembled source. No provider setting, migration, permission, client record or deployment was changed. This candidate must receive its own qualification and review after the current release; do not fold it into an in-flight release.
