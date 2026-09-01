# Secondary-source client portal

Status: **bounded increment locally verified, not released**, August 26, 2026. This extends the
[source-bound connector registry](project-alpha-connector-registry.md), not the
set of trusted staff authorities. The full [remaining acceptance
inventory](goal-remaining-acceptance.md) still applies.

## Intended operator workflow

1. Keep each Alpha instance as its own registered connection. Only the existing
   primary controls staff access. Business customer grouping does not combine
   accounts, identities, memberships or grants.
2. Use the Client portal controls on that same connection. Configuration reuses
   its current credential reference, producer Access issuer/audience/subject and
   immutable producer identity; there is no second browser credential form.
3. Configuration stages a pending purpose. Explicit activation requires the
   primary and selected connection to be active and the configured portal
   revision to match the current connector revision. This enables authenticated
   projection, not access for every contact from that source.
4. In a delivery folder's existing sharing panel, use Connected workspace and
   explicitly choose the source, workspace, project and person. Review the
   server-resolved target before confirming. A folder name or business-party
   match is never evidence of ownership or permission.
5. The client signs in with the existing verified global identity and selects
   an independently authorized workspace. Native hierarchy and delivery views
   must not create synthetic legacy accounts or call legacy finance/request APIs.

The secondary folder-binding/grant producer and its UI have passed the local
database and browser gates recorded below. The workflow above still requires
real producer compatibility and authorized live acceptance. Secondary finance,
invitations, and Viewer operations remain unavailable. Native service requests
and feedback now have a separately implemented, default-off exact-source path;
they remain unavailable until the migration-first and per-source activation
gates in [native portal requests and feedback](native-portal-requests-feedback.md)
are satisfied.
Native files currently use file-type icons, explicit previews and downloads;
this slice does not yet expose existing thumbnail or photo-map endpoints to a
secondary workspace. It does not change thumbnail generation. Do not describe
this bounded directory/delivery increment as full primary-portal feature parity.

## Projection authority

Client migration `0162_portal_source_authorities.sql` adds explicit secondary
authority, append-only credential revisions, permanent signing-key ownership,
audit and transaction guards. It enrolls no sources. The existing primary wire
protocol remains unchanged and primary signing keys cannot acquire a secondary
key's permanent ownership.

The existing deployment-managed `PROJECT_ALPHA_CONNECTOR_CREDENTIALS` envelope
may contain `portalCurrent` and optional `portalPrevious` within a credential
set, each with `keyId` and `value`. Values are secrets: never enter them in an
administration request, commit them, include them in response JSON or log them.
The referenced set must be provisioned to Operations and Client before use.
Keep the existing snapshot/event fields and per-source keys intact.

Secondary ingress is POST
`/api/internal/project-alpha/sources/:encodedSourceId/portal-v2`.
The source in the URL is only a candidate: exact registered Access verification
and the source-owned HMAC over the canonical path and original request bytes
must both pass. Application key, delivery ID, digest and timestamp are checked;
the body cannot choose another source. Signed snapshots/events retain the
existing bounded parsing and source-qualified receipt/ownership contracts.
Every projection write batch carries a current Delivery-local authority guard.

Native client access uses immutable source/workspace mapping and current signed
principal, membership, entitlement, generation and deny checks. Reusing an email
address as a business contact does not grant portal access. Automatic eligibility
continues only through the existing explicitly enabled identity policy, with a
verified login and an unambiguous signed principal. File handles bind the exact
identity, source, workspace and current resource proof; they are not public URLs.

## Interrupted administration and paired upgrades

Operations migration `0039_portal_connector_coordination.sql` adds a durable
administration barrier and permanent enrollment markers. An enrolled source's
state or credential revision cannot be changed by an older uncoordinated writer.
Pausing/retiring a source first pauses its Delivery authority; changing a primary
connection pauses affected secondary purposes. Resuming business synchronization
does not automatically reactivate portal access.

The two databases are not one transaction. A crash leaves an unfinished update
visible in connection status. Recovery takes a new token, pauses all registered
secondary purposes and cancels the uncertain action; it never replays an old
activation. Operators then review and explicitly reactivate each needed purpose.
No elapsed-time lease automatically restores access. Label/business-visibility
changes remain separate from client grants.

Missing or partial paired database support must reject changes after enrollment,
not silently fall back to the pre-portal administration path. An unconfigured,
business-only installation retains its prior interface. Do not delete enrollment,
authority, audit or key-ownership rows to regain legacy behavior.

## Explicit staff folder grants

Operations migration `0040_native_delivery_authorizations.sql` and Client
migration `0163_native_staff_delivery_bindings.sql` support the existing folder
sharing panel's Connected workspace mode. This uses the existing authenticated
delivery-grants feature gate, not a new broad-access capability.

