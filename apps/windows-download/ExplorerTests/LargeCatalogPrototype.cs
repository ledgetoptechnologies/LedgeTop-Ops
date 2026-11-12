using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;
internal static class LargeCatalogPrototype
{
    internal static async Task<int> RunAsync()
    {
        if (GetCapacity() != 5000) throw new Exception("Prototype flag required.");
        var paths = Enumerable.Range(0, 5000).Select(i => "p" + i).ToArray();
        var workers = new BoundedAvailabilityWorkers(paths, _ => new(AvailabilityIntent.None, false),
            (_, _, _) => Task.CompletedTask, _ => { });
        try {
            var visits = 0; using var stop = new CancellationTokenSource();
            await using var scanner = new AvailabilityScanWake((_, _) => new NullWatcher());
            await scanner.RunScannerAsync(paths, path => {
                workers.Observe(path, new(AvailabilityIntent.None, false));
                if (++visits == 5000) stop.Cancel();
            }, stop.Token);
            if (visits != 5000) throw new Exception("Not all generated paths scanned.");
            try { workers.AddKnownPaths(["extra"]); throw new Exception("Oversize addition accepted."); }
            catch (ArgumentException) { }
        } finally { await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask); }
        Console.WriteLine("PASS generated 5000 path worker and scanner, excess rejected; no native/network."); return 0;
    }
    private static int GetCapacity() => CatalogCapacity.MaximumEntries;
    private sealed class NullWatcher : IDisposable { public void Dispose() { } }
}
