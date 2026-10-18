# Canonical client portal origins

The canonical authenticated entry point is `https://portal.ledgetopdroneservices.com/portal` in production and `https://portal-staging.ledgetopdroneservices.com/portal` in staging. This patch changes canonical origins and retires former portal entry points. The unified dashboard without a workspace switcher is a separate UI change being prepared by Claude. The canonical portal is intended to combine services each signed-in client is authorized to use across both Project Alpha sources. The existing Technologies portal aliases remain supported; this change does not merge client identities or expand their permissions.

`CLIENT_PORTAL_RETIRED_ORIGINS` contains former authenticated entry hosts. GET/HEAD requests for their portal pages redirect to the primary portal and preserve the selected page and query. Their private APIs fail closed without forwarding request bodies, cookies or authorization headers. Static assets and minimal health responses remain available for compatibility.

`LEGACY_CLIENT_ORIGINS` has a different purpose: it preserves public bearer links and their host-bound download sessions. Production retains `https://client.ledgetopdroneservices.com` in this list. Adding a retired staging portal host must not add it to this public allowlist. Old share URLs, passwords, session signing keys, share versions, DNS and Worker domains stay unchanged.

## Configuration bundle

Apply each environment's bundle to its existing Workers; do not replace live settings wholesale with the checked-in defaults. The private release packet must capture the actual current resources, policies, DNS, domains and variables before any action.

| Setting | Production | Staging |
| --- | --- | --- |
| Client primary portal | `https://portal.ledgetopdroneservices.com` | `https://portal-staging.ledgetopdroneservices.com` |
| Client active portal origins | Canonical Drone Services portal and existing Technologies portal | Canonical Drone Services staging portal and existing Technologies staging portal |
| Client retired portal origin | `https://client.ledgetopdroneservices.com` | `https://client-staging.ledgetopdroneservices.com` |
| Client public origin / `EXPECTED_HOST` | Keep existing `portal.ledgetopdroneservices.com` | Keep existing `delivery-staging.ledgetopdroneservices.com` |
| Client legacy public origins | Keep existing `https://client.ledgetopdroneservices.com` | Keep absent |
| Native enrollment and authority expected hosts | `portal.ledgetopdroneservices.com` | `portal-staging.ledgetopdroneservices.com` |
| Native deployment profile | Exact canonical portal production profile | Keep production profile absent |
| Ops `DELIVERY_BASE_URL` | Canonical production portal | Canonical staging portal |

Client production accepts only its existing canonical Access audience after retirement. Staging retains its existing Access audience while its hostname coverage moves. Keep existing selectors, identity providers and session settings. Ops' origin list also controls Stream playback: retain old public-share video hosts there. This does not admit those hosts to Client private APIs.

The native deployment guard supports the original exact production profile/origin pair for a coordinated rollout or rollback, plus the new exact canonical pair. Mixing a profile with the other origin is rejected. Recipient, publication and file authority checks remain unchanged.

## Release and retirement gates

1. Back up the complete live app/policy/DNS/domain definitions and all policy references. Capture share configuration and existing anonymous routes.
2. Protect the new Drone Services staging portal hostname in the existing staging Access application before provisioning its Worker custom domain/DNS/certificate. Preserve the old hostname until replacement login works.
3. Release the paired Client/Ops staging configuration bundle. Verify the existing identity and workspace memberships, both-source authorized resources, native file access and own-profile editing. Anonymous private APIs must deny access. Old client portal entries must redirect, and old private APIs must fail closed.
4. Verify existing public links and their authenticated download sessions without rotating secrets or changing records. The retired staging hostname must not gain public-share access.
5. Remove old staging client-host coverage only after those checks. Its old public-assets Bypass application becomes unnecessary once no old-host catchall remains; verify account Default-Deny/fallbacks before retiring it. Keep the staging client Allow policy attached to the surviving portal application.
6. Repeat the paired release and verification in production. The two production portal domains already have the canonical Access application's protection.
7. Retire only the old authenticated client-domain Access application after its browser redirect and API denial are verified. Preserve the shared verified-email policy on the canonical app. Delete a policy only after a complete fresh reference inventory proves it is no longer attached anywhere.

Never delete the old `client.*` DNS or Worker custom domain: public share URLs and resumable sessions still depend on that host. Never redirect an entire legacy hostname or forward API credentials to a different origin.
