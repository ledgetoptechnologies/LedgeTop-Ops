# Recovery-key custody choices for Merger review

**Historical optional notes, superseded for staging:** Beau waived staging backups on
November 12. Do not require a vault choice, backup key or independent backup-recovery
test, and do not build more backup framework. No staging decision is pending here.
Credential encryption and production backup policy remain unchanged.

Beau requires encryption for secrets and sensitive retained material. Cold storage is a
storage/retention choice, not encryption. No named existing vault, off-machine recovery
location, recovery authority or real key has been verified or selected by this packet.

## What the current implementation supports

| Piece | Supported boundary | Does not establish |
| --- | --- | --- |
| `staging-backup-envelope.mjs` | Injected nonextractable AES-256-GCM key; authenticated bounded backup and opening | Persistence, key provisioning, independent recovery or full-transfer acceptance |
| `createWindowsDpapiSealer` in `staging-inquiry-custody.mjs` | Existing CurrentUser DPAPI response sealing for its original inquiry purpose | An off-machine backup key, independent recovery, or permission to reuse its consumed journals |
| Protected export response adapter | Injected sealer and independently checked proof contract | That a concrete vault, disk path, ACL policy, durable journal or transport has been accepted |

The original inquiry sealer must not be repointed to migration data. A new reviewed
purpose-bound adapter must enforce private create-new persistence and verify actual saved
ciphertext and restrictive ACLs. The response body can contain a private download capability
and must be encrypted before parsing or ordinary result recording. Encryption metadata
should contain only safe identifiers/hashes; private names and capability URLs stay sealed.

## Concrete custody options

1. **Existing independently recoverable encrypted vault plus local working protection.**
   Preferred if Merger verifies an existing approved vault and its recovery authority.
   Keep a distinct staging-backup key version there and a separate protected local working
   copy only if required by the reviewed adapter. Load through a private in-process/pipe
   boundary, import a nonextractable key, and keep material out of argv, stdout, environment
   dumps, repository files and ordinary receipts. The vault and local adapter are not yet
   selected or implemented here. A saved password or secret name is not a recovery test.
2. **Separately encrypted offline recovery copy plus local working protection.**
   Suitable only after Merger identifies an approved off-machine/offline destination and
   independent unlock custody. Encrypt the recovery material before writing it; never keep
   its unlock secret alongside the backup or on the same sole PC/profile. This format and
   provisioning adapter are not implemented. Do not invent a plaintext recovery file as an
   intermediate step or treat an unverified removable drive as accepted recovery storage.
3. **CurrentUser DPAPI only.**
   Available as local response protection for the existing purpose, but **insufficient by
   itself for migration backup recovery**. Losing the user profile/PC can lose access. It
   may be one layer of either option above; it is not a substitute for independent custody.

Do not create a key until Merger has selected the exact authority, protected recovery path
and rotation/retention procedure. No additional cloud service or paid product is requested
by this document. Runtime app credentials remain separate from backup encryption keys.

## Required qualification before real data

- Use a synthetic canary first. Persist ciphertext with create-new semantics in the actual
  reviewed private destination; verify bytes, digest, ACL and path/link policy after reopen.
- End the original key-holding process. In a separate process, retrieve through the approved
  independent recovery path and authenticate/open the saved canary without a plaintext file.
- Match the exact plaintext digest and length. Test wrong key/version/context and damaged
  ciphertext refusal. Record only safe proof hashes and the reviewed custody version.
- Retain the old recovery key while any retained backup requires it; prove recovery before
  rotation/cleanup. Do not delete source data or old authority based on this component test.

Only then can Merger review real export custody and the guarded restore/parity sequence.
Provider execution and activation remain disabled in the source-only transfer interfaces.
