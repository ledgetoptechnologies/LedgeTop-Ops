# Automatic production release readiness

The automatic release workflow remains disabled until its credentials, response
encryption recipient and independent production readiness requirements are
reviewed and provisioned. Merging this tooling does not enable deployments.

Every Operations, Client Portal and Sync release checks both production D1
migration ledgers. The reader uses fixed account/database identities and one
fixed, read-only `SELECT` per database. It compares the ordered, complete ledger
names with migrations in the exact checked-out CI commit. Missing, additional,
duplicate or reordered migrations refuse the release. Repeated observations
must preserve the same source and ledger digests. Checks run before preparation,
before provider mutation intents and during final verification.

The source inventory digest binds committed migration filenames and SQL bytes.
The live D1 ledger proves names and order, **not** the SQL bytes originally
executed. This workflow never applies migrations. A migration-bearing change
requires its separate reviewed migration procedure before release can proceed.
The reader has bounded responses, deadlines, redirect refusal and content-free
results; it does not export credentials, SQL bodies or client records.

Other activation prerequisites remain separate: the exact-commit native staff
cutover review is not a standing authorization for future commits. A recurring
release policy and fresh authoritative Access-group observation still need
implementation and review. The current temporary asset verifier also needs
Worker creation/deletion authority; its token must not be described as scoped
only to the three production Workers.

Retain actual bytes at every frontend asset URL served within the previous
48 hours, carry unexpired assets into subsequent releases, and record cutover
and earliest permitted pruning times. A rollback version or route configuration
alone does not prove old URLs work. There is no automatic pruning job.

CI exercises the migration reader and runtime mutation fences with synthetic
provider responses. Those tests do not constitute live production acceptance.
