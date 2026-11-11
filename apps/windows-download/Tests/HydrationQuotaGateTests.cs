using LedgeTop.WindowsDownload;

internal static class HydrationQuotaGateTests
{
    private sealed class SharingError : IOException { internal SharingError() : base("synthetic sharing error") { HResult = unchecked((int)0x80070020); } }
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("quota monitor wait times out and cancels without releasing another owner", Waiters),
        ("quota monitor executes once and preserves reentrant use", Reentrant),
        ("committed cleanup ignores cancellation while normal mutation refuses", CleanupCancellation),
        ("quota file sharing retry preserves deadline cancellation and single action", FileSharing)
    ];

    private static async Task Waiters()
    {
        var gate = new object(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var owner = Task.Run(() => { lock (gate) { entered.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("Test owner was not released."); } });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var mutations = 0;
        var observedWait = TimeSpan.Zero; var observedHeld = TimeSpan.Zero;
        try {
            var timeout = await Task.Run(() => {
                try { HydrationQuotaGate.Run(gate, () => Interlocked.Increment(ref mutations), wait: TimeSpan.FromMilliseconds(120), observe: (waited, held) => { observedWait = waited; observedHeld = held; }); return false; }
                catch (TransferException error) { return error.Reason == TransferFailureReason.LocalCacheBusy; }
            }).WaitAsync(TimeSpan.FromSeconds(5));
            if (!timeout || mutations != 0 || owner.IsCompleted || observedWait < TimeSpan.FromMilliseconds(100) || observedHeld != TimeSpan.Zero)
                throw new IOException("Quota timeout changed owner, ran mutation or omitted its wait measurement.");
            var display = HydrationFailureDiagnostic.FromException(HydrationStage.CachePreparation,
                new TransferException("busy", TransferFailureReason.LocalCacheBusy)).ActivityText;
            if (!display.Contains("local file cache is busy", StringComparison.Ordinal) || !display.Contains("LocalCacheBusy", StringComparison.Ordinal))
                throw new IOException("Quota timeout did not produce a local-cache Activity message.");

            using var cancel = new CancellationTokenSource();
            var cancellationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var waiter = Task.Run(() => {
                cancellationStarted.TrySetResult();
                try { HydrationQuotaGate.Run(gate, () => Interlocked.Increment(ref mutations), cancel.Token); return false; }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { return true; }
            });
            await cancellationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel();
            if (!await waiter.WaitAsync(TimeSpan.FromSeconds(5)) || mutations != 0 || owner.IsCompleted)
                throw new IOException("Quota cancellation changed owner or ran mutation.");
        } finally { release.Set(); }
        await owner.WaitAsync(TimeSpan.FromSeconds(5));
        HydrationQuotaGate.Run(gate, () => mutations++);
        if (mutations != 1) throw new IOException("Quota did not recover after the owner exited.");
    }

    private static Task Reentrant()
    {
        var gate = new object(); var calls = 0;
        HydrationQuotaGate.Run(gate, () => HydrationQuotaGate.Run(gate, () => calls++));
        if (calls != 1) throw new IOException("Reentrant quota operation did not complete exactly once.");
        return Task.CompletedTask;
    }
    private static Task CleanupCancellation()
    {
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        var calls = 0; var passedToken = new CancellationToken(true);
        using (HydrationMutationScope.Begin((action, token) => { passedToken = token; token.ThrowIfCancellationRequested(); action(); }, cancellation.Token)) {
            var rejected = false;
            try { HydrationMutationScope.Run(() => calls++, cancellation.Token); } catch (OperationCanceledException) { rejected = true; }
            if (!rejected || calls != 0) throw new IOException("Cancelled mutation was not refused.");
            HydrationMutationScope.Run(() => calls++, cancellation.Token, committedCleanup: true);
            if (calls != 1 || passedToken.CanBeCanceled) throw new IOException("Committed cleanup incorrectly inherited cancellation.");
        }
        return Task.CompletedTask;
    }
    private static async Task FileSharing()
    {
        if (!OperatingSystem.IsWindows()) return;
        var path = Path.Combine(Path.GetTempPath(), "lt-quota-test-" + Guid.NewGuid().ToString("N"));
        var gate = new object(); int opens = 0, calls = 0, checkedRoots = 0;
        FileStream Open() { Interlocked.Increment(ref opens); return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        try {
            using (var held = Open()) {
                opens = 0;
                var waiter = Task.Run(() => HydrationQuotaGate.RunWithFileLock(gate, Open, () => Interlocked.Increment(ref calls), wait: TimeSpan.FromSeconds(2), validate: () => Interlocked.Increment(ref checkedRoots)));
                var until = System.Diagnostics.Stopwatch.StartNew();
                while (Volatile.Read(ref opens) < 2 && until.Elapsed < TimeSpan.FromSeconds(1)) await Task.Delay(10);
                if (opens < 2 || calls != 0 || !Monitor.TryEnter(gate, TimeSpan.FromMilliseconds(200))) throw new IOException("Sharing wait did not release monitor.");
                Monitor.Exit(gate);
                held.Dispose(); await waiter.WaitAsync(TimeSpan.FromSeconds(3));
                if (calls != 1 || checkedRoots != opens) throw new IOException("Action count or repeated root validation differed.");
            }
            using (var held = Open()) {
                calls = 0; using var cancel = new CancellationTokenSource(100);
                try { await Task.Run(() => HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, cancel.Token, TimeSpan.FromSeconds(2))); throw new IOException("Cancellation ignored."); }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { }
                if (calls != 0) throw new IOException("Cancelled action executed.");
                var capped = System.Diagnostics.Stopwatch.StartNew();
                try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, wait: TimeSpan.FromSeconds(3)); throw new IOException("File retry cap was ignored."); }
                catch (TransferException e) when (e.Reason == TransferFailureReason.LocalCacheBusy) { }
                if (capped.Elapsed < TimeSpan.FromMilliseconds(350) || capped.Elapsed > TimeSpan.FromSeconds(2) || calls != 0) throw new IOException("File retry was not bounded independently of the monitor deadline.");
                try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, wait: TimeSpan.FromMilliseconds(120)); throw new IOException("Contention did not time out."); }
                catch (TransferException e) when (e.Reason == TransferFailureReason.LocalCacheBusy) { }
            }
            opens = 0; calls = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => { calls++; throw new IOException("action failure"); }); throw new IOException("Action failure swallowed."); }
            catch (IOException e) when (e.Message == "action failure") { }
            if (opens != 1 || calls != 1) throw new IOException("Action was retried.");
            opens = 0; calls = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => { calls++; throw new SharingError(); }); throw new IOException("Action failure swallowed."); }
            catch (SharingError) { }
            if (opens != 1 || calls != 1) throw new IOException("Sharing-shaped action failure was retried.");
            opens = 0; var validations = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++, validate: () => { validations++; throw new SharingError(); }); throw new IOException("Validation failure swallowed."); }
            catch (SharingError) { }
            if (opens != 0 || validations != 1) throw new IOException("Validation failure was retried.");
            opens = 0;
            try { HydrationQuotaGate.RunWithFileLock(gate, () => { opens++; throw new UnauthorizedAccessException(); }, () => calls++); throw new IOException("Open failure swallowed."); }
            catch (UnauthorizedAccessException) { }
            if (opens != 1) throw new IOException("Non-sharing open failure retried.");
            lock (gate) { try { HydrationQuotaGate.RunWithFileLock(gate, Open, () => calls++); throw new IOException("Reentrant acquisition accepted."); } catch (InvalidOperationException) { } }
        } finally { if (File.Exists(path)) File.Delete(path); }
    }
}
