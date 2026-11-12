using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class CompanyHydrationSourceGateTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Other = "odqp1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly byte[] Bytes = new byte[8192];
    private static string Sha => Convert.ToHexStringLower(SHA256.HashData(Bytes));
    internal static async Task<int> RunAsync()
    {
#if LEDGETOP_MEMORY_HYDRATION
        // Experimental memory build: the same cases run through the memory branch (gate -> lifetime -> employee all
        // forward it). Every staged buffer the coordinator releases or the downloader discards must be wiped.
        var staged = new List<byte[]>();
        PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = staged.Add; Downloader.MemoryStagingDiscardedForTest = staged.Add;
        try {
#endif
        foreach (var mode in new[] { "success", "unknown-source", "beforePrincipal", "before401", "after403", "afterPrincipal", "afterExpiry", "pause", "pause-resume", "caller-cancel", "generation-cancel" }) {
            var root = NewFixture(); var binary = Path.Combine(root, "synthetic-never-executed.bin"); File.WriteAllText(binary, "synthetic pinned helper bytes");
            using var generation = new CancellationTokenSource(); using var caller = new CancellationTokenSource();
            var runner = new Runner(); var access = new CloudflareAccessSession(new Uri("https://company.invalid/portal"), binary, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(binary))), runner);
            var sessions = 0; var resolves = 0; var downloads = 0;
            ExplorerSourceGate? gate = null;
            using var employee = new EmployeeQueuedDownloadSource("employee", access, new Handler(async (request, _) => {
                Require(request.Headers.GetValues("Cf-Access-Token").Single() == runner.Token);
                if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal)) {
                    sessions++; return Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds() });
                }
                Require(request.RequestUri.AbsolutePath == "/api/staff/files/queue/resolve"); resolves++;
                if (mode == "before401") return new(HttpStatusCode.Unauthorized);
                if (downloads != 0 && mode == "after403") return new(HttpStatusCode.Forbidden);
                var principal = mode == "beforePrincipal" || downloads != 0 && mode == "afterPrincipal" ? Other : Principal;
                var expires = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + (downloads != 0 && mode == "afterExpiry" ? 5 : 600);
                var result = Json(new { schemaVersion = 1, principalId = principal, manifest = new {
                    schemaVersion = 1, logicalFileId = "oef1_" + new string('c', 64), remoteVersion = Sha, strongETag = "\"" + Sha + "\"",
                    size = Bytes.Length, sha256 = Sha, name = "sample.bin", downloadPath = "/api/staff/files/downloads/eof1_synthetic", expiresAt = expires
                } });
                if (mode == "pause-resume" && downloads == 0) { gate!.Pause(); await gate.ResumeAsync(); }
                return result;
            }), new Downloader(new Handler((request, _) => {
                downloads++;
                if (mode == "pause") gate!.Pause();
                if (mode == "caller-cancel") caller.Cancel();
                if (mode == "generation-cancel") generation.Cancel();
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
            }), [access.Origin], session: access));
            IQueuedDownloadSource candidate = mode == "unknown-source" ? new UnknownSource(employee) : employee;
            var scoped = new LifetimeQueuedDownloadSource(candidate, generation.Token);
            using var ownedGate = gate = new ExplorerSourceGate(scoped, new("pilot", "employee", access.Origin.GetLeftPart(UriPartial.Authority), Principal));
            await gate.ResumeAsync(); Require(sessions == 1); sessions = 0;
            using var coordinator = new PlaceholderHydrationCoordinator(gate, "pilot", root, expectedPrincipal: Principal);
            var id = new PlaceholderIdentity("pilot", "employee", access.Origin.GetLeftPart(UriPartial.Authority), Principal, "odqr1_synthetic", "oef1_" + new string('c', 64), Sha, "sample.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
            var sink = new Sink(); var failed = false;
#if LEDGETOP_MEMORY_HYDRATION
            var attemptsBefore = PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest; staged.Clear();
#endif
            try {
                if (mode is "success" or "unknown-source") {
                    await using var dispatcher = new CloudFilesCallbackDispatcher(gate, "pilot", Principal, 42, root,
                        (core, identity, context, token) => core.HydrateAsync(identity, context.RequiredOffset, context.RequiredLength, sink, token));
                    await dispatcher.FetchDataAsync(id.Encode(), new(42, 100, 1, id.Length, 0, id.Length));
                } else await coordinator.HydrateAsync(id, 0, id.Length, sink, caller.Token);
            }
            catch (Exception error) when (error is TransferException or OperationCanceledException) { failed = true; }
            if (mode is "success" or "unknown-source") Require(!failed && sink.Bytes == Bytes.Length && sink.Completed == 1 && sink.Failed == 0 && resolves == 2 && downloads == 1 && sessions == (mode == "success" ? 0 : 4));
            else Require(failed && sink.Bytes == 0 && sink.Completed == 0 && sink.Failed == 1 && sessions == (mode == "pause-resume" ? 1 : 0));
            Require(runner.Logins == 0);
#if LEDGETOP_MEMORY_HYDRATION
            // Unknown sources do not forward memory support; every other case must have entered the memory branch.
            var entered = PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest - attemptsBefore;
            if (entered != (mode == "unknown-source" ? 0 : 1)) throw new IOException($"Memory branch entry for {mode} was {entered}.");
            // Pause, epoch change (pause-resume, refused at resolve before any download), cancellation and revocation
            // deliver no bytes and leave only wiped buffers.
            if (staged.Any(buffer => buffer.Any(b => b != 0))) throw new IOException($"Staged buffer for {mode} was not wiped.");
            if (mode is not ("success" or "unknown-source" or "before401" or "beforePrincipal" or "pause-resume") && staged.Count == 0) throw new IOException($"No staged buffer observed for {mode}.");
            Console.WriteLine($"Memory gate case: mode={mode}; entered={entered}; stagedBuffers={staged.Count}; wiped=True; sinkBytes={sink.Bytes}");
#endif
            File.WriteAllText(Path.Combine(root, "fixture-receipt.json"), JsonSerializer.Serialize(new { mode, sessions, resolves, downloads, sinkBytes = sink.Bytes, nativeOrNetwork = false }));
        }
        Console.WriteLine("PASS Company HTTP + lifetime + source-gate: 11 synthetic cases; no helper/network/native/provider operations.");
