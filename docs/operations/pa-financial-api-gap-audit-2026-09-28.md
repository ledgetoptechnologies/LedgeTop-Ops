# Project Alpha financial portal API gap audit

Date: 2026-09-28
Status: bounded source audit; design input only
Implementation status: no financial endpoint, permission, binding, schema, or
runtime setting was added or approved by this audit.

## Scope and source state

This audit answers one narrow question: which Project Alpha (PA) read surfaces
can support a future Client financial summary and existing action links, and
which generic contracts are still missing? It is not a vulnerability audit and
does not authorize deployment, data migration, permission changes, or use of
production credentials.

The newest locally cached `origin/main` inspected was
`1513b6a860a045e1a22e916e282699dea5ce2469`, checked out cleanly at
`C:/Projects/Project-Alpha/.codex/worktrees/pa-portal-eligibility-api`. This is
cached repository state, not a live fetch and not evidence of the version
deployed in production. The separately implemented read-default change was
inspected at
`C:/Projects/Project-Alpha/.codex/worktrees/pa-read-defaults` at
`56b0f7ae66119336933960e0d37f472ec2f5d16b`; that worktree was also clean.
The two commits have the same relevant router, capability-helper, and
read-default test bytes, but `56b0f7ae` is a parallel commit rather than an
ancestor of `1513b6a8` (their merge base is `c3f2ad52`).

`C:/Projects/Project-Alpha/.codex-worktrees/main-release` was also inspected,
but its local `main` was stale at
`2d8820d6c1ea21ac3f328d248781f00f314c133d` and was not used as the final
release-source authority.

The primary checkout `C:/Projects/Project-Alpha` was not treated as release
authority: it was on `codex/dev-recurring-expenses` at
`b847852bd33055e71a6dc94f80bdd6d78da5baaa`, with pre-existing changes to
`.phpunit.cache/test-results` and `database/baseline.sql` and untracked
`.codex/` and `.worktrees/`. Those files and every PA checkout were preserved.
Any observation first found there was rechecked against the clean cached
`origin/main` checkout before being recorded below.

No database-backed tests were run. No checkout, fetch, commit, push, runtime
configuration, credential, or production/staging setting was touched.

## Critical routing distinction

The approved default-enable boundary is **six read-only API-v2 feature groups**.
It is not the six older `api-*` list/summary routes.

In cached `origin/main` (and identically in `pa-read-defaults`),
`api_v2_enabled()` defaults exactly these six
flags on when the corresponding environment variable is absent, while honoring
an explicit `false`:

1. `APP_API_V2_DIRECTORY_READ_ENABLED`
2. `APP_API_V2_BINDING_STATUS_ENABLED`
3. `APP_API_V2_DIRECTORY_INVENTORY_ENABLED`
4. `APP_API_V2_PROJECTS_READ_ENABLED`
5. `APP_API_V2_PROJECTS_BINDING_STATUS_ENABLED`
6. `APP_API_V2_PROJECTS_INVENTORY_ENABLED`

Source: `src/utils/api_v2_capabilities.php:25-41`. The advertised read routes
and exact scopes are defined independently at
`src/utils/api_v2_capabilities.php:48-64,106-110,136-140`, and the router gates
them separately at `public/index.php:21-37,46-64,127-132`. The source test enumerates
the same six flags and proves explicit false suppresses them at
`tests/Workflows/ApiV2ReadRouteDefaultsTest.php:7-16,46-60,134-143`.
`docs/admin/api-v2-application-key-binding.md:75-79` records that these reads
still require application binding and exact scopes. Default-on is route
availability, not caller authorization.

Separately, cached `origin/main` retains an older front-controller family controlled
by installation-wide `APP_API_ENABLED`. It authenticates an API key, derives a
legacy scope, and dispatches dashboard/list controllers at
`public/index.php:426-460` (authentication at `:437-439`, mapping at
`:442-456`). Its six familiar entries—dashboard summary,
financial summary, invoices, quotes, projects, and clients—are **not** the six
user-approved API-v2 defaults. They are existing internal APIs and are not
reported here as newly discovered security vulnerabilities. They are simply the
wrong contracts for a customer portal.

Future finance work must not broaden either boundary by quietly adding finance
to one of the six API-v2 read flags or by relying on the legacy global
`APP_API_ENABLED` switch.

## Existing financial reads: legitimate internally, unsuitable for Client use

Cached `origin/main` confirms the legacy scope catalog still provides
`financial.read` and `invoices.read` in
`src/utils/api_scopes.php:181-185,201-205`.
API-key authentication checks key state, optional source-IP restrictions,
required scope, and rate limits in `src/utils/api_auth.php:75-121`; it deliberately
does not synthesize an interactive administrator session at `:122-133`.

The current controllers are intentionally broad internal projections:

- `src/controllers/api/financial_summary.php:8-34` computes installation
  revenue, paid-invoice totals, expenses, and profit for a trailing-day window.
  It is not a Client account balance and has no exact billing-entity/principal
  binding, document-recipient policy, currency grouping, revision, or freshness.
- `src/controllers/api/invoices_list.php:7-29` filters by exact stored status and
  returns a shallow invoice list. It omits stable public document identity,
  project/contract relationship, due and collection semantics, currency,
  partial payments, credits, refunds, reversals, recipient policy, and action
  link state.
- API-key service principals receive the historical global read projection via
  `acl_user_has_org_wide_scope()` in `src/utils/acl.php:170-183`; consequently
  `scope_clause()` returns no creator constraint at `:214-221`. An API key scope
  is therefore not an individual customer's financial authorization.

