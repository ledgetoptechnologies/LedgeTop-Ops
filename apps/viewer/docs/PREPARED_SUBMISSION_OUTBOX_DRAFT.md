# Prepared submission outbox draft

This is a dormant integration component for the Processing candidate contract
`ltds-viewer-prepared-envelope-jcs-v3`. It is not mounted by the Viewer server
and does not change the current NodeODM submit, reconcile, or ingest workers.
The Processing v3 route and its activation, source authorization, result, and
accepted-copy retrieval contracts are still inactive; do not enable or wire a
live deployment from this draft alone.

The outbox stores the exact RFC 8785/JCS bytes before the first network request.
Its digest is SHA-256 over the v3 domain separator followed by those bytes.
The unique task, attempt, and local submit-job identities are checked under the
current, unexpired Viewer submit lease. The outbox prevents envelope mutation
and deletion. A POST is followed by an authenticated GET by the stable
submission ID; the response must match the saved task, attempt, activation,
environment, and envelope digest before the row can move to `accepted`. A lost
POST response is treated as uncertain and recovered only by that exact GET.

The current reference-v1 manifest cannot represent the complete Viewer source
inventory: it has basename-only names, so it cannot preserve nested paths or
duplicate basenames in different folders. The future source inventory must
preserve dataset/file IDs, exact path spelling, roles, byte sizes and hashes,
and the exact per-attempt GCP snapshot plus its source/image provenance. Raw
GCP CSV files remain retained in the source dataset. No lossy mapping or
automatic cleanup is authorized by this component.

Focused tests are in `test/prepared-submission-outbox.test.js`. They exercise
canonical bytes, lease-bound durable replay, immutable storage, uncertain POST
recovery, authenticated binding checks, and fail-closed behavior. They do not
prove the full Processing pipeline, its live auth configuration, or a staging
deployment.
