# Ledge Top Logs: controller sign-in bootstrap (for Merger)

This is a plan, not a record of anything deployed. Source: branch `claude/logs-device-api`. Do the steps
in this order, separately in each account (staging first, then production). Owner of every deploy,
binding, route and Access change: Merger.

## What talks to what

- **Ops → Logs** (`FLIGHT_LOGS`, entrypoint `FlightLogsService`): staff actions, such as the flight list,
  import, approving a controller sign-in, and listing or revoking controllers.
- **Logs → Ops** (`OPS_DIRECTORY`, entrypoint `StaffDirectory`): exactly two lookups. Which active staff
  id owns this exact username, and is this staff id still active. It returns ids only.
- **Controllers → Logs**, public: `https://logs.ledgetop.app/api/v1/device/*`, authenticated by device
  tokens (only their SHA-256 is stored). **The logs host has no Cloudflare Access at all** (Beau,
  2026-11-12; Hub decision 40c0c790): it serves only `/api/v1/device/*` and `/health`, and the Worker
  returns 404 for every other path. There is no UI on this host. Staff use Ops for everything else.

## Is the two-way binding a deployment cycle?

A service binding names a Worker script and an entrypoint, and that Worker should already exist when
the binding is deployed. Both Workers already exist as bootstrap scripts (`ledge-top-logs` and the Ops
Worker). So there is no chicken-and-egg problem **if the entrypoint each binding names is deployed
first**. Not yet verified: whether Wrangler refuses a binding to a named entrypoint that the target
hasn't deployed yet, or accepts it and fails at call time. Check with `wrangler deploy --dry-run` in
staging before relying on either behaviour. The order below never depends on it.

## Order (per account)

1. **Ops, step 1:** deploy Ops with migration `0241_staff_usernames.sql` and the `StaffDirectory` named
   export (0241 adds the separate `staff_usernames` table; `staff_users` is never updated). No binding
   changes yet. Then an administrator sets usernames in Flight logs → Controller usernames (audited as
   `flight_logs.username.set`): `bkoltz` for Beau and `kstirn` for Kollin. Staff without a username can't
   sign in on a controller.
2. **Logs:** apply D1 migrations `0001` then `0002` to `ledge-top-logs(-staging)`. Deploy the logs Worker
   with the `OPS_DIRECTORY` service binding to the Ops script, entrypoint `StaffDirectory`, plus its
   existing D1, R2 and secrets. Without `OPS_DIRECTORY` every controller sign-in fails closed (503), which
   is the intended safe default.
3. **Ops, step 2:** deploy Ops with the `FLIGHT_LOGS` binding to `ledge-top-logs(-staging)`, entrypoint
   `FlightLogsService`.
4. **Route:** point `logs.ledgetop.app` (staging: `ledge-top-logs-staging.ledge-top-staging.workers.dev`) at the
   logs Worker with **no Cloudflare Access application** on the host. The Worker answers only
   `/api/v1/device/*` and `/health` and returns 404 for everything else. Activate this only after Beau answers
   Hub decision 40c0c790.
   Before step 4, the device API is unreachable, which is also safe.

## Rollback

- Remove the public device route: controllers stop and their queued logs wait on the device.
- Removing `OPS_DIRECTORY` makes sign-in and uploads fail closed.
- No step deletes data. Raw logs are write-once in R2 and are kept forever.

## Acceptance (staging, with the RC Plus 2)

1. A sign-in by username works, and approval only appears in that person's own Ops session.
2. The device token is collected exactly once.
3. Uploads deduplicate by SHA-256 and keep their first attribution.
4. A revoked controller is refused at once.
5. A pilot deactivated in Ops is refused within 60 s (`DEVICE_LIMITS.activeCacheMs`).
6. Raw logs show `needs_parse` until the decoder handles them.

## Controller app builds (exact hosts compiled in)

- Production: `build.ps1` with no host flags; it talks only to `https://logs.ledgetop.app`.
- Staging: `build.ps1 -StagingHost ledge-top-logs-staging.ledge-top-staging.workers.dev`, the host
  Merger confirmed on 2026-11-12 (Staging account). It adds exactly that one host.
- `-TestBuild` (loopback, debuggable, named `*-TEST-loopback-*`) is for local testing only. Never install
  it for real use.

Every build runs `test/ServerPolicyTest.java` first and fails if any server rule breaks.
