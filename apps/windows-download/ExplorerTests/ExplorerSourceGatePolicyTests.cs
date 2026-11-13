using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class ExplorerSourceGatePolicyTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly DownloadSpec Spec = new("synthetic", new Uri("https://source.example.invalid/file"), "test.txt", 0, "\"v1\"", new string('a', 64));
    internal static async Task<int> RunAsync()
    {
        var source = new Source();
        using var gate = new ExplorerSourceGate(source, new("pilot", source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), Principal));
        Require(gate.IsPaused);
        await Throws<DownloadsPausedException>(() => gate.GetSessionAsync());
        await Throws<DownloadsPausedException>(() => gate.ResolveAsync("synthetic"));
        await Throws<DownloadsPausedException>(() => gate.DownloadAsync(Spec, "never-used"));
        Require(source.Calls == 0);
        using (var cancelled = new CancellationTokenSource()) {
            cancelled.Cancel();
            await Throws<OperationCanceledException>(() => gate.GetSessionAsync(cancelled.Token));
            Require(source.Calls == 0);
        }
        await gate.ResumeAsync();
        Require(!gate.IsPaused);
        source.SourceAlias="other"; await Denial(() => gate.ResolveAsync("synthetic"),AccessDenialReason.SourceConfiguration); source.SourceAlias="employee";
        source.ResolvedPrincipal="different"; await Denial(() => gate.ResolveAsync("synthetic"),AccessDenialReason.PrincipalMismatch); source.ResolvedPrincipal=Principal;
        Require(source.Calls == 2);
        _ = await gate.GetSessionAsync(); _ = await gate.ResolveAsync("synthetic"); _ = await gate.DownloadAsync(Spec, "never-used");
        Require(source.Calls == 5);
        source.LoginRequired = true;
        await Throws<LoginRequiredException>(() => gate.GetSessionAsync());
        source.LoginRequired = false;
        source.Expiry = DateTimeOffset.UtcNow.AddSeconds(-1);
        await Throws<LoginRequiredException>(() => gate.GetSessionAsync());
        gate.Pause();
        Require(gate.IsPaused);
        await Throws<LoginRequiredException>(() => gate.ResumeAsync()); // Actual expired session remains authentication failure.
        Require(gate.IsPaused);
        var transient = new TransferException("synthetic", TransferFailureReason.Network);
        var denied = new AccessDeniedException();
        Require(OwnedExplorerRootSession.CanRetainPausedResume(transient, gate.IsPaused));
        Require(!OwnedExplorerRootSession.CanRetainPausedResume(denied, gate.IsPaused));
        Require(!OwnedExplorerRootSession.CanRetainPausedResume(transient, false));
        source.LoginRequired = false; source.Failure = transient;
        await Throws<TransferException>(() => gate.ResumeAsync());
        Require(gate.IsPaused && OwnedExplorerRootSession.CanRetainPausedResume(transient, gate.IsPaused));
        source.Failure = null;
        var calls = source.Calls;
        await Throws<DownloadsPausedException>(() => gate.GetSessionAsync()); Require(source.Calls == calls);
        source.Expiry = DateTimeOffset.UtcNow.AddHours(1); await gate.ResumeAsync();
        source.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var inFlight = gate.GetSessionAsync(); gate.Pause();
        source.Pending.SetResult(new(Principal, source.Expiry));
        await Throws<OperationCanceledException>(() => inFlight); // Old epoch stays cancelled even if source ignores cancellation.
        source.Pending = null; await gate.ResumeAsync(); _ = await gate.GetSessionAsync();
        gate.Pause();
        var ready = false; var connected = 0; var drains = 0; var clears = 0; var failDrain = false;
        Task RunFenced(Func<Task> connect, CancellationToken token = default) =>
            OwnedExplorerRootSession.ConnectFencedReadyAsync(gate, () => ready, connect, () => {
                drains++; return failDrain ? Task.FromException(new IOException("Synthetic drain failure")) : Task.CompletedTask;
            }, () => clears++, token);
        await Throws<IOException>(() => RunFenced(() => { connected++; return Task.CompletedTask; }));
        Require(connected == 0 && drains == 1 && clears == 1 && gate.IsPaused);
        ready = true;
        await RunFenced(async () => {
            connected++;
            await Throws<DownloadsPausedException>(() => gate.ResolveAsync("synthetic"));
        });
        Require(connected == 1 && drains == 1 && clears == 1 && gate.IsPaused);
        await Throws<IOException>(() => RunFenced(() => {
            connected++; ready = false; return Task.CompletedTask;
        }));
        Require(connected == 2 && drains == 2 && clears == 2 && gate.IsPaused);
        ready = true;
        await Throws<IOException>(() => RunFenced(() => throw new IOException("Synthetic partial connect")));
        Require(drains == 3 && clears == 3 && gate.IsPaused);
        source.LoginRequired = false;
        await Throws<LoginRequiredException>(() => RunFenced(() => { source.LoginRequired = true; return Task.CompletedTask; }));
        Require(drains == 4 && clears == 4 && gate.IsPaused); // Post-connect cached auth is checked again.
        source.LoginRequired = false;
        failDrain = true;
        await Throws<AggregateException>(() => RunFenced(() => throw new IOException("Synthetic partial connect")));
        Require(drains == 5 && clears == 4 && gate.IsPaused); // Failed drain keeps attempt ownership.
        failDrain = false;
        using (var cancelled = new CancellationTokenSource()) {
            cancelled.Cancel();
            await Throws<OperationCanceledException>(() => RunFenced(() => { connected++; return Task.CompletedTask; }, cancelled.Token));
            Require(connected == 2 && drains == 6 && clears == 5 && gate.IsPaused);
        }
        using (var cancelled = new CancellationTokenSource()) {
            var connecting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var attempt = RunFenced(() => {
                entered.SetResult(); return connecting.Task;
            }, cancelled.Token);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            cancelled.Cancel();
            Require(!attempt.IsCompleted && gate.IsPaused); // Never abandon the native boundary.
            connecting.SetResult();
            await Throws<OperationCanceledException>(() => attempt);
            Require(drains == 7 && clears == 6 && gate.IsPaused);
        }
        var fencedSource = new Source();
        using (var fenced = new ExplorerSourceGate(fencedSource, new("pilot", fencedSource.Alias, fencedSource.Origin.GetLeftPart(UriPartial.Authority), Principal)))
        using (var owner = new CancellationTokenSource()) {
            fenced.CommitFenced(() => true, owner.Token);
            fencedSource.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var outstanding = fenced.GetSessionAsync();
            owner.Cancel(); fencedSource.Pending.SetResult(new(Principal, fencedSource.Expiry));
            await Throws<DownloadsPausedException>(() => outstanding);
            await Throws<DownloadsPausedException>(() => fenced.ResolveAsync("synthetic"));
            await Throws<IOException>(() => fenced.ResumeAsync());
            Require(fenced.IsPaused);
        }
        var cancelledSource = new Source();
        using (var fenced = new ExplorerSourceGate(cancelledSource, new("pilot", cancelledSource.Alias, cancelledSource.Origin.GetLeftPart(UriPartial.Authority), Principal)))
        using (var owner = new CancellationTokenSource()) {
            try { fenced.CommitFenced(() => { owner.Cancel(); return true; }, owner.Token); throw new IOException("Canceled commit succeeded"); }
            catch (OperationCanceledException) { }
            Require(fenced.IsPaused);
            await Throws<DownloadsPausedException>(() => fenced.GetSessionAsync());
        }
        foreach (var allow in new[] { true, false }) {
            var racingSource = new Source();
            using var fenced = new ExplorerSourceGate(racingSource, new("pilot", racingSource.Alias, racingSource.Origin.GetLeftPart(UriPartial.Authority), Principal));
            using var owner = new CancellationTokenSource();
            using var releaseProof = new ManualResetEventSlim(false);
            var enteredProof = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var attemptedRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var commit = Task.Run(() => fenced.CommitFenced(() => {
                enteredProof.TrySetResult();
                if (!releaseProof.Wait(TimeSpan.FromSeconds(3))) throw new TimeoutException("Synthetic proof timeout.");
                return allow;
            }, owner.Token));
            try {
                await enteredProof.Task.WaitAsync(TimeSpan.FromSeconds(3));
                var read = Task.Run(async () => { attemptedRead.TrySetResult(); return await fenced.GetSessionAsync(); });
                await attemptedRead.Task.WaitAsync(TimeSpan.FromSeconds(3));
                Require(!read.IsCompleted && racingSource.Calls == 0); // Callback cannot pass the proof boundary.
                releaseProof.Set();
                if (allow) { await commit; _ = await read; Require(racingSource.Calls == 1); }
                else { await Throws<IOException>(() => commit); await Throws<DownloadsPausedException>(() => read); Require(racingSource.Calls == 0); }
            } finally { releaseProof.Set(); try { await commit; } catch { } }
        }
        var operationSource = new Source();
        using (var fenced = new ExplorerSourceGate(operationSource, new("pilot", operationSource.Alias, operationSource.Origin.GetLeftPart(UriPartial.Authority), Principal)))
        using (var owner = new CancellationTokenSource())
        using (var operation = new CancellationTokenSource()) {
            fenced.CommitFenced(() => true, owner.Token, operation.Token); operation.Cancel();
            _ = await fenced.GetSessionAsync(); // Completed operation cancellation is not owner shutdown.
        }
        var canceledOperationSource = new Source();
        using (var fenced = new ExplorerSourceGate(canceledOperationSource, new("pilot", canceledOperationSource.Alias, canceledOperationSource.Origin.GetLeftPart(UriPartial.Authority), Principal)))
        using (var owner = new CancellationTokenSource())
        using (var operation = new CancellationTokenSource()) {
            try { fenced.CommitFenced(() => { operation.Cancel(); return true; }, owner.Token, operation.Token); throw new IOException("Canceled operation committed"); }
            catch (OperationCanceledException) { }
            await Throws<DownloadsPausedException>(() => fenced.GetSessionAsync()); Require(canceledOperationSource.Calls == 0);
        }
        Console.WriteLine("PASS paused gate makes zero underlying calls; resume permits reads; real login/expiry and epoch/caller cancellation stay distinct. No helper/network/native/provider calls.");
        return 0;
    }
    private static async Task Throws<T>(Func<Task> run) where T : Exception
    {
        try { await run(); } catch (T) { return; }
        throw new IOException("Expected source-gate outcome was not observed.");
    }
    private static void Require(bool value) { if (!value) throw new IOException("Source-gate policy failed."); }
    private static async Task Denial(Func<Task> action, AccessDenialReason reason) { try { await action(); } catch (AccessDeniedException e) when (e.Reason==reason) { return; } throw new IOException("Expected denial reason missing."); }
    private sealed class Source : IQueuedDownloadSource
    {
        public string Alias => SourceAlias;
        internal string SourceAlias = "employee", ResolvedPrincipal = Principal;
        public Uri Origin => new("https://source.example.invalid");
        internal int Calls;
        internal bool LoginRequired;
        internal Exception? Failure;
        internal DateTimeOffset Expiry = DateTimeOffset.UtcNow.AddHours(1);
        internal TaskCompletionSource<QueuedDownloadSession>? Pending;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            if (Failure is { } failure) throw failure;
            if (LoginRequired) throw new LoginRequiredException();
            return Pending?.Task ?? Task.FromResult(new QueuedDownloadSession(Principal, Expiry));
        }
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default)
        { Calls++; return Task.FromResult(new ResolvedQueuedDownload(ResolvedPrincipal, "synthetic", "v1", Spec)); }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
        { Calls++; return Task.FromResult("synthetic-no-file"); }
    }
}
