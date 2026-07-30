# Isolated Cloudflare staging

Staging is separate infrastructure, not a branch version of a production Worker. A branch push must never receive a production custom domain or production traffic.

## Required resources

Provision through the approved Cloudflare account process and record non-secret identifiers outside Git:

- three staging Workers and staging-only custom hosts protected by distinct Cloudflare Access applications/audiences;
- staging delivery and operations D1 databases;
- staging delivery and incoming R2 buckets with retention/versioning safeguards suitable for test data;
- a staging file-event queue, staging-only consumer, and DLQ;
- distinct staging Workflow names for every Workflow binding;
- eight staging rate-limit namespace IDs;
- staging secrets entered interactively or through the approved secret store.

Never reuse a production worker name, host, Access audience, D1 ID, R2 bucket, queue, Workflow name, or rate-limit namespace. Never put secrets in a Wrangler config or shell command.

## Prepare local configuration

Copy each example to the corresponding ignored path and replace every placeholder:

```text
docs/staging/delivery.wrangler.json.example    -> apps/delivery/wrangler.staging.json
docs/staging/operations.wrangler.json.example  -> apps/operations/wrangler.staging.json
docs/staging/ops-sync.wrangler.json.example    -> apps/ops-sync/wrangler.staging.json
```

Preserve all fail-closed feature variables, then run:

```text
npm run staging:check
npm run staging:check:test
npm run staging:release:prepare
```

The preparation command validates all configs and runs checks, tests, and builds. It intentionally performs no Cloudflare operation.

## Separately authorized release sequence

Only after the unexpected production branch deployment has been resolved and a staging release is explicitly approved:

1. Restrict Cloudflare Builds so only the deliberate production branch can deploy production. Branch builds must target staging-only Worker names and have no production route.
2. Re-run `npm run staging:release:prepare` from the exact clean, pushed commit.
3. Back up both staging D1 databases.
4. List pending migrations with the explicit `--config apps/<app>/wrangler.staging.json` path and confirm the resolved IDs are staging IDs.
5. Apply staging migrations one database at a time with that explicit config.
6. Deploy with `wrangler deploy --config apps/<app>/wrangler.staging.json`. Never use an unqualified package `deploy` script for staging.
7. Verify Access rejection, host rejection, `/health`, object authorization, upload/download, recycle/restore, and audit/log behavior. Provider integrations and permanent purge stay disabled.

These are operator instructions, not commands run by repository automation. Record version IDs, migration output, health evidence, and rollback targets in the release ticket.

## Release gates

- The working tree is clean and the reviewed commit is pushed.
- `npm run staging:release:prepare` passes and reports no production resource reuse.
- Cloudflare Access authenticates users; Workers separately enforce role, division, client, job, and object ownership.
- Reconciliation repairs known manifest state and never purges ambiguous objects.
- Preview tests apply only to explicitly previewable delivery media.
- Direct-to-R2 uploads remain outside automated preview guarantees until the documented object-event fallback exists.
- Production routes, secrets, migrations, provider flags, and purge flags are unchanged.
