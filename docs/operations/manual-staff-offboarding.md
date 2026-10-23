# Manual Operations offboarding before native cutover

Use this temporary procedure while the native staff readiness control is absent
on the known pre-0225 schema, or its singleton is explicitly disabled. PA user
changes no longer disable Operations users. An administrator must complete and
verify this procedure for each Operations departure until the reviewed native
management cutover replaces it. This procedure does not change PA people or
client records.

After cutover is enabled, use the joined native `/api/native-staff/:staffId/disable`
command with its current version, authorized delegation and CSRF protection.
Do not directly edit compatibility rows after cutover. An unexpectedly missing
0225 table after a known cutover is an incident, not permission to return to this
procedure. Preserve that schema and restore or repair it through a reviewed
maintenance operation; the legacy missing-table fallback cannot itself remember
that cutover once happened.

## Prepare the exact change

1. Record the authorized operator, reason, target staff ID, exact existing email
   and bound Access subject, environment/account/database, and current status in
   a private change record. Read the primary database, not an old Team screen.
   Match all three identifiers to the reviewed departure. Refuse ambiguous or
   unbound identities. Do not publish this record or credentials in Git/EH.
2. Confirm the cutover state, a usable separate administrator remains, and the
   target is neither the configured protected owner nor a global `role-owner`
   in either `staff_role_assignments` or `local_staff_role_assignments`.
   Owner succession is a separate reviewed recovery operation. Retain the
   target's existing permissions, role assignments, historical work and audit
   records. Do not delete the employee or reassign their subject/email.
3. Identify the exact managed Cloudflare group by configured ID and, when
   configured, its expected name. Record its existing include, exclude and
   require rules privately. Inspect every policy allowing staff access; another
   email/domain/group rule can still admit the person at the edge. Scope any
   policy removal to that employee and the affected staff applications.
4. Serialize this maintenance with other staff changes and retain a verified
   restorable checkpoint. Use the existing authorized D1 operator connection;
   this document does not supply or expand its credentials. Do not enable native
   readiness, invent an admission, remove a schema guard, or edit PA to accomplish
   Operations offboarding.

## Deny locally, then revoke at the edge

First mark the exact compatibility row inactive and protect it from historical
PA sync. The reviewed statement is:

```sql
UPDATE staff_users
SET status='inactive', sync_protected=1, updated_at=datetime('now')
WHERE id=:staff_id AND email=:email COLLATE BINARY
  AND access_subject=:access_subject AND status='active'
  AND id<>:protected_owner_id
  AND NOT EXISTS (
    SELECT 1 FROM staff_role_assignments r
    WHERE r.staff_id=staff_users.id AND r.role_id='role-owner' AND r.scope='global'
  )
  AND NOT EXISTS (
    SELECT 1 FROM local_staff_role_assignments r
    WHERE r.staff_id=staff_users.id AND r.role_id='role-owner' AND r.scope='global'
  );
```

Bind the four reviewed values through the authorized parameterized maintenance
connection. If using an operator's SQL console/file instead, have the operator
produce and review a private SQL-literal-escaped statement before executing it;
the named parameters above are not a paste-ready Wrangler command. Require
exactly one changed row. For zero changes, read the primary again and reconcile
the actual identity/status before deciding whether this was already completed.
For an unknown outcome, inspect first; never broaden the predicate or retry a
different identity. Do not change admissions or bootstrap proofs manually.

Read the primary again: the same ID/email/subject must now have
`status='inactive'` and `sync_protected=1`, with previous role/permission links
unchanged. Ordinary Ops requests and Viewer renewal require an active
`staff_users` row, so a still-unexpired Access assertion cannot override this
local denial. Capture this verification before proceeding.

Next remove the exact employee email from the reviewed staff group's include
rules using the normal Cloudflare group editor or approved reconciliation tool.
Preserve every unrelated member and all exclude/require rules. Read the group
back by the same configured ID/name and verify the target is absent. Remove any
other staff policy entitlement identified during preparation. Do not replace
the group with an empty list or revoke other employees to make the test pass.

Finally revoke that user's existing Cloudflare Access sessions. The current
[Cloudflare session-management procedure](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#revoke-user-sessions)
provides per-user revocation under Zero Trust users. Review the exact user and
account before confirming: per-user revocation affects their Access sessions
across that account. A logout link alone is not administrative offboarding,
and session revocation alone does not remove their future policy eligibility.
Do not disable an unrelated shared identity-provider account merely to revoke
Operations access.

## Verify and close

- Verify a protected Ops request made with the departed user's prior assertion
  is denied and no new Viewer renewal is issued. Use an already authorized
  controlled test session; never request or copy the employee's password/token.
  If no such session is available, record that test as unperformed and keep the
  incident/change open until independently verified.
- Verify a new sign-in cannot reach staff content, the group readback remains
  correct after the next normal synchronization observation, and the primary
  row stays inactive/protected. Do not re-enable PA workforce synchronization.
- Confirm the remaining administrator still works. Keep the private operator
  receipt with timestamp, row-change count, group/policy readback, session
  revocation outcome and denial evidence. EH receives only redacted completion
  status and the private evidence reference.
- Already downloaded files and in-flight response bytes cannot be recalled.
  An existing separate Viewer session must be checked for its own revocation or
  expiry; blocking renewal does not prove that session was immediately ended.
  Do not claim full offboarding while any required independent access test is
  outstanding.

Cloudflare errors or unavailable verification do not justify restoring the local
active status. Leave the person inactive, keep the change pending and reconcile
the failed edge step explicitly. Re-enabling later requires its own authorization
and a reviewed identity/native-handoff plan; do not blindly replay the old row.
