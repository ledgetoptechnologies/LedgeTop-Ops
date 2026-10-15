# Native delivery production admission

The native delivery RPC writer/status/cancellation consumers, authenticated file
routes, fresh Operations proof adapter and mandatory content-start audit share an
explicit production deployment profile. All existing feature flags remain
default-off. Existing staging behavior is preserved; staging acceptance and
maintenance routes are not enabled in production by this change.

`CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE` must contain the
exact canonical JSON exported as `NATIVE_DELIVERY_PRODUCTION_PROFILE` by
`apps/client/src/worker/operations-native-delivery-deployment.ts`. It pins account
`846c924bf17bf4f3dd15c97a4c5d1d51`, Worker `ledgetop-clients`, and `DELIVERY_DB`
`7f40a7b7-c3ec-470e-a626-e798867f71f8`. Before setting it, the deployment preflight
must independently verify those actual Cloudflare resource bindings and the
reviewed Operations service binding. A D1 binding object does not expose its
physical database identity at runtime; the profile is a deployment assertion.

Production authenticated native bytes are confined to
`https://client.ledgetopdroneservices.com`. Keep `EXPECTED_HOST` at
`portal.ledgetopdroneservices.com` and both `PUBLIC_BASE_URL` and
`PUBLIC_SHARE_ORIGIN` at `https://portal.ledgetopdroneservices.com`. Do not redirect
or rewrite existing public links to the authenticated portal. Portal aliases do
not gain native file access merely by appearing in the portal origin allowlist.

The profile does not grant any recipient or file authority. The existing exact
principal, current publication/home/delivery heads, folder/project fences,
private Operations proof, revocation checks and content-start audit remain
required. A feature flag without this profile, a mismatched environment, or any
altered profile resource/host fails closed before D1, service RPC or R2 access.
