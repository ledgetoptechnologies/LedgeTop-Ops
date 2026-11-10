# Staging Viewer verification checkpoint — November 10, 2026

This checkpoint supersedes the deployment-status paragraphs in the earlier
design document. It is not a production release or a completed photo acceptance.

## Current installed state

The staging API/proxy, worker and capacity monitor were qualified under systemd.
The Processing owner currently controls the deliberate worker-off recovery
test described below; do not independently restart or recreate these services.
API and worker use Viewer image digest
`5b78e6122467968e617932a4d4a19388db7dac576449acb4bf1c790f723170c5`;
proxy uses `697b0b156c70b91130853fd0675c6be36665939d5f93dce2686be04b4c3f98a8`.
The new database is `/var/lib/ledgetop-viewer-photo-staging/db/viewer.sqlite`.
The prior Viewer database was not migrated or replaced.

Installed file SHA-256 values:

| File | SHA-256 |
| --- | --- |
| API `95-photo-queue.conf` | `c0f26280cf4e1c5bf354d4ecf43c3ea584a4041769c2813a31d395b2a0ef2bd6` |
| Worker unit | `2b056dd73b8cd0a23ac42293764db32f082bd1e9d0cc5a17350c46176ee9b74a` |
| Monitor unit | `7bcf55a1bcd3401773fa3be25a81ac9c11cad76e3cd151f3ce7e9b09a983a976` |
| Runtime preflight | `41f43c0c61650014ee0eba1f947e236501055e0efc7ac581eb21e75ef60c5752` |
| Capacity monitor | `444bbe9e5760fadca9188e435a2de61b295424386e1ecc8f569a7a3e72a32ca5` |

The API now requires an existing database on restart. Automatic restart remains
disabled during qualification. The worker creates/checks its stopped container
before starting it and checks the live API/proxy, database and pinned network
policy. Actual post-start verification checks worker health, image, mounts,
configuration and attached network IDs. No photo submission is authorized by
the service merely being active.

## Observed checks

- First API initialization: HTTPS readiness 200; schema 42/42; SQLite quick check
  `ok`; expected database and read-only coordinator CA mounts.
- Controlled API/proxy restart: same database inode and schema, quick check `ok`,
  HTTPS readiness 200, running network preflight passed.
- Worker stop/start: same API and proxy container IDs stayed healthy; worker
  post-start runtime preflight passed; database integrity `ok`.
- Actual monitor stop: worker became inactive while API stayed active. Starting
  the worker service restored monitor and worker; runtime preflight passed.
- Processing owner independently corroborated active services and final runtime
  and network checks. Its initial check during deliberate monitor restart failed
  transiently, then passed after recovery.
- Last observed processing-attempt count was zero. Provider credential entry
  and the actual 20-photo acceptance remained pending at this checkpoint.

## Upload transport and credential follow-up

The first real 20-photo upload was rejected by the staging Nginx 5 MiB default
body limit before task creation. A route-specific 32 MiB limit was added only
to `/api/v1/admin/uploads/{upload}/files/{file}/chunks/{index}`, with request
buffering disabled and existing proxy headers retained. `nginx -t` and reload
passed; an unauthenticated 16 MiB request reached API authentication and returned
401 rather than 413. The repository's general Nginx example already supports
large chunk uploads; this was drift in the separately managed staging config.

During diagnosis the staging proxy-header secret was accidentally displayed in
tool output. It was subsequently rotated entirely on the staging host, and the
new value was verified to match the proxy, API and worker without displaying
it. API and worker were restarted; readiness 200 and full runtime preflight
passed. A concurrent dependent-container recreation initially conflicted with
asynchronous API startup. Recovery waited for API health, replaced only the
stopped worker container, and started it through its systemd unit. No volumes
or retained upload were removed. The original failed upload was preserved.
Its browser retry context had already been lost; a fresh, distinctly named
20-photo submission was used for the acceptance run instead.

## Acceptance run and local retry coverage

The Processing owner reported successful finalization of all 20 photos and a
running staging coordinator task. That owner now controls the worker-off test:
keep API/proxy/monitor intact, let the exact engine task finish and persist its
archive, then restore the worker and verify import and durable acceptance.
Completion, rendering and acknowledgment are still unverified here.

