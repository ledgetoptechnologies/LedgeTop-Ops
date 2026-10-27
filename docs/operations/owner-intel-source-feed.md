# Owner Intel GSC and own-site source feed

This implementation adds a source-only Hermes path for `search_console_summary`
and `own_site`. It follows Owner Intel observation draft rev 3, version 3,
SHA-256 `ff354e29fbb8e751317db502e18b3654af42f24652a30e67eb61bb60cde0e567`.
The frozen v1 observation schema and receiver remain unchanged. New source kinds
are dispatched separately when the existing signed envelope carries
`semantics.observation: ci.obs.v2`; v1 requests fall through to the original
dispatcher. The source lane uses the same signed path, codec, headers, producer
key registry, and incoming-host boundary.

## Admission and retention

The source lane requires the existing
`COMPETITOR_INTEL_INGEST_ENABLED=true` setting, `ci_ingest_control.enabled=1`,
and a separate `owner_intel_source_control` row with both `enabled=1` and
`storage_accepted=1`. Migration 0229 defaults both source controls off. No
producer key, business, source binding, owner grant, Google permission, OAuth
credential, source fetch, schedule, or environment variable is added.

An active source binding stores the reviewed producer, Owner Intel binding and
configuration revision, kind, exact source subject, account reference, collector,
and kind-specific reviewed context. The verifier compares every observation
selector and provenance field to that stored context. GSC properties and result
pages are checked against exact reviewed domain or URL-prefix scope; own-site
page URLs and canonical domains are checked against the exact reviewed lists.
Only GSC and own-site are admitted in this lane. GA4, Ads, social observations,
commands, and browser/provider fetches are not admitted.

Every accepted observation receives an immutable raw-body, normalized payload,
receipt, operation ID, producer-key revision, payload digest, source epoch and
counter. Same-body replay returns the original receipt. Operation ID conflicts,
sequence reuse, epoch regression, changed reviewed context, unauthorized
business/binding membership, or stale transaction witnesses fail closed. Source
history and source DTO projections cannot be updated or deleted. GSC read
projections are kept per exact 7, 28, and 90 day observation period; a lower
ordered event cannot replace a newer projection for that same period. A request
for a range without an exact signed period returns `intel_range_unavailable`;
the service does not synthesize a shorter range from aggregate totals or top
rows. Every other accepted source kind uses its ordered subject head.

## Owner read API DTOs

Both endpoints retain the existing authenticated owner, native-admission,
explicit `intel.owner.read`, deny-precedence, and current-binding rechecks.
Source projection integrity, signed-source receipt, latest range/kind head and
reviewed context are revalidated before returning a DTO.

`GET /api/intel/:key/search-console?range=7d|28d|90d` returns:

```ts
{
  site: { url: string },
  range: { start: string; end: string }, // exact inclusive source period
  freshness: { fetchedAt: string; stale: boolean },
  totals: { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null },
  previous: null,
  queries: Array<{ query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }>,
  pages: Array<{ url: string; clicks: number; impressions: number; ctr: number | null; position: number | null }>,
  daily: Array<{ date: string; clicks: number; impressions: number }>,
  comparison: { previousPeriod: { start: string; end: string; days: number }; clicksDeltaPercent: string | null; impressionsDeltaPercent: string | null } | null,
  coverage: { state: string; reason: string | null; lastDataDate: string | null; dataRange: { start: string; end: string } | null;
    partial: boolean; partialReason: string | null; limits: string[]; asOf: string | null; rangeSelection: '7d' | '28d' | '90d' },
  receipt: { operationId: string; payloadSha256: string; completedAt: string; acceptedAt: string }
}
```

CTR is a fraction in this UI DTO (`10%` is `0.1`); the signed v2 payload stores
percent units (`10`). Unknown CTR and position remain `null`. No prior-period
totals are inferred from percentage deltas. `freshness.stale` is true only when
the source explicitly reports `source_stale`; no age threshold is invented.

`GET /api/intel/:key/website?range=7d|28d|90d` returns the Hermes own-site
monitor rather than analytics:

```ts
{
  schema: 'ops.intel.website-monitor.v1',
  site: { canonicalDomain: string },
  range: { start: string; end: string }, // requested UTC change window
  freshness: { fetchedAt: string; stale: boolean },
  monitoredPages: Array<SourceRef & { contentSha256: string; contentLength: number }>,
  changesSincePrevious: Array<Change>, // filtered inclusively to range
  technical: { httpsOk: StatedBoolean; sitemapPageCount: StatedNumber; robotsAllowsIndexing: StatedBoolean; avgFetchMs: number | null },
  provenance: { source: string; sourceAccountRef: string | null; collectedBy: string; collectedAt: string; asOf: string | null;
    lastDataDate: string | null; dataRange: { start: string; end: string } | null; partial: boolean; partialReason: string | null; limits: string[] },
  receipt: { operationId: string; payloadSha256: string; completedAt: string; acceptedAt: string }
}
```

The website range describes only the requested UTC window used to filter
`changesSincePrevious`; `freshness.fetchedAt`/provenance retain the source's
actual collection time. The DTO intentionally contains no GA4 fields, no Ads
fields, and no fabricated zeros for unknown monitored facts.

## Operational scope

This change ships the verifier, persistence, projection, and authorized read
paths. Migration 0229 remains default-off and contains no identities, keys,
allowlists, or owner grants. It does not contact Google or the Hermes host and
does not activate the feed. Provider credentials and existing Hermes pipeline
behavior remain outside Operations. Exact source context and owner grants must
be reviewed and provisioned through a separate controlled process before any
accepted feed is possible.
