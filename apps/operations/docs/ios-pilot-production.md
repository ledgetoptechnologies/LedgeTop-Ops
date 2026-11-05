# Production read-only pilot source candidate

This source adds a separate path for eventual access to actual Operations
records. It is not deployed or configured. It does not enable the current iPad
build, alter staff/source permissions, migrate a database, or provision Access.

The candidate production hostname is `ios-pilot.ledgetop.app`. It has not been
collision-checked or approved. A release owner must verify ownership, existing
routes/DNS, a dedicated production Access application and its exact audience,
effective policy, and the intended production database and source manifest
before activation. Never bind a staging OAuth resource to production records.

## Separate entrypoints

- Public main: `src/worker/ios-pilot-production-edge.ts`. It has only the default
  HTTP export and calls a private `IOS_PILOT_READ` binding. It imports no business
  read implementation and needs no database or connector credential binding.
- Private main: `src/worker/ios-pilot-production-read-entrypoint.ts`. Its only
  named export is `IosPilotProductionReadService`; default HTTP always denies.
  It does not export the general Operations handler or any workflow.
- Both require `ENVIRONMENT=production`, exact candidate origin, the existing
  managed-pilot switch, and the additional
  `IOS_PRODUCTION_READ_PILOT_ENABLED=true` switch. All are absent/off by default.
  A missing audience, the known staging pilot audience, or the general
  Operations audience is refused. Release review must verify that any configured
  audience belongs to the new dedicated production Access application.
- The private service also requires a nonempty source manifest with
  `PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED=true`; existing manifest parsing,
  transactional revision fences, current staff admission and record/source
  authorization remain authoritative. No credential envelope is loaded by the
  GET-only reader.
- The production edge never serves the synthetic probe, even with probe flags
  set. It preserves the shared bounded GET facade, runtime Access context and
  signed assertion identity comparison, and the private service independently
  verifies the assertion and current authorization.

Existing staging entrypoints still hardcode staging policy. Supplying production
settings to them cannot select the new policy. No deployable production Wrangler
configuration, production audience, database ID, route or secret is supplied by
this change. Keep workers.dev and preview URLs disabled in the eventual reviewed
configuration. Use a distinct production service binding target and pin the
actual deployed module/entrypoint; never rely on its name as identity proof.

## Required acceptance

1. Obtain release-owner review of the exact source/configuration and finish the
   separate staging validation before enabling actual data reads.
2. Verify dedicated Access resource isolation from the general API, staging
   tokens, invalid/expired/foreign assertions, missing or mismatched runtime
   identity, browser headers, mutations, alternative paths and routes.
3. Verify current staff/source/record restrictions, pagination, no business
   mutations, revocation and expiry against the actual approved deployment.
4. Select the reviewed production resource in the native client, update the
   existing app and validate real list/detail and restart behavior on the iPad.

Local synthetic checks are not live authorization acceptance. The candidate
hostname and additional flags alone are not permission to deploy or activate.

## Local qualification, November 5

The complete focused pilot suite passed 54 tests across 11 files with zero
skips, including the existing signed-assertion/local-D1 permission tests.
Operations `tsc --noEmit` and `git diff --check` passed. New tests exercise
cross-environment refusal, the additional production switch, known-staging and
web-audience refusal, method/route limits, runtime identity matching, mandatory
source-metadata settings, propagation of authoritative denial, and actual
Workerd default-HTTP/named-service boundaries. The production edge bundle has
only its default export and excludes the business read implementation.

Boundary handler fixtures are synthetic and inject the authoritative reader;
the unchanged common staff/source/record logic is covered separately by the
existing local-D1 tests. These checks do not prove production schema, Access
configuration, permissions, registry contents, native client configuration or
live data acceptance. No provider resource or application setting was changed.
