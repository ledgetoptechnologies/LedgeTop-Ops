# Competitor Intel observation receiver candidate

This implementation is source preparation. It installs no producer key, binding,
business, staff grant, scan job or provider credential. No runtime configuration
or data is activated. The source includes a default-off machine dispatcher;
ordinary Operations human authentication and all other host admission remain
unchanged.

Reviewed references, treated as contract/reference material:

- `ledge-top-ops / competitor-intel/frozen/ingest-wire-envelope-v1.md`, version 1,
  SHA-256 `a60a11ddd68df90da80a1e2eaf298434369653d8e8f390b814ed906e7b675b32`.
- `ledge-top-ops / competitor-intel/frozen/command-intents-and-read-surface-v1.md`,
  version 1, SHA-256 `faf08a4afadfbdee37f7928aac71d4533ec2da932d3770173a540c56780fc43e`.
- Internal-business read proposal v2, version 1,
  SHA-256 `3ea055d7c5905da9e264aff933e62ffb0de5e7d68d1f1d79fde4a89ab3207fd0`.
  Its proposed new wire kinds and commands are not accepted by this receiver.

## Admission and supported subset

Only `POST /api/competitor-intel/ingest/v1/observations`, with no query, is the
signed ingest route. The dispatcher only recognizes the exact configured HTTPS
incoming origin whose host matches `INCOMING_EXPECTED_HOST`. In production that
origin must also equal `https://incoming.ledgetopdroneservices.com`. Requests on
Operations/private/public presentation aliases do not enter this dispatcher.

Both the `COMPETITOR_INTEL_INGEST_ENABLED` environment flag and the
`ci_ingest_control.enabled` database gate must be explicitly enabled. Neither is
enabled by migration 0228. Other paths are returned to the existing dispatcher;
the new receiver never accepts human Access, PA, Viewer or incoming-upload
session credentials as ingest authentication. The top-level exact machine
dispatch appears before existing human application middleware intentionally;
its dedicated host and Ed25519 checks are its independent admission boundary.

The initial supported frozen v1 kinds are `competitor_profile`,
`baseline_assessment`, `change`, `ad_activity`, `scan_run`, and `self_assessment`.
`own_ads_checkup` returns `schema_invalid`: the frozen draft does not enumerate
`focus.value` values, and owner read schema 0227 deliberately has no provider
Ads projection. That kind needs a separately reviewed validator before enabling
its producer feed. No v2 kind is reinterpreted as a v1 observation.

Only `commandBinding: null` is accepted. A non-null, otherwise valid command
binding returns `command_binding_stale`; this receiver implements no command
intent/lease authority. Frozen producer retries must preserve exact body bytes.
Unsupported kinds are terminal 400 responses, so the sender must explicitly
exclude them until a compatible validator is accepted.

## Verification and authority

The codec is the frozen seven-line `ltci-observation-sig-v1` codec. It validates
strict header syntax and five-minute timestamp bounds, looks up the exact
producer/key, recomputes the exact raw UTF-8 body digest, and verifies Ed25519
before parsing JSON. Base64url must be unpadded and canonical. The frozen test
public key/vector is used only by synthetic tests; no installed key is read.

Bodies are streamed with a 256 KiB bound. UTF-8 errors, BOM, NUL, duplicate keys
(including escaped duplicate names), unknown fields and container depth above
six are rejected. Typed validators apply frozen decimal/int63/count, timestamp,
state/null, URL, array and cross-field rules. External URLs are metadata only:
the receiver never fetches them or accesses the Hermes LAN dashboard.

Producer keys contain only public material and explicit state/revision.
`active` and `previous` keys can verify; retired/revoked keys cannot. Exact
producer binding allowlists must resolve an existing reviewed 0227 internal
business binding at the same current configuration revision. A single current
business route alias is required; ambiguous aliases fail closed. No NULL or
default tenant, name/domain heuristic, directory record creation or implicit
membership exists. No key registration or binding-management route is added.

## Durable receipt, ordering and projection

Accepted raw bytes, digest and the original receipt are immutable. Identical
operation/digest retries return the original receipt with `delivery: duplicate`;
different content under an operation ID returns `operation_hash_conflict`.
Epoch/counter comparison uses JavaScript BigInt, not lexical ordering or lossy
SQLite/JSON numbers. The overall head is keyed by binding, configuration revision
and subject, without observation kind. Thus cross-kind reuse of a subject tuple
conflicts. Per-kind accepted heads are retained separately for reconstruction.

A lower binding epoch is rejected. A distinct lower subject tuple in the current
epoch is accepted as superseded immutable history and cannot update projection.
Every epoch transition is audited. No restore silently resets a durable head.

One D1 transaction compares current enabled gate, key, exact binding/business,
producer allowlist, previous epoch/head and projection revision, then inserts
inbox/receipt, advances applicable heads/audit, and appends the owner read
projection. Any stale witness or failed statement rolls the entire transaction
back and returns sanitized `retryable`; retry re-reads current primary state.
Concurrent identical submissions reconcile to the original receipt.

Normalized validated JSON is stored alongside exact raw bytes. Reconstruction
bounds normalized head bytes to 1 MiB in the same SQLite statement before
returning blobs to the Worker; it never loads hundreds of whitespace-padded
raw envelopes. Non-scan/self head count is bounded to 350 (50 profiles, 50
baselines, 50 ad observations and 200 changes). Latest scan/self are selected
separately. The final DTO must pass the unchanged owner read allowlist and its
256 KiB bound. Capacity exhaustion fails closed rather than truncating data.

The projector creates competitors only from accepted profiles. Assessments alone
cannot invent competitors. It strips producer review, scope keys, social/raw
evidence details and unsupported fields; client verdict/publication remain
absent, own Ads/provider account remain null, and intents remain empty. Producer
unknown/null evidence stays unknown/null. Freshness remains computed by the
existing human read adapter at read time. Existing owner admission and explicit
read grants are unchanged and no human read gate is enabled by ingest.

Key rotation alone does not erase accepted history. Compromise quarantine,
publication, worker commands, provider Ads, migration execution, actual key/
binding registration and enabling either gate remain separate work. Existing
legacy records with unknown scan counts must not be converted to fabricated
zero-count scan observations.

## Local validation

All fixtures are synthetic and use published test-only keys plus local D1.
The ingest suite passes 27 tests, including the frozen signature vector, all
six supported kind fixtures, exact incoming/default-off admission, replay and
cross-kind conflicts, numeric ordering, epoch regression, eleven-profile
projection, reconstruction and streamed-body bounds, forced transaction
rollback, and concurrent CAS. The existing 18 owner read tests and 40 reviewed
migration-chain tests also passed during this candidate's focused checks.
Operations TypeScript checking and Git whitespace checks pass. The final
host/query and transaction changes additionally passed four targeted tests.
These checks establish no live host, key, producer mapping or deployment state.
