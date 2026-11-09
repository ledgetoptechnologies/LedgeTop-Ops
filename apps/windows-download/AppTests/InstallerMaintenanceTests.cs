using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;

internal static class InstallerMaintenanceTests
{
    internal static async Task Run()
    {
        await GracefulQuitContract();
        InstallerStartupGate();
        UntrackedRootObservations();
        await LegacyCleanupIntegration();
        foreach (var compiled in new (bool Packaged, ReleaseChannel? Channel)[] { (false, null), (true, null), (true, ReleaseChannel.Stable) }) {
            Require(await InstallerMaintenance.RunAsync(compiled, [InstallerMaintenance.CheckArgument],
                () => throw new InvalidOperationException(), _ => throw new InvalidOperationException()) == 20,
                "unsupported builds refuse before singleton/session access");
        }
        foreach (var args in new string[][] { [], ["--installer-unknown"], ["--Installer-check"],
            [InstallerMaintenance.CheckArgument, "--demo"], [InstallerMaintenance.RemoveArgument, "C:/override"] }) {
            Require(await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), args,
                () => throw new InvalidOperationException(), _ => throw new InvalidOperationException()) == 20,
                "only one exact maintenance argument is accepted, without overrides");
        }
        Require(InstallerMaintenance.Requested(["--Installer-unknown"]) && InstallerMaintenance.Requested(["--installer"]) && !InstallerMaintenance.Requested(["--demo"]),
            "unknown maintenance requests route to refusal instead of interactive startup");
        Require(await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.CheckArgument], () => null,
            _ => throw new InvalidOperationException("No session while running.")) == 10, "running copy refuses silently before local session creation");

        var log = new List<string>(); var thread = Environment.CurrentManagedThreadId;
        var owner = new Owner(log, thread); var sources = new List<FakeSession>();
        Require(await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.CheckArgument], () => owner, mode => {
            log.Add("prepare-" + mode); var session = new FakeSession(log, mode.ToString()); sources.Add(session); return session;
        }) == 0 && sources.Count == 2 && sources.All(source => source.Removals == 0 && source.Disposals == 1) && owner.Disposals == 1,
            "check reads both fixed sources and disposes without start/auth/removal");
        Require(log.Last() == "owner-dispose", "singleton ownership outlives all check sessions");

        foreach (var permitted in new[] { true, false }) {
            log.Clear(); owner = new Owner(log, thread); sources.Clear(); var checks = 0;
            var result = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.CheckArgument], () => owner, mode => {
                var session = new FakeSession(log, mode.ToString()) { State = mode == AccessMode.Employee ? ExplorerPreviewState.Failed : ExplorerPreviewState.NotStarted };
                sources.Add(session); return session;
            }, _ => Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt), _ => { checks++; return Task.FromResult(permitted); });
            Require(result == (permitted ? 0 : 20) && checks == 1 && sources.All(s => s.Removals == 0 && s.Disposals == 1) && owner.Disposals == 1,
                "installer check accepts only verified fresh ownership and always drains sessions");
        }
        log.Clear(); owner = new Owner(log, thread); sources.Clear(); var removeChecks = 0;
        var freshRemoval = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument], () => owner, mode => {
            var session = new FakeSession(log, mode.ToString()) { State = mode == AccessMode.Employee ? ExplorerPreviewState.Failed : ExplorerPreviewState.NotStarted };
            sources.Add(session); return session;
        }, _ => Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt), _ => { removeChecks++; return Task.FromResult(true); });
        Require(freshRemoval == 20 && removeChecks == 0 && sources.All(s => s.Removals == 0 && s.Disposals == 1),
            "published install check does not authorize removal");

        log.Clear(); owner = new Owner(log, thread); sources.Clear();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var removing = InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument], () => owner, mode => {
            log.Add("prepare-" + mode); var session = new FakeSession(log, mode.ToString()) { Gate = mode == AccessMode.Client ? gate.Task : null };
            sources.Add(session); return session;
        });
        Require(!removing.IsCompleted && owner.Disposals == 0 && sources.Count == 2 && log.IndexOf("prepare-Employee") < log.IndexOf("remove-Client"),
            "both ownership reads finish before cleanup and singleton remains held during async removal");
        gate.SetResult();
        Require(await removing == 12 && sources.All(source => source.State == ExplorerPreviewState.Removed && source.Disposals == 1) && owner.Disposals == 1,
            "remove confirms both owned sessions, drains them, and releases singleton on original caller thread");

        foreach (var failure in new[] { "ownership", "unconfirmed", "remove", "dispose" }) {
            log.Clear(); owner = new Owner(log, thread); sources.Clear();
            var result = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument], () => owner, mode => {
                var session = new FakeSession(log, mode.ToString()) {
                    State = mode == AccessMode.Employee && failure == "ownership" ? ExplorerPreviewState.Failed : ExplorerPreviewState.NotStarted,
                    Unconfirmed = failure == "unconfirmed", FailRemove = failure == "remove", FailDispose = failure == "dispose"
                };
                sources.Add(session); return session;
            });
            Require(result == 20 && sources.All(source => source.Disposals == 1) && owner.Disposals == 1,
                "unknown ownership/unconfirmed cleanup/disposal failure returns refusal and retains drain ordering");
            if (failure == "ownership") Require(sources.All(source => source.Removals == 0), "failed ownership preflight never begins either removal");
        }
        foreach (var unavailableMode in new[] { AccessMode.Client, AccessMode.Employee }) {
            log.Clear(); owner = new Owner(log, thread); sources.Clear();
            var result = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument], () => owner, mode => {
                if (mode == unavailableMode) throw new IOException("Synthetic unknown native registration state.");
                var session = new FakeSession(log, mode.ToString()); sources.Add(session); return session;
            });
            Require(result == 20 && sources.Count == (unavailableMode == AccessMode.Client ? 0 : 1) &&
                sources.All(source => source.Removals == 0 && source.Disposals == 1) && owner.Disposals == 1,
                "unavailable native ownership during either source preflight refuses cleanup and drains earlier sessions");
        }
        Console.WriteLine("Installer maintenance: injected absence/unknown observations, fake session lifecycle and original-thread drain passed. No native registration queries or real connection cleanup.");
    }

    private static async Task GracefulQuitContract()
    {
        var log = new List<string>(); var thread = Environment.CurrentManagedThreadId;
        foreach (var compiled in new (bool, ReleaseChannel?)[] { (false, null), (true, ReleaseChannel.Stable) })
            Require(await InstallerMaintenance.RunWithQuitAsync(compiled, [InstallerMaintenance.QuitArgument],
                () => throw new Exception(), () => throw new Exception(), () => throw new Exception(), 2, () => throw new Exception()) == 20,
                "unsupported builds cannot request quit");
        var checks = 0; var requests = 0; var delays = 0;
        async Task<int> Run(bool accepted, int freeAt) => await InstallerMaintenance.RunWithQuitAsync((true, ReleaseChannel.Pilot),
            [InstallerMaintenance.QuitArgument], () => { requests++; return Task.FromResult(accepted); },
            () => ++checks >= freeAt ? new Owner(log, thread) : null,
            () => { delays++; return Task.CompletedTask; }, 3, () => throw new Exception("No other maintenance/session work."));
        Require(await Run(true, 3) == 0 && checks == 3 && requests == 1 && delays == 2 && log.SequenceEqual(["owner-dispose"]),
            "accepted quit waits for actual singleton release, retains caller thread and never prepares/removes sources");
        checks = requests = delays = 0; log.Clear();
        Require(await Run(true, 99) == 10 && checks == 4 && requests == 1 && delays == 3 && log.Count == 0,
            "acknowledgement without completed drain stays busy and never force-closes");
        checks = requests = delays = 0;
        Require(await Run(false, 99) == 10 && checks == 1 && requests == 1 && delays == 0,
            "legacy or rejected IPC returns busy for installer Retry");
        checks = requests = delays = 0;
        Require(await Run(true, 1) == 0 && requests == 0 && delays == 0,
            "definite absence succeeds without sending quit");
        Require(await InstallerMaintenance.RunWithQuitAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.QuitArgument],
            () => throw new IOException(), () => null, () => Task.CompletedTask, 1, () => throw new Exception()) == 20,
            "unavailable peer ownership refuses without starting other maintenance");
    }

    private static async Task LegacyCleanupIntegration()
    {
        var log = new List<string>();
        var sources = new List<FakeSession>();
        var thread = Environment.CurrentManagedThreadId;
        foreach (var outcome in Enum.GetValues<LegacyExplorerPreviewCleanupResult>()) {
            var calls = 0; var ownLog = new List<string>();
            var code = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RecoverLegacyInteractiveArgument],
                () => new Owner(ownLog, thread), _ => throw new Exception("Interactive recovery must not prepare connected roots."),
                _ => throw new Exception("Interactive recovery must not use the separate cleanup helper."),
                interactiveRecovery: _ => { calls++; return Task.FromResult(outcome); });
            var expected = outcome is LegacyExplorerPreviewCleanupResult.Removed or LegacyExplorerPreviewCleanupResult.NoKnownReceipt or LegacyExplorerPreviewCleanupResult.Postponed
                ? 0 : outcome == LegacyExplorerPreviewCleanupResult.Busy ? 10 : 20;
            Require(code == expected && calls == 1 && ownLog.SequenceEqual(["owner-dispose"]), "interactive recovery result and singleton routing");
        }
        foreach (var outcome in Enum.GetValues<LegacyExplorerPreviewCleanupResult>()) {
            var probeLog = new List<string>(); var calls = 0;
            var code = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.ProbeLegacyArgument],
                () => new Owner(probeLog, thread), _ => throw new Exception("Probe cannot prepare connected sources."), remove => {
                    Require(!remove && calls++ == 0, "probe is read-only and runs once"); return Task.FromResult(outcome);
                });
            var expected = outcome == LegacyExplorerPreviewCleanupResult.RecordedProfile ? 0 :
                outcome == LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified ? 11 :
                outcome == LegacyExplorerPreviewCleanupResult.NoKnownReceipt ? 12 :
                outcome == LegacyExplorerPreviewCleanupResult.Busy ? 10 : 20;
            Require(code == expected && calls == 1 && probeLog.SequenceEqual(["owner-dispose"]), "probe classifies without removal");
        }
        foreach (var compiled in new (bool Packaged, ReleaseChannel? Channel)[] { (false, null), (true, ReleaseChannel.Stable) })
            Require(await InstallerMaintenance.RunAsync(compiled, [InstallerMaintenance.RetireLegacyArgument],
                () => throw new Exception("No owner on unsupported retirement."), _ => throw new Exception(),
                _ => throw new Exception()) == 20, "retirement remains packaged-pilot-only");
        foreach (var outcome in Enum.GetValues<LegacyExplorerPreviewCleanupResult>()) {
            var retirementLog = new List<string>(); var calls = 0;
            var code = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RetireLegacyArgument],
                () => new Owner(retirementLog, thread), _ => throw new Exception("Retirement must never prepare a connected source."), remove => {
                    Require(remove && calls++ == 0 && retirementLog.Count == 0, "retirement holds its singleton for one fixed legacy operation");
                    return Task.FromResult(outcome);
                });
            var expected = outcome is LegacyExplorerPreviewCleanupResult.NoKnownReceipt or LegacyExplorerPreviewCleanupResult.Removed or LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified
                ? 0 : outcome == LegacyExplorerPreviewCleanupResult.Busy ? 10 : 20;
            Require(code == expected && calls == 1 && retirementLog.SequenceEqual(["owner-dispose"]),
                "retirement distinguishes absent/no-op, confirmed cleanup, busy and unknown without connected cleanup");
        }
        var drainLog = new List<string>(); var release = new TaskCompletionSource<LegacyExplorerPreviewCleanupResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var retirement = InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RetireLegacyArgument],
            () => new Owner(drainLog, thread), _ => throw new Exception("No connected source during retirement."), _ => release.Task);
        Require(!retirement.IsCompleted && drainLog.Count == 0, "retirement retains thread-affine owner while legacy cleanup drains");
        release.SetResult(LegacyExplorerPreviewCleanupResult.Removed);
        Require(await retirement == 0 && drainLog.SequenceEqual(["owner-dispose"]), "retirement releases owner only after completed cleanup on its owning thread");
        Require(await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RetireLegacyArgument],
            () => null, _ => throw new Exception(), _ => throw new Exception()) == 10, "active pilot prevents retirement before legacy work");
        Require(await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RetireLegacyArgument],
            () => new Owner(new List<string>(), thread), _ => throw new Exception(), _ => throw new IOException()) == 20,
            "unknown retirement failure refuses without fallback or connected work");
        foreach (var outcome in Enum.GetValues<LegacyExplorerPreviewCleanupResult>()) {
            var calls = 0;
            var code = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.LegacyRemoveArgument],
                () => new Owner(log, thread), _ => throw new Exception("Legacy-only repair must not prepare connected sources."), remove => {
                    Require(remove && calls++ == 0, "legacy-only repair executes one explicit owned cleanup");
                    return Task.FromResult(outcome);
                });
            var expected = outcome is LegacyExplorerPreviewCleanupResult.Removed or LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified
                ? 0 : outcome == LegacyExplorerPreviewCleanupResult.Busy ? 10 : 20;
            Require(code == expected && calls == 1, "legacy-only repair refuses missing/unknown receipts without touching connected roots");
        }
        FakeSession Prepare(AccessMode mode) { var session = new FakeSession(log, mode.ToString()); sources.Add(session); return session; }
        async Task<int> Execute(string argument, Func<bool, Task<LegacyExplorerPreviewCleanupResult>> cleanup) =>
            await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [argument], () => new Owner(log, thread), Prepare, cleanup);

        Require(await Execute(InstallerMaintenance.CheckArgument, _ => throw new Exception("Installation must not inspect/migrate the old demo.")) == 0,
            "ordinary installer preflight does not adopt the legacy portable demo");
        foreach (var outcome in new[] { LegacyExplorerPreviewCleanupResult.Removed,
            LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified, LegacyExplorerPreviewCleanupResult.NoKnownReceipt }) {
            log.Clear(); sources.Clear();
            var legacyCalls = 0;
            Require(await Execute(InstallerMaintenance.RemoveArgument, remove => {
                log.Add("legacy-remove");
                Require(remove && legacyCalls++ == 0 && sources.Count == 2 && sources.All(source => source.Removals == 0),
                    "connected sources are prepared before one singleton-held legacy validation/removal");
                return Task.FromResult(outcome);
            }) == (outcome == LegacyExplorerPreviewCleanupResult.NoKnownReceipt ? 12 : 0) && legacyCalls == 1 && sources.All(source => source.Removals == 1 && source.Disposals == 1) &&
                log.IndexOf("legacy-remove") < log.IndexOf("remove-Client") && log.Last() == "owner-dispose",
                "explicit uninstall handles one exact legacy operation then drains captured connected sources");
        }
        log.Clear(); sources.Clear();
        var recoveryCalls = 0;
        var recoveredUninstall = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument],
            () => new Owner(log, thread), Prepare, _ => Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt),
            interactiveRecovery: _ => {
                Require(sources.Count == 2 && sources.All(source => source.Removals == 0),
                    "missing legacy receipt is recovered before any connected root is detached");
                recoveryCalls++;
                return Task.FromResult(LegacyExplorerPreviewCleanupResult.Removed);
            });
        Require(recoveredUninstall == 0 && recoveryCalls == 1 && sources.All(source => source.Removals == 1 && source.Disposals == 1),
            "confirmed exact legacy recovery lets uninstall remove both captured connections");
        log.Clear(); sources.Clear(); recoveryCalls = 0;
        var postponedUninstall = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument],
            () => new Owner(log, thread), Prepare, _ => Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt),
            interactiveRecovery: _ => { recoveryCalls++; return Task.FromResult(LegacyExplorerPreviewCleanupResult.Postponed); });
        Require(postponedUninstall == 20 && recoveryCalls == 1 && sources.All(source => source.Removals == 0 && source.Disposals == 1),
            "declining missing-receipt recovery leaves every connection attached and stops uninstall");
        log.Clear(); sources.Clear(); recoveryCalls = 0;
        var unresolvedUninstall = await InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument],
            () => new Owner(log, thread), Prepare, _ => Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt),
            interactiveRecovery: _ => { recoveryCalls++; return Task.FromResult(LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview); });
        Require(unresolvedUninstall == 20 && recoveryCalls == 1 && sources.All(source => source.Removals == 0 && source.Disposals == 1),
            "uncertain missing-receipt recovery leaves every connection attached and stops uninstall");
        foreach (var refusal in new[] { LegacyExplorerPreviewCleanupResult.Busy, LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview,
            LegacyExplorerPreviewCleanupResult.Postponed, LegacyExplorerPreviewCleanupResult.RecordedProfile }) {
            log.Clear(); sources.Clear();
            var calls = 0;
            Require(await Execute(InstallerMaintenance.RemoveArgument, _ => { calls++; return Task.FromResult(refusal); }) ==
                (refusal == LegacyExplorerPreviewCleanupResult.Busy ? 10 : 20) && calls == 1 &&
                sources.All(source => source.Removals == 0 && source.Disposals == 1),
                "legacy refusal never begins connected cleanup or retries legacy removal");
        }
        foreach (var failure in new[] { "remove", "dispose" }) {
            log.Clear(); sources.Clear();
            var code = await Execute(InstallerMaintenance.RemoveArgument, _ => {
                if (failure == "remove") sources[1].FailRemove = true;
                else sources[1].FailDispose = true;
                return Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt);
            });
            Require(code == 20 && sources.All(source => source.Disposals == 1),
                "missing preview receipt never masks connected cleanup or disposal failure");
        }
        log.Clear(); sources.Clear();
        Require(await Execute(InstallerMaintenance.RemoveArgument, _ => {
            sources[1].FailRemove = true;
            return Task.FromResult(LegacyExplorerPreviewCleanupResult.Removed);
        }) == 20 && sources.All(source => source.Removals == 1 && source.Disposals == 1),
            "a later connected failure retains non-success after confirmed legacy removal for an idempotent retry");
        log.Clear(); sources.Clear();
        Require(await Execute(InstallerMaintenance.RemoveArgument, _ => {
            sources[0].FailDispose = true;
            return Task.FromResult(LegacyExplorerPreviewCleanupResult.Busy);
        }) == 20, "session drain failure cannot be hidden by the normal legacy-busy exit code");
    }

    private static void InstallerStartupGate()
    {
        var observed = 0;
        bool Active(string name) { observed++; Require(name == @"Local\LedgeTopFilesPilotInstaller", "installer object name differs from reviewed NSIS protocol"); return true; }
        Require(InstallerActivity.BlocksStartup((true, ReleaseChannel.Pilot), [], Active) && observed == 1,
            "new packaged pilot blocks normal startup while installer activity exists");
        Require(!InstallerActivity.BlocksStartup((true, ReleaseChannel.Pilot), [], _ => false), "definite installer absence allows normal startup");
        Require(InstallerActivity.BlocksStartup((true, ReleaseChannel.Pilot), [], _ => throw new UnauthorizedAccessException()) &&
            InstallerActivity.BlocksStartup((true, ReleaseChannel.Pilot), [], _ => throw new IOException()),
            "unknown or unreadable installer activity blocks provider startup");
        foreach (var compiled in new (bool Packaged, ReleaseChannel? Channel)[] { (false, null), (true, null), (true, ReleaseChannel.Stable) })
            Require(!InstallerActivity.BlocksStartup(compiled, [], _ => throw new InvalidOperationException("Other channels must not query pilot installer state.")),
                "developer/stable/unknown builds never query the pilot object");
        foreach (var command in new[] { InstallerMaintenance.CheckArgument, InstallerMaintenance.RemoveArgument, "--installer-unknown" })
            Require(!InstallerActivity.BlocksStartup((true, ReleaseChannel.Pilot), [command], _ => throw new InvalidOperationException()),
                "installer maintenance bypasses the startup gate so its own child can perform checks/cleanup or silent command refusal");

        // Exercise handle lifetime using a unique test-only object, never the actual installer activity object.
        var unique = @"Local\LedgeTopFilesInstallerGateTests-" + Guid.NewGuid().ToString("N");
        Require(!InstallerActivity.Exists(unique), "unique test object starts absent");
        using (var owner = new Mutex(false, unique)) {
            Require(InstallerActivity.Exists(unique) && InstallerActivity.Exists(unique), "observer sees live installer handle without acquiring or closing its owner");
        }
        Require(!InstallerActivity.Exists(unique), "activity ends only when its final owner handle closes");
    }

    private static void UntrackedRootObservations()
    {
        var parent = Path.Combine(Path.GetTempPath(), "ltfiles-maintenance-observe-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(parent);
        try {
            var root = Path.Combine(parent, "Saved files");
            var expected = new[] { root, root + " (2)", root + " (9999)" };
            foreach (var candidate in expected.Concat(new[] { root + " (1)", root + " (02)", root + " (10000)", root + " unrelated" }))
                Directory.CreateDirectory(candidate);
            var retained = Path.Combine(root, "notes.txt"); File.WriteAllText(retained, "keep local bytes");
            var calls = new List<string>();
            InstallerMaintenance.RefuseUntrackedRootAliases(root, candidate => { calls.Add(candidate); return unchecked((int)0x80070186); });
            Require(calls.Order().SequenceEqual(expected.Order()) && File.ReadAllText(retained) == "keep local bytes",
                "only canonical known root generations are observed; exact native absence permits ordinary retained folders unchanged");
            foreach (var status in new[] { 0, 390, 1, unchecked((int)0x80070005), unchecked((int)0x80004001), unchecked((int)0x80070185), unchecked((int)0x80070187) }) {
                var refused = false;
                try { InstallerMaintenance.RefuseUntrackedRootAliases(root, _ => status); } catch (IOException) { refused = true; }
                Require(refused, "registered root with any context, raw Win32 code, neighboring/unknown HRESULT cannot prove native absence");
            }
            foreach (var unknownCandidate in expected) {
                calls.Clear(); var refused = false;
                try {
                    InstallerMaintenance.RefuseUntrackedRootAliases(root, candidate => {
                        calls.Add(candidate);
                        return candidate == unknownCandidate ? unchecked((int)0x80004001) : unchecked((int)0x80070186);
                    });
                } catch (IOException) { refused = true; }
                Require(refused && calls.Contains(unknownCandidate) && calls.All(expected.Contains) &&
                    expected.All(Directory.Exists) && File.ReadAllText(retained) == "keep local bytes",
                    "one unavailable canonical generation refuses the whole observation even when other generations report exact absence");
            }
            foreach (var error in new Exception[] { new IOException("Native leaf/ancestor alias refused."), new UnauthorizedAccessException("Native observation unavailable.") }) {
                var refused = false;
                try { InstallerMaintenance.RefuseUntrackedRootAliases(root, _ => throw error); }
                catch (Exception caught) when (ReferenceEquals(caught, error)) { refused = true; }
                Require(refused, "native alias validation/access errors propagate as maintenance refusal without adopting or unregistering");
            }
            Require(File.ReadAllText(retained) == "keep local bytes", "all observations preserve retained content");
            // Synthetic acceptance must not call the default native inspector: a hosted runner can
            // legitimately lack Cloud Files support. Production must continue refusing that unknown
            // state; only the injected exact absence status above proves the success branch here.
        } finally {
            var full = Path.GetFullPath(parent);
            if (!full.StartsWith(Path.GetFullPath(Path.GetTempPath()) + "ltfiles-maintenance-observe-", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Refusing unexpected maintenance test cleanup path.");
            Directory.Delete(full, true);
        }
    }

    private static void Require(bool value, string message) { if (!value) throw new InvalidOperationException(message); }
    private sealed class Owner(List<string> log, int thread) : IDisposable
    {
        internal int Disposals;
        public void Dispose() { Require(Environment.CurrentManagedThreadId == thread, "singleton released on wrong thread"); Disposals++; log.Add("owner-dispose"); }
    }
    private sealed class FakeSession(List<string> log, string name) : IExplorerPreviewSession
    {
        internal int Removals, Disposals;
        internal bool Unconfirmed, FailRemove, FailDispose;
        internal Task? Gate;
        public string RootPath => "unused-fake-root";
        public ExplorerPreviewState State { get; set; }
        public IReadOnlyList<string> Activity => [];
        public event EventHandler? Changed { add { } remove { } }
        public Task StartAsync() => throw new InvalidOperationException("Maintenance cannot start/authenticate.");
        public Task PauseAsync() => throw new InvalidOperationException();
        public Task ResumeAsync() => throw new InvalidOperationException();
        public async Task RemoveAsync() {
            Removals++; log.Add("remove-" + name); if (Gate is not null) await Gate;
            if (FailRemove) throw new IOException("Synthetic refusal.");
            if (!Unconfirmed) State = ExplorerPreviewState.Removed;
        }
        public ValueTask DisposeAsync() { Disposals++; log.Add("dispose-" + name); if (FailDispose) throw new IOException("Synthetic drain refusal."); return ValueTask.CompletedTask; }
    }
}
