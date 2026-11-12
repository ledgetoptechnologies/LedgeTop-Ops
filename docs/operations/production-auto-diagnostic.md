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
| Wall-clock race inside the probe | 15 min |
| Output | one JSON line, at most 16 KiB (`head -c 16384`) |
| Refusal list | at most 50 records, plus a total count |
| Read-step lists | at most 16 entries |

Every reported value must look like a fixed label, otherwise it is replaced with `unlabelled`. So no URL, host,
path, body or error text reaches the log or the step summary. The process's stderr is discarded.

**Original run vs diagnostic run.** The step summary records both:
- the original CI run id, attempt and commit (`github.event.workflow_run.*`);
- the diagnostic run id and attempt (`github.run_id`, `github.run_attempt`), labelled "not a release run".

## Constraint Merger must decide: the release gate

The runtime's first check is `env.PRODUCTION_AUTO_RELEASE_ENABLED === 'true'`. With the global release OFF, which
this workflow requires, an unchanged probe stops at that gate and diagnoses nothing.

`production-auto-diagnostic-run.mjs` therefore does one substitution, and only in the env copy it hands to the
probe: it sets `PRODUCTION_AUTO_RELEASE_ENABLED: 'true'`. It does this only after refusing unless all of these
hold:
- the real value is exactly `'false'`;
- the diagnostic opt-in is `'true'`;
- the lane is `ledgetop-clients`;
- the event is `workflow_run`.

It never changes the repository variable, and the real release workflow still sees OFF and doesn't run.

**This is the one place the design relies on the probe's write-blocking, not on the gate.** If Merger rejects it,
the alternatives are:
- (a) a reviewed runtime change that adds a separate, explicitly diagnostic gate value;
- (b) no workflow at all, with Merger running the probe on a controlled hosted runner.

Turning the global release ON for a diagnostic is not an option. The release workflow would then fire on the
same CI completion.

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
| `held_before_first_write` | `stage`, `reason`, `phase`, `cause`, `class` and `failedReadStep` say where it stopped |
| `reached_first_write_boundary` | every read gate passes; the hold is at or after `readOldAssets`, which the probe never runs |
| `refused` | the runner's own preconditions failed, so the probe was not called |
| `timeout`, `probe_error` | fixed labels only |

The job succeeds only for the two diagnosis statuses (exit 0).

## Checks

```
node --test scripts/production-auto-diagnostic-run.test.mjs scripts/workflow-trigger-policy.test.mjs scripts/production-auto-readonly-probe.test.mjs
```

What these cover:
- gate preconditions and refusals;
- the probe never being called on refusal;
- the substitution confined to the env copy;
- the timeout;
- bounded and label-only output;
- hash pins equal to the files;
- a workflow policy that rejects: running while the release is on, a missing opt-in, write tokens, a dispatch
  trigger, non-main branches, unsuccessful runs, persisted credentials, a cancelling lock, secrets passed to npm,
  a removed hash check or timeout, and any call to a release runtime.
