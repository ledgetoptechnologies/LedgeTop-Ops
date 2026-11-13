using LedgeTop.Files;

internal static class RecoveryWaitTests
{
    internal static async Task Run()
    {
        {
            var registryWeak = CreateRegistryFixture();
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            if (!registryWeak.IsAlive) throw new IOException("Process hold registry failed to retain ownership.");
        }
        {
            var release = new TaskCompletionSource();
            var (weak, held) = CreateHeldFixture(release.Task);
            GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
            if (!weak.IsAlive || held.IsCompleted) throw new IOException("Uncertain session was not retained while waiting.");
            release.SetResult(); await held;
        }
        foreach (var phase in new[] { "discovery", "absence" }) {
            var operation = new TaskCompletionSource<int>(); var delay = new TaskCompletionSource();
            int shown = 0, closed = 0;
            var waiting = RecoveryWait.WaitAsync(operation.Task, delay.Task, () => { shown++; return new Notice(() => closed++); });
            delay.SetResult(); await Task.Yield();
            if (shown != 1 || closed != 0 || waiting.IsCompleted) throw new IOException(phase + " lost supervision on timeout.");
            operation.SetResult(42);
            if (await waiting != 42 || closed != 1) throw new IOException(phase + " notice outlived the operation.");
        }
        {
            var delay = new TaskCompletionSource(); var shown = 0;
            var result = await RecoveryWait.WaitAsync(Task.FromResult(7), delay.Task, () => { shown++; return new Notice(() => { }); });
            delay.SetResult(); if (result != 7 || shown != 0) throw new IOException("Completed operation showed a stale notice.");
        }
        {
            var operation = new TaskCompletionSource<int>(); var delay = new TaskCompletionSource();
            var waiting = RecoveryWait.WaitAsync(operation.Task, delay.Task, () => throw new IOException("Notice unavailable."));
            delay.SetResult(); await Task.Yield(); if (waiting.IsCompleted) throw new IOException("Notice failure abandoned operation.");
            operation.SetResult(9); if (await waiting != 9) throw new IOException("Notice failure lost the actual result.");
        }
        {
            var operation = new TaskCompletionSource<int>(); var delay = new TaskCompletionSource(); int closed = 0;
            var waiting = RecoveryWait.WaitAsync(operation.Task, delay.Task, () => { operation.SetResult(11); return new Notice(() => closed++); });
            delay.SetResult();
            if (await waiting != 11 || closed != 1) throw new IOException("Completion during notice creation left a stale notice.");
        }
        {
            var operation = new TaskCompletionSource<int>(); var delay = new TaskCompletionSource(); int closed = 0;
            var waiting = RecoveryWait.WaitAsync(operation.Task, delay.Task, () => new Notice(() => closed++));
            delay.SetResult(); await Task.Yield(); operation.SetException(new IOException("Synthetic observation failed."));
            try { await waiting; throw new Exception("Missing operation failure."); } catch(IOException) { }
            if (closed != 1) throw new IOException("Failure left its notice open.");
        }
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static WeakReference CreateRegistryFixture()
    {
        var owner = new object(); var weak = new WeakReference(owner);
        _ = RecoveryWait.Retain(owner); // Drop the caller and token; only the static registry roots the object.
        return weak;
    }
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static (WeakReference Weak, Task Held) CreateHeldFixture(Task release)
    {
        var owner = new object();
        return (new WeakReference(owner), LegacyExplorerPreviewCleanup.HoldLifetimeAsync(owner, release));
    }
    private sealed class Notice(Action close) : IDisposable { public void Dispose() => close(); }
}
