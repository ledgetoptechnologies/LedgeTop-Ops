# Request and enrollment retry recovery

This isolated follow-up starts from request composition `f2f9ebf86ea6f0cbcdadc136d7007940e75660a3`. It changes recovery behavior, not client eligibility or permissions. Merger owns qualification and release; the source changes alone do not make production requests available.

## Confirmed failures

- A request could commit while its response was lost. A later retry could return 409 because authority changed before submission. The form treated every 409 as a content conflict and discarded the original key; another submission could create a second inquiry. Editing a field after an uncertain result also discarded the key.
- A recipient confirmation could commit while `fetch` rejected. The enrollment page treated that as unavailable and offered inspection again, even though the issued link had already advanced to pending. The server's existing exact-operation replay could therefore not be reached from the page.

## Recovery contract

Request retries retain the original serialized payload and key. Once an outcome is uncertain, subsequent errors must not release that command, including a later validation error, access denial or conflict. Editing, cancelling and starting another command within the form remain unavailable until a verified response resolves it. The synchronous in-flight guard prevents duplicate submit events. Parent navigation callbacks run outside transport error classification.

On an initial send, a definite validation or unsupported-route rejection may release the command. HTTP 409 alone is insufficient: the server distinguishes `authority_changed`, `idempotency_conflict` and the existing `catalog_changed`. These codes describe outcomes; they grant no authority and do not bypass current server checks.

The inquiry router emits `authority_changed` before calling either write helper.
Only an initial inquiry may treat that exact code as a definite rejection and
reload services. Service submissions have no assumed equivalent guarantee;
after any uncertain attempt, the same code still retains the frozen command.

Enrollment treats transport failures and malformed successful receipts as uncertain. Its existing retry refreshes only the normal session token and resends the frozen confirmation body, including the original operation ID. Once uncertain, a failed retry retains that path. It does not re-inspect the consumed link, renew an expired invitation or activate access without owner review.

After a redemption binding is invoked, the HTTP wrapper cannot prove that an
expired proof, malformed receipt or exception means nothing committed. Those
outcomes return unavailable (503), exposing no receipt and retaining the exact
confirmation retry. Pre-dispatch authentication and input checks remain in
place, as do inspection's read-only expiry checks.

## Validation and limits

The source includes dependency-free request-attempt checks and browser regressions for the ambiguous outcomes. Actual executed checks and logs belong in the accompanying handoff; authored browser cases are not proof they ran. Full TypeScript, build, Worker and browser qualification must be performed against the final exact candidate.

Pending commands stay in component memory. A full page reload or external navigation can lose them; no private request payload is persisted in browser storage. There is no new outcome-lookup API for requests whose original authority was revoked or replaced. Such a retry can remain unresolved and requires staff investigation. These changes therefore improve same-form recovery, not durable cross-session reconciliation or complete live request readiness.

No migration, flag, service binding, Access policy, identity, email, production grant or deployment is changed here. Existing release requirements, including actual 48-hour frontend asset bytes and paths, remain mandatory.
