# Historical schema-v2 authority fixture

This test-only fixture preserves the reviewed staging schema-v2 authority producer and its direct source dependencies from immutable commit `332ffbb947c3dc50a96f7b0fc5e2a976f693bdbc` (tree `c07acd54f7c0e747b66e97ea7d9656210b7d7007`). It exists only to rehearse the pre-`0123` producer lineage in an isolated local database; production code does not import it.

`historical-v2-authority-sources.json` contains gzip/base64 representations of these exact Git blobs:

- `scripts/staging-native-authority-packet.mjs` — `acebdf1d29fcfacf395f34f8ccf97eb7bfd1c0ca`
- `scripts/staging-bootstrap.mjs` — `329ea1d651f245e95ac10a2dc9ef3b410c503248`
- `scripts/staging-requirements.mjs` — `5c6075b835f8b3ffe5e5f24efefb590a7aab4e59`
- `docs/staging/operations.wrangler.json.example` — `c58a90baae578b88c26225e3c5b9257f0e62ff06`

The helper verifies each decompressed SHA-256 and Git blob ID before import. It also verifies the canonical 122-file Operations migration names/content digests recorded by that historical bootstrap contract before copying migrations `0001` through `0122`. This avoids a runtime dependency on Git history or network access in shallow CI checkouts.

The preserved files remain governed by the repository's existing license and source history. They are not generated authority artifacts and must never be used to apply a remote migration.
