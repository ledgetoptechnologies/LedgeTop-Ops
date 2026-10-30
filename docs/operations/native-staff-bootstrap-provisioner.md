# Native staff bootstrap issuer provisioner

This source-only helper is a separate, one-shot Windows operation. It installs
the exact reviewed trust-config bytes at
`%LOCALAPPDATA%\LedgeTop\native-staff-bootstrap\trust-config.json` and creates
one signed empty `approval-state.json` in the separately pinned receipt
directory. It does not issue an owner
approval or receipt, call Cloudflare, or write D1.

## Fail-closed package boundary

The helper has its own exact package inventory and SHA-256 pin, independent of
the issuer's seven-file distribution manifest. The package includes the CLI,
core, Windows adapter, protected signer, and source-verification dependencies.
The package pin is held outside that manifest in
`native-staff-bootstrap-provisioner-pin-value.mjs`; a descriptive adjacent
manifest alone is not trusted. The package, config, and receipt-path pins all
remain unconfigured in source. The existing issuer and executor pins remain
unchanged. Until a separate source/package review sets and verifies those pins,
the CLI exits before argument parsing, candidate reads, filesystem operations,
source checks, or protected signing. It accepts no caller-supplied hash or
destination as authority.

The candidate config hash must equal both the independent provisioner pin and
the issuer's config pin. Its `receiptDirectory` must equal the separately
reviewed absolute path, which must be a new child path under `%LOCALAPPDATA%`.
The config parser is preceded by strict UTF-8 decoding and duplicate
JSON-key rejection. The helper checks the explicit source commit and all 225
migration names through the existing source verifier.

## One-shot operation

After package/config/path/source checks and a read-only filesystem preflight,
the helper signs the exact canonical empty state in memory through the existing
CurrentUser DPAPI signer and verifies the signature with the pinned public key.
Only then does it create its protected attempt journal. It writes the exact
config, creates the absent receipt directory, and calls the existing empty-state
initializer with that already-verified signature. The initializer accepts a
provisioner-only no-replace publisher and preserves temporary and lock artifacts
on failure. Its fixed journal and lock files are direct children of the existing
`%LOCALAPPDATA%` directory, so no config or receipt parent is created before
the durable `started` intent.

```powershell
node scripts/native-staff-bootstrap-provisioner.mjs --provision --candidate <reviewed-config-candidate.json>
node scripts/native-staff-bootstrap-provisioner.mjs --reconcile
```

The Windows adapter checks every existing path component for reparse points.
New provisioner-owned directories and files use protected ACLs with only Full
Control for the current user SID and SYSTEM. The pre-existing signer key is
checked against the candidate utility's distinct ACL contract: its parent is a
protected owner/SYSTEM directory, while the key file itself inherits exactly
two Full Control ACEs from that parent, has no explicit ACEs, and is owned by
the current user. It creates files exclusively, flushes file data, and
publishes with `MoveFileExW` without replace and with write-through. It
attempts to flush parent directory handles. In the bounded synthetic NTFS temp-directory run,
`FlushFileBuffers` succeeded for those handles; the helper still records
`directoryFlushConfirmed: false`, because this is not a guarantee across all
Windows filesystems or storage conditions.
The helper fails closed if a required file flush or no-replace/write-through
publication fails. A directory-handle flush failure is recorded as an explicit
directory-durability limitation; the completed journal reports the exact file
hashes but does not claim that the directory entry was flushed. A bounded
synthetic Windows run exercised the full core callback workflow, created and
read back a registry signed in memory with a synthetic RSA key, and verified
that incomplete and completed attempt journals prevent another provisioning
attempt without changing config bytes. The run used a synthetic package,
config, and placeholder key file; it did not invoke DPAPI or access production
candidate/key data.

Any exception after the durable `started` journal stops the operation. The
helper never retries, deletes temporary state, replaces a config/registry, or
reinitializes. An existing journal permanently blocks another provisioning
run. `--reconcile` is read-only and reports only the journal phase and config
and registry hashes; it does not sign, resume, repair, remove, or rewrite state.

The registry signature is not an anti-rollback anchor. The design retains the
existing assumption that the Windows host, local administrators, and filesystem
are trusted. The empty-registry operation has no additional typed consent
phrase. Beau must review the exact package, config hash, owner/target/source,
key identity, ACLs, and destinations and explicitly authorize a concrete future
run. The existing authenticated owner session and plan-bound typed consent are
still required later to issue a bootstrap approval.

Focused synthetic checks:

```powershell
node --test scripts/native-staff-bootstrap-provisioner.test.mjs
node --test scripts/native-staff-bootstrap-provisioner.windows.test.mjs
```

The second command runs only on Windows and uses a uniquely named disposable
temporary root. Its package/config pins, inherited-ACL placeholder key file,
and in-memory RSA signer are synthetic; it does not invoke DPAPI or read the
source provisioner pin values as authority.
