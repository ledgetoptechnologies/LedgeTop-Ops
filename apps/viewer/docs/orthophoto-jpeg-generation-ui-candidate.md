# JPG preparation UI candidate

Stacked source successor to download PR #615. No installed or visual acceptance
is claimed, and all default-off request/download/worker gates remain unchanged.

The staff Downloads dialog offers **Prepare full-resolution JPG** only to a
processing writer, for the exact current model/version described by the server.
The descriptor is absent unless request configuration and encoder pin are enabled
and the registered source is eligible. Opening or rendering the menu performs no
conversion, queue mutation, background polling or automatic retry. Existing JPG
products replace the preparation offer with the normal download choice.

An explicit click submits only the version ID and an idempotency key to the
existing authorized API. Network failures and malformed responses preserve the
same immutable payload/key for an explicit retry. Concurrent duplicate clicks
are rejected. The existing guarded direct-fetch path checks the captured
authorization epoch before dispatch and bypasses cross-session renewal replay.
At most 100 unresolved receipts are retained in memory. They are
discarded on authorization clearing/change; an epoch prevents stale responses
from updating the UI after a cleared context is reused. A full browser reload
does not preserve these receipts, but server-side source/policy request dedup
still prevents duplicate jobs for an unchanged request cohort. This is not
durable client reconciliation across reloads.

Queued/running/succeeded/failed/cleanup-required states have distinct messages.
There is no automatic failed-job retry or cleanup takeover. **Refresh products**
explicitly reloads the workspace and its current source-bound status/products.
Full-resolution dimension limits and server failures remain explicit errors;
the TIFF is retained. A pending job is not described as a ready download.

Validation uses pure UI controller/light DOM fakes plus actual in-memory SQLite
and tiny HTTP tests. No browser/render/build/native conversion runs on Beau's
PC. Real appearance, interaction, installed asset packaging, worker progress,
session renewal, conversion fidelity and staging behavior remain acceptance work
on the admitted server. The module is statically imported by the existing
workspace entry, but a source import is not a verified production bundle.

The preparation status lookup uses the same process-cached converter script
hash and configured encoder hash as queue requests, alongside source and policy.
Historical jobs from a different software cohort do not hide the current request
action. The guarded transport also checks the epoch after response parsing and
before authorization side effects, so an old in-flight 401 cannot clear a newer
session.

Seventy-five serial lightweight checks pass across the JPG API, registry,
capabilities, UI controller and existing download/workspace regressions. One
existing isolated VM fixture was updated for the new receipt-clear dependency
and asserts that clearing occurs once while upload preservation stays intact.
Independent review findings on dispatch authority, stale 401 and software-cohort
selection were fixed and rereviewed. Real browser/native acceptance remains open.
