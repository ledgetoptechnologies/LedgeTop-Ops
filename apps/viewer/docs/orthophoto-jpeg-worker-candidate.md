# Dedicated JPG worker candidate

This source increment adds the Linux profile and post-job closure observer for
the planned dedicated JPG worker. It does not start a worker, activate the API,
decode an image, register a download, or change an installed service.

The worker must use the API's local SQLite database on the same NAS. A shared
network WAL is unsupported. The filesystem helper rejects unknown/network types;
an allowed local type does not establish colocation or durable storage.

Before claiming work, the eventual worker must observe UID 568, no effective
capabilities, no-new-privileges, a 2 GiB memory limit, zero swap, a PID limit of
64, at most one CPU, and loopback-only networking. It requires a read-only
cgroup-v2 root with no descendants. Both cgroup membership and the namespace's
process list must contain only the worker and, optionally, a recognized PID 1
init. Every observed PID's start ticks are read twice to reject lifetime changes
even when the PID set stays the same.

After conversion, the same limits, cgroup identity and original PID lifetimes
must be observed again before releasing the job fence. Unknown closure must
retain the queue's cleanup-required fence and stop further claims. The helper
does not terminate children or clear a queue lease itself.

Pure fixture validation never claims kernel observation. Actual inspection is
Linux-only. Neither establishes the host's private namespace, Engine/image
identity, init binary identity, or physical host cleanup. Recognizing an init's
comm name is not binary verification. Those remain deployment-owner checks.

Six lightweight fixture tests cover limits, privileges, extra processes and
zombies, mismatched membership, reused PID lifetimes, changed cgroups, and
rejected network filesystems. No host, native image decoder, converter, cgroup or
container was exercised by these tests.

Remaining implementation: dedicated service entry point, bounded Python/cjpeg
execution and cancellation, queue heartbeat/closure integration, independent
output validation and registration, download authorization and UI. The pinned
cjpeg image and libraries, real full-resolution fidelity, resource coexistence,
combined migrations and staging acceptance are still unverified. Keep requests
disabled until the complete delivery path is qualified. This increment does not
change or gate the separate mesh calibration lane.
