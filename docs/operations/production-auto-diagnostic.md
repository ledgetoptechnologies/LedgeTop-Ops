# Read-only diagnostic for a held automatic release

Status: **draft for Merger's review.** Nothing here has run. Merger owns the repository variables, the merge,
and any run.

## Why this exists

Release run `43261175765` stopped in the Client lane. The coordinator then reported its single fixed hold
sentence, so the actual cause is unknown. The probe (PR #526) finds where a release stops without writing
anything. This workflow runs that probe on GitHub-hosted runners against a real main CI completion. It never
runs on Beau's PC or the held `.88` host.

## What it is

The diagnostic is made of:
- `.github/workflows/production-auto-diagnostic.yml`, a single job named `diagnose-client`;
- `scripts/production-auto-diagnostic-run.mjs`, a bounded entry point;
- the probe `scripts/production-auto-readonly-probe.mjs`, which is unchanged.

**Trigger.** The same authentic trigger as the release: `workflow_run` of `CI`, `completed`, on `main`. The job
runs only when all of these hold:
- the run was a `push` on `main`;
- its conclusion is `success`;
- the repository and the head repository are both `ledgetoptechnologies/LedgeTop-Ops`;
- `vars.PRODUCTION_AUTO_DIAGNOSTIC_ENABLED == 'true'`;
- `vars.PRODUCTION_AUTO_RELEASE_ENABLED == 'false'` (exactly `'false'`; unset doesn't count).

There is no dispatch, schedule, PR or feature-branch trigger.

**Can't overlap a release.** The release jobs need `PRODUCTION_AUTO_RELEASE_ENABLED == 'true'`; the diagnostic
needs it `'false'`. So at most one of them runs for any CI completion. It also takes the release's
non-cancelling `production-auto-installation-*` lock.

**Source.** It checks out `github.event.workflow_run.head_sha` with `persist-credentials: false`. The release
runtime's own fences run unchanged against that checkout:
- the checkout must be clean;
- it must be the trigger's CI commit;
- it must equal current main.

**Same build preparation as the failed lane.** It runs `npm ci --prefix apps/client` with no secrets in that
step. The runtime's own build call then strips secrets from the build environment, exactly as in the release.

**Probe outside the checkout.** Both scripts are copied to `$RUNNER_TEMP` and checked with `sha256sum --check
--strict` against hashes pinned in the workflow. A test keeps those pins equal to the committed files. The job
then confirms the checkout is still clean and runs the copy. The release modules load from the checkout through
`PRODUCTION_AUTO_PROBE_CHECKOUT`.

**Credentials.**
- `GITHUB_TOKEN` with `contents: read` and `actions: read`;
- the existing `secrets.CLOUDFLARE_API_TOKEN`, and no other secret.

The probe's exact allowlist refuses every non-read request before it is sent: pinned GitHub reads, pinned
Cloudflare account reads, and D1 POST only for the one reviewed SQL statement on the 2 pinned databases.
Redirects are refused. Every write step is replaced by a counted stop, and the receipt is a counted no-op.
There is no journal, no artifact upload and no provider write.

**Bounds.**

| Bound | Limit |
|---|---|
| Job timeout | 25 min |
| `timeout` on the process | 20 min |
| Runner deadline: kills and reaps the probe's whole process group/tree | 15 min |
| Wait for the killed group to be gone (reported as `reaped`) | 5 s |
| Output | one JSON line, at most 16 KiB; past that the probe tree is killed (`output_limit`), and `head -c 16384` again in the workflow |
| Refusal list | at most 50 records, plus a total count |
| Read-step lists | at most 16 entries |

Every reported value must look like a fixed label, otherwise it is replaced with `unlabelled`. So no URL, host,
path, body or error text reaches the log or the step summary. The process's stderr is discarded.

**Original run vs diagnostic run.** The step summary records both:
- the original CI run id, attempt and commit (`github.event.workflow_run.*`);
- the diagnostic run id and attempt (`github.run_id`, `github.run_attempt`), labelled "not a release run".

## The diagnostic gate (runtime mode, no substitution)

The release runtime has an explicit `readonly_diagnostic` mode (`runProductionAutoRelease({ mode, diagnostic })`):
- **Its own gate:** `PRODUCTION_AUTO_DIAGNOSTIC_ENABLED === 'true'` AND `PRODUCTION_AUTO_RELEASE_ENABLED === 'false'`
  exactly AND the Client lane. It never reads or changes the release gate value; release mode (the default, and the
  only mode the release CLI uses) is unchanged and refuses a diagnostic sink.
- **No injection:** in this mode the caller may not pass a transport, adapter factory, recipient, trigger or source
  reader (`runtime_diagnostic_injection_refused`). Only the built-in defaults run: the authentic workflow_run file
  and the real git clean/current source fence.
- **Runtime-owned guard:** the runtime wraps the transport before the adapter factory sees it and wraps the adapter
  the factory returns (`guardReadonlyDiagnosticRuntime` in `production-auto-readonly-guard.mjs`), both frozen. Every
  write step is a counted stop and the network is the exact read allowlist.

The runner checks the same preconditions first so a refused run never starts a process, then runs the probe CLI as a
child process with the deadline and output limit above.

**Scope note.** This diagnoses the *next* main CI completion, not the historic run `43261175765`. The runtime's
fences require the checkout to equal current main and the trigger to be that exact CI run, and re-targeting an
old run would mean overriding those fences. If the cause is in source or provider state, it shows on the next run.

## Pause and restore sequence (Merger)

1. Confirm `PRODUCTION_AUTO_RELEASE_ENABLED` is exactly `false`. Record its prior value.
2. Review and merge this workflow. Merging is a push to main, so CI runs. Nothing else runs yet, because the
   opt-in is unset.
3. Set `PRODUCTION_AUTO_DIAGNOSTIC_ENABLED=true`.
4. Let the next main CI succeed. This is the authentic trigger; there is no manual dispatch. Read the
   `diagnose-client` step summary.
5. Set `PRODUCTION_AUTO_DIAGNOSTIC_ENABLED` back to unset or `false` straight away.
6. Restore `PRODUCTION_AUTO_RELEASE_ENABLED` only through the normal reviewed release decision. The diagnostic
   never changes it.

**Budget.** One run is about 3 to 8 minutes: checkout, `npm ci`, then the Client build inside the coordinator's
`build` read step. It is bounded at 25 minutes, and it runs only while the opt-in is on.

## Outputs

| `status` | Meaning |
|---|---|
| `held_before_first_write` | `stage`, `reason`, `phase`, `cause`, `errorType` (a built-in error class name, only for `unexpected_error`), boolean `checks` and `failedReadStep` say where it stopped |
| `reached_first_write_boundary` | every read gate passes; the hold is at or after `readOldAssets`, which the probe never runs |
| `refused` | the runner's own preconditions failed, so the probe was not called |
| `timeout`, `output_limit` | the probe's process group/tree was killed; `reaped` says whether it was confirmed gone |
| `probe_error` | the probe printed no parseable line; no output text is reported |

The job succeeds only for the two diagnosis statuses (exit 0).

## Checks

```
node --test scripts/production-auto-diagnostic-mode.test.mjs scripts/production-auto-diagnostic-run.test.mjs scripts/workflow-trigger-policy.test.mjs scripts/production-auto-readonly-probe.test.mjs
```

What these cover:
- the runtime mode's gate, its refusal of every injected transport, factory or reader, and release mode unchanged;
- the real trigger and git source fences running with only the defaults, with the gate value never substituted;
- the runtime-owned guarded transport and adapter (real coordinator: the held receipt is a no-op);
- runner preconditions, and no process started on refusal;
- the timeout and output limit killing the probe's whole tree, with a grandchild confirmed gone;
- `errorType` carried through, unlisted fields dropped;
- bounded and label-only output;
- hash pins equal to the files;
- a workflow policy that rejects: running while the release is on, a missing opt-in, write tokens, a dispatch
  trigger, non-main branches, unsuccessful runs, persisted credentials, a cancelling lock, secrets passed to npm,
  a removed hash check or timeout, and any call to a release runtime.
