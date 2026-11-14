# Dedicated JPG worker candidate

This source increment adds Linux profile/closure observation, queue orchestration
and a fixed Python subprocess executor for a dedicated JPG worker. It does not
start a service, activate the API, decode an image, register a download, or change
an installed service.

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

Queue composition is disabled by default and requires a dedicated role and
qualified runtime before claiming. It renews a 30-second lease every ten seconds,
has a 900-second job deadline, and permits only one operation at a time. It
requires matching independent process closure plus durable private validation
and closure evidence before completing the job. Closure/evidence uncertainty
halts immediately even if transient; it is never retried to manufacture a safe
outcome. The original owner/token is marked cleanup-required without releasing
the global queue fence. Cancellation is passed through server-owned preparation,
validation, observation and evidence hooks. Cleanup gets a separate signal and
one shared deadline of at most ten seconds, within the original job deadline.
Hooks that ignore cancellation remain uncertain; an elapsed wait does not prove
their IO finished or permit clearing the fence. Deployment must stop/close the
dedicated service before an operator resolves that fence.

The process helper invokes only /usr/bin/python3.11 with an explicitly inherited,
server-pinned script descriptor and a private plan path. It retains no stderr
content and counts/drains at most 64 KiB before cancelling. It waits for close,
not merely exit. TERM/KILL requires the original leader's current PID/start
ticks/process group/session identity; it never signals the group after leader
exit. An inherited pipe after normal exit has a ten-second wait. The unavoidable
kernel gap between reading identity and signalling is not an atomic ownership
guarantee: dedicated namespaces/cgroups and deployment-owner isolation remain
required. Leader/pipe closure alone is not descendant closure.

Source tests compose the real in-memory SQLite queue with synthetic runtime,
process and IO hooks. They cover lease loss, cancellation, source withdrawal,
transient uncertainty, ignored cancellation, failed evidence and overlapping
claims. Fake-child tests cover invocation, process identity changes, escalation,
unobservable identity, inherited pipes, deadlines and bounded stderr. They do
not execute Python/cjpeg or observe the real kernel.

Fifty focused checks pass under a 128 MiB Node heap with serial execution:
staff API, TIFF metadata, queue transactions, worker orchestration, profile
fixtures and fake subprocess lifecycle. Independent source review found and
resolved transient uncertainty retries, missing bounded hook context and late
hook settlement beating timer delivery; final readback found no remaining
actionable regression. No native process, model decode, container or host probe
ran. Tiny HTTP fixtures and in-memory databases close at test completion.

Remaining implementation: dedicated service entry point and concrete hooks for
source/script pinning, plan preparation, independent output validation, durable
evidence, output registration, download authorization and UI. The pinned
cjpeg image and libraries, real full-resolution fidelity, resource coexistence,
combined migrations and staging acceptance are still unverified. Keep requests
disabled until the complete delivery path is qualified. This increment does not
change or gate the separate mesh calibration lane.
