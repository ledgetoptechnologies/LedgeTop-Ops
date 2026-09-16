# Staging Access created inventory

Created on 2026-07-30 in Cloudflare account
`846c924bf17bf4f3dd15c97a4c5d1d51`.

The temporarily broad API token was used only after token status, Access
application listing, and DNS-record read for `ledgetopdroneservices.com`
succeeded. Earlier attempts were blocked because that DNS-record read returned
Cloudflare authentication error `10000`.

## Applications

This is a historical pre-client-portal inventory, not evidence of live staging
Access state. No `Ledge Top Client Portal Staging` app,
`Ledge Top Client Public Staging` Bypass app, or dedicated client staging group was
created in this step. The historic Delivery staging audience must not be used
as `CLIENT_ACCESS_AUD`.

| Application | ID | Audience | Domain | Session | Launcher |
| --- | --- | --- | --- | --- | --- |
| Retired Delivery staging app | retired (do not reuse) | retired (do not reuse) | `delivery-staging.ledgetopdroneservices.com` | 1 hour | hidden |
| Retired Operations staging app | retired (do not reuse) | retired (do not reuse) | `ops-staging.ledgetopdroneservices.com` | 1 hour | hidden |
| Retired Ops Sync staging app | retired (do not reuse) | retired (do not reuse) | `ops-sync-staging.ledgetopdroneservices.com` | 1 hour | hidden |

## Policies

| Application | Policy | ID | Decision | Subject |
| --- | --- | --- | --- | --- |
| Delivery | Retired initial tester policy | retired (do not reuse) | Allow | one verified Access email |
| Operations | Retired initial tester policy | retired (do not reuse) | Allow | one verified Access email |
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
