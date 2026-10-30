# source38-inventory-v2

This folder is an isolated, source-only inventory profile for the reviewed Git
commit `38ad7ebcfc09e4334de846d5307e7dac5a0ff327` (tree
`47baeb281c5b370b935b86e6586c3d74d720681f`). The manifest and append plan are
the exact candidate bytes, pinned by `gate.mjs`. The candidate receipt is kept
for provenance; it records hashes of read responses, not the raw responses, so
its zero-write and no-DDL claims cannot be independently audited from these
files alone. The returned `pinnedProfileSourceTree` names the reviewed profile
tree; it is not evidence that a caller's live checkout has that tree.

`classifySource38Inventory` accepts already-read local source and ledger
evidence. It checks the fixed database IDs, the exact source migration names
and bytes, ordered base ledger, append plan, historical client rows, and
read-only statement metadata. It requires an explicit zero-valued write
indicator, but that caller-supplied metadata is not proof that a provider made
no mutation. The pure gate has no provider connection and can classify only
the evidence it receives. Tests reconstruct the pinned migration set from
the current `HEAD` tree by matching every migration name, blob OID, and SHA-256
to the profile. They do not require the historical profile commit object or
depend on checkout line-ending conversion.
It returns only a held inventory classification
with application readiness, DDL, migration, and feature activation all false.
Partial, unknown, reordered, or mismatched ledger states are rejected.

The gate is not connected to the automatic migration classifier or any
provider adapter. It does not read credentials, call a provider, execute SQL,
admit a successor profile, or grant production authority. A later profile or
execution path needs a separately reviewed change. The frozen
`append-only-inventory-gate.mjs`, its manifest, its append plan, and its
default wiring remain untouched.

Run the focused local tests with:

```powershell
node --test scripts/production-auto-migration-profile/source38-inventory-v2/gate.test.mjs
```
