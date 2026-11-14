# Local DJI log decoder (Docker)

A small, pull-based runner that decodes raw DJI flight logs uploaded by controllers. It runs on Ledge Top's own
local processing machine. **There is no cloud decoder:** no Cloudflare Container and no in-Worker WASM.

If this machine is off, nothing is lost. Raw logs and the queue stay in Logs (D1 + R2); decoding simply waits and
resumes when the runner is back.

**Status: not enabled anywhere.** The Logs routes it uses are closed by default (see below). Turning it on needs
review, qualification on real logs, and an operator. It is not part of this change.

## How it works

```
controller ──upload──▶ Logs (R2 raw log + D1 raw_logs row, parse_status needs_parse)
                                  ▲   │
              lease / raw / report│   │ only for the lease it holds
                                  │   ▼
                       local runner (this container) ──▶ dji-log (pinned) ──▶ DJI Open API (keychains, v13+)
```

1. **Lease.** `POST /api/v1/decoder/lease` claims one log, with a 5-minute lease and a one-time attempt token.
2. **Read.** `POST /api/v1/decoder/raw` returns the bytes of that log only. The runner checks the SHA-256 against the
   leased hash.
3. **Decode.** It runs `dji-log <file> --output frames.json --api-key <key>`: no shell, fixed arguments, a 4-minute
   limit, and only `PATH` passed on. The output is mapped to the same track columns ODL imports use
   (`ltds.logs.telemetry.v1`) plus a checked flight summary.
4. **Report.** `POST /api/v1/decoder/complete` stores the gzip track and records the flight, or the runner reports
   `retry` or `fail` with a closed error code. Every report is fenced by the lease token, so a late or repeated
   report can't create a second flight.

The pilot is always the raw log's own pilot from the controller sign-in. The decoder can't choose or change it.
An existing flight with the same hash is linked only for the same pilot, and keeps its own track. A different
pilot is an `attribution_conflict` and needs a reviewed reconciliation.

## Outages and restarts

| What happens | Result |
|---|---|
| Logs unreachable, 5xx, 429, or decoder routes switched off | Waits 5 s, 10 s, 20 s … up to 5 min, then carries on. Nothing is reported. |
| Runner stops mid-decode (reboot, crash, `docker stop`) | The lease expires and the log is offered again. The old attempt's report is refused (409). |
| Lease expired while decoding | The report is refused and the log is decoded again on its next lease. |
| Keychain fetch fails, parser error, raw bytes missing | `retry` with a closed code. After 5 attempts the log is `attempts_exhausted`. |
| Output has no frames | `fail` with `corrupt_log`. The raw log is always kept. |

`restart: unless-stopped` brings the container back after a reboot. On `SIGTERM` it finishes the current log
first.

## Security

- **Machine identity only.** A bearer token unique to this runner. Logs stores only its SHA-256 in
  `DECODER_TOKEN_SHA256`. The runner never uses a staff session or cookie.
- **Closed by default.** Unless `DECODER_ENABLED` is `"true"` and `DECODER_TOKEN_SHA256` is set, every
  `/api/v1/decoder/*` path returns 404, like an unknown path.
- **Narrow surface.** The runner can lease, read the bytes of a log it holds, and report that log. Leases carry no
  pilot, device or storage key. It can't list or read flights, choose a pilot, or name a URL or R2 key. The
  summary is checked field by field.
- **No arbitrary fetch or exec.** The client only calls `LOGS_URL` with fixed paths and refuses redirects. The
  parser runs with fixed arguments.
- **Secrets stay on this machine.** They're read from files (`*_FILE`) and are never in the image, the repo or
  Cloudflare. Each environment uses its own DJI key file, with no fallback to the other environment's key.
  Parser messages and keys are never logged or sent. Logs only receives closed error codes.
- **Container hardening.** It runs as a non-root user with a read-only root filesystem and a tmpfs for working
  copies (deleted after each log). All capabilities are dropped, `no-new-privileges` is set, and memory, CPU and
  pid limits apply.

## Parser

[`dji-log-parser`](https://github.com/lvauvillier/dji-log-parser) is MIT-licensed (© Luc Vauvillier and
contributors). The image builds its `dji-log` CLI from tag v0.5.7, commit
`e2e0775670a8391b4f7ecc40fca4cb01ea4a90fa`, with the upstream `Cargo.lock` (`--locked`). The CLI crate isn't
published to crates.io. The licence text ships in the image at `/usr/share/doc/dji-log-parser/LICENSE`.

## Configuration

| Variable | Meaning |
|---|---|
| `LOGS_ENVIRONMENT` | `staging` or `production`. Nothing else is accepted. |
| `LOGS_URL` | The Logs origin, `https`, with no path. |
| `DECODER_TOKEN_FILE` | File with the runner's bearer token. |
| `DJI_API_KEY_FILE` | File with this environment's DJI Open API key. The file name must name the environment. |
| `DECODE_TIMEOUT_MS` | Per-log parser limit (default 240000). |

## Running (operator, after enablement)

```sh
mkdir -p secrets && chmod 700 secrets      # write decoder_token_staging and dji_api_key_staging here
docker compose up -d --build
docker compose logs -f                     # only short hash prefixes and outcome codes are logged
```

The Logs side needs `DECODER_ENABLED=true` and `DECODER_TOKEN_SHA256=<sha256 of the token>` on that environment's
Worker, and the decoder routes reachable on its host. That's an operator change, made only after review.

## Tests

`npm test` (Node 22+) runs:

- the frame mapping;
- the parser wrapper, as a real child process with a stand-in;
- an end-to-end run of this runner against the real Logs decoder routes on D1 and R2 in Miniflare: success,
  closed codes, an outage with backoff, a crash mid-decode with a stale report, and a wrong token.

It needs `apps/logs` dependencies installed (for Miniflare). It doesn't need a DJI key, a real log or Docker.
