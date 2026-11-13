# Logs and Operations Staging Source Contract

This source composition is based on `main` at `4f597c7b9799146974a3fb51ecc87b2e8b2cd544`, with the reviewed Logs source at `7ec438fe237781db6be3c0a90576b1654c18b3a0` and its Ops directory binding followup `c77241f2d7e50c630898dded004ac1a21c8fd09f`. The Ops UI and route integration comes from `be67941ee45bee0450ab43f35467b4b080d0a295` and is limited to flight-log and staff-directory files plus the minimal route/nav and worker registration changes.

## Worker contracts

- `ledge-top-ops-staging` in account `df3f376bae6ee621f50cf972ebcc9484` exposes `StaffDirectory` to Logs. Its only methods resolve an explicitly assigned username to an active staff id and confirm whether a staff id is active; it returns no names, email addresses, or permissions.
- `ledge-top-logs-staging` exports `FlightLogsService`. Ops calls it through `FLIGHT_LOGS` for staff flight-log reads, controller sign-ins, and owner/admin imports.
- Ops authenticates the staff member and sends the stable staff id plus only `flight_logs.view` and `flight_logs.import` permissions. The Logs Worker applies the own-flight scope unless the actor has `flight_logs.view`.
- The Operations Fleet page is staff-only. Client Portal routes and bindings are not added.
- The browser import handles existing OpenDroneLog backup files locally, including Parquet-backed backups. This does not add a decoder or ingestion pipeline for raw DJI text files.

## Closed Staging profile

`apps/operations/wrangler.logs-staging-account.jsonc` binds only the Staging Ops D1 database and the Staging Logs `FlightLogsService`. It sets `FLIGHT_LOGS_ENABLED=false`, has no Workers.dev endpoint, preview URL, or custom route, and forwards `/fleet` through the Worker. Both the API route family and Ops `StaffDirectory` fail closed unless that flag is explicitly enabled. Logs remains private with its separate Staging D1/R2 resources and `OPS_DIRECTORY` binding.

This profile is configuration preparation, not a deployment receipt. Do not apply migrations, transfer data, enable the flag, admit Access users, or cut over domains until Merger reconciles the target schemas and migration ledger, transfer plan, closed Access configuration, and both service bindings. Keep production configuration unchanged and retain the legacy production-account staging dependencies until Merger verifies replacement acceptance.

## D1 suffix

The source Ops migration baseline ends at `0231_owner_google_ads_summary.sql`. This composition adds `0240_flight_logs_permissions.sql` and `0241_staff_usernames.sql`; no `0233`–`0235` inquiry migrations are included. The target Staging Ops D1 schema and migration history still require reconciliation before either migration is applied.
