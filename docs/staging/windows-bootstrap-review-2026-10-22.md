# Bootstrap candidate review: package acceptance held

## Follow-up: retained-view shutdown race

Desktop`5b01f792b3f86d4f51f9347cc7422e6e8e54ef19` fixes the first late-startup
case, and`1dacf5ba6f2d454f94b143171afa17ebec07aed3` adds dispatcher deferral for
an idle/already-disposed window. Those changes do not yet establish complete
shutdown ownership. The MainViewModel blob is identical in both:
`9529a6da1e33ee4b55a1891a2afdf03f78edbf46`.

An independent isolated5b archive regression reproduces a second path:
an active old-person transfer expires, its queue remains retained, a different
person signs in, and the old view detaches its queue while cleanup is delayed.
Disposal then returns before that cleanup finishes. Releasing cleanup lets the
sign-in continuation create a new-person queue after close; its lock remains.

Observed output:

```text
close_completed_while_old_drain_pending=True
all_queue_locks_released_after_close=False
0/1 app groups passed
```

This uses real TransferQueue/QueueHost/MainViewModel code. Only the scratch demo
provider adds a deterministic delayed-finally gate so the test can hold cleanup
until after the old view detached. The test waits for the queue field to be null;
waiting only for provider cleanup to start would exercise a different, already
owned queue and hide the bug. No network or real credentials/data are involved.
Archive SHA256 is
`36abd9b7fb14b00ff18265fb5c4709c1a71df6e5422faf8ed31f7289439a7f43`;
scratch is`C:/Users/fstor/.codex/tmp/windows-person-close-review-5b01f792/`.

The failure remains applicable to1dacf because the relevant model, host and Core
sources are byte-identical. Fixing only the post-await closed check prevents a
new queue but does not make disposal wait for the old detached host to drain.
Both lifetime ownership and the continuation fence are required. The finding
and executable fixture were sent to Claude. A minimal correction is being
prepared/tested in an isolated scratch; no direct edits to her worktree.

Root subsequently ran the exact1dacf clean archive independently:18/18 AppTests
passed, including idle/already-disposed and delayed-startup/open/active-transfer
close cases, with rendered output inspected. That source archive SHA256 is
`9191cd4db1ccb45d3ff586af2f8dffa46a7a20eb4204a23ce2ae15f00b00c134`.
The passing existing groups do not negate the separate retained-view failure.

An isolated correction against1dacf now passes20/20 AppTests, terminal exit0,
with no warning suppression: detached-host drain tasks remain owned until
finished, close joins them, Enter rechecks closed after old-view shutdown and
queue entry is serialized so concurrent startup/sign-in cannot replace the
single pending-open owner. Its MainVM blob is
`a67f761cc60015d78262d7fbb4ea4f50ade014ee`. Product patch SHA256 is
`431f9c022d4132f9829f6cca2a2767c17530f55e3b0f9d63cfa07b9685346197`;
separate regression/instrumentation patch SHA256 is
`631735bf4a73335e65d3f0db2ebaaed4364e01395f96b4f3c44a7f4ed26d33a1`.
Artifacts are privately retained at
`C:/Users/fstor/.codex/tmp/windows-person-close-fix-1dacf5ba/`.

Claude independently pushed4810e473 with retiring-drain ownership and reported
19/19 tests. Root compared that commit with the isolated correction: the
primary drain fix is equivalent in intent, but the single pending-open owner
can still be replaced by concurrent Enter calls. The serialization/ownership
regression and tested patch were sent for comparison/integration; no worktree
was overwritten. Neither the isolated patch nor its20 passing groups should be
reported as a merged desktop candidate. Final composite-source verification and
new package construction remain pending.

## Earlier bootstrap checkpoint

Exact desktop candidate: `feab610edbfa109348ea2cb9cc1653d9e204adb5`, parent
`f50337f9`. This is a source/test checkpoint, not an accepted installer release.

The independent clean-archive run passed16/16 existing AppTests with synthetic
data and no network. Exact SDK10.0.402 also published a self-contained x64 pilot
using `-p:LedgeTopPackage=true -p:LedgeTopReleaseChannel=pilot`. The actual output
DLL contains exactly the compiled pilot channel; SHA256 is
`4c5862cd4076377e78a4f6d62bdb00fed8cd4b2394f29a54532b4746b43fb52d`.
Its source archive SHA256 is
`ab03bd6488bfdbf2887c8e74e2a64e33e45500266a80f3b08a9effbd16899eef`;
Windows subtree identity is`5361b7fbc6bfd2aecbaf40b0e23d05014bc9a944`.

## Passing scope

The candidate takes packaged endpoint/helper identity only from a compiled
profile, fixes staging endpoints, pins the qualified Cloudflare helper, leaves
stable unconfigured, and separates pilot/stable/developer queue roots. Unknown
metadata and bad/missing helper fail closed. AppTests exercise malicious mutable
settings/arguments/environment and retain legacy files unchanged. Independent
source review found no blocker in this narrow bootstrap scope.

The new offline `scripts/windows-package-channel-check.ps1` reads PE metadata
without loading or executing the application. It accepted the actual published
pilot DLL and denied five cases: wrong expected channel, two differing compiled
channel attributes, unknown channel, wrong-case metadata key, and the old
developer rehearsal DLL. Compiler-generated synthetic PE fixtures were used for
the malformed cases. Identical repeated SDK metadata items were deduplicated by
the compiler, so the real duplicate fixture uses both pilot and stable values;
it is not a mocked parser count. This guard is only one package-build check,
not signature, origin, helper or whole-package verification.

## Reproduced shutdown failure

Review found that `StartAsync` and sign-in await authentication before entering
the queue-open generation fence. Disposing a model while that await is pending
can complete the memoized shutdown; a late result can then open a new queue that
later disposal will not release.

An isolated copy of the exact source archive added this synthetic regression:

```csharp
await using var env = Env.Create(signedIn: false);
await env.Model.StartAsync();
env.Model.SignIn.Execute(null);
await Task.Delay(50);
await env.Model.DisposeAsync();
await Task.Delay(2200);
True(env.Model.Screen != Screen.Files,
    "closed model reopened Files after pending sign-in completed");
```

It failed exactly at that assertion. The expanded run ended16/17, exit1; all16
original groups still passed. This is expected failing evidence of a real race,
not a green acceptance run. It uses only temporary synthetic data, no server,
credentials, actual client files or network. Scratch reproduction is retained at
`C:/Users/fstor/.codex/cache/windows-late-close-repro-feab610e/`.

The touched `async void OnClosing` also does not cancel/defer close before its
await, while the app shuts down on its main window. Source review therefore
does not establish that active-transfer draining and durable state saving finish
before process shutdown. That second finding is source evidence; this checkpoint
does not claim an independently reproduced process-termination loss.

Both findings were sent to Claude for lifetime fencing, orderly close and
delayed startup/sign-in plus active-transfer-close regression coverage. Candidate
package acceptance is held until the corrected immutable source is tested. No
new package was packed from this candidate, signed, installed or published.
The earlier unsigned construction rehearsal remains evidence for its older
exact source only. Live staging/EH/gateway/signing/large-file requirements remain
open; no TrueNAS/NAS or production action occurred.
