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

Before use, the application needs a durable journal binding the exact job,
generation, environment, input and result manifests, object, local path and
ownership state. It must reconcile a process failure before or after link,
unlink, directory sync and receipt commit; a pre-existing result currently
returns `EEXIST`, never authorizing acknowledgement. A linked final file may
remain after an error. A temporary hard link may also remain after interruption;
neither is safe to remove or reuse without independently verified ownership.

The caller must supply verified root identity and exclusive writer fencing;
the current function only checks a caller-supplied assertion and descriptor
identity and does not establish either. Linux tests, including injected I/O
errors, competing writers, process termination and crash recovery on the target
filesystem, have not run. No source-custody or cleanup authority is implied.
Reference provider dispatch and the Viewer result-to-model pipeline remain
unimplemented and must remain disabled.
