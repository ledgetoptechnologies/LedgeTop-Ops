# Outer-v2 pinned-vector inspection

This is a test-only inspection of Processing's unagreed, incompatible,
inactive outer-v2 proposal. It does not mount a provider, advertise a
capability, change v1, issue/accept a receipt, or authorize a runtime action.
Every successful fixture result explicitly remains `hold`.

The optional test reads the `contracts/reference-v2-candidate` package from a
separately verified, read-only Processing checkout. The paired run used commit
`15d053ac976da6aabc6e3759f40620778bad8f6b`; the package subtree was unchanged
against that commit before and after. Its other unrelated worktree changes were
not touched. Input SHA-256 pins are embedded in the test helper for the exact
`valid/treedar_only.json`, `valid/combined.json`, and pinned native vocabulary.
The package inventory digest is review metadata, not a negotiated protocol or
capability fingerprint.

The helper refuses changed inputs before parsing or opening the pinned ZIPs.
It checks the outer TreeDar bundle role, exact compressed bytes/hash, canonical
inner-manifest digest, input identity/hash references, twelve required native
paths, native role/format mapping, listed ZIP members and their sizes/hashes.
The test checks both synthetic fixtures, byte tampering rejection, and that the
existing v1 result validator accepts its v1 positive example but rejects the
v2 result record. The pinned synthetic files contain 22 native entries plus the
bundle manifest. Their bodies do not establish LAS acquisition, COG validity,
CRS, tree detection, authentication, actual NAS custody or publication.

This is **not a general v2 decoder or validator**. In particular the digest
gate rejects any different input without independently evaluating its v2
syntax or semantics; negative byte-tamper checks are not the candidate package's
full invalid-vector conformance. The ZIP inspection relies on the exact pinned
fixture gate; it must never be used for untrusted ZIPs. No accepted-copy or
outbox state is produced, and fixture-supplied receipt IDs are not authority.

Before a real adapter: agree an immutable schema/capability fingerprint and
version negotiation, strict lexical handling including integer tokens and
escaped duplicate keys, closed fieldsets and cross-record semantics, complete
positive/negative vector conformance, safe bounded archive validation,
authenticated producer and accepted-copy custody, original-source retention,
physical fencing and budgets, replay-safe acceptance and outbox, and current
publication authority. Keep existing v1 ODM requests and receipts unchanged.