Local commit `bb643956` preserves an in-dialog dataset retry only when the
complete newly hashed manifest matches. `4aad20ae` verifies that identical
filenames and sizes with different bytes cannot reuse that retry identity.
All 19 New task browser checks passed. The local HTTP regression also verifies
that a duplicate dataset name returns 409 without inserting another dataset,
and that a distinct name succeeds. Neither local change has been deployed.
The wider filesystem lifecycle suite requires Linux `/proc/self/fdinfo`; its
Windows run stopped during storage initialization, so it is not counted as a
passing lifecycle test. The metadata-only HTTP check passed independently.

Current CSV retention is intentionally fail-closed but remains a usability
gap: retained CSV records and source snapshots block dataset, task and project
trash/purge. Independent custody must be established and verified before any
guard is relaxed. Merely retaining a parsed GCP set is insufficient: invalid
CSV bytes, per-file provenance and attached source snapshots must survive too.

## GCP interaction follow-up

Local commits `13530981` and `040b3981` prevent late photo responses from being
displayed under a different selected image and prevent late candidate pages
from mixing control points. Obsolete image requests are aborted; any late blob
URL is revoked. Nineteen focused GCP interaction checks passed. A local compiled
bundle also built using the existing dependency installation via explicit
resolution aliases; that is not a clean-install release build.

The broader compiled workspace browser test stopped before reaching GCP at an
obsolete `manage-customers` selector in this integration candidate's fixture.
Do not count that run as end-to-end GCP or whole-workspace acceptance. The
installed `80bb4be` source does not expose that action, while this integration
fixture still expects it. Resolve that fixture/UI mismatch separately.

Subsequent local commits restored the Customers entry, project breadcrumbs,
customer groups and status filters. The compiled project-first browser test
then passed separately at 1440, 390 and 320 pixel widths, including GCP image
marking. A standalone compiled GCP test verified clicked photo coordinates
through create, update and delete. These are synthetic browser fixtures, not
live client or staging acceptance.

The Linux synthetic GCP suite passed 45/45 using task-owned `/tmp` in the
existing staging API container, then removed that temporary directory. It
covers source detection, permanent CSV holds, preparation, generated ODM file
and a simulated provider submission. Native profile/cross-section browser
checks passed 9/9; the volume inspector passed 9/9 against a synthetic API;
the WebGL movable cut-plane mesh/point-cloud test passed. Current navigation
and unsaved-measurement guard tests passed 18/18. These do not establish live
numerical accuracy on the retained production models or real NodeODM receipt.

Claude noted that opening model sessions in the same tab would stop the
existing opener-based automatic renewal. The current fixed staff/client return
navigation should remain in place until a separately verified renewal design
supports that transition. This note is not authority to broaden sharing.

The isolated upload retry release is draft PR #485, head
`8557cb69253e7e214066ce1c3209be099c2434d4`, based on `80bb4be` with only four
files changed. It excludes this GCP integration. Its own nineteen New task
browser checks and metadata HTTP conflict regression passed; an independent
read-only review found no new scoped correctness blocker. No branch Actions,
release image, deployment or production activation was performed.

## Remaining acceptance

Later qualification of the local integration candidate ran the complete GCP
server tests together with source-snapshot, preclaim, selected-generation,
transfer-provenance and processing-overview tests in a resource-limited Linux
container: 78/78 passed. These are synthetic tests; they do not establish real
NodeODM receipt, live Viewer measurement accuracy or installed acceptance. The
test container was removed. The separate archive fix candidate is not yet
integrated or qualified for production.

Complete staging-only provider authentication and capability checks without
exposing its token; verify worker egress and denied routes; run the authorized
20-photo fixture and verify output import/render, durable acceptance and restart
behavior. Preserve source and results until verified cleanup. GCP, client
sharing, measurement browser workflows, V2 integration and production release
remain separate incomplete requirements of the overall goal.

The local disposable Compose fixture was removed after Docker Desktop recovered:
both exact task-owned containers were deleted and no project containers or
networks remained. Do not touch retained synthetic Viewer stacks or other
agents' processes.