Operations now explicitly mirrors `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED`,
defaulting to `false`, as it already mirrors the identity-denylist flag. Keep
these rollout values aligned with Client. They select the existing hierarchy
authorization rules; adding the variable does not enable relation-based access.
The producer and reader share the same bounded scope query, including legacy
parent ambiguity, relation mode, schema support and existing lifecycle checks.
Do not switch modes to work around a rejected grant.

The server resolves the opaque folder reference and its actual division, checks
current staff permissions including explicit denies, and maps the selected
source-qualified project through an unambiguous exported public ID. The person
must already be an exact verified principal in that workspace. The preview
echoes this selection and returns a proof that must still match on confirmation.

The OPS authorization receipt is immutable and is the delegation decision point.
Its insert repeats the staff, folder and project checks within that database's
transaction. Delivery then stages an unreadable grant and publishes it only
under a fresh local authority, generation, recipient and binding guard, within
the receipt's two-minute publication window. Uncertain/changed publication
closes the grant gate; a success response is not inferred from an OPS receipt
alone. The databases do not share an atomic transaction.

The browser keeps the same idempotency key and exact request for an uncertain
retry. A terminal reconciliation error requires review, not blind retries with
new keys. Revocation retains the immutable grant version and records a separate
audited state change. Losing the original issuing staff member's role later
does not revoke a successfully completed delegation. Historical inspection and
explicit revoke must remain possible after the recipient loses eligibility.

A staged grant is labeled **Not published**, not active access. An authorized
operator can refresh the folder's grant history and **Cancel unpublished
access**, including when a different operator's interrupted request left it
behind. Cancellation uses the same guarded revoke path and leaves an audit
record; it does not publish access or delete files. Refresh is read-only and
must not manufacture a successful create result. After an uncertain save the
browser retains the exact original operation for a safe retry, or explicitly
switches to cancellation. An uncertain cancellation retains its own key and
body and must never resurrect the previous create request. Create and cancel
requests are mutually exclusive in the panel.

Native delivery enumeration seeks through bounded binding pages before applying
authorization, preserving continuation through empty intermediate pages. Scope
checks are batched; file reads use exact current grants and context-bound opaque
handles. No raw storage prefixes, legacy account IDs or public links are exposed.
The initial staff history surface is bounded to 100 records; overflow is an
explicit error, not a silently complete list. Staff history pagination remains
a follow-up before claiming unrestricted large-history support.

## Joined acceptance and rollout checks

Before release, exercise the same registered secondary source through signed
projection, verified client login, staff folder review, explicit grant, client
folder/file navigation and revocation. Use two sources with colliding upstream
IDs and prove that switching sources never retains the other source's records,
selection, pending request or file preview. Repeat the ordinary primary account
workflow; secondary support must not change its staff authority or credentials.

Check browser refresh and Back/Forward from a project, folder and exact-file
link; close a directly linked preview and confirm it returns to the folder list.
Check an interrupted create from both the original panel and a newly opened
panel, cancel unpublished access, and verify the client cannot read it. Revoke a
published grant during metadata and media requests and confirm that further
requests are denied rather than served from stale authorization state.

Rehearse populated upgrades and partial-schema failures with local databases.
Confirm paired rollout flags, secret references and exact producer public IDs
before any separately authorized production activation. Record the deployed
revisions and a real client smoke result separately from fixture test totals.

## Validation checkpoint

| Local gate | Result |
| --- | --- |
| Operations coordination and administration | 29 passed, including missing/partial paired schema, ACL, stale revisions and recovery |
| Operations connection UI | 48 passed; 375px/1280px screenshots inspected |
| Operations staff-sharing UI | 50 passed, including existing primary mode and interrupted-create cancellation; 375px/1280px screenshots inspected |
| Joined staff producer and native Client resources | 55 passed on frozen code: 29 producer + 26 resource cases, 498.90 seconds |
| Client compatibility, 11 files | 192 distinct cases passed across initial run and focused rerun; no skips (details below) |
| Generated Worker configuration | Both apps passed `cf-typegen:check` with Wrangler 4.118.0; no rollout values enabled |
| Type checks and builds | Both apps passed on final code; existing large-chunk build warnings remain |
| Native/primary Client browser | Final rebuilt run: 208 passed, four pre-existing visual-duplicate skips, zero failures; all 64 native cases and four mocked Viewer compatibility cases included |
| Public download compatibility | Four passed in a separate output directory, preserving native screenshot artifacts |
| Final Client UI unit rerun | 35 passed after the visual corrections; these are already included in the 192 distinct cases above |

The joined 55-case gate uses real signed projection, explicit staff publication,
exact client reads and revocation. Its initial 53/55 run exposed correlated
identity alias shadowing and missing no-store coverage on nested staff routes;
both were corrected before the clean rerun. The tests live under Operations so
the Ops Worker is not compiled against Client's generated binding types. No
production environment types were broadened.

