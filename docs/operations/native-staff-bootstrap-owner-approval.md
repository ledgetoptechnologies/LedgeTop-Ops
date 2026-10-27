# Operations native staff bootstrap owner approval

This is a source-only, out-of-band approval issuer for the guarded D1 installer in
`scripts/native-staff-bootstrap-d1.mjs`. It does not install or write D1 rows. The
installer still inserts the approval, admission/profile rows, initial reviewed
authority rows, and immutable receipt together in its guarded atomic batch.

## Trust boundary

The issuer obtains an Operations Access token through a provisioned absolute
Cloudflared executable path whose SHA-256 is pinned in the trusted config. It
does not search `PATH`. It validates the token’s RS256 signature against the pinned Access issuer JWKS, exact
audience, exact owner Access subject, human token type, and `iat`/`exp` bounds.
It then checks the live `/api/session` identity and obtains the existing
same-origin `/api/staff/current-cohort-review` advisory packet with its CSRF
token. It compares the current staff and captured authority tables with the
reviewed 225-migration snapshot, while ignoring only volatile `last_seen_at`.
Global business divisions and directory resource scopes are included in the
installer snapshot guard because they define permission scope interpretation.

The API packet is evidence for the owner review only. It does not grant
authority or create an approval. The approval is a locally signed receipt bound
to the exact target account/database, installer source and migration hash,
owner staff ID and Access subject, cohort packet hash, canonical plan hash,
binding evidence hash, snapshot hash, one-time approval/command IDs, and short
expiry. The receipt carries the installer’s fixed consent phrase in its legacy
envelope, plus a separately signed typed phrase containing the plan, binding
evidence, snapshot, and live cohort hashes. The installer verifier checks the signed receipt against
the exact execution input before its transaction and again immediately before
dispatch.

The private signing key is expected to be RSA 3072-bit PKCS#8 protected with
Windows DPAPI `CurrentUser`; `pwsh.exe` unprotects it only for the signing
operation and emits only the signature. The receipt is created with exclusive
file creation in the configured local receipt directory. `cloudflared` may
persist its own Access token cache; this issuer does not print or save the token.

## Issuance, revocation, and execution lease

Provisioning must create a signed empty `approval-state.json` before issuance is
enabled. Missing, malformed, or invalidly signed state refuses issuance and
execution. The issuer records the signed receipt hash and approval/command IDs
as `issued` before publishing the receipt file. A separate `--revoke <receipt>`
command requires the current pinned owner Access session and typed consent that
binds the approval ID and current state hash; it changes only an `issued` entry
to `revoked`. An executor acquires the exclusive state lock and transitions
`issued` to `dispatching` before D1 effects. It holds that lock through the D1
dispatch and durable reconciliation, then records `consumed` or `uncertain`.
Only `issued` entries can be executed or revoked. Stale locks, revoked or
already-dispatched entries, invalid state, and missing entries fail closed.

The signed sequence/hash chain detects unauthorized state edits, but restoring
an older valid signed state file cannot be detected without a protected
monotonic anchor. This design assumes the receipt directory and DPAPI identity
run on a trusted Windows host whose local administrators and filesystem are not
adversarial. A stronger anti-rollback anchor would require a separately reviewed
platform facility. Node.js, Windows PowerShell, Windows, and the pinned Wrangler
CLI are trusted platform dependencies. The distribution manifest covers the
issuer, signer, executor, config loader, low-level installer, local Wrangler
CLI bytes, and all 225 migration files. Its hashes identify this frozen Windows
checkout byte-for-byte; line-ending conversion or a different dependency
installation requires a newly reviewed manifest. Cloudflared is pinned
separately in trust config. This self-check does not defend against malicious
code replacing the launcher or files before the check runs.

## Provisioning is deliberately absent

The source pin `PINNED_TRUST_CONFIG_SHA256` is an all-zero sentinel. Therefore
the CLI refuses before token acquisition or network access. No trust config,
owner pin, signing key, key verifier pin, or owner decision was created here.
Before an authorized operator can use it, a separate reviewed provisioning
change must establish, through an independently authenticated owner/governance
process:

- The exact Operations owner staff ID and Access subject, checked against the
  current native admission/profile and trusted owner record. Email or role is
  not a substitute.
- The exact production target account and database, source commit, and 225
  migration-name digest.
- The absolute Cloudflared executable path and its exact SHA-256. A vendor
  update requires a separately reviewed provisioning update before this tool
  accepts the binary.
- A new signing key pair, with private PKCS#8 bytes protected for the intended
  Windows user and its SPKI SHA-256 key ID pinned in the config.
- A protected trust-config file at `%LOCALAPPDATA%\LedgeTop\native-staff-bootstrap\trust-config.json`
  and its exact SHA-256 in source. The trust-config hash pin must be reviewed
  independently of the file contents; capturing current cohort evidence does
  not authorize a key or owner pin.
- A separate reviewed distribution manifest/hash for the issuer CLI and signer
  helper. This issuer distribution identity is distinct from
  `config.source.commit`, which pins the installer module and complete migration
  tree byte-for-byte through Git objects; the two identities must not be made
  self-referential. The all-zero value in the separate distribution pin-value
  module stays fail-closed until the trusted launcher/provisioning record pins
  the manifest SHA; that pin-value file is outside its own manifest.
- A protected, existing receipt directory.

The config parser enforces a closed schema and exact target/source/owner/key
fields. Any key rotation or owner/target change requires a separately reviewed
source-pin update. There is no browser approval route, Worker endpoint, HTTP
bootstrap, automatic key generation, signature bypass, or CLI switch that
pretends approval was given.

## Operator flow after separate provisioning

From the reviewed source checkout, the operator supplies the already reviewed
installer artifact containing `canonicalPlanJson`, `bindingEvidenceJson`,
`reviewedSnapshot`, and `commandId`:

```powershell
node scripts/native-staff-bootstrap-owner-approval.mjs --artifact C:\private\reviewed-installer-artifact.json
```

The CLI validates the live Access session and review state, displays a redacted
row summary and hashes, then requires the operator to type the full exact
hash-bound consent phrase, including the binding evidence digest. It refreshes the review after consent and refuses if
the cohort hash changed. It creates a signed receipt file only; a later,
separately authorized executor must verify the receipt, reviewed plan, pinned
source/schema, and guarded D1 transaction. A failed or uncertain execution is
reconciled from durable D1 state and is never automatically retried.

No real owner consent or production execution was performed as part of this
source work. The hosted synthetic full-schema qualification for the prior
installer tuple does not qualify the added global resource-scope CAS change.
