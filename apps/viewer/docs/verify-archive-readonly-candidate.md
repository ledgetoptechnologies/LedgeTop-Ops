# Read-only archive check: candidate only

`scripts/verify-archive-readonly.cjs` is an unmounted operator candidate. It
opens the configured Viewer database read-only, requires exact task/provider
task IDs and a unique attempt, checks its saved receipt/inventory digest, then
walks the configured models directory one file at a time and compares paths,
sizes and hashes. It does not create directories or intentionally write data.
Its only intended output is `PASS point-in-time`, `MISMATCH contents`, or
`UNAVAILABLE` plus a generic category; it never prints an input ID, path,
file name, receipt or error. It does not verify the original compressed ZIP,
prove an authenticated receipt, pin a storage snapshot, ensure future
custody, or establish the absence of EPT outside this archive inventory.

This source has not been matched to an actual deployed image, tested inside
its Linux container, or qualified against adversarial concurrent parent-directory
rename and storage mutation. A synthetic parent replacement test holds, and
directory and named-file identity checks were added, but the walk is still
path-based rather than descriptor-pinned. Do not run a production command until the
operator verifies the exact installed build, runtime, mounts, privileges and
isolated read-only behavior. A scan can read up to 500 GiB sequentially and
should be scheduled with regard to other workloads. Windows did not permit
synthetic symlink creation. Processing independently reports the committed
`ff52034d` test passed 1/1 in an ephemeral Node 24 Linux container, including
the symlink rejection and injected read error; image
`sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`,
one CPU, 512 MiB, no network and read-only source mount. The temporary container
exited. That closes the synthetic Linux case only; actual deployed-image match,
descriptor-pinned/adversarial rename safety and any live scan remain unverified.
No production dataset or client file was read for this candidate.
