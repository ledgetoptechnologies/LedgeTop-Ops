# Production Ops onboarding approver grant (one-shot)

Migration 0242 lets an onboarding approval through only when the approver has a current
global allow delegation for `staff.onboarding.approve` in
`native_staff_management_delegations` (contract_version 1). The same check is
`APPROVAL_SCOPE` in `apps/operations/src/worker/native-staff-onboarding-approval.ts`.
No application route writes that table, so production has no approver. The only other
writer is the whole-cohort native-staff bootstrap/cutover executor.

`scripts/production-ops-onboarding-approver-grant-once.mjs` writes that one row for one named
owner. It does nothing else.

## The row

| column | value |
|---|---|
| `id` | `ops-onboarding-approver-grant.<staff id>` (deterministic, so it can be reconciled) |
| `actor_staff_id`, `granted_by` | the target staff id |
| `contract_version` / `authority_domain` | `1` / `staff_admin` |
| `capability` / `effect` / `scope_kind` | `staff.onboarding.approve` / `allow` / `global` |
| `business_area_id`, `division_id`, `target_staff_id` | `NULL` |
| `active` / `version` | `1` / `1` |

`created_at` and `updated_at` use the column defaults. The row needs no ceiling: 0067
ceilings belong only to `staff.directory_grant.manage` and `staff.admin_delegation.manage`
parents. The management read model accepts a global staff-admin row with no scope ids.

## Target and safety

- Production Ops D1 only: `--database-id 6ebf7514-d306-4615-ae56-ad869c874dbd` and
  `--database-name ltds-ops`. These are pinned with the account as `OPS_PRODUCTION_DATABASE`. The
  name is checked again against the D1 metadata endpoint before any read.
- The token comes only from `CLOUDFLARE_API_TOKEN`. It is never printed or written down.
- The default mode is a read-only dry run. `--reconcile` is read-only too.
- `--execute` needs all of these:
  - `--approval-ref`
  - an unused absolute `--receipt` path (the file is created exclusively)
  - a clean `main` checkout equal to `origin/main` (`currentMainSource`)
  - an interactive terminal where you type the confirmation phrase
- The receipt holds counts, ids, the approval ref and the source commit. It holds no emails,
  access subjects or token.

## Checks

A read runs first and again right after the confirmation, before the write. The tool refuses
unless all of these hold:

- the ledger contains `0242_native_staff_onboarding_approval_actor_authority.sql`, and the
  capability is in the catalog;
- the staff user exists and is `active`, and has a global `role-owner` assignment;
- the user has an active native admission bound to their access subject, and a native profile
  whose login email matches;
- the user has no existing allow or deny row for the capability, and the delegation id is unused;
- the global approver count (active global allow rows) is exactly 0.

The write is a single `INSERT ... SELECT ... WHERE <the same conditions>` in one D1 batch. A
precondition that changes between the read and the write therefore inserts nothing
(`changes = 0`), and the run reports a refusal.

After the write, a read-back must show all of these:

- exactly the row above, one allow row for the owner and no deny row;
- a global approver count of 1;
- unchanged counts for `staff_users`, `staff_role_assignments`, `staff_permission_overrides`,
  `native_staff_admissions`, `native_staff_profiles`, `native_staff_delegation_ceilings` and
  `native_staff_admin_delegations`;
- `native_staff_management_delegations` up by exactly 1.

The write is never retried. If its outcome is unknown, the tool takes one read-only look and
records a classification (`granted-exactly`, `not-granted` or `unexpected`). Then it stops with
`reconciliation-required`. To check again, run `--reconcile`.

## Commands

Run these from a clean `main` checkout equal to `origin/main`, with `CLOUDFLARE_API_TOKEN` set
in the environment.

```sh
node scripts/production-ops-onboarding-approver-grant-once.mjs --dry-run \
  --target-staff-id <owner staff id> \
  --database-id 6ebf7514-d306-4615-ae56-ad869c874dbd --database-name ltds-ops

node scripts/production-ops-onboarding-approver-grant-once.mjs --execute \
  --target-staff-id <owner staff id> \
  --database-id 6ebf7514-d306-4615-ae56-ad869c874dbd --database-name ltds-ops \
  --approval-ref <approval ref> --receipt <absolute path to a new receipt file>

node scripts/production-ops-onboarding-approver-grant-once.mjs --reconcile \
  --target-staff-id <owner staff id> \
  --database-id 6ebf7514-d306-4615-ae56-ad869c874dbd --database-name ltds-ops
```

The confirmation phrase is
`GRANT staff.onboarding.approve TO <owner staff id> ON ltds-ops`.

Exit codes: 0 for `complete`, `dry-run-passed` or `reconciled`; 2 for `cancelled`; 1 for
anything else.

## Tests

```sh
node --test scripts/production-ops-onboarding-approver-grant-once.test.mjs
```

The tests build a disposable SQLite database from this repository's migrations. They reach it
through the real provider with a synthetic `fetch`. The tests show that:

- after the grant, a synthetic claimed onboarding passes the 0242 fence and receipt triggers and
  the `APPROVAL_SCOPE` review query (read from the source); before the grant, the approval is
  refused;
- the tool refuses a user who isn't an owner, is inactive or missing, or has no native
  admission; one who already has an allow or deny row; a second approver; a wrong database id,
  name or metadata; an execute without a terminal; and a missing approval ref or receipt;
- a dry run writes nothing;
- an ambiguous write is sent once and then reconciled.
