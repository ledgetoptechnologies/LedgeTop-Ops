using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class QueuedDownloadSourceTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Reference = "odqr1_synthetic_resource";
    private static byte[] Bytes => "synthetic durable source verified content"u8.ToArray();
    private static string Sha => Convert.ToHexStringLower(SHA256.HashData(Bytes));
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("Company resolve bounded busy retry rechecks and fails closed", BusyRetry),
        ("Company resolve bounded busy stalled bodies and cancellation", BusyStalled),
        ("Company busy retry uses a bounded monotonic contention budget", BusyBudget),
        ("queue authorization timing separates fake token and response header delays", AuthorizationTiming),
        ("Company hydration authoritative HTTP resolve removes only redundant Session probes", CompanyHydrationAuthority),
        ("Company hydration retries only bounded transient HTTP authorization failures", CompanyHydrationAuthorizationRetry),
        ("Company hydration shared deadline cancels cooperative auth work", CompanyHydrationDeadlineCancellation),
        ("queue bounded auth diagnostics distinguish actual HTTP401 operations", AuthDiagnostics),
        ("queue source employee and portal metadata renews exact identity with human fixed-origin GETs", Metadata),
        ("queue source selection queries encode once and unsafe selectors reject before authentication", Selection),
        ("queue source manifests reject foreign URLs weak metadata and unknown JSON fields", InvalidManifests),
        ("queue source status redirects duplicate JSON invalid UTF8 and bounds fail closed", Responses),
        ("queue source verified downloader emits truthful progress without credential persistence", Download),
        ("queue source cancellation does not launch login or start another request", Cancellation),
        ("queue actual adapter joins lightweight reference durable enqueue renewal and verified completion", JoinedQueue),
        ("portal queue resumes an owned partial through only the dedicated successor byte path", SuccessorResume),
        ("queue metadata diagnostics classify bounded reasons and actual HTTP status", FailureReasons),
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
        ("memory hydration verifies in memory writes no provider file and refuses corrupt bytes", MemoryHydration),
        ("memory hydration cancels, fails closed on sink errors and serializes overlapping same-file requests", MemoryHydrationFailures),
        ("memory hydration cancellation after a partial simulated sink write wipes staging and settles once", MemoryHydrationPartialSinkCancellation),
        ("memory hydration falls back on low memory and allocation failure; wipes every staged buffer", MemoryHydrationQualification),
        ("memory hydration reclamation waits for an active same-file sink", MemoryReclamationWaits),
        ("memory hydration through lifetime wrappers honours generation cancellation and unsupported inner sources", MemoryHydrationWrappers),
        ("memory hydration fallback happens before any sink byte and keeps both authorizations", MemoryHydrationFallbackOrdering),
        ("memory hydration slot waits share one bounded budget: saturation and stripe collision fall back; caller cancel leaks no permit", MemoryHydrationBoundedGateWait),
