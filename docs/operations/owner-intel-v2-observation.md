# Owner Intel v2 observation validator preparation

This module is an unactivated, pure validator. No ingest route imports it. It
adds no SQL, migration, key, binding, grant, flag, provider request or credential
handling. The existing frozen v1 validator continues rejecting these new kinds.
Passing validation establishes schema/context consistency, not a connection to
Google or proof that a provider claim is true.

Reference: `ledge-top-ops / competitor-intel/drafts/v2-owner-intel-kinds-draft-20261025.md`,
version 2, SHA-256 `6e5f1525d3b391623e42e2e2e50a9e58413f74903847d781372bc282a89c4c0e`.
The draft and this preparation remain unactivated. The prepared kinds are
`search_console_summary`, `own_site`, and `social_presence`, under envelope
`ci.observation.v1` with `semantics.observation: ci.obs.v2`. GA4 remains rejected
until a canonical draft explicitly adds the reviewed `providerLimits` fields.
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
unique, ascending and inside the period. Only the GSC daily field has the
prepared 93-row exception; all other prepared arrays have explicit limits of
50 or less, including the smaller 25/20/10/5 limits in the draft. GA4's second
daily exception is not enabled while its schema remains pending.

Provenance enforces partial/reason equivalence, ordered data ranges,
`asOf <= collectedAt <= completedAt`, and last-data-date bounds. Observed data
requires non-null `asOf`; missing data never becomes fabricated success or zero.
No new freshness TTL, background refresh or provider connection is invented.

GSC observed totals require known clicks and impressions; non-observed totals
have all metric values null. CTR is null at zero impressions and otherwise must
equal clicks/impressions × 100 within 0.01, including zero clicks. Fixed-point
integer arithmetic preserves that tolerance at safe-integer count limits.
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
delay: `provider_data_delay` is structurally permitted only for a requested
range overlapping the configured recent three days, with `lastDataDate` inside
that bound and a limitation. This checks temporal compatibility, not Google's
actual processing state. `source_stale` retains its explicit date and cause
limitation; no-covered-day fixtures retain unknown/null totals.

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
- GA4 needs a canonical reviewed addition for provider metadata. The
  [GA4 response metadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData)
  separately identifies thresholding and sampling; those are not provider-data
  delay. No GA4 schema is silently extended in this version.

Synthetic tests cover observed, partial and unknown/not-connected fixtures;
inclusive dates, ordering, daily and other array bounds; state/null consistency;
provenance ordering, CTR/count/decimal constraints, stale-source delay misuse,
exact context and page scopes, UTF-8/depth/duplicate/byte limits, and rejection
by the unchanged v1 validator. No test calls Google or any source website.
