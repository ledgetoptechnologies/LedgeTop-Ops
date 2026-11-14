# Local DJI log decoder (Docker, RAM-only)

A small, pull-based runner that decodes raw DJI flight logs uploaded by controllers. It runs on Ledge Top's own local
processing machine as CPU offload only. **There is no cloud decoder:** no Cloudflare Container and no in-Worker parsing.

If that machine is off, nothing is lost. Raw logs and the queue stay in Logs (R2 + D1, durable and authoritative);
decoding waits and resumes when the runner is back. The runner keeps **nothing on disk**.

**Status: not enabled anywhere.** Every server side is closed by default. Turning it on needs:
- Merger's admission of the exact image, profile and window on the host;
- migration `0005_local_decoder_leases.sql` applied;
- review and qualification on real logs.

## How it fits

```
controller ──upload──▶ Logs public host (device API + /health only; everything else 404)
                         D1 raw_logs (the queue) + R2 raw originals
                                   ▲
                         private service binding → DecoderService (parser-only RPC, closed unless DECODER_ENABLED)
                                   │
            dedicated bridge Worker ledge-top-logs-decoder-bridge-staging (tiny auth/proxy, 404 for everything else)
                                   ▲
                         outbound HTTPS only: bearer token + audience
                                   │
                local runner (this container) ──▶ ltds-dji-decode ──▶ DJI Open API (keychains, logs v13+)
```

- **Bridge.** `apps/operations/src/worker/logs-decoder-bridge-worker.ts` serves `logs-decoder-bridge.ts`, configured
  by `apps/operations/wrangler.logs-decoder-bridge-staging.jsonc`.
  - Its only binding is `LOGS_DECODER` (Logs `DecoderService`): no staff app, assets, D1 or R2.
  - It's closed unless `LOGS_DECODER_ENABLED=true`, the binding, the exact host, the audience, `LOGS_DECODER_RUNNER_ID`
    and a token hash (`_NEXT` for rotation) are all set.
  - **It adds the runner identity from its own configuration**, so a runner can never claim as another.
  - The same module is also wired dormant in Ops, off by default.
- **`DecoderService`** never accepts a staff actor, pilot, URL or storage key, and returns fixed codes only.

## One log, start to finish

1. **Claim.**
   - At most one live lease across all runners, enforced in SQL.
   - Each claim has a fresh request id. Only an *exact* repeat (a lost claim reply) gets the same lease back.
   - A restarted process never adopts its predecessor's lease. It waits for it to expire (at most 5 minutes) and then
     takes it over with a fresh token. That counts as a reclaim, not an attempt.
2. **Read.** The held log is **streamed straight to tmpfs while hashed**, never held whole in Node, and capped at
   64 MiB. Its SHA-256 must equal the lease.
3. **Decode.** `ltds-dji-decode <input> <output>`:
   - no shell, only `PATH` plus the key **file path** (never the key itself, never on a command line);
   - a 4-minute limit;
   - killed immediately if the runner stops;
   - output capped at 96 MiB on tmpfs, then read once and deleted.

   The wrapper turns off its own core dumps (`PR_SET_DUMPABLE=0`, core limit 0) before reading anything.
4. **Check locally** with the same limits Logs enforces: at most 100,000 rows, at most 32 MiB of JSON, at most 8 MiB
   gzip. Anything over is suspended for review, never cut short.
