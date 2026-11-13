using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class LiveProviderCatalogTests
{
    internal static async Task<int> RunAsync()
    {
        var catalog = new LiveProviderCatalog<string>(new Dictionary<string, string> { ["old"] = "old-identity" }, []);
        var workers = new BoundedAvailabilityWorkers(["old"], _ => new(AvailabilityIntent.Keep, true),
            (_, _, _) => Task.CompletedTask, _ => { });
        try {
            var old = catalog.Current;
            var current = catalog.Add(0, new Dictionary<string, string> { ["dir\\new"] = "new-identity" }, ["dir"], paths => {
                Need(!catalog.Current.Files.ContainsKey("dir\\new"), "catalog visible before worker admission");
                workers.AddKnownPaths(paths);
                _ = workers.WhenJoinedAsync("dir\\new");
            });
            Need(current.Revision == 1 && current.Files["old"] == "old-identity" && current.Files["dir\\new"] == "new-identity", "additions missing");
            Need(!old.Files.ContainsKey("dir\\new") && !old.ScanPaths.Contains("dir\\new"), "old snapshot changed");
            Need(current.ScanPaths.Contains("dir\\new") && current.Directories.Contains("DIR"), "scanner snapshot missing addition");
            Need(workers.Observe("dir\\new", new(AvailabilityIntent.Keep, true)), "new worker entry unavailable");
            await workers.WhenJoinedAsync("dir\\new").WaitAsync(TimeSpan.FromSeconds(8));
            ExpectFailure(() => catalog.Add(0, new Dictionary<string, string> { ["late"] = "x" }, [], workers.AddKnownPaths));
            ExpectFailure(() => catalog.Add(1, new Dictionary<string, string> { ["OLD"] = "replacement" }, [], workers.AddKnownPaths));
            ExpectFailure(() => catalog.Add(1, new Dictionary<string, string> { ["dir"] = "x" }, [], workers.AddKnownPaths));
            ExpectFailure(() => catalog.Add(1, new Dictionary<string, string> { ["failed"] = "x" }, [], _ => throw new IOException("synthetic admission")));
            Need(ReferenceEquals(current, catalog.Current) && !catalog.Current.Files.ContainsKey("failed"), "failed admission published");
        } finally { await workers.StopAndDrainAsync(() => Task.CompletedTask, () => Task.CompletedTask).WaitAsync(TimeSpan.FromSeconds(8)); }
        ExpectFailure(() => catalog.Add(1, new Dictionary<string, string> { ["stopped"] = "x" }, [], workers.AddKnownPaths));
        Need(!catalog.Current.Files.ContainsKey("stopped"), "shutdown admission published");
        await ConcurrentUpdates();
        await UnconnectedProviderRejectsAdmission();
        await StopWinsBlockedAdmission();
        Console.WriteLine("PASS live catalog worker-first publication and immutable snapshots; synthetic only, no native operations or authority.");
        return 0;
    }
    private static async Task UnconnectedProviderRejectsAdmission()
    {
        var temp = Path.Combine(Path.GetTempPath(), "lt-catalog-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(temp, "root"); var cache = Path.Combine(temp, "cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var provider = new NativePlaceholderProvider(new Registration(root), cache, new Source(), "pilot", "odqp1_" + new string('a', 64),
            new Dictionary<string, PlaceholderIdentity>());
        try { ExpectFailure(() => provider.AdmitVerifiedCatalog(0, new Dictionary<string, PlaceholderIdentity>(), [])); }
        finally { await provider.DisposeAsync(); Directory.Delete(cache); Directory.Delete(root); Directory.Delete(temp); }
    }
    internal static async Task PendingFreshProviderRefusesWork()
    {
        var temp = Path.Combine(Path.GetTempPath(), "lt-fresh-admission-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(temp, "root"); var cache = Path.Combine(temp, "cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var provider = new NativePlaceholderProvider(new Registration(root), cache, new Source(), "pilot", "odqp1_" + new string('a', 64),
            new Dictionary<string, PlaceholderIdentity>());
        provider.ConfigureFreshAdmission();
        try {
            ExpectFailure(() => provider.RetryFailedAvailability());
            ExpectFailure(() => provider.SetFolderAvailabilityIntent("missing", true));
            ExpectFailure(() => provider.KeepOnDevice("missing"));
            ExpectFailure(() => provider.Hydrate("missing"));
            try { await provider.FreeSpaceAsync("missing"); throw new Exception("Expected pending refusal."); }
            catch (IOException) { }
            if (Directory.EnumerateFileSystemEntries(root).Any()) throw new Exception("Pending admission changed root.");
        } finally { await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(8)); Directory.Delete(cache); Directory.Delete(root); Directory.Delete(temp); }
    }
#if DEBUG
    internal static async Task FreshActivationProofCanStop()
    {
        var temp = Path.Combine(Path.GetTempPath(), "lt-fresh-activation-stop-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(temp, "root"); var cache = Path.Combine(temp, "cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var provider = new NativePlaceholderProvider(new Registration(root), cache, new Source(), "pilot", "odqp1_" + new string('a', 64), new Dictionary<string, PlaceholderIdentity>());
        provider.ConfigureFreshAdmission(); var authority = new BlockingAdmissionAuthority();
        typeof(NativePlaceholderProvider).GetField("catalogReady", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(provider, true);
        provider.SyntheticFreshScannerStartForTest = () => { };
        var activation = Task.Run(() => { try { provider.ActivateFreshAdmission(authority); throw new Exception("Stopped activation transferred authority."); } catch (IOException) { } });
        Task? stopping = null;
        try {
            await authority.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            stopping = provider.DisposeAsync().AsTask();
            if (stopping.IsCompleted || authority.Disposed) throw new Exception("Provider finished while caller authority was being verified.");
            ExpectFailure(() => provider.FreshAdmissionForTest.Enter());
            authority.Release.Set(); await activation.WaitAsync(TimeSpan.FromSeconds(5)); await stopping.WaitAsync(TimeSpan.FromSeconds(5));
            if (authority.Disposed) throw new Exception("Failed activation consumed caller authority.");
        } finally {
            authority.Release.Set(); await activation.WaitAsync(TimeSpan.FromSeconds(5));
            if (stopping is not null) await stopping.WaitAsync(TimeSpan.FromSeconds(5));
            authority.Dispose(); authority.Release.Dispose(); Directory.Delete(cache); Directory.Delete(root); Directory.Delete(temp);
        }
    }
    private sealed class BlockingAdmissionAuthority : IProviderWorkAuthority
    {
        internal bool Disposed;
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal readonly ManualResetEventSlim Release = new();
        public void VerifyHeld() { Entered.TrySetResult(); if (!Release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException(); }
        public void Dispose() => Disposed = true;
    }
    internal static async Task FreshProviderDrainsTicket()
    {
        var temp = Path.Combine(Path.GetTempPath(), "lt-fresh-drain-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(temp, "root"); var cache = Path.Combine(temp, "cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var principal = "odqp1_" + new string('a', 64); var sha = new string('b', 64);
        var identity = new PlaceholderIdentity("pilot", "employee", "https://source.example.invalid", principal,
            "odqr1_synthetic", "oef1_" + new string('c', 64), sha, "old.bin", 1, "\"" + sha + "\"", sha);
        var provider = new NativePlaceholderProvider(new Registration(root), cache, new Source(), "pilot", principal,
            new Dictionary<string, PlaceholderIdentity> { ["old.bin"] = identity });
        var authority = new AdmissionAuthority(); provider.ConfigureFreshAdmission(); provider.FreshAdmissionForTest.Activate(authority);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var work = provider.RunSyntheticAvailabilityForTest("old.bin", async _ => { entered.TrySetResult(); await release.Task; });
        var drainEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        provider.SyntheticAvailabilityDrainEnteredForTest = tasks => { if (tasks.Contains(work)) drainEntered.TrySetResult(); };
        try {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(8));
            var stopping = provider.DisposeAsync().AsTask();
            await drainEntered.Task.WaitAsync(TimeSpan.FromSeconds(8));
            if (stopping.IsCompleted || authority.Disposed) throw new Exception("Provider released active authority.");
            release.TrySetResult(); await work.WaitAsync(TimeSpan.FromSeconds(8)); await stopping.WaitAsync(TimeSpan.FromSeconds(8));
            if (!authority.Disposed) throw new Exception("Provider did not release drained authority.");
        } finally {
            release.TrySetResult(); try { await work.WaitAsync(TimeSpan.FromSeconds(8)); } catch { }
            await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(8)); Directory.Delete(cache); Directory.Delete(root); Directory.Delete(temp);
        }
    }
    internal static async Task FreshScannerFailureDoesNotActivate()
    {
        var temp = Path.Combine(Path.GetTempPath(), "lt-fresh-failure-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(temp, "root"); var cache = Path.Combine(temp, "cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var provider = new NativePlaceholderProvider(new Registration(root), cache, new Source(), "pilot", "odqp1_" + new string('a', 64), new Dictionary<string, PlaceholderIdentity>());
        provider.ConfigureFreshAdmission(); var gate = provider.FreshAdmissionForTest; var authority = new AdmissionAuthority();
        typeof(NativePlaceholderProvider).GetField("catalogReady", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.SetValue(provider, true);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously); using var release = new ManualResetEventSlim();
        provider.SyntheticFreshScannerStartForTest = () => { entered.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(8))) throw new IOException("Timeout."); throw new IOException("Scanner failed."); };
        var activation = Task.Run(() => provider.ActivateFreshAdmission(authority));
        try {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(8));
            ExpectFailure(() => gate.Enter()); // Concurrent fetch cannot acquire a ticket while scanner startup is unresolved.
            release.Set(); try { await activation.WaitAsync(TimeSpan.FromSeconds(8)); throw new Exception("Expected scanner failure."); } catch (IOException) { }
            ExpectFailure(() => gate.Enter()); ExpectFailure(() => provider.ActivateFreshAdmission(authority));
            if (authority.Disposed) throw new Exception("Failed activation consumed authority.");
        } finally {
            release.Set(); try { await activation.WaitAsync(TimeSpan.FromSeconds(8)); } catch (IOException) { }
            await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(8)); authority.Dispose();
            Directory.Delete(cache); Directory.Delete(root); Directory.Delete(temp);
        }
    }
    private sealed class AdmissionAuthority : IProviderWorkAuthority
    {
        internal bool Disposed;
        public void VerifyHeld() { if (Disposed) throw new IOException("disposed"); }
        public void Dispose() => Disposed = true;
    }
#endif
    private static async Task StopWinsBlockedAdmission()
    {
        var temp = Path.Combine(Path.GetTempPath(), "lt-catalog-race-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(temp, "root"); var cache = Path.Combine(temp, "cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var principal = "odqp1_" + new string('a', 64); var sha = new string('b', 64);
        PlaceholderIdentity Identity(string file) => new("pilot", "employee", "https://source.example.invalid", principal,
            "odqr1_synthetic", "oef1_" + new string('c', 64), sha, file, 1, "\"" + sha + "\"", sha);
        var provider = new NativePlaceholderProvider(new Registration(root), cache, new Source(), "pilot", principal,
            new Dictionary<string, PlaceholderIdentity> { ["old.bin"] = Identity("old.bin") });
        var fieldFlags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        typeof(NativePlaceholderProvider).GetField("catalogReady", fieldFlags)!.SetValue(provider, true); // Unconnected synthetic admission seam only.
        var catalog = (LiveProviderCatalog<PlaceholderIdentity>)typeof(NativePlaceholderProvider).GetField("catalog", fieldFlags)!.GetValue(provider)!;
        var prior = catalog.Current; var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var additions = new BlockingDictionary("new.bin", Identity("new.bin"), entered, release);
        var admission = Task.Run(() => provider.AdmitVerifiedCatalog(0, additions, []));
        try {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(8));
            await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(8)); // Stop must not wait for caller's enumeration.
            release.Set();
            try { await admission.WaitAsync(TimeSpan.FromSeconds(8)); throw new IOException("stopped provider admitted catalog"); }
            catch (IOException error) when (error.Message == "The provider is not ready for catalog admission.") { }
            Need(ReferenceEquals(prior, catalog.Current) && catalog.Current.Files.ContainsKey("old.bin") && !catalog.Current.Files.ContainsKey("new.bin"),
                "stop race changed the provider catalog");
        } finally {
            release.Set();
            try { await admission.WaitAsync(TimeSpan.FromSeconds(8)); } catch (IOException) { }
            await provider.DisposeAsync(); Directory.Delete(cache); Directory.Delete(root); Directory.Delete(temp);
        }
    }
    private sealed class BlockingDictionary(string path, PlaceholderIdentity identity, TaskCompletionSource entered, ManualResetEventSlim release)
        : IReadOnlyDictionary<string, PlaceholderIdentity>
    {
        public int Count => 1;
        public IEnumerable<string> Keys => [path];
        public IEnumerable<PlaceholderIdentity> Values => [identity];
        public PlaceholderIdentity this[string key] => key == path ? identity : throw new KeyNotFoundException();
        public bool ContainsKey(string key) => key == path;
        public bool TryGetValue(string key, out PlaceholderIdentity value) { value = identity; return key == path; }
        public IEnumerator<KeyValuePair<string, PlaceholderIdentity>> GetEnumerator()
        {
            entered.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(8))) throw new IOException("admission test timed out");
            yield return new(path, identity);
        }
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
    private sealed class Registration(string root) : IPreviewRootRegistration { public string Root => root; public void VerifyOwned() { } public void Unregister() => throw new InvalidOperationException(); }
    private sealed class Source : IQueuedDownloadSource {
        public string Alias => "employee";
        public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => throw new InvalidOperationException();
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) => throw new InvalidOperationException();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken token = default) => throw new InvalidOperationException();
    }
    private static async Task ConcurrentUpdates()
    {
        var catalog = new LiveProviderCatalog<string>(new Dictionary<string, string>(), []);
        var admitted = new System.Collections.Concurrent.ConcurrentDictionary<string, byte>();
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<bool> Add(string name) => Task.Run(async () => {
            await start.Task;
            try {
                catalog.Add(0, new Dictionary<string, string> { [name] = name }, [], paths => {
                    foreach (var path in paths) admitted.TryAdd(path, 0);
                    Thread.Yield(); // Readers must not see the new snapshot before worker admission.
                });
                return true;
            } catch (IOException) { return false; }
        });
        var first = Add("one"); var second = Add("two");
        var readers = Task.Run(async () => {
            await start.Task;
            while (!first.IsCompleted || !second.IsCompleted) {
                var snapshot = catalog.Current;
                Need(snapshot.Files.Keys.All(admitted.ContainsKey), "snapshot preceded worker admission");
                Need(snapshot.ScanPaths.All(snapshot.Files.ContainsKey), "scanner/catalog snapshot mismatch");
                Thread.Yield();
            }
        });
        start.SetResult(); var accepted = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(8));
        await readers.WaitAsync(TimeSpan.FromSeconds(8));
        Need(accepted.Count(value => value) == 1 && catalog.Current.Files.Count == 1 && admitted.Count == 1, "stale concurrent update was not rejected");
    }
    private static void Need(bool value, string message) { if (!value) throw new IOException(message); }
    private static void ExpectFailure(Action action) { try { action(); } catch (IOException) { return; } throw new IOException("Expected catalog failure."); }
}
