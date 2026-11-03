internal static class OwnedRootExecutorPrototypeTests
{
    private static async Task Expect<T>(Task task) where T : Exception
    {
        try { await task; } catch (T) { return; }
        throw new InvalidOperationException("Expected " + typeof(T).Name);
    }
    internal static async Task RunAsync()
    {
        var executor = new OwnedRootExecutorPrototype(2, 2);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var disposed = 0; var queuedStarted = 0;
        var first = executor.RunAsync("A", async () => {
            try { started.SetResult(); await release.Task; }
            finally { Interlocked.Increment(ref disposed); finished.SetResult(); }
        }, TimeSpan.FromSeconds(1));
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var cancel = new CancellationTokenSource();
        var cancelled = executor.RunAsync("A", () => { Interlocked.Increment(ref queuedStarted); return Task.CompletedTask; }, TimeSpan.FromSeconds(5), cancel.Token);
        cancel.Cancel(); await Expect<OperationCanceledException>(cancelled);
        var rejected = executor.RunAsync("A", () => { Interlocked.Increment(ref queuedStarted); return Task.CompletedTask; }, TimeSpan.FromSeconds(5));
        var alsoRejected = executor.RunAsync("A", () => { Interlocked.Increment(ref queuedStarted); return Task.CompletedTask; }, TimeSpan.FromSeconds(5));
        await Expect<InvalidOperationException>(executor.RunAsync("A", () => Task.CompletedTask, TimeSpan.FromSeconds(5)));
        var secondStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var secondRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = executor.RunAsync("B", async () => { secondStarted.SetResult(); await secondRelease.Task; }, TimeSpan.FromSeconds(5));
        await secondStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await Expect<InvalidOperationException>(executor.RunAsync("C", () => Task.CompletedTask, TimeSpan.FromSeconds(5)));
        secondRelease.SetResult(); await second;
        await Expect<TimeoutException>(first);
        await Expect<InvalidOperationException>(rejected);
        await Expect<InvalidOperationException>(alsoRejected);
        await Expect<InvalidOperationException>(executor.RunAsync("A", () => Task.CompletedTask, TimeSpan.FromSeconds(5)));
        if (disposed != 0 || queuedStarted != 0) throw new InvalidOperationException("Timed-out owner or cancelled work escaped quarantine.");
        release.SetResult(); await finished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // The delegate's cleanup may finish just before executor retirement.
        for (var i = 0; ; i++) {
            try { await executor.RunAsync("A", () => Task.CompletedTask, TimeSpan.FromSeconds(5)); break; }
            catch (InvalidOperationException) when (i < 100) { await Task.Delay(5); }
        }
        if (disposed != 1 || queuedStarted != 0) throw new InvalidOperationException("Owned resource cleanup was not exactly once.");
        var ordered = new List<int>();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var x = executor.RunAsync("A", async () => { ordered.Add(1); entered.SetResult(); await gate.Task; }, TimeSpan.FromSeconds(5));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var y = executor.RunAsync("A", () => { ordered.Add(2); return Task.CompletedTask; }, TimeSpan.FromSeconds(5));
        gate.SetResult(); await Task.WhenAll(x, y);
        if (!ordered.SequenceEqual(new[] { 1, 2 })) throw new InvalidOperationException("Root work did not remain serialized.");
        var cancelledStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelledRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelledFinished = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var runningCancel = new CancellationTokenSource();
        var running = executor.RunAsync("A", async () => {
            try { cancelledStarted.SetResult(); await cancelledRelease.Task; throw new IOException("late synthetic failure"); }
            finally { Interlocked.Increment(ref disposed); cancelledFinished.SetResult(); }
        }, TimeSpan.FromSeconds(5), runningCancel.Token);
        await cancelledStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        runningCancel.Cancel(); await Expect<OperationCanceledException>(running);
        await Expect<InvalidOperationException>(executor.RunAsync("A", () => Task.CompletedTask, TimeSpan.FromSeconds(5)));
        if (disposed != 1) throw new InvalidOperationException("Cancellation released the running owner early.");
        cancelledRelease.SetResult(); await cancelledFinished.Task.WaitAsync(TimeSpan.FromSeconds(5));
        for (var i = 0; ; i++) {
            try { await executor.RunAsync("A", () => Task.CompletedTask, TimeSpan.FromSeconds(5)); break; }
            catch (InvalidOperationException) when (i < 100) { await Task.Delay(5); }
        }
        if (disposed != 2) throw new InvalidOperationException("Late failure did not finish cleanup exactly once.");
        Console.WriteLine("PASS test-only executor: cancellation, quarantine, unrelated root and late cleanup.");
    }
}
