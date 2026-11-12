using System.Reflection;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class ScannerReporterIntegrationTests
{
    internal static async Task<int> RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "LedgeTop-ScannerReporter-" + Guid.NewGuid().ToString("N"));
        var cache = Path.Combine(root, "cache"); Directory.CreateDirectory(cache);
        var file = Path.Combine(root, "README.txt");
        using var source = new ExplorerDemoSource(signedIn:false, chunkDelay:TimeSpan.Zero);
        var entry = source.Entries.Single(x => x.RelativePath == "README.txt");
        var manifest = new Dictionary<string,PlaceholderIdentity> { ["README.txt"] = entry.Identity };
        Action? pulse = null;
        var wake = new AvailabilityScanWake((changed, _) => { pulse = changed; return new FakeNotifications(); });
        var notices = new System.Collections.Concurrent.ConcurrentQueue<string>();
        await using var provider = new NativePlaceholderProvider(new FakeRegistration(root), cache, source, source.Channel, source.PrincipalId, manifest);
        provider.Activity += notices.Enqueue;
        var type = typeof(NativePlaceholderProvider);
        type.GetField("scanWake", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(provider, wake);
        var loop = (Task)type.GetMethod("PinLoopAsync", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(provider, null)!;
        var waitingField = typeof(AvailabilityScanWake).GetField("waiting", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var sync = typeof(AvailabilityScanWake).GetField("sync", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(wake)!;
        Task? CurrentWait() { lock(sync) return (Task?)waitingField.GetValue(wake); }
        async Task AdvanceScan()
        {
            await Until(() => CurrentWait() is { IsCompleted: false });
            Task? previous;
            lock (sync) { previous = (Task?)waitingField.GetValue(wake); if (previous is null || previous.IsCompleted) throw new IOException("Scanner wait changed before pulse"); pulse!(); }
            await Until(() => CurrentWait() is { IsCompleted: false } next && !ReferenceEquals(next, previous));
        }
        try {
            await Until(() => notices.Count == 1);
            await AdvanceScan(); await AdvanceScan();
            if (notices.Count != 1) throw new IOException("repeated completed scan emitted a second notice");
            await File.WriteAllTextAsync(file, "synthetic");
            // Two completed generations ensure at least one full scan began after the file change,
            // even if the first captured waiter was already completing at the change boundary.
            await AdvanceScan(); await AdvanceScan();
            File.Delete(file);
            await AdvanceScan(); await AdvanceScan();
            await Until(() => notices.Count == 2);
            if (notices.Any(n => !n.Contains("availability/Inspect/LocalIO") || n.Contains(root) || n.Contains("README"))) throw new IOException("notice was not sanitized");
        } finally {
            var loopJoined = false; var providerDisposed = false;
            try { wake.Stop(); await loop.WaitAsync(TimeSpan.FromSeconds(8)); loopJoined = true; }
            finally {
                try { await provider.DisposeAsync(); providerDisposed = true; }
                finally {
                    if (loopJoined && providerDisposed) {
                        if (File.Exists(file)) File.Delete(file);
                        Directory.Delete(cache); Directory.Delete(root);
                    }
                }
            }
        }
        Console.WriteLine("PASS synthetic provider scanner failure, recovery, new episode and sanitized activity; no native connection."); return 0;
    }
    private static async Task Until(Func<bool> condition) { using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8)); while (!condition()) await Task.Delay(25, deadline.Token); }
    private sealed class FakeNotifications : IDisposable { public void Dispose() {} }
    private sealed class FakeRegistration(string root) : IPreviewRootRegistration { public string Root => root; public void VerifyOwned() {} public void Unregister() => throw new InvalidOperationException(); }
}





