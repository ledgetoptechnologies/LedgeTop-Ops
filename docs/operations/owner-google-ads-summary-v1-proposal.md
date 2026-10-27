# Owner Google Ads summary contract (proposed)

Status: source preparation only. This is a new, unaccepted contract; it is not
part of the Owner Intel v2 draft3 contract. It does not enable an ingest lane,
connect OAuth, create an account mapping, grant access, or establish provider
truth. No account identifiers or seed bindings are included here.

## Separation from existing feeds

This feed represents an explicitly reviewed Ledge Top business's own Google
Ads advertiser account. It is not competitor `ad_activity`, an MCC-wide
roll-up, or a Client account. Each Owner Intel business has its own exact
binding. LTDS and LTT are never joined by display name, email, domain, or MCC
membership. A Doug Beahm client account or an unverified customer reference
must never be labeled as LTT.

The existing frozen v1 observation codec and receiver remain unchanged. Draft3
continues to cover `search_console_summary`, `own_site`, `social_presence`, and
`ga4_summary`; that draft explicitly excludes Owner Ads. This proposal defines
a separate signed envelope discriminator `ci.google_ads_owner.v1` and kind
`google_ads_summary`. Passing the validator proves only payload and reviewed
context consistency, not that Google returned the claimed measurements.

## Reviewed binding context

An active binding is keyed by the existing producer ID, Owner Intel binding ID,
exact current configuration revision, fixed subject `own:google-ads`, and kind
`google_ads_summary`. The binding is explicitly attached to the matching
reviewed `owner_intel_bindings` row and its business ID. It stores the exact
Google Ads manager customer ID and advertiser customer ID (10 digits without
hyphens), currency code, IANA account time zone, source account reference, and
collector. Context is immutable; replacement means a new configuration
revision. Payload values cannot choose the business, manager, advertiser,
currency, or time zone.

No binding means `not_configured`, not proof that a business has no Ads account.
Only an explicitly reviewed `no_account` binding may produce `no_account`; it
is not accepted as an observation for an account binding. The database starts with no
Ads bindings, no producer keys, no business status, and no grants.

## Observation envelope and payload

The signed JSON envelope uses the existing authenticated producer headers and
raw-byte signature process, with these fixed values:

```json
{
  "schemaVersion": "ci.observation.v1",
  "producerId": "reviewed producer",
  "operationId": "UUIDv4",
  "monitoringBindingId": "reviewed binding",
  "configurationRevision": 1,
  "observationKind": "google_ads_summary",
  "subjectKey": "own:google-ads",
  "sourceSequence": { "epoch": "1", "counter": "1" },
  "commandBinding": null,
  "observedAt": "RFC3339 UTC timestamp",
  "completedAt": "RFC3339 UTC timestamp",
  "semantics": { "observation": "ci.google_ads_owner.v1" },
  "payload": {
    "account": {
      "managerCustomerRef": "exact reviewed 10-digit manager customer ID",
      "advertiserCustomerRef": "exact reviewed 10-digit advertiser customer ID",
      "currencyCode": "USD",
      "timeZone": "America/Chicago"
    },
    "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "days": 7, "timeZone": "IANA zone" },
    "currencyCode": "ISO 4217 code",
    "totals": {
      "costMicros": "canonical nonnegative int64 decimal string or null",
      "impressions": "canonical nonnegative int64 decimal string or null",
      "clicks": "canonical nonnegative int64 decimal string or null",
      "conversions": "canonical nonnegative decimal string (bounded precision) or null",
      "state": "observed | unknown | failed | source_stale | no_account",
      "reason": null
    },
    "provenance": {
      "source": "google_ads_api",
      "sourceAccountRef": "exact advertiser customer ID",
      "collectedBy": "reviewed collector",
      "collectedAt": "RFC3339 UTC timestamp",
      "asOf": "RFC3339 UTC timestamp or null",
      "partial": false,
      "partialReason": null,
      "limits": []
    }
  }
}
```

All object keys are closed; duplicate keys, unknown keys, invalid UTF-8,
oversized bodies, unsafe timestamps, wrong scope or precision are rejected.
Periods are exactly 7, 28, or 90 fully closed local-calendar days in the bound
account's time zone. A historical fully closed period may be accepted and
retained as immutable history. The owner read only serves a projection whose
dates exactly match the latest fully closed 7/28/90-day window at read time; if
the newest accepted event is for an older window, the requested range is
reported unavailable rather than presented as current. The DTO always includes
the exact period dates. `timeZone` must be the canonical IANA/ICU zone name and
`currencyCode` must match the binding. An `observed` state requires `asOf` to
fall after the period's end in that account-local zone; incomplete, unknown,
failed, and stale metrics remain null. There is a separate sequence/range head
for each period; no shorter report is extrapolated into a longer range.

Google reports `cost_micros` as an integer measure and metrics in the
authorized customer's currency. The wire format uses canonical decimal strings
to avoid JavaScript precision loss; conversions remain a decimal string with a
finite accepted scale and are never rounded into a different value. Numeric
zero is observed zero only when the producer reports a complete successful
result. Unknown, failed, stale, or absent fields remain null and carry an
explicit state/reason; absence is never converted into zero.

## Storage, ingest, and read behavior

Migration 0231 is additive. It does not change migration 0229, v1 inbox checks,
existing history, retention, keys, grants, or bindings. New Ads control is
disabled by default. New reviewed binding/status rows and producer credentials
are absent. New inbox and audit records are append-only; updates/deletes are
rejected. Replay identity and `(binding, revision, subject, epoch, counter)`
sequence collisions are permanent conflicts. Operation IDs share a collision
fence with both existing v1 and Owner Intel v2 inboxes. Ingestion requires the
existing incoming-origin, authenticated signature/key, control-plane key,
current owner binding/revision, exact manager/advertiser/currency/time-zone
context, and new disabled-by-default Ads gate.

The owner read route is `GET /api/intel/:businessKey/google-ads?range=7d|28d|90d`.
It uses ordinary verified human authentication, existing global-owner and
current profile/admission checks, explicit `intel.owner.read` allow with deny
precedence, and an exact route-key-to-reviewed-business binding. Account IDs
and manager IDs are not exposed in the response. Read revalidates the owner
authority, business binding, configuration revision, period head, source
projection, and payload digest after fetching the stored projection. Response
states distinguish `observed`, `no_account`, `not_configured`, `awaiting_first_data`,
`range_unavailable`, `source_stale`, and provider `unknown`/`failed`; metric
fields remain null unless observed.

## Sources and verification boundary

- Google Ads API [authorization headers](https://developers.google.com/google-ads/api/rest/auth): API requests need OAuth credentials and a developer token; manager-context requests require the exact `login-customer-id` header.
- Google Ads API [access model](https://developers.google.com/google-ads/api/docs/oauth/access-model): Google Ads has no separate read-only OAuth scope. Read-only behavior must be enforced by existing account-role access plus a source implementation restricted to read/search calls; this Worker receiver does not call Google.
- Versioned Google Ads API [metrics fields](https://developers.google.com/google-ads/api/fields/v26/metrics) and [`Customer` fields](https://developers.google.com/google-ads/api/fields/v26/customer): the actual producer must bind the account currency/time zone and choose only the reviewed summary fields.

This source-only change cannot prove manager hierarchy, account roles, actual
LTDS/LTT customer mapping, producer accuracy, or a live read-only API response.
The lane remains disabled until the producer protocol is acknowledged, exact
business/account bindings are independently reviewed, and actual signed
provider-derived observations pass acceptance tests. GA4 remains skipped.
