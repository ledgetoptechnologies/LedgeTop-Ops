# Read-only staging bridge contract

This source is disabled and is not a deployed business-data service. Its
source-reviewed host lists remain empty. The direct managed HTTP entrypoint is
permanently closed; future deployment uses only the dedicated Access-protected
edge Worker and its private service binding. The edge has no assets router,
D1 database, connector or business-data bindings. The release owner must
review the exact host, account, application policy, service binding and
disabled alternate routes before enabling any deployment.

Cloudflare resolves a managed OAuth access token and forwards a signed Access
assertion to the origin; it does not promise to preserve the original
Authorization header. The edge requires the runtime-provided Access context
with the exact pilot audience, verifies the signed assertion, and compares its
email and subject to the runtime identity's email and user UUID. Any missing,
invalid or mismatched information is denied. The private read service then
independently verifies the assertion and checks current staff, admission,
source and operation permissions in the existing transactional read path.
Only the URL and assertion cross the service binding. No bearer or invented
Authorization header is forwarded.

Cloudflare documents the assertion subject and the runtime identity user UUID
as user IDs; their exact equality for this managed OAuth deployment needs a
provider-backed acceptance test. The code fails closed if they differ. Access
context is available for a direct Worker invocation and is not propagated to
the service binding. A static-assets router can prevent that context reaching
the Worker and must not be introduced into this edge deployment.

The origin cannot establish whether Access used OAuth or browser authentication
solely from the assertion. Cookie/Origin rejection is defense in depth, not a
native-only guarantee. Assertions are replayable until expiry; current staff and
record authorization must be checked on every read. Do not log credentials,
identity claims, raw provider responses or business data.

Before accepting staging: test real Access context and identity match, missing
and spoofed assertions, expired/wrong-audience/foreign-user assertions,
disabled or revoked staff and record/source permissions, read-only methods,
alternative routes, valid pilot token isolation from the web API, and sign-out
and expiry. Verify the endpoint returns only approved staging data. Successful
synthetic sign-in or local mocks do not prove these live properties.

References: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/),
[Workers Access context](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
and [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/).