#if LEDGETOP_MEMORY_HYDRATION
        } finally { PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = null; Downloader.MemoryStagingDiscardedForTest = null; }
#endif
        return 0;
    }
    private static void Require(bool ok) { if (!ok) throw new IOException("Company source-gate contract failed."); }
    private sealed class UnknownSource(IQueuedDownloadSource inner) : IQueuedDownloadSource {
        public string Alias => inner.Alias; public Uri Origin => inner.Origin;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => inner.GetSessionAsync(token);
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) => inner.ResolveAsync(reference, token);
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken token = default) => inner.DownloadAsync(spec, destination, progress, token);
    }
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
    private sealed class Sink : IPlaceholderTransferSink {
        internal long Bytes; internal int Completed, Failed;
        public Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) { Bytes += bytes.Length; return Task.CompletedTask; }
        public Task CompleteAsync(CancellationToken token) { Completed++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; return Task.CompletedTask; }
    }
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> run) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => run(request, token);
    }
    private sealed class Runner : IAccessCommandRunner {
        internal int Logins;
        internal readonly string Token = "e30." + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { exp = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds() })).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c2ln";
        public Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> args, CancellationToken token) { if (args.Contains("login")) Logins++; return Task.FromResult(new AccessCommandResult(0, Token, "")); }
    }
    private static string NewFixture() {
        var selected = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? Path.Combine(AppContext.BaseDirectory, "test-artifacts");
        if (!Path.IsPathFullyQualified(selected) || selected.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Dedicated local artifacts required.");
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(selected));
        if (full == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!)) throw new IOException("Dedicated artifacts required.");
        for (var part = full; part is not null; part = Path.GetDirectoryName(part)) {
            try { var attrs = File.GetAttributes(part); if ((attrs & FileAttributes.ReparsePoint) != 0 || (attrs & FileAttributes.Directory) == 0) throw new IOException("Alias artifacts refused."); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
        }
        var root = Path.Combine(full, "company-source-gate-" + Guid.NewGuid().ToString("N"));
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("Fresh fixture required.");
        Directory.CreateDirectory(root); return root;
    }
}
