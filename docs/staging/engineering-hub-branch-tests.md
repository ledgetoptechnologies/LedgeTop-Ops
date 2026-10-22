# Branch testing through Engineering Hub

## Execution policy

GitHub Actions runs for pushes to `main` and for pull requests. The image
publishers have no manual branch trigger. Image promotion still requires the
reviewed main-branch publication gates. The workflow-trigger policy is checked
in the ordinary source-invariants job.

Feature-branch testing is intended to run on staging through Engineering Hub
before opening or updating a pull request. The pull request must still pass
GitHub CI before merge.

## Current readiness

Engineering Hub does **not yet execute Operations branch tests**. Its
`ledge-top-ops.validate` entry is coordination metadata with closed worker
admission. The currently implemented queued staging pilot is restricted to
Engineering Hub's own project. Shared roadmap notes and a successful Hub pilot
are not an Operations execution receipt.

The Hub integration needs an Operations-specific test action, trusted worker
enrollment and the private staging connection before this handoff is active.
Until then, run the repository tests locally or in an explicitly prepared
staging checkout, and retain PR CI as the merge gate.

## Required Operations test handoff

The Hub runner must bind a job to `ledge-top-ops`, one exact reviewed Git commit
and its immutable artifact digest, rather than executing a moving branch name.
Use a separate disposable Linux checkout/container on the staging test machine.
The host needs Node 24, locked npm installs, Docker for container checks and the
Edge browser dependencies used by the existing browser jobs.

The authoritative test commands and matrices remain in the root
`.github/workflows/ci.yml`, `.github/workflows/operations-mcp.yml` and
`.github/workflows/publish-viewer.yml`. An enrolled runner must cover the
applicable source-invariant, application, desktop/mobile browser, MCP and Viewer
checks from those definitions. Do not replace that matrix with a single build
command or report skipped jobs as passing. Viewer checks include the full Linux
suite and the exact locally built container verification, without registry
promotion.

This staging action runs tests only. It must not publish packages, deploy
Workers, change Access policies, use production credentials or mount production
data. Test data and databases are disposable synthetic fixtures. TrueNAS
administration remains operator-controlled.

Before marking this handoff active, verify successful and deliberately failing
jobs, cancellation and cleanup, stale-commit rejection, and recovery after a
worker restart. Record the exact commit, test commands, exit codes, skipped
coverage, runner/artifact identity and logs in Hub completion evidence. An
expired lease or lost response must be reconciled before another job starts.

The Hub work belongs to its separately reviewed executor integration; this
Operations policy change does not enable an unenrolled runner or modify Hub
admission controls.
