# Synthetic OAuth probe staging preparation

This is a local preparation record, not a deployment command. The probe returns
only a fixed synthetic marker and has no business
database, service, connector or secret bindings. The application currently
installed on the iPad is unchanged. The separate Operations staging release
and real-data access have their own gates in [BACKEND-ROLLOUT.md](BACKEND-ROLLOUT.md).

## Proposed test boundary

- Cloudflare account: **Ledge Top** (`846c924bf17bf4f3dd15c97a4c5d1d51`),
  not the separate account named Staging.
- Candidate origin: `https://ios-pilot-staging.ledgetop.app`.
  This remains a candidate until fresh collision checks and configuration review.
- Dedicated Access application: **LT Ops iPad OAuth Test** was created with
  Beau's action-time approval on October 29, 2026. Its ID is
  `1f42d803-99a4-4c2f-8ac3-42b6dfec3665`, and saved audience is
  `e982d104616a480315256a577ef5ad5ce089f382c0b5453ce9db4cd9df7cf89d`.
  With Beau's approval, the saved destination was changed to
  `ios-pilot-staging.ledgetop.app`; the audience, policy, OAuth callback and
  grant settings were verified after the change.
  The saved application uses the existing Beau-only policy, exact native callback, a 30-minute OAuth
  grant, and the default 15-minute access-token lifetime. Localhost and loopback
  dynamic-registration options are off. The reusable policy also governs other
  applications; do not edit that policy to set up the probe. It has its own
  session duration, which is distinct from the configured OAuth grant lifetime.
- A dedicated Worker must use `src/worker/ios-pilot-oauth-probe.ts`, no routes
  other than the exact candidate hostname, and no business-data bindings. Disable
  `workers.dev`, preview URLs, and custom-domain previews; verify those settings
  on the deployed resource instead of relying only on a local config.

The [Wrangler example](../operations/wrangler.ios-oauth-probe.example.jsonc)
has no account, route, variables or bindings. The separate
[staging candidate](../operations/wrangler.ios-oauth-probe.staging.jsonc)
records the exact account, hostname, distinct audience and issuer,
and enables the synthetic probe; the source allowlist contains only the
reviewed origin. Recheck route and ownership before any future deployment.
Deploying a custom-domain route can change DNS and routing even when the probe
flag is off. It has no business database, service, connector or secret bindings.
The `ledgetop.app` candidate passed the focused probe suite (5 tests) and a
Wrangler 4.118.0 dry run with only its six environment variables. These local
checks do not prove provider routing or OAuth behavior.

The disabled candidate was first deployed to the exact custom domain as Worker
`lt-ops-ios-oauth-probe-staging`, version `a57c4a0b-cf8e-41f6-9588-604276250881`,
then the synthetic marker was enabled as version `f1fad661-f9f3-4985-961e-9ff9b876941d`.
Provider readback showed only six plain-text variables and no other bindings;
workers.dev and preview URLs were disabled. Unauthenticated and invalid-bearer
requests returned 401 both before and after enabling. The protected host's OAuth discovery returned metadata
with the expected team issuer and endpoints. This does not yet test a real
authorization, valid bearer/assertion binding, sign-out or iPad callback.
After enabling, provider readback again confirmed the flag is true, all six
bindings are plain-text settings, workers.dev and previews are disabled, and
the Worker has only the intended custom hostname. Cloudflare identifies this
independent Worker's default environment as `production`; its configured
application environment is `staging`, and it is not the Operations Worker.
As a limited negative check, GET and POST requests to the existing Operations
API with a fabricated pilot-style bearer redirected to Cloudflare Access rather
than returning API data. This does not establish what happens with a real valid
pilot token; that cross-audience test remains required.

For the prior `ios-pilot-staging.ledgetopdroneservices.com` candidate, after
Access app creation, a fresh account-wide Worker custom-domain read found
no exact or wildcard match among 28 returned domains. The dashboard showed no
zone Worker routes, no exact DNS record, and an existing DNS-only wildcard A
record. The authenticated API token could not read the zone route/DNS endpoints
(403); the dashboard was used instead. An HTTPS HEAD to the prior hostname
timed out. An HTTP HEAD returned a 301 identifying OPNsense and redirecting the
same hostname to HTTPS port 8443, so the wildcard currently leads toward an
existing gateway. This does not establish whether a service uses the specific
hostname. These observations do not establish ownership or routing for the new
`ledgetop.app` candidate; perform fresh checks before routing it.

For the `ledgetop.app` candidate, the account-wide Worker domain inventory
showed no exact or wildcard match; the domain dashboard showed only three exact
Worker DNS records and no wildcard DNS records or zone Worker routes. The
Access application list showed the dedicated app at the candidate hostname.
Repeat these checks immediately before any route assignment.

## Before any provider change

1. The Access application's current domain, callback, policy, grant settings and
   separate audience were checked after the approved destination change. Recheck
   them before deployment.
   Never alter the existing Operations Access application or its policy for this
   experiment.
2. Immediately before assigning a route, repeat account-wide Worker custom-domain,
   zone Worker-route, Access-destination and DNS checks, including wildcard and
   preview routes for the new candidate and its zone. Adding a more-specific
   custom domain can change how that hostname resolves. Check the
   exact target and any affected existing service before proceeding.
3. The new app's audience differs from the production Operations audience in
   `wrangler.jsonc`; verify against all relevant Operations web audiences.
   Review the narrow source-controlled origin allowlist and staging-only Worker configuration with exact account,
   origin, team issuer, app audience and Operations audience. The synthetic flag
   is enabled only on the isolated test Worker. There must
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
