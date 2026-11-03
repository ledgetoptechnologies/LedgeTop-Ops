#if LEDGETOP_CACHE_RACE_TEST
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class ExperimentalColdDownloaderTests
{
    private static readonly byte[] Content = "experimental-synthetic-download"u8.ToArray();
    private static readonly byte[] Foreign = "do-not-replace"u8.ToArray();
    private static readonly Uri Origin = new("https://experimental.example.invalid");
    private static DownloadSpec Spec => new("synthetic-only", new Uri(Origin, "/data"), "output.bin", Content.Length, "\"v1\"", Convert.ToHexStringLower(SHA256.HashData(Content)));
    private static void Check(bool value) { if (!value) throw new IOException("Experimental cold download assertion failed."); }
    private static HttpResponseMessage Response(byte[] bytes, Stream? input = null) {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(input ?? new MemoryStream(bytes)) };
        response.Headers.ETag = new EntityTagHeaderValue("\"v1\""); response.Content.Headers.ContentLength = Content.Length; return response;
    }
    private static Downloader Engine(Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> handler) =>
        new(new FakeHandler(handler), [Origin]) { ExperimentalColdOwnedStreamForTest = true };
    private static async Task ExpectTransferFailure(Task task) {
        try { await task; } catch (TransferException) { return; }
        throw new IOException("Experimental transfer should fail closed.");
    }
    private static async Task RunOwnedFixtureAsync(Func<Task> body, Func<int> quarantined, Action cleanup, Action preserve)
    {
        var completed = false;
        try { await body(); completed = true; }
        finally {
            if (completed && quarantined() == 0) cleanup();
            else preserve();
        }
    }
    private static Task WithFixture(Func<DirectoryFixture, Task> body)
    {
        if (ExperimentalOwnedStream.QuarantinedCountForTest != 0) throw new IOException("An experimental owner is already quarantined; no new fixture was created.");
        var root = new DirectoryFixture();
        return RunOwnedFixtureAsync(() => body(root), () => ExperimentalOwnedStream.QuarantinedCountForTest,
            () => { try { root.Dispose(); } catch { Console.Error.WriteLine("Synthetic experimental Downloader cleanup incomplete: " + root.Path); throw; } },
            () => Console.Error.WriteLine("Synthetic experimental Downloader fixture preserved: " + root.Path));
    }
    private static async Task FixturePolicyTests()
    {
        var cleaned = 0; var preserved = 0;
        void Cleanup() => cleaned++;
        void Preserve() => preserved++;
        var rejected = false;
        try { await RunOwnedFixtureAsync(() => throw new IOException("Injected test failure."), () => 0, Cleanup, Preserve); }
        catch (IOException) { rejected = true; }
        Check(rejected && cleaned == 0 && preserved == 1);
        await RunOwnedFixtureAsync(() => Task.CompletedTask, () => 1, Cleanup, Preserve);
        Check(cleaned == 0 && preserved == 2);
        await RunOwnedFixtureAsync(() => Task.CompletedTask, () => 0, Cleanup, Preserve);
        Check(cleaned == 1 && preserved == 2);
    }
    internal static async Task RunAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        await FixturePolicyTests();
        await WithFixture(async root => {
            var calls = 0;
            using var downloader = Engine((request, _) => {
                calls++; Check(request.Method == HttpMethod.Get && request.Headers.IfMatch.Single().ToString() == Spec.ETag && request.Headers.Range is null);
                return Response(Content);
            });
            await using (var result = await downloader.DownloadVerifiedForHydrationAsync(Spec, root.Path)) {
                Check(!result.Stream.CanWrite && result.IntegrityVerified);
                var actual = new byte[Content.Length]; await result.Stream.ReadExactlyAsync(actual);
                Check(actual.SequenceEqual(Content));
                var blocked = false; try { result.Stream.Write(Content); } catch (NotSupportedException) { blocked = true; }
                Check(blocked && calls == 1);
            }
            Check(File.ReadAllBytes(Path.Combine(root.Path, "output.bin")).SequenceEqual(Content));
        });
        await WithFixture(async root => {
            using var downloader = Engine((_, _) => { File.WriteAllBytes(Path.Combine(root.Path, "output.bin"), Foreign); return Response(Content); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(File.ReadAllBytes(Path.Combine(root.Path, "output.bin")).SequenceEqual(Foreign));
            Check(Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single() is var part && File.ReadAllBytes(part).SequenceEqual(Content));
        });
        await WithFixture(async root => {
            var corrupt = Content.ToArray(); corrupt[0] ^= 1; var calls = 0;
            using var downloader = Engine((_, _) => { calls++; return Response(corrupt); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(corrupt));
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(calls == 1 && File.ReadAllBytes(part).SequenceEqual(corrupt)); // resume is explicitly unsupported
        });
        await WithFixture(async root => {
            using var cancel = new CancellationTokenSource();
            using var downloader = Engine((_, _) => Response(Content, new CancelAfterPrefix(Content, cancel)));
            var cancelled = false;
            try { await downloader.DownloadAsync(Spec, root.Path, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
            Check(cancelled && !File.Exists(Path.Combine(root.Path, "output.bin")));
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            Check(File.ReadAllBytes(part).SequenceEqual(Content[..4]));
        });
        await WithFixture(async root => {
            using var downloader = Engine((_, _) => { var response = Response(Content); response.Headers.ETag = new EntityTagHeaderValue("\"wrong\""); return response; });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && !Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Any());
        });
        await WithFixture(async root => {
            var empty = Spec with { Length = 0, Sha256 = Convert.ToHexStringLower(SHA256.HashData(Array.Empty<byte>())) };
            using var downloader = Engine((_, _) => { var response = Response([]); response.Content.Headers.ContentLength = 0; return response; });
            await using var result = await downloader.DownloadVerifiedForHydrationAsync(empty, root.Path);
            Check(result.Stream.Length == 0 && result.IntegrityVerified && !result.Stream.CanWrite);
        });
        foreach (var oversized in new[] { false, true }) {
            await WithFixture(async root => {
                var body = oversized ? Content.Concat(new byte[] { 42 }).ToArray() : Content[..^1];
                using var downloader = Engine((_, _) => Response(body));
                await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
                Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(oversized ? Content : body));
            });
        }
        foreach (var cancelAtHash in new[] { true, false }) {
            await WithFixture(async root => {
                using var cancel = new CancellationTokenSource();
                using var downloader = Engine((_, _) => Response(Content));
                if (cancelAtHash) ExperimentalOwnedStream.BeforeSealHashTestHook = cancel.Cancel;
                else Downloader.BeforeExperimentalPromotionTestHook = cancel.Cancel;
                try {
                    var cancelled = false;
                    try { await downloader.DownloadAsync(Spec, root.Path, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
                    var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
                    Check(cancelled && !File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(Content));
                } finally {
                    ExperimentalOwnedStream.BeforeSealHashTestHook = null; Downloader.BeforeExperimentalPromotionTestHook = null;
                }
            });
        }
        await WithFixture(async root => {
            using var downloader = Engine((_, _) => Response(Content));
            Downloader.BeforeExperimentalHandoffTestHook = () => throw new IOException("Synthetic handoff failure.");
            try {
                await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                Check(File.ReadAllBytes(Path.Combine(root.Path, "output.bin")).SequenceEqual(Content) &&
                    !Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Any() && ExperimentalOwnedStream.QuarantinedCountForTest == 0);
            } finally { Downloader.BeforeExperimentalHandoffTestHook = null; }
        });
        await WithFixture(async root => {
            using var source = new CoordinatorSource();
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", root.Path, expectedPrincipal: CoordinatorSource.Principal);
            var failed = new TestSink(); var reached = false;
            Downloader.BeforeExperimentalHandoffTestHook = () => { reached = true; throw new IOException("Synthetic handoff failure."); };
            try {
                await ExpectTransferFailure(coordinator.HydrateAsync(source.Identity, 0, Content.Length, failed));
                Check(reached && failed.Failed == 1 && failed.Completed == 0 && failed.Bytes.Length == 0);
            } finally { Downloader.BeforeExperimentalHandoffTestHook = null; }
            var reservationDir = Path.Combine(root.Path, "verified-hydration-v1", ".hydration-reservations-v2");
            Check(!Directory.EnumerateFiles(reservationDir, "*.json").Any() && ExperimentalOwnedStream.QuarantinedCountForTest == 0);
            var commandLock = Directory.EnumerateFiles(root.Path, "*.lock", SearchOption.AllDirectories)
                .Single(path => Path.GetFileName(Path.GetDirectoryName(path)) == ".ltds-downloads-v1");
            Check(Path.GetFullPath(commandLock).Length > 260); // same hierarchy/name length as the experimental partial
            var retried = new TestSink();
            try { await coordinator.HydrateAsync(source.Identity, 0, Content.Length, retried); }
            catch (TransferException error) { throw new IOException("Synthetic cache retry failed: " + error.HydrationFailure?.ActivityText, error); }
            Check(retried.Completed == 1 && retried.Failed == 0 && retried.Bytes.ToArray().SequenceEqual(Content) && source.Downloads == 1);
        });
        Console.WriteLine("PASS gated synthetic cold Downloader: empty, EOF, overflow, digest, collision, cancellation, handoff and coordinator recovery.");
    }
    private sealed class CancelAfterPrefix(byte[] data, CancellationTokenSource source) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            if (Position == 0) return ValueTask.FromResult(Read(buffer.Span[..Math.Min(buffer.Length, 4)]));
            source.Cancel(); throw new OperationCanceledException(token);
        }
    }
    private sealed class TestSink : IPlaceholderTransferSink
    {
        internal int Completed, Failed; internal MemoryStream Bytes { get; } = new();
        public Task WriteAsync(long offset, ReadOnlyMemory<byte> data, CancellationToken token) { token.ThrowIfCancellationRequested(); Bytes.Position = offset; Bytes.Write(data.Span); return Task.CompletedTask; }
        public Task CompleteAsync(CancellationToken token) { Completed++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; return Task.CompletedTask; }
    }
    private sealed class CoordinatorSource : IQueuedDownloadSource, IHydrationMutationAwareSource, IVerifiedHydrationDownloadSource, IDisposable
    {
        internal static readonly string Principal = "odqp1_" + new string('a', 64);
        internal readonly PlaceholderIdentity Identity = new("pilot", "synthetic", ExperimentalColdDownloaderTests.Origin.GetLeftPart(UriPartial.Authority), Principal,
            "odqr1_test", "oef1_" + new string('b', 64), "v1", Spec.FileName, Spec.Length, Spec.ETag, Spec.Sha256);
        private readonly Downloader downloader; internal int Downloads;
        internal CoordinatorSource() => downloader = Engine((_, _) => { Downloads++; return Response(Content); });
        public string Alias => "synthetic"; public Uri Origin => ExperimentalColdDownloaderTests.Origin;
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddMinutes(5)));
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            if (reference != Identity.ResourceReference) throw new ResourceUnavailableException();
            return Task.FromResult(new ResolvedQueuedDownload(Principal, Identity.LogicalFileId, Identity.RemoteVersion,
                Spec with { OpaqueIdentity = Identity.LogicalFileId + ":" + Identity.RemoteVersion }));
        }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => downloader.DownloadAsync(spec, destination, cancellationToken, progress);
        Task<VerifiedHydrationDownload> IVerifiedHydrationDownloadSource.DownloadForHydrationAsync(DownloadSpec spec, string destination, CancellationToken token) => downloader.DownloadVerifiedForHydrationAsync(spec, destination, token);
        public void Dispose() => downloader.Dispose();
    }
}
#endif