#endif
    ];
    private static HttpResponseMessage Busy(string body = "{\"error\":\"employee_gateway_busy\"}") {
        var response = new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        response.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true }; return response;
    }
    private static async Task BusyRetry() {
        using var f = new Fixture();
        var attempts = 0;
        using (var source = f.Source(true, new Handler((_, _) => Task.FromResult(++attempts < 3 ? Busy() : Json(Envelope(true)))))) {
            await source.ResolveAsync(Reference); Assert(attempts == 3);
        }
        attempts = 0;
        using (var source = f.Source(true, new Handler((_, _) => Task.FromResult(++attempts == 1 ? Busy() : new HttpResponseMessage(HttpStatusCode.Forbidden))))) {
            await Throws<AccessDeniedException>(() => source.ResolveAsync(Reference)); Assert(attempts == 2);
        }
        attempts = 0;
        using (var source = f.Source(true, new Handler((_, _) => { attempts++; return Task.FromResult(Busy()); }), clock: new FakeBusyClock().Clock)) {
            await Throws<TransferException>(() => source.ResolveAsync(Reference)); Assert(attempts == 10);
        }
        foreach (var employee in new[] { true, false }) {
            attempts = 0;
            using var source = f.Source(employee, new Handler((_, _) => { attempts++; return Task.FromResult(Busy(employee ? "{\"error\":\"other\"}" : "{\"error\":\"employee_gateway_busy\"}")); }));
            await Throws<TransferException>(() => source.ResolveAsync(Reference)); Assert(attempts == 1);
        }
        using var cts = new CancellationTokenSource(); attempts = 0;
        using (var source = f.Source(true, new Handler((_, _) => { attempts++; cts.Cancel(); return Task.FromResult(Busy()); }))) {
            await Throws<OperationCanceledException>(() => source.ResolveAsync(Reference, cts.Token)); Assert(attempts == 1);
        }
    }
    private sealed class FakeBusyClock {
        internal long Milliseconds;
        internal BusyRetryClock Clock => new(() => Milliseconds, start => TimeSpan.FromMilliseconds(Milliseconds - start),
            cap => cap, (delay, token) => { token.ThrowIfCancellationRequested(); Milliseconds += (long)delay.TotalMilliseconds; return Task.CompletedTask; });
    }
    private static async Task BusyBudget() {
        using var f = new Fixture(); var clock = new FakeBusyClock(); var attempts = 0;
        using (var source = f.Source(true, new Handler((_, _) => Task.FromResult(++attempts < 7 ? Busy() : Json(Envelope(true)))), clock: clock.Clock)) {
            await source.ResolveAsync(Reference); Assert(clock.Milliseconds >= 10_000 && attempts == 7);
        }
        clock = new(); attempts = 0;
        using (var source = f.Source(true, new Handler((_, _) => { attempts++; clock.Milliseconds += 5_000; return Task.FromResult(Busy()); }), clock: clock.Clock)) {
            try { await source.ResolveAsync(Reference); throw new Exception("Expected busy failure"); }
            catch (TransferException error) {
                var diagnostic = HydrationFailureDiagnostic.FromException(HydrationStage.AuthorizationBefore, error);
                Assert(error.Reason == TransferFailureReason.ServiceBusy && error.HttpStatus is null && diagnostic.ActivityText.Contains("file service is busy", StringComparison.Ordinal));
                Assert(!diagnostic.ActivityText.Contains(Reference, StringComparison.Ordinal));
            }
            Assert(clock.Milliseconds >= 30_000 && attempts < 10);
        }
        var generic = HydrationFailureDiagnostic.FromException(HydrationStage.AuthorizationBefore, new TransferException("generic", TransferFailureReason.UnexpectedHttpStatus, 503));
        var cancelled = HydrationFailureDiagnostic.FromException(HydrationStage.AuthorizationBefore, new OperationCanceledException());
        Assert(!generic.ActivityText.Contains("file service is busy", StringComparison.Ordinal));
        Assert(cancelled.Category == HydrationFailureCategory.Cancelled && !cancelled.ActivityText.Contains("file service is busy", StringComparison.Ordinal));
        using var boundaryCancel = new CancellationTokenSource(); attempts = 0;
        var boundaryClock = new BusyRetryClock(() => 0, _ => { boundaryCancel.Cancel(); return TimeSpan.FromSeconds(30); },
            _ => throw new Exception("No jitter after cancellation"), (_, _) => throw new Exception("No wait after cancellation"));
        using (var source = f.Source(true, new Handler((_, _) => { attempts++; return Task.FromResult(Busy()); }), clock: boundaryClock)) {
            await Throws<OperationCanceledException>(() => source.ResolveAsync(Reference, boundaryCancel.Token)); Assert(attempts == 1);
        }
        clock = new(); attempts = 0;
        using (var source = f.Source(true, new Handler((_, _) => { attempts++; if (attempts == 2) clock.Milliseconds += 35_000; return Task.FromResult(attempts == 1 ? Busy() : Json(Envelope(true))); }), clock: clock.Clock)) {
            await source.ResolveAsync(Reference); Assert(attempts == 2 && clock.Milliseconds > 30_000);
        }
    }
    private sealed class StalledStream : Stream {
        private readonly TaskCompletionSource<int> blocked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly bool partial;
        private bool sent;
        public StalledStream(bool partial) { this.partial = partial; }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            if (partial && !sent) { sent = true; buffer.Span[0] = (byte)'{'; return ValueTask.FromResult(1); }
            return new(blocked.Task); // deliberately ignores the cancellation token
        }
        protected override void Dispose(bool disposing) { blocked.TrySetResult(0); base.Dispose(disposing); }
        public override int Read(byte[] b, int o, int c) => throw new NotSupportedException(); public override void Flush() { }
        public override long Seek(long o, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long v) => throw new NotSupportedException(); public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();
    }
    private static async Task BusyStalled() {
        using var f = new Fixture();
        foreach (bool partial in new[] { false, true }) {
            var attempts = 0;
            using var source = f.Source(true, new Handler((_, _) => { attempts++; var r = new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StreamContent(new StalledStream(partial)) }; r.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json"); r.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true }; return Task.FromResult(r); }));
            var watch = System.Diagnostics.Stopwatch.StartNew(); await Throws<TransferException>(() => source.ResolveAsync(Reference));
            Assert(attempts == 1 && watch.Elapsed < TimeSpan.FromSeconds(6));
        }
        var count = 0; using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        using var cancelled = f.Source(true, new Handler((_, _) => { count++; var r = new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StreamContent(new StalledStream(true)) }; r.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json"); r.Headers.CacheControl = new CacheControlHeaderValue { NoStore = true }; return Task.FromResult(r); }));
        await Throws<OperationCanceledException>(() => cancelled.ResolveAsync(Reference, cancellation.Token)); Assert(count == 1);
        var retryCount = 0; using var retryCancel = new CancellationTokenSource();
        using var waiting = f.Source(true, new Handler((_, _) => { retryCount++; retryCancel.CancelAfter(TimeSpan.FromMilliseconds(75)); return Task.FromResult(Busy()); }));
        await Throws<OperationCanceledException>(() => waiting.ResolveAsync(Reference, retryCancel.Token)); Assert(retryCount == 1);
    }
    private static async Task AuthorizationTiming()
    {
        var gateIdentity = new PlaceholderIdentity("pilot", "employee", "https://ops-staging.ledgetopdroneservices.com", Principal, Reference, "oef1_" + new string('a', 64), "v1", "synthetic.bin", 1, "\"v1\"", new string('b', 64));
        using (var gateTiming = new HydrationTiming(_ => { })) {
            using var eligible = AuthorizationTimingScope.Begin(gateTiming, gateIdentity, true);
            using var wrongSource = AuthorizationTimingScope.Begin(gateTiming, gateIdentity with { SourceAlias = "portal" }, true);
            using var wrongOrigin = AuthorizationTimingScope.Begin(gateTiming, gateIdentity with { Origin = "https://ops.example.invalid" }, true);
            Assert(wrongSource is null && wrongOrigin is null);
#if LEDGETOP_AUTH_TIMING_STAGING
            Assert(eligible is not null);
#else
            Assert(eligible is null);
#endif
        }
        using var f = new Fixture(); f.Runner.Delay = TimeSpan.FromMilliseconds(35);
        using var source = f.Source(true, new Handler(async (_, token) => { await Task.Delay(60, token); return Json(Envelope(true)); }));
        var summaries = new List<HydrationTimingSummary>();
        using (var timing = new HydrationTiming(summaries.Add)) {
            using (AuthorizationTimingScope.BeginForTest(timing, true)) await source.ResolveAsync(Reference);
            timing.Complete(HydrationTimingOutcome.Completed);
        }
        var summary = summaries.Single();
        Assert(summary.AuthorizationCounts[0] == 1 && summary.AuthorizationCounts[1] == 1 && summary.AuthorizationCounts[2] == 0 && summary.AuthorizationCounts[3] == 0);
        Assert(summary.AuthorizationMilliseconds[0] >= 20 && summary.AuthorizationMilliseconds[1] >= 40);
        Assert(!summary.ActivityText.Contains(f.Runner.Token, StringComparison.Ordinal) && !summary.ActivityText.Contains("https:", StringComparison.Ordinal) && !summary.ActivityText.Contains(Reference, StringComparison.Ordinal));
        var failed = new List<HydrationTimingSummary>();
        using (var timing = new HydrationTiming(failed.Add)) {
            f.Runner.Error = new IOException("private synthetic token error");
            using (AuthorizationTimingScope.BeginForTest(timing, false)) await Throws<LoginRequiredException>(() => source.ResolveAsync(Reference));
            timing.Complete(HydrationTimingOutcome.Failed);
        }
        Assert(failed.Single().AuthorizationCounts[2] == 1 && failed.Single().AuthorizationCounts[3] == 0);
        Assert(!failed.Single().ActivityText.Contains("private", StringComparison.Ordinal));
        async Task<HydrationTimingSummary> Parallel(bool before) {
            using var fixture = new Fixture(); fixture.Runner.Delay = TimeSpan.FromMilliseconds(20);
            using var parallelSource = fixture.Source(true, new Handler(async (_, token) => { await Task.Delay(25, token); return Json(Envelope(true)); }));
            var output = new List<HydrationTimingSummary>();
            using var timing = new HydrationTiming(output.Add);
            using (AuthorizationTimingScope.BeginForTest(timing, before)) await parallelSource.ResolveAsync(Reference);
            timing.Complete(HydrationTimingOutcome.Completed); return output.Single();
        }
        var concurrent = await Task.WhenAll(Parallel(true), Parallel(false));
        Assert(concurrent[0].AuthorizationCounts.SequenceEqual(new[] { 1, 1, 0, 0 }) && concurrent[1].AuthorizationCounts.SequenceEqual(new[] { 0, 0, 1, 1 }));
        using var cancelledFixture = new Fixture(); cancelledFixture.Runner.Delay = TimeSpan.FromMilliseconds(10);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancelledSource = cancelledFixture.Source(true, new Handler(async (_, token) => { entered.TrySetResult(); await Task.Delay(5000, token); return Json(Envelope(true)); }));
        using var cancellation = new CancellationTokenSource(); var cancelled = new List<HydrationTimingSummary>();
        using (var timing = new HydrationTiming(cancelled.Add)) {
            using (AuthorizationTimingScope.BeginForTest(timing, true)) {
                var pending = cancelledSource.ResolveAsync(Reference, cancellation.Token);
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(10)); cancellation.Cancel();
                await Throws<OperationCanceledException>(() => pending);
            }
            timing.Complete(HydrationTimingOutcome.Cancelled);
        }
        Assert(cancelled.Single().AuthorizationCounts[0] == 1 && cancelled.Single().AuthorizationCounts[1] == 1 && cancelled.Single().Outcome == HydrationTimingOutcome.Cancelled);
    }
    private static void Assert(bool value) { if (!value) throw new Exception("Queue source assertion failed."); }
    private static async Task Throws<T>(Func<Task> run) where T : Exception { try { await run(); } catch (T) { return; } throw new Exception("Expected safe queue source failure."); }
    private static string Base(bool employee) => employee ? "/api/staff/files" : "/api/client/operations/data";
    private static async Task FailureReasons()
    {
        using var fixture = new Fixture();
        foreach (var employee in new[] { true, false }) {
            using (var source=fixture.Source(employee,new Handler((_,_)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden))))) {
                try { await source.GetSessionAsync(); throw new Exception("Expected session denial."); }
                catch(AccessDeniedException denied) { Assert(denied.Operation==DenialOperation.QueueSession && denied.MediaType==DenialMediaType.Unknown); }
                if (source is EmployeeQueuedDownloadSource staff) {
                    try { await staff.GetReferenceAsync("11111111-1111-4111-8111-111111111111","test.txt"); throw new Exception("Expected reference denial."); }
                    catch(AccessDeniedException denied) { Assert(denied.Operation==DenialOperation.QueueReference && denied.MediaType==DenialMediaType.Unknown); }
                }
            }
            foreach (var item in new[] { ("text/html",DenialMediaType.Html), ("application/json",DenialMediaType.Json), ("application/private-secret",DenialMediaType.Other) }) {
                using var source = fixture.Source(employee, new Handler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("secret-body", System.Text.Encoding.UTF8, item.Item1) })));
                try { await source.ResolveAsync(Reference); throw new Exception("Expected HTTP denial."); }
                catch (AccessDeniedException denied) { Assert(denied.Reason == AccessDenialReason.HttpForbidden && denied.Operation==DenialOperation.QueueResolve && denied.MediaType==item.Item2 && !denied.Message.Contains("secret")); }
            }
            foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.NotFound, HttpStatusCode.Conflict }) {
                using var source = fixture.Source(employee, new Handler((_, _) => Task.FromResult(new HttpResponseMessage(status))));
                if (status == HttpStatusCode.Unauthorized) await Throws<LoginRequiredException>(() => source.ResolveAsync(Reference));
                else if (status == HttpStatusCode.Forbidden) {
                    try { await source.ResolveAsync(Reference); throw new Exception("Expected HTTP denial."); }
                    catch (AccessDeniedException denied) { Assert(denied.Reason == AccessDenialReason.HttpForbidden); }
                }
                else await Throws<ResourceUnavailableException>(() => source.ResolveAsync(Reference));
            }
            foreach (var status in new[] { 302, 400, 429, 503 }) {
                var handler = new Handler((_, _) => Task.FromResult(new HttpResponseMessage((HttpStatusCode)status)));
                using var source = fixture.Source(employee, handler);
                try { await source.ResolveAsync(Reference); throw new Exception("Expected actual HTTP status."); }
                catch (TransferException error) { Assert(error.Reason == TransferFailureReason.UnexpectedHttpStatus && error.HttpStatus == status && error.InnerException is null); }
                Assert(handler.Calls == 1);
            }
            using (var source = fixture.Source(employee, new Handler((_, _) => Task.FromResult(Json(new { unexpected = "private-detail" }))))) {
                try { await source.ResolveAsync(Reference); throw new Exception("Expected invalid metadata."); }
                catch (TransferException error) { Assert(error.Reason == TransferFailureReason.InvalidMetadata && error.HttpStatus is null && !error.Message.Contains("private-detail", StringComparison.Ordinal)); }
            }
            foreach (var (failure, reason) in new (Exception, TransferFailureReason)[] {
                (new HttpRequestException("private-detail"), TransferFailureReason.Network),
                (new IOException("private-detail"), TransferFailureReason.ResponseRead),
                (new OperationCanceledException("private-detail"), TransferFailureReason.Timeout) }) {
                using var source = fixture.Source(employee, new Handler((_, _) => throw failure));
                try { await source.ResolveAsync(Reference); throw new Exception("Expected transport classification."); }
                catch (TransferException error) { Assert(error.Reason == reason && error.HttpStatus is null && error.InnerException is null && !error.Message.Contains("private-detail", StringComparison.Ordinal)); }
            }
        }
        using var cancel = new CancellationTokenSource(); cancel.Cancel();
        var unused = new Handler((_, _) => throw new Exception("Cancelled request reached HTTP."));
        using var cancelled = fixture.Source(true, unused);
        await Throws<OperationCanceledException>(() => cancelled.ResolveAsync(Reference, cancel.Token)); Assert(unused.Calls == 0 && fixture.Runner.Logins == 0);
    }
    private static Dictionary<string, object?> Manifest(bool employee, string handle = "renewed") => new() {
        ["schemaVersion"] = 1, ["logicalFileId"] = (employee ? "oef1_" : "ondf1_") + new string('b',64), ["remoteVersion"] = employee ? Sha : "provider-version-one",
        ["strongETag"] = "\"" + Sha + "\"", ["size"] = Bytes.Length, ["sha256"] = Sha, ["name"] = "queue.bin",
        ["downloadPath"] = employee ? Base(true)+"/downloads/eof1_"+handle : Base(false)+"/files/ond1_"+handle+"/download",
        ["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds()+600
    };
    private static Dictionary<string, object?> Envelope(bool employee, bool selected = false) {
        var result = new Dictionary<string,object?> { ["schemaVersion"]=1,["principalId"]=Principal,["manifest"]=Manifest(employee) };
        if(selected) { result.Remove("manifest"); result["resourceRef"]=Reference; } return result;
    }
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) {Content=new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,"application/json")};
    private static async Task CompanyHydrationAuthority()
    {
        foreach (var mode in new[] { "employee", "employee-lifetime", "portal", "portal-lifetime", "opaque-wrapper", "before403", "after403", "beforeBusyThen403", "afterBusyThen403", "after401", "afterPrincipal", "afterVersion", "afterLength", "afterExpiry" }) {
            using var f = new Fixture(); var sessions = 0; var resolves = 0; var downloads = 0; var busySent = false;
            var employee = !mode.StartsWith("portal", StringComparison.Ordinal);
            using var original = f.Source(employee, new Handler((request, _) => {
                Assert(request.Headers.GetValues("Cf-Access-Token").Single() == f.Runner.Token);
                if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal)) {
                    sessions++; return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
                }
                Assert(request.RequestUri.AbsolutePath == Base(employee) + "/queue/resolve"); resolves++;
                if ((mode == "beforeBusyThen403" && downloads == 0 || mode == "afterBusyThen403" && downloads != 0)) {
                    if (!busySent) { busySent = true; return Task.FromResult(Busy()); }
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                }
                if (mode == "before403" || downloads != 0 && mode == "after403") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                if (downloads != 0 && mode == "after401") return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
                var envelope = Envelope(employee);
                if (downloads != 0 && mode == "afterPrincipal") envelope["principalId"] = "odqp1_" + new string('f', 64);
                var manifest = (Dictionary<string, object?>)envelope["manifest"]!;
                if (downloads != 0 && mode == "afterVersion") { var sha = new string('e', 64); manifest["sha256"] = sha; manifest["remoteVersion"] = sha; manifest["strongETag"] = "\"" + sha + "\""; }
                if (downloads != 0 && mode == "afterLength") manifest["size"] = Bytes.Length + 1;
                if (downloads != 0 && mode == "afterExpiry") manifest["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 5;
                return Task.FromResult(Json(envelope));
            }), new Handler((request, _) => {
                downloads++; Assert(request.Headers.GetValues("Cf-Access-Token").Single() == f.Runner.Token);
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
            }));
            IQueuedDownloadSource selected = mode == "opaque-wrapper" ? new OpaqueSource(original) : original;
            if (mode.EndsWith("-lifetime", StringComparison.Ordinal)) selected = new LifetimeQueuedDownloadSource(new LifetimeQueuedDownloadSource(selected, CancellationToken.None), CancellationToken.None);
            var id = new PlaceholderIdentity("pilot", selected.Alias, f.Session.Origin.GetLeftPart(UriPartial.Authority), Principal, Reference,
                (employee ? "oef1_" : "ondf1_") + new string('b', 64), employee ? Sha : "provider-version-one", "queue.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
            using var coordinator = new PlaceholderHydrationCoordinator(selected, "pilot", f.Root, expectedPrincipal: Principal);
            var sink = new AuthoritySink();
            if (mode == "opaque-wrapper") {
                await coordinator.HydrateAsync(id, 0, id.Length, sink);
                Assert(sink.Written == Bytes.Length && sink.Completed == 1 && sink.Failed == 0 && sessions == 4 && resolves == 2 && downloads == 1);
            } else if (mode is "employee" or "employee-lifetime" or "portal" or "portal-lifetime") {
                try { await coordinator.HydrateAsync(id, 0, id.Length, sink); }
                catch (TransferException error) { throw new Exception("Company synthetic " + mode + "/" + error.HydrationFailure?.Stage + "/" + error.HydrationFailure?.Category + "/" + error.HydrationFailure?.Reason); }
                Assert(sink.Written == Bytes.Length && sink.Completed == 1 && sink.Failed == 0 && downloads == 1 && resolves == 2);
                Assert(sessions == (mode.StartsWith("employee", StringComparison.Ordinal) ? 0 : 4));
                Assert(f.Runner.Calls == (mode.StartsWith("employee", StringComparison.Ordinal) ? 3 : 7) && f.Runner.Logins == 0);
            } else {
                await Throws<TransferException>(() => coordinator.HydrateAsync(id, 0, id.Length, sink));
                Assert(sink.Written == 0 && sink.Completed == 0 && sink.Failed == 1 && sessions == 0 && f.Runner.Logins == 0);
                Assert(downloads == (mode is "before403" or "beforeBusyThen403" ? 0 : 1));
            }
        }
    }
    private static async Task CompanyHydrationAuthorizationRetry()
    {
        foreach (var mode in new[] { "before502", "before503-lifetime", "before504", "after503", "after401", "after403", "afterPrincipal", "afterVersion", "persistent", "cancel", "generation-cancel", "deadline-before-retry", "deadline-during-delay", "deadline-second-attempt", "other500", "opaque" }) {
            using var f = new Fixture(); using var cancellation = new CancellationTokenSource(); using var generation = new CancellationTokenSource();
            var clock = new AuthorizationDeadlineClock();
            var resolves = 0; var downloads = 0; var delays = 0; var faults = 0; var sink = new AuthoritySink();
            var after = mode.StartsWith("after", StringComparison.Ordinal);
            using var original = f.Source(true, new Handler((request, _) => {
                if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal))
                    return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
                resolves++; Assert(sink.Written == 0 && sink.Completed == 0);
                if ((after && downloads > 0 || !after && downloads == 0) && (faults == 0 || mode == "persistent")) {
                    faults++;
                    if (mode == "deadline-before-retry") clock.Advance(TimeSpan.FromMinutes(15));
                    if (mode is "deadline-second-attempt" or "deadline-during-delay") clock.Advance(TimeSpan.FromMinutes(14));
                    var status = mode == "before502" ? 502 : mode == "before504" ? 504 : mode == "other500" ? 500 : 503;
                    return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status));
                }
                if (mode == "deadline-second-attempt") clock.Advance(TimeSpan.FromMinutes(1));
                if (after && downloads > 0 && mode is "after401" or "after403")
                    return Task.FromResult(new HttpResponseMessage(mode == "after401" ? HttpStatusCode.Unauthorized : HttpStatusCode.Forbidden));
                var envelope = Envelope(true);
                if (after && downloads > 0 && mode == "afterPrincipal") envelope["principalId"] = "odqp1_" + new string('f', 64);
                if (after && downloads > 0 && mode == "afterVersion") {
                    var sha = new string('e', 64); var manifest = (Dictionary<string, object?>)envelope["manifest"]!;
                    manifest["sha256"] = sha; manifest["remoteVersion"] = sha; manifest["strongETag"] = "\"" + sha + "\"";
                }
                return Task.FromResult(Json(envelope));
            }), new Handler((_, _) => {
                downloads++; var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
            }));
            IQueuedDownloadSource selected = mode == "opaque" ? new OpaqueSource(original) : original;
            if (mode is "before503-lifetime" or "generation-cancel")
                selected = new LifetimeQueuedDownloadSource(new LifetimeQueuedDownloadSource(selected, generation.Token), CancellationToken.None);
            var id = new PlaceholderIdentity("pilot", selected.Alias, f.Session.Origin.GetLeftPart(UriPartial.Authority), Principal, Reference,
                "oef1_" + new string('b', 64), Sha, "queue.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
            Task Delay(TimeSpan delay, CancellationToken token) {
                delays++; Assert(delay >= TimeSpan.FromMilliseconds(125) && delay <= TimeSpan.FromMilliseconds(375));
                if (mode == "cancel") cancellation.Cancel();
                if (mode == "generation-cancel") generation.Cancel();
                if (mode == "deadline-during-delay") clock.Advance(TimeSpan.FromMinutes(1));
                token.ThrowIfCancellationRequested(); return Task.CompletedTask;
            }
            using var coordinator = new PlaceholderHydrationCoordinator(selected, "pilot", f.Root, 64L << 30, 128L << 30, Principal, Delay, clock);
            if (mode is "before502" or "before503-lifetime" or "before504" or "after503") {
                await coordinator.HydrateAsync(id, 0, id.Length, sink, cancellation.Token);
                Assert(delays == 1 && sink.Written == Bytes.Length && sink.Completed == 1 && sink.Failed == 0 && downloads == 1 && resolves == 3);
            } else {
                try { await coordinator.HydrateAsync(id, 0, id.Length, sink, cancellation.Token); throw new Exception("Expected retry refusal."); }
                catch (TransferException error) {
                    if (mode.StartsWith("deadline-", StringComparison.Ordinal)) Assert(error.Reason == TransferFailureReason.Timeout);
                }
                catch (OperationCanceledException) when (mode is "cancel" or "generation-cancel") { }
                Assert(sink.Written == 0 && sink.Completed == 0 && sink.Failed == 1);
                Assert(delays == (mode is "other500" or "opaque" or "deadline-before-retry" ? 0 : 1));
                Assert(resolves == (after ? 3 : mode is "cancel" or "generation-cancel" or "deadline-before-retry" or "deadline-during-delay" or "other500" or "opaque" ? 1 : 2));
            }
            Assert(f.Runner.Logins == 0);
        }
    }
    private static async Task CompanyHydrationDeadlineCancellation()
    {
        foreach (var mode in new[] { "http", "token", "http-second", "token-second", "caller-and-deadline", "generation-and-deadline" }) {
            using var f = new Fixture(); using var caller = new CancellationTokenSource(); using var generation = new CancellationTokenSource();
            var clock = new AuthorizationDeadlineClock(); var sink = new AuthoritySink(); var delays = 0;
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            async Task Block(CancellationToken token) {
                entered.TrySetResult();
                try { await Task.Delay(Timeout.InfiniteTimeSpan, token); }
                catch (OperationCanceledException) { cancelled.TrySetResult(); await release.Task; throw; }
            }
            if (mode == "token") f.Runner.Gate = Block;
            if (mode == "token-second") f.Runner.Gate = token => f.Runner.Calls == 2 ? Block(token) : Task.CompletedTask;
            var attempts = 0;
            var handler = new Handler(async (_, token) => {
                if (mode is "http-second" or "token-second" && Interlocked.Increment(ref attempts) == 1)
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
                await Block(token); throw new InvalidOperationException("Blocked request unexpectedly completed.");
            });
            using var source = f.Source(true, handler);
            IQueuedDownloadSource selected = mode == "generation-and-deadline" ? new LifetimeQueuedDownloadSource(source, generation.Token) : source;
            var id = new PlaceholderIdentity("pilot", selected.Alias, f.Session.Origin.GetLeftPart(UriPartial.Authority), Principal, Reference,
                "oef1_" + new string('b', 64), Sha, "queue.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
            Task Delay(TimeSpan _, CancellationToken token) { delays++; token.ThrowIfCancellationRequested(); return Task.CompletedTask; }
            using var coordinator = new PlaceholderHydrationCoordinator(selected, "pilot", f.Root, 64L << 30, 128L << 30, Principal, Delay, clock);
            var work = coordinator.HydrateAsync(id, 0, id.Length, sink, caller.Token);
            try {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                clock.Advance(TimeSpan.FromMinutes(15));
                await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
                if (mode == "caller-and-deadline") caller.Cancel();
                if (mode == "generation-and-deadline") generation.Cancel();
                release.TrySetResult();
                try { await work.WaitAsync(TimeSpan.FromSeconds(5)); throw new Exception("Deadline unexpectedly succeeded."); }
                catch (OperationCanceledException) when (mode == "caller-and-deadline") { }
                catch (TransferException error) when (mode != "caller-and-deadline") {
                    // Caller cancellation has priority; simultaneous generation/deadline
                    // cancellation can surface either bounded cancellation or timeout.
                    if (mode == "generation-and-deadline")
                        Assert(error.Reason == TransferFailureReason.Timeout || error.HydrationFailure?.Category == HydrationFailureCategory.Cancelled);
                    else Assert(error.Reason == TransferFailureReason.Timeout);
                }
                Assert(delays == (mode is "http-second" or "token-second" ? 1 : 0));
                Assert(handler.Calls == (mode == "token" ? 0 : mode == "http-second" ? 2 : 1));
                Assert(sink.Written == 0 && sink.Completed == 0 && sink.Failed == 1 && f.Runner.Logins == 0);
            } finally { caller.Cancel(); generation.Cancel(); release.TrySetResult(); try { await work.WaitAsync(TimeSpan.FromSeconds(5)); } catch { } }
        }
    }
    // Minimal deterministic one-shot timer for the linked authorization deadline.
    private sealed class AuthorizationDeadlineClock : TimeProvider
    {
        private long now; private DeadlineTimer? timer;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => now;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
            timer = new DeadlineTimer(this, callback, state, dueTime, period);
        internal void Advance(TimeSpan amount) { now += amount.Ticks; timer?.FireIfDue(); }
        private sealed class DeadlineTimer : ITimer
        {
            private readonly AuthorizationDeadlineClock clock; private readonly TimerCallback callback; private readonly object? state;
            private long due; private bool disposed;
            internal DeadlineTimer(AuthorizationDeadlineClock clock, TimerCallback callback, object? state, TimeSpan due, TimeSpan period) {
                this.clock = clock; this.callback = callback; this.state = state; Change(due, period);
            }
            public bool Change(TimeSpan delay, TimeSpan period) {
                if (disposed || period != Timeout.InfiniteTimeSpan) return false;
                due = delay == Timeout.InfiniteTimeSpan ? long.MaxValue : clock.now + delay.Ticks; return true;
            }
            internal void FireIfDue() { if (!disposed && clock.now >= due) { due = long.MaxValue; callback(state); } }
            public void Dispose() => disposed = true;
            public ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
        }
    }
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
    private static async Task MemoryHydration()
    {
        foreach (var mode in new[] { "employee", "portal", "corrupt", "oversize", "revokedAfter" }) {
            using var f = new Fixture(); var downloads = 0; var resolves = 0;
            var attemptsBefore = PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest;
            var employee = mode != "portal";
            using var source = f.Source(employee, new Handler((request, _) => {
                if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal))
                    return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
                resolves++;
                // Second (post-download) authorization denied: no byte may reach the sink.
                if (mode == "revokedAfter" && downloads != 0) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
                return Task.FromResult(Json(Envelope(employee)));
            }), new Handler((_, _) => {
                downloads++; var body = Bytes; if (mode == "corrupt") { body = (byte[])body.Clone(); body[3] ^= 1; }
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
            }));
            var id = new PlaceholderIdentity("pilot", source.Alias, f.Session.Origin.GetLeftPart(UriPartial.Authority), Principal, Reference,
                (employee ? "oef1_" : "ondf1_") + new string('b', 64), employee ? Sha : "provider-version-one", "queue.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
            var previousMax = PlaceholderHydrationCoordinator.MemoryHydrationMaxBytes;
            if (mode == "oversize") PlaceholderHydrationCoordinator.MemoryHydrationMaxBytes = Bytes.Length - 1;
            try {
                using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", f.Root, expectedPrincipal: Principal);
                var sink = new AuthoritySink();
                if (mode is "corrupt" or "revokedAfter") {
                    await Throws<TransferException>(() => coordinator.HydrateAsync(id, 0, id.Length, sink));
                    Assert(sink.Written == 0 && sink.Completed == 0 && sink.Failed == 1 && downloads == 1);
                    Assert(mode != "revokedAfter" || resolves == 2);
                } else {
                    await coordinator.HydrateAsync(id, 0, id.Length, sink);
                    Assert(sink.Written == Bytes.Length && sink.Completed == 1 && sink.Failed == 0 && downloads == 1 && resolves == 2);
                }
                var cached = Directory.GetFiles(f.Root, "queue.bin*", SearchOption.AllDirectories).Length;
                // Memory staging must never create the cached file or a partial; oversize keeps the verified cache path.
                Assert(mode == "oversize" ? cached == 1 : cached == 0);
                // Every mode except oversize must have entered the memory branch, so its result is evidence for that path.
                Assert((PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest - attemptsBefore) == (mode == "oversize" ? 0 : 1));
            } finally { PlaceholderHydrationCoordinator.MemoryHydrationMaxBytes = previousMax; }
        }
    }
