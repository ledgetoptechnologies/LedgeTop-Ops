using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class PlaceholderCacheEvictionTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly byte[] Bytes = Enumerable.Range(0, 8192).Select(value => (byte)(value % 251)).ToArray();
    private static PlaceholderIdentity Identity => new("pilot", "portal", "https://cache.example.invalid", Principal,
        "odqr1_cache", "ondf1_" + new string('b', 64), "v1", "sample.bin", Bytes.Length, "\"v1\"", Convert.ToHexStringLower(SHA256.HashData(Bytes)));
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
#if LEDGETOP_CACHE_RACE_TEST
        ("cache reclamation quota timeout reports busy preserves bytes and cancellation", QuotaBusy),
#endif
        ("cache reclamation retries only bounded transient sharing failures", RetryPolicy),
        ("cache reclamation admission timeout reports busy without retry", AdmissionTimeout),
        ("cache reclamation evicts exact verified bytes offline and rehydrates from source", ExactAndRetry),
        ("cache reclamation missing entries never create directories or leases", Missing),
        ("cache reclamation preserves tampered bytes foreign ownership and wrong scope", Integrity),
        ("cache reclamation honors capacity entry and file sharing leases", Leases),
        ("cache reclamation waits active sink and cancels without deleting its cache", ActiveSink),
        ("cache reclamation dispatcher stop joins cancelled eviction and hydration", Stop),
        ("cache reclamation connection owner forwards only active scoped requests", Owner),
        ("cache reclamation handles installed-profile-length paths without weakening ownership", LongPaths)
    ];
#if LEDGETOP_CACHE_RACE_TEST
    private static async Task QuotaBusy()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var f = new Fixture(); await f.Hydrate(); var calls = f.Source.Calls;
        using var holder = await HydrationCacheConcurrency.AcquireAsync(f.CacheRoot, "test-other", default);
        using var release = new ManualResetEventSlim();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var owner = Task.Run(() => { lock (holder.Quota) { entered.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(8))) throw new TimeoutException(); } });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try {
            HydrationQuotaGate.TestWait = TimeSpan.FromMilliseconds(120); var attempts = 0;
            try {
                await Task.Run(() => CacheReclamationRetry.RunAsync(ct => { attempts++; return f.Coordinator.EvictVerifiedCacheAsync(Identity, ct); }, default)).WaitAsync(TimeSpan.FromSeconds(4));
                throw new InvalidOperationException("Expected quota busy.");
            } catch (CacheReclamationException error) { Check(error.Kind == CacheReclamationFailureKind.Busy); }
            Check(attempts == 1 && File.ReadAllBytes(f.File).SequenceEqual(Bytes) && f.Source.Calls == calls && !owner.IsCompleted);
            HydrationQuotaGate.TestWait = TimeSpan.FromSeconds(5);
            using var cancellation = new CancellationTokenSource();
            var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            HydrationQuotaGate.BeforeWaitTestHook = () => waiting.TrySetResult();
            var cancelled = Task.Run(() => f.Coordinator.EvictVerifiedCacheAsync(Identity, cancellation.Token));
            await waiting.Task.WaitAsync(TimeSpan.FromSeconds(4)); cancellation.Cancel(); await Cancelled(cancelled);
            Check(File.ReadAllBytes(f.File).SequenceEqual(Bytes) && !owner.IsCompleted);
        } finally { HydrationQuotaGate.BeforeWaitTestHook = null; HydrationQuotaGate.TestWait = null; release.Set(); await owner.WaitAsync(TimeSpan.FromSeconds(5)); }
        await CacheReclamationRetry.RunAsync(ct => f.Coordinator.EvictVerifiedCacheAsync(Identity, ct), default);
        Check(!File.Exists(f.File) && f.Source.Calls == calls);
    }
