# Actual selected staging definition attribution

The guarded staging read captured 40 Operations and 9 Client selected definitions.
All 49 observed hashes match the earlier drift report. Raw DDL remains in two
newly owned local temporary review files; the public JSON contains only approved
metadata, identities, hashes and lexical categories. No application rows were
read, and no staging SQL was executed from those definitions.

One completed **baseline-only** local replay on loaded source `4142b7c6` produced:

| App | Baseline | Objects | Schema SHA-256 | FK violations |
| --- | --- | ---: | --- | ---: |
| Operations | 0221 | 2402 | `8da53584a8a7bf06affec4994ec34cda3bfac9060a360c1566aad873e171a325` | 0 |
| Client | 0234 | 1158 | `e25d98637026da4137f5cf72bba3e5a385cac41ef05be24b1ae81596d659cab8` | 0 |

Both hashes match the pinned local baseline references. The replay's observer
retained copied, frozen selected definitions after calculating checkpoint hashes.
This does not prove historical execution or data effects in staging.

Of the 46 differing application definitions, the conservative lexer attributes
40 to whitespace outside quoted tokens (33 Operations, 7 Client). Six application
definitions remain unresolved:

- Operations: `client_onboarding_portal_activation_proofs`,
  `native_directory_profile_binding_continuation_ack`,
  `native_staff_onboarding_approve_finish`,
  `operations_directory_audit_original_subject_required`, and
  `native_directory_existing_import_live_reviews`.
- Client: `client_folder_notification_batch_control_result`.

The later bounded residual comparison attributes three of these six to comment
tokens only (`client_onboarding_portal_activation_proofs`,
`native_directory_profile_binding_continuation_ack`, and
`native_directory_existing_import_live_reviews`). The other three differ in
non-comment tokens; the Client trigger also has a changed literal-token sequence.
The safe residual JSON reports token kinds/counts, never token contents. All six
remain in the original unresolved category: this further attribution does not
approve a schema, infer semantic equivalence or change the release gates.

The two `_cf_METADATA` absences, two `_cf_KV` additions, and Operations
`staging_native_authority_migrations` addition are also unresolved. No object is
ignored, rewritten or approved by the lexical comparison. Semantic equivalence,
canonical history and rollout readiness remain unverified.

## Replay invocation correction

The first invocation used `node --input-type=module -e`. Its inherited flag breaks
the locked Miniflare synchronous helper's CommonJS eval worker: a small separate
worker reproduced `ReferenceError: require is not defined`. The owned Node
loopback was unresponsive, and the locked proxy contains an unbounded
`Atomics.wait`. The exact blocked RPC was not instrumented. That invocation
produced **no qualified replay result** and was explicitly stopped after this
diagnosis. Its worker exited with its parent; no other process was stopped.

The successful replay used an ordinary owned `.mjs` file without that flag. The
generator now rejects inherited `--input-type` arguments before loading either
engine. Bounded subprocess tests verify that rejection and normal file entry.
No runtime flags or dependency implementations were patched.

The JSON companion records the completed replay, retained-file hashes, original
non-qualifying invocation and full selected-object categories. It is diagnostic
evidence, with `canonicalBaselineVerified` and
`semanticEquivalenceEstablished` both false. Live staging migration, identity,
gateway/TLS, grant, client session and EH execution gates remain open.
