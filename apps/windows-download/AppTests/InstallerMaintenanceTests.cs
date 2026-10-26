using LedgeTop.Files;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;

internal static class InstallerMaintenanceTests
{
    internal static async Task Run()
    {
        InstallerStartupGate();
        UntrackedRootObservations();
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

        log.Clear(); owner = new Owner(log, thread); sources.Clear();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var removing = InstallerMaintenance.RunAsync((true, ReleaseChannel.Pilot), [InstallerMaintenance.RemoveArgument], () => owner, mode => {
            log.Add("prepare-" + mode); var session = new FakeSession(log, mode.ToString()) { Gate = mode == AccessMode.Client ? gate.Task : null };
            sources.Add(session); return session;
        });
        Require(!removing.IsCompleted && owner.Disposals == 0 && sources.Count == 2 && log.IndexOf("prepare-Employee") < log.IndexOf("remove-Client"),
            "both ownership reads finish before cleanup and singleton remains held during async removal");
        gate.SetResult();
        Require(await removing == 0 && sources.All(source => source.State == ExplorerPreviewState.Removed && source.Disposals == 1) && owner.Disposals == 1,
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
