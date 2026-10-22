# ledgetop.app Cloudflare readiness inventory

Read-only observation on October 22, 2026. No DNS, Workers, Access, certificate,
policy, account, database or TrueNAS changes were made.

## Account-specific observations

| Item | Observed state |
| --- | --- |
| Account | `846c924bf17bf4f3dd15c97a4c5d1d51` |
| Zone | `4301f5748241d683471ef45bac0da34f` (`ledgetop.app`) |
| Zone/registrar | Active, Full DNS setup, Cloudflare Registrar; registration expires October 22, 2027 |
| Authoritative nameservers | `alberto.ns.cloudflare.com`, `anastasia.ns.cloudflare.com` (also resolved through public DNS) |
| DNS records | Cloudflare DNS page reports zero records |
| Existing Worker connection | Zone overview says “No Workers connected” |
| Portal DNS | `portal.ledgetop.app` returns DNS name does not exist |
| Universal certificate | Active for `ledgetop.app` and `*.ledgetop.app`, displayed expiry January 20, 2027 |
| Zone TLS settings | Always Use HTTPS off, minimum TLS 1.0 default, TLS 1.3 on; observed only, unchanged |

The certificate is ready, but the absence of DNS/Worker bindings means this is
not yet a serving Operations or Client hostname.

## Existing Access boundaries to preserve

The signed-in Cloudflare Access inventory contains fifteen applications. Its
production staff application is `LTDS Ops default Admins`, application ID
`76ca2837-2d09-4d22-a303-d191823cdb83`, with these exact destinations:

- `ops.ledgetopdroneservices.com`
- `ops.ledgetoptechnologies.com`

Its displayed application session duration is 24 hours. It uses the existing
`LTDS Ops` Allow policy, ID `d74d1513-5510-410e-9c5d-d9a80a35d7a4`.
Neither staff destination is `ledgetop.app` yet.

The production `LTDS Client Portal` application, ID
`34439cca-fa0b-43e2-a830-bd569e303e68`, contains:

- `portal.ledgetopdroneservices.com/portal*`
- `portal.ledgetopdroneservices.com/api/client*`
- `portal.ledgetoptechnologies.com/portal*`
- `portal.ledgetoptechnologies.com/api/client*`

The legacy client application remains separate, ID
`ce8e60fa-47a7-42e3-b38a-460c0810d173`, with
`client.ledgetopdroneservices.com/portal*` and one other destination. Its second
destination was not expanded during this audit. Separate internal-projection
and Ops Sync applications also exist and must not be replaced with human-login
or blanket public-bypass policies.

## Reversible connection sequence

1. Ship compatibility code that recognizes the proposed hosts while leaving
   canonical redirects disabled. Preserve old hosts, namespaces, signing
   contracts, cookies, existing route bindings and audiences.
2. Add the new staff hostname to the existing staff Access application with its
   current policy and session settings. Do not replace allowed principals or
   create a broad allow/bypass policy. Reusing the application avoids requiring
   the Worker to trust an additional application audience solely for migration.
3. Add only the existing protected portal path shapes on `portal.ledgetop.app`
   to the appropriate Client application. Public share paths must remain outside
   a blanket human-login policy, while internal/service paths retain their own
   strict authentication. Review matching precedence before saving changes.
4. Add Worker Custom Domains: `ledgetop.app` to `ledgetop-ops`, and
   `portal.ledgetop.app` to `ledgetop-clients`. Those Worker names are from the
   current repository configs and must be compared with live deployment settings
   before applying. Do not add a competing origin CNAME first.
5. Validate TLS, existing owner sign-in, client sign-in, same-origin requests,
   origin/CSRF checks, Viewer renewal, legacy public links and downloads before
   changing generated URLs or enabling navigation redirects.
6. Enable narrowly scoped temporary navigation redirects. Keep API, POST,
   upload, signed URL, service callback and opaque-link paths on their reviewed
   transport until separately verified. Keep legacy hosts/certificates/Access
   applications serving for compatibility. Rollback disables canonical behavior
   and removes only the new bindings/destinations; it does not remove old hosts.

Cloudflare's current [Custom Domains documentation](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
states that Worker Custom Domains manage the DNS record and required certificate.
The current [self-hosted application documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
describes public-hostname/path destinations for Access. This proposed sequence
has not been executed and is not evidence that a new hostname is protected.

Do not delete legacy domains, public-link records, policies or certificates as
part of this initial connection. Existing client links are the compatibility
contract, not disposable migration artifacts.