#endif
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
    private static async Task MemoryHydrationFailures()
    {
        // Cancellation while the body is being received: no sink bytes, one failure, cancellation surfaces.
        {
            using var f = new Fixture(); var started = new TaskCompletionSource();
            using var source = f.Source(true, new Handler((_, _) => Task.FromResult(Json(Envelope(true)))), new Handler(async (_, token) => {
                started.TrySetResult(); await Task.Delay(Timeout.Infinite, token); throw new Exception("unreachable");
            }));
            var id = MemoryId(f, source);
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", f.Root, expectedPrincipal: Principal);
            using var cancel = new CancellationTokenSource(); var sink = new AuthoritySink();
            var running = coordinator.HydrateAsync(id, 0, id.Length, sink, cancel.Token);
            await started.Task; cancel.Cancel();
            try { await running; throw new Exception("Expected cancellation."); } catch (OperationCanceledException) { }
            Assert(sink.Written == 0 && sink.Completed == 0 && sink.Failed == 1);
        }
        // A sink write failure after verification fails closed and is not reported as complete.
        {
            using var f = new Fixture();
            using var source = f.Source(true, new Handler((_, _) => Task.FromResult(Json(Envelope(true)))), Data());
            var id = MemoryId(f, source);
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", f.Root, expectedPrincipal: Principal);
            var sink = new ThrowingSink();
            await Throws<TransferException>(() => coordinator.HydrateAsync(id, 0, id.Length, sink));
            Assert(sink.Completed == 0 && sink.Failed == 1);
        }
        // Overlapping same-file requests are served one at a time; each is fully verified.
        {
            using var f = new Fixture(); var active = 0; var peak = 0; var downloads = 0;
            using var source = f.Source(true, new Handler((_, _) => Task.FromResult(Json(Envelope(true)))), new Handler(async (_, token) => {
                var now = Interlocked.Increment(ref active); peak = Math.Max(peak, now); Interlocked.Increment(ref downloads);
                await Task.Delay(50, token); Interlocked.Decrement(ref active);
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return response;
            }));
            var id = MemoryId(f, source);
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", f.Root, expectedPrincipal: Principal);
            var sinks = Enumerable.Range(0, 3).Select(_ => new AuthoritySink()).ToArray();
            await Task.WhenAll(sinks.Select(sink => coordinator.HydrateAsync(id, 0, id.Length, sink)));
            Assert(sinks.All(sink => sink.Written == Bytes.Length && sink.Completed == 1 && sink.Failed == 0) && downloads == 3 && peak == 1);
        }
    }
    private static Handler Data() => new((_, _) => {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
        response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
    });
    private static PlaceholderIdentity MemoryId(Fixture f, IQueuedDownloadSource source) =>
        new("pilot", source.Alias, f.Session.Origin.GetLeftPart(UriPartial.Authority), Principal, Reference,
            "oef1_" + new string('b', 64), Sha, "queue.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
    private sealed class ThrowingSink : IPlaceholderTransferSink {
        internal int Completed, Failed;
        public Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) => throw new IOException("synthetic sink failure");
        public Task CompleteAsync(CancellationToken token) { Completed++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; return Task.CompletedTask; }
    }
    private static async Task MemoryReclamationWaits()
    {
        using var f = new Fixture();
        using var source = f.Source(true, new Handler((request, _) => {
            if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal))
                return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
            return Task.FromResult(Json(Envelope(true)));
        }), Data());
        var id = MemoryId(f, source);
        using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", f.Root, expectedPrincipal: Principal);
        var sink = new HeldMemorySink(); var previous = PlaceholderHydrationCoordinator.AvailableMemoryForTest;
        var attempts = PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest;
        PlaceholderHydrationCoordinator.AvailableMemoryForTest = () => long.MaxValue;
        Task? hydration = null;
        try {
            hydration = coordinator.HydrateAsync(id, 0, id.Length, sink);
            await sink.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert(PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest == attempts + 1);
            var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest;
            PlaceholderHydrationCoordinator.AvailableMemoryForTest = () => 0;
            using (var secondCancel = new CancellationTokenSource()) {
                var secondSink = new AuthoritySink();
                var second = coordinator.HydrateAsync(id, 0, id.Length, secondSink, secondCancel.Token);
                await Task.Delay(100);
                Assert(!second.IsCompleted && PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest == fallbacks);
                secondCancel.Cancel();
                try { await second; throw new Exception("Expected cancellation of competing hydration."); } catch (OperationCanceledException) { }
                Assert(secondSink.Written == 0 && secondSink.Completed == 0 && secondSink.Failed == 1);
            }
            using var cancel = new CancellationTokenSource();
            var eviction = coordinator.EvictVerifiedCacheAsync(id, cancel.Token);
            try {
                await Task.Delay(100);
                if (eviction.IsCompleted) throw new Exception("Reclamation completed while the memory sink was still active.");
                cancel.Cancel();
                try { await eviction; throw new Exception("Expected cancellation of waiting reclamation."); } catch (OperationCanceledException) { }
            } finally { cancel.Cancel(); }
            var retry = coordinator.EvictVerifiedCacheAsync(id);
            await Task.Delay(100);
            Assert(!retry.IsCompleted);
            sink.Release.TrySetResult();
            await retry.WaitAsync(TimeSpan.FromSeconds(5));
        } finally {
            sink.Release.TrySetResult();
            if (hydration is not null) await hydration.WaitAsync(TimeSpan.FromSeconds(5));
            PlaceholderHydrationCoordinator.AvailableMemoryForTest = previous;
        }
    }
    private sealed class HeldMemorySink : IPlaceholderTransferSink {
        internal TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) { Entered.TrySetResult(); await Release.Task.WaitAsync(token); }
        public Task CompleteAsync(CancellationToken token) => Task.CompletedTask;
        public Task FailAsync(string code) => Task.CompletedTask;
    }
    private static async Task MemoryHydrationPartialSinkCancellation()
    {
        using var f = new Fixture();
        var data = new byte[CloudFilesNativeTransfer.TransferChunkBytes + 4096];
        RandomNumberGenerator.Fill(data);
        var sha = Convert.ToHexStringLower(SHA256.HashData(data));
        var resolves = 0; var downloads = 0;
        using var source = f.Source(true, new Handler((request, _) => {
            if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal))
                return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
            resolves++;
            var manifest = Manifest(true); manifest["remoteVersion"] = sha; manifest["strongETag"] = "\"" + sha + "\"";
            manifest["size"] = data.Length; manifest["sha256"] = sha;
            var envelope = Envelope(true); envelope["manifest"] = manifest; return Task.FromResult(Json(envelope));
        }), new Handler((_, _) => {
            downloads++; var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(data) };
            response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + sha + "\""); return Task.FromResult(response);
        }));
        var id = new PlaceholderIdentity("pilot", source.Alias, f.Session.Origin.GetLeftPart(UriPartial.Authority), Principal, Reference,
            "oef1_" + new string('b', 64), sha, "queue.bin", data.Length, "\"" + sha + "\"", sha);
        using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", f.Root, expectedPrincipal: Principal);
        using var cancel = new CancellationTokenSource(); var sink = new PartialCancellingSink(cancel);
        byte[]? released = null;
        var previousHeadroom = PlaceholderHydrationCoordinator.AvailableMemoryForTest;
        var previousRelease = PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest;
        var attempts = PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest;
        try {
            PlaceholderHydrationCoordinator.AvailableMemoryForTest = () => long.MaxValue;
            PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = bytes => released = bytes;
            try { await coordinator.HydrateAsync(id, 0, id.Length, sink, cancel.Token); throw new Exception("Expected cancellation after partial write."); }
            catch (OperationCanceledException) { }
            Assert(downloads == 1 && resolves == 2 && PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest == attempts + 1);
            Assert(sink.Writes == 1 && sink.Bytes == CloudFilesNativeTransfer.TransferChunkBytes && sink.Bytes < data.Length && sink.Completed == 0 && sink.Failed == 1);
            Assert(released is not null && released.Length == data.Length && released.All(b => b == 0));
        } finally {
            PlaceholderHydrationCoordinator.AvailableMemoryForTest = previousHeadroom;
            PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = previousRelease;
        }
    }
    private sealed class PartialCancellingSink(CancellationTokenSource cancel) : IPlaceholderTransferSink {
        internal int Writes, Bytes, Completed, Failed;
        public Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) {
            token.ThrowIfCancellationRequested(); Assert(offset == 0); Writes++; Bytes += bytes.Length; cancel.Cancel(); return Task.CompletedTask;
        }
        public Task CompleteAsync(CancellationToken token) { Completed++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Assert(code == "cancelled"); Failed++; return Task.CompletedTask; }
    }
