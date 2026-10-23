# Viewer UI binding preparation

The initial binding stage keeps existing HTML selected while adding a private
service binding and the `/_ui` asset namespace. The offline compiler in
`scripts/ui-additive-release-plan.mjs` has no provider client, native command,
upload, activation, grant or HTML-selection path. Existing production deployment
guards and profiles are unchanged. This is not permission to use backend-only
deployment for a UI release.

Production callers must supply a fresh complete snapshot recognized by the
default `portal-entry-canonical` profile and independently qualified primary
Worker artifact paths. `options.profile` is a trusted synthetic-test seam, not a
production JSON input. Recompile from the original baseline before checking a
planned provider poststate; a deserialized expected profile cannot authorize
itself.

The exact preparation delta for Operations and Client is:

- Add HTTP service binding `UI_RELEASE_ASSETS` targeting `ledgetop-ui-assets` in
  `production`, without a named entrypoint.
- Add `UI_ACTIVE_RELEASE` with the empty string; keep existing HTML selected.
- Append only `/_ui` and `/_ui/*` to the existing Worker-first routing list.
- Keep existing asset files through `keep_assets:true`, with no primary asset
  directory, upload or completion JWT.
- Keep every other scalar, secret, binding, export, runtime setting, origin,
  schedule and cron exactly as recognized by the baseline.

Operations already uses all 128 text/secret slots. Only its existing
`CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE="false"` scalar is omitted to
make room for the selector. The shared maintenance helper activates only for
`"true"`; absent and `"false"` remain disabled. The Client scalar stays present.
This omission is explicitly reported and forbidden from silently reappearing in
the expected prepared profile. No secret or other feature flag is omitted.

Wrangler's `keep_vars:true` would resurrect an omitted plaintext binding. The
generated native config instead uses `keep_vars:false`, explicit inheritance of
every retained binding by name, and final `unsafe.metadata.keep_bindings:[]`.
The test suite checks these interactions against pure fragments extracted from
the exact hash-pinned native Wrangler runtime. That establishes local metadata
generation behavior, not provider acceptance.

Modern version metadata exposes asset configuration, not a namespace or content
identity. Expected hashes recognize only the precise routing-config delta. They
do not prove preservation of live bytes. Actual upload/version receipts and live
old/new asset behavior remain separate acceptance requirements. The default HTTP
service binding's exact provider-returned shape also remains unqualified; no
empty/null/named entrypoint normalization is admitted by this plan.

Local checks passed: 38 compiler/metadata/regression tests and independent
review. The plan also compiled against a fresh recognized production snapshot,
and native Operations and Client `--dry-run` commands exited successfully. Those
commands did not upload or activate anything. Operations remains at 128
text/secret slots; Client becomes 92.

Later stages still require their own reviewed executable release path: private
resource creation and upload acceptance, inactive primary candidate validation,
separate activation with unchanged unrelated controls, staff-canonical host
acceptance, finite presentation routing and HTML selection, browser/CSP/deep-link
and rollback checks, and the exact LTDS authenticated sharing pilot. An HTML
rollback retains canonical-origin settings, the service binding and all
registered prefixes needed by already-open new tabs.
