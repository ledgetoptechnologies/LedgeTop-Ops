using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Synthetic transport and native Windows CFAPI only: no network, credentials or production grants.
internal static class SyntheticBusyNative {
    static readonly byte[] Bytes = Encoding.UTF8.GetBytes(new string('x', 100_000));
    static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    static readonly string Principal = "odqp1_" + new string('f', 64);
    static void Need(bool b, string message) { if (!b) throw new IOException(message); }
    static async Task<bool> Denied(Task<byte[]> t) { try { await t.WaitAsync(TimeSpan.FromSeconds(20)); return false; } catch (IOException) { return true; } }
    internal static async Task<int> RunAsync(bool dedicatedReaders = false) {
        var basePath = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Need task artifact root.");
        var id = Guid.NewGuid(); var owned = Path.Combine(basePath, "busy-fixtures", id.ToString("N"));
        var root = Path.Combine(owned, "Files"); var cache = Path.Combine(owned, "Cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        var binary = Path.Combine(owned, "synthetic-token-helper.bin"); await File.WriteAllTextAsync(binary, "synthetic; never executed");
        var session = new CloudflareAccessSession(new Uri("https://source.example.invalid/portal/"), binary,
            Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(binary))), new Runner());
        var state = new State();
        var entries = Enumerable.Range(0,4).Select(i => {
            var name = $"sample-{i}.bin"; var reference = "odqr1_" + i; var logical = "oef1_" + new string((char)('a' + i),64);
            return new PlaceholderIdentity("pilot", "staff", "https://source.example.invalid", Principal, reference, logical, Sha, name, Bytes.Length, "\"" + Sha + "\"", Sha);
        }).ToArray();
        state.Entries = entries.ToDictionary(e => e.ResourceReference, StringComparer.Ordinal);
        using var source = new EmployeeQueuedDownloadSource("staff", session, new Metadata(state), new Downloader(new Data(state), [session.Origin], session:session));
        IPreviewRootRegistration? registration = null; NativePlaceholderProvider? provider = null; var phases = new List<string>(); var failures = new List<string>();
        try {
            registration = NativeRootRegistration.Register(root, Encoding.UTF8.GetBytes("LedgeTop.Files.BusyNativeTest.v1:" + id));
            var manifest = entries.ToDictionary(e => e.FileName, StringComparer.OrdinalIgnoreCase);
            provider = new NativePlaceholderProvider(registration, cache, source, "pilot", Principal, manifest, []);
            provider.Activity += message => Console.WriteLine(message);
            await provider.ConnectAndPopulateAsync();
            state.Mode = "timed"; state.BusyClock = System.Diagnostics.Stopwatch.StartNew();
            if (dedicatedReaders) Console.WriteLine("Using four dedicated threads to start file reads.");
            await using var diagnostics = new BusyReadDiagnostics(TimeSpan.FromSeconds(1), 26, Console.WriteLine);
            Task<byte[]> Read(PlaceholderIdentity e) {
                diagnostics.RecordReadStart(e.FileName);
                return File.ReadAllBytesAsync(Path.Combine(root,e.FileName));
            }
            var reads = entries.Select(e => dedicatedReaders
                ? StartDedicated(() => Read(e)) : Task.Run(() => Read(e))).ToArray();
            var allReads = Task.WhenAll(reads);
            diagnostics.Start(() => !allReads.IsCompleted);
            byte[][] contents;
            try { contents = await allReads.WaitAsync(TimeSpan.FromSeconds(25)); }
            finally { await diagnostics.StopAsync(); }
            Need(contents.All(x => SHA256.HashData(x).SequenceEqual(SHA256.HashData(Bytes))), "Busy retry changed content.");
            Need(state.BusyClock.Elapsed >= TimeSpan.FromSeconds(3), "Expected a three-second busy interval.");
            Need(entries.All(e => state.BusyResponses.GetValueOrDefault(e.ResourceReference) >= 1 &&
                state.Attempts.GetValueOrDefault(e.ResourceReference) > state.BusyResponses.GetValueOrDefault(e.ResourceReference)),
                "Each file must receive a busy response and a later successful retry.");
            phases.Add("four native files opened after a three-second 503 busy interval and passed SHA-256 checks");
            await provider.FreeSpaceAsync(entries[0].FileName);
            state.Attempts.Clear(); state.Downloaded = 0; state.Mode = "revoke";
            Need(await Denied(Task.Run(() => File.ReadAllBytesAsync(Path.Combine(root,entries[0].FileName)))), "Post-download denial delivered bytes.");
            Need(state.Downloaded == 1 && state.Attempts.GetValueOrDefault(entries[0].ResourceReference) >= 4, $"Expected busy, success, download, busy, denial; downloads={state.Downloaded}, attempts={state.Attempts.GetValueOrDefault(entries[0].ResourceReference)}.");
            Need(((uint)provider.InspectAttributes(entries[0].FileName) & 0x1000) != 0, "Denied file ceased being online only.");
            phases.Add("post-download 503 then revocation denied native file open and retained online-only state");
            await provider.FreeSpaceAsync(entries[1].FileName);
            state.Attempts.Clear(); state.BusySeen = new(TaskCreationOptions.RunContinuationsAsynchronously); state.Mode = "cancel";
            var blocked = Task.Run(() => File.ReadAllBytesAsync(Path.Combine(root,entries[1].FileName)));
            await state.BusySeen.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(20)); provider = null;
            Need(await Denied(blocked), "Cancelled busy read unexpectedly succeeded.");
            Need(state.Attempts.GetValueOrDefault(entries[1].ResourceReference) == 1, "A retry ran after cancellation.");
            phases.Add("provider stop cancels an outstanding busy retry and joins callback work");
        } catch (Exception e) { failures.Add(e.GetType().Name + ": " + e.Message); Console.Error.WriteLine(e); }
        finally {
            var safe = true;
            if (provider != null) try { await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(20)); } catch (Exception e) { safe=false; failures.Add("Dispose: " + e.Message); }
            if (registration != null && safe) try { registration.Unregister(); phases.Add("exact owned registration removed and absence verified"); } catch(Exception e) { failures.Add("Unregister: " + e.Message); }
            await File.WriteAllTextAsync(Path.Combine(owned,"receipt.json"), JsonSerializer.Serialize(new { id, phases, failures, synthetic=true }, new JsonSerializerOptions{WriteIndented=true}));
        }
        Console.WriteLine(JsonSerializer.Serialize(new { passed = failures.Count==0, phases, failures, receipt=Path.Combine(owned,"receipt.json") }));
        return failures.Count == 0 ? 0 : 1;
    }
    private static Task<T> StartDedicated<T>(Func<Task<T>> operation) =>
        Task.Factory.StartNew(operation, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();
    private sealed class BusyReadDiagnostics(TimeSpan interval, int maxSamples, Action<string> report, TimeSpan? maximumLifetime = null) : IAsyncDisposable {
        private readonly System.Diagnostics.Stopwatch elapsed = System.Diagnostics.Stopwatch.StartNew();
        private readonly CancellationTokenSource stop = new();
        private Task? watchdog;
        internal bool IsStopped => watchdog?.IsCompleted ?? true;
        private void Sample(string phase) {
            ThreadPool.GetMinThreads(out var minimum, out _);
            ThreadPool.GetAvailableThreads(out var available, out _);
            report($"Busy diagnostics: {phase}; elapsedMs={elapsed.ElapsedMilliseconds}; thread={Environment.CurrentManagedThreadId}; workerMin={minimum}; workerAvailable={available}");
        }
        internal void RecordReadStart(string fileName) => Sample("read-start " + fileName);
        internal void Start(Func<bool> readsPending) {
            var limit = maximumLifetime ?? TimeSpan.FromSeconds(30);
            if (watchdog is not null || interval <= TimeSpan.Zero || maxSamples is < 1 or > 60 ||
                limit <= TimeSpan.Zero || limit > TimeSpan.FromSeconds(30))
                throw new InvalidOperationException("Invalid busy diagnostics lifecycle.");
            watchdog = Task.Factory.StartNew(() => {
                var lifetime = System.Diagnostics.Stopwatch.StartNew();
                for (var i = 0; i < maxSamples; i++) {
                    var remaining = limit - lifetime.Elapsed;
                    if (remaining <= TimeSpan.Zero || stop.Token.WaitHandle.WaitOne(remaining < interval ? remaining : interval) ||
                        lifetime.Elapsed >= limit || !readsPending()) return;
                    Sample("watchdog");
                }
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }
        internal async Task StopAsync() {
            stop.Cancel();
            if (watchdog is not null) await watchdog.ConfigureAwait(false);
        }
        public async ValueTask DisposeAsync() { await StopAsync(); stop.Dispose(); }
    }
    internal static async Task<int> RunDiagnosticsTestsAsync() {
        var lines = new ConcurrentQueue<string>();
        var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using (var diagnostics = new BusyReadDiagnostics(TimeSpan.FromMilliseconds(10), 10, line => {
            lines.Enqueue(line);
            if (line.Contains("watchdog", StringComparison.Ordinal)) first.TrySetResult();
        })) {
            diagnostics.RecordReadStart("sample.bin");
            diagnostics.Start(() => true);
            await first.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await diagnostics.StopAsync();
            var count = lines.Count;
            await Task.Delay(30);
            Need(diagnostics.IsStopped && lines.Count == count, "Cancelled watchdog must be joined before return.");
            Need(lines.Any(line => line.Contains("read-start sample.bin", StringComparison.Ordinal) && line.Contains("workerMin=", StringComparison.Ordinal) &&
                line.Contains("workerAvailable=", StringComparison.Ordinal) && line.Contains("elapsedMs=", StringComparison.Ordinal)),
                "Read-start diagnostics must include timing and worker counts.");
        }
        var bounded = new ConcurrentQueue<string>();
        await using (var diagnostics = new BusyReadDiagnostics(TimeSpan.FromMilliseconds(5), 2, bounded.Enqueue)) {
            diagnostics.Start(() => true);
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            while (!diagnostics.IsStopped && deadline.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(10);
            Need(diagnostics.IsStopped && bounded.Count == 2, "Watchdog must stop at its configured sample bound.");
        }
        var finished = new ConcurrentQueue<string>();
        await using (var diagnostics = new BusyReadDiagnostics(TimeSpan.FromMilliseconds(5), 2, finished.Enqueue)) {
            diagnostics.Start(() => false);
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            while (!diagnostics.IsStopped && deadline.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(10);
            Need(diagnostics.IsStopped && finished.IsEmpty, "A completed read set must not produce watchdog samples.");
        }
        var lifetimeLines = new ConcurrentQueue<string>();
        await using (var diagnostics = new BusyReadDiagnostics(TimeSpan.FromMilliseconds(5), 60, lifetimeLines.Enqueue, TimeSpan.FromMilliseconds(50))) {
            diagnostics.Start(() => true);
            var deadline = System.Diagnostics.Stopwatch.StartNew();
            while (!diagnostics.IsStopped && deadline.Elapsed < TimeSpan.FromSeconds(5)) await Task.Delay(10);
            Need(diagnostics.IsStopped && lifetimeLines.Count < 60, "Watchdog lifetime must end without a caller continuation.");
        }
        Console.WriteLine("Synthetic busy diagnostics: cancellation, join, sample bound and worker-count output passed; no native registration.");
        return 0;
    }
    internal static async Task<int> RunDedicatedReaderTestsAsync() {
        using var barrier = new Barrier(4);
        var readers = Enumerable.Range(0, 4).Select(_ => StartDedicated(() => {
            var id = Environment.CurrentManagedThreadId;
            if (!barrier.SignalAndWait(TimeSpan.FromSeconds(10))) throw new TimeoutException("Dedicated readers did not start together.");
            return Task.FromResult(id);
        })).ToArray();
        var ids = await Task.WhenAll(readers).WaitAsync(TimeSpan.FromSeconds(15));
        Need(ids.Distinct().Count() == 4, "Four independent dedicated reader threads are required.");
        Console.WriteLine("Synthetic dedicated readers: four distinct concurrent thread starts passed; no native registration.");
        return 0;
    }
    internal static int RunBusyWindowTests() {
        var now = TimeSpan.Zero;
        var window = new TimedBusyWindow(() => now);
        Need(window.IsBusy("early"), "The first request must be busy.");
        now = TimeSpan.FromMilliseconds(2900);
        Need(window.IsBusy("early") && window.IsBusy("late"), "A late file needs its own busy window.");
        now = TimeSpan.FromSeconds(3);
        Need(!window.IsBusy("early") && window.IsBusy("late"), "The first file expires independently.");
        now = TimeSpan.FromMilliseconds(5900);
        Need(!window.IsBusy("late"), "The late file expires three seconds after its first request.");
        Console.WriteLine("Synthetic busy windows: late-start and independent expiry passed; no native registration.");
        return 0;
    }
    private sealed class TimedBusyWindow(Func<TimeSpan> elapsed) {
        private readonly ConcurrentDictionary<string, TimeSpan> starts = new(StringComparer.Ordinal);
        internal bool IsBusy(string reference) {
            var now = elapsed();
            var started = starts.GetOrAdd(reference, now);
            return now - started < TimeSpan.FromSeconds(3);
        }
    }
    sealed class State {
        internal Dictionary<string,PlaceholderIdentity> Entries = [];
        internal ConcurrentDictionary<string,int> Attempts = new(), BusyResponses = new();
        internal volatile string Mode = "success";
        internal int Downloaded;
        internal System.Diagnostics.Stopwatch BusyClock = new();
        internal readonly TimedBusyWindow TimedBusy;
        internal TaskCompletionSource BusySeen = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal State() { TimedBusy = new(() => BusyClock.Elapsed); }
    }
    sealed class Metadata(State s) : HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken ct) {
            var reference = Uri.UnescapeDataString(r.RequestUri!.Query["?resourceRef=".Length..]); var e = s.Entries[reference];
            int n = s.Attempts.AddOrUpdate(reference, 1, (_,old) => old+1); string mode=s.Mode;
            if (mode == "cancel" || (mode == "timed" && s.TimedBusy.IsBusy(reference)) || (mode != "timed" && n == 1) || (mode == "revoke" && n == 3)) {
                if (mode == "timed") s.BusyResponses.AddOrUpdate(reference, 1, (_, old) => old + 1);
                s.BusySeen.TrySetResult(); var busy = new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("{\"error\":\"employee_gateway_busy\"}",Encoding.UTF8,"application/json") };
                busy.Headers.CacheControl = new CacheControlHeaderValue { NoStore=true }; return Task.FromResult(busy);
            }
            if (mode == "revoke" && n >= 4) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
            var body = new { schemaVersion=1, principalId=Principal, manifest=new { schemaVersion=1, logicalFileId=e.LogicalFileId, remoteVersion=Sha,
                strongETag="\""+Sha+"\"", size=Bytes.Length, sha256=Sha, name=e.FileName,
                downloadPath="/api/staff/files/downloads/eof1_"+reference, expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+600 } };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(body),Encoding.UTF8,"application/json") });
        }
    }
    sealed class Data(State s) : HttpMessageHandler { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken ct) {
        Interlocked.Increment(ref s.Downloaded); var response=new HttpResponseMessage(HttpStatusCode.OK) { Content=new ByteArrayContent(Bytes) };
        response.Headers.ETag=EntityTagHeaderValue.Parse("\""+Sha+"\""); return Task.FromResult(response);
    } }
    sealed class Runner : IAccessCommandRunner { public Task<AccessCommandResult> RunAsync(string p,IReadOnlyList<string> a,CancellationToken ct) {
        string body=Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { sub="synthetic", exp=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600 })).TrimEnd('=').Replace('+','-').Replace('/','_');
        return Task.FromResult(new AccessCommandResult(0,"eyJhbGciOiJSUzI1NiJ9."+body+".c2ln", ""));
    } }
}
