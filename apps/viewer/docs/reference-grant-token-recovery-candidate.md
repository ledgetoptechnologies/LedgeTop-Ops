# Reference grant token recovery candidate

This is an inactive building block for replaying a source transfer grant after
the broker commits it but the Processing acknowledgement is lost. The Viewer
reference dispatcher remains hard-off; this does not issue a NAS custody
receipt, provide a durable dispatch loop, or change the live processing route.

When the broker is constructed with an explicitly injected 32-byte
`grantRecoveryKey`, it derives a grant's opaque bearer with HMAC-SHA-256 over a
domain-separated value containing the persisted grant ID and exact stored
identity. The database still stores only the token hash. An exact replay after
restart derives the same token and confirms its hash with a constant-time
comparison before returning it. No recovery key is persisted by this module.

If the key is missing, wrong, or differs from the key used for an older random
token, the broker returns no token and does not mint a replacement for the same
grant. That outcome must remain held for operator review; it must not be treated
as permission to rotate the reservation or issue a second grant. Key storage,
startup validation, rotation, backup and deployment wiring are not implemented
here. The caller must provide the same key after restart through an approved
secret channel, and must keep request bodies and returned bearers out of logs.

The synthetic tests cover process restart and exact replay with a stable key,
no plaintext token in the persisted row, wrong-key refusal, and invalid key
length. They do not verify host secret provisioning, worker authentication,
NAS immutability, the durable Viewer dispatch outbox, or cross-host recovery.
