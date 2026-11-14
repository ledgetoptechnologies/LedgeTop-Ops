# Local DJI log decoder (Docker)

A small, pull-based runner that decodes raw DJI flight logs uploaded by controllers. It runs on Ledge Top's own
local processing machine. **There is no cloud decoder:** no Cloudflare Container and no in-Worker parsing.

If that machine is off, nothing is lost. Raw logs and the queue stay in Logs (D1 + R2); decoding simply waits and
resumes when the runner is back.

**Status: not enabled anywhere.** Every server side is closed by default. Turning it on needs Merger's admission on
the host, the decoder-queue migration (number pending), review, and qualification on real logs.

## How it fits

```
controller ──upload──▶ Logs public host (device API + /health only)
                         D1 raw_logs (the queue) + R2 raw originals
                                   ▲
                         private service binding (DecoderService RPC, parser-only)
                                   │
                       Ops machine bridge  /api/machine/logs-decoder/*  (its own exact host, before staff middleware)
                                   ▲
                         outbound HTTPS only, bearer token + audience
                                   │
                local runner (this container) ──▶ ltds-dji-decode ──▶ DJI Open API (keychains, logs v13+)
```

- **The public Logs host is unchanged.** It serves the device API and `/health`, and every other path is 404. The
  runner never talks to it.
- **The Ops bridge** (`apps/operations/src/worker/logs-decoder-bridge.ts`) only answers on `LOGS_DECODER_MACHINE_HOST`.
  It's closed unless `LOGS_DECODER_ENABLED=true`, the `LOGS_DECODER` binding, the audience and a token hash are all
  configured.
  - **Auth:** a dedicated bearer token per runner. Ops keeps only its SHA-256, with `…_NEXT` for rotation. The
    request must also name the audience `ledgetop-logs-decoder-<environment>`. No staff session, cookie, account
    token or storage credential is involved.
- **The Logs `DecoderService`** (`apps/logs/src/worker/decoder-service.mjs` and `decode-contract.mjs`) is reached only
  through that binding. It takes a claim request id or the lease it handed out, and the result for that lease.
  It never accepts a pilot, URL, storage key or staff actor.

## One log, start to finish

1. **Claim.** `claim {requestId}` returns at most one lease, live leases being capped at one across all runners
   (enforced in SQL). A lost claim reply is safe: the runner repeats it with the same `requestId` and gets the same
   lease.
2. **Read.** `raw` returns the bytes of the held log only. The runner checks their SHA-256 against the lease and
   keeps them on disk (at most 128 MiB).
3. **Decode.** It runs `ltds-dji-decode <input> <output>`. The process is called directly, with no shell. The DJI key
   is read by the wrapper from `DJI_API_KEY_FILE` and is never on the command line. The parser gets only `PATH` and
   that file path, a 4-minute limit, and an output cap of 192 MiB. Frames are mapped to the
   `ltds.logs.telemetry.v1` track, using the same column names ODL imports use, plus a checked summary.
4. **Heartbeat** every minute while working. If Logs says the lease is gone, the runner stops without reporting.
5. **Report:**
   - **`complete`.** Logs checks everything before storing anything:
     - the hash, and a strict summary;
     - the track: gzip at most 8 MiB, at most 32 MiB once expanded, at most 100,000 rows, known columns only, and
       one value per row.
     
     The track is stored under a key unique to this attempt and these bytes, and the flight is written by the fenced
     atomic commit with a durable receipt (attempt and fingerprint). Replaying an identical result returns the
     original receipt; a different result is refused.
   - **Lost reply:** the runner calls `reconcile` (the result is decoded, still held, or lost) instead of re-sending
     blindly.
   - **`defer`** is for problems outside the log: the keychain, DJI, the network or rate limits. It uses no parse
     attempt and waits 5–30 minutes.
   - **`retry`** is for a real decoder error. It uses an attempt and backs off; after 5 the log is
     `attempts_exhausted`.
   - **`fail`** is for something wrong with the log itself: `corrupt_log` or `log_too_large`. A log is never cut
     short.

The pilot is always the raw log's own pilot from the controller sign-in. An existing flight with the same hash is
linked only for the same pilot, and keeps its own track.

## Outages, crashes and restarts

| What happens | Result |
|---|---|
| Bridge or Logs unreachable, closed, 401, 429 or 5xx | Waits 5 s, 10 s … up to 5 min, keeping the same claim id, then carries on. Nothing is reported. |
| Runner stops mid-decode (reboot, crash, power-off) | The lease expires and the log is offered again. This counts as a reclaim, not a parse attempt. The old attempt's reports are refused. |
| A log's leases keep expiring (20 reclaims) | Parked as `needs_review`, never marked `attempts_exhausted`. A reviewer decides. |
| DJI, keychain or network trouble | `defer`: no attempt used. |

`restart: unless-stopped` and `init: true` bring the container back after a reboot. `SIGTERM` finishes the current
log first.

## Resource profile (staging, proposed)

- **Limits:** one log at a time; 1 CPU; 1 GiB memory with swap equal (no swap); 64 pids; no file over 256 MiB; Node
  heap 640 MiB.
- **Scratch:** on disk under the dedicated root `/var/lib/ledgetop-logs-decoder-staging/work`, holding one log and its
  output at a time and deleted after each log.
- **Container:** read-only root filesystem, non-root (uid 1000), all capabilities dropped, `no-new-privileges`.
- **Network:** no published ports, host network, Docker socket or privileged mode. Outbound connections only.
- **Logging:** only short hash prefixes and outcome codes.
- `/var/lib/ledgetop-viewer-photo-staging` is reserved and must not be touched.

## Parser

`ltds-dji-decode` (`parser/`) is a small Rust wrapper over the
[`dji-log-parser`](https://github.com/lvauvillier/dji-log-parser) library (MIT, © Luc Vauvillier and contributors).
It's built inside the upstream workspace at v0.5.7, commit `e2e0775670a8391b4f7ecc40fca4cb01ea4a90fa`, against
upstream's own `Cargo.lock`; the build fails if any existing lock entry changes. It writes the same
`{version, details, frames}` JSON as the upstream CLI. It prints nothing; the outcome is its exit code:

| Exit code | Meaning |
|---|---|
| 0 | OK |
| 10 / 11 | Key missing or rejected |
| 12 | DJI unavailable |
| 13 | Network |
| 20 | Corrupt log |
| other | Decoder error |

The licence text ships in the image.

## Configuration

| Variable | Meaning |
|---|---|
| `LOGS_ENVIRONMENT` | `staging` or `production`. Sets the audience `ledgetop-logs-decoder-<env>`. |
| `DECODER_BRIDGE_URL` | The admitted Ops machine host, `https`, with no path. |
| `DECODER_TOKEN_FILE` | File with the runner's bearer token. |
| `DJI_API_KEY_FILE` | This environment's DJI key file. Its name must name the environment, with no fallback. |
| `DECODE_TIMEOUT_MS` | Per-log parser limit (default 240000, at most 600000). |

## Tests

`npm test` (Node 22+) runs:

- the frame mapping;
- the parser call, as a real child process with a stand-in: arguments, environment, exit codes and limits;
- an end-to-end run of this runner over HTTP, in the bridge's wire format, against the real Logs decoder functions on
  D1 + R2 in Miniflare. It covers success, defer and fail outcomes, an outage with backoff, a lost claim reply, a
  lost completion reply (reconciled), a crash with a stale attempt refused, and a wrong token.

It needs `apps/logs` dependencies (Miniflare). It doesn't need Docker, Rust, a DJI key or a real log. The Rust
wrapper is compiled only in the Docker build.
