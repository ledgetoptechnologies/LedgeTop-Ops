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
     interleave their reads, compare, write and read-back. Every writer uses
     `queue: max`, so a pending writer is never replaced by a newer one;
   - it can be paused with the repository variable `AUTO_PROMOTE_LATEST_PAUSED`.
     Its first step decides, before any registry login, registry read or API
     call: `true` skips everything else with a warning, unset or `false` runs,
     and any other value fails the job without writing. The value is the one
     GitHub supplies when the job is prepared (the workflow token cannot read
     repository variables), so a pause governs publisher runs created after it
     was set, not runs already in flight;
   - only forward from whatever `latest` names at write time: it reads that commit and asks
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

   With `queue: max`, GitHub keeps up to 100 pending writers per group, in
   order (ordering is not guaranteed). Beyond that it cancels the new one. A
   cancelled `promote-latest` leaves `latest` where it is, and the next merge
   moves it forward. A cancelled manual promotion must be dispatched again.

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

A rollback is the manual promotion of an earlier commit and its digest (the
previous digest is in the publish run's summary and in the last promotion's
receipt). It lasts until the next automatic write: any `promote-latest` job
that runs after it moves `latest` forward again. To keep a rollback, do these
steps in this order:

1. Set the repository variable `AUTO_PROMOTE_LATEST_PAUSED` to `true`. It
   pauses every image's automatic promotion, for publisher runs created from
   now on.
2. Wait for, or cancel, every publisher run already in progress (the
   `publish-*.yml` workflows), because they may have read the old value.
3. Check that no publisher run is still queued.
4. Then run the manual promotion to roll back.
5. To resume, unset the variable (or set it to `false`). The next merge to
   `main` moves `latest` forward again.

Going back past schema 46: use the recorded rollback image, or turn on the
pause and check it before step 4. See
[Rollback after schema 46](#rollback-after-schema-46).

Reverting on `main` is the other way to move `latest` back for good. Rolling back
the image does not prove the older image is compatible with a newer database
schema; check that before rolling back. The
attestation must still exist, so this works for 90 days after that candidate
was built. For older images, pin the digest on the host instead (section 2).

### Rollback after schema 46

Schema 46 keeps original GCP source files. An older release ignores it. Its
worker runs at start and every hour, deletes expired Recycle Bin datasets
without keeping their CSV files, and deletes upload caches this release keeps
on purpose. Its API does the same when staff delete or purge. Those files
cannot be recovered from the database. Retained originals are not touched.

A restart pulls whatever `latest` is and starts its worker at once. No check
inside the new image or an update script can protect a rollback.

**Rule: go back only to an image that was rehearsed for this.** Use the first
that applies:

1. Fix forward.
2. Roll back to the recorded rollback image, by digest. It must be a release
   that removes neither originals nor upload caches, and its exact digest must
   have passed on staging: on a synthetic store migrated to schema 46, through
   first start, restart and recreate.
3. Fallback: pause first, then an older image. The pause is
   `PROCESSING_PLATFORM_ENABLED=false` in the host settings. Older releases obey
   it: their worker stays idle, and the processing, upload, delete and purge
   routes are off. Viewing still works. Use it only when it was rehearsed with
   that exact image on a migrated synthetic store: the value is `false` before
   the first start, the worker is idle, the write routes are off, and nothing is
   removed through a restart and a recreate. Keep the pause on from before the
   rollback until a release with proven retention runs again.

A file or module existing in an image is not proof that it keeps anything. The
proof is the staging record of that exact digest and commit.

#### Steps for someone who restarts the containers

Do these in order. Stop if a check fails.

1. In the host settings for the Viewer app, set `PROCESSING_PLATFORM_ENABLED`
   to `false`. Use the place Compose takes the value from (the app's own
   settings, or the file given with `--env-file`). `Config/viewer.env` alone is
   not enough: the Compose file sets this variable itself and wins over it.
2. Apply it while the current release is still the one that starts. Recreate
   both containers (`docker compose up -d`, or save and redeploy the app). A
   plain container restart keeps the old value.
3. Look at the `viewer-worker` log. It must say `Processing worker is idle
   because PROCESSING_PLATFORM_ENABLED=false`. If it does not, the pause is not
   on. Go back to step 1.
4. Only now move `latest` back (the steps above) or change the pinned digest,
   and restart.
5. Look at the `viewer-worker` log again. It must show the same line.
6. Leave the value alone. Restarts and host reboots are safe while it is
   `false`.

If an older release ran without the pause: stop both containers now, do not
start them again, and keep the database, `trash` and `cache` as they are.

#### Before turning processing back on

All of these must be true:

- Both containers run an image whose exact digest has a staging record for
  retention on a migrated store. `/app/source-commit.txt` in `viewer-api` and in
  `viewer-worker` is the commit in that record.
- `latest`, or the pinned digest, is that same image, so the next restart does
  not bring the older one back.
- Both containers are healthy, and the API log shows no database error.

Then set the value back to `true` and recreate both containers. The worker log
must no longer say it is idle.

#### If an older release must run with processing

Stop both containers, keep the current database, cache and trash, and restore
the pre-upgrade backup of the database and storage together. Work done since
the upgrade is not in it.

#### What the updater adds

`scripts/update-truenas.sh` is not used by a plain restart. Where it is used,
its automatic rollback starts an image without the retention module view-only,
and it refuses to update to such an image while processing is on. The check can
only refuse. An image that passes it still needs the staging record above.

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