#endif
    private static async Task RetryPolicy()
    {
        var attempts = 0; var delays = 0;
        Task Delay(CancellationToken ct) { ct.ThrowIfCancellationRequested(); delays++; return Task.CompletedTask; }
        await CacheReclamationRetry.RunAsync(_ => { if (++attempts < 3) throw new IOException("private path", unchecked((int)0x80070020)); return Task.CompletedTask; }, default, Delay);
        Check(attempts == 3 && delays == 2);
        attempts = 0;
        try { await CacheReclamationRetry.RunAsync(_ => { attempts++; throw new TransferException("modified private data"); }, default, Delay); throw new InvalidOperationException("Expected unverified refusal"); }
        catch (CacheReclamationException error) { Check(error.Kind == CacheReclamationFailureKind.Unverified && !error.Message.Contains("private")); }
        Check(attempts == 1);
        attempts = 0;
        try { await CacheReclamationRetry.RunAsync(_ => { attempts++; throw new IOException("private path", unchecked((int)0x80070021)); }, default, Delay); throw new InvalidOperationException("Expected busy refusal"); }
        catch (CacheReclamationException error) { Check(error.Kind == CacheReclamationFailureKind.Busy && !error.Message.Contains("private")); }
        Check(attempts == 3);
        attempts = 0; delays = 0;
        try { await CacheReclamationRetry.RunAsync(_ => { attempts++; throw new CacheLeaseContentionTimeoutException(); }, default, Delay); throw new InvalidOperationException("Expected busy timeout"); }
        catch (CacheReclamationException error) { Check(error.Kind == CacheReclamationFailureKind.Busy); }
        Check(attempts == 1 && delays == 0);
        using (var f = new Fixture()) {
            await f.Hydrate();
            var path = Path.Combine(f.Entry, ".hydration.lock");
            using var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            try { using var unexpected = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(path, FileMode.Open, default, true, TimeSpan.FromMilliseconds(75)); throw new InvalidOperationException("Expected reclamation lease timeout"); }
            catch (CacheLeaseContentionTimeoutException) { }
            try { using var unexpected = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(path, FileMode.Open, default, false, TimeSpan.FromMilliseconds(75)); throw new InvalidOperationException("Expected hydration lease timeout"); }
            catch (TransferException error) { Check(error.Reason == TransferFailureReason.Timeout); }
            using var cancelLease = new CancellationTokenSource(); cancelLease.Cancel();
            try { using var unexpected = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(path, FileMode.Open, cancelLease.Token, true, TimeSpan.FromMilliseconds(75)); throw new InvalidOperationException("Expected lease cancellation"); }
            catch (OperationCanceledException) { }
            Check(File.Exists(f.File));
        }
        using var cancelled = new CancellationTokenSource(); attempts = 0;
        try { await CacheReclamationRetry.RunAsync(_ => { attempts++; throw new IOException("busy", unchecked((int)0x80070020)); }, cancelled.Token, _ => { cancelled.Cancel(); return Task.FromCanceled(cancelled.Token); }); throw new InvalidOperationException("Expected cancellation"); }
        catch (OperationCanceledException) { }
        Check(attempts == 1);
    }
    private static async Task AdmissionTimeout()
    {
        var attempts = 0; var delays = 0;
        Task Delay(CancellationToken ct) { ct.ThrowIfCancellationRequested(); delays++; return Task.CompletedTask; }
        // Exercise the real root admission timeout without a two-minute wait. The
        // timeout is busy, is not retried, and is distinct from caller cancellation.
        var admissionRoot = Path.Combine(Path.GetTempPath(), "lt-cache-admission-test-" + Guid.NewGuid().ToString("N"));
        using (var exclusive = await HydrationCacheConcurrency.AcquireAsync(admissionRoot, "held", default, exclusive: true)) {
            attempts = 0; delays = 0;
            try {
                await CacheReclamationRetry.RunAsync(async ct => {
                    attempts++;
                    using var lease = await HydrationCacheConcurrency.AcquireForReclamationAsync(admissionRoot, "waiting", ct, testTimeout: TimeSpan.FromMilliseconds(75));
                    throw new InvalidOperationException("Unexpected admission.");
                }, default, Delay);
                throw new InvalidOperationException("Expected admission timeout.");
            } catch (CacheReclamationException error) {
                Check(error.Kind == CacheReclamationFailureKind.Busy && !error.Message.Contains(admissionRoot));
            }
            Check(attempts == 1 && delays == 0);
            using var cancelAdmission = new CancellationTokenSource();
            var waiting = CacheReclamationRetry.RunAsync(async ct => {
                using var lease = await HydrationCacheConcurrency.AcquireForReclamationAsync(admissionRoot, "cancelled", ct, testTimeout: TimeSpan.FromSeconds(5));
            }, cancelAdmission.Token, Delay);
            cancelAdmission.Cancel();
            try { await waiting; throw new InvalidOperationException("Expected admission cancellation."); }
            catch (OperationCanceledException) { }
        }
        using (var recovered = await HydrationCacheConcurrency.AcquireAsync(admissionRoot, "recovered", default, exclusive: true, testTimeout: TimeSpan.FromSeconds(1))) { }
        Check(CacheReclamationRetry.Classify(new TransferException("private", TransferFailureReason.Timeout)) == CacheReclamationFailureKind.Unverified);
        using var boundaryCancel = new CancellationTokenSource();
        try {
            await CacheReclamationRetry.RunAsync(_ => { boundaryCancel.Cancel(); throw new CacheLeaseContentionTimeoutException(); }, boundaryCancel.Token, Delay);
            throw new InvalidOperationException("Expected cancellation at timeout boundary.");
        } catch (OperationCanceledException) { }
    }
    private static void Check(bool value) { if (!value) throw new InvalidOperationException("Cache reclamation assertion failed."); }
    private static async Task Refuse(Func<Task> action) {
        try { await action().WaitAsync(TimeSpan.FromSeconds(4)); }
        catch (Exception error) when (error is TransferException or IOException or AccessDeniedException) { return; }
        throw new InvalidOperationException("Expected cache reclamation refusal.");
    }
    private static async Task Cancelled(Task task) {
        try { await task.WaitAsync(TimeSpan.FromSeconds(4)); } catch (OperationCanceledException) { return; }
        throw new InvalidOperationException("Expected cancelled cache operation.");
    }
    private static async Task ExactAndRetry()
    {
        using var f = new Fixture(); await f.Hydrate(); Check(File.Exists(f.File));
        var calls = f.Source.Calls; var files = Directory.GetFiles(f.Root, "*", SearchOption.AllDirectories).Length;
        await f.Coordinator.EvictVerifiedCacheAsync(Identity);
        Check(!File.Exists(f.File) && f.Source.Calls == calls && f.Source.Downloads == 1);
        await f.Coordinator.EvictVerifiedCacheAsync(Identity);
        Check(f.Source.Calls == calls && Directory.GetFiles(f.Root, "*", SearchOption.AllDirectories).Length == files - 1);
        await f.Hydrate(); Check(File.ReadAllBytes(f.File).SequenceEqual(Bytes) && f.Source.Downloads == 2);
    }
    private static async Task LongPaths()
    {
        Check(PlaceholderHydrationCoordinator.NativeCacheFilePath(@"C:\owned\cache\file.bin") == @"\\?\C:\owned\cache\file.bin");
        foreach (var invalid in new[] { "relative.bin", @"\rooted.bin", @"C:relative.bin", @"\\server\share\file.bin",
            @"\\?\C:\owned\file.bin", @"\\.\C:\owned\file.bin", @"C:\owned\..\file.bin", "C:/owned/file.bin" }) {
            var refused = false;
            try { _ = PlaceholderHydrationCoordinator.NativeCacheFilePath(invalid); } catch (TransferException) { refused = true; }
            Check(refused);
        }
        using var f = new Fixture(longPath: true); await f.Hydrate();
        Check(f.File.Length > 382 && File.ReadAllBytes(f.File).SequenceEqual(Bytes));
        var calls = f.Source.Calls;
        await f.Coordinator.EvictVerifiedCacheAsync(Identity);
        Check(!File.Exists(f.File) && f.Source.Calls == calls);
        await f.Hydrate(); Check(File.ReadAllBytes(f.File).SequenceEqual(Bytes) && f.Source.Downloads == 2);
    }
    private static async Task Missing()
    {
        using var f = new Fixture();
        var before = Directory.GetFileSystemEntries(f.Root, "*", SearchOption.AllDirectories).Order().ToArray();
        await f.Coordinator.EvictVerifiedCacheAsync(Identity);
        Check(before.SequenceEqual(Directory.GetFileSystemEntries(f.Root, "*", SearchOption.AllDirectories).Order()) && f.Source.Calls == 0);
        await f.Hydrate(); var other = Identity with { RemoteVersion = "not-cached" };
        before = Directory.GetFileSystemEntries(f.Root, "*", SearchOption.AllDirectories).Order().ToArray();
        var calls = f.Source.Calls; await f.Coordinator.EvictVerifiedCacheAsync(other);
        Check(before.SequenceEqual(Directory.GetFileSystemEntries(f.Root, "*", SearchOption.AllDirectories).Order()) && f.Source.Calls == calls && File.Exists(f.File));
    }
    private static async Task Integrity()
    {
        using (var f = new Fixture()) {
            await f.Hydrate(); var calls = f.Source.Calls;
            foreach (var wrong in new[] { Identity with { PrincipalId = "odqp1_" + new string('c', 64) }, Identity with { Channel = "stable" },
                Identity with { SourceAlias = "employee" }, Identity with { Origin = "https://wrong.example.invalid" } })
                await Refuse(() => f.Coordinator.EvictVerifiedCacheAsync(wrong));
            Check(File.ReadAllBytes(f.File).SequenceEqual(Bytes) && f.Source.Calls == calls);
            foreach (var reserved in new[] { ".verified-hydration-owner", ".HYDRATION.LOCK", ".hydration-cache.lock" }) {
                var invalid = Identity with { FileName = reserved };
                await Refuse(() => f.Coordinator.EvictVerifiedCacheAsync(invalid));
                await Refuse(() => f.Coordinator.HydrateAsync(invalid, 0, invalid.Length, new Sink()));
            }
            Check(f.Source.Calls == calls && File.ReadAllBytes(f.File).SequenceEqual(Bytes));
            var changed = Bytes.ToArray(); changed[0] ^= 1; File.WriteAllBytes(f.File, changed);
            await Refuse(() => f.Coordinator.EvictVerifiedCacheAsync(Identity));
            Check(File.ReadAllBytes(f.File).SequenceEqual(changed) && f.Source.Calls == calls);
            File.WriteAllBytes(f.File, Bytes[..^1]); await Refuse(() => f.Coordinator.EvictVerifiedCacheAsync(Identity));
            Check(new FileInfo(f.File).Length == Bytes.Length - 1);
        }
        foreach (var level in new[] { 0, 1, 2 }) {
            using var f = new Fixture(); await f.Hydrate();
            var directories = new[] { f.CacheRoot, Path.GetDirectoryName(f.Entry)!, f.Entry };
            var marker = Path.Combine(directories[level], ".verified-hydration-owner"); File.WriteAllText(marker, "foreign owner");
            var calls = f.Source.Calls; await Refuse(() => f.Coordinator.EvictVerifiedCacheAsync(Identity));
            Check(File.ReadAllBytes(f.File).SequenceEqual(Bytes) && File.ReadAllText(marker) == "foreign owner" && f.Source.Calls == calls);
        }
    }
    private static async Task Leases()
    {
        using var f = new Fixture(); await f.Hydrate(); var calls = f.Source.Calls;
        foreach (var path in new[] { Path.Combine(f.CacheRoot, ".hydration-cache.lock"), Path.Combine(f.Entry, ".hydration.lock"), f.File }) {
            using (var held = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None)) {
                if (Path.GetFileName(path) == ".hydration.lock") {
                    using var cancel = new CancellationTokenSource();
                    var waiting = f.Coordinator.EvictVerifiedCacheAsync(Identity, cancel.Token);
                    Check(!waiting.IsCompleted); cancel.Cancel(); await Cancelled(waiting);
                } else await Refuse(() => f.Coordinator.EvictVerifiedCacheAsync(Identity));
            }
            Check(File.Exists(f.File) && f.Source.Calls == calls);
        }
        await f.Coordinator.EvictVerifiedCacheAsync(Identity); Check(!File.Exists(f.File));
    }
    private static async Task ActiveSink()
    {
        using var f = new Fixture(); var sink = new Sink { Hold = true };
        var hydration = f.Coordinator.HydrateAsync(Identity, 0, Identity.Length, sink);
        await sink.Entered.Task.WaitAsync(TimeSpan.FromSeconds(4));
        var calls = f.Source.Calls; using var cancellation = new CancellationTokenSource();
        var eviction = f.Coordinator.EvictVerifiedCacheAsync(Identity, cancellation.Token);
        Check(!eviction.IsCompleted && File.Exists(f.File) && f.Source.Calls == calls);
        cancellation.Cancel(); await Cancelled(eviction); Check(File.Exists(f.File));
        var afterDrain = f.Coordinator.EvictVerifiedCacheAsync(Identity);
        Check(!afterDrain.IsCompleted); sink.Release.TrySetResult();
        await hydration.WaitAsync(TimeSpan.FromSeconds(4)); await afterDrain.WaitAsync(TimeSpan.FromSeconds(4));
        Check(!File.Exists(f.File) && f.Source.Calls == calls);
    }
    private static async Task Stop()
    {
        using var f = new Fixture(); var sink = new Sink { Hold = true };
        var dispatcher = new CloudFilesCallbackDispatcher(f.Source, "pilot", Principal, 7, f.Root,
            (coordinator, id, context, token) => coordinator.HydrateAsync(id, context.RequiredOffset, context.RequiredLength, sink, token));
        var hydration = dispatcher.FetchDataAsync(Identity.Encode(), new(7, 1, 2, Bytes.Length, 0, Bytes.Length));
        await sink.Entered.Task.WaitAsync(TimeSpan.FromSeconds(4));
        var calls = f.Source.Calls; var eviction = dispatcher.EvictVerifiedCacheAsync(Identity);
        await Refuse(() => dispatcher.EvictVerifiedCacheAsync(Identity with { PrincipalId = "odqp1_" + new string('d', 64) }));
        await dispatcher.StopAsync().WaitAsync(TimeSpan.FromSeconds(4));
        await Cancelled(hydration); await Cancelled(eviction);
        Check(File.Exists(f.File) && f.Source.Calls == calls);
        await Refuse(() => dispatcher.EvictVerifiedCacheAsync(Identity));
    }
    private static async Task Owner()
    {
        using var f = new Fixture(); CloudFilesCallbackDispatcher? dispatcher = null;
        var native = new Native();
        var owner = new CloudFilesConnectionOwner(native, key => dispatcher = new(f.Source, "pilot", Principal, key, f.Root,
            (coordinator, id, context, token) => coordinator.HydrateAsync(id, context.RequiredOffset, context.RequiredLength, new Sink(), token)));
        await Refuse(() => owner.EvictVerifiedCacheAsync(Identity));
        owner.Connect(); await dispatcher!.FetchDataAsync(Identity.Encode(), new(77, 1, 2, Bytes.Length, 0, Bytes.Length));
        var calls = f.Source.Calls; await owner.EvictVerifiedCacheAsync(Identity);
        Check(!File.Exists(f.File) && f.Source.Calls == calls);
        await owner.StopAsync(); Check(native.Disconnections == 1); await Refuse(() => owner.EvictVerifiedCacheAsync(Identity));
    }
    private sealed class Native : ICloudFilesConnectionNative
    {
        internal int Disconnections;
        public int Connect(nint table, nint context, out long key) { key = 77; return 0; }
        public int Disconnect(long key) { Disconnections++; return 0; }
        public void RejectFetch(CloudFilesOperationContext context, int status) => throw new InvalidOperationException();
    }
    private sealed class Sink : IPlaceholderTransferSink
    {
        internal bool Hold;
        internal TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously), Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) {
            Entered.TrySetResult(); if (Hold) await Release.Task.WaitAsync(token);
        }
        public Task CompleteAsync(CancellationToken token) => Task.CompletedTask;
        public Task FailAsync(string code) => Task.CompletedTask;
    }
    private sealed class Source : IQueuedDownloadSource, IHydrationMutationAwareSource
    {
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        internal int Calls, Downloads;
        public string Alias => "portal";
        public Uri Origin => new("https://cache.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) { Calls++; return Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddHours(1))); }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            Calls++; return Task.FromResult(new ResolvedQueuedDownload(Principal, Identity.LogicalFileId, Identity.RemoteVersion,
                new DownloadSpec(Identity.LogicalFileId + ":" + Identity.RemoteVersion, new Uri(Origin, "/bytes"), Identity.FileName, Bytes.Length, Identity.ETag, Identity.Sha256)));
        }
        public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) {
            Calls++; Downloads++; var file = Path.Combine(destination, spec.FileName); await File.WriteAllBytesAsync(file, Bytes, cancellationToken); return file;
        }
    }
    private sealed class Fixture : IDisposable
    {
        internal readonly string Root = CreateFixtureRoot();
        internal Source Source = new();
        internal PlaceholderHydrationCoordinator Coordinator;
        internal string CacheRoot => Path.Combine(Root, "verified-hydration-v1");
        internal string Entry => Path.Combine(CacheRoot, Identity.ScopeKey, Identity.CacheKey);
        internal string File => Path.Combine(Entry, Identity.FileName);
        internal Fixture(bool longPath = false) {
            if (longPath) Root = Path.Combine(Root, new string('p', 90), new string('q', 90));
            Directory.CreateDirectory(Root); Coordinator = new(Source, "pilot", Root, expectedPrincipal: Principal);
        }
        internal Task Hydrate() => Coordinator.HydrateAsync(Identity, 0, Bytes.Length, new Sink());
        public void Dispose() => Coordinator.Dispose(); // Retain only synthetic evidence within the one authorized task artifact directory.
        private static string CreateFixtureRoot()
        {
            var selected = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ??
                Path.Combine(Path.GetTempPath(), "LedgeTopFilesTests", "cache-reclamation");
            if (!Path.IsPathFullyQualified(selected) || selected.StartsWith("\\\\", StringComparison.Ordinal))
                throw new IOException("Test artifacts require a fully qualified local directory.");
            var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(selected));
            if (full == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!))
                throw new IOException("Use a dedicated test artifact directory.");
            for (var part = full; part is not null; part = Path.GetDirectoryName(part)) {
                try {
                    var attributes = System.IO.File.GetAttributes(part);
                    if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0)
                        throw new IOException("Test artifacts cannot pass through aliases or files.");
                } catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            }
            return Path.Combine(full, "fixtures", Guid.NewGuid().ToString("N"));
        }
    }
}
