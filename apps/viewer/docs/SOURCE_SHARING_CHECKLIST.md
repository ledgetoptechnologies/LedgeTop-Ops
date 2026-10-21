# External evaluation source-sharing checklist

## Decision at the accepted viewer baseline

Reviewed main revision: `ab6bcc766e102d549c1267717da02b46c9fdf522`.
The owner has reported that the viewing experience is working as intended;
see the [release acceptance record](STABILITY_MEMORY_STORAGE_CANDIDATE.md).

Do not treat the deployment checkout as a ready-made external distribution.
Prefer a sanitized, tracked-source-only snapshot with no Git history, or a
deliberately limited viewer demo using an owner-approved dataset. Neither a
source package nor a public demo was created or shared during this review.

## What the current-source review established

- The tracked inventory contains no populated `.env`, SQLite database, backup
  ZIP, log, or private-key file. `.env.example` contains placeholder secrets,
  not the live secret values. Credential-pattern searches and source review
  did not identify a real credential in current tracked source; that is not
  a guarantee against every arbitrary secret format.
- Runtime credentials and managed model data are supplied through external
  configuration and storage mounts. Do not include those mounts, the live
  environment file, browser storage, signed asset URLs, HAR captures, console
  dumps, or exported database files in a handoff.
- Tracked deployment examples contain actual company hostnames, private LAN
  ranges/host addresses and TrueNAS installation paths. These are not access
  credentials, but disclose installation details and must be customized for
  another operator instead of pointing their instance at the existing service.
- `serve-all.sh` contains an actual client/job photo-directory path. Omit this
  legacy development helper from an external snapshot, or replace it with a
  generic, reviewed local-only example. It starts development file servers and
  is not the production deployment path.
- Internal QA/handoff documents include project labels, storage totals,
  camera-relative positions and deployment observations. Anonymize or omit
  those documents in the external distribution according to the owner's
  intended audience. Keep the internal evidence record intact.
- The small tracked B3DM/LAZ files are test fixtures, distinct from the excluded
  production asset directories. The tests and tileset describe synthetic/simple
  geometry; independently review fixture provenance if distributing them under
  a new project's release policy.

## Packaging and deployment boundaries

1. Export only the reviewed tracked source at an exact revision; do not ZIP the
   whole working directory. `.gitignore` is not a filter applied by a normal
   folder ZIP operation, and does not sanitize files already committed.
2. Remove/anonymize the internal helper and QA/deployment details in the export,
   not by silently changing the currently working production defaults.
3. Supply generic hostnames, storage paths and setup instructions. The recipient
   must generate independent secrets and use their own datasets and providers.
   Do not supply Operations credentials or grant access to the existing server.
4. Do not bundle `.git`. This review did not audit prior commits or branches;
   deleting sensitive text from today's files would not remove it from history.
5. Review the intended license and third-party notices before distribution.
   `package.json` currently declares `ISC`, but no project-level LICENSE file
   was found. The Obj2Tiles fork documentation identifies upstream AGPL-3.0 and
   the image includes its upstream license. This is an inventory observation,
   not a completed license-compliance assessment or a newly selected license.
6. Validate the sanitized snapshot in an isolated setup before handing it over.
   The existing production Compose/template is installation-specific, not a
   turnkey configuration for an unrelated operator.

The current `.dockerignore` also does not exclude `.env` or other populated
environment variants. The Dockerfile copies the context into its build stage;
therefore, keep local secrets outside that context when preparing a build or
sharing build-cache artifacts. This does not establish that a live secret was
included in the published CI image.

## Review limits

This is an accidental-disclosure review, not a full application penetration
test, Git-history secret scan, legal review, or blanket production-readiness
certification. No live secret values were collected, no production access was
granted, and no source sanitization or runtime/security-policy changes were
implemented as part of recording these findings.
