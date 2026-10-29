using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class HydrationConcurrencyTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly byte[] Bytes = Enumerable.Range(0, 8192).Select(i => (byte)(i % 251)).ToArray();
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    private static PlaceholderIdentity Identity(int i) => new("pilot", "portal", "https://concurrency.example.invalid", Principal,
        "odqr1_" + i, "ondf1_" + new string((char)('a' + i), 64), "v1", "sample" + i + ".bin", Bytes.Length, "\"v1\"", Sha);
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("hydration concurrency shares two distinct slots across coordinators and cancels queued work", Distinct),
        ("hydration concurrency excludes duplicate entries but independently authorizes and settles sinks", SameEntry),
        ("hydration concurrency reserves capacity before network and releases exact records after cancellation", Quota),
        ("hydration concurrency rejected distinct admissions do not consume marker bytes beyond quota", DeniedMetadata),
        ("hydration concurrency reclaims only exact stale records under the exclusive entry lease", Stale),
        ("hydration concurrency cancellation retains counted owned partial and resumes verified bytes", Partial),
        ("hydration concurrency reservation cleanup cannot mask primary cancellation or source failure", CleanupFailure),
        ("hydration concurrency promoted-cache crash records reconcile on cache hit and offline eviction", PromotedStale),
        ("hydration concurrency rejects malformed and foreign durable reservations without deleting them", Reservations),
        ("hydration concurrency excludes legacy leases and does not hold short quota lock over network", Legacy),
        ("hydration concurrency eviction waits matching sink while unrelated entry progresses", Eviction),
        ("hydration concurrency dispatcher stop drains two active and one queued request exactly once", Drain),
        ("hydration concurrency metadata growth uses the actual bounded downloader serialization", Metadata)
    ];
    private static void Check(bool value) { if (!value) throw new InvalidOperationException("Concurrency assertion failed."); }
    private static async Task Reject(Task task) { try { await task.WaitAsync(TimeSpan.FromSeconds(5)); } catch (Exception e) when (e is TransferException or IOException) { return; } throw new InvalidOperationException("Expected refusal."); }
    private static async Task Cancelled(Task task) { try { await task.WaitAsync(TimeSpan.FromSeconds(5)); } catch (OperationCanceledException) { return; } throw new InvalidOperationException("Expected cancellation."); }
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static async Task Distinct()
    {
        using var f = new Fixture(); using var second = f.Coordinator();
        var one = Signal(); var two = Signal(); var release = Signal();
        f.Source.BeforeDownload = async (spec, token) => { (spec.FileName == Identity(0).FileName ? one : two).TrySetResult(); await release.Task.WaitAsync(token); };
        var a = f.Run(0); var b = f.Run(1, second); await Task.WhenAll(one.Task, two.Task).WaitAsync(TimeSpan.FromSeconds(5));
        using var cancel = new CancellationTokenSource(); var sink = new Sink(); var queued = f.Run(2, second, sink, cancel.Token);
        Check(!queued.IsCompleted && f.Source.Downloads == 2); cancel.Cancel(); await Cancelled(queued); Check(sink.Failed == 1 && sink.Complete == 0);
        release.SetResult(); await Task.WhenAll(a, b).WaitAsync(TimeSpan.FromSeconds(5)); Check(f.Source.Peak == 2);
        Check(!Directory.EnumerateFiles(f.Root, "*.json", SearchOption.AllDirectories).Any(p => Path.GetFileName(Path.GetDirectoryName(p)) == ".hydration-reservations-v2"));
    }
    private static async Task SameEntry()
    {
        using var f = new Fixture(); using var second = f.Coordinator(); var entered = Signal(); var release = Signal();
        f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); };
        var s1 = new Sink(); var s2 = new Sink(); var first = f.Run(0, sink: s1); await entered.Task;
        var duplicate = f.Run(0, second, s2); Check(!duplicate.IsCompleted && f.Source.Downloads == 1);
        release.SetResult(); await Task.WhenAll(first, duplicate).WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Source.Downloads == 1 && f.Source.Resolves == 4 && s1.Complete == 1 && s2.Complete == 1 && s1.Failed + s2.Failed == 0);
    }
    private static async Task Quota()
    {
        using var f = new Fixture(); using var small1 = f.Coordinator(18000); using var small2 = f.Coordinator(18000);
        var entered = Signal(); var release = Signal(); f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); };
        using var cancel = new CancellationTokenSource(); var a = f.Run(0, small1, token: cancel.Token); await entered.Task;
        await Reject(f.Run(1, small2)); Check(f.Source.Downloads == 1);
        cancel.Cancel(); await Cancelled(a);
        f.Source.BeforeDownload = null; await f.Run(1, small2); Check(f.Source.Downloads == 2);
    }
    private static async Task Reservations()
    {
        using var f = new Fixture(); await f.Run(0);
        var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
        var foreign = Path.Combine(directory, "foreign.json"); File.WriteAllText(foreign, "{}");
        await Reject(f.Run(1)); Check(File.ReadAllText(foreign) == "{}" && f.Source.Downloads == 1);
        File.Delete(foreign); // Exact synthetic file created by this test, never cleanup unknown records.
        var id = Identity(1); var record = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json");
        File.WriteAllText(record, JsonSerializer.Serialize(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey, Growth = 0 }));
        await Reject(f.Run(1)); Check(File.Exists(record) && f.Source.Downloads == 1);
    }
    private static async Task DeniedMetadata()
    {
        using var f = new Fixture(); using var tiny = f.Coordinator(9000);
        var root = Path.Combine(f.Root, "verified-hydration-v1");
        var before = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Sum(p => new FileInfo(p).Length);
        for (var i = 0; i < 6; i++) {
            await Reject(f.Run(i, tiny));
            Check(Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Sum(p => new FileInfo(p).Length) == before);
            Check(!Directory.EnumerateDirectories(root).Any());
        }
        Check(f.Source.Downloads == 0);
    }
    private static async Task Stale()
    {
        using var f = new Fixture(); await f.Run(0);
        var id = Identity(1); var spec = new DownloadSpec(id.LogicalFileId + ":v1", new Uri(id.Origin + "/content"), id.FileName, id.Length, id.ETag, id.Sha256);
        var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
        var path = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json");
        // Simulate a crash after metadata creation. Recreate the precise owned entry/marker, not an unknown path.
        var entry = Path.Combine(f.Root, "verified-hydration-v1", id.ScopeKey, id.CacheKey); Directory.CreateDirectory(entry);
        File.WriteAllText(Path.Combine(entry, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n");
        File.WriteAllText(path, JsonSerializer.Serialize(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey,
            Growth = checked(id.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024) }));
        await f.Run(1); Check(f.Source.Downloads == 2 && !File.Exists(path));
    }
    private static async Task Partial()
    {
        using var f = new Fixture(); var waiting = Signal();
        f.Source.StreamFactory = () => new PrefixThenWait(waiting);
        using var cancel = new CancellationTokenSource(); var request = f.Run(0, token: cancel.Token);
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel(); await Cancelled(request);
        var part = Directory.EnumerateFiles(f.Root, "*.part", SearchOption.AllDirectories).Single();
        Check(new FileInfo(part).Length == 4096);
        Check(!Directory.EnumerateFiles(Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2"), "*.json").Any());
        f.Source.StreamFactory = null; var sink = new Sink(); await f.Run(0, sink: sink);
        Check(sink.Complete == 1 && sink.Failed == 0 && f.Source.Downloads == 2 && !File.Exists(part));
    }
    private static string ExactRecord(Fixture f, int i, long? overrideGrowth = null)
    {
        var id = Identity(i); var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
        var path = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json");
        File.WriteAllText(path, JsonSerializer.Serialize(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey,
            Growth = overrideGrowth ?? checked(id.Length + Downloader.HydrationStateGrowthBudget(id.Length, id.ETag, id.Sha256) + 1024) }));
        return path;
    }
    private static async Task CleanupFailure()
    {
        foreach (var cancelled in new[] { true, false }) {
            using var f = new Fixture(); using var cancel = new CancellationTokenSource(); var entered = Signal(); var release = Signal(); var sink = new Sink();
            f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); throw new ResourceUnavailableException(); };
            var operation = f.Run(0, sink: sink, token: cancel.Token); await entered.Task;
            var root = Path.Combine(f.Root, "verified-hydration-v1");
            using (var held = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                if (cancelled) { cancel.Cancel(); await Cancelled(operation); }
                else {
                    release.SetResult();
                    try { await operation.WaitAsync(TimeSpan.FromSeconds(5)); throw new InvalidOperationException("Expected primary failure."); }
                    catch (TransferException error) { Check(error.HydrationFailure?.Category == HydrationFailureCategory.ResourceUnavailable); }
                }
            }
            Check(sink.Failed == 1 && sink.Complete == 0 && Directory.EnumerateFiles(Path.Combine(root, ".hydration-reservations-v2"), "*.json").Count() == 1);
            f.Source.BeforeDownload = null; await f.Run(0);
            Check(!Directory.EnumerateFiles(Path.Combine(root, ".hydration-reservations-v2"), "*.json").Any());
        }
    }
    private static async Task PromotedStale()
    {
        using var f = new Fixture(); await f.Run(0); var path = ExactRecord(f, 0); var downloads = f.Source.Downloads;
        await f.Run(0); Check(f.Source.Downloads == downloads && !File.Exists(path));
        path = ExactRecord(f, 0); var resolves = f.Source.Resolves;
        using var offline = f.Coordinator(); await offline.EvictVerifiedCacheAsync(Identity(0));
        Check(!File.Exists(path) && f.Source.Resolves == resolves && f.Source.Downloads == downloads);
        await f.Run(0); path = ExactRecord(f, 0, 0); resolves = f.Source.Resolves;
        await Reject(offline.EvictVerifiedCacheAsync(Identity(0)));
        Check(File.Exists(path) && Directory.EnumerateFiles(f.Root, Identity(0).FileName, SearchOption.AllDirectories).Any() && f.Source.Resolves == resolves);
    }
    private sealed class PrefixThenWait(TaskCompletionSource waiting) : MemoryStream(Bytes)
    {
        private bool first = true;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            if (first) { first = false; return await base.ReadAsync(buffer[..Math.Min(4096, buffer.Length)], token); }
            waiting.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, token); return 0;
        }
    }
    private static async Task Legacy()
    {
        using var f = new Fixture(); await f.Run(0);
        var root = Path.Combine(f.Root, "verified-hydration-v1");
        using (var legacy = new FileStream(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) await Reject(f.Run(1));
        var entered = Signal(); var release = Signal(); f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); };
        var pending = f.Run(1); await entered.Task;
        try { using var legacy = new FileStream(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new InvalidOperationException("Expected legacy exclusion."); } catch (IOException) { }
        using (var shortQuota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        release.SetResult(); await pending;
    }
    private static async Task Eviction()
    {
        using var f = new Fixture(); using var second = f.Coordinator(); var entered = Signal(); var release = Signal();
        var sink = new Sink { BeforeWrite = async () => { entered.TrySetResult(); await release.Task; } };
        var transfer = f.Run(0, sink: sink); await entered.Task;
        var eviction = second.EvictVerifiedCacheAsync(Identity(0)); Check(!eviction.IsCompleted);
        await f.Run(1, second).WaitAsync(TimeSpan.FromSeconds(5)); Check(!eviction.IsCompleted);
        release.SetResult(); await transfer; await eviction.WaitAsync(TimeSpan.FromSeconds(5));
        Check(sink.Complete == 1 && sink.Failed == 0 && !Directory.EnumerateFiles(f.Root, Identity(0).FileName, SearchOption.AllDirectories).Any());
    }
    private static Task Metadata()
    {
        var id = Identity(0); var spec = new DownloadSpec("x", new Uri(id.Origin + "/content"), id.FileName, long.MaxValue, "\"" + new string('<', 510) + "\"", id.Sha256);
        var exact = JsonSerializer.SerializeToUtf8Bytes(new { Version = 1, Descriptor = new string('a', 64), spec.Length, spec.ETag, Sha256 = spec.Sha256.ToLowerInvariant() }).LongLength + System.Text.Encoding.UTF8.GetByteCount("LedgeTop.WindowsDownload/1\n");
        Check(Downloader.HydrationStateGrowthBudget(spec) == exact && exact > 3000);
        return Task.CompletedTask;
    }
    private static async Task Drain()
    {
        using var f = new Fixture(); var two = Signal(); var entered = 0; var sinks = new[] { new Sink(), new Sink(), new Sink() };
        f.Source.BeforeDownload = async (_, token) => { if (Interlocked.Increment(ref entered) == 2) two.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, token); };
        await using var dispatcher = new CloudFilesCallbackDispatcher(f.Source, "pilot", Principal, 42, f.Root,
            (core, id, context, token) => core.HydrateAsync(id, 0, Bytes.Length, sinks[(int)context.RequestKey], token));
        var requests = Enumerable.Range(0, 3).Select(i => dispatcher.FetchDataAsync(Identity(i).Encode(), new(42, 100 + i, i, Bytes.Length, 0, Bytes.Length))).ToArray();
        await two.Task.WaitAsync(TimeSpan.FromSeconds(5)); Check(f.Source.Downloads == 2);
        await dispatcher.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        foreach (var task in requests) await Cancelled(task);
        Check(sinks.All(sink => sink.Complete == 0 && sink.Failed == 1) && f.Source.Downloads == 2);
    }
    private sealed class Sink : IPlaceholderTransferSink
    {
        internal int Complete, Failed; internal Func<Task>? BeforeWrite;
        public async Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) { token.ThrowIfCancellationRequested(); if (BeforeWrite is not null) await BeforeWrite(); }
        public Task CompleteAsync(CancellationToken token) { Complete++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; return Task.CompletedTask; }
    }
    private sealed class Source : IQueuedDownloadSource, IDisposable
    {
        private readonly Downloader downloader;
        private int downloads, resolves, active, peak;
        internal int Downloads => Volatile.Read(ref downloads); internal int Resolves => Volatile.Read(ref resolves); internal int Peak => Volatile.Read(ref peak);
        internal Func<DownloadSpec, CancellationToken, Task>? BeforeDownload;
        internal Func<Stream>? StreamFactory;
        public string Alias => "portal"; public Uri Origin => new("https://concurrency.example.invalid");
        internal Source() { downloader = new(new Handler(this), [Origin]); }
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) { token.ThrowIfCancellationRequested(); return Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddHours(1))); }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            token.ThrowIfCancellationRequested(); Interlocked.Increment(ref resolves); var id = Identity(int.Parse(reference[6..], System.Globalization.CultureInfo.InvariantCulture));
            return Task.FromResult(new ResolvedQueuedDownload(Principal, id.LogicalFileId, id.RemoteVersion, new(id.LogicalFileId + ":v1", new Uri(Origin, "/content"), id.FileName, id.Length, id.ETag, id.Sha256)));
        }
        public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) {
            Interlocked.Increment(ref downloads); var current = Interlocked.Increment(ref active); int previous;
            do { previous = Volatile.Read(ref peak); if (previous >= current) break; } while (Interlocked.CompareExchange(ref peak, current, previous) != previous);
            try { if (BeforeDownload is not null) await BeforeDownload(spec, cancellationToken); return await downloader.DownloadAsync(spec, destination, cancellationToken, progress); }
            finally { Interlocked.Decrement(ref active); }
        }
        public void Dispose() => downloader.Dispose();
        private sealed class Handler(Source source) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
                token.ThrowIfCancellationRequested(); var offset = request.Headers.Range?.Ranges.Single().From ?? 0;
                var content = source.StreamFactory is { } factory ? (HttpContent)new StreamContent(factory()) : new ByteArrayContent(Bytes[(int)offset..]);
                content.Headers.ContentLength = Bytes.Length - offset;
                if (offset > 0) content.Headers.ContentRange = new(offset, Bytes.Length - 1, Bytes.Length);
                var response = new HttpResponseMessage(offset > 0 ? HttpStatusCode.PartialContent : HttpStatusCode.OK) { Content = content };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"v1\""); return Task.FromResult(response);
            }
        }
    }
    private sealed class Fixture : IDisposable
    {
        internal readonly string Root;
        internal readonly Source Source = new(); private readonly PlaceholderHydrationCoordinator coordinator;
        internal Fixture() {
            var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? Path.Combine(Path.GetTempPath(), "LedgeTopFilesTests");
            if (!Path.IsPathFullyQualified(parent) || parent.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Use local test artifacts.");
            parent = Path.GetFullPath(parent);
            for (var part = parent; part is not null; part = Path.GetDirectoryName(part)) {
                if (File.Exists(part)) throw new IOException("Artifact ancestor is a file.");
                if (Directory.Exists(part) && (File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new IOException("Artifact ancestor is an alias.");
            }
            Root = Path.Combine(parent, "concurrency", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Root); coordinator = Coordinator();
        }
        internal PlaceholderHydrationCoordinator Coordinator(long maximum = 1L << 30) => new(Source, "pilot", Root, Bytes.Length, maximum, Principal);
        internal Task Run(int i, PlaceholderHydrationCoordinator? owner = null, Sink? sink = null, CancellationToken token = default) => (owner ?? coordinator).HydrateAsync(Identity(i), 0, Bytes.Length, sink ?? new Sink(), token);
        public void Dispose() { coordinator.Dispose(); Source.Dispose(); File.WriteAllText(Path.Combine(Root, "synthetic-receipt.txt"), "Synthetic owned cache only. No source data or credentials.\n"); }
    }
}
