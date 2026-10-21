# ODM provider compatibility

LTDS talks to NodeODM's documented API instead of WebODM's Django API. The
adapter is tested against NodeODM 2.2.3 and ClusterODM 1.5.5, but probes
`GET /info` and `GET /options` at runtime instead of rejecting a provider only
because its patch version differs.

The implemented workflow follows the upstream NodeODM API documentation:

1. `POST /task/new/init` with an LTDS-generated UUID in `set-uuid` and options
   as an array of `{name,value}` records.
2. One or more multipart `POST /task/new/upload/{uuid}` calls.
3. `POST /task/new/commit/{uuid}` only after every source file is uploaded.
4. Reconcile with `GET /task/{uuid}/info`; status codes 10/20/30/40/50 map to
   queued/running/failed/completed/cancelled.
5. Cancel with `POST /task/cancel` and retrieve results with
   `GET /task/{uuid}/download/all.zip`.

The assigned UUID, submission phase, and completed photo count are persisted.
After a crash, `GET /task/{uuid}/info.imagesCount` reconciles only the
photo-image prefix. NodeODM also accepts GEO, GCP text, seed ZIP, image-group,
and alignment inputs in the same multipart `images` field, but its image count
cannot prove which auxiliary files committed. An ambiguous auxiliary upload or
queued commit therefore uses documented `POST /task/remove` and restarts the
same deterministic submission rather than guessing. A running/completed task
proves the commit crossed the boundary and is reconciled in place.

Option serialization deliberately retains both boolean `true` and boolean
`false`; falsy options are not filtered. ClusterODM is NodeODM API-compatible
and remains responsible for selecting a node. LTDS limits how many jobs it
admits to the ClusterODM endpoint, while `/info.taskQueueCount`,
`maxParallelTasks`, and the configured local admission limit provide
backpressure. Provider health is never part of Viewer readiness or published
asset authorization.

Primary sources:

- <https://github.com/OpenDroneMap/NodeODM/blob/master/docs/index.adoc>
- <https://github.com/OpenDroneMap/ClusterODM>

## Opt-in live compatibility gate

The tested source baselines are NodeODM v2.2.3 release commit `baa619a` and
ClusterODM tag `v1.5.5`. They are compatibility baselines, not production
version lockouts. The default harness is read-only and calls only `/info` and
`/options`:

```bash
npm run verify:odm-provider -- \
  --provider-type nodeodm \
  --endpoint http://192.168.50.80:3000
```

If the provider needs a token, put it in `ODM_PROVIDER_TOKEN` (or name another
environment variable with `--token-env`). The harness never prints the token.
It rejects redirects and reports only bounded capability metadata and the
static fingerprint.

Destructive contract verification is never run by `npm test`, CI, container
health, or production readiness. Run it only against a disposable provider or
with explicit operator approval and a user-supplied small 1-50 image corpus:

```bash
npm run verify:odm-provider -- \
  --provider-type clusterodm \
  --endpoint http://192.168.50.80:3000 \
  --provider-image opendronemap/clusterodm@sha256:<64-hex-digest> \
  --destructive \
  --corpus /path/to/small-reviewed-corpus \
  --confirm I_UNDERSTAND_PROVIDER_TASKS_WILL_BE_CREATED_AND_REMOVED
```

The provider image argument must be an immutable digest for the endpoint being
tested; mutable tags are rejected. The corpus is limited to 50 top-level image
files, 512 MiB per file, and 2 GiB total. The aggregate timeout must be an
integer from one minute through six hours and covers hashing, both uploads,
processing, download, and cancellation. That mode creates an LTDS-assigned
UUID, uploads and commits the corpus, polls status and bounded output, streams
and hashes `all.zip` without retaining the archive, safely extracts it into an
ephemeral bounded workspace through the production ZIP path, and requires the
requested native EPT and 3D Tiles outputs plus the complete textured-mesh input
closure used by the Viewer worker: one OBJ, every referenced MTL and texture,
and the independent companion GLB. The closure is parsed and hashed with the
same immutable-manifest implementation used by derivative admission,
then uploads and commits a second task, verifies that cancelling real queued or
running work settles at NodeODM status code 50, and removes both tasks. It
prints the immutable provider image, corpus count/bytes/content-manifest,
archive/expanded byte counts, entry count, discovered output kinds, and the
mesh-input file count, byte count, and manifest digest in the result. Success
is emitted only after both UUIDs are confirmed absent and the
ephemeral output workspace is removed;
ambiguous initialization responses and failed removal verification fail the
gate. It has a two-hour default timeout and never runs without the exact
confirmation phrase.

### NodeODM 2.2.3 baseline evidence

On 2026-08-17 the destructive gate completed against immutable image
`opendronemap/nodeodm@sha256:b5260d56e96e24fd70a44f5bd892e6f2e3ee8a7a37b1247c1667b7ffc5758361`
on an isolated Docker network. The corpus was the 16-image `banana` starter set
linked by the official [ODMdata catalog](https://github.com/OpenDroneMap/ODMdata),
pinned to `pierotofy/dataset_banana` commit
`2778294e4a73aec8f37747e0d2edfc4cb38b23a6`. Its 16 image files totalled
15,294,677 bytes; a sorted `name<TAB>size<TAB>sha256<LF>` manifest hashed to
`0521a4583c8a9bab746ad5c5f4bf45e82547fa5e9c82e0250407f148f07c4013`.

The task completed. Its streamed `all.zip` contained 458,039,578 compressed
bytes with SHA-256
`0d9b05f801a4179baf65c56a861ce381e79ceb4bdabf9daad5824d341b9561fc`.
The production ZIP path extracted 265 entries totalling 457,991,174 bytes and
discovered EPT, GLB, native 3D Tiles, OBJ, orthophoto, and point-cloud outputs.
The second committed task settled at `cancelled`. Both assigned tasks were
removed and the provider data directory was empty before the disposable
container, network, and corpus checkout were removed.

### ClusterODM 1.5.5 baseline evidence

On 2026-08-17 the same gate and corpus completed against immutable image
`opendronemap/clusterodm@sha256:345cde80cd717cd23b207f99d4b49dac57e969d273861662b56c681f733baa9f`
with an isolated NodeODM processing node. The image is tagged 1.5.5; its
runtime API package reports 1.5.3, and the downstream ODM engine reports 3.5.0.
The streamed `all.zip` contained 458,488,913 compressed bytes with SHA-256
`fe7c7a6b55938f57667b3fd5c06bffb0236f33d248a5899d36e1597568acc9bc`.
The production ZIP path extracted 263 entries totalling 458,440,895 bytes and
discovered EPT, GLB, native 3D Tiles, OBJ, orthophoto, and point-cloud outputs.
The second committed task settled at `cancelled`; both provider tasks were
confirmed absent, and both the ClusterODM scheduler and NodeODM task
inventories were empty before cleanup.

These results prove the small immutable NodeODM and ClusterODM compatibility,
native-output, cancellation, and cleanup contracts. They do not replace a
representative TrueNAS corpus, GCP/LOD review, or restart interruption gate.
