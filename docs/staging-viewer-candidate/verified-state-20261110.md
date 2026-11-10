# Staging Viewer verification checkpoint — November 10, 2026

This checkpoint supersedes the deployment-status paragraphs in the earlier
design document. It is not a production release or a completed photo acceptance.

## Current installed state

The staging API/proxy, worker and capacity monitor are active under systemd.
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

## Remaining acceptance

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
