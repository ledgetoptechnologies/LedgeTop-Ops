# Raw DJI log decoding

**Status: contract plus a local runner, closed by default.** `src/worker/decode-contract.mjs` defines how a
decoder leases raw logs and reports outcomes. `src/worker/decoder-routes.mjs` exposes it to one machine runner, and
only when `DECODER_ENABLED=true` and `DECODER_TOKEN_SHA256` are set. The runner itself is `apps/logs-decoder` (Docker,
on Ledge Top's local processing machine). Nothing here enables it, changes Wrangler configuration, or reads a secret value.

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
- **Clients never see flight logs.** Only the runner's closed-by-default routes (below) reach the contract;
  controllers and staff never do.

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

## Runtime (decided): local runner, no cloud decoder

Decoding runs on Ledge Top's own local processing machine, in Docker (`apps/logs-decoder`). There is no Cloudflare
Container and no in-Worker WASM. If that machine is down, decoding waits: raw logs and the queue stay in Logs and
nothing is lost.

The runner reaches Logs only through `/api/v1/decoder/{lease,raw,complete,retry,fail}`, which call the functions
above:

- **Closed by default.** Every decoder path returns 404 unless `DECODER_ENABLED` is `"true"` and
  `DECODER_TOKEN_SHA256` holds the SHA-256 of the runner's bearer token. A machine token, never a staff session.
- **Leases carry only** `sha256`, `attemptToken`, `leaseExpiresAt` and `attempt`. No pilot, device or storage key.
- **`raw` returns the bytes of a log the caller currently holds**, and nothing else.
- **`complete` checks before storing anything.** The content hash must equal the lease, the summary is checked field
  by field, and the track must be gzip and at most 32 MiB. The track goes to `telemetry/v1/raw-<sha256>.json.gz`,
  one key per raw log, so a repeat overwrites rather than leaving orphans. The flight write is the contract's atomic
  `completeDecode`, which now also records the track key and the raw log's file name. A linked existing flight
  keeps its own track.
- **The DJI key lives with the runner**, in a file on that machine, one per environment, with no fallback. It is not
  a Worker secret. `djiKeyBinding` remains only for a future in-Worker runtime, which is not planned.

No migration is needed: the runner uses existing `raw_logs` and `flights` columns.

## Tests

`test/decode-contract.test.mjs` and `test/decoder-routes.test.mjs` run against a real D1 (and R2) in Miniflare. The
contract tests cover: exclusive and expiring leases,
stale/foreign/expired token rejection, the hash-mismatch, cross-pilot and same-pilot link cases, atomic
completion with no orphan flight, the attempts cap, the closed error-code list, no key fallback, and
unchanged raw records. The route tests cover closed-by-default, token-only auth, lease → read → complete with
the stored track, same-pilot linking that keeps the existing track, the cross-pilot refusal, rejected reports that
store nothing, and fenced retry and fail. They use the same Miniflare setup as the existing device tests. Running it needs the
same runtime admission as those suites.
