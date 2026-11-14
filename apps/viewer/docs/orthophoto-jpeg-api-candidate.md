# Staff JPG request/status API candidate

Stacked source increment on job PR602. Generation requests default off through
ORTHOPHOTO_JPEG_REQUESTS_ENABLED=false. Enabling requests requires the configured
ORTHOPHOTO_JPEG_ENCODER_SHA256; this is not software qualification or worker
activation. No running configuration was changed.

POST /api/v1/models/:modelId/orthophoto-jpeg-jobs accepts only {versionId}. It
requires current staff viewer.processing.write and an Idempotency-Key. The server
selects the current registered ortho and reads bounded first-IFD dimensions;
callers cannot choose paths, hashes, encoder, scale or dimensions. Metadata reads
are not full integrity verification or image decoding. The worker must still
hash the full source and validate its native layout before conversion.

After metadata IO, staff authority is checked again. A source fingerprint is
checked inside the job transaction, preventing a changed source from acquiring
stale dimensions. The job, audit and202 idempotency response commit together.
Known rolled-back failures can release only their own pending receipt after a
successful explicit rollback acknowledgement; rollback failure or uncertain
committed state remains reserved. Exact replay does not reread source metadata
or enqueue duplicate work. No conversion runs in the HTTP handler.

GET /api/v1/models/:modelId/orthophoto-jpeg-jobs/:jobId requires current staff
viewer.processing.read and exact model/job ownership. Responses are private and
no-store; the status DTO omits raw paths, lease identities, policy hashes and
worker evidence. Neither endpoint accepts client Viewer capabilities or creates
public links, source grants or download access.

Twenty-one focused checks pass (6API/9metadata/6queue), using tiny synthetic metadata and in-memory SQLite with real staff
and idempotency middleware. They verify replay, disabled-before-IO behavior,
read-only/unauthenticated denial, source drift/withdrawal and session revocation
after async reads, atomic audit-failure rollback/retry, failed-rollback reservation
retention and rejected caller fields. Both modern and legacy reduced-image flags
are rejected without reading pixel data.
No native, real raster, GPU, image build or host workload ran.

Worker execution and coexistence admission, actual cjpeg image/software closure,
output validation/registration, client/staff download authorization, UI,
combined migrations and real staging acceptance remain required. Default-off
requests must stay off until those operational prerequisites are qualified.
