# Frontend retention includes routing

Retaining an asset file does not prove that the candidate Worker can serve its
previous URL. A release must preserve both the bytes and the routing metadata
that makes those bytes available, without changing the caller's authorization.

For a release with catalog-backed UI assets:

1. Pin the installed catalog, its qualified asset inventory, and the actual
   retained bytes. Carry forward the required manifest objects unchanged into
   the candidate's build input. Do not infer a release or grant from a filename.
2. Verify the compiled candidate resolves every retained catalog path through
   the real router and its existing asset binding. A path-classifier test or a
   copied file alone cannot establish this.
3. Test the actual handler with all retained release identities, authorized and
   rejected origins, and missing manifests or bindings. Preserve fail-closed
   behavior. Do not add a native-assets fallback to make a failed proof pass.
4. Before switching traffic, verify the candidate's deployed module, binding
   graph, version identity, and actual response bytes. Keep failures distinct
   from authorized empty results. A private proof route must exercise the
   intended routing path, rather than a more permissive substitute.

For native asset releases, retain the complete qualified asset union and its
ledger, including the archived previous root HTML. Classify native archives,
catalog routes, and proof-only sentinels separately; none creates another
namespace's authority. Preserve existing public links and host restrictions.

Operations and Client Portal releases must retain the required old asset paths
and actual bytes for at least 48 hours after their actual cutover. Carry any
unexpired retention forward into later releases. Record the cutover and earliest
permitted pruning time; do not schedule automatic pruning as part of release.

If a live proof fails, preserve its claim, responses, and terminal receipt. Clean
up only its owned temporary resources and verify their absence. Correct the
build in a new immutable artifact and independently review the next attempt.
Do not rewrite the failed evidence or replay a consumed deployment action.
