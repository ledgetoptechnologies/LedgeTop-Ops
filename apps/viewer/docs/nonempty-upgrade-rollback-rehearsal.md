# Offline nonempty upgrade and rollback rehearsal

This test is an isolated evidence fixture, not a release or rollback procedure.
It requires `LT_OLD_VIEWER_CHECKOUT` to name a separately verified clean checkout
of the previously reported deployed source `c2bba3d589ad0ea4718e94dc72f742b7c0d0e5ff`;
the test does not independently verify that checkout's commit. Without the
variable the test is skipped. The candidate source was `655da439317fb5f8edd4e03ab7d61cddf6dc9922`.

The fixture creates and retains a unique synthetic temporary directory. It
opens a nonempty old-version database with a leased ingest and separate pending
work, takes an SQLite snapshot, migrates the live synthetic copy, and opens a
separate copy of the old snapshot with the old source. It confirms the pending
and leased rows and SQLite integrity in that isolated old copy, while the
upgraded database retains a newly added publication intent. It does not overwrite
the upgraded database or exercise real job processing during rollback.

The test demonstrates that the old repository's heartbeat can renew a reclaimed
ingest lease with the same owner despite a newer generation, and the old
migration runner accepts schema 41. Thus #403's cooperating-writer generation
checks do not fence old binaries. A pre-upgrade backup also lacks an intent added
after the upgrade; restoring it over a live newer database would discard state.
The fixture does not prove old-process quiescence, real storage locking, crash or
power-loss durability, production image contents, or safe rollback after writes.
See `legacy-ingest-release-gates.md` for the still-required operator gates.
