# Automatic retained-asset release runtime

This adds a same-repository `workflow_run` entry point after successful main CI for the Operations and Client frontend Workers. It checks out the exact successful CI SHA, re-verifies the latest required main CI jobs before each stage, and uses the existing retained-asset coordinator and provider adapter. Operations additionally requires the current native-staff readiness packet. The workflow does not run for pull requests, forks, pushes directly, schedules, or manual dispatch.

The runtime carries the complete previous asset ledger and proves old and candidate bytes at zero percent and after activation. It does not prune assets. Its receipt records the observed cutover and earliest pruning time, at least 48 hours after cutover. An uncertain provider result is recorded once and held for read-only reconciliation; the runtime never retries or rolls back a mutation.

Before the first temporary verifier Worker write, the runtime creates a fast-forward-only journal claim on a dedicated per-Worker Git ref. Every provider mutation requires a persisted intent; a response must be acknowledged and privately sealed before another mutation can proceed. The journal contains hashes, bounded status metadata, and ciphertext digests only. The encrypted response bundle is uploaded as a GitHub Actions artifact and its exact artifact ID and digest are attached in a separate journal-only completion step. The separate response recipient is pinned in source and uses RSA-OAEP-256 to wrap an AES-256-GCM key with request identity in authenticated data.

The recipient in `scripts/production-auto-private-recipient.mjs` is an all-zero fail-closed sentinel. The workflow variable and provider credentials are not provisioned by this change. Until a separately reviewed recipient is installed and an owner provisions the explicit enablement and required credentials, both runtime entry points refuse before network access. This source change does not authorize or perform a production release.

Run the offline checks with:

```powershell
node --test scripts/production-auto-*.test.mjs scripts/workflow-trigger-policy.test.mjs
```

The tests cover journal compare-and-swap, intent-before-write ordering, one-time ledger binding after the old-byte verifier claim, encrypted response custody, release/artifact completion gates, exact workflow event admission, and fail-closed unprovisioned behavior. They do not qualify live credentials, Cloudflare account permissions, current production readiness, or an enabled release.
