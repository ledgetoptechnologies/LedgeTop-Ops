# Native staff bootstrap installer core

This module is a source-only prototype for the out-of-band bootstrap described
by migration 0060. It has no Worker route, Wrangler binding, production target,
credential loader, or command-line entry point. The current production
readiness tool remains read-only.

`prepareNativeStaffBootstrapInstall` accepts only already-existing canonical
plan and identity-binding evidence, a separately supplied approval envelope,
and a reviewed schema/cohort/control-plane/permission snapshot. It requires a
separately injected `verifyTrust` function. A caller-provided boolean, email,
role, or ordinary Worker credential cannot satisfy that requirement. This
repository does not yet define or provide the independent root-signature
format/verifier or an actual owner-accepted bootstrap artifact; therefore this
prototype cannot produce an executable production approval.

`executeNativeStaffBootstrapInstall` requires a separate management adapter
whose `withImmediateTransaction` holds a write lock across the complete
callback and rolls back on any error. Inside that transaction the core checks
the current migration ledger, complete reviewed cohort, control-plane set and
permission-state digest, rechecks the trust envelope, refuses reused IDs and
conflicting existing rows, inserts only plan-owned rows from a fixed native
authority table/column allowlist, and writes the immutable 0060 receipt last.
It never edits legacy Operations or PA roles, permissions, scope grants,
identity bindings, or existing native authority rows. The core intentionally
does not implement a Cloudflare D1 adapter: a D1/Worker integration would need
a separately reviewed mechanism that provides equivalent transactional
snapshot fencing and independent trusted authorization.

The local test uses synthetic test-only trust fixtures and SQLite's actual
0057, 0059 and 0060 DDL to exercise successful transactional writes, one-shot
receipt refusal, changed permission state, revoked trust, and atomic rollback
on receipt failure. Those tests are not owner acceptance, operator approval,
production schema validation through migration 0225, or release authorization.
