using System.Collections.Concurrent;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;
internal static class LargeCatalogPrototype
{
    internal static async Task<int> RunAsync()
    {
        if (GetCapacity() != 5000) throw new Exception("Prototype flag required.");
        await SaturationAndRetry();
        Console.WriteLine("PASS generated 5000 path saturation and fresh intent retry; fake delegates, no native/network."); return 0;
    }
    private static async Task SaturationAndRetry()
    {
        const int count = 5000;
        var paths = Enumerable.Range(0, count).Select(i => "p" + i).ToArray();
        var results = new ConcurrentDictionary<string, AvailabilityIntent>(StringComparer.Ordinal);
        var errors = new ConcurrentQueue<Exception>();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var fourRunning = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstScan = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allDone = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var started = 0; var visits = 0; var targetFree = 0; var admitted = 0; var deferred = 0;
        Action? notify = null;
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        AvailabilityObservation Inspect(string path) => new(path == "p4999" && Volatile.Read(ref targetFree) == 1 ? AvailabilityIntent.Free : AvailabilityIntent.Keep, !results.ContainsKey(path));
        var workers = new BoundedAvailabilityWorkers(paths, Inspect, async (path, intent, token) => {
            if (Interlocked.Increment(ref started) <= 4) {
                if (Volatile.Read(ref started) == 4) fourRunning.TrySetResult();
                await release.Task.WaitAsync(token);
            }
            if (!results.TryAdd(path, intent)) throw new IOException("A path executed more than once.");
            if (results.Count == count) allDone.TrySetResult();
        }, errors.Enqueue);
        await using var scanner = new AvailabilityScanWake((changedAction, _) => { notify = changedAction; return new NullWatcher(); });
        var scanning = scanner.RunScannerAsync(paths, path => {
            if (workers.Observe(path, Inspect(path))) Interlocked.Increment(ref admitted); else Interlocked.Increment(ref deferred);
            if (Interlocked.Increment(ref visits) == count) firstScan.TrySetResult();
        }, cancel.Token);
        try {
            await firstScan.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await fourRunning.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (results.Count != 0 || Volatile.Read(ref started) != 4 || admitted < 1000 || deferred < 3996) throw new IOException("Initial saturation did not hold four workers and defer the tail.");
            Volatile.Write(ref targetFree, 1); // p4999 cannot have entered a 1000-slot queue with four held workers.
            release.TrySetResult();
            for (var n = 0; n < 100 && !allDone.Task.IsCompleted; n++) {
                notify!();
                await Task.WhenAny(allDone.Task, Task.Delay(150, cancel.Token));
            }
            await allDone.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (results.Count != count || results["p4999"] != AvailabilityIntent.Free || !errors.IsEmpty)
                throw new IOException("Not every path completed once with the latest observed intent.");
        } finally {
            release.TrySetResult(); cancel.Cancel();
            await scanning.WaitAsync(TimeSpan.FromSeconds(10));
            await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask).WaitAsync(TimeSpan.FromSeconds(10));
        }
    }
    private static int GetCapacity() => CatalogCapacity.MaximumEntries;
    private sealed class NullWatcher : IDisposable { public void Dispose() { } }
}
