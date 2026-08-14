# Isolated Cloudflare staging

Staging is separate infrastructure, not a branch version of a production Worker. A branch push must never receive a production custom domain or production traffic.

## Required resources

Provision through the approved Cloudflare account process and record non-secret identifiers outside Git:

- three staging Workers and five staging-only custom hosts, including a distinct
  client portal host with a dedicated path-scoped Access app/audience/group and
  a reviewed public-share Bypass contract;
- staging delivery and operations D1 databases;
- staging delivery and incoming R2 buckets with retention/versioning safeguards suitable for test data;
- a staging file-event queue, staging-only consumer, and DLQ;
- distinct staging Workflow names for every Workflow binding;
- eight staging rate-limit namespace IDs;
- staging secrets entered interactively or through the approved secret store.

Never reuse a production worker name, host, Access audience, D1 ID, R2 bucket, queue, Workflow name, or rate-limit namespace. Never put secrets in a Wrangler config or shell command.

The client portal release program is specified in
[client-portal-rollout.md](client-portal-rollout.md). Its config is default-off;
the existing Delivery staging Access app is not the client identity app.

## Prepare local configuration

Copy each example to the corresponding ignored path and replace every placeholder:

```text
docs/staging/delivery.wrangler.json.example    -> apps/client/wrangler.staging.json
docs/staging/operations.wrangler.json.example  -> apps/operations/wrangler.staging.json
docs/staging/ops-sync.wrangler.json.example    -> apps/ops-sync/wrangler.staging.json
```

The Wrangler examples contain only fields accepted by Wrangler. Required secret
names live in the checked-in sidecar
`docs/staging/staging-secret-manifest.json`; never add the release-only manifest
as a `secrets` property in a Wrangler config. Secret values remain ignored and
operator-supplied.

Preserve all fail-closed feature variables, then run:

```text
npm run staging:check
npm run staging:check:test
npm run staging:release:prepare
```

The preparation command validates all configs and the sidecar secret-name
manifest, then runs checks, tests, builds, browser tests, and explicit-config
dry-runs. It intentionally performs no Cloudflare operation. Complete
post-deployment evidence and activation dependencies are checked later with
`npm run staging:release:verify`; this avoids requiring a deployed version ID
before that version exists.

## Separately authorized release sequence

Only after the unexpected production branch deployment has been resolved and a staging release is explicitly approved:

1. Restrict Cloudflare Builds so only the deliberate production branch can deploy production. Branch builds must target staging-only Worker names and have no production route.
2. Re-run `npm run staging:release:prepare` from the exact clean, pushed commit.
3. Back up both staging D1 databases.
4. List pending migrations with the explicit `--config apps/<app>/wrangler.staging.json` path and confirm the resolved IDs are staging IDs.
5. Apply staging migrations one database at a time with that explicit config.
6. Upload reviewable versions with `wrangler versions upload --strict --config apps/<app>/wrangler.staging.json`, inspect the returned version IDs and bindings, and deploy only those reviewed versions as described in `release-checklist.md`. Never use an unqualified package `deploy` script for staging. Keep Ops Sync undeployed until its service-auth, Access-group, and exact timestamp/body HMAC prerequisites are proven.
7. Verify Access rejection, host rejection, `/health`, object authorization, upload/download, recycle/restore, and audit/log behavior. Follow the separate client-portal activation/restore sequence; provider integrations and permanent purge stay disabled.
8. Restore every temporary feature flag to false, finish the evidence packet,
   and run `npm run staging:release:verify` from the same clean pushed commit.

These are operator instructions, not commands run by repository automation. Record version IDs, migration output, health evidence, and rollback targets in the release ticket.

## Release gates

- The working tree is clean and the reviewed commit is pushed.
- `npm run staging:release:prepare` passes before mutation and
  `npm run staging:release:verify` passes after deployment evidence is complete.
- Cloudflare Access authenticates users; Workers separately enforce role, division, client, job, and object ownership.
- Reconciliation repairs known manifest state and never purges ambiguous objects.
- Thumbnail tests apply only to supported still images at or below the
  implementation's 20 MiB input cap; all other kinds use local fallbacks.
- Every supported R2 create path must reach the staging file-event queue before
  thumbnail generation is considered verified. No original may be used as a
  list/grid fallback.
- Production routes, secrets, migrations, provider flags, and purge flags are unchanged.
