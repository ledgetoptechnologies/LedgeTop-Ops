# Releasing the Viewer image

The Viewer API and worker share one image,
`ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer`. Every qualifying merge to
`main` builds and verifies an immutable candidate and, once every check has
passed, moves `latest` to it in the same run (the way Project-Alpha's images
work). The hand-run, approved promotion below is for rollback and re-promotion.

## 1. Every merge to main: build, verify, then move latest

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
   (`viewer-image-attestation-<commit>`, kept 90 days);
6. once that job has passed, a separate `promote-latest` job moves `latest` to
   that exact digest:
   - only on a push to `main`, never for a pull request, tag or other branch;
   - only if `sha-<commit>` still names the verified digest and the image
     carries this commit's revision label;
   - it runs in the `latest-writer-viewer` concurrency group, which the manual
     `promote-viewer.yml` also uses, so the automatic and manual writers never
     interleave their reads, compare, write and read-back;
   - a manual promotion (rollback or re-promotion) wins over builds already in
     flight: if one succeeded after this run was created, `latest` is left
     alone. The next merge to `main` moves it forward again;
   - only forward: it reads the commit that `latest` names now and asks
     GitHub to compare it with this commit. If this commit descends from it,
     `latest` moves. If `latest` already names a newer `main` commit (an older
     build finishing late), it is left alone with a warning. Anything else
     (diverged history, a missing revision label, a registry error) fails the
     job and writes nothing. A missing `latest` is created only when the
     registry answers exactly "not found" or `MANIFEST_UNKNOWN` for that tag;
   - it re-reads `latest` just before the write, with the same strict absence
     rule, and stops on any change or any read error (auth, network, server).
     The registry has no atomic compare-and-swap, so a package admin writing
     by hand could still race it;
   - the run summary records the commit, the new digest, the previous `latest`
     digest and its commit, and the decision.

   GitHub keeps at most one pending job per concurrency group. A newer pending
   writer replaces an older pending one, so if a manual promotion is still
   waiting (for example for approval) when another build's `promote-latest`
   queues behind it, check that the manual run completed, and dispatch it again
   if it was cancelled.

A failed gate stops the run before the `sha-` tag, the attestation and `latest`
are written. The run summary shows the commit and digest.

Builds are not cancelled once started. If several merges land while a build
runs, GitHub keeps only the newest queued build, so intermediate commits may
have no candidate. That is expected, and `latest` simply skips them.

## 2. Staging smoke of a candidate

Pin the exact digest, never `latest`:

```text
ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer@sha256:<digest>
```

`scripts/update-truenas.sh` accepts an `@sha256:` digest or a `sha-<commit>`
tag in addition to `latest`. To pin a stack, add a
`docker-compose.override.yml` next to `docker-compose.yml` that sets `image:`
to the digest for both `viewer-api` and `viewer-worker`; Compose loads it
automatically. Remove the override to follow `latest` again. Because `latest`
now follows `main`, pin a digest on any host that must not change with the
next merge.

## 3. Manual promotion: rollback or re-promotion (explicit approval)

Promotion is `.github/workflows/promote-viewer.yml`, run by hand from `main`
(Actions > "Promote Operations Viewer candidate to latest" > Run workflow) with:

- `commit`: the full 40-character `main` commit SHA;
- `digest`: the `sha256:` digest from that commit's publish run summary;
- `approved_by` and `approval_reference` (for example a Hub task or decision
  id): typed notes only, kept in the receipt.

Approval is enforced: the job runs in the protected GitHub Environment
`image-promotion`, so GitHub holds it until a required reviewer approves.
Before any other step it verifies through the API that the environment exists
and has a required-reviewers rule, and reads the approver from the deployment
review into the receipt (`approvedBy`); otherwise it stops and writes nothing.
The environment is an owner repository setting (Settings > Environments) that
this workflow never creates or changes.

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

Writers of `latest` never run in parallel: this workflow and the publisher's
`promote-latest` job share the `latest-writer-viewer` concurrency group.
Promoting the digest `latest` already names is a no-op. A test fails if any
workflow or script other than this one and `promote-latest` writes the Viewer `latest`, or anything but the publisher
writes `sha-` tags. None of this is a registry-wide lock, so package admins
must not write `latest` during a release.

## Rollback

Run the manual promotion with an earlier commit and its digest (the previous
digest is in the publish run's summary and in the last promotion's receipt).
A rollback holds against builds already in flight; the next qualifying merge
to `main` after it moves `latest` forward again; merge the fix (or a revert) to move on. Rolling back
the image does not prove the older image is compatible with a newer database
schema; check that before rolling back. The
attestation must still exist, so this works for 90 days after that candidate
was built. For older images, pin the digest on the host instead (section 2).

## Updating the production host

After `latest` moves, update with the guarded helper as before:
`scripts/update-truenas.sh . auto` pulls `latest`, keeps the previous image as
`ltds-viewer-rollback:previous`, waits for health and runs the readiness check.
Pinning a digest (section 2) is the stricter option: the host then changes only
when someone edits the pin.

The Compose file uses `pull_policy: always`. Any `docker compose up` or app
redeploy on the host pulls `latest` again, so a redeploy after a merge to `main`
picks up the newest verified image even without the helper.

## Candidate tag retention

`candidate-*` and `sha-*` tags accumulate in the package. They are small next
to the shared layers, and none of them is moved. Prune old, unpromoted
candidates by hand from the package settings when needed; keep every digest
that was ever promoted, and anything still within the rollback window.