#endif
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
    // Runs one hydration and reports whether the cache file was created and how many data GETs were sent.
    private static async Task<(AuthoritySink Sink, bool Cached, int DataCalls, Exception? Error)> MemoryRun(Func<IQueuedDownloadSource, IQueuedDownloadSource>? wrap = null,
        bool corrupt = false, bool revokeAfter = false, bool failSink = false)
    {
        using var f = new Fixture(); var downloads = 0;
        using var source = f.Source(true, new Handler((request, _) => {
            if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal))
                return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
            if (revokeAfter && downloads != 0) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
            return Task.FromResult(Json(Envelope(true)));
        }), new Handler((_, _) => {
            downloads++; var body = Bytes; if (corrupt) { body = (byte[])body.Clone(); body[3] ^= 1; }
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) };
            response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
        }));
        IQueuedDownloadSource selected = wrap is null ? source : wrap(source);
        var id = MemoryId(f, selected);
        using var coordinator = new PlaceholderHydrationCoordinator(selected, "pilot", f.Root, expectedPrincipal: Principal);
        var sink = new AuthoritySink(); Exception? error = null;
        try {
            if (failSink) await coordinator.HydrateAsync(id, 0, id.Length, new ThrowingSink());
            else await coordinator.HydrateAsync(id, 0, id.Length, sink);
        } catch (Exception e) { error = e; }
        return (sink, Directory.GetFiles(f.Root, "queue.bin", SearchOption.AllDirectories).Length == 1, downloads, error);
    }
    private static async Task MemoryHydrationQualification()
    {
        var released = new List<byte[]>();
        PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = released.Add;
        try {
            // Low memory: refused before any request; the verified cache path serves the file.
            var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest;
            PlaceholderHydrationCoordinator.AvailableMemoryForTest = () => 0;
            try {
                var low = await MemoryRun();
                Assert(low.Error is null && low.Sink.Written == Bytes.Length && low.Sink.Completed == 1 && low.Cached && low.DataCalls == 1);
                Assert(PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest == fallbacks + 1);
            } finally { PlaceholderHydrationCoordinator.AvailableMemoryForTest = null; }
            // Allocation failure: no memory-path request is sent; exactly one (cache-path) data GET.
            PlaceholderHydrationCoordinator.SimulateMemoryStagingOutOfMemoryForTest = true;
            try {
                var oom = await MemoryRun();
                Assert(oom.Error is null && oom.Sink.Completed == 1 && oom.Cached && oom.DataCalls == 1);
                Assert(PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest == fallbacks + 2);
            } finally { PlaceholderHydrationCoordinator.SimulateMemoryStagingOutOfMemoryForTest = false; }
            // With a free gate and headroom the memory path is used again (no cache file).
            var normal = await MemoryRun();
            Assert(normal.Error is null && normal.Sink.Completed == 1 && !normal.Cached);
            // Zeroing: every buffer handed back by the coordinator, and every buffer the downloader discarded, is all zero.
            released.Clear();
            var ok = await MemoryRun();
            var corrupt = await MemoryRun(corrupt: true);
            var revoked = await MemoryRun(revokeAfter: true);
            var sinkFailure = await MemoryRun(failSink: true);
            Assert(ok.Error is null && corrupt.Error is TransferException && revoked.Error is TransferException && sinkFailure.Error is TransferException);
            Assert(!corrupt.Cached && !revoked.Cached && !sinkFailure.Cached && corrupt.Sink.Written == 0 && revoked.Sink.Written == 0);
            // The coordinator owns every staged buffer, including the corrupt one, and wipes each on release.
            if (released.Count != 4) throw new Exception("staged buffers released=" + released.Count);
            Assert(released.All(buffer => buffer.Length == Bytes.Length && buffer.All(b => b == 0)));
        } finally {
            PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = null;
        }
    }
    private static async Task MemoryHydrationWrappers()
    {
        // Generation already cancelled: the wrapper refuses; nothing is written or cached.
        using (var cancelled = new CancellationTokenSource()) {
            cancelled.Cancel();
            var run = await MemoryRun(inner => new LifetimeQueuedDownloadSource(inner, cancelled.Token));
            Assert(run.Error is not null && run.Sink.Written == 0 && run.Sink.Completed == 0 && !run.Cached);
        }
        // Live generation: the wrapper forwards the memory path (no cache file).
        var live = await MemoryRun(inner => new LifetimeQueuedDownloadSource(inner, CancellationToken.None));
        Assert(live.Error is null && live.Sink.Completed == 1 && !live.Cached);
        // Wrapper over a source without memory support: no memory attempt, cache path used.
        var attempts = PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest;
        var opaque = await MemoryRun(inner => new LifetimeQueuedDownloadSource(new OpaqueSource(inner), CancellationToken.None));
        Assert(opaque.Error is null && opaque.Sink.Completed == 1 && opaque.Cached && PlaceholderHydrationCoordinator.MemoryHydrationAttemptsForTest == attempts);
        // Generation cancelled while the body is being received: cancellation, no sink bytes, buffer wiped.
        var discarded = new List<byte[]>(); PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = discarded.Add;
        try {
            using var f = new Fixture(); using var generation = new CancellationTokenSource(); var started = new TaskCompletionSource();
            using var source = f.Source(true, new Handler((request, _) => Task.FromResult(Json(Envelope(true)))), new Handler(async (_, token) => {
                started.TrySetResult(); await Task.Delay(Timeout.Infinite, token); throw new Exception("unreachable");
            }));
            var wrapped = new LifetimeQueuedDownloadSource(source, generation.Token);
            var id = MemoryId(f, wrapped);
            using var coordinator = new PlaceholderHydrationCoordinator(wrapped, "pilot", f.Root, expectedPrincipal: Principal);
            var sink = new AuthoritySink(); var running = coordinator.HydrateAsync(id, 0, id.Length, sink);
            await started.Task; generation.Cancel();
            try { await running; throw new Exception("Expected generation cancellation."); } catch (Exception error) when (error is OperationCanceledException or TransferException) { }
            Assert(sink.Written == 0 && sink.Completed == 0 && sink.Failed == 1 && discarded.Count == 1 && discarded[0].All(b => b == 0));
            Assert(Directory.GetFiles(f.Root, "queue.bin*", SearchOption.AllDirectories).Length == 0);
        } finally { PlaceholderHydrationCoordinator.MemoryStagedReleasedForTest = null; }
    }
