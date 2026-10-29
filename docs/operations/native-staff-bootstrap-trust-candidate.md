# Native staff bootstrap trust candidate preparation

This Windows-only utility prepares a local trust-config **candidate** for
independent review. It does not provision trust, configure the issuer or
executor, initialize the approval registry, or approve an owner decision. The
source trust-config pin and issuer distribution pin remain their all-zero
fail-closed sentinels.

## Explicit operator input

The operator supplies a UTF-8 JSON file with this exact shape:

```json
{
  "schemaVersion": 1,
  "kind": "operations-native-staff-bootstrap-trust-candidate-input-v1",
  "target": { "accountId": "<reviewed account id>", "databaseId": "<reviewed database UUID>" },
  "source": { "commit": "<reviewed 40-character commit>", "migrationNamesSha256": "<reviewed 64-character digest>" },
  "access": {
    "origin": "<reviewed Operations origin>",
    "issuer": "<reviewed Cloudflare Access issuer>",
    "audience": "<reviewed Access audience>",
    "owner": { "staffId": "<independently verified owner staff ID>", "accessSubject": "<independently verified Access subject>" },
    "cloudflaredExecutablePath": "<absolute Windows path>",
    "cloudflaredExecutableSha256": "<reviewed executable digest>"
  },
  "receiptDirectory": "<absolute Windows receipt directory>"
}
```

The input contract is closed: extra fields such as email, role, cohort, snapshot
or proposed grants are rejected. Values must be supplied from separately
reviewed records. This utility checks their shape only; it does not read a D1
snapshot, infer staff identity or authority, inspect the Access application,
hash the cloudflared executable, or confirm that the supplied facts are true.

## Commands

Validation reads the explicit input and performs no key generation or file
creation:

```powershell
node scripts/native-staff-bootstrap-trust-candidate.mjs --validate C:\private\trust-candidate-input.json
```

Candidate creation is explicit opt-in:

```powershell
node scripts/native-staff-bootstrap-trust-candidate.mjs --create-candidate C:\private\trust-candidate-input.json
```

It creates a uniquely named candidate folder directly under the current user's
`%LOCALAPPDATA%`. The folder receives a protected DACL for the current Windows
user and `SYSTEM`, with no inherited entries. Existing paths, reparse points,
unexpected ACLs, and file overwrites are refused. An RSA-3072 key pair is
generated in Windows .NET process memory. PKCS#8 private bytes are protected
with DPAPI `CurrentUser` using the UTF-8 bytes of the exact configured entropy
string before they cross into Node or are written. That matches the existing
signer helper's unprotect contract. Only the DPAPI-protected bytes are
persisted; the public config and a
`draft-not-approved` review marker are written with exclusive creation.

The candidate config is named `trust-config.candidate.json`, not the loader's
expected `trust-config.json` path. Its SHA-256 is passed to the existing closed
`parseTrustConfig` parser only to verify that the candidate conforms to the
current schema. That digest is not installed as a source pin. The tool prints
only the public key ID, config hash, candidate paths and draft status. It never
prints operator identity fields or key material.

## Review boundary

The candidate is not trusted merely because the parser accepts it or because a
key was generated. Separate owner/governance review must confirm each supplied
owner, target, source, Access and cloudflared fact and approve the exact
candidate bytes. A separately reviewed source change must then pin the exact
trust-config hash and distribution manifest. Only a later explicitly authorized
provisioning step may install the trusted config and initialize the signed empty
approval registry. This utility has no command for those actions, and it does
not issue or sign an owner approval or execute the D1 installer.

Offline test command:

```powershell
node --test scripts/native-staff-bootstrap-trust-candidate.test.mjs
```

The Windows runtime test uses a synthetic owner/target, a temporary folder, and
the current user's DPAPI context. It invokes the existing signer only on a
synthetic, non-approval test string, verifies the RSA-PSS signature with the
candidate public key, and independently checks the directory and child-file
ACLs. It does not create an owner approval or use production inputs.
