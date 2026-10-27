using LedgeTop.Files.Updates;
using LedgeTop.WindowsDownload;

internal static class ExeUpdateHandoffTests
{
    // Pure in-memory seams: no file, credential, process, native, browser or network operation.
    internal static async Task Run()
    {
        var success = new Fixture();
        var accepted = await success.Owner.ApplyAsync(default);
        Require(accepted == new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.ParentExitRequested, true), "only parent exit is requested, never installed success");
        Require(string.Join(',', success.Log) == "lease,fresh,record,drain,verify,launch,ready,exit", "handoff order");
        Require(success.Owner.HoldsRecoveryFences && success.Lease.Disposals == 0 && success.Boundary.Disposals == 0, "accepted exit retains ownership and byte fences");
        var count = success.Log.Count;
        Require(await success.Owner.ApplyAsync(default) == accepted && success.Log.Count == count, "accepted exit cannot launch twice");

        foreach (var state in new[] { WindowsAppReleaseStatus.NoRelease, WindowsAppReleaseStatus.Current }) {
            var f = new Fixture { PreparedStatus = state };
            Require((await f.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.NoUpdate && string.Join(',', f.Log) == "lease,fresh,release", "no offer never drains");
        }
        var busy = new Fixture { Busy = true };
        Require((await busy.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.Busy && busy.Log.SequenceEqual(["lease"]), "external maintenance excludes staging");
        foreach (var fault in new[] { "fresh", "record", "drain", "verify", "launch", "ready" }) {
            var f = new Fixture { Fault = fault };
            var result = await f.Owner.ApplyAsync(default);
            Require(!f.Log.Contains("exit") && !f.Owner.HoldsRecoveryFences && f.Lease.Disposals == 1, "failed step cannot exit and releases confirmed-safe ownership: " + fault);
            Require(result.Status == (fault is "fresh" or "record" ? ExeUpdateHandoffStatus.PreparationFailed :
                fault == "drain" ? ExeUpdateHandoffStatus.DrainFailed : fault == "verify" ? ExeUpdateHandoffStatus.BoundaryRejected : ExeUpdateHandoffStatus.HelperUnavailable), "typed failure: " + fault);
            Require(f.Log.Contains("recover") == (fault is not ("fresh" or "record")), "only a started drain needs recovery");
            if (fault == "ready") Require(f.Log.IndexOf("disarm") < f.Log.IndexOf("recover"), "confirm helper disarm before restoring provider");
        }
        foreach (var mutation in new Func<ExeUpdateCandidate, ExeUpdateCandidate>[] {
            c => c with { InstalledOwner = c.InstalledOwner with { Owner = "unowned" } }, c => c with { Channel = "unknown" },
            c => c with { CurrentVersion = "0.5.2" }, c => c with { InstallerPath = @"\\server\share\update.exe" },
            c => c with { Origin = new Uri("http://synthetic.invalid/") }, c => c with { ApiBase = "/other" },
            c => c with { Parent = new(0, 1) }, c => c with { Release = c.Release with { Version = "0.5.1.0" } },
            c => c with { Release = c.Release with { Sha256 = "wrong" } }, c => c with { Release = c.Release with { SizeBytes = (1L << 30) + 1 } },
            c => c with { Release = c.Release with { StrongETag = "W/\"weak\"" } }
        }) {
            var f = new Fixture(); f.Candidate = mutation(f.Candidate);
            Require((await f.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.PreparationFailed && !f.Log.Contains("record"), "malformed or nonforward candidate cannot be persisted");
        }
        foreach (var changed in new[] { "identity", "artifact", "parent" }) {
            var f = new Fixture { ChangedAtBoundary = changed };
            Require((await f.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.BoundaryRejected && !f.Log.Contains("launch") && f.Log.Contains("recover"), "changed/revoked boundary fails closed: " + changed);
        }
        var changedBeforeLaunch = new Fixture { ChangedBeforeLaunch = true };
        Require((await changedBeforeLaunch.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.HelperUnavailable &&
            !changedBeforeLaunch.Log.Contains("ready") && !changedBeforeLaunch.Log.Contains("exit") && changedBeforeLaunch.Log.Contains("recover"),
            "adapter rejects modification after boundary verification before handing bytes to helper");
        // A new attempt must repeat fresh authorization; failed drain cannot reuse an old offer.
        var retry = new Fixture { Fault = "drain" };
        await retry.Owner.ApplyAsync(default); retry.Fault = "fresh";
        Require((await retry.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.PreparationFailed && retry.Log.Count(x => x == "fresh") == 2 && !retry.Log.Contains("launch"), "retry repeats fresh admission after revocation");

        foreach (var step in new[] { "fresh", "record", "verify", "launch", "ready" }) {
            using var cancel = new CancellationTokenSource();
            var f = new Fixture { After = at => { if (at == step) cancel.Cancel(); } };
            Require((await f.Owner.ApplyAsync(cancel.Token)).Status == ExeUpdateHandoffStatus.Postponed && !f.Log.Contains("exit"), "cancellation at safe boundary prevents exit: " + step);
            if (step is "fresh" or "record") Require(!f.Log.Contains("drain"), "pre-drain cancellation preserves active provider");
        }
        using (var cancel = new CancellationTokenSource()) {
            var started = Signal(); var finish = Signal();
            var f = new Fixture { DrainWork = async () => { started.SetResult(); await finish.Task; } };
            var first = f.Owner.ApplyAsync(cancel.Token); await started.Task;
            cancel.Cancel(); Require(!first.IsCompleted, "cancellation joins drain");
            using var waitingCancel = new CancellationTokenSource();
            var queued = f.Owner.ApplyAsync(waitingCancel.Token); waitingCancel.Cancel();
            await Canceled(queued);
            var second = f.Owner.ApplyAsync(default);
            Require(!second.IsCompleted && f.Log.Count(x => x == "lease") == 1, "concurrent update cannot race drain");
            f.DrainWork = null; f.PreparedStatus = WindowsAppReleaseStatus.NoRelease; finish.SetResult();
            Require((await first).Status == ExeUpdateHandoffStatus.Postponed && (await second).Status == ExeUpdateHandoffStatus.NoUpdate && !f.Log.Contains("launch"), "joined cancellation recovers before serialized fresh retry");
        }
        var timeout = new Fixture(TimeSpan.FromMilliseconds(10)) { StallReady = true };
        Require((await timeout.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.HelperUnavailable && timeout.Log.Contains("disarm") && !timeout.Log.Contains("exit"), "readiness deadline disarms and recovers");
        var rejected = new Fixture { ExitDecision = ExeUpdateParentExitDecision.Rejected };
        Require((await rejected.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.ExitRejected && rejected.Log.Contains("recover"), "known exit rejection recovers");
        foreach (var explicitUncertain in new[] { true, false }) {
            var f = new Fixture { ExitDecision = ExeUpdateParentExitDecision.Uncertain, Fault = explicitUncertain ? null : "exit" };
            Require((await f.Owner.ApplyAsync(default)).Status == ExeUpdateHandoffStatus.ExitUncertain && f.Owner.HoldsRecoveryFences && !f.Log.Contains("recover") && !f.Log.Contains("disarm"), "uncertain exit cannot race recovery or another helper");
        }
        foreach (var fault in new[] { "recover", "disarm", "retire", "release" }) {
            var f = new Fixture { Fault = fault, ExitDecision = ExeUpdateParentExitDecision.Rejected };
            var result = await f.Owner.ApplyAsync(default);
            Require(result.Status == (fault == "recover" ? ExeUpdateHandoffStatus.NeedsReconnect : ExeUpdateHandoffStatus.RecoveryBlocked), "recovery faults are explicit: " + fault);
            if (fault == "disarm") Require(!f.Log.Contains("recover") && f.Owner.HoldsRecoveryFences, "uncertain helper cannot race reconnect");
        }
        var reconnect = new Fixture { ExitDecision = ExeUpdateParentExitDecision.Rejected, RecoveryResult = false };
        Require(await reconnect.Owner.ApplyAsync(default) == new ExeUpdateHandoffResult(ExeUpdateHandoffStatus.NeedsReconnect, true), "missing reconnect adapter never claims provider restored");
        Console.WriteLine("EXE handoff synthetic lifecycle passed; no helper/platform adapter or installation executed.");
    }

    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static void Require(bool value, string reason) { if (!value) throw new Exception(reason); }
    private static async Task Canceled(Task<ExeUpdateHandoffResult> task)
    { try { await task; } catch (OperationCanceledException) { return; } throw new Exception("Expected queued cancellation."); }

    private sealed class Fixture : IExeUpdateHandoffPlatform, IExeUpdateHelperReservation
    {
        internal readonly List<string> Log = [];
        internal string? Fault, ChangedAtBoundary;
        internal bool Busy, StallReady, ChangedBeforeLaunch, RecoveryResult = true;
        internal Action<string>? After;
        internal Func<Task>? DrainWork;
        internal WindowsAppReleaseStatus PreparedStatus = WindowsAppReleaseStatus.Available;
        internal ExeUpdateParentExitDecision ExitDecision = ExeUpdateParentExitDecision.Accepted;
        internal ExeUpdateCandidate Candidate = new(new("S-1-5-21-111-222-333-1001", 1, "0.5.2.0", @"C:\synthetic\installed",
            "LedgeTop.Files.UnsignedPilotInstaller/1", new string('c', 64), new string('d', 40), new string('e', 64), new string('f', 64)), "pilot",
            new Uri("https://synthetic.invalid/"), "/api/app", "0.5.2.0", new(1234, 123456),
            new("pilot", "0.5.3.0", 100, new string('a', 64), "\"exact-artifact\"", new string('b', 40), "exe"), @"C:\synthetic\update.exe");
        internal readonly FakeLease Lease;
        internal readonly FakeBoundary Boundary;
        internal ExeUpdateHandoffCoordinator Owner { get; }
        private ExeUpdateHandoff? staged;
        internal Fixture(TimeSpan? timeout = null)
        { Lease = new(this); Boundary = new(this); Owner = new(this, timeout); }
        private void Step(string name) { Log.Add(name); if (Fault == name) throw new InvalidOperationException("private adapter details must not escape"); After?.Invoke(name); }
        public Task<IAsyncDisposable?> TryEnterMaintenanceAsync(CancellationToken token)
        { Step("lease"); return Task.FromResult<IAsyncDisposable?>(Busy ? null : Lease); }
        public Task<ExeUpdatePreparation> PrepareFreshAsync(CancellationToken token)
        { Step("fresh"); return Task.FromResult(new ExeUpdatePreparation(PreparedStatus, PreparedStatus == WindowsAppReleaseStatus.Available ? Candidate : null)); }
        public Task StageHandoffAsync(ExeUpdateHandoff handoff, CancellationToken token)
        { Step("record"); Require(handoff.Id != Guid.Empty && handoff.Candidate == Candidate, "record bound to exact fresh candidate"); staged = handoff; return Task.CompletedTask; }
        public async Task DrainAndDisconnectAsync() { Step("drain"); if (DrainWork is { } work) await work(); }
        public Task<IExeUpdateBoundary?> VerifyBoundaryAsync(ExeUpdateCandidate candidate, CancellationToken token)
        {
            Step("verify");
            if (ChangedAtBoundary is "identity" or "artifact") return Task.FromResult<IExeUpdateBoundary?>(null);
            Boundary.Candidate = ChangedAtBoundary == "parent" ? candidate with { Parent = new(9999, 123456) } : candidate;
            return Task.FromResult<IExeUpdateBoundary?>(Boundary);
        }
        public Task<IExeUpdateHelperReservation?> LaunchHelperAsync(ExeUpdateHandoff handoff, IExeUpdateBoundary boundary, CancellationToken token)
        {
            Step("launch"); Require(handoff == staged && boundary.Candidate == handoff.Candidate, "launch binds staged record, exact identity and artifact fence");
            if (ChangedBeforeLaunch) throw new InvalidOperationException("Synthetic execution-boundary artifact modification");
            return Task.FromResult<IExeUpdateHelperReservation?>(this);
        }
        public async Task<bool> WaitReadyAsync(ExeUpdateHandoff handoff, CancellationToken token)
        { Step("ready"); Require(handoff == staged && handoff.Candidate.Parent == Candidate.Parent, "readiness binds candidate and parent start identity"); if (StallReady) await Task.Delay(Timeout.Infinite, token); return true; }
        public Task DisarmAndWaitAsync() { Step("disarm"); return Task.CompletedTask; }
        public Task<ExeUpdateParentExitDecision> RequestParentExitAsync(ExeUpdateHandoff handoff)
        { Step("exit"); Require(handoff == staged, "exit binds exact handoff"); return Task.FromResult(ExitDecision); }
        public Task<bool> RecoverProviderAsync() { Step("recover"); return Task.FromResult(RecoveryResult); }
        public Task RetireHandoffAsync(ExeUpdateHandoff handoff) { Step("retire"); return Task.CompletedTask; }
        internal sealed class FakeLease(Fixture owner) : IAsyncDisposable
        { internal int Disposals; public ValueTask DisposeAsync() { owner.Step("release"); Disposals++; return ValueTask.CompletedTask; } }
        internal sealed class FakeBoundary(Fixture owner) : IExeUpdateBoundary
        {
            internal int Disposals;
            public ExeUpdateCandidate Candidate { get; set; } = owner.Candidate;
            public ValueTask DisposeAsync() { owner.Step("unpin"); Disposals++; return ValueTask.CompletedTask; }
        }
    }
}
