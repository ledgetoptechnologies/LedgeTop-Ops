# Signed-in Project replay acceptance

This is staging acceptance tooling, not a production project editor or a client-access grant.

## Entry and prerequisites

- Open `https://ops-staging.ledgetopdroneservices.com/administration/staging/project-v2-replay-acceptance` in the supported signed-in browser.
- The preparation endpoint requires the exact staging HTTPS origin and configured host, the existing default-off Project activation gate, an administrator with deny-aware global `integrations.manage`, and a current matching native human identity.
- Use one explicitly reviewed synthetic project ID beginning `ops/project-acceptance-`, a synthetic name, the configured staging application UUID, an already active mapped organization, and an optional client whose current organization relationship matches.
- Select an exact business area or division. This form offers no implicit global scope, automatic matching, credential export, service-token substitution, or automatic command submission.
- Confirm the effective PA Project capabilities and feature gates, current mappings, and an independent public-link baseline before live writes. Local fixture results do not prove those prerequisites.

## Normal test sequence

1. Freeze the reviewed selection. This makes no network request or mutation.
2. Load create preparation. The page obtains the current session and CSRF token, then requests server-derived local and PA fences through the normal same-origin API transport.
3. Confirm the exact project ID and displayed name. Start the create step.
4. Advance the same frozen attempt through exact replay, changed-body conflict, and current server readback. A lost response must retain the same command ID and request bytes; do not create a replacement command.
5. Review the returned current profile/version and confirm the update step. Repeat replay, conflict and readback for that new command.
6. Record independent PA destination evidence and compare the public-link baseline. Do not treat UI completion, Ops-local state, or mocked browser tests as live destination/public-link proof.

## Identity and recovery boundaries

- Ops ownership uses canonical Directory `record_id`. PA relation proofs use the exact selected active mapping's PA binding `external_id`; acquired mappings may deliberately differ. Never infer either from a name or email.
- Preparation is advisory. Current authority and canonical command guards remain enforced again by the writer and its atomic database transaction.
- Create reserves its native proof only if the exact mapping identities/cardinality and client/organization endpoints still match inside that transaction. This is not a local observation revision/hash/status check or a relationship-version continuity guarantee between preparation and submission; PA independently validates the submitted relation proofs. A stale proof may queue and then produce a normal PA conflict rather than a local preparation pass guaranteeing success.
- Preserve a pending or uncertain attempt and diagnose through its original ledger. Do not reset a fixture, delete an outbox row, relax a trigger, or allocate a new command merely to obtain a green result.
- Project creation does not activate a client recipient, share a folder, publish a public link, or satisfy the portal sign-in/data-access acceptance gate.
- Keep the production update checkpoint closed until the complete live Directory, Project, recipient, selected-file and revocation acceptance sequence succeeds and the temporary authority is cleaned up through its paired recovery procedure.
