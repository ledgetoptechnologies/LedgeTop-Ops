#if LEDGETOP_MEMORY_HYDRATION
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Synthetic-only native benchmark for memory-staged hydration versus the standard #504 verified-cache path.
// Generated data only: no credentials, DNS, network, real app, saved connection or staging data.
//
//   --memory-hydration-benchmark <count 1..4> <payloadMiB 1..200>
//   LEDGETOP_MEMBENCH_MODE=memory|standard   (required; same build, one variable)
//   LEDGETOP_MEMBENCH_DEADLINE_S=30..900     (reader deadline; default 240)
//   LEDGETOP_TEST_ARTIFACT_ROOT=<local absolute folder>  (fixture parent; the fixture is retained)
//
// Each file has distinct deterministic content (seeded per file) and its own SHA-256, so swaps are detected.
// Readers are separate processes that stream-hash the placeholder (bounded RAM) and recompute the expected
// digest from the generator; their stdout is captured by the parent and printed verbatim.
internal static class MemoryHydrationBenchmark
{
    private const string Principal = "odqp1_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    private static readonly Uri Origin = new("https://membench.example.invalid");

    internal static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 3 || !int.TryParse(args[1], out var count) || count is < 1 or > 4 ||
            !int.TryParse(args[2], out var mib) || mib is < 1 or > 200) { Console.WriteLine("usage: --memory-hydration-benchmark <count 1..4> <payloadMiB 1..200>"); return 2; }
        var mode = Environment.GetEnvironmentVariable("LEDGETOP_MEMBENCH_MODE");
        if (mode is not ("memory" or "standard")) { Console.WriteLine("LEDGETOP_MEMBENCH_MODE must be memory or standard."); return 2; }
        var deadlineSeconds = int.TryParse(Environment.GetEnvironmentVariable("LEDGETOP_MEMBENCH_DEADLINE_S"), out var d) ? d : 240;
        if (deadlineSeconds is < 30 or > 900) { Console.WriteLine("LEDGETOP_MEMBENCH_DEADLINE_S must be 30..900."); return 2; }
        var basePath = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        if (string.IsNullOrWhiteSpace(basePath) || !Path.IsPathFullyQualified(basePath) || basePath.StartsWith(@"\\", StringComparison.Ordinal))
        { Console.WriteLine("LEDGETOP_TEST_ARTIFACT_ROOT must be a local absolute folder."); return 2; }
        var executable = Environment.ProcessPath ?? throw new IOException("Self-contained test apphost required.");
        if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) throw new IOException("Use the self-contained test apphost.");

        var length = (long)mib * 1024 * 1024;
        var id = Guid.NewGuid();
        var fixture = Path.Combine(Path.GetFullPath(basePath), "membench-fixtures", id.ToString("N"));
        if (Directory.Exists(fixture)) throw new IOException("Fixture already exists.");
        var root = Path.Combine(fixture, "Files"); var cache = Path.Combine(fixture, "Cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        Console.WriteLine($"MEMBENCH start: fixture={fixture}; mode={mode}; count={count}; payloadBytes={length}; deadlineS={deadlineSeconds}; pid={Environment.ProcessId}");

        var manifest = new Dictionary<string, PlaceholderIdentity>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < count; i++) {
            var sha = Convert.ToHexStringLower(Generated.Digest(Seed(i), length));
            manifest[$"bench-{i}.bin"] = new("pilot", "synthetic", Origin.GetLeftPart(UriPartial.Authority), Principal, "odqr1_mb" + i,
                "oef1_" + new string((char)('a' + i), 64), sha, $"bench-{i}.bin", length, "\"" + sha + "\"", sha);
        }
        Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_HYDRATION", mode == "memory" ? "1" : "0");
#if LEDGETOP_NATIVE_DIAGNOSTICS
        var trace = NativeStallTrace.Enable();
