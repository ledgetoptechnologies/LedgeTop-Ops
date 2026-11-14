# JPG file adapter source candidate

This source increment supplies the concrete preparation, execution, validation,
resource release and private evidence hooks for the dedicated worker. It does
not start a service or enable JPG requests/downloads.

The adapter requires Linux UID568, canonical private cache storage, the shared
storage reserve and actual local scratch headroom. It binds the exact registered
source root/path on every fresh check, including UUID-qualified external model
roots. It keeps source, root-owned converter script, plan and output descriptors
open through validation. Full hashes stream through one reusable 1 MiB buffer;
file identity uses lossless BigInt stat fields. Changed paths, source bytes,
script bytes, output inventory or private permissions reject completion.

Plans and evidence are exclusive private files, flushed with their parent
directory. Retry artifacts use the lease UUID; originals and partial artifacts
are never overwritten or removed. Validation independently hashes the exact
PPM/JPG/stderr/receipt inventory, checks the bounded JPEG header and receipt,
then rechecks source/script bytes and held file identities. This is not a pixel
decode or a native fidelity qualification.

The worker now requires a successful resource-release acknowledgement before
process closure, private evidence and SQL completion. Failed or unacknowledged
release retains the original cleanup fence and halts further jobs. Preparation
must close everything it opened on failure; uncertain descriptor cleanup cannot
be dismissed by an empty process snapshot. Null cancellation/rejection remains
a failure and follows the same cleanup path.

Pure checks cover source-alias retargeting, cache binding, lossless timestamps,
bounded private evidence, scoped roots and queue/resource-release failures.
Sixty-eight focused serial checks pass under a 128 MiB Node heap across API,
metadata, queue, process/profile fixtures, orchestration, validation and IO
helpers. Independent source review resolved source-alias and storage-reserve
gaps and found no remaining issue in the resource-release changes. These checks
do not execute the Linux filesystem adapter, a native converter or a real model.
Three separate Linux filesystem fixtures cover real pin/hash/close/evidence IO,
alias retargeting and source mutation using synthetic data and a fake executor.
They require explicit VIEWER_JPEG_IO_FILESYSTEM_TESTS=1, Linux UID568 and separate
owner workload admission. They have not been executed. The opt-in is a test
selector, not permission or runtime qualification. No Python/cjpeg/GDAL decoder,
model, container or host probe ran during source work.

Remaining requirements: execute those filesystem fixtures in an admitted owner
namespace; finish service composition, image/software qualification, actual
full-resolution conversion/fidelity/resource tests, product registration,
current staff/client download authorization and UI. Preserve the original TIFF,
all other retained data and permissions. Requests must remain disabled until the
complete delivery path passes staging checks.