5. **Heartbeat** every minute. If Logs says the lease is gone, the runner stops without reporting.
6. **Report:**
   - **`complete`.** The result is committed with a durable receipt. Replaying an identical result gets the receipt;
     a different result is refused.
   - **Lost reply.** The runner `reconcile`s for at most one lease period (or until it's told to stop), then lets the
     lease expire. It never retries forever or holds the result.
   - **`defer`** for the keychain, DJI, the network, rate limits or a missing raw object. Uses no attempt.
   - **`retry`** for a real decoder error. Uses an attempt; after 5 the log is `attempts_exhausted`.
   - **`suspend`**, visible and for review: `log_too_large` (over the limits) or `resource_capacity` (out of memory or
     tmpfs). No attempt, no disk spill, and never a permanent "corrupt".
   - **`fail`** for `corrupt_log`.
7. **Clean up scratch.** If it can't be verified clean, the runner exits instead of taking another log; the restart
   gives fresh tmpfs.

## Outages, crashes and restarts

| What happens | Result |
|---|---|
| Bridge or Logs unreachable, closed, 401, 429 or 5xx | Waits 5 s, 10 s … up to 5 min, keeping the same claim id, then carries on. Nothing is reported. |
| Shutdown (`SIGTERM`, `docker compose stop`) | Stops at once: the parser is killed, nothing is reported, and the log is offered again after its lease. A deliberate stop is honoured. |
| Host reboot or crash | `restart: unless-stopped` brings it back. The old lease expires and the log is taken over. No secret or state is persisted locally. |
| A log's leases keep expiring (20 reclaims) | Parked as `needs_review`, never `attempts_exhausted`. |

## RAM-only profile (staging, PROPOSED, unmeasured)

- **No disk use by design:**
  - no volumes or dataset mounts, and a read-only root filesystem;
  - all scratch on `tmpfs /work` (192 MiB, noexec) plus `/tmp` (8 MiB);
  - `memswap_limit = mem_limit` (no swap), to be verified as `memory.swap.max = 0` at admission;
  - `logging: none`.
- **Limits:** 1 CPU; 1 GiB memory shared by tmpfs, Node and the parser; Node heap 320 MiB; 64 pids; `init`; non-root
  (uid 1000); all capabilities dropped; `no-new-privileges`. No published ports, host network, Docker socket or
  privileged mode.
- **Budget (proposed, not yet measured):** tmpfs at most 192 MiB, Node heap at most 320 MiB, and about 400 MiB of
  parser native memory. This includes Node's external buffers and temporary JSON copies. **None of it is measured.**
  The real peak must be measured on the admitted host with real logs, smallest first, before the fit is claimed.
- **Core dumps:**
  - The parser is non-dumpable and has a core limit of 0.
  - `ulimits.core: 0` applies to the container.
  - The host's `core_pattern` pipes to apport, and the kernel ignores `RLIMIT_CORE` for piped helpers. So a synthetic
    crash on the actual host, admitted separately, must confirm that nothing is written for the Node process.
- **Unavoidable disk I/O, disclosed:** image layers when built or pulled, Docker's container metadata, and the two
  secret files.
- **Reserved:** `/var/lib/ledgetop-viewer-photo-staging` must not be touched.

## Parser

`ltds-dji-decode` (`parser/`) is a small Rust wrapper over the
[`dji-log-parser`](https://github.com/lvauvillier/dji-log-parser) library (MIT, © Luc Vauvillier and contributors).

- **Build:** inside the upstream workspace at v0.5.7, commit `e2e0775670a8391b4f7ecc40fca4cb01ea4a90fa`, against
  upstream's own `Cargo.lock`. The build fails if any existing lock entry changes; `libc` is already locked there at
  0.2.151.
- **Output:** the same `{version, details, frames}` JSON as the upstream CLI. It prints nothing; the outcome is its
  exit code:

| Exit code | Meaning |
|---|---|
| 0 | OK |
| 10 / 11 | Key missing or rejected (defer) |
| 12 | DJI unavailable (defer) |
| 13 | Network (defer) |
| 20 | Corrupt log (fail) |
| 30 | Out of scratch (suspend) |
| 137 or SIGKILL | Memory limit (suspend) |
| other | Decoder error (retry) |

The licence text ships in the image.

## Keys (v1 behaviour)

- **Keychains come from DJI every time.** For each v13+ log, the wrapper fetches that log's keychains from the DJI
  Open API, using this environment's key file. It does not use the per-log keychains already stored (sealed) in Logs
  from ODL imports, and it caches nothing. `KEYCHAIN_ENCRYPTION_KEY` stays with Logs, and those keychains never leave
  it.
- **DJI outages defer the log.** If DJI is unreachable or rate-limited, the log is deferred, using no attempt.
- **No key is needed for older logs** (before v13).
- **Not in v1:** reusing the stored keychains, which would mean releasing them to the runner. That would be a separate,
  reviewed feature.

## Configuration

| Variable | Meaning |
|---|---|
| `LOGS_ENVIRONMENT` | `staging` or `production`. Sets the audience `ledgetop-logs-decoder-<env>`. |
| `DECODER_BRIDGE_URL` | The bridge origin, `https`, with no path. |
| `DECODER_TOKEN_FILE` | File with the runner's bearer token. |
| `DJI_API_KEY_FILE` | This environment's DJI key file. Its name must name the environment, with no fallback. |
| `DECODE_TIMEOUT_MS` | Per-log parser limit (default 240000, at most 600000). |

## Tests

`npm test` (Node 22+), 17 tests:

- **Frame mapping.**
- **The parser call**, as a real child process with a stand-in:
  - arguments, environment and exit codes;
  - output limits;
  - being killed on stop.
- **End to end:** this runner over HTTP, in the bridge's wire format, against the real Logs decoder functions on
  D1 + R2 in Miniflare. It covers:
  - success, defer, fail and suspend;
  - an outage with backoff, and shutdown during an outage;
  - a lost claim reply, and a lost completion reply;
  - a crash and takeover, with the stale attempt refused;
  - scratch-clean failure;
  - a wrong token.

It doesn't need Docker, Rust, a DJI key or a real log. The Rust wrapper is compiled only in the Docker build.
