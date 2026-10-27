# Native staff cutover owner approval

This is a separate authorization purpose from the additive native staff
bootstrap installer. It signs only the first 0230 cutover that changes the
native reconciliation singleton from disabled to enabled. The cutover plan
does not insert or change staff identities, roles, grants, or Access group
membership.

## Closed bindings

The cutover receipt has its own `operations-native-staff-cutover-owner-approval-v1`
kind and its own signed registry file (`cutover-approval-state.json`). Its
consent hash covers a closed owner approval context containing the exact
configured account, D1 UUID and database name, committed 0230 source and
migration hashes, the low-level cutover context, snapshot, canonical plan and
binding hashes, cohort, control-plane IDs, operator, command, and complete
dormant Sync preparation receipt. That receipt includes the current and desired
Access group counts and digests. The typed phrase contains the hash of this
whole context, including target and source.

Issuance and execution require a real signed Cloudflare Access app JWT and an
Access-protected `/api/session` response naming the configured owner. Execution
also checks the configured D1 metadata, current full 0230 snapshot, active owner
admission/profile binding, and signed local registry before preparing. It
repeats the owner session, target, snapshot, approval, and registry checks after
acquiring the one-shot lease and again immediately before the atomic batch.

The cutover registry is independent of the bootstrap registry. An issued entry
can be revoked only against the current registry hash. Execution transitions
`issued` to `dispatching` before provider dispatch and holds the exclusive lock
through readback. It records `consumed` after exact durable verification or
`uncertain` after any ambiguous outcome. Neither state can be retried. The
registry hash chain detects modification and forks; restoration of an older
signed state on the trusted Windows host remains outside the filesystem threat
model, as with the bootstrap registry.

## Commands

The owner-only issuer accepts a candidate artifact and asks the operator to
type the context-bound consent phrase:

```powershell
node scripts/native-staff-cutover-owner-approval-cli.mjs --candidate <candidate.json>
```

An unconsumed approval can be revoked by its exact registry state hash. The
issuer rechecks the current owner session and requires the typed revocation
phrase before changing the signed registry:

```powershell
node scripts/native-staff-cutover-owner-approval-cli.mjs --revoke <approval-uuid> --state-sha256 <current-registry-hash>
```

The executor defaults to read-only preview. Use the exact digest it prints for
the one-shot execution command:

```powershell
node scripts/native-staff-cutover-approved-executor.mjs --candidate <candidate.json>
node scripts/native-staff-cutover-approved-executor.mjs --candidate <candidate.json> --execute --prepared-sha256 <digest>
```

The candidate contains the reviewed source snapshot, control-plane staff IDs,
operator identity, command and approval UUIDs, and complete dormant Sync
preparation receipt. It contains no credentials. The receipt and registry are
stored under the configured protected receipt directory.

## Provisioning boundary and verification limits

The cutover trust-config hash, cutover runtime manifest hash, and existing
issuer distribution hash are all zero in source. Commands therefore fail
closed before Access or D1 calls until a separate review provisions those
independent pins and a signed empty cutover registry. No key/config provisioning,
production Access call, D1 write, activation, or deployment is part of this
source change. Synthetic tests use only a temporary DPAPI-protected test key,
synthetic Access JWT/JWKS/session responses, and local fixtures; they do not
establish owner authority or production readiness.

During local integration debugging, an earlier synthetic D1 batch committed
and its exact durable readback marked that fixture's one-shot registry entry
consumed before the provider metadata normalization fix was applied. That
fixture was disposed and was never replayed. The passing signed-wrapper run
used a fresh synthetic approval and command against a fresh local D1 instance.