#endif
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
    private sealed class OrderedSink(Func<bool> fallbackObserved) : IPlaceholderTransferSink {
        internal long Written; internal int Completed, Failed; internal bool FirstWriteAfterFallback = true; private bool seen;
        public Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) {
            if (!seen) { seen = true; FirstWriteAfterFallback = fallbackObserved(); }
            Written += bytes.Length; return Task.CompletedTask;
        }
        public Task CompleteAsync(CancellationToken token) { Completed++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; return Task.CompletedTask; }
    }
    // One hydration with resolve counting and a sink that records whether the fallback had already happened at its first write.
    private static async Task<(OrderedSink Sink, bool Cached, int Resolves, int DataCalls)> GateRun(int fallbacksBefore)
    {
        using var f = new Fixture(); var resolves = 0; var downloads = 0;
        using var source = f.Source(true, new Handler((request, _) => {
            if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal))
                return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
            resolves++; return Task.FromResult(Json(Envelope(true)));
        }), new Handler((_, _) => {
            downloads++; var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
            response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
        }));
        var id = MemoryId(f, source);
        using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", f.Root, expectedPrincipal: Principal);
        var sink = new OrderedSink(() => PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest > fallbacksBefore);
        await coordinator.HydrateAsync(id, 0, id.Length, sink);
        return (sink, Directory.GetFiles(f.Root, "queue.bin", SearchOption.AllDirectories).Length == 1, resolves, downloads);
    }
    private static async Task MemoryHydrationFallbackOrdering()
    {
        // Both fallbacks are decided before the first authorization: the cache path then performs the usual two
        // authorizations (2 resolves), one data GET, and the fallback is recorded before the first sink byte.
        PlaceholderHydrationCoordinator.AvailableMemoryForTest = () => 0;
        try {
            var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest;
            var run = await GateRun(fallbacks);
            Assert(run.Sink.Completed == 1 && run.Cached && run.Sink.FirstWriteAfterFallback && run.Resolves == 2 && run.DataCalls == 1);
        } finally { PlaceholderHydrationCoordinator.AvailableMemoryForTest = null; }
        PlaceholderHydrationCoordinator.SimulateMemoryStagingOutOfMemoryForTest = true;
        try {
            var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest;
            var run = await GateRun(fallbacks);
            Assert(run.Sink.Completed == 1 && run.Cached && run.Sink.FirstWriteAfterFallback && run.Resolves == 2 && run.DataCalls == 1);
        } finally { PlaceholderHydrationCoordinator.SimulateMemoryStagingOutOfMemoryForTest = false; }
        // Without a fallback the memory path itself keeps both authorizations and writes no cache file.
        {
            var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest;
            var run = await GateRun(fallbacks);
            Assert(run.Sink.Completed == 1 && !run.Cached && !run.Sink.FirstWriteAfterFallback && run.Resolves == 2 && run.DataCalls == 1);
        }
    }
