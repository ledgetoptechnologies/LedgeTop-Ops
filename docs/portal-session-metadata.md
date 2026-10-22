# Portal account and session metadata

Backend contract for the unified portal UI:

- `GET /api/client/session` adds `account.email`, normalized from the cryptographically verified Cloudflare Access principal. This is the signed-in email, not a client/company contact email.
- `GET /api/client/session/status` returns exactly `{ "serverTime": "<ISO8601>", "expiresAt": "<ISO8601>" }` with `Cache-Control: no-store`. It needs no selected-workspace header and ignores such a header for timing. Expired, malformed, forged or mismatched assertions return the existing authentication 401 style.

Both routes retain existing portal feature, origin, authentication, local account and global admission gates. Hierarchy-enabled timing uses the same globally admitted identity/sentinel pattern as session bootstrap; it neither selects nor grants a workspace. Timing reuses the existing strict, cryptographically verified human-assertion deadline proof and matches its issuer, subject and email to the middleware principal. No decode-only token claims or CRM-derived expiry are used. The timing route verifies the signed deadline again after admission/session lookup, so it does not introduce a cache of token claims.

The focused test uses real locally signed RS256 assertions and signature verification with synthetic local JWKS. Only repository lookup and global admission are isolated test seams. It covers the actual mounted API path, cookie fallback, expiry/signature/issuer/audience rejection, forged email claims, stricter human/deadline rejection, admission/origin/default-off gates and the CRM-vs-sign-in-email distinction.

Validation from `apps/client`: 79 tests passed across `client-session-metadata`, `client-access-identity`, and `client-portal-routes`; `tsc --noEmit` passed. Source-only change; no deployment, UI edits, production sign-in or credential access.
