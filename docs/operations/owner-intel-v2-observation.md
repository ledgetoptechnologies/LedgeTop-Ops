# Owner Intel v2 observation validator preparation

This module is an unactivated, pure validator. No ingest route imports it. It
adds no SQL, migration, key, binding, grant, flag, provider request or credential
handling. The existing frozen v1 validator continues rejecting these new kinds.
Passing validation establishes schema/context consistency, not a connection to
Google or proof that a provider claim is true.

Reference: `ledge-top-ops / competitor-intel/drafts/v2-owner-intel-kinds-draft-20261025.md`,
version 3, SHA-256 `ff354e29fbb8e751317db502e18b3654af42f24652a30e67eb61bb60cde0e567`.
The draft and this preparation remain unactivated. The prepared kinds are
`search_console_summary`, `ga4_summary`, `own_site`, and `social_presence`, under
envelope `ci.observation.v1` with `semantics.observation: ci.obs.v2`. GA4 follows
the explicit draft3 `providerLimits` addition; this does not connect a provider.
Own Ads/Money are excluded; extra financial fields fail strict validation.

## Required reviewed context

`validateOwnerIntelV2Observation(bytes, reviewedContext, now)` requires exact
producer ID, monitoring binding ID, configuration revision, kind, subject,
source, source-account reference and collector. The context must come from an
independently reviewed control plane; there is no default tenant, identity
lookup, producer-supplied context or name-based inference.

Context also supplies exact reviewed property scopes, own-site canonical
domains/pages, social owner subjects/profile URLs/evidence pages, and the
three-day provider-lag structural bound. It contains no per-observation
thresholding, sampling, source-staleness or data-returned assertions. Those
provider facts cannot be independently proved by a schema validator.