#endif
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
    private sealed class BlockingSink(TaskCompletionSource entered, Task release) : IPlaceholderTransferSink {
        internal long Written; internal int Completed, Failed;
        public async Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) {
            entered.TrySetResult(); await release.WaitAsync(token); Written += bytes.Length;
        }
        public Task CompleteAsync(CancellationToken token) { Completed++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; return Task.CompletedTask; }
    }
    // Distinct-identity fixture for slot tests: the resolve handler answers per resource reference.
    private sealed class SlotFixture : IDisposable {
        internal readonly Fixture F = new(); internal readonly QueuedDownloadSource Source; internal int Downloads;
        internal static string Name(int n) => "file-" + n + ".bin";
        internal static string Logical(int n) => "oef1_" + Convert.ToHexStringLower(SHA256.HashData(BitConverter.GetBytes(n)));
        internal SlotFixture() {
            Source = F.Source(true, new Handler((request, _) => {
                var reference = Uri.UnescapeDataString(request.RequestUri!.Query["?resourceRef=".Length..]);
                var n = int.Parse(reference["odqr1_slot_".Length..]);
                var manifest = Manifest(true); manifest["logicalFileId"] = Logical(n); manifest["name"] = Name(n);
                var envelope = Envelope(true); envelope["manifest"] = manifest; return Task.FromResult(Json(envelope));
            }), new Handler((_, _) => {
                Interlocked.Increment(ref Downloads); var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha + "\""); return Task.FromResult(response);
            }));
        }
        internal PlaceholderIdentity Id(int n) => new("pilot", Source.Alias, F.Session.Origin.GetLeftPart(UriPartial.Authority), Principal, "odqr1_slot_" + n,
            Logical(n), Sha, Name(n), Bytes.Length, "\"" + Sha + "\"", Sha);
        internal bool Cached(int n) => Directory.GetFiles(F.Root, Name(n), SearchOption.AllDirectories).Length == 1;
        public void Dispose() { Source.Dispose(); F.Dispose(); }
    }
    // Starts stuck memory hydrations and always releases and joins them, even if an assertion fails first.
    private static async Task WithStuckHydrations(PlaceholderHydrationCoordinator coordinator, PlaceholderIdentity[] held, Func<Task> body, Action<BlockingSink[]>? after = null)
    {
        var release = new TaskCompletionSource(); var sinks = new List<BlockingSink>(); var tasks = new List<Task>();
        try {
            foreach (var id in held) {
                var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var sink = new BlockingSink(entered, release.Task); sinks.Add(sink);
                tasks.Add(coordinator.HydrateAsync(id, 0, id.Length, sink));
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            }
            await body();
        } finally {
            release.TrySetResult();
            try { await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(15)); }
            catch (TimeoutException) { throw new Exception("Stuck hydrations did not join after release; fixture retained for review."); }
        }
        after?.Invoke(sinks.ToArray());
    }
    private static async Task MemoryHydrationBoundedGateWait()
    {
        var previousWait = PlaceholderHydrationCoordinator.MemoryHydrationGateWait;
        try {
            // (1) Global saturation: two distinct stuck transfers hold both process slots; a third distinct file falls
            // back to the verified cache path within the single budget instead of waiting indefinitely.
            PlaceholderHydrationCoordinator.MemoryHydrationGateWait = TimeSpan.FromMilliseconds(200);
            using (var x = new SlotFixture()) {
                using var coordinator = new PlaceholderHydrationCoordinator(x.Source, "pilot", x.F.Root, expectedPrincipal: Principal);
                await WithStuckHydrations(coordinator, [x.Id(0), x.Id(1)], async () => {
                    var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest;
                    var clock = Stopwatch.StartNew(); var third = new AuthoritySink();
                    await coordinator.HydrateAsync(x.Id(2), 0, Bytes.Length, third).WaitAsync(TimeSpan.FromSeconds(20));
                    Assert(third.Written == Bytes.Length && third.Completed == 1 && third.Failed == 0 && clock.Elapsed < TimeSpan.FromSeconds(15));
                    Assert(PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest == fallbacks + 1 && x.Cached(2) && !x.Cached(0) && !x.Cached(1));
                }, sinks => Assert(sinks.All(sink => sink.Completed == 1 && sink.Failed == 0)));
                Assert(x.Downloads == 3);
            }
            // (2) Occupied stripe: a distinct identity whose same-file stripe collides with a stuck transfer falls back,
            // even though a process slot is free.
            using (var x = new SlotFixture()) {
                using var coordinator = new PlaceholderHydrationCoordinator(x.Source, "pilot", x.F.Root, expectedPrincipal: Principal);
                var stripe = PlaceholderHydrationCoordinator.MemoryFileGateIndexForTest(x.Id(0));
                var colliding = Enumerable.Range(1, 5000).First(n => PlaceholderHydrationCoordinator.MemoryFileGateIndexForTest(x.Id(n)) == stripe);
                await WithStuckHydrations(coordinator, [x.Id(0)], async () => {
                    var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest; var sink = new AuthoritySink();
                    await coordinator.HydrateAsync(x.Id(colliding), 0, Bytes.Length, sink).WaitAsync(TimeSpan.FromSeconds(20));
                    Assert(sink.Completed == 1 && sink.Written == Bytes.Length && x.Cached(colliding));
                    Assert(PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest == fallbacks + 1);
                });
            }
            // (3) Caller cancellation while waiting for a slot is a cancellation, not a fallback, writes nothing and
            // leaks no permit: after the holders finish, a new distinct request is served from memory again.
            PlaceholderHydrationCoordinator.MemoryHydrationGateWait = TimeSpan.FromSeconds(30);
            using (var x = new SlotFixture()) {
                using var coordinator = new PlaceholderHydrationCoordinator(x.Source, "pilot", x.F.Root, expectedPrincipal: Principal);
                await WithStuckHydrations(coordinator, [x.Id(0), x.Id(1)], async () => {
                    var fallbacks = PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest;
                    using var cancel = new CancellationTokenSource(); var waiting = new AuthoritySink();
                    var pending = coordinator.HydrateAsync(x.Id(2), 0, Bytes.Length, waiting, cancel.Token);
                    await Task.Delay(150); Assert(!pending.IsCompleted); cancel.Cancel();
                    try { await pending.WaitAsync(TimeSpan.FromSeconds(10)); throw new Exception("Expected cancellation while waiting for a memory slot."); }
                    catch (OperationCanceledException) { }
                    Assert(waiting.Written == 0 && waiting.Completed == 0 && waiting.Failed == 1 && !x.Cached(2));
                    Assert(PlaceholderHydrationCoordinator.MemoryHydrationFallbacksForTest == fallbacks);
                });
                // Reacquisition: both slots and stripes are free again, so the next request uses memory (no cache file).
                var attempts = PlaceholderHydrationCoordinator.MemoryHydrationsForTest; var again = new AuthoritySink();
                await coordinator.HydrateAsync(x.Id(3), 0, Bytes.Length, again).WaitAsync(TimeSpan.FromSeconds(20));
                Assert(again.Completed == 1 && !x.Cached(3) && PlaceholderHydrationCoordinator.MemoryHydrationsForTest == attempts + 1);
            }
        } finally { PlaceholderHydrationCoordinator.MemoryHydrationGateWait = previousWait; }
    }
