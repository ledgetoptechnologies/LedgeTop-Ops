# Client onboarding acceptance authority packet

This staging-only packet opens and closes the least-privilege native authority
needed for a positive client-onboarding acceptance. It is separate from the
Directory/Project acceptance packet and does not revise or erase that packet's
immutable approvals, receipts, or auxiliary migration ledger.

The provision phase requires an existing inactive staff admission, an existing
profile at the reviewed version, exactly zero active Directory grants, zero
active Project grants, one active selected business area, and no actor fences or
pending/leased Directory or Project work. It then:

- reactivates the reviewed admission;
- creates one durable `directory.profile.edit` allow scoped only to the selected
  business area, or reactivates that exact inactive row for a later packet; and
- records immutable, hashed plan and result evidence.

It does **not** reactivate the durable global profile-edit row left by earlier
staging packets. It does not create or reactivate `project.shared.sync`,
identity-link, enrollment-management, portal-access, staff-management,
integration, or workforce authority.

The revoke phase is generated before provisioning. It requires the exact prior
approval and receipt, the exact active admission and business-area grant, no
other active Directory or Project grants, and no actor work. It deactivates the
new grant and admission, revokes the provision approval, and records its own
immutable receipt. It never deletes authority or ledger rows.

The scoped grant identity is deterministic for the staff/business-area pair.
That matches the Directory grant table's unique scope identity and allows later
packet IDs to open a new bounded window without deleting history. Reactivation
requires the complete exact inactive row shape; an alternate ID, changed scope,
active row, or competing same-scope row fails closed.

## Generate and review

1. Copy `staging-onboarding-authority.json.example` to the ignored
   `.backups/staging-onboarding-authority.json`.
2. Read back the current inactive admission/profile versions, exact bound Access
   subject, and active staging business-area ID. Never place an Access token or
   cookie in the values file.
3. Keep the window at four hours or less and generate both phases before apply:

```powershell
npm.cmd run staging:onboarding-authority:generate
npm.cmd run staging:onboarding-authority:revoke:generate
npm.cmd run staging:onboarding-authority:check
npm.cmd run staging:onboarding-authority:revoke:check
npm.cmd run staging:onboarding-authority:test
```

The generator pins the exact staging account, `ltds-ops-staging` D1 binding,
and current 140-file canonical Operations migration chain. Generated SQL,
manifests, and Wrangler configs are ignored and must remain operator-private.
Apply only the generated one-file provision configuration. Immediately after
the acceptance, disable the acceptance routes and apply only the generated
one-file revoke configuration. A failed exact-state guard is a stop condition;
do not weaken it or use raw SQL as a fallback.
