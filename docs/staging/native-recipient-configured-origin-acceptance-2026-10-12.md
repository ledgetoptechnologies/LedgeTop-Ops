# Native recipient configured-origin acceptance

This is the acceptance contract for the isolated recipient-enrollment rollout slice. It is not production activation approval. The implementation branch starts at `6c1b93e18eb33b84e70fe50309cf9fccc253eccc`; it must not be confused with the candidate currently under CI or the deployed staging pair.

## Intended change

- Replace staging hostname literals only in normal recipient owner/enrollment admission with exact server-configured HTTPS origin and an explicit environment allowlist.
- Preserve normal authenticated staff authority, verified recipient Access issuer/subject, exact target consent, CSRF, idempotency, current revision checks, immutable commands and audited revocation.
- Leave every production activation flag off. Do not deploy or provision production bindings in this slice.
- Keep the staging wrapper, synthetic fixtures, directory-maintenance authority and other acceptance transports staging-only. Do not expose them to make normal workflows reachable.
- Delivery, workspace publication and billing owner exposure are separate remaining slices, not implicitly solved by recipient enrollment.

## Required runtime tests

- Explicitly supported staging and production configuration pass the same admission logic; unknown/missing environments fail closed. No hostname substring, header, query, body field or forwarded-origin value selects the environment.
- Origin must exactly match configured HTTPS origin/expected host. Reject userinfo, ports, non-root paths, query, fragment, non-HTTPS and host disagreements. Request URL origin cannot be overridden by a matching `Host` or forwarded header.
- Owner and recipient origins remain distinct. Configured application origin never substitutes for the Access identity issuer or audience.
- Missing/false flags stop before authentication, database or RPC. Enabled but incomplete configuration fails closed without issuing an intent. Private enrollment RPC returns canonical unavailable when disabled.
- Existing same-origin request metadata, custom request headers, verified actor lifetime and CSRF checks remain enforced. Test cross-origin CSRF replay and subject/admission changes; any intentional CSRF format change needs explicit compatibility analysis rather than an unnoticed test update.
- Client consent derives issuer, subject and display label only from signed verified proof. Client-supplied identity, alternate target, expired proof or proof change during RPC cannot redeem an intent.
- Exact-key body validation, bounded reads/RPC, canonical wire validation, operation UUIDs, stale revision rejection, conflicting operation reuse and pending transport classification remain intact.
- Revoke/cancel/recovery still use the stored exact command and current authority. Recovery must not create a replacement grant, and a revoked intent cannot revive an old grant.
- Exercise the actual standard Ops fetch route, private enrollment ingress and registered Client consent route under enabled and disabled production-shaped configuration. Import/string assertions alone do not prove routing or authorization behavior.
- Standard production entrypoint must not dispatch synthetic fixture or directory-maintenance handlers. Existing staging tests must continue to pass unchanged where possible.

## Integration gates after local implementation

1. Independently review the immutable patch and run focused runtime tests plus both application type-checks.
2. Integrate only after preserving the current connection candidate's CI and private live-attempt evidence. A passing isolated test is not a passing paired staging release.
3. Add exact typed service bindings and explicit false configuration inventories in a separately reviewed integration patch; regenerate configuration types and update pins with substantive negative tests.
4. Test the complete enrolled-recipient workflow in staging against the selected synthetic customer, including consent, owner confirmation, replay, revocation and distinct-principal denial.
5. Complete separate selected-file and financial acceptance. Enrollment alone grants neither all files nor billing access.
6. Retain the production PA owner-update checkpoint and separate production client-access authorization boundary.

No production configuration, client grant, public link or PA instance was changed by writing this contract.
