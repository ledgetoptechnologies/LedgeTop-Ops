# Client and portal goal completion audit — 2026-09-08

This is a point-in-time completion audit for the unified Operations and Client
Portal goal. It reconciles the current Operations `main` implementation at
`193cae069d9e88e9095ce23ba5249f8c3a1eba53`, Project Alpha `main` at
`1b52773c2eb8361fcbbc1b3bcbc767a16a8f539d`, and read-only production checks
performed on September 8, 2026. It does not replace the feature-specific
security and rollout documents linked below.

## Current conclusion

### September 8 maintenance-release follow-up

PR #41 was merged into Operations `main` as
`2fa63bdadfca69b97ea7b9212a0e8c2f7fa3ffd6`. All ten PR and main CI jobs
passed, including both Client and Operations desktop/mobile browser suites.
The table's original Client CI gap below is therefore closed. Main evidence:
https://github.com/ledgetoptechnologies/LedgeTop-Ops/actions/runs/34291302236.
Cloudflare deployment readback confirmed 100% traffic on Operations version
`8d46c0f4-8679-411e-848a-c07a3315e590`, Client version
`bf068857-9762-4787-8a01-2e1477782597`, and Ops Sync version
`a79827e1-c76b-4265-8c7a-ecee9d5d7b0d`.

A subsequent fresh browser reload of the LTDS organization workspace still
reported `Automatic workspace pending` and `Portal eligibility enabled —
workspace not linked`. Business synchronization reported healthy, with its
last success at September 8, 08:21 local time. This is direct evidence that
healthy business ingestion does not yet prove default-on portal provisioning.
Both Project Alpha browser tabs were at login; their current producer recovery
status could not be inspected. Sign-in was requested without changing access.

The fetched Project Alpha `origin/main` is now `14b304d7`, containing the
TrueNAS managed-key permissions fix after the startup repair in `c019cc32`.
Repository presence does not prove either production container has adopted it.
Existing encryption keys must be preserved; deleting them is not a recovery
step. Durable expiry-scheduler health remains in implementation and must not
be marked deployed from this checkpoint.

After the owner signed in, both live PA footers confirmed `v14b304d` and both
existing connections showed enabled Ed25519 signing and web-process readiness.
LTDS had 21 active producer workspaces and 41 terminal workspace events; LTT
had three active producer workspaces, four retrying events, and four terminal
events. Both scheduled reconciliation statuses were `Preflight not ready`.
Failure summaries showed `external-operations-delivery-unavailable` with no
HTTP status. The LTDS cron log independently reported `prerequisites_missing`.
Manual Sync now completed bounded passes without recovering terminal records.

The current sender throws that code before HTTP when delivery configuration
is unavailable. This narrows the next check to cron configuration/readiness;
it does not establish which prerequisite is missing or prove a receiver fault.
The owner was asked whether both cron containers were recreated with the web
update. Preserve credentials, key files, and failed-event history while checking
the shared config mount and effective key. Replacement snapshot recovery remains
pending until sender readiness and receiver acceptance can be verified.

The core architecture and most requested workflows are implemented and covered
locally. The overall goal is **not rollout-complete**. Several higher-authority
Client workflows remain deliberately default-off, LTT Project Alpha has not
completed its first authenticated synchronization, and live two-source client
acceptance has not been recorded.

Do not compensate for missing projections by matching names or email addresses,
fabricating secondary-source workspaces in Operations, or enabling only one
half of a cross-application feature.

## Requirement evidence

