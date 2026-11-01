# V2 delivery ledger fixture — unqualified

This standalone test fixture is not registered with the Viewer, is not an API,
and must not be used on a real database. `FIXTURE_SCOPE` is a programming guard,
not authentication or a production feature flag. There is no migration, route,
authorization, signature, source binding, transport, or deployment.

`createFixtureLedger(db, FIXTURE_SCOPE)` accepts an already opened SQLite fixture
database. `provision` fixes a synthetic job's manifest and byte/request limits.
`admit` accepts caller-supplied request hash, request ID, delivery ID and response
length; it atomically charges a delivery once, refuses an identical delivery
replay, rejects changed request identity/length, and holds a second delivery
while a first is active. It does not validate a canonical request or prove that
the supplied response length matches its hash. `fixtureProveStopped` is an
untrusted test assertion only, not a real process fence. `fixtureRead` returns
recorded or unknown, never authoritative absence. These are internal fixture
methods, not a proposed network or authentication interface.

Focused synthetic tests cover normal reopen, exit without explicit database
close after commit, quota, duplicate/conflicting IDs and sequential operations
through two connections. They do not prove concurrent races, kill-at-transaction
boundaries, storage power-loss guarantees, current authority, ledger epoch and
retention watermarks, signed adoption, predecessor fencing, or proxy behavior.
All are release blockers, along with paired wire and staging qualification.

`referenceV2AdmissionCandidate.js` adds an unmounted canonical request decoder.
It checks bounded strict UTF-8 JSON, decoded duplicate keys, exact canonical wire
bytes, closed fields, canonical 32-byte IDs, UUID/hash/ASCII syntax, and the
shared whole/empty rules; ranges stay rejected pending proof semantics. It
recomputes the domain-separated logical-request hash excluding delivery ID.
Shared Processing synthetic positive and negative fixtures are copied into
`test/fixtures` for independent Node tests. The exact `admitLiveV2` gate always
rejects and has no configuration switch; `createSyntheticAdmission` is solely a
fixture adapter and its scope is not an authorization or security boundary.

The copied fixtures and parser are provisional, not a negotiated wire or proof
of issuer/holder/current authority. The synthetic adapter accepts a caller-set
job budget and uses the test ledger; it does not verify a reservation, access to
objects, a real source digest, delivery fencing, signatures, rollback safety,
retention watermarks or any actual response stream. Production integration must
first define and implement those boundaries; it must not import this test path
or make the hard-disabled entry point configurable as a shortcut.
