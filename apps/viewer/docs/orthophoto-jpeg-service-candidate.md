# Dedicated JPG service composition candidate

`createOrthophotoJpegService` wires the actual queue repository, filesystem IO,
fixed process executor and worker. It is default-off and performs no IO at
construction. A caller must supply its own database connection, storage manager,
owner ID, private staging parent and trusted `assertRuntimeQualified` function.
The service is not mounted on HTTP or started by the normal processing worker.
There is no environment flag that supplies qualification or bypasses it.

`runOne({signal})` runs at most one queue job through the existing worker. The
same service retains its worker's busy/halted state across calls. It does not
create timers between jobs, auto-retry failures, steal leases, close a caller's
database or register process-wide signal handlers. The admitted host owns its
one-shot lifetime and cancellation. Default-off construction and unsuccessful
qualification do not query the database, resolve storage or invoke native tools.

## Host contract still required

Processing owns physical host admission and image/native execution. A real
service entrypoint and runtime qualification source must be agreed with that
owner; this factory does not invent an admission file, unsigned trust assertion
or accepted registry entry. It is not an installable or admitted service by itself.

The unchanged kernel checks require Linux UID568, no effective capabilities,
no-new-privileges, private dedicated PID/cgroup namespaces, no network interface
besides loopback, CPU at most one, exactly 2GiB memory, zero swap, PIDs64 and a
known single Node process with at most its verified init. The host must also
independently establish image/engine/init/private-namespace identity, API/worker
SQLite WAL colocation on durable local storage and finite lifetime limits.
The API must apply the reviewed migration stack before a worker connects.

The qualified image must contain the reviewed Python/GDAL/cjpeg versions and
hashes, with the converter script root-protected and the encoder hash matching
the requested job. Mount sources read-only and the private cache/evidence and
same local database writable under the reviewed storage contract. Retain source
TIFFs and failure evidence. The fixed IO module requires the supplied staging
parent to resolve exactly as cache/orthophoto-jpeg and independently pins it.

Source tests cover disabled construction, invalid composition, qualification
rejection before any queue/storage access, and pre-cancelled work. They do not
run the Linux profile, filesystem hooks, subprocesses, encoder or pixels. Native
image qualification, actual service entry, durable shutdown, resource/fidelity,
installed products and staging acceptance remain open. No deployment occurred.

Forty-nine lightweight service/worker/profile/process/IO/validation checks pass.
Independent source review found that a bad staging path could fail only after
claiming work. Construction now rejects the exact noncanonical/non-root path
cases that IO rejects; targeted checks pass and the fix was independently
rereviewed. No real process, kernel-profile or filesystem execution is implied.