The inspected cached `origin/main` API controller directory has no generic contract
read or payment read endpoint. The API-v2 read-default implementation covers
Directory and Project reads/binding status/inventory only; its capability
definitions contain no finance scope or endpoint
(`src/utils/api_v2_capabilities.php:48-142`). A portal-ready financial contract
is therefore missing from both inspected source states.

## Authority that can be extended, but not inferred

PA already has useful explicit identity and scope primitives:

- `database/migrations/0062_client_portal_foundation.sql:91-121` stores explicit
  principal-to-client relationships and issuer/subject identity bindings.
- The same migration defines organization- and project-scoped entitlement
  records at `:123-164`.
- `database/migrations/0066_generic_portal_v2_integration.sql:45-68` represents
  allow/deny entitlements at workspace, organization, standalone-client,
  department, client, and project scopes.
- `docs/portal-v2-integration.md:68-86` requires explicit profile/workspace
  allowlists, scoped reconciliation, deny/revocation handling, and no implicit
  installation-wide association.
- `docs/admin/external-operations.md:115-125` says portal eligibility is not
  identity or content authority and that contact relationships do not
  grant access and explicitly forbids inferring an identity binding from email,
  name, address, CRM contact, primary contact, or public link.

Those records do not currently define billing visibility. The allowed v2 portal
capabilities in `database/migrations/0068_portal_contract_completeness.sql:7-11`
contain no `viewBilling` equivalent. Organization, department, project, portal
membership, and individual billing-recipient authorization must remain distinct.

## Existing public-link read primitive and unsafe higher-level helpers

PA's public links and financial-email behavior must remain PA-owned and intact.
Cached `origin/main` now contains a narrow, side-effect-free repository primitive:
`pa_public_link_active()` performs one `SELECT` for the newest row-level
non-revoked, non-time-expired document link and returns its ID, token, expiry, and
`expire_when_paid` state (`src/utils/public_links.php:36-66`). This helper is a
valid foundation for the existing-link lookup phase. It is not by itself a
portal contract: it does not authorize a principal, validate the billing-entity
or document binding, apply recipient visibility, or construct and validate an
allowlisted absolute URL. It also does not evaluate whether the document is now
paid, cancelled, void, denied, signed, completed, or otherwise terminal.
`pa_public_link_terminal_reason()` is itself read-only and derives several of
those document states (`src/utils/public_links.php:133-190`), but the existing
mutation path applies additional general-recipient paid-receipt timing behavior.
A future read composition must reproduce the complete effective document/link
policy with pure reads; `pa_public_link_active()` plus a null terminal reason is
not a blanket authorization rule.

The higher-level status/create/email helpers are not safe summary reads:

- `pa_public_link_status()` calls `pa_public_link_terminalize()` before reading
  and invokes schema-maintenance logic in
  `src/utils/public_links.php:268-297`.
- Terminalization updates revocation, redirect, and expiry state in
  `src/utils/public_links.php:192-262`.
- `src/controllers/public_link_create.php:63-187` validates/finalizes documents,
  may create or alter schema, revoke or upgrade links, reuse a link, or create a
  new one.
- The document email path calls `pa_public_link_reuse_or_create()` and therefore
  creates a new token when none is active
  (`src/controllers/email_send.php:116-132`; mutating helper at
  `src/utils/public_links.php:68-130`). It is an email command path, not a
  summary-read repository.

Therefore `pa_public_link_active()` may be reused behind new independent
authorization and URL-policy checks; `pa_public_link_status()` must not. A
financial summary must never call a reuse-or-create, terminalization,
schema-ensure, renewal, revival, or email path.

## Required generic, default-off contract work

The minimum future PA work is:

1. Add a separately reviewed, default-off financial API-v2 feature family and
   exact read scopes. Do not attach it to any of the six approved default-on
   flags and do not expose it through legacy `APP_API_ENABLED` by default.
2. Add permanent, explicit bindings from an Operations organizational unit to
   the exact PA instance and billing entity. Never match by label, name, email,
   address, or deployment branding.
3. Add an independent per-principal billing-recipient allow/deny policy. Apply
   exact recipient and document authorization on every read; organization,
   department, and project membership alone is insufficient.
4. Add bounded contract, invoice, and payment read DTOs/cursors with stable
   public IDs, source revisions, `asOf`, currency, finalized/draft state,
   direct-versus-monthly rollup semantics, due/overdue derivation, partial
   payment, credits, refunds, reversals, and outstanding balance. Never count a
   monthly rollup and its child charges twice or combine currencies implicitly.
5. Wrap the existing pure `pa_public_link_active()` repository primitive in a
   new pure effective-state, authorization, and presentation phase. It must
   account for terminal document policy (including the bounded
   general-recipient paid-receipt case) and return unavailable for missing,
   revoked, expired, terminal, mismatched, or unauthorized links. Expose a URL
   only after exact recipient, document, billing-entity, configured scheme/host,
   and allowlisted path checks. Do not call the similarly named mutating helpers.
6. Keep link create/renew/revive/send as separate PA-authorized commands with
   their existing approval, idempotency, audit, lifecycle, and email ownership.
   Portal reads must not duplicate PA financial email.
7. Define revocation and offline behavior: a current deny wins over cache; stale
   summaries carry `asOf` and disable actions; unknown is not zero; a browser
   return does not prove payment or settlement.

This work should stay generic and open-source: stable capability identifiers,
resource kinds, and binding keys—not customer, product, business, or deployment
labels. No finance endpoint or new permission is implemented by this document.

## Relationship to the unified portal proposal

The proposed DTO and policy remain in
`docs/operations/unified-portal-feature-contracts.md:258-319`. This audit supplies
the PA source evidence for that proposal; it does not turn the proposal into an
approved or implemented contract.
