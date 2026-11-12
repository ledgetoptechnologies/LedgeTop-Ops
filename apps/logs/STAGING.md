# Flight Logs Cloudflare resources

The deployed Logs Workers are private bootstrap resources with status `setup_pending`. They do
not yet expose the `FlightLogsService` data path, have an Operations service binding, or accept
flight data. `workers_dev` is disabled in both configs. The R2 buckets have no custom domains,
and their public `r2.dev` endpoints are disabled.

| Environment | Cloudflare account | Worker | D1 database | R2 bucket |
| --- | --- | --- | --- | --- |
| Production | Ledge Top `846c924bf17bf4f3dd15c97a4c5d1d51` | `ledge-top-logs` | `ledge-top-logs` (`7f82ff71-d337-48c1-b04b-2e5d03a926cc`) | `ledge-top-logs` |
| Staging | Staging `df3f376bae6ee621f50cf972ebcc9484` | `ledge-top-logs-staging` | `ledge-top-logs-staging` (`33542156-96f0-4e83-8bf4-406cb1228640`) | `ledge-top-logs-staging` |

Use `wrangler.jsonc` for production and `wrangler.staging.jsonc` for staging. The account IDs,
resource names, and D1 UUIDs are verified. Keep each
environment's D1, R2, and secret resources in its listed account. Do not enable public Worker
access or the Ops `FLIGHT_LOGS` binding until the release owner completes the private service
setup, migration, authorization and acceptance work.

## Secrets and feature readiness

- Production reserves `DJI_API_KEY`; staging uses **`DJI_API_KEY_STAGING`**, as specified
  by Beau for the RC Plus 2 / M4E test. Save it only as a secret on `ledge-top-logs-staging`
  in the separate Staging account. Do not put either value in source, APKs, browser code,
  command arguments, logs or test receipts. Staging must not fall back to the production key.
  The keychain decoder adapter still needs implementation; these names are its required
  server-side credential contract, not a claim the current Worker consumes either secret.
  DJI API processing is not implemented; saving the key does not enable DJI integration.
  The intended credential is the activated DJI **Open API** application key used for flight-log
  keychain requests, rather than assuming any other DJI application key is interchangeable.
- `KEYCHAIN_ENCRYPTION_KEY` is separate. Generate an independent 32-byte secret for each account
  before importing real keychains. Never print, commit, or reuse it between production and staging.
- Operations can later bind `FLIGHT_LOGS` to `FlightLogsService` in the matching account.
  Flight Logs maps use Leaflet with Esri World Imagery and World Topographic tiles; no Mapbox
  token is required for these views. Operations must permit `https://server.arcgisonline.com`
  in its image CSP and retain visible Esri attribution. Other Operations maps may still use
  Mapbox independently. Preserve the private bootstrap state until the runtime is deployed
  and staging acceptance is complete.
