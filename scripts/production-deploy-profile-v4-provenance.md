# Canonical installed production profile v4

This profile records the existing installed canonical browser hosts. Its canonical
JSON SHA-256 is `2ef0f21be881bbe1567e4ea941255ea1f6e1be9a339c1f854174c5ac334a10fd`.
It was compiled offline from the completed main `2686c535` Client and Operations
release receipts and an authenticated full capture at 2026-11-05T15:04:24.059Z.
That capture's digest is `3d8dde3b9c7ae611c4eb2922cb3e49b3283820b80e836267c5d5bbcf2ffcdf30`.
The compiler candidate was offline-only; this source adoption performs no provider
mutation and does not establish release or migration readiness.

Client active version: `7ebfd9ba-e293-482d-84f9-08d1c6901b88`.
Operations active version: `af10de97-d629-4af8-9f1b-de6b8c3d0917`.
Sync remained `6f8e224c-4202-4904-9de5-b78886b52e74`.
Client retained 184 assets; Operations retained 550. The earliest pruning times
are respectively November 7, 2026, 14:14:31.899Z and 14:38:14.355Z. Unexpired
asset paths and actual bytes must carry forward; no automatic pruning is authorized.

The profile preserves bindings, secret names, staff controls, non-host flags and
public-link compatibility. It reflects canonical Operations and Portal origins
already installed by the consumed guarded release. Historical v3 transition
profiles and consumed actions must not be replayed against this installation.

Ordinary frontend release admission must select the exact v4 preservation lane,
retain current source/CI, owner-authority, predecessor and asset-retention fences,
and observe the installed database schemas without running DDL. Pending source
migrations remain pending. This profile does not authorize their application,
feature activation, native staff cutover, access grants or credentials.
