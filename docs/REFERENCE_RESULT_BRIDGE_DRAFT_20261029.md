# Reference result bridge: unmounted development draft

This module is not imported by the application and must not be enabled. It is
an integration candidate, not an issuer of source custody, an exclusive writer
fence, or proof of publication. The default application still rejects reference
admission.

For the plain-photo case, the bridge revalidates the sealed result, journals and
retains the exact archive, requires a caller-owned durable and replay-safe Viewer
ingest and a separate verification, records the existing acceptance ledger, then
posts the immutable receipt. The acceptance ledger and the result journal must
refer to the same root inode; the receipt's storage ID must match the journal's
binding-derived key. A lost acceptance reply leaves the ledger outbox for replay.
The caller must re-establish current authorization and hold the actual trusted
storage/writer fence for the entire operation. No result acceptance authorizes
deletion of source data.

Before app integration: implement the real Viewer ingest and persistent receipt
verification callbacks; safe restart/partial-ingest recovery and publication;
trusted provisioned root and same-filesystem identity plus old-writer drain;
source custody and purge protection; caller authorization on every replay;
ledger initialization recovery; cross-process and Linux crash/fsync tests; and
actual Viewer-to-Processing integration. The journal and ledger roots must not be
replaceable by untrusted writers; inode comparison alone is not a fence. Receipt
identity/time must be durably persisted before invocation, not regenerated on
retry. The code accepts exactly one ODM archive, not a multi-object pipeline.

The Linux test uses the actual provider class, journal, acceptance ledger and
archive extraction with a synthetic transport and test authority. It reopens
databases in the same process and keeps the extraction receipt in memory. It is
not a real process restart, application model publication, external-writer test,
or proof of power-loss durability. On Windows this test is skipped.
