# Stage owner native adoption (source candidate, not runnable)

`scripts/stage-owner-native-adoption.mjs` adopts one **existing** Stage
Operations staff owner, `staff-beau-koltz`, into native identity. This is not
new-staff onboarding.

## What it writes

The module makes one atomic D1 batch on the pinned Stage database. The batch writes:

- one `native_staff_admissions` row, copied from the current `staff_users`
  row (`bound_access_subject = access_subject`, `active = 1`,
  `admitted_by = staff-beau-koltz`);
- one `native_staff_profiles` row (`login_email = email`,
  `display_name`, `version = 1`);
- one immutable approval row and one immutable receipt row, in the existing
  0060 `native_staff_bootstrap_approvals` / `_receipts` tables. The plan kind
  is `operations-stage-owner-native-adoption-v1`.

It writes nothing else. There are no grants, delegations, memberships,
ceilings, ACL rows, usernames or logs-device eligibility.

## What it does not change

- `native-staff-bootstrap-d1.mjs` (v1), the cutover and owner-approval tools,
  and their distribution and package pins are unchanged. Only the
  management-batch compiler is imported.
- This module does not use the v1 control-plane requirement, the 225-migration
  digest or the v1 consent phrase, and it does not accept v1 plans.
- No Worker or HTTP route can reach it. There is no self-grant path.

## Guards

- **Migrations:** the current-main migration chain is pinned. That is 235 files
  ending at `0243_staff_logs_device_eligibility.sql`, with names and contents
  SHA-256 in `STAGE_OWNER_ADOPTION_MIGRATIONS`. The database's `d1_migrations`
  ledger must equal the chain exactly.
- **Schema:** the full `sqlite_schema` is fingerprinted, including tables,
  views, indexes and triggers. The fingerprint is bound into the plan and the
  consent.
- **State CAS:** the CAS covers all legacy ACL tables, all authority-wide
  native tables, and every row in any table that references the target.
  It is checked twice: first by a read-only probe, then by guards inside the
  write batch that abort it. `staff_users.last_seen_at` is the only exemption,
  the same as the bootstrap installer; it stays in the schema fingerprint.
- **Identity:** the target must be active and have an access subject. It must
  not already have native rows, and its subject and email must not already be
  bound to another staff member.
- **Live owner identity:** an injected `verifyOwnerIdentity(token)` must
  verify the token and return exactly `{staffId, email, accessSubject}`
  matching the current `staff_users` row. The token is checked at prepare,
  and a **fresh** token is required again at execute. Tokens are never stored.
- **Consent:** a closed envelope binds the action, purpose, environment,
  account, database, target, owner email and subject, migration digests,
  schema digest, snapshot digest, plan digest, approval ID, command ID and
  window, plus a purpose-specific phrase. An injected `verifyConsent` must
  return `true` for it. Consent is checked at prepare and again at execute.
- **Window and replay:** the window may be at most 60 minutes. It is checked
  in JS and again by the D1 clock in the gated approval insert. Reused
  approval or command IDs are refused. A replay fails the CAS because the
  target is no longer pre-adoption.
- **Durable readback:** after commit, the approval, the receipt and both rows
  are re-read and compared exactly. A mismatch reports
  `commit_outcome_uncertain`, not success.

## Missing inputs (it refuses until all exist)

1. **Stage D1 database ID.** `STAGE_PINS.databaseId` is all-zero, so every
   entry point refuses with `stage_pins_unprovisioned`. Merger provides it
   from independent readback. The account ID is
   `df3f376bae6ee621f50cf972ebcc9484`, as Merger supplied it.
2. **Owner-identity verifier.** This must be real Access JWT verification:
   signature against the team JWKS, issuer, Stage application audience and
   expiry, mapped to `{staffId, email, accessSubject}`. It does not exist
   yet. The operator can prepare it from independent readback; Beau does not
   need to type IDs or run key tools.
3. **Consent trust.** This is a reviewed trust key or signer for the consent
   envelope, plus a hash-bound owner consent. It is a future explicit review
   input and is not created here.
4. **`roles.manage` readback.** This remains a precondition owned by Merger,
   outside this module.
5. **Transport.** `submitBatch(request, {accountId, databaseId})` performs
   exactly one D1 batch call, with no retry, to the pinned target. No
   transport ships here.

The owner decision channel belongs to Merger. This candidate does not open a
Hub decision or question.

## Tests

`apps/operations/test/stage-owner-native-adoption.test.ts` uses Miniflare
with the full current migration chain and only synthetic pins, identities and
keys. It covers:

- the source pin and ledger mismatch;
- unprovisioned or mismatched pins;
- missing verifiers;
- fixed-purpose plan tampering (grants, extra rows, email or subject change,
  wrong target or database, the v1 kind);
- identity mismatch (staff ID, email, subject, extra claims, forged token);
- consent tampering and the wrong signer;
- expired, not-yet-valid and over-long windows;
- the token not being retained and a fresh token being required;
- CAS refusal on status, email, subject and ACL drift;
- full rollback when a later write fails;
- the D1 clock gate;
- success with a `last_seen_at` refresh;
- immutability;
- replay refusal.
