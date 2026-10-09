# Retained Directory staging authority rehearsal

This is a narrow synthetic staging recovery tool, not general staff provisioning
and not a production migration. Its fixed target is exported as
`RETAINED_DIRECTORY_TARGET` in `scripts/staging-retained-directory-authority.mjs`.
It reactivates only the original three grant IDs for that exact retained client
area. It does not authorize the separately scoped parent organization, grant
client-portal access, or change public links.

## Required release and state checks

- Use the reviewed source revision and exact staging D1 binding. Run the normal
  exact-revision CI and staging preservation checks before promoting any Worker.
- The compiler pins the complete 181-migration chain through 0181, including
  migration contents. Do not relax the pin after a new migration; review and
  intentionally advance it with matching tests instead.
- The original provision and paired-revoke evidence must exist in the private,
  ignored `.backups/staging-native-authority/` lineage directory. Never commit
  those files, database snapshots, credentials, or generated authority packets.
- Retained schema, grant/history, deny, reference-count, admission, predecessor,
  project-generation and unsettled-work checks must all pass unchanged.
- Configure credentials through the approved process environment. Do not put
  tokens in command arguments, documentation, console output or Git.

## Commands

Run from the isolated repository root, using the independently verified minimal
staging configuration path rather than a production or mixed-resource config.

```powershell
node scripts/staging-retained-directory-authority-window.mjs prepare-readonly --config <minimal-staging-config.json>
node scripts/staging-retained-directory-authority-window.mjs apply --config <minimal-staging-config.json>
node scripts/staging-retained-directory-authority-window.mjs close --config <minimal-staging-config.json> --artifact <saved-provision.json>
node scripts/staging-retained-directory-authority-window.mjs reconcile --config <minimal-staging-config.json> --artifact <saved-retained-artifact.json>
```

- `prepare-readonly` reads and compiles current state; it does not save or apply
  an authority packet.
- `apply` saves private recovery evidence before the atomic batch, then verifies
  exact grant/history state and immutable approval/receipt readback.
- Save the returned artifact path. Complete the normal recovery workflow and
  acknowledge outstanding work before running the paired `close` command.
- `close` requires the exact saved activation artifact, saves its own revoke
  evidence before applying, and verifies both the new receipt and revocation of
  the activation approval. Expired activation approval does not prevent this
  reviewed cleanup path.
- `reconcile` is read-only. After an uncertain response, supply the exact saved
  artifact named in the error. It reports committed only with matching immutable
  receipt and exact poststate, or not committed only with exact unchanged
  prestate and absent approval/receipt. All other outcomes remain unknown.
- Do not rename generated revoke files or move packets out of their original
  approval-ID directory. File identity, bounded size and non-symlink checks are
  enforced before use.
- Approval expiry is **not** automatic grant removal. Always finish the paired
  close and independent readback; never claim cleanup based on elapsed time.

## Live recovery ordering before a relationship-schema successor

- Retained create-generation recovery and profile settlement use canonical 0181.
  Finish their acknowledged write/replay/conflict/readback and paired authority
  cleanup before advancing the chain for the separate organization relationship.
- Use a newly committed, terminal-CI-green runtime revision and a fresh complete
  staging-settings preservation upload/readback. Historical inactive versions
  and ignored scripts pinned to older revisions are not release approval.
- Browser preparation requires the recovery flag and the exact retained grants;
  a `prepared` response is queued work, not a PA acknowledgment. Leave the normal
  deployed Directory drain off and cron schedules empty.
- The existing isolated remote-preview scheduled acceptance path can dispatch
  without adding an endpoint or a deployed schedule. Before its single
  invocation, prove the scheduler's entire eligible set is exactly the saved
  successor across both profile and relationship queues, and prove no waiting
  client intent can materialize additional work. Repeat that proof once the
  preview is ready. A count limited to the intended source or command is not
  sufficient. Use the scheduler's configured-source, due-time, lease and
  materialization semantics, not a simplified pending-row query.
- Use only the documented Directory cron contract and a short-lived staging-only
  Access credential. Require one attempted and acknowledged command, no other
  outcomes, exact durable acknowledgment/mapping/materialization readback, an
  unchanged terminal predecessor, and an empty remaining eligible set. Stop the
  preview and revoke its temporary Access policy/credential afterward, including
  on failure. Do not blindly re-invoke after an uncertain response: reconcile
  the saved command and receipts first.
- Complete profile acceptance and paired `close`, independently verify inactive
  grants, and restore recovery-off/drain-off/zero-cron staging configuration
  before any new relationship migration. Neither this runbook nor the local
  relationship SQL proposal is evidence that live acceptance has passed.

## Local evidence

```powershell
node --test scripts/staging-retained-directory-authority.test.mjs scripts/staging-retained-directory-authority-window.test.mjs scripts/staging-retained-directory-authority-fullschema.test.mjs
```

The full-schema cases use a local synthetic Miniflare D1 instance. Two additional
historical-lineage unit cases intentionally skip when private historical files
are absent, including on CI. Local/mock results do not prove live PA settlement,
recipient enrollment, file access or production readiness.
