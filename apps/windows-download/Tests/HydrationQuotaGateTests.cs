using LedgeTop.WindowsDownload;

internal static class HydrationQuotaGateTests
{
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("quota monitor wait times out and cancels without releasing another owner", Waiters),
        ("quota monitor executes once and preserves reentrant use", Reentrant),
        ("committed cleanup ignores cancellation while normal mutation refuses", CleanupCancellation)
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
}