#endif
        NativeRootRegistration? registration = null; NativePlaceholderProvider? provider = null;
        using var source = new BenchSource(manifest.Values, length, memory: mode == "memory");
        var readers = new List<(Process Process, string File, Task<string> Out, Task<string> Err)>();
        bool success = false, readersJoined = true, disposeCompleted = false, unregisterVerified = false;
        long readerWallMs = -1;
        try {
            registration = NativeRootRegistration.Register(root, Encoding.UTF8.GetBytes("LedgeTop.Files.MemoryHydrationBenchmark.v1:" + id.ToString("N")));
            provider = new NativePlaceholderProvider(registration, cache, source, "pilot", Principal, manifest, []);
            provider.Activity += message => { if (message.StartsWith("Hydration timing:", StringComparison.Ordinal)) Console.WriteLine("MEMBENCH activity: " + message); };
            await provider.ConnectAndPopulateAsync();
            var clock = Stopwatch.StartNew();
            for (var i = 0; i < count; i++) {
                var name = $"bench-{i}.bin";
                var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                info.ArgumentList.Add("--memory-hydration-benchmark-reader"); info.ArgumentList.Add(Path.Combine(root, name));
                info.ArgumentList.Add(Seed(i).ToString()); info.ArgumentList.Add(length.ToString());
                var reader = Process.Start(info) ?? throw new IOException("Reader did not start.");
                readers.Add((reader, name, reader.StandardOutput.ReadToEndAsync(), reader.StandardError.ReadToEndAsync()));
            }
            var all = Task.WhenAll(readers.Select(r => r.Process.WaitForExitAsync()));
            try { await all.WaitAsync(TimeSpan.FromSeconds(deadlineSeconds)); }
            catch (TimeoutException) { Console.WriteLine($"MEMBENCH readers: outcome=deadline; deadlineS={deadlineSeconds}"); }
            readerWallMs = (long)clock.Elapsed.TotalMilliseconds;
            var matched = 0;
            foreach (var r in readers) {
                if (!r.Process.HasExited) {
                    try { r.Process.Kill(entireProcessTree: true); await r.Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
                    catch { readersJoined = false; }
                }
                var stdout = r.Out.IsCompleted ? (await r.Out).Trim() : "<not-drained>";
                var stderr = r.Err.IsCompleted ? (await r.Err).Trim() : "<not-drained>";
                var exit = r.Process.HasExited ? r.Process.ExitCode : -1;
                Console.WriteLine($"MEMBENCH reader-captured: file={r.File}; pid={r.Process.Id}; exit={exit}; stdout={stdout}; stderr={stderr}");
                // Independent check: the captured digest must equal this file's manifest SHA, not just "matched".
                var expected = manifest[r.File].Sha256;
                if (exit == 0 && stdout.Contains("sha256=" + expected + ";", StringComparison.Ordinal) && stdout.Contains("matched=True", StringComparison.Ordinal)) matched++;
            }
            success = readersJoined && matched == count;
        } catch (Exception error) {
            Console.WriteLine($"MEMBENCH error: {error.GetType().Name}: {error.Message}");
        } finally {
            if (provider is null) disposeCompleted = true;
            else try { await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(30)); disposeCompleted = true; } catch { }
            if (registration is not null && readersJoined && disposeCompleted && provider?.SyntheticCommittedCleanupUncertain != true)
                try { registration.Unregister(); unregisterVerified = true; } catch { }
            foreach (var r in readers) r.Process.Dispose();
        }
#if LEDGETOP_NATIVE_DIAGNOSTICS
        var stages = NativeStallTrace.Snapshot(trace).GroupBy(e => e.Kind).OrderBy(g => g.Key.ToString(), StringComparer.Ordinal)
            .Select(g => g.Key + "=" + g.Count());
        Console.WriteLine("MEMBENCH trace-stages: " + string.Join(",", stages) + $"; dropped={NativeStallTrace.Dropped(trace)}");