| Requirement | Current evidence | Completion state |
| --- | --- | --- |
| Separate Project Alpha instances through one connection per instance | Project Alpha uses one generic External application connection for ordinary, workspace, service-assignment, and contact-role projections. Ops Sync accepts the legacy primary route and exact-source routes bound to a registered source, producer binding, application key, and public-key commitment. | Implemented. LTDS is live and healthy; LTT receiver registration exists but its producer connection is still disabled. |
| Unified client identity without cross-tenant merging | `business-parties.ts`, `business-party-routes.ts`, and `client-hub-directory.ts` implement reviewed cross-source grouping while authorization remains source-qualified. Same-name suggestions never auto-link. | Implemented. Live two-source acceptance remains blocked on first LTT sync. |
| Default-on workspace creation with administrative revocation | Signed Project Alpha workspace snapshots create authoritative source workspaces. `client-portal-root-access.ts` provides source-qualified, idempotent revoke/restore with audit history. The primary legacy-account repair path is intentionally LTDS-only. | Partial rollout. LTDS production records currently report automatic workspace pending; LTT cannot create workspaces until its Project Alpha producer publishes signed snapshots. |
| Service-capability-driven portal behavior | Project Alpha service assignments are synchronized facts, never login or membership grants. `service-assignment-policy.ts` uses exact workspace, source generation, and receiver grants to decide which request services are available. | Implemented but default-off. Default-on portal eligibility remains independent; service assignments constrain request capabilities only. |
| Searchable, progressively loaded Client Hub | Cursor-bound directory pagination and source-aware indexes are implemented in `client-hub-directory.ts` and `client-hub-index.ts`; browser tests cover debounced type-to-search and continuation. | Implemented. Production Client Hub loaded successfully with isolated LTDS/LTT/local filters; LTT currently contains zero synchronized clients. |
| Responsive client and organization workspace | Client Hub detail pages use source-qualified lookups and a 1/2/3/4-column layout at responsive breakpoints, with destructive controls ordered last. | Implemented in source and mocked browser coverage. Live mobile and ultrawide acceptance still needs recording after the portal rollout. |
| Organization and project contact roles | Organization operational roles and source-published Project Alpha contact roles are implemented as informational roles that never grant portal or delivery access. | Implemented; PA contact-role publication and the Operations flag must be verified per source before activation. |
| Project history, notes, operational memory, and recurring-project copy-forward | Source-qualified history, revisioned operational memory, staff-only notes, attachments, explicit preview/confirm copy-forward, receipts, and reassignment recovery are implemented and tested. | Implemented. Production write acceptance has not been recorded. |
| Delegated access with expiration and audit | Delegated-share signer, exact-target authorization, live membership/entitlement rechecks, expiry/revoke handling, manager recovery, and audit federation are implemented. | Implemented but default-off. Paired Client and Operations flags, migrations, bindings, and live staff/client acceptance are still required. |
| Portal-native delivery and staged notifications | Native delivery bindings, authenticated grants, delivery-change batching, digest history, and recovery components exist. | Implemented but default-off. Recipient, batching, retry, and revocation behavior require controlled live acceptance before enabling. |
| Generic feedback | Legacy and exact-source native feedback paths are implemented. | Implemented but native source allowlist is empty by default. Activate one verified source at a time. |
| Project Alpha-backed service requests | Request v2, service-assignment policy, staff triage, and idempotent Project Alpha draft-quote handoff exist. Project Alpha remains the pricing and quote authority. | Implemented but default-off. A new contract is required only if approval must create a Project Alpha project/task rather than a draft quote. |
| Tenant isolation, authorization, and recoverability | Exact source/root keys, deny precedence, source visibility checks, optimistic concurrency, immutable receipts, and fix-forward recovery are covered throughout the relevant unit/integration suites. | Strong source evidence. Final proof requires a real client from each PA source plus revoke/no-crossover tests. |
| Automated and browser coverage | Operations CI enforces unit/build plus desktop/mobile Edge acceptance. Client portal browser tests exist locally. | Gap: Client portal desktop/mobile browser suites are not yet required by CI. |
| Observability | Worker observability, safe workflow readiness, connector sync/recovery status, audit history, and token-expiry reminders exist. | Partial. Delegated-expiry reconciliation lacks durable component-specific last-run/last-success/error/backlog state. |

## Verified production facts

- The LTDS source remained healthy after its Ed25519 activation and manual sync.
- The deployed Operations Worker exposed the non-secret connector-token expiry
  diagnostic added by Operations PR 40.
- The LTT source was registered and read-visible in the Operations connector
  registry, but its last pull returned `project-alpha-http-500` and it had never
  completed a successful sync at the time of inspection.
- The LTT Project Alpha External application connection remained disabled, with
  its staged Ed25519 key unactivated. No LTT client records had reached the
  production Client Hub.
- The production Client Hub rendered 22 accessible records without a console or
  route failure. Project Alpha-backed LTDS records reported automatic workspace
  pending rather than falsely claiming a linked workspace.

## Ordered remaining gates

1. Deploy the latest Project Alpha `main` to both instances and verify the shared
   encryption-key startup contract and scheduled portal recovery.
2. Complete the LTT External application connection using the existing exact
   source route, a bounded Cloudflare Access service token, and the already
   registered Ed25519 public key. Do not create another Project Alpha connection.
3. Run LTT manual sync, verify business/workspace/service/contact projections,
   and prove LTDS remains unaffected. Then require registered sources in Ops Sync.
4. Verify migrations and enable service assignments, request v2, and native
   feedback for one source at a time. Record catalog, deny, revoke, and retry
   evidence.
5. Enable the paired authenticated-delivery, membership, delegated-share, and
   notification flags only after both Worker readiness checks and controlled
   staff/client acceptance pass.
6. Add Client Portal desktop/mobile browser suites to CI and add durable
   scheduler health for delegated-expiry reconciliation.
7. Record live two-source tenant-isolation, mobile, ultrawide, session renewal,
   and revocation evidence before marking the overall goal complete.

## Related current documents

- `docs/operations/client-portal-goal-acceptance.md`
- `docs/operations/client-portal-production-evidence-2026-09-01.md`
- `docs/operations/project-alpha-snapshot-recovery.md`
- `docs/operations/project-memory-design.md`
- `docs/operations/recurring-project-copy-forward.md`
- `docs/operations/project-access-expiry-notifications.md`
- `docs/client-delegated-share-signer.md`
- `docs/cloudflare-setup.md`

Historical inventories and frozen-scope records remain useful provenance, but
must not be read as proof that their runtime gates are enabled today.
