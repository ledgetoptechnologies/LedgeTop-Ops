# Owner Intel read API

Source candidate based on main `92b688f2`, October 24, 2026. No live storage,
grants, business identities, producer keys, ingestion or production settings
were created. This change adds read infrastructure; it does not connect the
Hermes pipeline or make existing LAN dashboard data available in Operations.

The API uses the existing `OPS_DB` binding and ordinary verified human Access
authentication. It is registered after that authentication middleware. Every
read requires an active native admission matching the canonical staff identity,
an unexpired Access assertion, a global `role-owner` assignment, and an active
explicit `intel.owner.read` allow for the exact staff/business pair. Generic
administrators and owners without that grant are denied. Exact business denies
and any existing `administration.view` or `intel.owner.read` override deny win.
The native profile and admission versions and current permission are checked
again after data awaits. Catalogs enumerate only explicitly permitted businesses.

The dedicated `owner_intel_read_grants` table is a new permission domain. It does
not add a permission to the closed directory/client grant vocabulary. Nothing
seeds this grant, guesses Beau's staff ID, or infers internal business ownership
from a name, domain, provider ID, PA customer, or Hermes NULL client record.
Opaque internal business identities and durable route aliases are reviewed
separately. Retired aliases cannot be reassigned to another identity. No PA
customer record is required or created.

## Routes and unavailable states

- `GET /api/intel/businesses` returns `{businesses:[{key,name}]}`.
- `GET /api/intel/:key/competitors` returns the existing `StaffTenantView` shape
  when a qualifying accepted read projection exists.
- `GET /api/intel/:key/website?range=7d|28d|90d` returns 404
  `intel_website_not_connected`.
- `GET /api/intel/:key/search-console?range=7d|28d|90d` returns 404
  `intel_search_console_not_connected`.

All responses are private/no-store. Unknown and unauthorized business aliases
both return 404 `intel_business_not_found`. Missing monitoring returns 404
`intel_monitoring_not_configured`; a reviewed binding without accepted data
returns 404 `intel_awaiting_first_data`. Those states never return fabricated
zero totals. Malformed query shapes return 400. Corrupt storage/projections or
changed reads return sanitized 503 errors. Owner admission/permission denial
returns 403. Missing schema or disabled control returns 404
`intel_not_configured`; broken partial schema fails closed.

`session.capabilities.intel.enabled` is false unless the schema/control is ready
and the caller meets the owner and explicit-grant checks. The catalog remains
the authority for which business aliases this person may read. No automatic
job, scan, model call, OAuth request, LAN fetch or write happens on a read.
`session.capabilities.intel.readOnly` is always `true` in this candidate. The UI
must hide scan requests, verdicts, publication and other mutation controls.

## Migration and adapter boundary

Operations migration `0227_owner_intel_reads.sql` creates the default-off control,
unseeded internal catalog/aliases, explicit read grants, reviewed bindings and
append-only competitor read projections. Migration 0226 remains reserved for the
separate linked-login candidate; this migration does not depend on it. The
existing staff/native identity tables are prerequisites. Do not apply the entire
main migration suffix as an incidental owner-login or frontend repair.
An existing working legacy owner login does not prove native admission is
configured. This candidate intentionally requires native admission; a production
release needs either the separately reviewed native readiness/handoff or an
independently reviewed backport plan. It is not a drop-in backend release for
the older active Operations runtime.

`owner_intel_competitor_projections` is a materialized **read DTO**, with a
separate `ops.intel.competitors.v1` schema, binding/configuration revision,
append-only revision, exact source contract hash and checked SHA-256 of its JSON.
It is not a producer wire format, evidence of a valid producer signature, or a
replacement for ingest validation. The reader validates duplicate-free bounded
JSON and the complete supported DTO; it rejects cross-business data and unknown
fields. Freshness is recalculated at read time without rewriting stored evidence.
Historical projections survive configuration changes; only the binding's current
configuration revision can be read.

The initial internal DTO deliberately requires `ownAds`, `providerAccountRef`,
`scopeKey`, and `manifest` to be null, `intents` to be empty, and changes to have
no verdict or publication. Provider consent, internal verdict authority,
publication and command APIs are separate work. The UI must present this as read
only and hide those actions. Unsupported data must not be repackaged as Ads or
competitor observations to pass the v1 gate.

The **future reviewed verifier/projector** must establish authenticated frozen-v1
observations, immutable receipts, binding/producer allowlists, numeric epoch and
counter ordering, quarantine handling, safe projection completeness and the
source-to-projection proof before setting `storage_accepted=1`. No route or import
command in this candidate accepts, writes or certifies a projection. A stored
contract hash and DTO digest alone do not prove producer provenance. Keep
`enabled=0` and `storage_accepted=0` until that acceptance is complete. Then prepare
exact reviewed business IDs, aliases, current binding/configuration and the
authorized staff/business grant through the separately approved maintenance
process; none is inferred by this migration.

Frozen v1 remains unchanged: dedicated Ed25519 signing, exact path/domain codec,
strict envelope, explicit monitoring binding/configuration, per-subject numeric
ordering, durable idempotent outbox/receipts and no credential reuse. This change
adds no ingest, worker lease, command, verdict, publication or portal route. GA4
and GSC/own-site/social v2 observation kinds remain unaccepted proposals.

## Reviewed references

Hub project `ledge-top-ops`, canonical paths read October 24:

- `competitor-intel/frozen/ingest-wire-envelope-v1.md`, version 1,
  SHA-256 `a60a11ddd68df90da80a1e2eaf298434369653d8e8f390b814ed906e7b675b32`.
- `competitor-intel/frozen/command-intents-and-read-surface-v1.md`, version 1,
  SHA-256 `faf08a4afadfbdee37f7928aac71d4533ec2da932d3770173a540c56780fc43e`.
- `competitor-intel/internal-business-read-contract-v2-proposal-20261023.md`,
  version 1, SHA-256
  `3ea055d7c5905da9e264aff933e62ffb0de5e7d68d1f1d79fde4a89ab3207fd0`.

The internal-business note is design reference; the explicitly authorized
owner-only API above does not activate its broader staff grant or client report
proposals. Release requires fresh Hub decisions, native staff/schema acceptance,
joined UI/API tests and authenticated live read checks. Any frontend release
also retains prior 48-hour asset URLs and verifies bytes in the active namespace.
