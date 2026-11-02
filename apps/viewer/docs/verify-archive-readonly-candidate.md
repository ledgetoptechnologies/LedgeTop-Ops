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
its Linux container, or qualified against concurrent parent-directory rename
and storage mutation. Do not provide or run a production command until the
operator verifies the exact installed build, runtime, mounts, privileges and
isolated read-only behavior. A scan can read up to 500 GiB sequentially and
should be scheduled with regard to other workloads. Windows did not permit
synthetic symlink creation in the initial test, so that case needs a bounded
Linux test before qualification. No production dataset or client file was
read for this candidate.
