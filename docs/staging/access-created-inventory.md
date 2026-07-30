# Staging Access created inventory

Created on 2026-07-30 in Cloudflare account
`846c924bf17bf4f3dd15c97a4c5d1d51`.

The temporarily broad API token was used only after token status, Access
application listing, and DNS-record read for `ledgetopdroneservices.com`
succeeded. Earlier attempts were blocked because that DNS-record read returned
Cloudflare authentication error `10000`.

## Applications

| Application | ID | Audience | Domain | Session | Launcher |
| --- | --- | --- | --- | --- | --- |
| LTDS Delivery Staging | `2ef49026-12ac-4e5a-a354-4843b8b01249` | `f6942c97e306d81d206c94746dc731413d5e59461b35d9b213f13fdf96b62835` | `delivery-staging.ledgetopdroneservices.com` | 1 hour | hidden |
| LTDS Operations Staging | `8689176a-df0a-44b4-ac4f-caae5cd12d08` | `e5e2026896677c6fbaa0c7eb9b795e326516c15a3191dfba3c2ad43da4728671` | `ops-staging.ledgetopdroneservices.com` | 1 hour | hidden |
| LTDS Ops Sync Staging | `30d86d9e-7da4-476f-bc2e-ecb9debccf29` | `7b578ad388abb5c5eb550e86ddf3263af0b2a5694e8bf4810c67affa5721ec37` | `ops-sync-staging.ledgetopdroneservices.com` | 1 hour | hidden |

## Policies

| Application | Policy | ID | Decision | Subject |
| --- | --- | --- | --- | --- |
| Delivery | LTDS Delivery Staging - Initial Tester | `acb50f64-c99e-41a5-8bae-08428bd2939c` | Allow | one verified Access email |
| Operations | LTDS Operations Staging - Initial Tester | `ead911a7-833a-40d3-80a6-2de9368a909b` | Allow | one verified Access email |
| Ops Sync | none | — | default-deny | staging service token not created |

The human identity had a recorded successful Access login before the policies
were created. The email is intentionally omitted from this tracked inventory.

## Verification and boundaries

- All three applications re-listed with type `self_hosted`, the exact staging
  domain, one-hour sessions, and launcher visibility disabled.
- Delivery and Operations each have exactly one Allow policy with an explicit
  email selector.
- Ops Sync has no policy and therefore remains default-deny until a separate
  staging service-token decision.
- The three staging hostnames each had zero DNS records after creation.
- No DNS record, Worker route, Worker version, service token, production Access
  application/policy, secret, migration, or feature flag was changed.

Put the audiences only in ignored local staging Wrangler configs:

- Delivery `POLICY_AUD`;
- Operations `OPERATIONS_AUD`;
- Ops Sync `CF_ACCESS_AUD`.

## Credential follow-up

The broad API token was not copied or persisted by this task.

A later read-only validation attempt on 2026-07-30 returned HTTP 401 for the
credential in the authorized local file. Treat that credential as invalid or
revoked; do not rely on it for release automation.

If future staging work needs a replacement token, restrict it to:

- account `846c924bf17bf4f3dd15c97a4c5d1d51`;
- `Access: Apps and Policies Edit`;
- `DNS Read` for zone `ledgetopdroneservices.com`.

Do not retain unrelated full-account permissions for later staging work.
