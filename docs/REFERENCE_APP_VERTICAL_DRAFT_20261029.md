# Reference application vertical slice — disabled draft

This branch combines the reference-dispatch and result-bridge prototypes. The production worker reference lane remains unconditionally disabled; no route issues source custody or a writer-drain authority.

The dispatcher now supplies the immutable input-manifest digest in the field required by the result journal. The cross-platform test verifies that handoff using the actual result-binding validator.

A Linux-only synthetic test joins the dispatcher with the actual provider, result journal, acceptance ledger, archive extraction and verification. It covers a lost acceptance reply and shows that an expired lease alone does not allow a replacement. Only after an explicitly labeled fixture-only terminal-writer attestation does the test clear the lease and attempt an identical acknowledgement replay. That SQL update and synthetic authority are test scaffolding, not an implementation or proof of production recovery.

The Linux test has not been run on Windows. A new child process reopens the file-backed result journal and ledger and replays the exact synthetic acknowledgement after a simulated lost reply. That child does not restart the application dispatcher: the application journal remains in memory, the ingest receipt is a synthetic fixture, and no actual Viewer publication occurs. Production requires an authenticated writer-drain authority, current access and source-custody checks, durable ingest receipt and immutable acceptance plan, real worker selection/scheduling and reclaim, Linux filesystem qualification, and a configured result-size bound appropriate for actual archives. Neither the synthetic result nor an acknowledgement authorizes source cleanup. Migration and old-writer compatibility remain unverified.