#endif
        var parentPeakMiB = Process.GetCurrentProcess().PeakWorkingSet64 / (1024 * 1024);
        if (!unregisterVerified) success = false;
        Console.WriteLine($"MEMBENCH summary: mode={mode}; success={success}; readersJoined={readersJoined}; readerWallMs={readerWallMs}; " +
            $"memoryAttempts={PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest}; memoryHydrations={PlaceholderHydrationCoordinator.MemoryHydrationsForTest}; " +
            $"standardDownloads={source.StandardDownloads}; memoryDownloads={source.MemoryDownloads}; parentPeakWorkingSetMiB={parentPeakMiB}; " +
            $"disposeCompleted={disposeCompleted}; unregisterVerified={unregisterVerified}; fixtureRetained=True; fixture={fixture}");
        return success ? 0 : 1;
    }

    internal static int Reader(string[] args)
    {
        if (args.Length != 4 || !uint.TryParse(args[2], out var seed) || !long.TryParse(args[3], out var length) || length <= 0) return 2;
        var clock = Stopwatch.StartNew();
        try {
            using var actual = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long read = 0; var buffer = new byte[1024 * 1024];
            using (var stream = new FileStream(args[1], FileMode.Open, FileAccess.Read, FileShare.Read, 1, FileOptions.SequentialScan)) {
                int n;
                while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) { actual.AppendData(buffer, 0, n); read += n; }
            }
            var digest = Convert.ToHexStringLower(actual.GetHashAndReset());
            var expected = Convert.ToHexStringLower(Generated.Digest(seed, length));
            var matched = read == length && digest == expected;
            Console.WriteLine($"file={Path.GetFileName(args[1])}; bytes={read}; sha256={digest}; expected={expected}; matched={matched}; elapsedMs={clock.ElapsedMilliseconds}; peakWorkingSetMiB={Process.GetCurrentProcess().PeakWorkingSet64 / (1024 * 1024)}");
            return matched ? 0 : 1;
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException) {
            Console.WriteLine($"file={Path.GetFileName(args[1])}; outcome={error.GetType().Name}; hresult=0x{error.HResult:X8}; elapsedMs={clock.ElapsedMilliseconds}");
            return 1;
        }
    }

    private static uint Seed(int index) => 0x9E3779B9u ^ (uint)(index * 0x85EBCA6B + 1);

    /// <summary>Deterministic xorshift32 byte generator; never materializes the payload.</summary>
    internal sealed class Generated(uint seed, long length) : Stream
    {
        private uint state = seed == 0 ? 1 : seed; private long position;
        internal static byte[] Digest(uint seed, long length) {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); using var stream = new Generated(seed, length);
            var buffer = new byte[1024 * 1024]; int n; while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) hash.AppendData(buffer, 0, n);
            return hash.GetHashAndReset();
        }
        public override int Read(byte[] buffer, int offset, int count) {
            var n = (int)Math.Min(count, length - position);
            for (var i = 0; i < n; i++) { state ^= state << 13; state ^= state >> 17; state ^= state << 5; buffer[offset + i] = (byte)state; }
            position += n; return n;
        }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => length; public override long Position { get => position; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long o, SeekOrigin s) => throw new NotSupportedException();
        public override void SetLength(long v) => throw new NotSupportedException();
        public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();
    }

    /// <summary>Standard #504 cache path (DownloadVerifiedForHydrationAsync, no experimental owned stream) or memory path,
    /// selected once per run; both use the real Downloader against a generated in-memory handler.</summary>
    private sealed class BenchSource : IQueuedDownloadSource, IVerifiedHydrationDownloadSource, IMemoryHydrationDownloadSource, IHydrationMutationAwareSource, IDisposable
    {
        private readonly Dictionary<string, PlaceholderIdentity> identities;
        private readonly Downloader downloader;
        private readonly bool memory;
        private int standardDownloads, memoryDownloads;
        internal int StandardDownloads => Volatile.Read(ref standardDownloads);
        internal int MemoryDownloads => Volatile.Read(ref memoryDownloads);
        internal BenchSource(IEnumerable<PlaceholderIdentity> manifest, long length, bool memory) {
            identities = manifest.ToDictionary(v => v.ResourceReference, StringComparer.Ordinal); this.memory = memory;
            var bySha = identities.Values.Select((v, i) => (v.Sha256, Seed: Seed(int.Parse(v.FileName["bench-".Length..^".bin".Length])))).ToDictionary(p => p.Sha256, p => p.Seed);
            downloader = new Downloader(new Handler(bySha, length), [Origin]);
        }
        public string Alias => "synthetic";
        Uri IQueuedDownloadSource.Origin => Origin;
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        bool IMemoryHydrationDownloadSource.SupportsMemoryHydration => memory;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) =>
            Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddMinutes(30)));
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            token.ThrowIfCancellationRequested();
            if (!identities.TryGetValue(reference, out var id)) throw new ResourceUnavailableException();
            var spec = new DownloadSpec(id.LogicalFileId + ":" + id.RemoteVersion, new Uri(Origin, "/membench/" + id.Sha256), id.FileName, id.Length, id.ETag, id.Sha256);
            return Task.FromResult(new ResolvedQueuedDownload(Principal, id.LogicalFileId, id.RemoteVersion, spec));
        }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken token = default) =>
            downloader.DownloadAsync(spec, destination, token, progress);
        async Task<VerifiedHydrationDownload> IVerifiedHydrationDownloadSource.DownloadForHydrationAsync(DownloadSpec spec, string destination, CancellationToken token) {
            var result = await downloader.DownloadVerifiedForHydrationAsync(spec, destination, token).ConfigureAwait(false);
            Interlocked.Increment(ref standardDownloads); return result;
        }
        async Task<byte[]> IMemoryHydrationDownloadSource.DownloadVerifiedToMemoryAsync(DownloadSpec spec, long maximumBytes, CancellationToken token) {
            var result = await downloader.DownloadVerifiedToMemoryAsync(spec, maximumBytes, token).ConfigureAwait(false);
            Interlocked.Increment(ref memoryDownloads); return result;
        }
        public void Dispose() => downloader.Dispose();

        private sealed class Handler(Dictionary<string, uint> bySha, long length) : HttpMessageHandler {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
                token.ThrowIfCancellationRequested();
                var path = request.RequestUri?.AbsolutePath ?? "";
                if (request.Method != HttpMethod.Get || request.RequestUri?.Host != Origin.Host || !path.StartsWith("/membench/", StringComparison.Ordinal) ||
                    request.Headers.Range is not null || request.Headers.IfMatch.Count != 1)
                    throw new IOException("Benchmark request scope mismatch.");
                var sha = path["/membench/".Length..];
                if (!bySha.TryGetValue(sha, out var seed) || request.Headers.IfMatch.Single().ToString() != "\"" + sha + "\"")
                    throw new IOException("Benchmark request version mismatch.");
                var content = new StreamContent(new Generated(seed, length), 1024 * 1024);
                content.Headers.ContentLength = length;
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
                response.Headers.ETag = new EntityTagHeaderValue("\"" + sha + "\"");
                return Task.FromResult(response);
            }
        }
    }
}
#endif
