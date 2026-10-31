# Production Client migration 0242 one-shot operator

This operator is a separate, fixed-target path for the single migration
`0242_client_ops_triage_inquiries.sql`. It does not amend the held
`client-0242-targeted-v1` compiler or claim that compiler authorizes production
DDL. The compiler's `held`, `authorizesMigration:false`,
`authorizesFeatureActivation:false`, and `applicationReady:false` fields remain
unchanged and are asserted by the operator.

## Scope and safeguards

- Fixed Cloudflare account `846c924bf17bf4f3dd15c97a4c5d1d51`, production
  Worker `ledgetop-clients`, binding `DELIVERY_DB`, and D1 database
  `7f40a7b7-c3ec-470e-a626-e798867f71f8` (`client-data`). The live settings and
  D1 identity are reread during each phase; an environment or binding mismatch
  stops before the migration request.
- The source migration commit must be an ancestor, the checkout must be clean,
  and `HEAD` must equal locally fetched `origin/main`. Either the `main` branch
  or a detached checkout at that exact commit is accepted; feature branches
  are refused. The operator does not fetch; refresh and verify `origin/main`
  before invoking it.
- The full API-returned `settings.bindings` metadata is normalized and hashed
  at preparation, before execution, and after the migration. The inquiry gate
  must be absent or literal `false` at preparation and execution. Cloudflare
  withholds secret values, so only returned binding metadata can be hashed and
  compared.
- Prepare and execute are separate. Prepare makes read-only calls and writes a
  short-lived private snapshot, exact body and receipt. Execute requires the
  exact prepared receipt SHA, an unexpired packet, a clean current-main checkout and
  a fresh exact metadata/binding match.
- The only mutating call is one Cloudflare D1 REST `/query` batch containing
  the transaction guard, pinned 0242 DDL and ledger ID 159. A durable intent is
  written first. The request is never retried. An uncertain response is
  reconciled with metadata readback; an unchanged or divergent state is held
  for manual reconciliation and cannot be replayed by this artifact.
- Postflight requires all 158 prior ledger identities and all old schema
  objects to remain unchanged, the exact five migration objects and one 0242
  ledger row to be added, and no application rows in the two new tables.
  Pending 0235, 0236, 0239 and 0241 remain pending. Any other ledger/schema or
  binding delta is a hold.
- No Worker setting, code, deployment, feature flag, notification state, Ops
  database, identity, grant or application record is modified. This code does
  not authorize execution; any production invocation still needs the
  independently reviewed current release decision and explicit operator action.

The production REST batch mechanics were previously tested on a disposable
synthetic D1 and deleted with a 404 readback. That evidence is limited to
transport transaction behavior. This operator is not a substitute for a fresh
production baseline, current release review, or readback after execution.

## Invocation contract

From a clean, current `main` checkout, `--prepare` performs fresh read-only
ownership, database identity, ledger, schema and parent-key checks. Review its
private receipt and exact request-body hash. Only an explicitly reviewed hash
can be passed to `--execute --prepared-sha256 <hash>` within the ten-minute
window. The operator's runbook output is intentionally minimal; detailed
metadata snapshots and state receipts are stored in the private one-shot
artifact directory.

Do not use ordinary Wrangler `d1 migrations apply` for this targeted append:
the current pending set contains four earlier migrations. Any later migration
inventory or apply operation requires separate review of the exceptional
0242-at-ID-159 history.
