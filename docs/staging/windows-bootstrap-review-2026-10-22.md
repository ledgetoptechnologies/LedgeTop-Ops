# Bootstrap candidate review: package acceptance held

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
