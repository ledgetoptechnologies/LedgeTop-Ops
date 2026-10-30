# Synthetic OAuth probe staging preparation

This is a local preparation record, not a deployment command or proof of user
approval. The probe returns only a fixed synthetic marker and has no business
database, service, connector or secret bindings. The application currently
installed on the iPad is unchanged. The separate Operations staging release
and real-data access have their own gates in [BACKEND-ROLLOUT.md](BACKEND-ROLLOUT.md).

## Proposed test boundary

- Cloudflare account: **Ledge Top** (`846c924bf17bf4f3dd15c97a4c5d1d51`),
  not the separate account named Staging.
- Candidate origin: `https://ios-pilot-staging.ledgetopdroneservices.com`.
  This remains a candidate until fresh collision checks and configuration review.
- Dedicated Access application: the prepared **LT Ops iPad OAuth Test** form
  uses the existing Beau-only policy, the exact native callback, a 30-minute OAuth
  grant, and the default 15-minute access-token lifetime. Localhost and loopback
  dynamic-registration options are off. The reusable policy also governs other
  applications; do not edit that policy to set up the probe. It has its own
  session duration, which is distinct from the configured OAuth grant lifetime.
- A dedicated Worker must use `src/worker/ios-pilot-oauth-probe.ts`, no routes
  other than the exact candidate hostname, and no business-data bindings. Disable
  `workers.dev`, preview URLs, and custom-domain previews; verify those settings
  on the deployed resource instead of relying only on a local config.

The current [Wrangler example](../operations/wrangler.ios-oauth-probe.example.jsonc)
is intentionally not deployable as a working probe: it has no account, route,
variables or bindings, and the source-reviewed origin list is empty. Its local
dry run only proves bundling. Do not add a route to this example and deploy it
as-is; prepare and review the exact source revision and separate deployment
configuration after the Access application exists and its audience is known.

## Before any provider change

1. Wait for the pending per-action confirmation before creating the prepared
   Access application. Verify its exact domain, callback, policy, grant settings,
   and separate application audience after creation. Never alter the existing
   Operations Access application or its policy for this experiment.
2. Immediately before assigning a route, repeat account-wide Worker custom-domain,
   zone Worker-route, Access-destination and DNS checks, including wildcard and
   preview routes. The October 29 read-only check found no exact existing record
   or custom-domain match, but the zone has a DNS-only wildcard A record. Adding
   a more-specific custom domain changes how that hostname resolves. Check the
   exact target and any affected existing service before proceeding.
3. Obtain the new app's real Access audience and verify it differs from all
   relevant Operations web audiences. Review a narrow source-controlled origin
   allowlist change and a staging-only Worker configuration with exact account,
   origin, team issuer, app audience and Operations audience. Keep the flag off
   until the Access application and effective routing are confirmed. There must
   be no D1, connector, service binding, or secrets in the synthetic probe.
4. Validate the exact candidate source/config locally, including tests and a
   Wrangler dry run; inspect the deployment plan and any DNS effects. Coordinate
   resource ownership and preserve other sessions' work. Do not assume the
   pending Access confirmation also approves a separate security-sensitive UI
   action if the computer-use policy requires confirmation at that action.

## Provider and device acceptance

After the isolated route is in place, verify Access discovery and dynamic client
registration with the exact callback and public-client PKCE. Validate the
provider's metadata, issuer, endpoint pins and resource against the app; do not
log tokens, authorization codes, assertions, emails or private data. Test a
normal sign-in on the iPad, cancellation, expiry, sign-out, provider revocation,
and return to the app. Confirm the existing app is updated in place and only one
pilot is installed.

Test that missing, invalid and mismatched bearer tokens fail at Cloudflare and
that a client-supplied assertion is not trusted. Verify the exact protected host,
the Worker version and audience, and that workers.dev, preview and other routes
cannot reach the probe. The probe itself validates assertion signatures and
audience but only checks bearer syntax; a successful response alone does not
prove Cloudflare bound the bearer to the assertion. Also test that the pilot
token cannot access the general Operations API or its write endpoints.

If a check fails, disable the probe and remove or roll back only resources
created for this test after checking ownership and the normal recovery path.
Do not remove the shared wildcard record, existing Access policy, web routes, or
unrelated assets. Recheck effective DNS and Access behavior after rollback; a
new specific record can expose the previous wildcard behavior when removed.
