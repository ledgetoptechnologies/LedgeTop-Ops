# Reference result spool — unexposed draft

**Not ready to use or deploy.** `referenceResultSpool.js` is not called by an
application route, worker or startup hook. It cannot authenticate an archive
root, establish exclusive writer fencing, issue a Viewer acceptance receipt,
publish a model, or authorize upstream cleanup.

The existing Viewer extraction path removes its temporary source ZIP after
extracting it. The reference acceptance ledger instead requires the original
result object to be retained and verified. This draft explores copying a fully
verified stream into an externally authorized Linux directory descriptor,
syncing the file and directory, and refusing to overwrite an existing name.

The draft `referenceResultJournal.js` binds the job, generation, environment,
input and result manifests, object, local path and root identity before it
attempts a file write. A pre-existing object is rehashed and synced before the
journal can record readiness. This does not issue an acceptance or prove the
caller supplied authentic job/engine bindings and root authority.

Before use the application must reconcile failures before or after link,
unlink, directory sync and receipt commit. In particular a crash during fresh
journal schema initialization can leave an empty or partial database: opening
it intentionally fails closed and requires an ownership-verified recovery
procedure. A linked final file may remain after an error. A temporary hard link
may also remain after interruption; neither is safe to remove or reuse without
independently verified ownership.

The caller must supply verified root identity and exclusive writer fencing;
the current function only checks a caller-supplied assertion and descriptor
identity and does not establish either. Linux tests, including injected I/O
errors, competing writers, process termination and crash recovery on the target
filesystem, have not run. No source-custody or cleanup authority is implied.
Reference provider dispatch and the Viewer result-to-model pipeline remain
unimplemented and must remain disabled.
