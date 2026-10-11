# Organization project preparation: live staging failure

## Verified environment

- Operations staging runtime: `f49597483b6414eb1e540136dc650b674ff1fa62`.
- Worker version: `c8ece7b8-b340-42ad-85ba-4cc618153745`, 100% staging deployment.
- Staging schema: 190 migrations, final `0190_client_hub_native_project_preparation_authority.sql`.
- Authority helper successor: `ef0e4c8f65b34fd8be8a0cb98f3c02716081e98c`.
- No production changes or existing public-link changes.

## Reproduction performed once

- Opened the exact synthetic organization in the normal signed-in Client Hub.
- Used the audited helper to provision only `project.shared.sync` in the existing synthetic business area. Initial Project generation was 28; Directory generation was 154.
- Reloaded the page. The project-create form became available, proving the scoped native authority was recognized by the normal launch/read path.
- Entered a synthetic name and description, without dates, then clicked **Prepare project** and accepted its ordinary preparation confirmation.
- UI returned **“The native project reference is already prepared.”**
- Read-only D1 query found **zero** rows in `client_hub_native_project_preparations`. No create submission or retry followed.

## Cleanup and independent readback

- Executed the helper's exact paired revoke using the original private provision artifact and a freshly sealed Directory snapshot.
- Helper reported committed cleanup. Provision and revoke receipts remain in the private evidence directory; they are not included in this document.
- Independent D1 query confirmed:
  - active Project grants for the test operator: 0;
  - project preparations: 0;
  - foreign-key violations: 0.

## Diagnosis boundary

- `prepareClientHubNativeProject` catches every preparation INSERT error and reports the same duplicate-reference message. It does not distinguish a uniqueness violation from a CHECK failure, a trigger rejection, or a platform SQL error.
- An empty preparation table contradicts the literal duplicate explanation. It does **not** establish which underlying constraint failed.
- The prepared request was not captured. Do not infer its random IDs or inspect private browser/session state to recover them.
- Next: evaluate the exact synthetic owner/mapping/observation and actor predicates read-only, and add a full-schema regression or narrowly sanitized error classification once the cause is established.
- Do not remove a trigger, add a legacy connector/global grant, or retry a fresh project to conceal the failure.

## Release implication

Ordinary organization project creation remains unproven. Passing helper tests and inventory reads do not satisfy the PA–Ops write/sync acceptance gate.
