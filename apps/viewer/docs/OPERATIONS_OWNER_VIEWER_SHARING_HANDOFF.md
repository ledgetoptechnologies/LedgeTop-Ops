# Operations handoff: protected owner cannot create Viewer public links

## Requested outcome

The user is the protected Operations owner and expects owner access to all authorized management functions without individual permission assignments. Preserve that existing owner policy when Operations issues and renews Viewer workspace sessions. Do not modify Viewer to treat a missing permission as authorization.

## Verified evidence

- Viewer release `0027ed8f21fd6623fedb843fd6488dccdfe9a80d` is deployed (health revision header).
- A freshly opened signed-in workspace shows project/task Share buttons. Hickory Grove's task Share dialog opens, but shows: "Creating a link requires share permission and, for private ready models, activation permission." No creation form appears.
- The private ready task's View button uses `data-action="open-review"`. Viewer only renders this path with `viewer.processing.publish`; therefore activation permission is present. The remaining form gate is `viewer.shares.create`.
- This is a UI/code-trace diagnosis, not a capture of credentials or the raw session payload. Confirm the actual granted permission names in trusted server-side tests/logs, without logging tokens.
- The independent optional Operations client-access lookup bug was fixed in `0027ed8`. That is not the remaining permission problem.
- No public links, role assignments, publication state, or Operations code were changed during this investigation.

## Viewer contract to inspect

In the Viewer repository:

- `workspace-projects.js`: `canShareOutput`, `taskQuickActions`, `shareModal`, `createOutputShare`. `shareModal` requires `viewer.shares.create` and, for private ready outputs, `viewer.processing.publish`.
- `server/processingApi.js`: permission allowlist includes `viewer.shares.read`, `viewer.shares.create`, `viewer.shares.revoke`, and `viewer.processing.publish`.
- `POST /api/v1/admin-grants` accepts the explicit permission list from the authenticated HMAC issuer. `POST /api/v1/admin-sessions/redeem` copies that grant's permissions into both newly created and renewed workspace sessions. Viewer does not receive or infer an Operations protected-owner bypass through this contract.
- `POST /api/v1/processing/outputs/:id/shares` independently requires `viewer.shares.create`; activating a private ready version also requires `viewer.processing.publish`.
- `POST /api/v1/projects/:id/public-shares` requires `viewer.shares.create` and a published eligible task. Project sharing does not implicitly publish every private task.

## Operations-side investigation and fix

1. Find the workspace-session permission builder and renewal/reauthorization equivalent. Check whether they enumerate only explicit role grants and omit the protected-owner bypass used elsewhere in Operations.
2. Resolve protected-owner authority exclusively from trusted authenticated server-side identity and the existing protected-owner policy. Do not trust a client-supplied owner flag, email label, local storage, URL parameter, or arbitrary role name.
3. Translate effective owner authority into the explicit supported Viewer permissions. For the public-link management workflow, verify create/read/revoke and activation/publication permissions. Use the canonical supported permission mapping; do not introduce an unchecked wildcard or grant these scopes to every staff/client account.
4. Apply the same effective-permission resolution on initial session issuance and renewal. A fresh session should preserve intended owner authority; revoked or non-owner identities must remain restricted.
5. If create is already emitted, trace any filtering/allowlist/session serialization between issuance and Viewer. Diagnose before changing Viewer guards.

## Acceptance tests

- Protected owner with no individual grants receives the intended Viewer management scopes, including `viewer.shares.create`.
- Initial session and renewed session agree on effective permissions.
- Ordinary read-only staff and client sessions do not gain share creation or publication authority.
- Forged owner attributes cannot broaden scopes; authorization remains enforced server-side.
- After deployment, reopen Viewer from Operations with a fresh session. Hickory Grove → task Share should display label, optional password/expiry, allowed-feature choices, and Create public link.
- Test actual link creation/revocation only with explicit approval for the chosen model and public exposure. Opening the dialog is read-only. Keep private personal measurements private by default.

## Coordination boundary

This handoff authorizes no automatic cross-agent messages or production grants. The user will pass it to the Operations agent. Keep unrelated Operations work intact. Return the implemented permission-mapping change, test results, and whether a new workspace session is required. Do not return credentials or bearer URLs.
