# Raw DJI log decoding

**Status: implemented, closed by default, not enabled anywhere.** Decoding runs on Ledge Top's own local processing
machine in Docker (`apps/logs-decoder`). There is no Cloudflare Container and no in-Worker parsing. If that machine is
down, decoding waits: raw logs and the queue stay in Logs and nothing is lost.

Needs migration `0005_local_decoder_leases.sql` (reserved by Merger; 0004 is pairing).

## Surfaces

- **Public Logs host:** unchanged. It serves the controller device API and `/health`, and every other path is 404.
  The decoder never uses it.
- **`DecoderService`** (`src/worker/index.mjs`) is a parser-only RPC entrypoint, reached only through a private
  service binding from the machine bridge.
  - It's closed unless `DECODER_ENABLED` is `"true"`.
  - Methods: `claim`, `heartbeat`, `readRaw`, `complete`, `defer`, `retry`, `suspend`, `fail`, `reconcile`.
  - It takes the bridge-configured runner id with a claim request id, or the lease it handed out, and the result
    for that lease. It never accepts a staff actor, pilot, URL or storage key.
  - Errors are fixed codes only. Unexpected exceptions are logged as a fixed category, never their text.
- **Machine bridge** (`apps/operations/src/worker/logs-decoder-bridge.ts`): `POST /api/machine/logs-decoder/*`.
  - It's served by the dedicated tiny Worker `ledge-top-logs-decoder-bridge-staging`
    (`logs-decoder-bridge-worker.ts`, `wrangler.logs-decoder-bridge-staging.jsonc`). Its only binding is
    `LOGS_DECODER`, and everything else is 404. It's also wired dormant in Ops, off by default.
  - It's closed unless enabled, bound, and the exact host, audience, `LOGS_DECODER_RUNNER_ID` and a token hash
    (`_NEXT` for rotation) are all set.
  - It supplies the runner id itself, so a runner can't claim as another.

## Contract (`src/worker/decode-contract.mjs`)

- **Raw logs are kept forever.** No transition deletes or rewrites a `raw_logs` row's pilot, device, source, upload
  time or R2 key, or the R2 object.
- **Attribution never moves.** A decoded flight gets the raw row's own `pilot_id` (`controller_sign_in`) and
  `file_hash`. An existing flight with that hash is linked only for the same pilot, and keeps its own track. Another
  pilot's flight is an `attribution_conflict`: nothing is linked. Raw uploads follow the same rule (`device.mjs`).
- **Claim.**
  - **Just in time, per runner:** the claim is keyed `runnerId:requestId`. Only an exact repeat returns the same
    lease (a lost claim reply). Any other claim, including a restarted process of the same runner, never adopts a
    live lease; it waits for expiry and takes over with a fresh token.
  - **One at a time:** at most `MAX_OCCUPANCY` (1) live leases across all runners, enforced inside the claim's own
    statement.
  - **No attempt used:** claiming doesn't count against `parse_attempts`.
- **Heartbeat** extends the lease (`LEASE_SECONDS`) of the exact live attempt only.
- **Expired leases** (crash, outage, power-off) are taken over as **reclaims**, not parse attempts. After
  `MAX_RECLAIMS` (20) the row is parked as `needs_review`, never `attempts_exhausted`.
- **Complete.** One D1 batch with a durable receipt: `committed_attempt_token`, `result_fingerprint` (over the
  canonical summary, the track bytes' SHA-256 and the decoder version) and `decoder_version`.
  - An identical replay returns the original receipt.
  - A different result, or another attempt, is refused (`result_conflict` or `lease_stale`) and never swapped in.
- **Reconcile** after a lost reply: `decoded` (only for the committing attempt), `held`, or `lost`.
- **Outcomes, closed vocabularies:**

| Outcome | Codes | Effect |
|---|---|---|
| `defer` | `keychain_unavailable`, `dji_unavailable`, `network_unavailable`, `rate_limited`, `raw_missing` | Waits (`next_attempt_at`, 1 min – 6 h). No attempt used. |
| `retry` | `decoder_error` | Uses an attempt and backs off (2, 4, 8 … min, at most 1 h). After `MAX_ATTEMPTS` (5): `attempts_exhausted`. |
| `suspend` | `log_too_large`, `resource_capacity` | Visible, for review; not a verdict on the log. No attempt used. |
| `fail` | `unsupported_version`, `corrupt_log`, `attribution_conflict` | Closes the row. The raw log is kept. |
| parked | `needs_review` | Set by the server only. |

  Raw decoder messages, keys and file contents are never stored or returned.

## Results (`src/worker/decoder-service.mjs`)

- **Checked before anything is stored:**
  - the content hash must equal the lease;
  - the summary is checked field by field (unknown fields refused, types and ranges checked, and it must agree with
    the track);
  - the track is gzip at most 8 MiB, at most 32 MiB expanded, at most 100,000 rows, schema `ltds.logs.telemetry.v1`,
    known columns only, one value per row, and values typed.
- **Never cut short.** The runner applies the same limits locally and suspends with `log_too_large` rather than
  recording part of a log.
- **Typed columns.** Values are typed per column class (`odl/map.mjs`): text (`flightMode`, `cellVoltages`), flag
  (`isPhoto`, `isVideo`), otherwise number. Null is always allowed.
- **Immutable, attempt-scoped storage.** The track is stored at `telemetry/v1/raw-<sha256>/<attempt>-<track>.json.gz`,
  unique to the attempt and the bytes, and is referenced only by the fenced commit. A stale attempt can therefore
  never overwrite or replace the winner's track. A test pauses a stale upload while another attempt commits.

## Keys

The DJI Open API key lives with the runner: one file per environment on the processing machine, with no fallback. It
is read only by the parser wrapper, never passed on a command line, and never sent to Logs or Ops. Keychains stored
from ODL imports stay sealed with `KEYCHAIN_ENCRYPTION_KEY` in Logs and are never returned.

## Tests

- `test/decode-contract.test.mjs`, on a real D1 in Miniflare: claim idempotency and occupancy (including concurrent
  same-id claims), reclaim parking, heartbeat fencing, defer, retry and the caps, receipts and conflicts, the stale
  attempt, same-pilot linking, and reconcile.
- `test/decoder-service.test.mjs`, on the real Worker in Miniflare:
  - strict summary and track limits;
  - attempt-scoped storage, and the paused stale upload;
  - the public host returning 404 for decoder paths;
  - the closed-by-default and working RPC through a service binding.
