using LedgeTop.Files;
using LedgeTop.Files.Explorer;

internal static class LegacyExplorerPreviewCleanupTests
{
    internal static async Task Run()
    {
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        Require(await Run(true,cancelled.Token,
            () => throw new Exception(), () => throw new Exception(), () => throw new Exception()) == LegacyExplorerPreviewCleanupResult.Postponed);
        Require(await Run(true,default,() => null,
            () => throw new Exception(), () => throw new Exception()) == LegacyExplorerPreviewCleanupResult.Busy);
        var log = new List<string>();
        Require(await Run(true,default,() => new Owner(log),() => false,
            () => throw new Exception()) == LegacyExplorerPreviewCleanupResult.NoKnownReceipt && log.SequenceEqual(["release"]));
        foreach (var state in new[] { ExplorerPreviewState.Failed, ExplorerPreviewState.Removed, ExplorerPreviewState.Running, ExplorerPreviewState.Paused }) {
            log.Clear(); var invalid = new Session(log) { State = state };
            Require(await Run(true,default,() => new Owner(log),() => true,() => invalid)
                == LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview && invalid.Removals == 0 && invalid.Disposals == 1 && log.Last() == "release");
        }
        log.Clear(); var check = new Session(log);
        Require(await Run(false,default,() => new Owner(log),() => true,() => check)
            == LegacyExplorerPreviewCleanupResult.RecordedProfile && check.Removals == 0 && check.Disposals == 1);
        var failedCheckDisposal = new Session(log) { Failure = "dispose" };
        Require(await Run(false,default,() => new Owner(log),() => true,() => failedCheckDisposal)
            == LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview && failedCheckDisposal.Removals == 0);
        log.Clear(); var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var removing = new Session(log) { Gate = gate.Task };
        var operation = Run(true,default,() => new Owner(log),() => true,() => removing);
        Require(!operation.IsCompleted && !log.Contains("release") && removing.Removals == 1);
        gate.SetResult(); Require(await operation == LegacyExplorerPreviewCleanupResult.Removed && log.SequenceEqual(["remove","dispose","release"]));
        foreach (var failure in new[] { "remove", "unconfirmed", "dispose" }) {
            log.Clear(); var session = new Session(log) { Failure = failure };
            Require(await Run(true,default,() => new Owner(log),() => true,() => session)
                == LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview && session.Removals == 1 && session.Disposals == 1 && log.Last() == "release");
        }
        using var beforeRemove = new CancellationTokenSource(); var pending = new Session(log);
        Require(await Run(true,beforeRemove.Token,() => new Owner(log),() => true,
            () => { beforeRemove.Cancel(); return pending; }) == LegacyExplorerPreviewCleanupResult.Postponed && pending.Removals == 0 && pending.Disposals == 1);
        foreach (int disappearsAt in new[] { 2, 3 }) {
            int reads = 0; var disappeared = new Session(log);
            Require(await Run(true,default,() => new Owner(log),() => ++reads < disappearsAt,() => disappeared)
                == LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview && disappeared.Removals == (disappearsAt == 2 ? 0 : 1) && disappeared.Disposals == 1);
        }
        var retained = new Session(log); int verified = 0;
        Require(await Run(true,default,() => new Owner(log),() => true,() => retained,_ => throw new Exception()) == LegacyExplorerPreviewCleanupResult.Removed);
        Require(await Run(true,default,() => new Owner(log),() => true,() => retained,_ => { verified++; return true; })
            == LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified && retained.Removals == 1 && verified == 1);
        foreach (var failure in new[] { "foreign-reappearance", "native-unknown", "namespace-present", "missing-root", "changed-file-id", "throw" }) {
            var removed = new Session(log) { State = ExplorerPreviewState.Removed };
            Require(await Run(true,default,() => new Owner(log),() => true,() => removed,
                _ => failure == "throw" ? throw new IOException() : false) == LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview && removed.Removals == 0 && removed.Disposals == 1);
        }
        Require(await LegacyExplorerPreviewCleanup.RunAsync(true,default,() => new Owner(log),
            () => LegacyExplorerPreviewReceiptState.Unknown,() => throw new Exception(),_ => throw new Exception()) == LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview);
        foreach (var remove in new[] { false, true }) {
            var missingReads = 0;
            Require(await LegacyExplorerPreviewCleanup.RunDefaultAsync(remove, default, () => new Owner(log),
                () => { missingReads++; return LegacyExplorerPreviewReceiptState.Missing; },
                () => throw new Exception("Missing receipt must not construct a session."), _ => throw new Exception())
                == LegacyExplorerPreviewCleanupResult.NoKnownReceipt && missingReads == 1);
        }
        int recoveryAttempts = 0, recoveredReceiptReads = 0;
        var recovered = new Session(log);
        var recoveredResult = await LegacyExplorerPreviewCleanup.RunAsync(true, default, () => new Owner(log),
            () => ++recoveredReceiptReads == 1 ? LegacyExplorerPreviewReceiptState.Missing : LegacyExplorerPreviewReceiptState.Present,
            () => recovered, _ => false, () => { recoveryAttempts++; return true; });
        Require(recoveredResult == LegacyExplorerPreviewCleanupResult.Removed && recoveryAttempts == 1 &&
            recoveredReceiptReads >= 4 && recovered.Removals == 1);
        recoveryAttempts = 0;
        Require(await LegacyExplorerPreviewCleanup.RunAsync(true, default, () => new Owner(log),
            () => LegacyExplorerPreviewReceiptState.Missing, () => throw new Exception(), _ => false,
            () => { recoveryAttempts++; return false; }) == LegacyExplorerPreviewCleanupResult.NoKnownReceipt && recoveryAttempts == 1);
        using (var current = System.Security.Principal.WindowsIdentity.GetCurrent())
        {
            var sid = current.User!.Value;
            var identity = Guid.NewGuid();
            var id = NativeRootRegistration.ProviderName + "!" + sid + "!" + identity.ToString("N");
            var context = System.Text.Encoding.UTF8.GetBytes("LedgeTop.Files.ExplorerPreview/1:" + identity.ToString("N"));
            Require(LegacyExplorerPreviewCleanup.TryMatchLegacyGeneratedIdentity(id, sid, ExplorerRootDisplayName.Legacy,
                ExplorerBrandIcon.LegacyResource, context, out var matched) && matched == identity);
            Require(!LegacyExplorerPreviewCleanup.TryMatchLegacyGeneratedIdentity(id, "S-1-5-18", ExplorerRootDisplayName.Legacy,
                ExplorerBrandIcon.LegacyResource, context, out _));
            Require(!LegacyExplorerPreviewCleanup.TryMatchLegacyGeneratedIdentity(id, sid, "Other provider",
                ExplorerBrandIcon.LegacyResource, context, out _));
            Require(!LegacyExplorerPreviewCleanup.TryMatchLegacyGeneratedIdentity(id, sid, ExplorerRootDisplayName.Legacy,
                ExplorerBrandIcon.LegacyResource, [.. context, 0], out _));
            Require(!LegacyExplorerPreviewCleanup.TryMatchLegacyGeneratedIdentity(id, sid, ExplorerRootDisplayName.Legacy,
                "C:\\untrusted.ico,0", context, out _));
        }
        var tempBase = Path.GetFullPath(Path.GetTempPath());
        Require(Path.Combine(LegacyExplorerPreviewCleanup.ProfileDirectory, "profile.json") == LegacyExplorerPreviewCleanup.ProfilePath &&
            Path.GetFileName(LegacyExplorerPreviewCleanup.ProfileDirectory) == "v2");
        var observedDirectory = "";
        Require(LegacyExplorerPreviewCleanup.WriteRecoveredProfile("synthetic-root", Guid.Empty, "icon", 1, Guid.Empty,
            (directory, _, _, _, _, _) => { observedDirectory = directory; return true; }) &&
            Path.Combine(observedDirectory, "profile.json") == LegacyExplorerPreviewCleanup.ProfilePath &&
            observedDirectory != LegacyExplorerPreviewCleanup.ProfilePath);
        var rejectProfile = Path.Combine(tempBase, "lt-recovery-reject-" + Guid.NewGuid().ToString("N"));
        var unrelatedRoot = Path.Combine(tempBase, "LedgeTop Files Preview (10000)");
        Require(!OwnedExplorerRootSession.WriteRecoveredGeneratedProfile(rejectProfile, unrelatedRoot, Guid.NewGuid(),
            ExplorerBrandIcon.LegacyResource, 1, Guid.NewGuid()) && !Directory.Exists(rejectProfile));
        string path = Path.Combine(Path.GetPathRoot(Path.GetFullPath("."))!,"synthetic-profile","profile.json");
        Require(LegacyExplorerPreviewCleanup.ProbeReceipt(path,p => p == path ? FileAttributes.Normal : FileAttributes.Directory) == LegacyExplorerPreviewReceiptState.Present);
        foreach (var bad in new[] { FileAttributes.Directory, FileAttributes.ReparsePoint })
            Require(LegacyExplorerPreviewCleanup.ProbeReceipt(path,p => p == path ? bad : FileAttributes.Directory) == LegacyExplorerPreviewReceiptState.Unknown);
        Require(LegacyExplorerPreviewCleanup.ProbeReceipt(path,_ => throw new UnauthorizedAccessException()) == LegacyExplorerPreviewReceiptState.Unknown);
        Require(LegacyExplorerPreviewCleanup.ProbeReceipt(path,_ => throw new IOException()) == LegacyExplorerPreviewReceiptState.Unknown);
        Require(LegacyExplorerPreviewCleanup.ProbeReceipt(path,_ => throw new FileNotFoundException()) == LegacyExplorerPreviewReceiptState.Missing);
        Require(LegacyExplorerPreviewCleanup.ProbeReceipt(path,_ => throw new DirectoryNotFoundException()) == LegacyExplorerPreviewReceiptState.Missing);
        Require(LegacyExplorerPreviewCleanup.ProbeReceipt(path,_ => FileAttributes.Directory | FileAttributes.ReparsePoint) == LegacyExplorerPreviewReceiptState.Unknown);
    }
    static Task<LegacyExplorerPreviewCleanupResult> Run(bool remove,CancellationToken token,Func<IDisposable?> owner,
        Func<bool> receipt,Func<IExplorerPreviewSession> prepare,Func<IExplorerPreviewSession,bool>? verify = null) =>
        LegacyExplorerPreviewCleanup.RunAsync(remove,token,owner,
            () => receipt() ? LegacyExplorerPreviewReceiptState.Present : LegacyExplorerPreviewReceiptState.Missing,
            prepare,verify ?? (_ => false));
    static void Require(bool condition) { if (!condition) throw new Exception("Legacy cleanup synthetic contract failed."); }
    sealed class Owner(List<string> log) : IDisposable { public void Dispose() => log.Add("release"); }
    sealed class Session(List<string> log) : IExplorerPreviewSession
    {
        public ExplorerPreviewState State { get; set; } = ExplorerPreviewState.NotStarted;
        public string RootPath => "unused-synthetic";
        public IReadOnlyList<string> Activity => [];
        public event EventHandler? Changed { add { } remove { } }
        internal int Removals, Disposals;
        internal string Failure = "";
        internal Task? Gate;
        public Task StartAsync() => throw new Exception("Start forbidden");
        public Task PauseAsync() => throw new Exception("Pause forbidden");
        public Task ResumeAsync() => throw new Exception("Resume forbidden");
        public async Task RemoveAsync() { log.Add("remove"); Removals++; if (Gate is not null) await Gate; if (Failure == "remove") throw new Exception(); if (Failure != "unconfirmed") State = ExplorerPreviewState.Removed; }
        public ValueTask DisposeAsync() { log.Add("dispose"); Disposals++; if (Failure == "dispose") throw new Exception(); return ValueTask.CompletedTask; }
    }
}
