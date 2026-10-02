# Native portal service-home acceptance profile

`native-recipient-service-home-acceptance` is a staging-only, ignored Wrangler
override for the bounded recipient → service home → native data-browser
acceptance. It changes exactly three unique gates:

- Client: `CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED=true`;
- Client and Operations: `CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED=true`;
- Operations: `CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED=true`.

The native selector is intentionally present on both Workers. A missing native
grant, missing native migration, or denied native metadata read must fail
closed; neither side may retry the historical PA-backed service-home path.
The generator also refuses a staging source that does not already have the
reviewed native recipient-enrollment and native delivery capabilities enabled.

## Generate and inspect

Start with current, preflight-valid `apps/client/wrangler.staging.json` and
`apps/operations/wrangler.staging.json`. Both base files, and both production
configs, must explicitly keep all three gates off.

```powershell
npm run staging:native-portal-acceptance:generate
npm run staging:native-portal-acceptance:check
```

This writes only these ignored files and performs no Cloudflare action:

```text
apps/client/wrangler.staging.native-portal-acceptance.json
apps/operations/wrangler.staging.native-portal-acceptance.json
```

The checker rejects any difference from the base configs outside the four
exact placements of the three gates. Inspect both configs and their resolved
bindings before an independently approved staging version upload. This profile
does not apply migrations, create authority, or authorize content.

## Bounded use and restore

Use only the repository's reviewed staging version-upload/deployment process.
Open the private RPC first by deploying the reviewed Operations candidate, then
deploy the reviewed Client candidate. Do not hand-copy one of these flags into
the base config and do not deploy a partial profile.

Immediately after acceptance, restore default-off in the opposite order:

1. deploy a reviewed Client version from `apps/client/wrangler.staging.json`;
2. deploy a reviewed Operations version from `apps/operations/wrangler.staging.json`;
3. run `npm run staging:check` and confirm all four gate placements are
   explicitly `false` before recording the window closed.

Closing Client first removes the reachable service-home route before the
Operations private RPC is disabled. The base and production configs are never
rewritten by this generator, so they remain the rollback inputs.
