# Viewer source consolidation into LedgeTop Operations

The Viewer now lives at `apps/viewer` in `ledgetoptechnologies/LedgeTop-Ops`.
It remains a separately deployed Node service and durable processing worker;
moving the source does not put processing or its database into Cloudflare Workers.

## Source and package identity

The initial import contains only tracked files from
`ledgetoptechnologies/3D-Viewer` commit
`44208101dff490e88069b9838730cc18ff08c544`. `source-import.json` records the
upstream Git tree, original Compose checksum, runtime contract and unmerged work.
The old local checkout's working changes, data, caches and credentials were not
imported. The npm package remains `ltds-3d-viewer` with its independent lockfile.

The new image is:

```text
ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest
```

The API and worker continue to use the same image. The Operations image workflow
must verify the exact candidate before promoting `latest`; use its published
source revision, digest and attestation to verify an update. The image source
stamp identifies the new Operations commit, while `source-import.json` identifies
the original Viewer source baseline.

## Existing installation update

Wait until the new package has been published and its candidate verification has
passed. In the **existing** Compose stack, replace only the former Viewer image
reference with the new reference above. For the canonical Compose file that is
one `x-runtime.image` value; if your stack repeats the image on each service,
change it on both `viewer-api` and `viewer-worker`.

Keep the existing Compose project, service names, ports, environment file,
credentials, proxy settings, provider configuration and bind mounts. In
particular, preserve all of the following:

| Contract | Preserved value |
| --- | --- |
| API / worker | `viewer-api` / `viewer-worker` |
| Service identity | UID/GID `568:568` |
| Runtime working directory | `/app` |
| API port | `8088` |
| Storage mount | Existing host dataset mounted at `/app/storage` |
| Database | `/app/storage/data/viewer.sqlite`, schema 38 at import |
| Worker command | `node server/workerSupervisor.js` |
| Runtime configuration | Existing persistent `viewer.env` |
| External import mount | Existing read-only `/imports/webodm` |

There is no storage relocation, credential rotation, data import or database
schema migration in this source-consolidation change. Do not replace the stack
with a new empty installation or copy the example configuration over existing
secrets. A private new GHCR package may require your existing registry identity
to be granted pull access to that package.

Use the existing update window: pause new processing admission, allow durable
work to settle, and pull/recreate the two services through your normal management
process. The copied `scripts/update-truenas.sh` now recognizes the new package;
an old downloaded copy of that script must also be replaced if you use it. The
script retains the prior image locally for rollback and does not move, delete,
create or change ownership of the host storage root.

After updating, check API readiness, the worker heartbeat, the expected source
revision and visibility of existing projects/models. This migration is intended
to preserve existing Viewer URLs and Ops service endpoints. Do not change URLs,
service signing secrets or client grants merely because the source repository
changed. Roll back to the previous image with the same services, mounts and
configuration if verification fails.

Production TrueNAS updates remain operator-performed; this repository migration
does not authorize an agent to access TrueNAS administration.

## Verification

From the Operations repository root:

```sh
npm --prefix apps/viewer ci
npm --prefix apps/viewer run check
docker build -f apps/viewer/Dockerfile apps/viewer
```

`test/monorepo-migration.test.js` compares the entire canonical Compose file
against the checksum-bound upstream fixture and permits only the image-name
change. It checks container/package identity and reopens a disposable schema-38
database while preserving a synthetic existing catalog marker and model asset.
The full Viewer suite and exact-image native-tool/runtime checks remain required;
the source-level compatibility test is not evidence of a live production update.

## Outstanding upstream work

The old repository is retained as source history and rollback reference. These
open changes were not silently folded into the pinned import:

- [PR #21](https://github.com/ledgetoptechnologies/3D-Viewer/pull/21): Claude's
  production Viewer UI and current-tab recovery work; review and port separately.
- [PR #10](https://github.com/ledgetoptechnologies/3D-Viewer/pull/10): held UI
  work on `dev`; retain its hold and history.

Do not archive or delete that repository or its outstanding branches until all
required work has been accounted for and the monorepo release is verified.
