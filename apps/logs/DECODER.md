# Raw DJI log decoding

**Status: contract only. There is no working decoder yet.** `src/worker/decode-contract.mjs` defines how a
decoder runtime leases raw logs and reports outcomes. Nothing in this change decodes a file, calls DJI,
creates a queue or cron trigger, changes Wrangler configuration, or reads a secret value.

## What the contract guarantees

- **Raw logs are kept forever.** No transition deletes or rewrites a `raw_logs` row's identity,
  attribution, or R2 object. Only `parse_status`, the lease fields, `error_code`, `flight_id` and
  `decoded_at` change.
- **Attribution never moves.** A decoded flight gets the raw row's own `pilot_id` (`pilot_attribution =
  'controller_sign_in'`) and `file_hash = raw_logs.sha256`. Decoder output can't override either. The decoder
  never infers a pilot from the aircraft model.
- **Existing flights.** If a flight with the same hash already exists (for example from an ODL backup), it is
  linked only when its `pilot_id` equals the raw row's. A different pilot is an `attribution_conflict`: the row
  is failed, nothing is linked, and the case needs a reviewed reconciliation. It is never linked silently.
- **Fenced work.** `leaseRawLogs` claims each row by compare-and-set and gives it a fresh `attempt_token` with a
  `LEASE_SECONDS` expiry. `completeDecode`, `retryDecode` and `failDecode` change a row only for the current,
  unexpired token. Expired leases are reclaimed. After `MAX_ATTEMPTS`, a row is closed as
  `attempts_exhausted`: when its last lease expires, when a retry is reported on the last attempt, or when
  it is found still `needs_parse` at the cap. It is never left waiting for a lease it can't get.
- **Atomic completion.** The flight insert or link and the `raw_logs` → `decoded` update run in one D1 batch.
  The raw row only becomes `decoded` if its flight carries the same hash and pilot.
- **Safe error codes only.** Retryable: `keychain_unavailable`, `decoder_error`, `raw_missing`. Permanent:
  `unsupported_version`, `corrupt_log`, `attribution_conflict`, `attempts_exhausted`. Raw decoder messages,
  keys and file contents are never stored.
- **Clients never see flight logs.** The contract adds no route.

## DJI key binding

`djiKeyBinding(env)` names the one binding the environment may use:

| `LOGS_ENVIRONMENT` | Binding |
|---|---|
| `staging` | `DJI_API_KEY_Staging` |
| `production` | `DJI_API_KEY` |

Any other value, or a missing or blank secret, is an error. Neither environment falls back to the other's key.
`LOGS_ENVIRONMENT` is not set in Wrangler yet; adding it is part of runtime admission, not this change.

## Keychains

DJI v13+ logs need per-log keychains from the DJI Open API. They are stored in `keychains` sealed with
`KEYCHAIN_ENCRYPTION_KEY` (`keychain-crypto.mjs`), and only the parser path calls `decryptKeychain`.

## Runtime decision (for review, not implemented)

The decoder library is the MIT-licensed Rust crate `dji-log-parser`. There are two options:

1. **WASM inside the Logs Worker**, run from a queue consumer or cron. The Worker does the DJI keychain HTTP
   request with the environment's key, then passes the keychains to the WASM parser. Size and CPU limits
   must be measured on real logs first.
2. **A container or processing node** that leases through an authenticated internal route. This has more
   headroom for large logs, but it is another runtime to secure.

Either runtime must use only the functions above to change `raw_logs`.

## Tests

`test/decode-contract.test.mjs` runs against a real D1 in Miniflare: exclusive and expiring leases,
stale/foreign/expired token rejection, the hash-mismatch, cross-pilot and same-pilot link cases, atomic
completion with no orphan flight, the attempts cap, the closed error-code list, no key fallback, and
unchanged raw records. It uses the same Miniflare setup as the existing device tests. Running it needs the
same runtime admission as those suites.
