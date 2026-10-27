# Native staff bootstrap approved executor

The approved executor is the only CLI in this package that can dispatch the
one-shot native staff bootstrap install. Its default invocation is a read-only
preview. The execution mode requires the exact preview digest and consumes the
signed local approval registry entry before its final session and database
checks.

## Trust gates

- The independent issuer distribution manifest pin and the trust-config pin
  must both be provisioned and match. The distribution manifest pins the
  receipt verifier, executor, config loader, and DPAPI signer. Its sentinel is
  separate from the self-excluded pin module.
- Trust configuration is loaded only from
  `%LOCALAPPDATA%\LedgeTop\native-staff-bootstrap\trust-config.json` and must
  match the source-pinned SHA-256 constant. An all-zero constant means the
  executor is unprovisioned and refuses to run.
- The configured installer commit, runtime module, and all 225 migrations are
  checked against Git objects before either preview or execution.
- The artifact and signed receipt must agree on the approval, command, exact
  canonical plan, binding evidence, target, source, and reviewed D1 snapshot.
- The signed local registry must contain the exact receipt hash in `issued`
  state. Execute changes it to `dispatching` under an exclusive lock before
  final rechecks; it becomes `consumed` after durable confirmation or
  `uncertain` if dispatch outcome cannot be established. Neither state permits
  another execution attempt.
- The current Access JWT is signature-checked against the pinned issuer and
  audience, must identify the pinned owner, and must be accepted by a fresh
  protected `/api/session` GET. The session's staff ID must match the pinned
  owner. No browser cookies, role/email shortcuts, or service tokens are used.
- A fresh D1 authority snapshot must exactly match the signed reviewed
  snapshot. The existing installer then performs its own compare-and-swap
  checks and writes the approval, authority rows, and durable receipt in one
  atomic management batch.

## Invocation

Preview:

```powershell
node scripts/native-staff-bootstrap-approved-executor.mjs --artifact <private-artifact.json>
```

Execution must be a separate explicit invocation with the exact preview digest:

```powershell
node scripts/native-staff-bootstrap-approved-executor.mjs --execute --artifact <private-artifact.json> --prepared-sha256 <preview-sha256>
```

The receipt is resolved by the exact approval ID under the configured receipt
directory. The Cloudflare API bearer is obtained from the hash-pinned installed
Wrangler CLI and is never printed. Access tokens are obtained through
`cloudflared access token`, held in memory, and never printed. REST requests use
the exact configured account and D1 UUID, bounded responses, manual redirect
handling, and no retry behavior.

## Limits

This wrapper does not initialize the approval registry, issue or revoke a
receipt, create keys, change Worker code or bindings, or provision D1 tables.
Registry signatures detect modification and forward forks, but a local actor
able to restore an earlier signed registry file can roll back its sequence;
the current design assumes the trusted Windows host and its receipt-directory
ACLs are not rolled back. No automatic recovery or replay is provided after an
uncertain dispatch.
