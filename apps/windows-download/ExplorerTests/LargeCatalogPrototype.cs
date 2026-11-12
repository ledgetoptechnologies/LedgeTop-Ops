using System.Collections.Concurrent;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;
internal static class LargeCatalogPrototype
{
    internal static async Task<int> RunAsync()
    {
        if (CatalogCapacity.MaximumEntries != 5000) throw new Exception("Prototype flag required.");
        await SaturationAndRetry();
        await ScannerFailureStillDrains();
        Console.WriteLine("PASS generated 5000 path saturation, fresh intent retry and failed-scanner drain; fake delegates, no native/network."); return 0;
    }
    private static async Task Close(BoundedAvailabilityWorkers workers, AvailabilityScanWake? scanner, Task? scanning, CancellationTokenSource cancel, TaskCompletionSource release)
    {
        var failures = new List<Exception>();
        release.TrySetResult(); cancel.Cancel();
        try {
            if (scanning is not null) await scanning.WaitAsync(TimeSpan.FromSeconds(10));
        } catch (Exception error) { failures.Add(error); }
        try {
            await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask).WaitAsync(TimeSpan.FromSeconds(10));
        } catch (Exception error) { failures.Add(error); }
        finally {
            if (scanner is not null) {
                try { await scanner.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10)); }
                catch (Exception error) { failures.Add(error); }
            }
        }
        if (failures.Count != 0) throw new AggregateException("Scanner or worker cleanup failed.", failures);
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
        AvailabilityScanWake? scanner = null; Task? scanning = null; Exception? primary = null;
        try {
            scanner = new AvailabilityScanWake((changedAction, _) => { notify = changedAction; return new NullWatcher(); });
            scanning = scanner.RunScannerAsync(paths, path => {
                if (workers.Observe(path, Inspect(path))) Interlocked.Increment(ref admitted); else Interlocked.Increment(ref deferred);
                if (Interlocked.Increment(ref visits) == count) firstScan.TrySetResult();
            }, cancel.Token);
            await firstScan.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await fourRunning.Task.WaitAsync(TimeSpan.FromSeconds(10));
            if (results.Count != 0 || Volatile.Read(ref started) != 4 || admitted < 1000 || deferred < 3996) throw new IOException("Initial saturation did not hold four workers and defer the tail.");
            Volatile.Write(ref targetFree, 1);
            release.TrySetResult();
            for (var n = 0; n < 100 && !allDone.Task.IsCompleted; n++) {
                notify!(); await Task.WhenAny(allDone.Task, Task.Delay(150, cancel.Token));
            }
            await allDone.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (results.Count != count || results["p4999"] != AvailabilityIntent.Free)
                throw new IOException("Not every path completed once with the latest observed intent.");
        } catch (Exception error) { primary = error; }
        try { await Close(workers, scanner, scanning, cancel, release); }
        catch (Exception cleanup) { throw primary is null ? cleanup : new AggregateException(primary, cleanup); }
        if (primary is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(primary).Throw();
        if (!errors.IsEmpty) throw new IOException("Availability worker reported errors after drain.");
    }
    private static async Task ScannerFailureStillDrains()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var errors = new ConcurrentQueue<Exception>();
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var workers = new BoundedAvailabilityWorkers(["p"], _ => new(AvailabilityIntent.Keep, true), async (_, _, token) => {
            entered.TrySetResult(); await release.Task.WaitAsync(token);
        }, errors.Enqueue);
        AvailabilityScanWake? scanner = null; Task? scanning = null; bool sawFailure = false;
        try {
            scanner = new AvailabilityScanWake((_, _) => new NullWatcher());
            scanning = scanner.RunScannerAsync(["p"], path => {
                workers.Observe(path, new(AvailabilityIntent.Keep, true));
                throw new IOException("deliberate scanner failure");
            }, cancel.Token);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        } finally {
            try { await Close(workers, scanner, scanning, cancel, release); }
            catch (AggregateException error) when (error.InnerExceptions.Any(e => e is IOException { Message: "deliberate scanner failure" })) { sawFailure = true; }
        }
        if (!sawFailure || !errors.IsEmpty) throw new IOException("Failed scanner did not drain cleanly.");
        if (workers.Observe("p", new(AvailabilityIntent.Keep, true))) throw new IOException("Worker still accepts work after drain.");
    }
    private sealed class NullWatcher : IDisposable { public void Dispose() { } }
}
