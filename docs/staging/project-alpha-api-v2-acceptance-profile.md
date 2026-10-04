# Project Alpha API-v2 staging acceptance profile

The Operations base staging configuration and every production configuration
keep these gates explicitly off. A bounded API-v2 staging run uses the
separately generated, ignored file
`apps/operations/wrangler.staging.project-alpha-api-v2-acceptance.json`.
Generation performs no Cloudflare operation and changes no base or production
configuration.

The profile enables exactly these five Operations vars:

- `PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED`
- `PROJECT_ALPHA_API_V2_SYNC_ENABLED`
- `PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED`
- `PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED`
- `PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED`

It does not create an API key, expand Project Alpha permissions, auto-match
records, activate client access, publish links, or change any Project Alpha
record. PA-side route permissions and the exact staging key remain independently
scoped and controlled in the PA staging instance. Every record reconciliation
must remain an explicitly selected pair with a reviewable conflict outcome.

After rendering and validating the ordinary staging configuration, confirm
that its five vars are `false`; production must also keep them `false`. Then
run:

```powershell
npm run staging:check
npm run staging:project-alpha-api-v2-acceptance:generate
npm run staging:project-alpha-api-v2-acceptance:check
```

Review the generated config diff against the base and verify it targets only
`ledgetop-ops-staging` and the staging D1/service resources. Upload and deploy
only this exact config through the reviewed staging version workflow. The
profile is temporary: after the bounded acceptance run, upload the ordinary
base staging config to restore all five gates to `false`, then verify the
staging Worker version and read-only denial behavior. Never use this profile
with a production config or a production PA origin.
