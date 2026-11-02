# Reference-v1 source broker: blocking vertical-slice design

Status: read-only design, not an endpoint, migration, issuer, grant, source pin
or activation. Do not mount a broker until storage-owner fencing, authentication
and the paired wire have been reviewed and proved. Preserve the active NodeODM
v1 processing route and all existing v1 reference jobs/receipts.

## What the existing code actually binds

Viewer `datasets` rows identify project, storage mode, root key, relative path,
state and manifest hash; `dataset_files` rows map file IDs to relative paths,
sizes and SHA-256. These are application records, not independent proof that
filesystem bytes remain immutable. `StorageManager` resolves configured roots
and checks existing-path containment; that is not a NAS writer or purge fence.
The snapshot acquirer hashes descriptor-relative files and detects identity
changes during its scan but explicitly releases descriptors and cannot prevent
changes immediately afterwards. `sourceCustodyDraft.issue()` always returns
`custody_unavailable`; its prepared rows and SQLite triggers do not protect
files against open old writers, other app versions, NAS clients, aliases or
administrators. Lifecycle fixture fences are not installed in normal runtime;
application source-binding and CSV purge checks cover selected paths only.

The API mounts `processingApi` only when processing is enabled, behind existing
proxy and admin/service authentication. Its staff permissions and signed
service calls do not by themselves validate a Processing worker's scoped object
bearer. A new source GET must not silently reuse a broad admin session, bearer
from another audience, caller-supplied path, or generic service HMAC as a grant.
No current authenticated NAS custody issuer, protected single-writer epoch,
all-path purge barrier, or qualified worker-facing source route was established
by this inspection. No client file or live NAS was inspected.

## Existing reference-v1 wire (do not change in place)

Processing's `validate_grant` requires a closed transfer grant with exactly:

```text
reservationId, generation, expiresAt, manifestSha256, byteBudget, nonce,
jobId, environment, objectIds, token
```

It compares reservation/generation/expiry/manifest/budget/nonce to the persisted
transfer request and job/generation/environment/manifest to the persisted job.
The object ID set must match its input manifest, whose unique IDs, positive
sizes and SHA-256 values total `totalBytes`; the budget must be between that
total and three times the total, within the safe integer limit. The token is a
bounded opaque printable bearer, not a locally specified signed-token format.

The existing `BrokerClient` sends HTTPS
`GET /api/processing/reference/v1/objects/{objectId}` with that scoped bearer
and `Accept-Encoding: identity`; it expects a direct 200 at the original URL,
identity encoding and, when present, an exact Content-Length. It reads the
declared whole object, verifies EOF/size/SHA-256, fsyncs an exclusive private
temporary file, then publishes without replacing an existing target. Redirects
and partial bodies fail. This client has no Range/resume or physical
byte/request meter and may retry from byte zero up to its existing bounded
driver attempts. No range header, new per-request delivery ID, response digest
header, extra grant key or unagreed token encoding may be required as if the
current client already supports it.

## Proposed source pin and physical accounting prerequisites

Before a production grant is issued, the NAS storage owner must durably bind a
stable pin/intent ID to the exact environment, Viewer attempt and dataset IDs,
job/generation, original parent claim and reservation/nonce, manifest digest,
and ordered object IDs, physical identities, byte lengths and SHA-256 values.
The binding must include root/mount generation and authoritative retention
policy without exposing physical paths to workers. Verify source bytes under an
independently enforced storage-owner barrier spanning issuance and every transfer;
fence old app versions and already-open write handles, all aliases, external
writers and purge/move paths. Recheck the live authority/epoch, grant expiry and
revocation before and during transfer. Raw Emlid CSV files must never be deleted,
including on purge, cancellation, failure or rollback. They remain retained
even when excluded from worker input. Unknown ownership or fencing holds.

The issuer must authenticate the specific worker/audience and map an opaque
bearer to the complete immutable grant and verified source pin. It must protect
tokens from logs, reject unsupported/revoked/expired bindings before revealing
object existence, and stream only an object in the exact grant. A source hash
alone cannot authenticate the actor or stop a concurrent writer. Current v1
has no physical-delivery ID on the GET; a production design therefore needs a
jointly agreed accounting/recovery scheme compatible with this limitation or a
separately negotiated version. Do not pretend a synthetic delivery ID is already
sent by `BrokerClient`.

The reservation ledger must charge real physical request/byte attempts before
streaming or otherwise enforce a demonstrably safe bound; repeated transfers,
disconnects, lost replies and partial bytes consume budget. No automatic refund,
counter reset or retry on unknown outcome. A durable, independently protected
epoch/rollback anchor and explicit history-retention coverage are needed before
declaring an attempt absent. A lease timeout, fresh SQLite row, stale ACK, closed
socket or successful hash is not proof that a prior stream or writer stopped.
Define and verify the independent fence and trusted observation before takeover.

## Minimum proposed durable records (not a wire schema)

* `SourcePinIntent`: stable operation ID, environment, attempt/job/generation,
  manifest and exact object ID/size/hash closure, storage-owner root generation,
  retention class and requested capacity; immutable same-ID replay.
* `SourcePinReceipt`: distinct issuer-authenticated receipt and exact intent
  digest, source/root/epoch identity and verified barrier evidence. No fixture
  boolean, caller-supplied timestamp or row alone is such evidence.
* `TransferAdmission`: immutable current job/worker/audience/reservation/nonce,
  pin and object binding, issuer/key/revocation, ledger epoch, physical attempt
  identity, limits and pre-stream charge. Replays/conflicts/uncertain outcomes
  require authoritative lookup; compatibility with the existing no-delivery-ID
  GET is an unresolved paired contract decision.
* `AcceptedCopyReceipt` and stable ACK/outbox: exact independently verified
  result identity/hash/size/closure and NAS copy, producer receipt linkage,
  durable bytes/directory/ledger commit, exact ACK identity/digest, conflict and
  recovery behavior. Acceptance, publication and any later producer cleanup are
  distinct operations; an ACK never authorizes deletion of managed copies or
  permanent raw CSVs. See `reference-nas-broker-seam-proposal.md`.

These are names for review, not existing APIs or agreed keys. Issuer identity,
key lifecycle, source/worker capacity reservations, exact schemas/canonical
bytes, rollback/restore, retention/release, cleanup ACK and current authority
must be agreed by Viewer, Processing and the NAS owner. Broker/intake/config and
service activation remain false/absent in the reported Processing provisioning
state; no route is safe to expose merely because the peer client is present.

## Qualification needed before a vertical slice

Use synthetic data first. Exercise the actual paired client against a bounded
test-only issuer and isolated storage under explicit ownership. Verify correct
v1 positive grants and closed-field rejection; unauthorized object/audience,
wrong manifest/source/generation, expiry/revocation, token secrecy, redirects,
truncation and changed bytes. Add real independent old-writer/purge fencing,
partial stream and crash cases, physical budget exhaustion, exact replay and
ambiguous-result holds, concurrent actors, restore/rollback and retention
watermarks. Verify permanent CSV retention across every lifecycle path. Test
separate durable result write, exact ACK and unknown cleanup without deleting
source or accepted files. Synthetic fixtures, a passing hash or a process
heartbeat are not evidence of production authority, TLS, NAS durability or
cross-host safety. No endpoint, migration or client job is included here.
