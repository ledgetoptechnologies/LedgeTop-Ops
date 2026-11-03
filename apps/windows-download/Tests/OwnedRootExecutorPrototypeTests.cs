internal static class OwnedRootExecutorPrototypeTests
{
    private sealed class FakeLease : IDisposable {
        internal int Releases;
        public void Dispose() { if (Interlocked.Increment(ref Releases) != 1) throw new InvalidOperationException("Lease released twice."); }
    }
    private static async Task Expect<T>(Task task) where T : Exception
    {
        try { await task; } catch (T) { return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name);
    }
    internal static async Task RunAsync()
    {
        var registry = new OwnedRootExecutorPrototype.Registry(2, 2);
        var executor = registry.Create(); var secondExecutor = registry.Create();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var disposed = 0; var queuedStarted = 0; var lease = new FakeLease();
        var counter = new OwnedRootExecutorPrototype.SyntheticCounter(); bool? lateCommit = null;
        var first = executor.RunAsync(@"C:\synthetic\A", async scope => {
            try { started.SetResult(); await release.Task; lateCommit = scope.TryCommit(counter); }
            finally { lease.Dispose(); Interlocked.Increment(ref disposed); finished.SetResult(); }
            return lease.Releases == 1;
        }, TimeSpan.FromSeconds(1));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var cancel = new CancellationTokenSource();
        var cancelled = executor.RunAsync(@"C:\synthetic\A", _ => { Interlocked.Increment(ref queuedStarted); return Task.FromResult(true); }, TimeSpan.FromSeconds(5), cancel.Token);
        cancel.Cancel(); await Expect<OperationCanceledException>(cancelled);
        var rejected = secondExecutor.RunAsync(@"c:\synthetic\Other\..\a\", _ => { Interlocked.Increment(ref queuedStarted); return Task.FromResult(true); }, TimeSpan.FromSeconds(5));
        var alsoRejected = executor.RunAsync(@"C:\synthetic\A", _ => { Interlocked.Increment(ref queuedStarted); return Task.FromResult(true); }, TimeSpan.FromSeconds(5));
        await Expect<InvalidOperationException>(secondExecutor.RunAsync(@"c:\synthetic\a", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        var secondStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = executor.RunAsync(@"C:\synthetic\B", async _ => { secondStarted.SetResult(); await secondRelease.Task; return true; }, TimeSpan.FromSeconds(5));
        await secondStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Expect<InvalidOperationException>(executor.RunAsync(@"C:\synthetic\C", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        secondRelease.SetResult(); await second;
        await Expect<TimeoutException>(first);
        await Expect<InvalidOperationException>(rejected);
        await Expect<InvalidOperationException>(alsoRejected);
        await Expect<InvalidOperationException>(executor.RunAsync(@"C:\synthetic\A", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        if (disposed != 0 || queuedStarted != 0) throw new InvalidOperationException("Timed-out owner or cancelled work escaped quarantine.");
        release.SetResult(); await finished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // The delegate's cleanup may finish just before executor retirement.
        for (var i = 0; ; i++) {
            try { await executor.RunAsync(@"C:\synthetic\A", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)); break; }
            catch (InvalidOperationException) when (i < 100) { await Task.Delay(5); }
        }
        if (disposed != 1 || lease.Releases != 1 || queuedStarted != 0 || lateCommit != false || counter.Value != 0)
            throw new InvalidOperationException("Late work escaped terminal fencing or lease cleanup was not exact.");
        await Expect<TimeoutException>(first); // Late successful cleanup cannot revise the caller's terminal result.
        OwnedRootExecutorPrototype.SyntheticCommitScope? retiredScope = null;
        await executor.RunAsync(@"C:\synthetic\A", scope => { retiredScope = scope; if (!scope.TryCommit(counter)) throw new IOException("Active commit rejected."); return Task.FromResult(true); }, TimeSpan.FromSeconds(5));
        if (retiredScope is null || retiredScope.TryCommit(counter) || counter.Value != 1) throw new InvalidOperationException("Retired work committed.");
        await Expect<ArgumentException>(executor.RunAsync(@"\\server\share", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        await Expect<ArgumentException>(executor.RunAsync("relative", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        var ordered = new List<int>();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var x = executor.RunAsync(@"C:\synthetic\A", async _ => { ordered.Add(1); entered.SetResult(); await gate.Task; return true; }, TimeSpan.FromSeconds(5));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var y = executor.RunAsync(@"C:\synthetic\A", _ => { ordered.Add(2); return Task.FromResult(true); }, TimeSpan.FromSeconds(5));
        gate.SetResult(); await Task.WhenAll(x, y);
        if (!ordered.SequenceEqual(new[] { 1, 2 })) throw new InvalidOperationException("Root work did not remain serialized.");
        var cancelledStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelledRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelledFinished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var runningCancel = new CancellationTokenSource();
        var running = executor.RunAsync(@"C:\synthetic\A", async _ => {
            try { cancelledStarted.SetResult(); await cancelledRelease.Task; throw new IOException("late synthetic failure"); }
            finally { Interlocked.Increment(ref disposed); cancelledFinished.SetResult(); }
        }, TimeSpan.FromSeconds(5), runningCancel.Token);
        await cancelledStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        runningCancel.Cancel(); await Expect<OperationCanceledException>(running);
        await Expect<InvalidOperationException>(executor.RunAsync(@"C:\synthetic\A", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        if (disposed != 1) throw new InvalidOperationException("Cancellation released the running owner early.");
        cancelledRelease.SetResult(); await cancelledFinished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Expect<InvalidOperationException>(executor.RunAsync(@"C:\synthetic\A", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        if (disposed != 2) throw new InvalidOperationException("Late failure did not finish cleanup exactly once.");
        var bounds = new OwnedRootExecutorPrototype.Registry(1, 1).Create();
        var invalidRan = false;
        await Expect<ArgumentOutOfRangeException>(bounds.RunAsync(@"C:\synthetic\C", _ => { invalidRan = true; return Task.FromResult(true); }, TimeSpan.FromDays(365)));
        await bounds.RunAsync(@"C:\synthetic\D", _ => Task.FromResult(true), TimeSpan.FromSeconds(5));
        if (invalidRan) throw new InvalidOperationException("Invalid timeout admitted work.");
        var uncertain = new OwnedRootExecutorPrototype.Registry(1, 2).Create();
        var uncertainStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var uncertainRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var uncertainItem = uncertain.RunAsync(@"C:\synthetic\X", async _ => { uncertainStarted.SetResult(); await uncertainRelease.Task; return false; }, TimeSpan.FromSeconds(5));
        await uncertainStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var uncertainQueued = uncertain.RunAsync(@"C:\synthetic\X", _ => Task.FromResult(true), TimeSpan.FromSeconds(5));
        uncertainRelease.SetResult();
        await Expect<InvalidOperationException>(uncertainItem);
        await Expect<InvalidOperationException>(uncertainQueued);
        await Expect<InvalidOperationException>(uncertain.RunAsync(@"C:\synthetic\X", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        await Expect<InvalidOperationException>(uncertain.RunAsync(@"C:\synthetic\Y", _ => Task.FromResult(true), TimeSpan.FromSeconds(5)));
        Console.WriteLine("PASS test-only executor: cancellation, quarantine, unrelated root and late cleanup.");
    }
}