#endif
    private sealed class AuthoritySink : IPlaceholderTransferSink {
        internal long Written; internal int Completed, Failed;
        public Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) { Written += bytes.Length; return Task.CompletedTask; }
        public Task CompleteAsync(CancellationToken token) { Completed++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; return Task.CompletedTask; }
    }
    private sealed class OpaqueSource(IQueuedDownloadSource inner) : IQueuedDownloadSource {
        public string Alias => inner.Alias;
        public Uri Origin => inner.Origin;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => inner.GetSessionAsync(token);
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) => inner.ResolveAsync(reference, token);
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => inner.DownloadAsync(spec, destination, progress, cancellationToken);
    }

    private static async Task AuthDiagnostics() {
        foreach (var employee in new[] { true, false }) {
            using var f = new Fixture(); var calls = 0;
            using var source = f.Source(employee, new Handler((_, _) => { calls++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized) { Content = new StringContent("PRIVATE response token") }); }));
            async Task Expect(Func<Task> action, LoginFailureOperation operation) {
                try { await action(); throw new Exception("Expected HTTP401."); }
                catch (LoginRequiredException error) {
                    Assert(error.Reason == LoginFailureReason.HttpUnauthorized && error.Operation == operation);
                    Assert(error.InnerException is null && !error.ToString().Contains("PRIVATE") && !error.ToString().Contains(f.Runner.Token));
                }
            }
            await Expect(() => source.GetSessionAsync(), LoginFailureOperation.QueueSession);
            await Expect(() => source.ResolveAsync(Reference), LoginFailureOperation.QueueResolve);
            if (employee) await Expect(() => ((EmployeeQueuedDownloadSource)source).GetReferenceAsync("20000000-0000-4000-8000-000000000001", "synthetic.bin"), LoginFailureOperation.QueueReference);
            else await Expect(() => ((PortalQueuedDownloadSource)source).GetReferenceAsync("ond1_current"), LoginFailureOperation.QueueReference);
            Assert(calls == 3 && f.Runner.Calls == 3 && f.Runner.Logins == 0);
            f.Runner.Error = new LoginRequiredException(LoginFailureReason.HelperExitedUnsuccessfully, LoginFailureOperation.Unknown);
            try { await source.GetSessionAsync(); throw new Exception("Expected helper failure before HTTP."); }
            catch (LoginRequiredException error) { Assert(error.Reason == LoginFailureReason.HelperExitedUnsuccessfully && error.Operation == LoginFailureOperation.CachedToken); }
            Assert(calls == 3 && f.Runner.Logins == 0);
            f.Runner.Error = null;
            using var cancellation = new CancellationTokenSource();
            using var waiting = f.Source(employee, new Handler(async (_, ct) => { cancellation.Cancel(); await Task.Delay(Timeout.Infinite, ct); return new(HttpStatusCode.Unauthorized); }));
            await Throws<OperationCanceledException>(() => waiting.GetSessionAsync(cancellation.Token));
        }
    }

    private static async Task Metadata() {
        foreach(var employee in new[]{true,false}) {
            using var f = new Fixture(); var requests = new List<string>();
            using var source = f.Source(employee,new Handler((r,_)=>{
                Assert(r.Version == System.Net.HttpVersion.Version20 && r.VersionPolicy == HttpVersionPolicy.RequestVersionOrLower);
                Assert(r.RequestUri!.Host=="source.example.invalid" && r.Method==HttpMethod.Get && r.Headers.Authorization is null && !r.Headers.Contains("Cookie"));
                Assert(r.Headers.GetValues("Cf-Access-Token").Single()==f.Runner.Token); requests.Add(r.RequestUri.AbsolutePath);
                return Task.FromResult(r.RequestUri.AbsolutePath.EndsWith("/session",StringComparison.Ordinal)
                    ? Json(new{schemaVersion=1,principalId=Principal,expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600}) : Json(Envelope(employee)));
            }));
            Assert((await source.GetSessionAsync()).PrincipalId==Principal);
            var first=await source.ResolveAsync(Reference);var second=await source.ResolveAsync(Reference);
            Assert(first.PrincipalId==Principal && first.LogicalFileId==second.LogicalFileId && first.RemoteVersion==second.RemoteVersion && first.Spec==second.Spec);
            Assert(first.Spec.OpaqueIdentity==first.LogicalFileId+":"+first.RemoteVersion && first.Spec.ContentUri.Host=="source.example.invalid");
            Assert(requests.SequenceEqual(new[]{Base(employee)+"/queue/session",Base(employee)+"/queue/resolve",Base(employee)+"/queue/resolve"}));
            Assert(f.Runner.Logins==0);
        }
    }
    private static async Task Selection() {
        using var f=new Fixture();var path="Clients/Ben/中 #?.jpg";
        using var employee = new EmployeeQueuedDownloadSource("employee",f.Session,new Handler((r,_)=>{
            Assert(r.RequestUri!.Query=="?rootId=20000000-0000-4000-8000-000000000001&path="+Uri.EscapeDataString(path));return Task.FromResult(Json(Envelope(true,true)));
        }),new Downloader([f.Session.Origin]));
        var selected=await employee.GetReferenceAsync("20000000-0000-4000-8000-000000000001",path);Assert(selected.ResourceReference==Reference);
        var before=f.Runner.Calls;
        await Throws<ArgumentException>(()=>employee.GetReferenceAsync("invalid",path));
        await Throws<ArgumentException>(()=>employee.GetReferenceAsync("20000000-0000-4000-8000-000000000001","../escape"));
        foreach(var unsafePath in new[]{"file%20name","a:b","a\\b","a/\u200db","a/\ud800"})
            await Throws<ArgumentException>(()=>employee.GetReferenceAsync("20000000-0000-4000-8000-000000000001",unsafePath));
        await Throws<TransferException>(()=>employee.ResolveAsync("https://evil.example/"));Assert(f.Runner.Calls==before);
        using var portal=new PortalQueuedDownloadSource("portal",f.Session,new Handler((r,_)=>{
            Assert(r.RequestUri!.Query=="?fileHandle=ond1_current");return Task.FromResult(Json(Envelope(false,true)));
        }),new Downloader([f.Session.Origin]));
        Assert((await portal.GetReferenceAsync("ond1_current")).ResourceReference==Reference);
        await Throws<ArgumentException>(()=>portal.GetReferenceAsync("eof1_wrong_source"));
        using var catalog = new PortalQueuedDownloadSource("portal",f.Session,new Handler((r,_)=>{
            Assert(r.RequestUri!.Query=="?fileHandle=wpc1_current_catalog");return Task.FromResult(Json(Envelope(false,true)));
        }),new Downloader([f.Session.Origin]));
        Assert((await catalog.GetReferenceAsync("wpc1_current_catalog")).ResourceReference==Reference);
        var catalogCalls=f.Runner.Calls;
        foreach(var unsafeHandle in new[]{"wsp1_bytes","wpc1_","wpc1_../escape","wpc1_valid?other=1","wpc1_%2f","wpc1_quoted=","https://evil.example/","wpc1_a\r\nHeader:1"})
            await Throws<ArgumentException>(()=>catalog.GetReferenceAsync(unsafeHandle));
        Assert(f.Runner.Calls==catalogCalls);
    }
    private static async Task InvalidManifests() {
        foreach(var employee in new[]{true,false}) foreach(var key in new[]{"downloadPath","logicalFileId","remoteVersion","strongETag","size","sha256","name","expiresAt","unknown"}) {
            using var f=new Fixture();var manifest=Manifest(employee);
            manifest[key]=key switch {
                "downloadPath"=>"https://evil.example/bytes", "logicalFileId"=>"oef1_wrong", "remoteVersion"=>employee?"wrong": " bad ", "strongETag"=>"W/\"weak\"",
                "size"=>-1,"sha256"=>new string('F',64),"name"=>"../unsafe","expiresAt"=>DateTimeOffset.UtcNow.ToUnixTimeSeconds()+901,_=>true
            };
            var envelope=Envelope(employee);envelope["manifest"]=manifest;
            using var source=f.Source(employee,new Handler((_,_)=>Task.FromResult(Json(envelope))));await Throws<TransferException>(()=>source.ResolveAsync(Reference));
        }
        using(var f=new Fixture()) {
            using var source=f.Source(true,new Handler((_,_)=>Task.FromResult(Json(new{schemaVersion=1,principalId="client-supplied",expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600}))));
            await Throws<TransferException>(()=>source.GetSessionAsync());
        }
        using(var f=new Fixture()) {
            var envelope=Envelope(false);var manifest=Manifest(false);manifest["name"]=" map.bin";envelope["manifest"]=manifest;
            using var source=f.Source(false,new Handler((_,_)=>Task.FromResult(Json(envelope))));
            Assert((await source.ResolveAsync(Reference)).Spec.FileName==" map.bin");
        }
    }
    private static async Task Responses() {
        foreach(var status in new[]{401,403,404,409,302,503}) {
            using var f=new Fixture();var calls=0;
            using var source=f.Source(true,new Handler((_,_)=>{calls++;return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status));}));
            if(status==401)await Throws<LoginRequiredException>(()=>source.ResolveAsync(Reference));
            else if(status==403)await Throws<AccessDeniedException>(()=>source.ResolveAsync(Reference));
            else if(status is 404 or 409)await Throws<ResourceUnavailableException>(()=>source.ResolveAsync(Reference));
            else await Throws<TransferException>(()=>source.ResolveAsync(Reference));
            Assert(calls==1 && f.Runner.Logins==0);
        }
        foreach(var variant in new[]{"duplicate","utf8","oversize","encoding"}) {
            using var f=new Fixture();
            using var source=f.Source(false,new Handler((_,_)=>{
                var r=Json(Envelope(false));
                if(variant=="duplicate") r.Content=new StringContent("{\"schemaVersion\":1,\"schemaVersion\":1}",Encoding.UTF8,"application/json");
                if(variant=="utf8") {r.Content=new ByteArrayContent([0xff]);r.Content.Headers.ContentType=new("application/json");}
                if(variant=="oversize")r.Content=new StringContent(new string(' ',96*1024+1),Encoding.UTF8,"application/json");
                if(variant=="encoding")r.Content.Headers.ContentEncoding.Add("gzip");
                return Task.FromResult(r);
            }));await Throws<TransferException>(()=>source.ResolveAsync(Reference));
        }
    }
    private static async Task Download() {
        using var f=new Fixture();var phases=new List<DownloadProgress>();
        using var source=f.Source(true,new Handler((_,_)=>Task.FromResult(Json(Envelope(true)))),new Handler((r,_)=>{
            Assert(r.Version == System.Net.HttpVersion.Version20 && r.VersionPolicy == HttpVersionPolicy.RequestVersionOrLower);
            Assert(r.Headers.GetValues("Cf-Access-Token").Single()==f.Runner.Token && r.Headers.IfMatch.Single().Tag=="\""+Sha+"\"");
            var result=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Bytes)};result.Headers.ETag=new EntityTagHeaderValue("\""+Sha+"\"");return Task.FromResult(result);
        }));
        var resolved=await source.ResolveAsync(Reference);var output=await source.DownloadAsync(resolved.Spec,f.Root,new ProgressSink(phases));
        Assert(File.ReadAllBytes(output).SequenceEqual(Bytes));Assert(phases.Last().Phase==DownloadPhase.Completed && phases.Last().BytesTransferred==Bytes.Length);
        await Throws<TransferException>(()=>source.DownloadAsync(resolved.Spec with {ContentUri=new Uri("https://evil.example/bytes")},f.Root));
    }
    private static async Task Cancellation() {
        using var f=new Fixture();using var source=f.Source(true,new Handler(async(_,token)=>{await Task.Delay(Timeout.Infinite,token);throw new Exception("unreachable");}));
        using var cancel=new CancellationTokenSource(50);await Throws<OperationCanceledException>(()=>source.ResolveAsync(Reference,cancel.Token));Assert(f.Runner.Logins==0);
    }
    private static async Task JoinedQueue() {
        using var f=new Fixture();int preparations=0,bytes=0;
        using var source=f.Source(true,new Handler((request,_)=>{
            var path=request.RequestUri!.AbsolutePath;
            if(path.EndsWith("/session",StringComparison.Ordinal))return Task.FromResult(Json(new{schemaVersion=1,principalId=Principal,expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600}));
            if(path.EndsWith("/reference",StringComparison.Ordinal))return Task.FromResult(Json(Envelope(true,true)));
            preparations++;var envelope=Envelope(true);envelope["manifest"]=Manifest(true,"renewal"+preparations);return Task.FromResult(Json(envelope));
        }),new Handler((request,_)=>{
            bytes++;Assert(request.RequestUri!.AbsolutePath.EndsWith("eof1_renewal2",StringComparison.Ordinal));
            var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Bytes)};response.Headers.ETag=new("\""+Sha+"\"");return Task.FromResult(response);
        }));
        var selected=await ((EmployeeQueuedDownloadSource)source).GetReferenceAsync("20000000-0000-4000-8000-000000000001","folder/file");
        Assert(preparations==0 && selected.PrincipalId==Principal);
        var output=Path.Combine(f.Root,"output");Directory.CreateDirectory(output);
        var state=Path.Combine(f.Root,"state");Directory.CreateDirectory(state);
        await using(var queue=await TransferQueue.OpenAsync(state,source)) {
            var id=await queue.EnqueueAsync(selected.ResourceReference,output);Assert(preparations==1 && bytes==0);
            await queue.StartAsync(id);await queue.WaitForIdleAsync();
            Assert(preparations==2 && bytes==1 && (await queue.GetJobsAsync()).Single().State==QueuedTransferState.Completed);
        }
        Assert(File.ReadAllBytes(Path.Combine(output,"queue.bin")).SequenceEqual(Bytes));
        var durable=File.ReadAllText(Path.Combine(state,"queue.json"));
        Assert(durable.Contains(Reference,StringComparison.Ordinal) && !durable.Contains("eof1_",StringComparison.Ordinal) && !durable.Contains("Cf-Access",StringComparison.Ordinal)
            && !durable.Contains(f.Runner.Token,StringComparison.Ordinal));
        await using var reopened=await TransferQueue.OpenAsync(state,source);
        Assert((await reopened.GetJobsAsync()).Single().State==QueuedTransferState.Completed && bytes==1);
    }
    private sealed class ProgressSink(List<DownloadProgress> items):IProgress<DownloadProgress>{public void Report(DownloadProgress p)=>items.Add(p);}
    private static async Task SuccessorResume() {
        using var f = new Fixture(); int resolutions = 0, requests = 0;
        using var source = f.Source(false, new Handler((request, _) => {
            if (request.RequestUri!.AbsolutePath.EndsWith("/session", StringComparison.Ordinal))
                return Task.FromResult(Json(new { schemaVersion = 1, principalId = Principal, expiresAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }));
            var envelope = Envelope(false); var manifest = Manifest(false);
            if (++resolutions >= 3) manifest["downloadPath"] = Base(false) + "/windows-successor/files/wsp1_renewed/download";
            envelope["manifest"] = manifest; return Task.FromResult(Json(envelope));
        }), new Handler((request, _) => {
            requests++;
            if (requests == 1) {
                Assert(request.RequestUri!.AbsolutePath == Base(false) + "/files/ond1_renewed/download");
                var interrupted = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new InterruptedPrefix()) };
                interrupted.Headers.ETag = new("\"" + Sha + "\""); interrupted.Content.Headers.ContentLength = Bytes.Length;
                return Task.FromResult(interrupted);
            }
            Assert(request.RequestUri!.AbsolutePath == Base(false) + "/windows-successor/files/wsp1_renewed/download"
                && request.Headers.Range?.ToString() == "bytes=8-" && request.Headers.IfMatch.Single().Tag == "\"" + Sha + "\"");
            var resumed = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(Bytes[8..]) };
            resumed.Headers.ETag = new("\"" + Sha + "\""); resumed.Content.Headers.ContentRange = new ContentRangeHeaderValue(8, Bytes.Length - 1, Bytes.Length);
            return Task.FromResult(resumed);
        }));
        var output = Path.Combine(f.Root, "output"); Directory.CreateDirectory(output);
        var state = Path.Combine(f.Root, "state"); Directory.CreateDirectory(state);
        await using (var queue = await TransferQueue.OpenAsync(state, source)) {
            var id = await queue.EnqueueAsync(Reference, output);
            await queue.StartAsync(id); await queue.WaitForIdleAsync();
            Assert((await queue.GetJobsAsync()).Single().State == QueuedTransferState.Failed);
            Assert(new FileInfo(Directory.GetFiles(output, "*.part", SearchOption.AllDirectories).Single()).Length == 8);
            await queue.RetryAsync(id); await queue.WaitForIdleAsync();
            Assert((await queue.GetJobsAsync()).Single().State == QueuedTransferState.Completed && requests == 2);
        }
        Assert(File.ReadAllBytes(Path.Combine(output, "queue.bin")).SequenceEqual(Bytes));
        foreach (var path in new[] {
            Base(false) + "/files/wsp1_wrong/download", Base(false) + "/windows-successor/files/ond1_wrong/download",
            Base(false) + "/windows-successor/files/wsp1_ok/download?extra=1",
            Base(false) + "/windows-successor/files/wsp1_ok/preview", Base(false) + "/windows-successor/files/wsp1_/download"
        }) {
            var envelope = Envelope(false); var manifest = Manifest(false); manifest["downloadPath"] = path; envelope["manifest"] = manifest;
            using var invalid = f.Source(false, new Handler((_, _) => Task.FromResult(Json(envelope))));
            await Throws<TransferException>(() => invalid.ResolveAsync(Reference));
        }
    }
    private sealed class InterruptedPrefix : MemoryStream {
        private bool sent;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
            if (sent) throw new IOException("Synthetic interruption after owned prefix.");
            sent = true; Bytes.AsMemory(0, 8).CopyTo(buffer); return ValueTask.FromResult(8);
        }
    }
    private sealed class Handler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> action):HttpMessageHandler {
        internal int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken) { Calls++; return action(request,cancellationToken); }
    }
    private sealed class Runner:IAccessCommandRunner {
        internal int Calls,Logins;internal string Token=""; internal Exception? Error; internal TimeSpan Delay; internal Func<CancellationToken,Task>? Gate;
        public async Task<AccessCommandResult> RunAsync(string path,IReadOnlyList<string> arguments,CancellationToken ct) {
            Calls++;if(arguments.Contains("login"))Logins++; if (Error is not null) throw Error;
            if (Gate is { } gate) await gate(ct);
            if (Delay > TimeSpan.Zero) await Task.Delay(Delay, ct);
            Token="eyJhbGciOiJSUzI1NiJ9."+Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new{sub="synthetic-person",exp=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600})).TrimEnd('=').Replace('+','-').Replace('/','_')+".c2ln";
            return new AccessCommandResult(0,Token,"");
        }
    }
    private sealed class Fixture:IDisposable {
        internal string Root=Path.Combine(Path.GetTempPath(),"ltds-queue-source-synthetic-"+Guid.NewGuid().ToString("N"));internal Runner Runner=new();internal CloudflareAccessSession Session;
        internal Fixture(){Directory.CreateDirectory(Root);var binary=Path.Combine(Root,"synthetic.bin");File.WriteAllText(binary,"synthetic owned never executed");Session=new(new Uri("https://source.example.invalid/portal/"),binary,Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(binary))),Runner);}
        internal QueuedDownloadSource Source(bool employee,HttpMessageHandler metadata,HttpMessageHandler? data=null, BusyRetryClock? clock=null) {
            var downloader=data is null?new Downloader(Session):new Downloader(data,[Session.Origin],session:Session);
            return employee?new EmployeeQueuedDownloadSource("staff",Session,metadata,downloader,clock):new PortalQueuedDownloadSource("portal",Session,metadata,downloader);
        }
        public void Dispose()=>Directory.Delete(Root,true);
    }
}
