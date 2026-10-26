# LTDS media generation stack

One TrueNAS SCALE Custom App can run proxy generation and Operations thumbnail
processing as independent services. The default deployment contains two services:

| Service | Work | Local media access | Network |
| --- | --- | --- | --- |
| `proxy-generator` | Resolve editing proxies from local videos | Jobs read/write; writes sibling `Proxy/` files | None |
| `queue-renderer` | Operations image, PDF and video thumbnail jobs from R2 | None; temporary sources stay in RAM | Outbound HTTPS |

The [optional prebuilt overlay](compose.truenas.prebuilt.yaml) adds the existing
local thumbnail `decoder` and registration `broker`. It is separate from the
default YAML so the default installation never requires their images,
credentials, or datasets. The Viewer remains in its existing app; it is not a
dependency of these services. No service waits for another at startup.

## Default installation

Use [compose.truenas.yaml](compose.truenas.yaml) through **Apps > Discover Apps >
Custom App > Install via YAML** in the TrueNAS UI. Labels vary by SCALE version.
This repository change prepares deployment files; it does not install an app,
alter the Jobs dataset, or stop any existing app.

1. Obtain the digest-qualified proxy image from the **Verify and publish Resolve
   proxy generator** workflow receipt and the queue-worker image from **Publish TrueNAS
   thumbnail renderer images**. Use `image@sha256:...` references, not `latest`.
   Configure a private registry credential in the Apps UI if required.
2. Create a private persistent proxy-state dataset and give the selected
   non-root user/group ownership. The default IDs are `568:568`. Keep that
   state when upgrading or rolling back: it contains instance locking,
   per-file completion receipts, retries, and health state.
3. Select the existing Jobs dataset explicitly with `MEDIA_JOBS_HOST_PATH`.
   The supplied reference path is `/mnt/L.T.D.S./Drone_Jobs/Jobs`; verify it
   before saving. Bind sources must already exist; the YAML refuses to create
   a missing host directory. The app user needs read/traverse on eligible
   originals and write permission in their parent directories to create
   sibling `Proxy/` folders. Do not change Jobs permissions recursively or
   grant root to work around an ACL failure.
4. Enter the values listed in [.env.example](.env.example) using the Custom
   App environment/substitution UI. If that SCALE version does not expose
   Compose substitutions, replace the placeholders in its YAML editor before
   saving. Store actual credentials only in the private TrueNAS configuration;
   never commit a filled YAML or environment file.
5. Configure the existing dedicated renderer bearer token. Leave the queue's
   two Cloudflare Access values empty on the normal incoming API unless that
   endpoint is protected by a service-token policy. Keep the existing policy
   and authorized credentials when using an Access-protected endpoint.

Proxy generation has no network and no cloud credentials. Its Jobs bind must
be read/write because Resolve discovers proxies beside originals. That mount
grants filesystem write capability across the selected tree; code confines its
normal writes to `Proxy/` output, but the mount itself is not a read-only
security boundary. The thumbnail queue has no Jobs mount and no R2 credential.
Neither service publishes a port.

## Migration from the two existing apps

Keep the old app definitions, script, image references, and existing proxies
for rollback. Do not run both old and new proxy generators against the same
Jobs tree. Stop the old proxy app through the UI and wait for its processes to
exit before starting the new stack. Also stop the old thumbnail queue app to
avoid unintentionally doubling the pool; allow its graceful shutdown before
starting the replacement. An interrupted thumbnail lease recovers through
Operations' normal lease expiry, not by manually editing queue state.

Use a synthetic media folder first, with a narrow scan scope and concurrency
one. Confirm a proxy opens in Resolve and links correctly, a second scan
skips it, and a synthetic Operations thumbnail completes. Then restore the
normal scan scope and the intended pool sizes. Keep the persistent state
dataset across restarts. Changing the regeneration version is an explicit
request to regenerate proxies, so do not bump it merely for an image upgrade.
Follow the [proxy runtime migration behavior](../proxy-generator/README.md)
when adopting existing script-generated outputs.

The default proxy pool is six jobs, with two FFmpeg encoder threads per job;
the thumbnail pool is four. They share server CPU, memory and storage, even
though they do not depend on each other. Defaults cap the proxy container at
12 CPUs/12 GiB and the queue at 4 CPUs/5 GiB. The queue's 4 GiB scratch tmpfs
counts toward its memory use. Adjust pool sizes and limits together in the
UI after checking headroom; adding local pre-generation adds more load.

Proxy scans start at boot and repeat after each completed pass plus a
15-minute sleep. A new source needs two unchanged observations separated by
the stability window, so the first pass defers it, normally until the next
scan. Retry backoff may defer a file further. Probing and encoding have
separate finite timeouts. A healthy
container reports its runtime health; verify actual proxy output and
thumbnail completion as well.

For rollback, stop the new stack fully, keep its state and generated proxies,
then restart the retained old app definitions. Do not erase state, remove
proxies, prune images, or change Cloud Sync as part of this migration.

## Optional local thumbnail pre-generation

Add [compose.truenas.prebuilt.yaml](compose.truenas.prebuilt.yaml) only when
local still/PDF pre-generation is wanted and its prerequisites have been
verified. The overlay defines `decoder` and `broker`; it does not change the
two default services or add startup dependencies.

| Additional service | Work | Access |
| --- | --- | --- |
| `decoder` | Scans local stills/PDFs and builds immutable WebP thumbnails | Jobs read-only, private cache/scratch/state; no network or credentials |
| `broker` | Verifies exact source/derivative identities and registers with Operations | Artifact/state datasets and outbound HTTPS; no Jobs bind or media decoder |

Compose profiles are intentionally unnecessary. For a TrueNAS editor accepting
one document, combine the files locally with Docker Compose and paste the
result into the UI:

```powershell
docker compose -f apps/media-generation/compose.truenas.yaml -f apps/media-generation/compose.truenas.prebuilt.yaml config --no-interpolate
```

This is a local rendering command, not a TrueNAS system-shell operation.
`--no-interpolate` preserves placeholders so credentials need not be written
into generated output. Resolve them through the TrueNAS UI as for the default
file. If inspecting an interpolated configuration locally, its output contains
secrets: never paste it into chat, logs, or the repository. Do not run `up` or
other deployment commands on the workstation as part of this rendering step.

The overlay needs the four private thumbnail datasets, two extra pinned images,
broker-only bucket-scoped Object Read credentials, the exact ingest endpoint,
and a Cloudflare Access service-token pair. Broker Access settings use separate
`LTDSTHUMB_BROKER_ACCESS_*` substitutions so enabling the broker does not add
Access headers to the queue's incoming endpoint. Read the current
[thumbnail installation and storage requirements](../thumbnail-renderer/README.md)
before enabling it.

The broker does not upload derivatives. A separately configured one-way
TrueNAS Cloud Sync/rclone task must map only the persistent `prebuilt/` cache
to `_ltds/derivatives/thumbnails/v1/prebuilt/`. It must never target the parent
derivative namespace, `managed/`, or original files. This stack creates no
Cloud Sync task and changes no existing task.

Prebuilt registration also requires an exposed full-object SHA-256 matching
the local source. The documented R2/rclone multipart path lacks that proof and
fails closed; running a decoder and broker alone does not make those files
eligible. The existing queue/managed path remains available. Verify actual
single-part/multipart behavior before investing in this optional path. No
automatic pruning schedule is installed by this stack.
