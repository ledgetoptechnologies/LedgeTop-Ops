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

## Local evidence

```powershell
node --test scripts/staging-retained-directory-authority.test.mjs scripts/staging-retained-directory-authority-window.test.mjs scripts/staging-retained-directory-authority-fullschema.test.mjs
```

The full-schema cases use a local synthetic Miniflare D1 instance. Two additional
historical-lineage unit cases intentionally skip when private historical files
are absent, including on CI. Local/mock results do not prove live PA settlement,
recipient enrollment, file access or production readiness.