GSC `siteUrl` must match an exact reviewed property. A reviewed Domain property
admits only the matching domain or its real subdomains; a reviewed URL-prefix
property admits only its exact origin and path prefix. This follows Google's
[property scope documentation](https://support.google.com/webmasters/answer/34592?hl=en).
The [Sites API](https://developers.google.com/webmaster-tools/v1/sites) identifies
Domain properties as `sc-domain:example.com`; they are not HTTP URLs. Newly
published result pages within that reviewed property need no manual page-list
entry. Credentials, lookalike hosts, unrelated subdomains, non-HTTP URLs and
out-of-prefix paths are rejected. Nothing fetches a result URL.

Own-site monitoring and changed-page SourceRefs use the exact fixed page list,
without crawler expansion. Social profile URLs and evidence-page URLs must
also match their respective exact lists. A source's display name or URL never
selects a tenant or creates authority.

## Structural and evidence rules

The validator reuses the unchanged frozen UTF-8/duplicate-key/depth decoder and
enforces 256 KiB before decoding. Every object is strict. Integers are safe
nonnegative counts, decimals have at most six fractional places, and dates are
real calendar dates. Inclusive periods contain 1–93 days. Daily dates must be
unique, ascending and inside the period. Only GSC daily and GA4 daily have the
93-row exception; every other prepared array has an explicit limit of 50 or
less, including the smaller 25/20/10/5 limits in the draft.

Provenance enforces partial/reason equivalence, ordered data ranges,
`asOf <= collectedAt <= completedAt`, and last-data-date bounds. Observed data
requires non-null `asOf`; missing data never becomes fabricated success or zero.
No new freshness TTL, background refresh or provider connection is invented.

GSC observed totals require known clicks and impressions; non-observed totals
have all metric values null. CTR is null at zero impressions and otherwise must
equal clicks/impressions × 100 rounded HALF-UP to six decimal places, including
zero clicks. Exact integer arithmetic preserves that rounding at safe-integer
count limits; draft2's former 0.01 tolerance is not retained. Equivalent decimal
trailing-zero representations are accepted; seventh fractional places are not.
Google's [API CTR value](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
is a fraction; conversion into this draft's percent field is the producer's
responsibility. An unavailable average position at positive impressions needs
a nonempty limitation. No average position is replaced by zero.

A period with actual data and omitted daily dates needs nonempty `limits`,
including known daily/top rows with unknown/null aggregate totals. Empty unknown
or no-covered-day reports do not acquire a fabricated missing-day disclosure.
The mixed unknown-aggregate/sparse-known-row regression first failed on frozen
`ac1685c5` before this follow-up moved the check to payload-derived data presence. Prose
accuracy and whether it names every omitted date cannot be machine-proved from
this unstructured field. Unknown source gaps cannot be encoded as old provider
delay: `provider_data_delay` requires a recent overlapping requested range and
a limitation. Each derived missing date must be between the UTC collection date
minus three days and the collection date, inclusive. The last known data date
may precede that missing window; it is not incorrectly treated as a missing date.
This checks temporal compatibility, not Google's actual processing state or
whether a returned day remains provisional. `source_stale` retains its date and cause
limitation; no-covered-day fixtures retain unknown/null totals.

## GA4 schema preparation

Connected/report-bearing observations require an exact reviewed non-null
`propertyRef`; it is never inferred from a label, source account or binding name.
Observed totals need at least one reported non-null metric. Missing totals,
daily, channel and landing-page metrics stay null rather than becoming zeros.
Missing metrics alone do not require a limitation in draft3. Counts are compared
only when both are known (`newUsers <= activeUsers` and
`engagedSessions <= sessions`). Daily dates share the period/order/gap rules.

Both `providerLimits.thresholded` and `.sampled` must be reported booleans when
data/reports exist; a mixed null/boolean pair is invalid. A no-response state
(including failed or not connected) carries two null flags and no invented data
or source-time/range facts. Either true flag requires partial/data_limited and
nonempty limitation text. `provider_data_delay` is invalid for GA4. These remain
authenticated producer claims rather than provider-signed evidence.

The null-property exception remains limited to `not_connected` with
`consent_missing` or `no_property_selected`, null totals and flags, empty data
arrays, null asOf/lastDataDate/dataRange, and no partial-success claim. An empty
reviewed property list is valid for that honest no-connection state. No consent,
Google scope, account selection, access grant or provider call is implemented.
Only declared report fields are admitted, without user-level identifier fields.
The validator cannot independently prove that producer-supplied dimension
strings or prose are free of PII; collection/redaction remains producer work.

## Explicit implementation clarifications

These clarifications were supplied during review; they do not activate a feed:

- Own-site changes use the v1 `SourceRef` shape for `pageUrl`.
- Own-site data is present when a successfully fetched monitored page, change,
  non-null measured fetch time, or observed technical fact is present. A measured
  zero or observed false remains a real fact and requires `asOf`.
- Social data is present when at least one profile-found, follower or last-post
  value is observed. Missing facts retain their evidence state and null value.
- No caller `dataReturned` flag can override payload-derived data presence.
- Limitation text is required where the draft calls for disclosure, but its
  factual accuracy is not asserted by validation.
- GA4 uses draft3's explicit reviewed addition for provider metadata. The
  [GA4 response metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData)
  separately identifies thresholding and sampling; those are not provider-data
  delay. No ad-hoc provider assertions are added to reviewed binding context.

Synthetic tests cover observed, partial and unknown/not-connected fixtures;
inclusive dates, ordering, daily and other array bounds; state/null consistency;
provenance ordering, CTR/count/decimal constraints, stale-source delay misuse,
exact context and page scopes, UTF-8/depth/duplicate/byte limits, and rejection
by the unchanged v1 validator. No test calls Google or any source website.

## Canonical peer fixture receipt and unresolved conflict

The locally supplied canonical fixture note has SHA-256
`14d8fdeadbc2b50acc27c48d53c3946eb7c46499ad2fb1ebbfaafe6b7cecd8d4`.
It contains only 23 complete inline JSON fixtures; 45 others are listed by hash
without bytes. The opt-in test harness uses `OWNER_INTEL_V2_FIXTURE_NOTE` to read
that supplied artifact, verifies its exact hash and each of the 23 UTF-8 fixture
hashes, then strips `headers` TEST metadata before schema validation. It also
verifies the ten positive TEST Ed25519 signatures using the unchanged frozen
codec. It neither fetches fixtures nor contacts a provider.

Of those 23 available fixtures, 22 outcomes agree. The positive
`ga4-unknown-no-property-selected.json` conflicts with the draft's
not_connected-only null-property rule: it supplies `state: unknown` and a null
property. Review explicitly retained the stricter prose rule pending an agreed
fixture correction or draft change. The harness asserts and reports that exact
conflict; it does not reclassify it as passing. No claim is made that all 68
fixtures ran or passed. The remaining 45 bytes and that contract conflict must
be reconciled before a complete interoperability receipt can be issued.
