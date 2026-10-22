# Windows portal publication successor protocol (draft)

Producer and consumer authorization source is implemented; content integration is unfinished.
This does not make cross-publication downloads available in a deployed portal.

## Implemented producer

The existing private `OperationsPortalNativeDeliveryAuthorizationReader` class
adds `readWindowsDeliverySuccessorAuthorization(canonicalOriginalGrant)`.
Admission uses its existing exact deployment-origin check and reader switch.
There is no HTTP route, new environment variable, grant edit or issuer command.
The input is an exact canonical original delivery grant, maximum 65,536 UTF-8
bytes. Duplicate keys, noncanonical serialization, malformed JSON and other
shapes fail before database access. Results are primitive JSON, maximum 16,384
UTF-8 bytes, to avoid service-RPC object decoration.

Successful shape:

```text
{ok:true, protocolVersion:1, successor:{
  authorization: <original grant proof, including original publication>,
  continuity:{grantOperationId, grantFingerprint, first, current,
              publicationCount, chainSha256}
}}
```

`first` and `current` contain only operationId, publicationId, revision,
sourceSequence, snapshotId and snapshotSha256. The current publication is not
substituted into the original command or original proof. Failures have only
`ok:false`, `protocolVersion:1` and `code` (`disabled`, `invalid`, `denied` or
`unavailable`). Operational errors expose no database, prefix or stack details.

The producer proves the immutable bounded publication chain, runs the complete
current recipient/home/folder/project/physical mapping joins using its effective
publication, proves the same chain again, and finishes with another joined
permission query. It checks expiry after the last database response. Both joined
queries require the original delivery to be acknowledged. The original grant
revision, publication, recipient, resource, features and expiry remain pinned.
The original reader and grant-dispatch path pass no effective publication and
continue to require the original publication.

## Implemented consumer authorization source

The ordinary Client `operations_portal_native_delivery_live_heads` view correctly
disappears when its original publication is no longer current. It must remain
unchanged. Migration 0235 adds a separate successor-candidate view and an exact
authority/person selector. This lets the reader and future audit guards share
one local predicate without changing ordinary authority. It proves the current active grant
through raw heads/commands/history/receipts, current recipient/workspace/home
receipt, and the current publication head/receipt/snapshot retaining the selected
folder and project. Candidate rows are not content authorization by themselves.

`authorizeWindowsPortalSuccessor` reads a candidate before private RPC,
validates/hashes its original canonical grant, then strictly validates the
distinct successor response. Every nested object has exact own keys. The original
authorization equals the expected original proof; grant ID/hash and `first` match
the original wire; `current` matches the consumer's current publication;
revisions/sequences are positive safe
integers, contiguous and bounded by 64 publications. Chain SHA is opaque producer
evidence, not a locally recomputed history proof. The candidate is re-read
afterward and the entire original/current tuple must remain unchanged. Original
expiry and identity/feature pins are checked; the caller must first verify a human
session and repeat proof at each content phase. There is no ordinary-reader
fallback. A missing successor method or schema returns unavailable. The bounded
private call retains its 1.5-second deadline.

The returned `successorContext` is distinct from the ordinary context: it contains
`originalGrant`, not `command`, and cannot be passed directly to the old byte or
audit paths. It carries the original fingerprint, selected prefix and frozen
continuity proof internally, never in browser JSON. No existing route invokes it.
The candidate WHERE predicates are grouped to respect D1's expression-tree depth
limit; a real-schema query-planning regression covers that limit.

## Next byte, queue and audit implementation

Use a distinct encryption purpose, handle prefix and successor-only byte route.
The handle retains original lifecycle/path/provider-version/SHA pins plus current
publication pins and chain digest. Its expiry is the minimum of 15 minutes,
original grant expiry and verified human expiry. Existing `ond1_` handles keep
their original semantics. Long queue references retain original selectors; each
resolve obtains fresh successor proof and a fresh short byte handle.

Existing content-start audit is deliberately tied to the original publication
and ordinary live-head view. Do not weaken its guard or forge an updated command.
A separate immutable successor ledger/guard must bind original grant, effective
publication, chain digest, HMAC resource/version and a distinct dedupe purpose.
The atomic insert must prove the current local candidate, exact file-index pins
and absence of tombstones. Repeat private/local authorization before and after
audit and before R2 metadata/bytes and final handoff. A missing ledger or failed
audit denies content; successful history alone never permits a read.

The planned ledger is download-only and separate from migration 0228. Its
immutable records retain the original authority/home/folder/project pins plus
the original publication source sequence, effective publication's six pins,
chain digest and bounded publication count. Principal, prefix, resource and
content-version values are purpose-separated fingerprints; never persist raw
storage keys, person identifiers, provider versions or the original grant wire.
Content-version evidence hashes the trusted tuple of ETag, provider version,
SHA256 and length, rather than ETag alone.

An insert and dedupe lookup must run in one D1 batch and both re-prove the same
current candidate, canonical original grant, person, exact file-index ETag/size
and absence of active file/prefix tombstones. A deduplicated old event cannot
authorize a new read. The database guard proves local state only: the caller
must separately obtain current producer continuity before writing and compare
the complete original/current/digest tuple without silently substituting a new
one. After audit it repeats private/local proof and trusted R2 identity before
byte handoff. Missing table/view/guard/index or any failure denies bytes. No
database predicate can replace verification of R2 provider version and SHA256.

Acceptance still needed: actual same-content queued resume after refresh,
changed-content isolation, missing/omitted/restored history, revoke/regrant,
recipient/home/client switch, folder remap, stale consumer publication, expiry,
concurrent refresh/revoke, provider changes and audit failure. Large-history
performance and a later stable continuity epoch remain separate qualification.
This producer method currently proves `file.download` only. Catalog discovery,
folder listing and metadata still use original-publication authority and need
their own reviewed continuity support; queue recovery alone will not make the
whole desktop browser survive a publication refresh.