The Client gate initially passed 188/192. Four failures came from outdated
fixtures: the concurrency injector watched `statement.run()` rather than the
guarded batch, and a thin grant table omitted the `grant_version` column already
present in migration 0147. A fresh run of those two corrected files passed all
19 cases; the other nine suites stayed green. This is not a claimed single
clean 11-file rerun. The authority suite's final 19/19 also supersedes an earlier
copied-credential fixture failure. Integration suites use bounded timeouts;
increasing the timeout was not treated as proof until a complete run passed.

The initial Client browser run passed 208 with four existing visual skips, but
screenshot review found visible screen-reader context inside action buttons and
missing base styling on Download links. After correcting those styles, adding
clipping/accessibility/button-style assertions and rebuilding, the full browser
gate passed again. Final native 375px/1280px directory/delivery/file screenshots
and primary preview screenshots were inspected; 640px/3440px layouts were also
checked. Browser totals are 212 passed and four skipped across 216 registered
cases, including the separate public-download subset. No tests were disabled to
make this change pass. The final Operations build, both type checks and both
generated-type checks passed. Local sandbox startup restrictions required approved
build/test reruns; no application permissions or production resources changed.

Joined full-business onboarding acceptance remains open. These local fixtures
do not prove actual producer/export compatibility, deployed configuration or
live client access.

## Release restrictions

### Reproducible local gate

Run these from the indicated app directory, sequentially on a development
machine. The database suites use disposable local Miniflare databases; browser
suites use test fixtures. Neither is a production smoke test.

Operations:

```sh
npx vitest run test/native-delivery-bindings.test.ts test/native-portal-resources.test.ts --maxWorkers=1 --reporter=verbose
npx vitest run test/project-alpha-portal-coordination.test.ts test/project-alpha-connector-admin.test.ts --maxWorkers=1 --testTimeout=60000 --hookTimeout=90000
npm run check
npm run build
npx playwright test --config playwright.config.ts test/browser/project-alpha-connections.spec.ts test/browser/native-delivery-grants.spec.ts test/browser/portal-grant-admin.spec.ts --workers=1
```

Client:

```sh
npx vitest run test/portal-source-authority.test.ts test/client-portal-ui.test.ts test/workspace-v2.test.ts test/authenticated-delivery-grants.test.ts test/portal-identity-eligibility.test.ts test/client-portal-routes.test.ts test/project-alpha-portal-projection.test.ts test/project-alpha-portal-relations-projection.test.ts test/portal-hierarchy-relations.test.ts test/bulk-download-client.test.ts test/service-request-client-api.test.ts --maxWorkers=1 --testTimeout=60000 --hookTimeout=120000 --reporter=verbose
npm run check
npm run build
npx playwright test --config playwright.config.ts test/browser/native-portal.spec.ts test/browser/client-portal.spec.ts test/browser/client-feedback.spec.ts test/browser/service-library.spec.ts --workers=1
npx playwright test --config playwright.config.ts test/browser/public-delivery.spec.ts --grep "Download all follows|single-file Download" --workers=1
```

Run `npm run cf-typegen:check` in both apps as well. Preserve the existing mocked
Viewer compatibility assertions: testing those routes does not authorize changes
to the separate Viewer runtime. Record skipped cases independently of passes.
An edit after a test module has loaded requires a fresh affected-suite run.

### Coordinated production handoff, not executed

1. Confirm approved producer/export revisions and the exact exported project
   public IDs. Resolve publication approvals separately; do not invent mappings.
2. Record deployed app revisions, database recovery points, current rollout flags
   and secret-reference names without recording secret values. Rehearse the
   populated upgrade locally before applying either production migration set.
3. Apply the paired Client and Operations migrations and deploy compatible
   consumer/administration code before enrolling a secondary purpose. Keep all
   new sources unconfigured until both sides report schema readiness. A partial
   upgrade must remain unavailable rather than use legacy authorization.
4. Confirm the same intended hierarchy/denylist settings on both apps and the
   source-specific credentials already provisioned through the supported secret
   mechanism. Do not change flags merely to make a denied test pass.
5. Only after separate activation approval, stage and explicitly activate one
   source, project signed data, and exercise a reviewed exact-client share,
   preview/download and revocation with a real test identity. Recheck the
   primary portal. Record actual deployed evidence separately from local totals.
6. If a coordinated operation is interrupted, use the documented recovery action
   and verify suspended access. Do not delete authority records, restore only
   one database, or roll back to a writer that bypasses enrollment guards.

- No production migration, configuration, activation, access change, mail or
  deployment has been performed for this increment.
- Alpha's public-ID export `38dc6c81` remains unpublished after a permission-review
  rejection; publication requires renewed explicit approval. Do not compensate
  with numeric-ID guesses, fabricated accounts or cross-source matches.
- Coordinate all producer/consumer migrations and code, confirm exact existing
  public IDs and rehearse rollback/recovery before enrolling a live purpose.
  After enrollment, prefer a forward fix; rolling back only application code
  must not bypass suspension or ownership checks.
- Viewer and thumbnail runtimes remain frozen and are not modified here.
