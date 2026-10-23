# Independent employees and shared clients: staging acceptance

Ops owns Ops employees. Each Project Alpha owns its own people. A PA user, role,
entitlement or matching email must not create, edit, disable or grant access to an
Ops employee. Client profiles remain shared only across explicitly connected PA
destinations. Quotes, contracts, invoices and financial records remain PA-owned.

## Repeatable dummy dataset on this PC

From the repository root:

```powershell
npm ci --prefix apps/operations
node scripts/independent-staff-client-acceptance.mjs
```

The runner uses the locked Operations Vitest/Miniflare dependencies, applies the
repository's complete Operations and Client migration sequences to fresh local D1 databases,
and calls the actual Sync projection handlers. It has no remote mode, does not
load Cloudflare credentials, does not persist its database, and disposes its
runtime on completion. An extra CLI argument is refused. No real client files,
email delivery, production records or TrueNAS access are involved.

The editable synthetic dataset is
`scripts/fixtures/independent-staff-client-dataset.json`. Its email addresses use
the reserved `.invalid` domain:

| Record | Purpose |
| --- | --- |
| Synthetic Ops Employee | Local employee whose email is deliberately reused in PA entitlement events |
| Synthetic Admin | Explicit synthetic delegations/ceilings that satisfy the surviving control-plane administrator guard |
| Synthetic Drone Client | LTDS copy only |
| Synthetic Technology Client | LTT copy only |
| Synthetic Shared Client | Separate source-bound copies in both PAs |

The checks compare complete employee/profile-role-control tables and desired
Access-group email lists before and after PA entitlement events, including both
grant and revoke payloads for each source. The primary ingress ignores employee
events; the secondary employee ingress remains explicitly unsupported. Both must
leave Ops employees and their access unchanged. The native employee command
service changes the dummy display name, rejects a stale edit, replays a command
without a duplicate receipt, and disables/re-enables the dummy admission while
the PA reference and client-command outbox tables remain unchanged.
They assert that the three client cases create exactly four source-bound copies,
that colliding external IDs cannot overwrite another PA's copy, and that a
subsequent update from each source reaches the correct copy. A final foreign-key
check verifies the resulting local database.

This is a local service acceptance test. It proves inbound projection isolation;
it does not itself establish real PA network delivery, the user-facing employee
management UI, Cloudflare Access sign-in or a deployed staging release.

## Client edit fanout regression checks

Run the existing actual writer/composer/dispatcher suites as a separate local
check (their PA HTTP responses and authority fixtures are controlled test data):

```powershell
npm --prefix apps/operations test -- test/native-directory-shared-profile.test.ts test/shared-profile-correspondence-composer.test.ts test/shared-profile-portal-dispatcher.test.ts
```

These exercise a shared client revision with two queued PA commands, portal
profile edits across logical PA destinations, transaction rollback and current
authority checks before dispatch. Passing these checks is local evidence, not a
claim that either real PA was changed.

## Interactive synthetic lab

```powershell
node scripts/independent-staff-client-lab.mjs
```

Open `http://127.0.0.1:8789/`. The developer panel lets you edit the dummy Ops
employee, disable/re-enable native admission, submit a PA employee revocation
for the same email, and simulate client projections for the fixture's selected
PA destinations. The panel uses the actual command/identity/projection services,
fresh canonical schemas, and temporary data. Restarting discards all changes.
It does not connect to either PA server or test outbound delivery. Its known
synthetic actor is test configuration, never a production bootstrap procedure.

While the lab is running, verify its HTTP boundary and workflows with:

```powershell
node scripts/independent-staff-client-lab-smoke.mjs
```

The listener is fixed to loopback, validates Host/Origin and a per-run API token,
and refuses unknown targets. For an isolated copy on the staging server, keep
the remote listener on loopback and use an SSH tunnel on the same local port:
`ssh -N -L 8789:127.0.0.1:8789 bkoltz@192.168.50.90`. Stop any local lab first.
Never publish this fixture panel through a public route or mount its synthetic
actor in the normal Operations router.

## Cutover boundary

PA snapshot/event code no longer writes Ops employee identity, roles, divisions
or activation. Existing staff rows, subject bindings and grants are preserved.
PA user projections remain reference data for historical business records.
PA-triggered and scheduled Access-group replacement are retired; the existing
Cloudflare group is left unchanged. The Ops-local candidate email query is a
helper only and is not automatically applied to the group. Review the exact
membership delta before activating a separate native admission reconciler.

The production-compatible login path still reads `staff_users`; native commands
edit native profiles/admissions. Therefore disabling native admission in this
lab proves native identity refusal, not revocation of the deployed legacy login.
Finishing that login/authorization/Team-UI migration and live PA fanout remains
a separate release gate. The lab is a testable service slice, not full employee
administration in the production dashboard.

## Live staging test sequence

After a reviewed staging deployment, repeat these actions with newly created
synthetic records and the normal authorized staff session. Do not import this
fixture into production, reuse a real customer's email, or grant test users real
folders. The `.invalid` addresses are intentionally undeliverable: a real portal
sign-in check needs a separately authorized test identity with an inbox the owner
controls. Do not treat the local fixture as a way to bypass Access sign-in.

1. Add an Ops-only employee through Ops. Confirm no PA staff record is created.
2. Create/change/disable a synthetic PA user independently in each staging PA;
   confirm the Ops employee's name, active state, roles and permissions remain
   unchanged. Also test a PA user with the same synthetic email as the Ops user.
3. Create the LTDS-only and LTT-only clients from Ops with their respective
   selected destination. Confirm the unselected PA has no new client.
4. Create the shared client with both selected destinations. Edit it in Ops and
   confirm both PA profiles converge after the normal outbox drain.
5. With an explicitly authorized synthetic portal identity, edit that client's
   own shared profile. Confirm the same two destination profiles converge.
6. Revoke that test identity's profile-edit access. Confirm further edits are
   denied and no PA command is sent. Existing public links must remain usable.

Record the exact candidate commit, staging Worker versions, synthetic record
identifiers and outcomes separately. The read-only staging machine MCP cannot
perform these writes or access grants; use the existing authorized human staging
workflow. Local execution alone must not be reported as a completed live test.
