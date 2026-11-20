# Releasing the Viewer image

The Viewer API and worker share one image,
`ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer`. Releasing it is two separate
steps: every qualifying merge to `main` builds and verifies an immutable
candidate, and a person later promotes one verified candidate to `latest`.

## 1. Every merge to main: build an immutable candidate

`.github/workflows/publish-viewer.yml` runs on pushes to `main` that touch
`apps/viewer/**`, the workflow itself or the monorepo boundary test. It:

1. runs `npm run check` and the monorepo boundary test;
2. builds once (with the ImageSharp licence build secret, provenance and SBOM)
   and pushes only `candidate-<commit>-<run>-<attempt>`;
3. pulls that exact digest and runs every runtime, numerical-engine, converter,
   schema and Potree gate against it;
4. publishes the write-once tag `sha-<commit>` for the verified digest. If that
   tag already names a different digest the run fails; it never moves an
   existing tag;
5. writes and uploads the release attestation
   (`viewer-image-attestation-<commit>`, kept 90 days).

It never moves `latest`. A failed gate stops the run before the `sha-` tag and
the attestation are written, so the build cannot be promoted. The run summary
shows the commit and digest to promote.

Builds are not cancelled once started. If several merges land while a build
runs, GitHub keeps only the newest queued build, so intermediate commits may
have no candidate. That is expected: promote the commit you tested.

## 2. Staging smoke of a candidate

Pin the exact digest, never `latest`:

```text
ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer@sha256:<digest>
```

`scripts/update-truenas.sh` accepts an `@sha256:` digest or a `sha-<commit>`
tag in addition to `latest`. To pin a stack, add a
`docker-compose.override.yml` next to `docker-compose.yml` that sets `image:`
to the digest for both `viewer-api` and `viewer-worker`; Compose loads it
automatically. Remove the override to follow `latest` again.

## 3. Promote to latest (explicit approval)

Promotion is `.github/workflows/promote-viewer.yml`, run by hand from `main`
(Actions > "Promote Operations Viewer candidate to latest" > Run workflow) with:

- `commit`: the full 40-character `main` commit SHA;
- `digest`: the `sha256:` digest from that commit's publish run summary;
- `approved_by` and `approval_reference` (for example a Hub task or decision
  id): written into the receipt as a record. The workflow does not enforce
  them; enforcement would be a GitHub Environment with required reviewers, an
  owner repository setting that is not part of this workflow.

Run it only after the approvals the release requires. It does not rebuild. It:

1. checks the commit is part of `main`;
2. finds the successful `push` run of `publish-viewer.yml` on `main` for that
   commit;
3. downloads that run's attestation, checks its SHA-256 file, and requires the
   same repository, commit, image, digest, run, `main` ref and workflow, with
   every verification field passed;
4. requires `sha-<commit>` to still name the digest, pulls it, and checks the
   runtime user and revision label;
5. reads the current `latest`. It must resolve to a well-formed digest;
   anything else stops the run before anything is written, including an
   apparent absence, because production `latest` already exists. Registry,
   network and permission errors (and a bare "not found") are retried three
   times, then stop the run. The only exception is the opt-in
   `initialize_latest` input (default false) for a first-time setup: it
   proceeds only on the registry's `MANIFEST_UNKNOWN` response, refuses to run
   if `latest` exists, and records `mode: initialize` in the receipt;
6. writes a rollback receipt (previous digest, new digest, commit, candidate
   and promotion run ids, dispatcher, approver and approval reference, time)
   to the run summary and uploads it as the
   `viewer-promotion-receipt-<run>-<attempt>` artifact **before** `latest`
   changes;
7. re-reads `latest` immediately before writing and stops, writing nothing, if
   it no longer equals the receipt's previous digest or cannot be read. This
   narrows the window for another writer; it is **not** an atomic
   compare-and-swap;
8. moves `latest` to the digest and confirms it. If the write or the
   confirmation fails, the run fails and prints the rollback command. It does
   **not** restore `latest`. A `viewer-promotion-result-<run>-<attempt>` record
   is still uploaded.

Promotions never run in parallel. Promoting the digest `latest` already names
is a no-op. A test fails if any other workflow or script writes the Viewer
`latest` or `sha-` tags. None of this is a registry-wide lock, so package admins
must not write `latest` during a release.

## Rollback

Run the same promotion with an earlier commit and its digest (the previous
digest is in the last promotion's receipt artifact and summary). Rolling back
the image does not prove the older image is compatible with a newer database
schema; check that before rolling back. The
attestation must still exist, so this works for 90 days after that candidate
was built. For older images, pin the digest on the host instead (section 2).

## Updating the production host

After a promotion, update with the guarded helper as before:
`scripts/update-truenas.sh . auto` pulls `latest`, keeps the previous image as
`ltds-viewer-rollback:previous`, waits for health and runs the readiness check.
Pinning a digest (section 2) is the stricter option: the host then changes only
when someone edits the pin.

The Compose file uses `pull_policy: always`. Any `docker compose up` or app
redeploy on the host pulls `latest` again, so a redeploy after a promotion picks
up the promoted image even without the helper.

## Candidate tag retention

`candidate-*` and `sha-*` tags accumulate in the package. They are small next
to the shared layers, and none of them is moved. Prune old, unpromoted
candidates by hand from the package settings when needed; keep every digest
that was ever promoted, and anything still within the rollback window.
