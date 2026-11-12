# Offline D1 export response custody adapter

**Historical optional prototype:** Beau waived staging backups on November 12. This
adapter is not a prerequisite or approved live migration runner; do not expand backup
frameworks or create recovery keys to satisfy it. Necessary sensitive migration transport
still requires protection; existing data and production backup policy remain unchanged.

`scripts/staging-d1-export-custody.mjs` coordinates one Operations or Portal D1
export. It derives exact source/target bindings through
`backupBindingForTransferPlan`; no caller account ID or credential is accepted.
The injected transport, `sealRawResponse`, `validateProof`, and `record` callbacks
are trusted integration boundaries. This module does not call Cloudflare directly.
`downloadOrigin` is a separate immutable constructor setting, not an origin authorization
derived from the plan. Its HTTPS syntax and equality with the returned capability are
checked here; Merger must independently approve the exact provider storage origin and its
association with the reviewed input before use. A caller-selected HTTPS origin is not
proof of that review. No real download origin has been discovered or approved by these tests.

The transport receives the fixed Cloudflare v4 D1 export endpoint, fixed request
body, `redirect:"error"`, `credentials:"omit"`, a 30-second deadline, and a 1 MiB response
limit with cancel-on-limit requested. It must enforce the deadline and bounded streaming/cancellation and return
own-data response metadata including exact HTTP status, `redirected:false`, and the
unchanged final endpoint URL. The adapter checks those claims; this callback contract
does not prove the transport or provider honored them.

Within one controller there is exactly one intent per unique request. An action ID binds plan hash, role,
sequence, and request kind. The initial export can start only once; at most 100 polls
reuse the original `at_bookmark`, for at most 101 HTTP requests total. A synchronous
in-flight lock prevents concurrent starts, polls, or reconciliation. Each response,
including non-200/202 response bodies, is snapshotted and sealed before status or JSON
classification. The sealer receives an authenticated context containing schema, action
ID, request hash, raw response hash, HTTP status, and binding hash; the raw response
and context must be encrypted/authenticated together. The injected proof validator
must verify that sealed receipt against this context and exact raw bytes. The adapter
checks the returned proof fields before journaling custody or parsing.
Sealer and proof callbacks receive separate copies, which are cleared after use; the
parser's snapshot is separately cleared on completion/failure.

Journal records contain fixed phases, sequence/status, action IDs and SHA-256 values
only. Receipt references must themselves be lowercase SHA-256 strings. Provider text,
bookmark, filename, signed URL, and body content are never journaled or returned.
Transport/custody uncertainty and response-capacity overflow block further work.
`reconcile` accepts an opaque pending action ID plus a raw response and protected
receipt proof, validates that evidence against the original private request, journals
it, then parses; it never repeats the API request. Unverified reconciliation evidence or
uncertain journal custody stays blocked. A proved and custodied malformed/provider-failed
response is terminal and cannot be replaced by a second outcome.

Completion returns `export-capability-sealed`: the complete raw response, including
the signed URL, was passed through the protected sealing/proof callbacks. The adapter
validates the URL origin then discards the parsed URL; a later reviewed downloader
must recover it from the sealed response receipt. This is not a completed or
recoverable backup. The separate downloader remains
unimplemented; it must enforce the reviewed HTTPS origin, redirects off, no bearer or
cookies, a bounded 32 MiB streamed body, ciphertext custody and proof validation.
The callback `record` is not demonstrated as durable storage, and this module does not
prove atomic append/CAS, ACLs, independent key recovery, or actual provider behavior.

Tests use synthetic data and an ephemeral AES-GCM test key. They cover lock behavior,
single intents, bounded request contract, normal and reconciliation proof checks,
sealer mutation isolation, unknown outcomes, HTTP refusal bodies, bookmark consistency,
capability-origin validation, recovered-completion receipts and intrinsic typed-array size
checks. Optional completion `type`, inner `success` and `filename` follow the documented
API schema; a present type must be `export`, and the signed URL is always required for
completion. An active result must not contain a completion payload without its status.
No real D1 export or download was performed.

## Operational integration still required

`record` must exclusively claim the exact run/role and durably create each intent before
returning true, rejecting the same action in a new controller/process rather than performing
another initial export. Later phases require append-only compare-and-set persistence and
readback reconciliation for an ambiguous write; the in-process lock is not a cross-process
lock. No existing consumed inquiry journal is reused. Starting a new object does not authorize
repeating a prior action. The sealer and proof-validator must authenticate the response
context and independently reopen the exact persisted ciphertext; returning matching fields
or an in-memory flag is not storage proof. Receipt hashes alone are not authority.

The transport is separately credentialed and reviewed: it must send its account credential
only to the fixed Cloudflare API origin, omit cookies, reject redirects without following
them, stream with the requested deadline/limit, cancel on overflow, and suppress raw error
text/response bodies/capabilities from logs. This module never receives or loads a token.
Download credentials must not be inherited from this transport by a later SQL downloader.
The current raw-transport interface and synthetic fixture do not implement that live client.

Read [recovery custody options](recovery-custody-options.md) and the
[protected transfer design](protected-transfer-design.md) before preparing operational
adapters. This coordinator does not start the disabled full transfer executor, validate a
quiet window, recover a key, persist a backup, import SQL or prove restored-client access.
