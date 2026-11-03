#if LEDGETOP_CACHE_RACE_TEST
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using System.Diagnostics;
using LedgeTop.WindowsDownload;

internal static class ExperimentalColdDownloaderTests
{
    private static readonly byte[] Content = "experimental-synthetic-download"u8.ToArray();
    private static readonly byte[] Foreign = "do-not-replace"u8.ToArray();
    private static readonly Uri Origin = new("https://experimental.example.invalid");
    private static readonly ConcurrentDictionary<Guid, Process> OwnedObservers = new();
    private static readonly ConcurrentBag<object> UncertainTestResources = new();
    private static int PendingOwnedResources() => ExperimentalOwnedStream.QuarantinedCountForTest + ExperimentalEntryLease.RetainedCount + ExperimentalReservationOwner.RetainedCount + OwnedObservers.Count + UncertainTestResources.Count;
    private static DownloadSpec Spec => new("synthetic-only", new Uri(Origin, "/data"), "output.bin", Content.Length, "\"v1\"", Convert.ToHexStringLower(SHA256.HashData(Content)));
    private static void Check(bool value) { if (!value) throw new IOException("Experimental cold download assertion failed."); }
    private static (ulong Volume, Guid Id) PhysicalId(string path)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var data = Marshal.AllocHGlobal(24);
        try {
            if (!GetFileInformationByHandleEx(file.SafeFileHandle, 18, data, 24)) throw new IOException("Synthetic reservation ID unavailable.");
            var bytes = new byte[16]; Marshal.Copy(data + 8, bytes, 0, 16);
            return (unchecked((ulong)Marshal.ReadInt64(data)), new Guid(bytes));
        } finally { Marshal.FreeHGlobal(data); }
    }
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
    private static async Task ExpectQuarantineStaleGuard(Func<Task> operation, string expectedEntry)
    {
        var hits = new List<string>();
        PlaceholderHydrationCoordinator.QuarantineStaleGuardTestHook = hits.Add;
        try { await ExpectTransferFailure(operation()); }
        finally { PlaceholderHydrationCoordinator.QuarantineStaleGuardTestHook = null; }
        Check(hits.Count == 1 && string.Equals(hits[0], expectedEntry, StringComparison.OrdinalIgnoreCase));
    }
    private static async Task RunOwnedFixtureAsync(Func<Task> body, Func<int> quarantined, Action cleanup, Action preserve)
    {
        var completed = false;
        try { await body(); completed = true; }
        finally {
            if (!completed) preserve();
            else if (quarantined() == 0) cleanup();
            else { preserve(); throw new IOException("Experimental owner remains quarantined; fixture preserved."); }
        }
    }
    private static Task WithFixture(Func<DirectoryFixture, Task> body)
    {
        if (PendingOwnedResources() != 0) throw new IOException("An experimental owner or observer is still retained; no new fixture was created.");
        var root = new DirectoryFixture();
        return RunOwnedFixtureAsync(() => body(root), PendingOwnedResources,
            () => { try { root.Dispose(); } catch { Console.Error.WriteLine("Synthetic experimental Downloader cleanup incomplete: " + root.Path); throw; } },
            () => Console.Error.WriteLine("Synthetic experimental Downloader fixture preserved: " + root.Path));
    }
    private static async Task<T[]> AwaitRaceOrRetain<T>(Task<T>[] tasks, TimeSpan timeout, Action<Task<T>[]> retain)
    {
        try { return await Task.WhenAll(tasks).WaitAsync(timeout); }
        catch { if (tasks.Any(task => !task.IsCompleted)) retain(tasks); throw; }
    }
    private static async Task RaceRetentionPolicyTest()
    {
        var first = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<int>[]? retained = null; var timedOut = false;
        try { await AwaitRaceOrRetain(new[] { first.Task, second.Task }, TimeSpan.FromMilliseconds(20), tasks => retained = tasks); }
        catch (TimeoutException) { timedOut = true; }
        Check(timedOut && retained is not null && retained.Length == 2 && ReferenceEquals(retained[0], first.Task) && ReferenceEquals(retained[1], second.Task));
        first.SetResult(1); second.SetResult(2);
        Check((await Task.WhenAll(retained!)).SequenceEqual(new[] { 1, 2 }));
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
        rejected = false;
        try { await RunOwnedFixtureAsync(() => Task.CompletedTask, () => 1, Cleanup, Preserve); }
        catch (IOException) { rejected = true; }
        Check(rejected && cleaned == 0 && preserved == 2);
        await RunOwnedFixtureAsync(() => Task.CompletedTask, () => 0, Cleanup, Preserve);
        Check(cleaned == 1 && preserved == 2);
    }
    private static async Task<string> SeedPartial(DirectoryFixture root)
    {
        using var cancel = new CancellationTokenSource();
        using var downloader = Engine((_, _) => Response(Content, new CancelAfterPrefix(Content, cancel)));
        var cancelled = false;
        try { await downloader.DownloadAsync(Spec, root.Path, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
        var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
        Check(cancelled && File.ReadAllBytes(part).SequenceEqual(Content[..4])); return part;
    }
    private static HttpResponseMessage PartialResponse(string etag = "\"v1\"", long start = 4)
    {
        var remaining = Content[4..];
        var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(remaining) };
        response.Headers.ETag = new EntityTagHeaderValue(etag);
        response.Content.Headers.ContentRange = new ContentRangeHeaderValue(start, Content.Length - 1, Content.Length);
        return response;
    }
    private static HttpResponseMessage TailResponse(byte[] bytes, string etag = "\"v1\"", long? start = null)
    {
        var from = start ?? Content.Length - 1;
        var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(bytes) };
        response.Headers.ETag = new EntityTagHeaderValue(etag); response.Content.Headers.ContentLength = 1;
        response.Content.Headers.ContentRange = new ContentRangeHeaderValue(from, Content.Length - 1, Content.Length);
        return response;
    }
    private static async Task<string> SeedFullPartial(DirectoryFixture root, DownloadSpec spec, byte[] bytes)
    {
        using var cancel = new CancellationTokenSource();
        using var downloader = Engine((_, _) => { var response = Response(bytes); response.Content.Headers.ContentLength = spec.Length; return response; });
        Downloader.BeforeExperimentalPromotionTestHook = cancel.Cancel;
        try {
            var cancelled = false;
            try { await downloader.DownloadAsync(spec, root.Path, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            Check(cancelled && File.ReadAllBytes(part).SequenceEqual(bytes)); return part;
        } finally { Downloader.BeforeExperimentalPromotionTestHook = null; }
    }
    private static void CheckResumeRequest(HttpRequestMessage request)
    {
        Check(request.Headers.Range?.Ranges.Single().From == 4 && request.Headers.IfRange?.EntityTag?.ToString() == Spec.ETag &&
            request.Headers.IfMatch.Single().ToString() == Spec.ETag);
    }
    internal static async Task CrashChildAsync(string root, string checkpoint)
    {
        if (!Path.IsPathFullyQualified(root) || root.StartsWith(@"\\", StringComparison.Ordinal) || !Directory.Exists(root) ||
            checkpoint is not ("partial" or "statewrite" or "beforeflush" or "state" or "write" or "eof" or "verified" or "promoted")) throw new IOException("Invalid synthetic crash fixture.");
        Downloader.ExperimentalCrashCheckpointTestHook = reached => {
            if (reached != checkpoint) return;
            Console.WriteLine("READY " + reached); Console.Out.Flush();
            Thread.Sleep(Timeout.Infinite);
        };
        using var downloader = Engine((_, _) => Response(Content, new PrefixStream(Content)));
        await downloader.DownloadAsync(Spec, root);
        throw new IOException("Crash checkpoint was not reached.");
    }
    private static async Task AbruptChildAsync(string root, string checkpoint, Action? beforeStatus = null)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("Synthetic test executable unavailable.");
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase))
            info.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
        info.ArgumentList.Add("--experimental-crash-child"); info.ArgumentList.Add(root); info.ArgumentList.Add(checkpoint);
        var process = Process.Start(info) ?? throw new IOException("Synthetic crash child failed to start.");
        var pid = process.Id; Task? reaper = null; var transferred = false;
        try {
            var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15));
            Check(line == "READY " + checkpoint);
            beforeStatus?.Invoke();
            Check(!process.HasExited);
            process.Kill();
            var exited = ObserveTransferred(process, 10000, ref reaper, ref transferred);
            if (!exited) throw new IOException("Synthetic crash child remains live; preserve fixture and inspect PID " + pid);
            Check(process.ExitCode != 0);
        } catch {
            try {
                if (reaper is null) {
                    // Kill is scoped to the Process object we started. Even if it
                    // already exited or status access fails, observe or retain it.
                    try { process.Kill(); } catch (InvalidOperationException) { }
                    finally { ObserveTransferred(process, 10000, ref reaper, ref transferred); }
                }
            } catch (Exception cleanupError) {
                Console.Error.WriteLine("Synthetic crash child cleanup was uncertain: " + cleanupError.GetType().Name + "; PID " + pid);
            }
            throw;
        } finally { if (!transferred) process.Dispose(); }
    }
    private static async Task AbruptRestartTests()
    {
        foreach (var checkpoint in new[] { "statewrite", "beforeflush", "eof", "verified", "promoted" }) await WithFixture(async root => {
            await AbruptChildAsync(root.Path, checkpoint);
            var states = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).ToArray();
            Check(states.Length == 1);
            var stateBytes = File.ReadAllBytes(states[0]);
            var final = Path.Combine(root.Path, "output.bin");
            if (checkpoint == "promoted") {
                Check(File.Exists(final) && File.ReadAllBytes(final).SequenceEqual(Content));
                var id = PhysicalId(final); var calls = 0;
                using var downloader = Engine((_, _) => { calls++; return Response(Content); });
                await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                Check(calls == 0 && PhysicalId(final) == id && File.ReadAllBytes(final).SequenceEqual(Content) && File.ReadAllBytes(states[0]).SequenceEqual(stateBytes));
                return;
            }
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            var idBefore = PhysicalId(part); var bytes = File.ReadAllBytes(part);
            Check(bytes.Length <= Content.Length && Content.AsSpan(0, bytes.Length).SequenceEqual(bytes));
            if (checkpoint is "statewrite" or "beforeflush") {
                var complete = false;
                try { using var document = System.Text.Json.JsonDocument.Parse(stateBytes); complete = document.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object; }
                catch (System.Text.Json.JsonException) { }
                if (checkpoint == "statewrite") Check(!complete);
                var calls = 0;
                using var downloader = Engine((request, _) => { calls++; Check(request.Headers.Range is null); return Response(Content); });
                if (complete) {
                    var recovered = await downloader.DownloadAsync(Spec, root.Path);
                    Check(calls == 1 && PhysicalId(recovered) == idBefore && File.ReadAllBytes(recovered).SequenceEqual(Content));
                } else {
                    await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                    Check(calls == 0 && PhysicalId(part) == idBefore && File.ReadAllBytes(part).SequenceEqual(bytes) && File.ReadAllBytes(states[0]).SequenceEqual(stateBytes));
                }
                return;
            }
            using var resumed = Engine((request, _) => {
                if (bytes.Length == 0) { Check(request.Headers.Range is null); return Response(Content); }
                var from = bytes.Length == Content.Length ? bytes.Length - 1 : bytes.Length;
                Check(request.Headers.Range?.Ranges.Single().From == from);
                var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(Content[from..]) };
                response.Headers.ETag = new EntityTagHeaderValue(Spec.ETag);
                response.Content.Headers.ContentRange = new ContentRangeHeaderValue(from, Content.Length - 1, Content.Length);
                return response;
            });
            var result = await resumed.DownloadAsync(Spec, root.Path);
            Check(PhysicalId(result) == idBefore && File.ReadAllBytes(result).SequenceEqual(Content));
        });
        await WithFixture(async root => {
            var injected = false;
            try { await AbruptChildAsync(root.Path, "state", () => throw new IOException("Injected status failure.")); }
            catch (IOException error) when (error.Message == "Injected status failure.") { injected = true; }
            Check(injected && PendingOwnedResources() == 0);
            Check(Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Count() == 1 &&
                Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Count() == 1);
        });
        foreach (var checkpoint in new[] { "partial", "state", "write" }) await WithFixture(async root => {
            await AbruptChildAsync(root.Path, checkpoint);
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            var bytes = File.ReadAllBytes(part); var id = PhysicalId(part);
            var states = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).ToArray();
            if (checkpoint == "partial") {
                Check(bytes.Length == 0 && states.Length == 0);
                using var downloader = Engine((_, _) => throw new IOException("Unexpected network request."));
                await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                Check(PhysicalId(part) == id && File.ReadAllBytes(part).SequenceEqual(bytes));
                return;
            }
            Check(states.Length == 1 && bytes.Length <= 4 && Content.AsSpan(0, bytes.Length).SequenceEqual(bytes));
            var state = File.ReadAllBytes(states[0]);
            using var resumed = Engine((request, _) => {
                if (bytes.Length == 0) { Check(request.Headers.Range is null); return Response(Content); }
                Check(request.Headers.Range?.Ranges.Single().From == bytes.Length);
                var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(Content[bytes.Length..]) };
                response.Headers.ETag = new EntityTagHeaderValue(Spec.ETag);
                response.Content.Headers.ContentRange = new ContentRangeHeaderValue(bytes.Length, Content.Length - 1, Content.Length);
                return response;
            });
            var result = await resumed.DownloadAsync(Spec, root.Path);
            Check(PhysicalId(result) == id && File.ReadAllBytes(result).SequenceEqual(Content) && state.Length > 0);
        });
    }
    internal static async Task ReservationCloseChildAsync(string root, string stage)
    {
        if (!Path.IsPathFullyQualified(root) || root.StartsWith(@"\\", StringComparison.Ordinal) || !Directory.Exists(root) ||
            stage is not ("record" or "directory" or "entry" or "lease" or "markerforeign" or "postwrite" or "authdispose" or "authcancel" or "authrace" or "authafterstage" or "authaftercancel" or "authcleanupfail" or "cancelcallbackfail")) throw new IOException("Synthetic teardown input invalid.");
        if (stage == "markerforeign") { await MarkerForeignCloseChildAsync(root); return; }
        if (stage == "postwrite") { await PostWriteStatusChildAsync(root); return; }
        if (stage is "authdispose" or "authcancel" or "authrace" or "authafterstage" or "authaftercancel" or "authcleanupfail" or "cancelcallbackfail") { await AuthorizationBoundaryChildAsync(root, stage); return; }
        var scope = new string('a', 64); var key = new string('b', 64);
        var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
        var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
        File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
        HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
        admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
        var alias = admission; FileStream? entry = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(Path.Combine(entryDir, ".hydration.lock"), FileMode.OpenOrCreate, CancellationToken.None);
        var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = key, Growth = Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 });
        var gate = admission.Quota; ExperimentalReservationOwner? owner = null;
        alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            owner = ExperimentalReservationOwner.Create(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
        }, CancellationToken.None));
        var injected = false; ExperimentalReservationOwner.BeforeTeardownTestHook = current => { if (current == stage) throw new IOException("Injected teardown failure."); };
        try {
            owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                owner.Release(quota);
            }, CancellationToken.None));
        } catch (IOException error) when (error.Message == "Injected teardown failure.") { injected = true; }
        finally { ExperimentalReservationOwner.BeforeTeardownTestHook = null; }
        Check(injected && ExperimentalReservationOwner.RetainedCount == 1);
        var refused = false; try { _ = owner!.Growth; } catch (IOException) { refused = true; } Check(refused);
        AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock"));
        if (stage != "lease") AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
        // Intentionally retain the owner until this synthetic child exits.
    }
    private static async Task AuthorizationBoundaryChildAsync(string applicationRoot, string stage)
    {
        using var source = new CoordinatorSource(); var identity = source.Identity;
        var spec = (await source.ResolveAsync(identity.ResourceReference)).Spec;
        using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", applicationRoot, expectedPrincipal: CoordinatorSource.Principal);
        var root = Path.Combine(applicationRoot, "verified-hydration-v1"); var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
        File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
        Directory.CreateDirectory(Path.Combine(root, identity.ScopeKey, identity.CacheKey));
        HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, identity.ScopeKey + identity.CacheKey, CancellationToken.None);
        admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate); var alias = admission;
        ExperimentalEntryLease? entry = ExperimentalEntryLease.Open(admission, root, identity.ScopeKey, identity.CacheKey); var gate = admission.Quota;
        var growth = spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024;
        var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identity.ScopeKey, Entry = identity.CacheKey, Growth = growth });
        ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null;
        alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            owner = ExperimentalReservationOwner.CreateWithOwnedEntry(root, identity.ScopeKey, identity.CacheKey, bytes, spec, ref admission, ref entry, quota);
        }, CancellationToken.None));
        owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            receipt = owner.ReleaseAndReturn(quota);
        }, CancellationToken.None));
        var recordPath = Path.Combine(reservationDir, identity.ScopeKey + "-" + identity.CacheKey + ".json");
        using var cancellation = new CancellationTokenSource();
        var entered = new ManualResetEventSlim(); var release = new ManualResetEventSlim(); var quotaHeld = new ManualResetEventSlim(); var quotaAttempt = new ManualResetEventSlim();
        Task<string>? stageTask = null; Task? blocker = null;
        try {
            if (stage == "cancelcallbackfail") {
                Check(await coordinator.ExperimentalAuthorizeAndStageAsync(identity, receipt!));
                var fake = SyntheticReceiptDownloadSource.Create(spec, Content, blockCancellationCallback: true, throwCancellationCallback: true);
                var session = await coordinator.ExperimentalStartReceiptDownloadAsync(identity, receipt!, fake);
                try {
                    await fake.Entered.WaitAsync(TimeSpan.FromSeconds(10));
                    var cancellationWait = session.CancelWorkerAndWaitAsync(TimeSpan.FromSeconds(5));
                    await fake.CallbackEntered.WaitAsync(TimeSpan.FromSeconds(10));
                    fake.ReleaseCancellationCallback(); fake.Release();
                    Check(await cancellationWait.WaitAsync(TimeSpan.FromSeconds(10)));
                    var observed = session.WaitAsync();
                    Check(ReferenceEquals(await Task.WhenAny(observed, Task.Delay(TimeSpan.FromSeconds(10))), observed));
                    Check(observed.IsFaulted && observed.Exception!.Flatten().InnerExceptions.Any(e => e is InvalidOperationException && e.Message == "Synthetic cancellation callback failed."));
                    AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock"));
                    AssertOtherProcessCannotOpen(Path.Combine(root, identity.ScopeKey, identity.CacheKey, ".hydration.lock"));
                    var refused = false; try { receipt!.Dispose(); } catch (IOException) { refused = true; } Check(refused && ExperimentalReservationOwner.RetainedCount > 0);
                    receipt = null; // The uncertain receipt stays rooted until this owned child exits.
                } finally { fake.ReleaseCancellationCallback(); fake.Release(); }
                return;
            }
            if (stage == "authrace") {
                blocker = Task.Run(() => { lock (gate) { quotaHeld.Set(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new IOException("Synthetic quota blocker timed out."); } });
                Check(quotaHeld.Wait(TimeSpan.FromSeconds(5)));
                HydrationQuotaGate.BeforeWaitTestHook = () => quotaAttempt.Set();
            } else if (stage is "authafterstage" or "authaftercancel" or "authcleanupfail") {
                PlaceholderHydrationCoordinator.ExperimentalAfterStageTestSignal = entered;
                PlaceholderHydrationCoordinator.ExperimentalAfterStageReleaseTestSignal = release;
            } else {
                PlaceholderHydrationCoordinator.ExperimentalAfterAuthorizationTestSignal = entered;
                PlaceholderHydrationCoordinator.ExperimentalAfterAuthorizationReleaseTestSignal = release;
            }
            stageTask = Task.Run(async () => {
                try { return await coordinator.ExperimentalAuthorizeAndStageAsync(identity, receipt!, cancellation.Token) ? "staged" : "capacity"; }
                catch (ObjectDisposedException) { return "disposed"; } catch (OperationCanceledException) { return "cancelled"; } catch (AccessDeniedException) { return "denied"; }
            });
            if (stage == "authrace") {
                Check(quotaAttempt.Wait(TimeSpan.FromSeconds(5)) && !stageTask.Wait(TimeSpan.FromMilliseconds(150)));
                source.ResolveFailureForTest = new AccessDeniedException(); release.Set();
                Check(await stageTask.WaitAsync(TimeSpan.FromSeconds(10)) == "denied");
                Check(!File.Exists(recordPath)); receipt = null;
                AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true);
            } else if (stage is "authafterstage" or "authaftercancel" or "authcleanupfail") {
                Check(entered.Wait(TimeSpan.FromSeconds(5))); AssertOtherProcessCannotOpen(recordPath);
                AssertOtherProcessOpen(Path.Combine(root, ".hydration-quota-v2.lock"), true);
                if (stage is "authafterstage" or "authcleanupfail") source.ResolveFailureForTest = new AccessDeniedException(); else cancellation.Cancel();
                if (stage == "authcleanupfail") ExperimentalReservationOwner.ReceiptCleanupFailureTestHook = true;
                release.Set(); Check(await stageTask.WaitAsync(TimeSpan.FromSeconds(10)) == (stage == "authaftercancel" ? "cancelled" : "denied"));
                ExperimentalReservationOwner.ReceiptCleanupFailureTestHook = false;
                if (stage == "authcleanupfail") {
                    AssertOtherProcessCannotOpen(recordPath); AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-quota-v2.lock"));
                    AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock"));
                    var refused = false; try { receipt!.Dispose(); } catch (IOException) { refused = true; } Check(refused && ExperimentalReservationOwner.RetainedCount == 1);
                    receipt = null; // Registry retains the uncertain synthetic receipt until child exit.
                } else { Check(!File.Exists(recordPath)); receipt = null; AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true); }
            } else {
                Check(entered.Wait(TimeSpan.FromSeconds(5)));
                if (stage == "authdispose") coordinator.Dispose(); else cancellation.Cancel();
                release.Set(); Check(await stageTask.WaitAsync(TimeSpan.FromSeconds(10)) == (stage == "authdispose" ? "disposed" : "cancelled"));
            }
            if (stage is "authdispose" or "authcancel") { Check(!File.Exists(recordPath)); receipt!.Dispose(); receipt = null; }
        } finally {
            ExperimentalReservationOwner.ReceiptCleanupFailureTestHook = false;
            release.Set(); PlaceholderHydrationCoordinator.ExperimentalAfterAuthorizationTestSignal = null; PlaceholderHydrationCoordinator.ExperimentalAfterAuthorizationReleaseTestSignal = null;
            HydrationQuotaGate.BeforeWaitTestHook = null;
            PlaceholderHydrationCoordinator.ExperimentalAfterStageTestSignal = null; PlaceholderHydrationCoordinator.ExperimentalAfterStageReleaseTestSignal = null;
            // Do not let this synthetic child exit while a started operation is unconfirmed.
            if (stageTask is not null) await stageTask;
            if (blocker is not null) await blocker;
            receipt?.Dispose(); entry?.Dispose(); admission?.Dispose(); entered.Dispose(); release.Dispose(); quotaHeld.Dispose(); quotaAttempt.Dispose();
        }
    }
    private static async Task PostWriteStatusChildAsync(string applicationRoot)
    {
        using var source = new CoordinatorSource(); var firstId = source.Identity;
        var firstSpec = (await source.ResolveAsync(firstId.ResourceReference)).Spec;
        var secondId = firstId with { FileName = "second.bin" }; var secondSpec = firstSpec with { FileName = secondId.FileName };
        using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", applicationRoot, expectedPrincipal: CoordinatorSource.Principal);
        var root = Path.Combine(applicationRoot, "verified-hydration-v1"); var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
        File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
        async Task<ExperimentalReservationOwner.LeaseReceipt> MakeReceipt(PlaceholderIdentity id, DownloadSpec spec) {
            Directory.CreateDirectory(Path.Combine(root, id.ScopeKey, id.CacheKey));
            HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, id.ScopeKey + id.CacheKey, CancellationToken.None);
            admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate); var alias = admission;
            ExperimentalEntryLease? entry = ExperimentalEntryLease.Open(admission, root, id.ScopeKey, id.CacheKey); var gate = admission.Quota;
            var growth = spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024;
            var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey, Growth = growth });
            ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null;
            try {
                alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    owner = ExperimentalReservationOwner.CreateWithOwnedEntry(root, id.ScopeKey, id.CacheKey, bytes, spec, ref admission, ref entry, quota);
                }, CancellationToken.None));
                owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    receipt = owner.ReleaseAndReturn(quota);
                }, CancellationToken.None));
                return receipt!;
            } finally { entry?.Dispose(); admission?.Dispose(); }
        }
        var first = await MakeReceipt(firstId, firstSpec); var second = await MakeReceipt(secondId, secondSpec);
        var entered = new ManualResetEventSlim(); var release = new ManualResetEventSlim(); Task<bool>? stageTask = null;
        try {
            ExperimentalReservationOwner.ReceiptStageAfterWriteTestSignal = entered; ExperimentalReservationOwner.ReceiptStageAfterWriteReleaseTestSignal = release;
            stageTask = Task.Run(() => {
                try { _ = first.StageSyntheticReservationForTest(root, firstId, firstSpec, coordinator); return false; }
                catch (TransferException error) when (error.Message == "Synthetic receipt status changed during creation.") { return true; }
            });
            Check(entered.Wait(TimeSpan.FromSeconds(5)));
            var token = new object(); var injected = false;
            ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = true; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = token;
            try { _ = second.AccountMarker(root, secondId.ScopeKey + secondId.CacheKey, root); }
            catch (IOException error) when (error.Message == "Injected receipt marker failure.") { injected = true; }
            finally { ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = false; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = null; }
            Check(injected); release.Set(); Check(await stageTask.WaitAsync(TimeSpan.FromSeconds(10)));
            var path = Path.Combine(reservationDir, firstId.ScopeKey + "-" + firstId.CacheKey + ".json");
            AssertOtherProcessCannotOpen(path); AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock"));
            AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-quota-v2.lock"));
            AssertOtherProcessCannotOpen(Path.Combine(root, firstId.ScopeKey, firstId.CacheKey, ".hydration.lock"));
            AssertOtherProcessCannotOpen(Path.Combine(root, secondId.ScopeKey, secondId.CacheKey, ".hydration.lock"));
            var admissionRefused = false;
            try { using var unexpected = await HydrationCacheConcurrency.AcquireAsync(root, firstId.ScopeKey + firstId.CacheKey, CancellationToken.None, testTimeout: TimeSpan.FromMilliseconds(100)); }
            catch (TransferException error) when (error.Reason == TransferFailureReason.Timeout) { admissionRefused = true; }
            Check(admissionRefused);
            var refused = false; try { first.Dispose(); } catch (IOException) { refused = true; } Check(refused);
            refused = false; try { second.Dispose(); } catch (IOException) { refused = true; } Check(refused);
            Check(ExperimentalReservationOwner.RetainedCount == 2);
            // Both synthetic receipts intentionally remain quarantined until this child exits.
        } finally {
            release.Set(); ExperimentalReservationOwner.ReceiptStageAfterWriteTestSignal = null; ExperimentalReservationOwner.ReceiptStageAfterWriteReleaseTestSignal = null;
            if (stageTask is not null && !stageTask.IsCompleted) await stageTask;
            entered.Dispose(); release.Dispose();
        }
    }
    private static async Task MarkerForeignCloseChildAsync(string root)
    {
        var scope = new string('a', 64); var key = new string('b', 64); var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
        var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
        File.WriteAllBytes(Path.Combine(root, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
        File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
        var foreignDir = Path.Combine(root, "foreign"); Directory.CreateDirectory(foreignDir);
        var foreign = Path.Combine(foreignDir, ".verified-hydration-owner"); File.WriteAllBytes(foreign, Foreign);
        HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
        admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
        ExperimentalEntryLease? entry = ExperimentalEntryLease.Open(admission, root, scope, key); var alias = admission; var gate = admission.Quota;
        var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = key, Growth = Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 });
        ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null;
        alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            owner = ExperimentalReservationOwner.CreateWithOwnedEntry(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
        }, CancellationToken.None));
        owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            receipt = owner.ReleaseAndReturn(quota);
        }, CancellationToken.None));
        var rejected = false; try { _ = receipt!.AccountMarker(root, scope + key, foreignDir); } catch (IOException) { rejected = true; } Check(rejected);
        rejected = false; try { receipt!.Dispose(); } catch (IOException) { rejected = true; } Check(rejected);
        rejected = false; try { receipt!.SettleInjectedMarkerFailureForTest(new object()); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
        Check(File.ReadAllBytes(foreign).SequenceEqual(Foreign) && ExperimentalReservationOwner.RetainedCount == 1);
        AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
        // A real foreign marker is not auto-settled; retain this synthetic child until it exits.
    }
    private static async Task RunReservationCloseChildAsync(string root, string stage)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("Synthetic test executable unavailable.");
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase)) info.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
        info.ArgumentList.Add("--experimental-reservation-close-child"); info.ArgumentList.Add(root); info.ArgumentList.Add(stage);
        var process = Process.Start(info) ?? throw new IOException("Synthetic teardown child failed to start.");
        Task? reaper = null; var transferred = false; var pid = process.Id;
        try {
            var exited = ObserveTransferred(process, 20000, ref reaper, ref transferred);
            if (!exited) throw new IOException("Synthetic teardown child remains live; preserve fixture and inspect PID " + pid);
            Check(process.ExitCode == 0);
        } finally { if (!transferred) process.Dispose(); }
        await Task.CompletedTask;
    }
    internal static async Task ResumeChildAsync(string root)
    {
        if (!Path.IsPathFullyQualified(root) || root.StartsWith(@"\\", StringComparison.Ordinal) || !Directory.Exists(root)) throw new IOException("Synthetic child root invalid.");
        using var downloader = Engine((request, _) => { CheckResumeRequest(request); return PartialResponse(); });
        var result = await downloader.DownloadAsync(Spec, root);
        Check(File.ReadAllBytes(result).SequenceEqual(Content) && PendingOwnedResources() == 0);
    }
    private static async Task RunResumeChildAsync(string root)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("Synthetic test executable unavailable.");
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase))
            info.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
        info.ArgumentList.Add("--experimental-resume-child"); info.ArgumentList.Add(root);
        var process = Process.Start(info) ?? throw new IOException("Synthetic resume child failed to start."); var pid = process.Id;
        Task? reaper = null; var transferred = false;
        try {
            var exited = ObserveOrRetain(process, 10000, out reaper); transferred = reaper is not null;
            if (!exited) throw new IOException("Synthetic resume child remains live; preserve fixture and inspect PID " + pid);
            Check(process.ExitCode == 0);
        } catch { if (reaper is not null) transferred = true; throw; }
        finally { if (!transferred) process.Dispose(); }
        await Task.CompletedTask;
    }
    private static void AssertOtherProcessCannotOpen(string path) => AssertOtherProcessOpen(path, false);
    private static void AssertOtherProcessOpen(string path, bool shouldOpen)
    {
        var info = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add("-NoProfile"); info.ArgumentList.Add("-NonInteractive"); info.ArgumentList.Add("-Command");
        info.ArgumentList.Add("try { $f = [IO.File]::Open($env:LEDGETOP_SYNTHETIC_PART, 'Open', 'ReadWrite', 'ReadWrite'); $f.Dispose(); exit 0 } catch { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; if ($e -is [IO.IOException] -and (($e.HResult -band 65535) -eq 32)) { exit 17 }; exit 18 }");
        info.Environment["LEDGETOP_SYNTHETIC_PART"] = path;
        var process = Process.Start(info) ?? throw new IOException("Synthetic cross-process test failed to start."); var transferred = false; Task? reaper = null;
        var pid = process.Id; // Capture before a reaper can observe exit and dispose the Process.
        try {
            var exited = ObserveOrRetain(process, 5000, out reaper); transferred = reaper is not null;
            if (!exited) {
                throw new IOException("Synthetic open observer remains live; preserve fixture and inspect PID " + pid);
            }
            Check(process.ExitCode == (shouldOpen ? 0 : 17));
        } catch { if (reaper is not null) transferred = true; throw; }
        finally { if (!transferred) process.Dispose(); }
    }
    private static bool ObserveTransferred(Process process, int timeoutMilliseconds, ref Task? reaper, ref bool transferred, Action? afterObservation = null)
    {
        try {
            var exited = ObserveOrRetain(process, timeoutMilliseconds, out reaper);
            afterObservation?.Invoke();
            return exited;
        } finally { transferred |= reaper is not null; }
    }
    private static bool ObserveOrRetain(Process process, int timeoutMilliseconds, out Task? reaper)
    {
        reaper = null;
        try { if (process.WaitForExit(timeoutMilliseconds)) return true; }
        catch { reaper = TrackOwnedObserver(process); throw; }
        reaper = TrackOwnedObserver(process); return false;
    }
    private static Task TrackOwnedObserver(Process process)
    {
        Guid key;
        do { key = Guid.NewGuid(); } while (!OwnedObservers.TryAdd(key, process));
        return ReapOwnedObserverAsync(key, process);
    }
    private static async Task ReapOwnedObserverAsync(Guid key, Process process)
    {
        try { await process.WaitForExitAsync(); }
        catch (Exception error) { Console.Error.WriteLine("Synthetic observer exit remains uncertain: " + error.GetType().Name); return; }
        if (OwnedObservers.TryRemove(key, out var owned)) owned.Dispose();
    }
    internal static async Task DrainRetainedObserversAsync(bool signal = false)
    {
        if (signal && !OwnedObservers.IsEmpty) { Console.WriteLine("DRAINING"); Console.Out.Flush(); }
        while (!OwnedObservers.IsEmpty) await Task.Delay(250);
    }
    internal static void StartNestedObserverForDrainTest(string eventName)
    {
        if (!eventName.StartsWith("Local\\LedgeTopSyntheticDrain-", StringComparison.Ordinal)) throw new IOException("Synthetic drain event invalid.");
        var info = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add("-NoProfile"); info.ArgumentList.Add("-NonInteractive"); info.ArgumentList.Add("-Command");
        info.ArgumentList.Add("$e = [Threading.EventWaitHandle]::OpenExisting($env:LEDGETOP_SYNTHETIC_OBSERVER_EVENT); try { $e.WaitOne() | Out-Null } finally { $e.Dispose() }");
        info.Environment["LEDGETOP_SYNTHETIC_OBSERVER_EVENT"] = eventName;
        var process = Process.Start(info) ?? throw new IOException("Synthetic nested observer failed to start.");
        Task? reaper = null; var transferred = false;
        try {
            var exited = ObserveTransferred(process, 0, ref reaper, ref transferred);
            if (exited) throw new IOException("Synthetic nested observer exited early.");
            Check(reaper is not null && transferred);
            Console.WriteLine("RETAINED"); Console.Out.Flush();
        } finally { if (!transferred) process.Dispose(); }
    }
    private static async Task ObserverDrainLifecycleTest()
    {
        var name = "Local\\LedgeTopSyntheticDrain-" + Guid.NewGuid().ToString("N");
        var release = new EventWaitHandle(false, EventResetMode.ManualReset, name);
        var executable = Environment.ProcessPath ?? throw new IOException("Synthetic executable unavailable.");
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase)) info.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
        info.ArgumentList.Add("--experimental-observer-drain-child"); info.ArgumentList.Add(name);
        var process = Process.Start(info) ?? throw new IOException("Synthetic drain child failed to start.");
        Task? reaper = null; var transferred = false; var confirmed = false;
        try {
            Check(await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) == "RETAINED");
            Check(await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) == "DRAINING");
            Check(!process.WaitForExit(150));
            release.Set();
            confirmed = ObserveTransferred(process, 10000, ref reaper, ref transferred);
            if (!confirmed) throw new IOException("Synthetic drain child remains live; preserve resources.");
            Check(process.ExitCode == 0);
        } finally {
            release.Set();
            try { if (!confirmed && !transferred) confirmed = ObserveTransferred(process, 10000, ref reaper, ref transferred); }
            finally {
                if (transferred) UncertainTestResources.Add(release);
                else { process.Dispose(); release.Dispose(); }
            }
        }
    }
    private static async Task ObserverReaperTest()
    {
        var eventName = "Local\\LedgeTopSyntheticObserver-" + Guid.NewGuid().ToString("N");
        using var release = new EventWaitHandle(false, EventResetMode.ManualReset, eventName);
        var info = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
        info.ArgumentList.Add("-NoProfile"); info.ArgumentList.Add("-NonInteractive"); info.ArgumentList.Add("-Command");
        info.ArgumentList.Add("$e = [Threading.EventWaitHandle]::OpenExisting($env:LEDGETOP_SYNTHETIC_OBSERVER_EVENT); try { if (-not $e.WaitOne(5000)) { exit 3 } } finally { $e.Dispose() }");
        info.Environment["LEDGETOP_SYNTHETIC_OBSERVER_EVENT"] = eventName;
        var process = Process.Start(info) ?? throw new IOException("Synthetic observer test failed to start.");
        Task? reaped = null; var transferred = false; var injected = false;
        try {
            try {
                ObserveTransferred(process, 0, ref reaped, ref transferred, () => throw new IOException("Injected observation failure."));
            } catch (IOException error) when (error.Message == "Injected observation failure.") { injected = true; }
            Check(injected && transferred && reaped is not null && OwnedObservers.Count == 1);
        } finally { release.Set(); if (!transferred) process.Dispose(); }
        await reaped!.WaitAsync(TimeSpan.FromSeconds(7));
        Check(OwnedObservers.IsEmpty);
    }
    internal static async Task RunAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        await FixturePolicyTests();
        await RaceRetentionPolicyTest();
        await ObserverReaperTest();
        await ObserverDrainLifecycleTest();
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "markers"); Directory.CreateDirectory(root);
            const string markerName = ".verified-hydration-owner";
            var marker = Path.Combine(root, markerName); var expected = "LedgeTop.VerifiedHydration/1\n"u8.ToArray(); File.WriteAllBytes(marker, expected);
            var foreignDir = Path.Combine(root, "foreign"); Directory.CreateDirectory(foreignDir);
            File.WriteAllText(Path.Combine(foreignDir, markerName), "foreign");
            var lockPath = Path.Combine(root, ".hydration-cache.lock");
            var first = await HydrationCacheConcurrency.AcquireAsync(root, "one", CancellationToken.None);
            var second = await HydrationCacheConcurrency.AcquireAsync(root, "two", CancellationToken.None);
            HydrationCacheConcurrency.Lease.MarkerFacade? owner = null;
            try {
                var refused = false; try { _ = first.ExperimentalMarkers; } catch (TransferException) { refused = true; } Check(refused);
                first.AcquireExclusiveLegacy(lockPath, FileMode.OpenOrCreate); AssertOtherProcessCannotOpen(lockPath);
                owner = first.ExperimentalMarkers; _ = second.ExperimentalMarkers;
                var invalid = false; try { owner.ValidateExisting(foreignDir, markerName, expected); } catch (IOException) { invalid = true; }
                Check(invalid && File.ReadAllText(Path.Combine(foreignDir, markerName)) == "foreign");
                foreach (var bad in new[] { "CON", "owner:stream", markerName + ":stream" }) {
                    invalid = false; try { owner.ValidateExisting(root, bad, expected); } catch (IOException) { invalid = true; } Check(invalid);
                }
                owner.ValidateExisting(root, markerName, expected);
                refused = false; try { owner.ValidateExisting(root, markerName, "different"u8.ToArray()); } catch (IOException) { refused = true; }
                Check(refused); first.Dispose();
                refused = false; try { _ = first.ExperimentalMarkers; } catch (ObjectDisposedException) { refused = true; }
                Check(refused);
                second.ExperimentalMarkers.ValidateExisting(root, markerName, expected);
                refused = false; try { File.Move(marker, marker + ".moved"); } catch (IOException) { refused = true; } catch (UnauthorizedAccessException) { refused = true; }
                Check(refused && File.ReadAllBytes(marker).SequenceEqual(expected));
            } finally { first.Dispose(); second.Dispose(); }
            var rejected = false; try { owner!.ValidateExisting(root, markerName, expected); } catch (ObjectDisposedException) { rejected = true; }
            Check(rejected); File.Move(marker, marker + ".moved");
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "quarantine"); Directory.CreateDirectory(root);
            var marker = Path.Combine(root, ".verified-hydration-owner"); var bytes = "LedgeTop.VerifiedHydration/1\n"u8.ToArray(); File.WriteAllBytes(marker, bytes);
            var lockPath = Path.Combine(root, ".hydration-cache.lock");
            var lease = await HydrationCacheConcurrency.AcquireAsync(root, "one", CancellationToken.None);
            lease.AcquireExclusiveLegacy(lockPath, FileMode.OpenOrCreate); lease.ExperimentalMarkers.ValidateExisting(root, ".verified-hydration-owner", bytes);
            var failed = false; ExperimentalRootMarkerOwner.BeforeCloseTestHook = () => throw new IOException("Injected close failure.");
            try { lease.Dispose(); } catch (IOException error) when (error.Message == "Injected close failure.") { failed = true; }
            finally { ExperimentalRootMarkerOwner.BeforeCloseTestHook = null; }
            Check(failed); AssertOtherProcessCannotOpen(lockPath);
            var rejected = false; try { await HydrationCacheConcurrency.AcquireAsync(root, "two", CancellationToken.None); } catch (TransferException) { rejected = true; }
            Check(rejected && File.ReadAllBytes(marker).SequenceEqual(bytes));
            HydrationCacheConcurrency.SettleInjectedMarkerCloseForTest(root);
            AssertOtherProcessOpen(lockPath, true);
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "created"); Directory.CreateDirectory(root);
            var first = await HydrationCacheConcurrency.AcquireAsync(root, "one", CancellationToken.None);
            var second = await HydrationCacheConcurrency.AcquireAsync(root, "two", CancellationToken.None);
            var marker = Path.Combine(root, ".verified-hydration-owner"); var expected = "LedgeTop.VerifiedHydration/1\n"u8.ToArray();
            try {
                first.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
                var owner = first.ExperimentalMarkers;
                var foreignDir = Path.Combine(root, "foreign"); Directory.CreateDirectory(foreignDir);
                var foreignPath = Path.Combine(foreignDir, ".verified-hydration-owner"); File.WriteAllBytes(foreignPath, Foreign);
                var refused = false; try { owner.CreateNew(foreignDir); } catch (IOException) { refused = true; }
                Check(refused && File.ReadAllBytes(foreignPath).SequenceEqual(Foreign));
                var results = await Task.WhenAll(Task.Run(() => { try { owner.CreateNew(root); return true; } catch (IOException) { return false; } }),
                    Task.Run(() => { try { second.ExperimentalMarkers.CreateNew(root); return true; } catch (IOException) { return false; } }));
                Check(results.Count(x => x) == 1); second.ExperimentalMarkers.ValidateExisting(root, ".verified-hydration-owner", expected);
                AssertOtherProcessCannotOpen(marker);
            } finally { first.Dispose(); second.Dispose(); }
            Check(File.ReadAllBytes(marker).SequenceEqual(expected));
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "create-failure"); Directory.CreateDirectory(root);
            var lease = await HydrationCacheConcurrency.AcquireAsync(root, "one", CancellationToken.None);
            var lockPath = Path.Combine(root, ".hydration-cache.lock"); lease.AcquireExclusiveLegacy(lockPath, FileMode.OpenOrCreate);
            var owner = lease.ExperimentalMarkers; var failed = false;
            ExperimentalRootMarkerOwner.AfterCreateTestHook = () => throw new IOException("Injected creation failure.");
            try { owner.CreateNew(root); } catch (IOException error) when (error.Message == "Injected creation failure.") { failed = true; }
            finally { ExperimentalRootMarkerOwner.AfterCreateTestHook = null; }
            Check(failed); var refused = false;
            try { lease.Dispose(); } catch (IOException) { refused = true; }
            Check(refused); AssertOtherProcessCannotOpen(lockPath);
            refused = false; try { await HydrationCacheConcurrency.AcquireAsync(root, "other", CancellationToken.None); } catch (TransferException) { refused = true; }
            Check(refused && File.Exists(Path.Combine(root, ".verified-hydration-owner")));
            HydrationCacheConcurrency.SettleInjectedMarkerCreateForTest(root); AssertOtherProcessOpen(lockPath, true);
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "lease-race"); Directory.CreateDirectory(root);
            var first = await HydrationCacheConcurrency.AcquireAsync(root, "one", CancellationToken.None);
            var second = await HydrationCacheConcurrency.AcquireAsync(root, "two", CancellationToken.None);
            first.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
            var facade = first.ExperimentalMarkers; var other = second.ExperimentalMarkers;
            var entered = new ManualResetEventSlim(); var release = new ManualResetEventSlim(); var disposing = new ManualResetEventSlim();
            Task? create = null; Task? close = null;
            try {
                ExperimentalRootMarkerOwner.AfterCreateTestHook = () => { entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new IOException("Synthetic lease barrier timed out."); };
                create = Task.Run(() => facade.CreateNew(root));
                Check(entered.Wait(TimeSpan.FromSeconds(5)));
                close = Task.Run(() => { disposing.Set(); first.Dispose(); });
                Check(disposing.Wait(TimeSpan.FromSeconds(5)) && !close.Wait(TimeSpan.FromMilliseconds(150)));
                release.Set(); await Task.WhenAll(create, close).WaitAsync(TimeSpan.FromSeconds(10));
                var rejected = false; try { facade.ValidateExisting(root, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray()); } catch (ObjectDisposedException) { rejected = true; }
                Check(rejected); rejected = false;
                try { facade.CreateNew(root); } catch (ObjectDisposedException) { rejected = true; }
                Check(rejected); rejected = false;
                var detached = Path.Combine(root, "detached.lock");
                try { first.AcquireExclusiveLegacy(detached, FileMode.OpenOrCreate); } catch (ObjectDisposedException) { rejected = true; }
                Check(rejected && !File.Exists(detached));
                other.ValidateExisting(root, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            } finally {
                release.Set(); ExperimentalRootMarkerOwner.AfterCreateTestHook = null;
                var pending = new[] { create, close }.Where(task => task is not null).Cast<Task>().ToArray();
                try { await Task.WhenAll(pending).WaitAsync(TimeSpan.FromSeconds(10)); }
                finally {
                    if (pending.All(task => task.IsCompleted)) { try { try { first.Dispose(); } finally { second.Dispose(); } } finally { entered.Dispose(); release.Dispose(); disposing.Dispose(); } }
                    else { UncertainTestResources.Add((first, second, pending, entered, release, disposing)); Console.Error.WriteLine("Synthetic lease test resources remain uncertain; preserve fixture."); }
                }
            }
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "legacy-race"); Directory.CreateDirectory(root);
            var lease = await HydrationCacheConcurrency.AcquireAsync(root, "one", CancellationToken.None);
            var entered = new ManualResetEventSlim(); var release = new ManualResetEventSlim(); var disposing = new ManualResetEventSlim();
            Task? acquisition = null; Task? close = null;
            try {
                HydrationCacheConcurrency.BeforeLegacyAcquireTestHook = () => { entered.Set(); if (!release.Wait(TimeSpan.FromSeconds(10))) throw new IOException("Synthetic legacy barrier timed out."); };
                acquisition = Task.Run(() => lease.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate));
                Check(entered.Wait(TimeSpan.FromSeconds(5)));
                close = Task.Run(() => { disposing.Set(); lease.Dispose(); });
                Check(disposing.Wait(TimeSpan.FromSeconds(5)) && !close.Wait(TimeSpan.FromMilliseconds(150)));
                release.Set(); await Task.WhenAll(acquisition, close).WaitAsync(TimeSpan.FromSeconds(10));
                var refused = false; try { lease.AcquireExclusiveLegacy(Path.Combine(root, "detached.lock"), FileMode.OpenOrCreate); } catch (ObjectDisposedException) { refused = true; }
                Check(refused && !File.Exists(Path.Combine(root, "detached.lock")));
                AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true);
            } finally {
                release.Set(); HydrationCacheConcurrency.BeforeLegacyAcquireTestHook = null;
                var pending = new[] { acquisition, close }.Where(task => task is not null).Cast<Task>().ToArray();
                try { await Task.WhenAll(pending).WaitAsync(TimeSpan.FromSeconds(10)); }
                finally {
                    if (pending.All(task => task.IsCompleted)) { try { lease.Dispose(); } finally { entered.Dispose(); release.Dispose(); disposing.Dispose(); } }
                    else { UncertainTestResources.Add((lease, pending, entered, release, disposing)); Console.Error.WriteLine("Synthetic legacy test resources remain uncertain; preserve fixture."); }
                }
            }
        });
        await WithFixture(async fixture => {
            using var source = new CoordinatorSource();
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", fixture.Path, maximumFileBytes: Content.Length,
                maximumCacheBytes: 1024, expectedPrincipal: CoordinatorSource.Principal);
            var root = Path.Combine(fixture.Path, "verified-hydration-v1");
            var lease = await HydrationCacheConcurrency.AcquireAsync(root, "scan", CancellationToken.None);
            try {
                lease.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
                var scope = Path.Combine(root, "synthetic-scope"); Directory.CreateDirectory(scope);
                lease.ExperimentalMarkers.CreateNew(scope);
                var marker = Path.Combine(scope, ".verified-hydration-owner"); AssertOtherProcessCannotOpen(marker);
                var ownerLength = System.Text.Encoding.UTF8.GetByteCount("LedgeTop.VerifiedHydration/1\n");
                var used = coordinator.ExperimentalCheckMarkerCapacity(lease, 0);
                Check(used == 2 * ownerLength && coordinator.ExperimentalCheckMarkerCapacity(lease, 1024 - used) == used);
                var rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(lease, 1025 - used); } catch (TransferException) { rejected = true; }
                Check(rejected);
                var reservations = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservations);
                File.WriteAllBytes(Path.Combine(reservations, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                var scopeKey = new string('a', 64); var entryKey = new string('b', 64);
                var record = Path.Combine(reservations, scopeKey + "-" + entryKey + ".json");
                File.WriteAllBytes(record, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scopeKey, Entry = entryKey, Growth = 11L }));
                var actualUsed = coordinator.ExperimentalCheckMarkerCapacity(lease, 0);
                Check(actualUsed == used + ownerLength + new FileInfo(record).Length);
                Check(coordinator.ExperimentalCheckMarkerCapacity(lease, 1024 - actualUsed - 11) == actualUsed);
                rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(lease, 1025 - actualUsed - 11); } catch (TransferException) { rejected = true; }
                Check(rejected && File.Exists(record)); File.Delete(record);
                var foreignRoot = Path.Combine(fixture.Path, "other-root"); Directory.CreateDirectory(foreignRoot);
                var other = await HydrationCacheConcurrency.AcquireAsync(foreignRoot, "other", CancellationToken.None);
                try {
                    other.AcquireExclusiveLegacy(Path.Combine(foreignRoot, ".hydration-cache.lock"), FileMode.OpenOrCreate);
                    rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(other, 0); } catch (TransferException) { rejected = true; }
                    Check(rejected && !File.Exists(Path.Combine(foreignRoot, ".hydration-quota-v2.lock")));
                } finally { other.Dispose(); }
                var foreign = Path.Combine(root, "foreign"); Directory.CreateDirectory(foreign);
                var foreignMarker = Path.Combine(foreign, ".verified-hydration-owner"); File.WriteAllBytes(foreignMarker, Foreign);
                rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(lease, 0); } catch (IOException) { rejected = true; }
                Check(rejected && File.ReadAllBytes(foreignMarker).SequenceEqual(Foreign));
                File.Delete(foreignMarker);
                var variantMarker = Path.Combine(foreign, ".VERIFIED-HYDRATION-OWNER"); File.WriteAllBytes(variantMarker, "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(lease, 0); } catch (IOException) { rejected = true; }
                Check(rejected && File.Exists(variantMarker));
            } finally { lease.Dispose(); }
            var disposedRejected = false;
            try { coordinator.ExperimentalCheckMarkerCapacity(lease, 0); } catch (ObjectDisposedException) { disposedRejected = true; }
            Check(disposedRejected);
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "reservation-owner"); Directory.CreateDirectory(root);
            var scope = new string('a', 64); var key = new string('b', 64);
            var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
            var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
            File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
            admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
            var alias = admission;
            FileStream? entry = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(Path.Combine(entryDir, ".hydration.lock"), FileMode.OpenOrCreate, CancellationToken.None);
            var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = key, Growth = Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 });
            var gate = admission.Quota; ExperimentalReservationOwner? owner = null;
            try {
                var wrongGrowth = false;
                try { alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    _ = ExperimentalReservationOwner.Create(root, scope, key, bytes, Spec with { Length = Spec.Length + 1 }, ref admission, ref entry, quota);
                }, CancellationToken.None)); } catch (IOException) { wrongGrowth = true; }
                Check(wrongGrowth && admission is not null && entry is not null && ExperimentalReservationOwner.RetainedCount == 0);
                alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    owner = ExperimentalReservationOwner.Create(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                }, CancellationToken.None));
                Check(owner is not null && owner.Growth == Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 && admission is null && entry is null && ExperimentalReservationOwner.RetainedCount == 1);
                var refused = false; try { alias.AcquireExclusiveLegacy(Path.Combine(root, "detached"), FileMode.OpenOrCreate); } catch (ObjectDisposedException) { refused = true; }
                Check(refused);
                var path = Path.Combine(reservationDir, scope + "-" + key + ".json"); AssertOtherProcessCannotOpen(path);
                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                var blocked = false;
                try { using var unexpected = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None, testTimeout: TimeSpan.FromMilliseconds(100)); }
                catch (TransferException error) when (error.Reason == TransferFailureReason.Timeout) { blocked = true; }
                Check(blocked);
                owner!.Verify(); var injected = false;
                ExperimentalReservationOwner.BeforeDispositionTestHook = () => throw new IOException("Injected disposition failure.");
                try {
                    owner.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                        using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                        _ = owner.ReleaseAndReturn(quota);
                    }, CancellationToken.None));
                } catch (IOException error) when (error.Message == "Injected disposition failure.") { injected = true; }
                finally { ExperimentalReservationOwner.BeforeDispositionTestHook = null; }
                Check(injected && ExperimentalReservationOwner.RetainedCount == 1); AssertOtherProcessCannotOpen(path);
                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                using var pendingDeleteReader = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var postInjected = false; ExperimentalReservationOwner.AfterDispositionCloseTestHook = () => throw new IOException("Injected post-disposition failure.");
                try {
                    owner.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                        using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                        owner.SettleInjectedDispositionFailureForTest(quota);
                    }, CancellationToken.None));
                } catch (IOException error) when (error.Message == "Injected post-disposition failure.") { postInjected = true; }
                finally { ExperimentalReservationOwner.AfterDispositionCloseTestHook = null; }
                Check(postInjected && ExperimentalReservationOwner.RetainedCount == 1);
                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                var denied = false; try { _ = owner.Growth; } catch (IOException) { denied = true; } Check(denied);
                denied = false; try { owner.Verify(); } catch (IOException) { denied = true; } Check(denied);
                var pendingRefused = false;
                try { owner.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    owner.SettleInjectedPostDispositionFailureForTest(quota);
                }, CancellationToken.None)); } catch (IOException) { pendingRefused = true; }
                Check(pendingRefused && ExperimentalReservationOwner.RetainedCount == 1);
                pendingDeleteReader.Dispose();
                owner.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    owner.SettleInjectedPostDispositionFailureForTest(quota);
                }, CancellationToken.None));
                Check(!File.Exists(path) && ExperimentalReservationOwner.RetainedCount == 0);
                AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true);
                File.WriteAllBytes(path, Foreign);
                admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
                admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open);
                entry = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(Path.Combine(entryDir, ".hydration.lock"), FileMode.Open, CancellationToken.None);
                gate = admission.Quota; var collision = false;
                try {
                    admission.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                        using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                        _ = ExperimentalReservationOwner.Create(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                    }, CancellationToken.None));
                } catch (IOException) { collision = true; }
                Check(collision && admission is null && entry is null && ExperimentalReservationOwner.RetainedCount == 0 && File.ReadAllBytes(path).SequenceEqual(Foreign));
                AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true);
            } finally { entry?.Dispose(); admission?.Dispose(); }
        });
        foreach (var stage in new[] { "record", "directory", "entry", "lease", "markerforeign", "postwrite", "authdispose", "authcancel", "authrace", "authafterstage", "authaftercancel", "authcleanupfail", "cancelcallbackfail" }) await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "teardown"); Directory.CreateDirectory(root);
            await RunReservationCloseChildAsync(root, stage);
            var cacheRoot = stage is "postwrite" or "authdispose" or "authcancel" or "authrace" or "authafterstage" or "authaftercancel" or "authcleanupfail" or "cancelcallbackfail" ? Path.Combine(root, "verified-hydration-v1") : root;
            AssertOtherProcessOpen(Path.Combine(cacheRoot, ".hydration-cache.lock"), true);
            if (stage is "postwrite" or "authcleanupfail") {
                using var source = new CoordinatorSource(); var identity = source.Identity;
                var spec = (await source.ResolveAsync(identity.ResourceReference)).Spec;
                var growth = spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024;
                var path = Path.Combine(cacheRoot, ".hydration-reservations-v2", identity.ScopeKey + "-" + identity.CacheKey + ".json");
                var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identity.ScopeKey, Entry = identity.CacheKey, Growth = growth });
                Check(File.ReadAllBytes(path).SequenceEqual(bytes));
            }
        });
        await WithFixture(async fixture => {
            using var source = new CoordinatorSource();
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", fixture.Path, maximumFileBytes: Content.Length,
                maximumCacheBytes: 100000, expectedPrincipal: CoordinatorSource.Principal);
            var root = Path.Combine(fixture.Path, "verified-hydration-v1");
            var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
            File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            var scope = new string('a', 64); var growth = Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024;
            async Task<(ExperimentalReservationOwner Owner, object Gate, string Path, int RecordSize)> MakeOwner(char keyChar) {
                var key = new string(keyChar, 64); var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
                HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
                admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
                var alias = admission; FileStream? entry = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(Path.Combine(entryDir, ".hydration.lock"), FileMode.OpenOrCreate, CancellationToken.None);
                var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = key, Growth = growth });
                var gate = admission.Quota; ExperimentalReservationOwner? owner = null;
                try {
                    alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                        using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                        owner = ExperimentalReservationOwner.Create(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                    }, CancellationToken.None));
                    return (owner!, gate, Path.Combine(reservationDir, scope + "-" + key + ".json"), bytes.Length);
                } finally { entry?.Dispose(); admission?.Dispose(); }
            }
            var one = await MakeOwner('b'); var two = await MakeOwner('c'); var oneSettled = false;
            var scanner = await HydrationCacheConcurrency.AcquireAsync(root, "scan-ledger", CancellationToken.None);
            try {
                scanner.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open);
                AssertOtherProcessCannotOpen(one.Path); AssertOtherProcessCannotOpen(two.Path);
                var used = coordinator.ExperimentalCheckMarkerCapacity(scanner, 0);
                var ownerLength = System.Text.Encoding.UTF8.GetByteCount("LedgeTop.VerifiedHydration/1\n");
                Check(used == 2 * ownerLength + one.RecordSize + two.RecordSize);
                Check(coordinator.ExperimentalCheckMarkerCapacity(scanner, 100000 - used - 2 * growth) == used);
                var refused = false; try { coordinator.ExperimentalCheckMarkerCapacity(scanner, 100001 - used - 2 * growth); } catch (TransferException) { refused = true; } Check(refused);
                PlaceholderHydrationCoordinator.ExperimentalOmitReservationFromWalkTestHook = p => string.Equals(p, one.Path, StringComparison.OrdinalIgnoreCase);
                try { refused = false; try { coordinator.ExperimentalCheckMarkerCapacity(scanner, 0); } catch (TransferException) { refused = true; } Check(refused); }
                finally { PlaceholderHydrationCoordinator.ExperimentalOmitReservationFromWalkTestHook = null; }
                var foreignKey = new string('d', 64); var unknown = Path.Combine(reservationDir, scope + "-" + foreignKey + ".json");
                var foreignBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = foreignKey, Growth = 11L });
                File.WriteAllBytes(unknown, foreignBytes);
                Check(coordinator.ExperimentalCheckMarkerCapacity(scanner, 100000 - used - foreignBytes.Length - 2 * growth - 11) == used + foreignBytes.Length);
                refused = false; try { coordinator.ExperimentalCheckMarkerCapacity(scanner, 100001 - used - foreignBytes.Length - 2 * growth - 11); } catch (TransferException) { refused = true; } Check(refused);
                File.Delete(unknown); File.WriteAllBytes(unknown, Foreign);
                refused = false; try { coordinator.ExperimentalCheckMarkerCapacity(scanner, 0); } catch (Exception error) when (error is IOException or System.Text.Json.JsonException or TransferException) { refused = true; }
                Check(refused && File.ReadAllBytes(unknown).SequenceEqual(Foreign)); File.Delete(unknown);
                var injected = false; ExperimentalReservationOwner.BeforeDispositionTestHook = () => throw new IOException("Injected ledger failure.");
                try { one.Owner.RunWithLeaseForTest(() => HydrationQuotaGate.Run(one.Gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    one.Owner.Release(quota);
                }, CancellationToken.None)); } catch (IOException error) when (error.Message == "Injected ledger failure.") { injected = true; }
                finally { ExperimentalReservationOwner.BeforeDispositionTestHook = null; }
                refused = false; try { coordinator.ExperimentalCheckMarkerCapacity(scanner, 0); } catch (IOException) { refused = true; }
                Check(injected && refused && ExperimentalReservationOwner.RetainedCount == 2);
                one.Owner.RunWithLeaseForTest(() => HydrationQuotaGate.Run(one.Gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    one.Owner.SettleInjectedDispositionFailureForTest(quota);
                }, CancellationToken.None)); oneSettled = true;
            } finally {
                scanner.Dispose();
                void ReleaseOwner((ExperimentalReservationOwner Owner, object Gate, string Path, int RecordSize) item) => item.Owner.RunWithLeaseForTest(() => HydrationQuotaGate.Run(item.Gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    item.Owner.Release(quota);
                }, CancellationToken.None));
                try { if (!oneSettled) ReleaseOwner(one); } finally { ReleaseOwner(two); }
            }
            Check(ExperimentalReservationOwner.RetainedCount == 0);
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "return-leases"); Directory.CreateDirectory(root);
            var scope = new string('a', 64); var key = new string('b', 64); var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
            var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
            File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
            admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate); var alias = admission;
            FileStream? entry = await PlaceholderHydrationCoordinator.OpenEntryLeaseAsync(Path.Combine(entryDir, ".hydration.lock"), FileMode.OpenOrCreate, CancellationToken.None);
            var gate = admission.Quota; var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = key, Growth = Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 });
            ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null;
            try {
                alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    owner = ExperimentalReservationOwner.Create(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                }, CancellationToken.None));
                var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                async Task<ExperimentalReservationOwner.LeaseReceipt?> Attempt() {
                    await start.Task;
                    try {
                        ExperimentalReservationOwner.LeaseReceipt? value = null;
                        owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                            value = owner.ReleaseAndReturn(quota);
                        }, CancellationToken.None));
                        return value;
                    } catch (ObjectDisposedException) { return null; } catch (IOException) { return null; }
                }
                var first = Task.Run(Attempt); var second = Task.Run(Attempt); start.SetResult();
                var results = await AwaitRaceOrRetain(new[] { first, second }, TimeSpan.FromSeconds(10),
                    tasks => { UncertainTestResources.Add((fixture, owner!, tasks)); Console.Error.WriteLine("Synthetic return race remains uncertain; fixture and both tasks retained: " + fixture.Path); });
                Check(results.Count(x => x is not null) == 1); receipt = results.Single(x => x is not null);
                var recordPath = Path.Combine(reservationDir, scope + "-" + key + ".json"); Check(!File.Exists(recordPath));
                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                var refused = false; try { alias.AcquireExclusiveLegacy(Path.Combine(root, "detached"), FileMode.OpenOrCreate); } catch (ObjectDisposedException) { refused = true; } Check(refused);
                refused = false; try { using var unexpected = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None, testTimeout: TimeSpan.FromMilliseconds(100)); }
                catch (TransferException error) when (error.Reason == TransferFailureReason.Timeout) { refused = true; } Check(refused);
                receipt!.Dispose(); receipt.Dispose(); receipt = null;
                AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true); AssertOtherProcessOpen(Path.Combine(entryDir, ".hydration.lock"), true);
            } finally { receipt?.Dispose(); entry?.Dispose(); admission?.Dispose(); }
            Check(ExperimentalReservationOwner.RetainedCount == 0);
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "owned-entry"); Directory.CreateDirectory(root);
            var scope = new string('a', 64); var key = new string('b', 64); var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
            var admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
            ExperimentalEntryLease? original = null; ExperimentalEntryLease? winner = null; var raceUncertain = false;
            try {
                var rejected = false; try { _ = ExperimentalEntryLease.Open(admission, root, scope, key); } catch (TransferException) { rejected = true; } Check(rejected);
                admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
                rejected = false; try { _ = ExperimentalEntryLease.Open(admission, root, scope, new string('c', 64)); } catch (TransferException) { rejected = true; } Check(rejected);
                using (var blocker = new FileStream(Path.Combine(entryDir, ".hydration.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
                    rejected = false; try { _ = ExperimentalEntryLease.Open(admission, root, scope, key); } catch (IOException) { rejected = true; } Check(rejected);
                }
                original = ExperimentalEntryLease.Open(admission, root, scope, key); var alias = original;
                rejected = false; try { admission.Dispose(); } catch (IOException) { rejected = true; } Check(rejected);
                rejected = false; try { _ = admission.TransferForReservationTest(scope + key); } catch (TransferException) { rejected = true; } Check(rejected);
                AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                async Task<ExperimentalEntryLease?> Move() { await start.Task; try { return alias.Move(); } catch (ObjectDisposedException) { return null; } }
                var first = Task.Run(Move); var second = Task.Run(Move); start.SetResult();
                var moved = await AwaitRaceOrRetain(new[] { first, second }, TimeSpan.FromSeconds(10), tasks => { raceUncertain = true; UncertainTestResources.Add((fixture, admission, alias, tasks)); });
                Check(moved.Count(item => item is not null) == 1); winner = moved.Single(item => item is not null);
                rejected = false; try { alias.Validate(); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                rejected = false; try { alias.Dispose(); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                winner!.Validate(); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                var active = winner; var nextStart = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                async Task<(ExperimentalEntryLease? Moved, bool Disposed)> MoveAgain() { await nextStart.Task; try { return (active.Move(), false); } catch (ObjectDisposedException) { return (null, false); } }
                async Task<(ExperimentalEntryLease? Moved, bool Disposed)> DisposeRace() { await nextStart.Task; try { active.Dispose(); return (null, true); } catch (ObjectDisposedException) { return (null, false); } }
                var moving = Task.Run(MoveAgain); var disposing = Task.Run(DisposeRace); nextStart.SetResult();
                var race = await AwaitRaceOrRetain(new[] { moving, disposing }, TimeSpan.FromSeconds(10), tasks => { raceUncertain = true; UncertainTestResources.Add((fixture, admission, active, tasks)); });
                var next = race[0].Moved; Check((next is not null) != race[1].Disposed);
                if (next is not null) { next.Validate(); next.Dispose(); }
                winner = null; original = null;
                AssertOtherProcessOpen(Path.Combine(entryDir, ".hydration.lock"), true);
            } finally { if (!raceUncertain) { winner?.Dispose(); if (original is not null) { try { original.Dispose(); } catch (ObjectDisposedException) { } } admission.Dispose(); } }
            Check(ExperimentalEntryLease.RetainedCount == 0);
        });
        await WithFixture(async fixture => {
            using var capacitySource = new CoordinatorSource();
            using var capacityCoordinator = new PlaceholderHydrationCoordinator(capacitySource, "pilot", fixture.Path, maximumFileBytes: Content.Length, maximumCacheBytes: 10000, expectedPrincipal: CoordinatorSource.Principal);
            var root = Path.Combine(fixture.Path, "verified-hydration-v1");
            var scope = new string('a', 64); var key = new string('b', 64); var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
            var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
            File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            var path = Path.Combine(reservationDir, scope + "-" + key + ".json");
            var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = key, Growth = Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 });
            HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
            admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
            ExperimentalEntryLease? entry = ExperimentalEntryLease.Open(admission, root, scope, key); var stale = entry; var current = entry.Move();
            var alias = admission; var gate = admission.Quota; ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null; var receiptUncertain = false;
            try {
                entry = stale; var rejected = false;
                try { alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    _ = ExperimentalReservationOwner.CreateWithOwnedEntry(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                }, CancellationToken.None)); } catch (ObjectDisposedException) { rejected = true; }
                Check(rejected && admission is not null); current.Validate(); entry = current;
                File.WriteAllBytes(path, Foreign); rejected = false;
                try { alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    _ = ExperimentalReservationOwner.CreateWithOwnedEntry(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                }, CancellationToken.None)); } catch (IOException) { rejected = true; }
                Check(rejected && admission is null && entry is null && ExperimentalReservationOwner.RetainedCount == 0 && ExperimentalEntryLease.RetainedCount == 0 && File.ReadAllBytes(path).SequenceEqual(Foreign));
                File.Delete(path); admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
                admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open); alias = admission;
                entry = ExperimentalEntryLease.Open(admission, root, scope, key); stale = entry; gate = admission.Quota;
                alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    owner = ExperimentalReservationOwner.CreateWithOwnedEntry(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                }, CancellationToken.None));
                Check(admission is null && entry is null && owner is not null);
                rejected = false; try { stale.Validate(); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                rejected = false; try { alias.AcquireExclusiveLegacy(Path.Combine(root, "detached"), FileMode.OpenOrCreate); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                AssertOtherProcessCannotOpen(path); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                var failed = false; ExperimentalReservationOwner.BeforeDispositionTestHook = () => throw new IOException("Injected joint failure.");
                try { owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    _ = owner.ReleaseAndReturn(quota);
                }, CancellationToken.None)); } catch (IOException error) when (error.Message == "Injected joint failure.") { failed = true; }
                finally { ExperimentalReservationOwner.BeforeDispositionTestHook = null; }
                Check(failed && ExperimentalReservationOwner.RetainedCount == 1 && ExperimentalEntryLease.RetainedCount == 1);
                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                async Task<ExperimentalReservationOwner.LeaseReceipt?> Attempt() {
                    await start.Task;
                    try { ExperimentalReservationOwner.LeaseReceipt? value = null;
                        owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                            value = owner.SettleInjectedDispositionFailureAndReturnForTest(quota);
                        }, CancellationToken.None)); return value;
                    } catch (ObjectDisposedException) { return null; } catch (IOException) { return null; }
                }
                var first = Task.Run(Attempt); var second = Task.Run(Attempt); start.SetResult();
                var results = await AwaitRaceOrRetain(new[] { first, second }, TimeSpan.FromSeconds(10), tasks => UncertainTestResources.Add((fixture, owner!, tasks)));
                Check(results.Count(item => item is not null) == 1); receipt = results.Single(item => item is not null);
                Check(!File.Exists(path)); AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                rejected = false; try { stale.Dispose(); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                var heldReceipt = receipt!;
                rejected = false; try { _ = new ExperimentalReservationOwner.LeaseReceipt(root, scope + key, new object()); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
                rejected = false; try { heldReceipt.Attach(null!, (ExperimentalEntryLease)null!, new object()); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
                rejected = false; try { ExperimentalReservationOwner.ExerciseReceiptReattachGuardForTest(heldReceipt); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
                rejected = false; try { heldReceipt.ValidateEntry(Path.Combine(root, "foreign"), scope + key); } catch (TransferException) { rejected = true; } Check(rejected);
                rejected = false; try { heldReceipt.ValidateEntry(root, scope + new string('c', 64)); } catch (TransferException) { rejected = true; } Check(rejected);
                heldReceipt.ValidateEntry(root, scope + key);
                rejected = false; try { _ = heldReceipt.BeginSyntheticDownloadUse(Path.Combine(root, "wrong"), scope + key); } catch (TransferException) { rejected = true; } Check(rejected);
                rejected = false; try { _ = heldReceipt.BeginSyntheticDownloadUse(root, scope + new string('c', 64)); } catch (TransferException) { rejected = true; } Check(rejected);
                var downloadUse = heldReceipt.BeginSyntheticDownloadUse(root, scope + key); await Task.Yield(); downloadUse.ValidateEntry();
                rejected = false; try { heldReceipt.ValidateEntry(root, scope + key); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
                var disposeRefused = await Task.Run(() => { try { heldReceipt.Dispose(); return false; } catch (InvalidOperationException) { return true; } }); Check(disposeRefused);
                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                downloadUse.Dispose(); rejected = false; try { downloadUse.ValidateEntry(); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                rejected = false; try { downloadUse.Dispose(); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                heldReceipt.ValidateEntry(root, scope + key);
                var unknownKey = new string('d', 64); var unknownRecord = Path.Combine(reservationDir, scope + "-" + unknownKey + ".json");
                var unknownBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = unknownKey, Growth = 11L });
                File.WriteAllBytes(unknownRecord, unknownBytes);
                var usedForCapacity = 2L * System.Text.Encoding.UTF8.GetByteCount("LedgeTop.VerifiedHydration/1\n") + unknownBytes.Length;
                Check(heldReceipt.InspectCapacityForTest(root, scope + key, capacityCoordinator, 10000 - usedForCapacity - 11));
                Check(!heldReceipt.InspectCapacityForTest(root, scope + key, capacityCoordinator, 10001 - usedForCapacity - 11));
                heldReceipt.ValidateEntry(root, scope + key); File.Delete(unknownRecord);
                foreach (var capacityOperation in new[] { false, true }) foreach (var failureStage in new[] { "validation", "close" }) {
                    var failureToken = new object(); var injected = false;
                    ExperimentalReservationOwner.ReceiptQuotaFailureStageTestHook = failureStage;
                    ExperimentalReservationOwner.ReceiptQuotaFailureTokenTestHook = failureToken;
                    try { if (capacityOperation) _ = heldReceipt.InspectCapacityForTest(root, scope + key, capacityCoordinator, 0); else _ = heldReceipt.AccountMarkerUnderQuota(root, scope + key, root); }
                    catch (IOException error) when (error.Message == "Injected receipt quota " + failureStage + " failure.") { injected = true; }
                    finally { ExperimentalReservationOwner.ReceiptQuotaFailureStageTestHook = null; ExperimentalReservationOwner.ReceiptQuotaFailureTokenTestHook = null; }
                    Check(injected && ExperimentalReservationOwner.RetainedCount == 1);
                    AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                    AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-quota-v2.lock"));
                    rejected = false; try { heldReceipt.Dispose(); } catch (IOException) { rejected = true; } Check(rejected);
                    rejected = false; try { heldReceipt.SettleInjectedQuotaFailureForTest(new object()); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
                    heldReceipt.SettleInjectedQuotaFailureForTest(failureToken); heldReceipt.ValidateEntry(root, scope + key);
                    AssertOtherProcessOpen(Path.Combine(root, ".hydration-quota-v2.lock"), true);
                }
                Check(heldReceipt.AccountMarker(root, scope + key, root) == System.Text.Encoding.UTF8.GetByteCount("LedgeTop.VerifiedHydration/1\n"));
                var markerToken = new object(); var markerInjected = false;
                ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = true; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = markerToken;
                try { _ = heldReceipt.AccountMarker(root, scope + key, root); } catch (IOException error) when (error.Message == "Injected receipt marker failure.") { markerInjected = true; }
                finally { ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = false; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = null; }
                Check(markerInjected && ExperimentalReservationOwner.RetainedCount == 1);
                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                rejected = false; try { heldReceipt.Dispose(); } catch (IOException) { rejected = true; } Check(rejected);
                rejected = false; try { heldReceipt.SettleInjectedMarkerFailureForTest(new object()); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
                heldReceipt.SettleInjectedMarkerFailureForTest(markerToken); heldReceipt.ValidateEntry(root, scope + key);
                var exposed = typeof(ExperimentalReservationOwner.LeaseReceipt).GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly).Where(method => method.IsAssembly);
                Check(exposed.All(method => (method.ReturnType == typeof(void) || method.ReturnType == typeof(long) || method.ReturnType == typeof(bool) || method.ReturnType == typeof(ExperimentalReservationOwner.LeaseReceipt.DownloadUse) || method.ReturnType == typeof(ExperimentalReservationOwner.LeaseReceipt.DownloadSession)) && method.GetParameters().All(parameter => !typeof(Delegate).IsAssignableFrom(parameter.ParameterType))));
                var entered = new ManualResetEventSlim(); var release = new ManualResetEventSlim(); var disposing = new ManualResetEventSlim();
                Task? operation = null; Task? close = null;
                try {
                    ExperimentalReservationOwner.ReceiptQuotaEnteredTestSignal = entered; ExperimentalReservationOwner.ReceiptQuotaReleaseTestSignal = release;
                    operation = Task.Run(() => heldReceipt.AccountMarkerUnderQuota(root, scope + key, root));
                    Check(entered.Wait(TimeSpan.FromSeconds(5)));
                    AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-quota-v2.lock"));
                    close = Task.Run(() => { disposing.Set(); heldReceipt.Dispose(); });
                    Check(disposing.Wait(TimeSpan.FromSeconds(5)) && !close.Wait(TimeSpan.FromMilliseconds(150)));
                    release.Set(); await Task.WhenAll(operation, close).WaitAsync(TimeSpan.FromSeconds(10));
                } finally {
                    release.Set(); var pending = new[] { operation, close }.Where(task => task is not null).Cast<Task>().ToArray();
                    try { await Task.WhenAll(pending).WaitAsync(TimeSpan.FromSeconds(10)); }
                    finally {
                        ExperimentalReservationOwner.ReceiptQuotaEnteredTestSignal = null; ExperimentalReservationOwner.ReceiptQuotaReleaseTestSignal = null;
                        if (pending.All(task => task.IsCompleted)) { entered.Dispose(); release.Dispose(); disposing.Dispose(); }
                        else { receiptUncertain = true; UncertainTestResources.Add((fixture, heldReceipt, pending, entered, release, disposing)); }
                    }
                }
                if (!receiptUncertain) receipt = null;
                rejected = false; try { heldReceipt.ValidateEntry(root, scope + key); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
                AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true); AssertOtherProcessOpen(Path.Combine(entryDir, ".hydration.lock"), true);
            } finally { if (!receiptUncertain) receipt?.Dispose(); entry?.Dispose(); admission?.Dispose(); }
            Check(ExperimentalReservationOwner.RetainedCount == 0 && ExperimentalEntryLease.RetainedCount == 0);
        });
        await WithFixture(async fixture => {
            var root = Path.Combine(fixture.Path, "joint-handoff-failure"); Directory.CreateDirectory(root);
            var scope = new string('a', 64); var key = new string('b', 64); var entryDir = Path.Combine(root, scope, key); Directory.CreateDirectory(entryDir);
            var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
            File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, scope + key, CancellationToken.None);
            admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
            ExperimentalEntryLease? entry = ExperimentalEntryLease.Open(admission, root, scope, key);
            var oldEntry = entry; var oldAdmission = admission; var gate = admission.Quota; var token = new object();
            var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = scope, Entry = key, Growth = Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 });
            var injected = false; ExperimentalReservationOwner.PairTransferTokenTestHook = token;
            ExperimentalReservationOwner.AfterPairTransferTestHook = () => throw new IOException("Injected pair handoff failure.");
            try {
                oldAdmission.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    _ = ExperimentalReservationOwner.CreateWithOwnedEntry(root, scope, key, bytes, Spec, ref admission, ref entry, quota);
                }, CancellationToken.None));
            } catch (IOException error) when (error.Message == "Injected pair handoff failure.") { injected = true; }
            finally { ExperimentalReservationOwner.AfterPairTransferTestHook = null; ExperimentalReservationOwner.PairTransferTokenTestHook = null; }
            Check(injected && admission is null && entry is null && ExperimentalReservationOwner.RetainedCount == 1 && ExperimentalEntryLease.RetainedCount == 1);
            var held = ExperimentalReservationOwner.FindInjectedPairFailureForTest(token);
            var rejected = false; try { oldEntry.Validate(); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
            rejected = false; try { oldAdmission.AcquireExclusiveLegacy(Path.Combine(root, "detached"), FileMode.OpenOrCreate); } catch (ObjectDisposedException) { rejected = true; } Check(rejected);
            AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
            rejected = false; try { held.SettleInjectedPairFailureForTest(new object()); } catch (InvalidOperationException) { rejected = true; } Check(rejected);
            held.SettleInjectedPairFailureForTest(token);
            Check(ExperimentalReservationOwner.RetainedCount == 0 && ExperimentalEntryLease.RetainedCount == 0);
            AssertOtherProcessOpen(Path.Combine(root, ".hydration-cache.lock"), true); AssertOtherProcessOpen(Path.Combine(entryDir, ".hydration.lock"), true);
        });
        await WithFixture(async fixture => {
            using var source = new CoordinatorSource();
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", fixture.Path, expectedPrincipal: CoordinatorSource.Principal);
            var observed = await coordinator.ExperimentalObserveAuthorizedGrowthAsync(source.Identity);
            Check(observed == Spec.Length + Downloader.HydrationStateGrowthBudget(Spec) + 1024 && source.Resolves == 1 && source.Downloads == 0);
            var refused = false;
            try { _ = await coordinator.ExperimentalObserveAuthorizedGrowthAsync(source.Identity with { PrincipalId = "odqp1_" + new string('c', 64) }); }
            catch (TransferException) { refused = true; }
            Check(refused && source.Resolves == 1);
            foreach (var change in new Func<ResolvedQueuedDownload, ResolvedQueuedDownload>[] {
                value => value with { PrincipalId = "odqp1_" + new string('c', 64) },
                value => value with { Spec = value.Spec with { ETag = "\"changed\"" } },
                value => value with { Spec = value.Spec with { Length = value.Spec.Length + 1 } },
                value => value with { Spec = value.Spec with { ContentUri = new Uri("https://foreign.example.invalid/data") } }
            }) {
                source.RewriteResolutionForTest = change; refused = false;
                try { _ = await coordinator.ExperimentalObserveAuthorizedGrowthAsync(source.Identity); } catch (ResourceUnavailableException) { refused = true; }
                Check(refused && source.Downloads == 0);
            }
        });
        await WithFixture(async fixture => {
            using var source = new CoordinatorSource();
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", fixture.Path, maximumFileBytes: Content.Length, maximumCacheBytes: 10000, expectedPrincipal: CoordinatorSource.Principal);
            using var constrained = new PlaceholderHydrationCoordinator(source, "pilot", fixture.Path, maximumFileBytes: Content.Length, maximumCacheBytes: 100, expectedPrincipal: CoordinatorSource.Principal);
            var root = Path.Combine(fixture.Path, "verified-hydration-v1"); var identity = source.Identity;
            var spec = (await source.ResolveAsync(identity.ResourceReference)).Spec;
            var entryDir = Path.Combine(root, identity.ScopeKey, identity.CacheKey); Directory.CreateDirectory(entryDir);
            var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
            File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, identity.ScopeKey + identity.CacheKey, CancellationToken.None);
            admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate); var alias = admission;
            ExperimentalEntryLease? entry = ExperimentalEntryLease.Open(admission, root, identity.ScopeKey, identity.CacheKey);
            var gate = admission.Quota; var growth = spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024;
            var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identity.ScopeKey, Entry = identity.CacheKey, Growth = growth });
            ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null; Exception? primaryFailure = null;
            var path = Path.Combine(reservationDir, identity.ScopeKey + "-" + identity.CacheKey + ".json");
            try {
                alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                    owner = ExperimentalReservationOwner.CreateWithOwnedEntry(root, identity.ScopeKey, identity.CacheKey, bytes, spec, ref admission, ref entry, quota);
                }, CancellationToken.None));
                owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                    using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    receipt = owner.ReleaseAndReturn(quota);
                }, CancellationToken.None));
                var rejected = false; try { _ = receipt!.StageSyntheticReservationForTest(root, identity, spec with { Length = spec.Length + 1 }, coordinator); } catch (TransferException) { rejected = true; }
                Check(rejected && !File.Exists(path));
                Check(!receipt!.StageSyntheticReservationForTest(root, identity, spec, constrained) && !File.Exists(path));
                source.RewriteResolutionForTest = value => value with { Spec = value.Spec with { ETag = "\"changed\"" } };
                rejected = false; try { _ = await coordinator.ExperimentalAuthorizeAndStageAsync(identity, receipt); } catch (ResourceUnavailableException) { rejected = true; }
                Check(rejected && !File.Exists(path)); source.RewriteResolutionForTest = null;
                source.ResolveFailureForTest = new AccessDeniedException();
                rejected = false; try { _ = await coordinator.ExperimentalAuthorizeAndStageAsync(identity, receipt); } catch (AccessDeniedException) { rejected = true; }
                Check(rejected && !File.Exists(path)); source.ResolveFailureForTest = null;
                File.WriteAllBytes(path, bytes);
                Check(!receipt.StageSyntheticReservationForTest(root, identity, spec, coordinator) && File.ReadAllBytes(path).SequenceEqual(bytes)); File.Delete(path);
                Check(await coordinator.ExperimentalAuthorizeAndStageAsync(identity, receipt)); AssertOtherProcessCannotOpen(path);
                var blocked = SyntheticReceiptDownloadSource.Create(spec, Content);
                ExperimentalReservationOwner.LeaseReceipt.DownloadSession? session = null; var terminal = false;
                try {
                    source.ResolveFailureForTest = new AccessDeniedException(); var startDenied = false;
                    try { _ = await coordinator.ExperimentalStartReceiptDownloadAsync(identity, receipt, blocked); } catch (AccessDeniedException) { startDenied = true; }
                    Check(startDenied && !blocked.Entered.IsCompleted); source.ResolveFailureForTest = null;
                    session = await coordinator.ExperimentalStartReceiptDownloadAsync(identity, receipt, blocked);
                    await blocked.Entered.WaitAsync(TimeSpan.FromSeconds(10));
                    using var cancelledWait = new CancellationTokenSource(); cancelledWait.Cancel(); var waitCancelled = false;
                    try { await session.WaitAsync(cancelledWait.Token); } catch (OperationCanceledException) { waitCancelled = true; }
                    Check(waitCancelled);
                    var refusedWhileDownloading = false; try { _ = receipt.BeginSyntheticDownloadUse(root, identity.ScopeKey + identity.CacheKey); } catch (InvalidOperationException) { refusedWhileDownloading = true; } Check(refusedWhileDownloading);
                    refusedWhileDownloading = false; try { receipt.Dispose(); } catch (IOException) { refusedWhileDownloading = true; } catch (InvalidOperationException) { refusedWhileDownloading = true; } Check(refusedWhileDownloading);
                    AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                    _ = session.WaitAsync(); // Deliberately abandon one waiter; the owned task continues.
                    blocked.Release();
                    await session.WaitAsync().WaitAsync(TimeSpan.FromSeconds(15)); terminal = true;
                    Check(File.ReadAllBytes(Path.Combine(entryDir, identity.FileName)).SequenceEqual(Content));
                    source.ResolveFailureForTest = new AccessDeniedException(); var afterDenied = false;
                    try { await coordinator.ExperimentalWaitReceiptDownloadAuthorizedAsync(identity, session); } catch (AccessDeniedException) { afterDenied = true; }
                    Check(afterDenied); source.ResolveFailureForTest = null;
                    await coordinator.ExperimentalWaitReceiptDownloadAuthorizedAsync(identity, session);
                    var wrongSession = false;
                    try { await coordinator.ExperimentalWaitReceiptDownloadAuthorizedAsync(identity with { FileName = "other.bin" }, session); } catch (ResourceUnavailableException) { wrongSession = true; }
                    Check(wrongSession);
                    var doubleStart = false; try { session.Start(); } catch (InvalidOperationException) { doubleStart = true; } Check(doubleStart);
                    File.Delete(Path.Combine(entryDir, identity.FileName));
                    foreach (var ignoreCancellation in new[] { false, true }) {
                        var cancellationSource = SyntheticReceiptDownloadSource.Create(spec, Content, ignoreCancellation);
                        var unauthenticated = false;
                        try { _ = receipt.StartSyntheticDownloadForTest(root, identity, spec, cancellationSource, new object()); } catch (InvalidOperationException) { unauthenticated = true; }
                        Check(unauthenticated);
                        var worker = await coordinator.ExperimentalStartReceiptDownloadAsync(identity, receipt, cancellationSource); var settled = false;
                        try {
                            await cancellationSource.Entered.WaitAsync(TimeSpan.FromSeconds(10));
                            var stopped = await worker.CancelWorkerAndWaitAsync(ignoreCancellation ? TimeSpan.FromMilliseconds(150) : TimeSpan.FromSeconds(5));
                            Check(stopped != ignoreCancellation);
                            if (ignoreCancellation) {
                                var busy = false; try { _ = receipt.BeginSyntheticDownloadUse(root, identity.ScopeKey + identity.CacheKey); } catch (InvalidOperationException) { busy = true; } Check(busy);
                                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                                cancellationSource.Release();
                                Check(await worker.CancelWorkerAndWaitAsync(TimeSpan.FromSeconds(5)));
                            }
                            var cancelledWorker = false; try { await worker.WaitAsync(); } catch (OperationCanceledException) { cancelledWorker = true; }
                            Check(cancelledWorker && !File.Exists(Path.Combine(entryDir, identity.FileName))); settled = true;
                        } finally {
                            cancellationSource.Release();
                            if (!settled) UncertainTestResources.Add((fixture, receipt, worker, cancellationSource));
                        }
                    }
                    var timeoutSource = SyntheticReceiptDownloadSource.Create(spec, Content, timeoutAfterRelease: true);
                    var timeoutWorker = await coordinator.ExperimentalStartReceiptDownloadAsync(identity, receipt, timeoutSource); var timeoutSettled = false;
                    try {
                        await timeoutSource.Entered.WaitAsync(TimeSpan.FromSeconds(10)); timeoutSource.Release();
                        var observed = timeoutWorker.WaitAsync();
                        Check(ReferenceEquals(await Task.WhenAny(observed, Task.Delay(TimeSpan.FromSeconds(10))), observed));
                        Check(observed.IsFaulted && observed.Exception!.Flatten().InnerExceptions.Any(e => e is TimeoutException && e.Message == "Synthetic source timeout."));
                        Check(await timeoutWorker.CancelWorkerAndWaitAsync(TimeSpan.FromSeconds(2)));
                        timeoutSettled = true;
                    } finally {
                        timeoutSource.Release();
                        if (!timeoutSettled) UncertainTestResources.Add((fixture, receipt, timeoutWorker, timeoutSource));
                    }
                    var callbackSource = SyntheticReceiptDownloadSource.Create(spec, Content, blockCancellationCallback: true);
                    var callbackWorker = await coordinator.ExperimentalStartReceiptDownloadAsync(identity, receipt, callbackSource); var callbackSettled = false;
                    try {
                        await callbackSource.Entered.WaitAsync(TimeSpan.FromSeconds(10));
                        var cancelling = callbackWorker.CancelWorkerAndWaitAsync(TimeSpan.FromMilliseconds(150));
                        await callbackSource.CallbackEntered.WaitAsync(TimeSpan.FromSeconds(10));
                        Check(!await cancelling.WaitAsync(TimeSpan.FromSeconds(5)));
                        var busy = false; try { _ = receipt.BeginSyntheticDownloadUse(root, identity.ScopeKey + identity.CacheKey); } catch (InvalidOperationException) { busy = true; } Check(busy);
                        AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock")); AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                        callbackSource.ReleaseCancellationCallback(); callbackSource.Release();
                        Check(await callbackWorker.CancelWorkerAndWaitAsync(TimeSpan.FromSeconds(5)));
                        var callbackCancelled = false; try { await callbackWorker.WaitAsync(); } catch (OperationCanceledException) { callbackCancelled = true; }
                        Check(callbackCancelled); callbackSettled = true;
                    } finally {
                        callbackSource.ReleaseCancellationCallback(); callbackSource.Release();
                        if (!callbackSettled) UncertainTestResources.Add((fixture, receipt, callbackWorker, callbackSource));
                    }
                    foreach (var mode in new[] { "success", "held", "denied", "sinkfailure", "partialfail", "heldcancel", "completefail", "completecancel", "failfail", "cancelled" }) {
                        var deliverySource = SyntheticReceiptDownloadSource.Create(spec, Content);
                        var sink = new TestSink { ThrowOnWrite = mode is "sinkfailure" or "failfail", HoldWrite = mode is "held" or "heldcancel", PartialThenThrow = mode == "partialfail", ThrowOnComplete = mode == "completefail", CancelOnComplete = mode == "completecancel", ThrowOnFail = mode == "failfail" };
                        var delivery = await coordinator.ExperimentalStartReceiptTransferAsync(identity, receipt, deliverySource, sink); var deliverySettled = false;
                        try {
                            await deliverySource.Entered.WaitAsync(TimeSpan.FromSeconds(10));
                            AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock"));
                            if (mode == "denied") source.ResolveFailureForTest = new AccessDeniedException();
                            if (mode == "cancelled") Check(await delivery.CancelWorkerAndWaitAsync(TimeSpan.FromSeconds(5)));
                            else deliverySource.Release();
                            if (mode is "held" or "heldcancel") {
                                await sink.WriteEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
                                var inUse = false; try { receipt.Dispose(); } catch (InvalidOperationException) { inUse = true; } catch (IOException) { inUse = true; } Check(inUse);
                                AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-cache.lock"));
                                AssertOtherProcessCannotOpen(Path.Combine(entryDir, ".hydration.lock"));
                                if (mode == "heldcancel") Check(await delivery.CancelWorkerAndWaitAsync(TimeSpan.FromSeconds(5)));
                                else sink.WriteRelease.TrySetResult();
                            }
                            var observedDelivery = delivery.WaitAsync();
                            Check(ReferenceEquals(await Task.WhenAny(observedDelivery, Task.Delay(TimeSpan.FromSeconds(10))), observedDelivery));
                            Exception? failure = null;
                            try { await observedDelivery; } catch (Exception error) { failure = error; }
                            if (mode is "success" or "held") Check(failure is null && sink.Completed == 1 && sink.Failed == 0 && sink.Bytes.ToArray().SequenceEqual(Content));
                            else if (mode == "partialfail") Check(failure is IOException && sink.Completed == 0 && sink.Failed == 1 && sink.Bytes.ToArray().SequenceEqual(Content[..1]));
                            else if (mode is "completefail" or "completecancel") Check(failure is not null && sink.Completed == 1 && sink.Failed == 0 && sink.Bytes.ToArray().SequenceEqual(Content));
                            else if (mode == "failfail") Check(failure is IOException { Message: "Synthetic sink failure." } && sink.Completed == 0 && sink.Failed == 1 && sink.Bytes.Length == 0);
                            else Check(failure is not null && sink.Completed == 0 && sink.Failed == 1 && sink.Bytes.Length == 0);
                            deliverySettled = true;
                        } finally {
                            source.ResolveFailureForTest = null; deliverySource.Release(); sink.WriteRelease.TrySetResult();
                            if (!deliverySettled) UncertainTestResources.Add((fixture, receipt, delivery, deliverySource));
                        }
                        if (File.Exists(Path.Combine(entryDir, identity.FileName))) File.Delete(Path.Combine(entryDir, identity.FileName));
                    }
                } finally {
                    blocked.Release();
                    if (session is not null && !terminal) UncertainTestResources.Add((fixture, receipt, session, blocked));
                }
                source.ResolveFailureForTest = new AccessDeniedException();
                rejected = false; try { await coordinator.ExperimentalReauthorizeStagedAsync(identity, receipt); } catch (AccessDeniedException) { rejected = true; }
                Check(rejected); AssertOtherProcessCannotOpen(path);
                source.ResolveFailureForTest = null; await coordinator.ExperimentalReauthorizeStagedAsync(identity, receipt);
                rejected = false; try { receipt.Dispose(); } catch (IOException) { rejected = true; } Check(rejected);
                Check(receipt.InspectCapacityForTest(root, identity.ScopeKey + identity.CacheKey, coordinator, 0));
                receipt.RemoveSyntheticReservationForTest(root, identity.ScopeKey + identity.CacheKey); Check(!File.Exists(path));
                var token = new object(); var injected = false;
                ExperimentalReservationOwner.ReceiptQuotaFailureStageTestHook = "close"; ExperimentalReservationOwner.ReceiptQuotaFailureTokenTestHook = token;
                try { _ = receipt.StageSyntheticReservationForTest(root, identity, spec, coordinator); }
                catch (IOException error) when (error.Message == "Injected receipt quota close failure.") { injected = true; }
                finally { ExperimentalReservationOwner.ReceiptQuotaFailureStageTestHook = null; ExperimentalReservationOwner.ReceiptQuotaFailureTokenTestHook = null; }
                Check(injected); AssertOtherProcessCannotOpen(path); AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-quota-v2.lock"));
                receipt.SettleInjectedQuotaFailureForTest(token); receipt.RemoveSyntheticReservationForTest(root, identity.ScopeKey + identity.CacheKey);
                Check(!File.Exists(path)); receipt.Dispose(); receipt = null;
            } catch (Exception error) { primaryFailure = error; Console.Error.WriteLine($"Synthetic receipt test failure: {error}"); throw; }
            finally {
                try { receipt?.Dispose(); entry?.Dispose(); admission?.Dispose(); }
                catch (Exception cleanupError) when (primaryFailure is not null) { Console.Error.WriteLine($"Synthetic receipt cleanup remains uncertain: {cleanupError}"); }
            }
            Check(ExperimentalReservationOwner.RetainedCount == 0 && ExperimentalEntryLease.RetainedCount == 0);
        });
        await WithFixture(ReceiptTransferRangesAsync);
        await WithFixture(async fixture => {
            using var source = new CoordinatorSource(); var identityOne = source.Identity;
            var specOne = (await source.ResolveAsync(identityOne.ResourceReference)).Spec;
            var identityTwo = identityOne with { FileName = "second.bin" }; var specTwo = specOne with { FileName = identityTwo.FileName };
            var growth = specOne.Length + Downloader.HydrationStateGrowthBudget(specOne) + 1024;
            var ownerLength = System.Text.Encoding.UTF8.GetByteCount("LedgeTop.VerifiedHydration/1\n");
            var limit = 2L * ownerLength + 2 * growth - 1;
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", fixture.Path, maximumFileBytes: Content.Length, maximumCacheBytes: limit, expectedPrincipal: CoordinatorSource.Principal);
            var root = Path.Combine(fixture.Path, "verified-hydration-v1"); var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(reservationDir);
            File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            async Task<ExperimentalReservationOwner.LeaseReceipt> MakeReceipt(PlaceholderIdentity id, DownloadSpec spec) {
                Directory.CreateDirectory(Path.Combine(root, id.ScopeKey, id.CacheKey));
                HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, id.ScopeKey + id.CacheKey, CancellationToken.None);
                admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate); var alias = admission;
                ExperimentalEntryLease? entry = ExperimentalEntryLease.Open(admission, root, id.ScopeKey, id.CacheKey);
                var gate = admission.Quota; var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey, Growth = growth });
                ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null;
                try {
                    alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
                        using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                        owner = ExperimentalReservationOwner.CreateWithOwnedEntry(root, id.ScopeKey, id.CacheKey, bytes, spec, ref admission, ref entry, quota);
                    }, CancellationToken.None));
                    owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
                        using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                        receipt = owner.ReleaseAndReturn(quota);
                    }, CancellationToken.None));
                    return receipt!;
                } finally { entry?.Dispose(); admission?.Dispose(); }
            }
            var first = await MakeReceipt(identityOne, specOne); var second = await MakeReceipt(identityTwo, specTwo); var completed = false;
            var entered = new ManualResetEventSlim(); var release = new ManualResetEventSlim(); var secondAttempted = new ManualResetEventSlim();
            Task<bool>? one = null, two = null;
            try {
                var preCreateEntered = new ManualResetEventSlim(); var preCreateRelease = new ManualResetEventSlim();
                var stageToken = new object(); var preMarkerToken = new object(); Task<bool>? blockedStage = null;
                try {
                    ExperimentalReservationOwner.ReceiptStageBeforeCreateTestSignal = preCreateEntered;
                    ExperimentalReservationOwner.ReceiptStageBeforeCreateReleaseTestSignal = preCreateRelease;
                    ExperimentalReservationOwner.ReceiptStagePreCreateTokenTestHook = stageToken;
                    blockedStage = Task.Run(() => {
                        try { _ = first.StageSyntheticReservationForTest(root, identityOne, specOne, coordinator); return false; }
                        catch (TransferException error) when (error.Message == "Synthetic receipt status changed before creation.") { return true; }
                    });
                    Check(preCreateEntered.Wait(TimeSpan.FromSeconds(5)));
                    var preInjected = false; ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = true; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = preMarkerToken;
                    try { _ = second.AccountMarker(root, identityTwo.ScopeKey + identityTwo.CacheKey, root); }
                    catch (IOException error) when (error.Message == "Injected receipt marker failure.") { preInjected = true; }
                    finally { ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = false; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = null; }
                    Check(preInjected); preCreateRelease.Set(); Check(await blockedStage.WaitAsync(TimeSpan.FromSeconds(10)));
                    var blockedPath = Path.Combine(reservationDir, identityOne.ScopeKey + "-" + identityOne.CacheKey + ".json");
                    Check(!File.Exists(blockedPath)); AssertOtherProcessCannotOpen(Path.Combine(root, ".hydration-quota-v2.lock"));
                    first.SettleInjectedQuotaFailureForTest(stageToken);
                    var quarantineScan = await HydrationCacheConcurrency.AcquireAsync(root, "precreate-quarantine-scan", CancellationToken.None);
                    try {
                        quarantineScan.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open);
                        var refused = false; try { _ = coordinator.ExperimentalCheckMarkerCapacity(quarantineScan, 0); } catch (IOException) { refused = true; }
                        Check(refused);
                    } finally { quarantineScan.Dispose(); }
                    second.SettleInjectedMarkerFailureForTest(preMarkerToken);
                } finally {
                    preCreateRelease.Set(); ExperimentalReservationOwner.ReceiptStageBeforeCreateTestSignal = null;
                    ExperimentalReservationOwner.ReceiptStageBeforeCreateReleaseTestSignal = null; ExperimentalReservationOwner.ReceiptStagePreCreateTokenTestHook = null;
                    if (blockedStage is not null && !blockedStage.IsCompleted) UncertainTestResources.Add((fixture, first, second, blockedStage, preCreateEntered, preCreateRelease));
                    else { preCreateEntered.Dispose(); preCreateRelease.Dispose(); }
                }
                ExperimentalReservationOwner.ReceiptQuotaEnteredTestSignal = entered; ExperimentalReservationOwner.ReceiptQuotaReleaseTestSignal = release;
                one = Task.Run(() => first.StageSyntheticReservationForTest(root, identityOne, specOne, coordinator));
                Check(entered.Wait(TimeSpan.FromSeconds(5)));
                two = Task.Run(() => { secondAttempted.Set(); return second.StageSyntheticReservationForTest(root, identityTwo, specTwo, coordinator); });
                Check(secondAttempted.Wait(TimeSpan.FromSeconds(5)) && !two.Wait(TimeSpan.FromMilliseconds(150)));
                release.Set(); var results = await AwaitRaceOrRetain(new[] { one, two }, TimeSpan.FromSeconds(15), tasks => UncertainTestResources.Add((fixture, first, second, tasks, entered, release, secondAttempted)));
                Check(results[0] && !results[1]);
                var path = Path.Combine(reservationDir, identityOne.ScopeKey + "-" + identityOne.CacheKey + ".json"); AssertOtherProcessCannotOpen(path);
                var recordBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identityOne.ScopeKey, Entry = identityOne.CacheKey, Growth = growth });
                var used = 2L * ownerLength + recordBytes.Length;
                Check(second.InspectCapacityForTest(root, identityTwo.ScopeKey + identityTwo.CacheKey, coordinator, limit - used - growth));
                Check(!second.InspectCapacityForTest(root, identityTwo.ScopeKey + identityTwo.CacheKey, coordinator, limit - used - growth + 1));
                var unknownKey = new string('d', 64); var unknownPath = Path.Combine(reservationDir, identityOne.ScopeKey + "-" + unknownKey + ".json");
                var unknown = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identityOne.ScopeKey, Entry = unknownKey, Growth = 11L }); File.WriteAllBytes(unknownPath, unknown);
                Check(second.InspectCapacityForTest(root, identityTwo.ScopeKey + identityTwo.CacheKey, coordinator, limit - used - growth - unknown.Length - 11));
                Check(!second.InspectCapacityForTest(root, identityTwo.ScopeKey + identityTwo.CacheKey, coordinator, limit - used - growth - unknown.Length - 10)); File.Delete(unknownPath);
                var scan = await HydrationCacheConcurrency.AcquireAsync(root, "staged-scan", CancellationToken.None);
                try {
                    scan.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open);
                    PlaceholderHydrationCoordinator.ExperimentalOmitReservationFromWalkTestHook = value => string.Equals(value, path, StringComparison.OrdinalIgnoreCase);
                    var refused = false; try { _ = coordinator.ExperimentalCheckMarkerCapacity(scan, 0); } catch (TransferException) { refused = true; }
                    finally { PlaceholderHydrationCoordinator.ExperimentalOmitReservationFromWalkTestHook = null; }
                    Check(refused);
                } finally { scan.Dispose(); }
                var statusScan = await HydrationCacheConcurrency.AcquireAsync(root, "status-scan", CancellationToken.None);
                var statusEntered = new ManualResetEventSlim(); var statusRelease = new ManualResetEventSlim(); Task<bool>? statusTask = null;
                var markerToken = new object(); var injected = false;
                try {
                    statusScan.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open);
                    PlaceholderHydrationCoordinator.ExperimentalScanStatusEnteredTestSignal = statusEntered;
                    PlaceholderHydrationCoordinator.ExperimentalScanStatusReleaseTestSignal = statusRelease;
                    statusTask = Task.Run(() => {
                        try { _ = coordinator.ExperimentalCheckMarkerCapacity(statusScan, 0); return false; }
                        catch (TransferException error) when (error.Message == "Synthetic receipt status changed during the scan.") { return true; }
                    });
                    Check(statusEntered.Wait(TimeSpan.FromSeconds(5)));
                    ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = true; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = markerToken;
                    try { _ = first.AccountMarker(root, identityOne.ScopeKey + identityOne.CacheKey, root); }
                    catch (IOException error) when (error.Message == "Injected receipt marker failure.") { injected = true; }
                    finally { ExperimentalReservationOwner.ReceiptMarkerFailureTestHook = false; ExperimentalReservationOwner.ReceiptMarkerFailureTokenTestHook = null; }
                    Check(injected); statusRelease.Set();
                    Check(await statusTask.WaitAsync(TimeSpan.FromSeconds(10)));
                    first.SettleInjectedMarkerFailureForTest(markerToken);
                } finally {
                    statusRelease.Set(); PlaceholderHydrationCoordinator.ExperimentalScanStatusEnteredTestSignal = null; PlaceholderHydrationCoordinator.ExperimentalScanStatusReleaseTestSignal = null;
                    if (statusTask is not null && !statusTask.IsCompleted) UncertainTestResources.Add((fixture, statusScan, statusTask, statusEntered, statusRelease));
                    else { statusScan.Dispose(); statusEntered.Dispose(); statusRelease.Dispose(); }
                }
                first.RemoveSyntheticReservationForTest(root, identityOne.ScopeKey + identityOne.CacheKey); Check(!File.Exists(path));
                first.Dispose(); second.Dispose(); completed = true;
            } finally {
                release.Set(); ExperimentalReservationOwner.ReceiptQuotaEnteredTestSignal = null; ExperimentalReservationOwner.ReceiptQuotaReleaseTestSignal = null;
                var pending = new[] { one, two }.Where(task => task is not null).Cast<Task>().ToArray();
                if (pending.All(task => task.IsCompleted)) { entered.Dispose(); release.Dispose(); secondAttempted.Dispose(); }
                else UncertainTestResources.Add((fixture, first, second, pending, entered, release, secondAttempted));
                if (!completed) Console.Error.WriteLine("Synthetic concurrent staging fixture preserved: " + fixture.Path);
            }
        });
        await AbruptRestartTests();
        await WithFixture(async root => {
            var etag = "\"" + new string('\\', 510) + "\"";
            var spec = Spec with { ETag = etag };
            using var cancel = new CancellationTokenSource();
            using var downloader = Engine((_, _) => {
                var response = Response(Content, new CancelAfterPrefix(Content, cancel));
                response.Headers.ETag = new EntityTagHeaderValue(etag); return response;
            });
            try { await downloader.DownloadAsync(spec, root.Path, cancel.Token); throw new IOException("Expected cancellation."); }
            catch (OperationCanceledException) { }
            var state = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Single();
            Check(new FileInfo(state).Length <= Downloader.HydrationStateGrowthBudget(spec) - System.Text.Encoding.UTF8.GetByteCount("LedgeTop.WindowsDownload/1\n"));
        });
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
            Check(calls == 2 && File.ReadAllBytes(part).SequenceEqual(corrupt)); // a full partial requires a fresh validation response
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
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && new FileInfo(part).Length == 0 && Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Count() == 1);
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
                Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(oversized ? [] : body));
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
            var part = await SeedPartial(root); var foreign = part + ".moved"; var calls = 0;
            using var downloader = Engine((request, _) => {
                calls++; CheckResumeRequest(request);
                var blocked = false; try { File.Move(part, foreign); } catch (IOException) { blocked = true; } catch (UnauthorizedAccessException) { blocked = true; }
                Check(blocked && File.Exists(part) && !File.Exists(foreign));
                AssertOtherProcessCannotOpen(part);
                return PartialResponse();
            });
            var result = await downloader.DownloadAsync(Spec, root.Path);
            Check(calls == 1 && !File.Exists(part) && File.ReadAllBytes(result).SequenceEqual(Content));
        });
        foreach (var fault in new[] { "etag", "status", "range" }) {
            await WithFixture(async root => {
                var part = await SeedPartial(root); var prefix = File.ReadAllBytes(part);
                using var downloader = Engine((request, _) => {
                    CheckResumeRequest(request);
                    return fault == "status" ? Response(Content) : PartialResponse(fault == "etag" ? "\"wrong\"" : "\"v1\"", fault == "range" ? 3 : 4);
                });
                await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(prefix));
            });
        }
        await WithFixture(async root => {
            var part = await SeedPartial(root); var prefix = File.ReadAllBytes(part);
            var state = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Single(); File.WriteAllText(state, "{}"); var calls = 0;
            using var downloader = Engine((_, _) => { calls++; return PartialResponse(); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(calls == 0 && File.ReadAllBytes(part).SequenceEqual(prefix) && File.ReadAllText(state) == "{}");
        });
        await WithFixture(async root => {
            var part = await SeedPartial(root); var originalId = PhysicalId(part); var prefix = File.ReadAllBytes(part);
            var state = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Single(); var stateBytes = File.ReadAllBytes(state);
            Check(stateBytes.Length <= Downloader.HydrationStateGrowthBudget(Spec) - System.Text.Encoding.UTF8.GetByteCount("LedgeTop.WindowsDownload/1\n"));
            var saved = part + ".original"; File.Move(part, saved); File.WriteAllBytes(part, prefix); var replacementId = PhysicalId(part); var calls = 0;
            Check(replacementId != originalId);
            using var downloader = Engine((_, _) => { calls++; return PartialResponse(); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(calls == 0 && PhysicalId(part) == replacementId && PhysicalId(saved) == originalId &&
                File.ReadAllBytes(part).SequenceEqual(prefix) && File.ReadAllBytes(saved).SequenceEqual(prefix) && File.ReadAllBytes(state).SequenceEqual(stateBytes));
        });
        foreach (var missingState in new[] { true, false }) {
            await WithFixture(async root => {
                var part = await SeedPartial(root); var id = PhysicalId(part); var prefix = File.ReadAllBytes(part);
                var state = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Single(); var stateBytes = File.ReadAllBytes(state);
                var saved = part + ".saved";
                if (missingState) File.Delete(state); else File.Move(part, saved);
                var calls = 0; using var downloader = Engine((_, _) => { calls++; return PartialResponse(); });
                await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                if (missingState) Check(!File.Exists(state) && PhysicalId(part) == id && File.ReadAllBytes(part).SequenceEqual(prefix));
                else Check(!File.Exists(part) && PhysicalId(saved) == id && File.ReadAllBytes(saved).SequenceEqual(prefix) && File.ReadAllBytes(state).SequenceEqual(stateBytes));
                Check(calls == 0);
            });
        }
        await WithFixture(async root => {
            var part = await SeedPartial(root); var id = PhysicalId(part);
            await RunResumeChildAsync(root.Path);
            var result = Path.Combine(root.Path, "output.bin");
            Check(!File.Exists(part) && PhysicalId(result) == id && File.ReadAllBytes(result).SequenceEqual(Content));
        });
        await WithFixture(async root => {
            using var cancel = new CancellationTokenSource();
            using (var legacy = new Downloader(new FakeHandler((_, _) => Response(Content, new CancelAfterPrefix(Content, cancel))), [Origin])) {
                var cancelled = false; try { await legacy.DownloadAsync(Spec, root.Path, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
                Check(cancelled);
            }
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single(); var partId = PhysicalId(part); var prefix = File.ReadAllBytes(part);
            var state = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Single(); var stateBytes = File.ReadAllBytes(state); var calls = 0;
            using var experimental = Engine((_, _) => { calls++; return PartialResponse(); });
            await ExpectTransferFailure(experimental.DownloadAsync(Spec, root.Path));
            Check(calls == 0 && PhysicalId(part) == partId && File.ReadAllBytes(part).SequenceEqual(prefix) && File.ReadAllBytes(state).SequenceEqual(stateBytes));
        });
        await WithFixture(async root => {
            var part = await SeedPartial(root); var prefix = File.ReadAllBytes(part); var extraLink = part + ".link"; var calls = 0;
            if (!CreateHardLinkW(extraLink, part, 0)) throw new IOException("Synthetic hard-link setup failed.", Marshal.GetLastWin32Error());
            using var downloader = Engine((_, _) => { calls++; return PartialResponse(); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(calls == 0 && File.ReadAllBytes(part).SequenceEqual(prefix) && File.ReadAllBytes(extraLink).SequenceEqual(prefix));
        });
        await WithFixture(async root => {
            var part = await SeedPartial(root); var prefix = File.ReadAllBytes(part); prefix[0] ^= 1; File.WriteAllBytes(part, prefix);
            using var downloader = Engine((request, _) => { CheckResumeRequest(request); return PartialResponse(); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(prefix.Concat(Content[4..])));
        });
        await WithFixture(async root => {
            var part = await SeedPartial(root); var prefix = File.ReadAllBytes(part);
            using var downloader = Engine((request, _) => {
                CheckResumeRequest(request);
                var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(Content[4..].Concat(new byte[] { 42 }).ToArray()) };
                response.Headers.ETag = new EntityTagHeaderValue("\"v1\"");
                response.Content.Headers.ContentLength = Content.Length - 4;
                response.Content.Headers.ContentRange = new ContentRangeHeaderValue(4, Content.Length - 1, Content.Length);
                return response;
            });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(prefix));
        });
        await WithFixture(async root => {
            var part = await SeedFullPartial(root, Spec, Content); var id = PhysicalId(part); var calls = 0;
            using var downloader = Engine((request, _) => {
                calls++; Check(request.Headers.Range?.Ranges.Single().From == Content.Length - 1 && request.Headers.IfRange?.EntityTag?.ToString() == Spec.ETag && request.Headers.IfMatch.Single().ToString() == Spec.ETag);
                return TailResponse(Content[^1..]);
            });
            var result = await downloader.DownloadAsync(Spec, root.Path);
            Check(calls == 1 && !File.Exists(part) && PhysicalId(result) == id && File.ReadAllBytes(result).SequenceEqual(Content));
        });
        foreach (var fault in new[] { "etag", "status", "range", "tail", "extra", "eof" }) {
            await WithFixture(async root => {
                var part = await SeedFullPartial(root, Spec, Content); var id = PhysicalId(part); var before = File.ReadAllBytes(part);
                using var downloader = Engine((request, _) => {
                    Check(request.Headers.Range?.Ranges.Single().From == Content.Length - 1);
                    if (fault == "status") return Response(Content);
                    var tail = fault == "eof" ? Array.Empty<byte>() : fault == "extra" ? new[] { Content[^1], (byte)42 } :
                        fault == "tail" ? new[] { (byte)(Content[^1] ^ 1) } : Content[^1..];
                    return TailResponse(tail, fault == "etag" ? "\"wrong\"" : "\"v1\"", fault == "range" ? Content.Length - 2 : null);
                });
                await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
                Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && PhysicalId(part) == id && File.ReadAllBytes(part).SequenceEqual(before));
            });
        }
        await WithFixture(async root => {
            var corrupt = Content.ToArray(); corrupt[0] ^= 1;
            using (var first = Engine((_, _) => Response(corrupt))) await ExpectTransferFailure(first.DownloadAsync(Spec, root.Path));
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single(); var id = PhysicalId(part);
            using var downloader = Engine((_, _) => TailResponse(Content[^1..]));
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && PhysicalId(part) == id && File.ReadAllBytes(part).SequenceEqual(corrupt));
        });
        await WithFixture(async root => {
            var part = await SeedFullPartial(root, Spec, Content); var id = PhysicalId(part); var calls = 0;
            var state = Directory.EnumerateFiles(root.Path, "*.json", SearchOption.AllDirectories).Single(); File.WriteAllText(state, "{}");
            using var downloader = Engine((_, _) => { calls++; return TailResponse(Content[^1..]); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(calls == 0 && !File.Exists(Path.Combine(root.Path, "output.bin")) && PhysicalId(part) == id && File.ReadAllBytes(part).SequenceEqual(Content) && File.ReadAllText(state) == "{}");
        });
        await WithFixture(async root => {
            var empty = Spec with { Length = 0, Sha256 = Convert.ToHexStringLower(SHA256.HashData(Array.Empty<byte>())) };
            var part = await SeedFullPartial(root, empty, []); var id = PhysicalId(part);
            using var downloader = Engine((request, _) => { Check(request.Headers.Range is null && request.Headers.IfMatch.Single().ToString() == empty.ETag); var response = Response([]); response.Content.Headers.ContentLength = 0; return response; });
            var result = await downloader.DownloadAsync(empty, root.Path);
            Check(!File.Exists(part) && PhysicalId(result) == id && new FileInfo(result).Length == 0);
        });
        foreach (var mode in new[] { "success", "status", "tail" }) {
            await WithFixture(async root => {
                byte[] oneByte = [0x5a];
                var one = Spec with { Length = 1, Sha256 = Convert.ToHexStringLower(SHA256.HashData(oneByte)) };
                var part = await SeedFullPartial(root, one, oneByte); var id = PhysicalId(part);
                using var downloader = Engine((request, _) => {
                    Check(request.Headers.Range?.Ranges.Single().From == 0 && request.Headers.IfRange?.EntityTag?.ToString() == one.ETag && request.Headers.IfMatch.Single().ToString() == one.ETag);
                    var bytes = mode == "tail" ? new byte[] { 0x5b } : oneByte;
                    var response = new HttpResponseMessage(mode == "status" ? HttpStatusCode.OK : HttpStatusCode.PartialContent) { Content = new ByteArrayContent(bytes) };
                    response.Headers.ETag = new EntityTagHeaderValue(one.ETag);
                    if (mode != "status") response.Content.Headers.ContentRange = new ContentRangeHeaderValue(0, 0, 1);
                    return response;
                });
                if (mode == "success") {
                    var result = await downloader.DownloadAsync(one, root.Path);
                    Check(!File.Exists(part) && PhysicalId(result) == id && File.ReadAllBytes(result).SequenceEqual(oneByte));
                } else {
                    await ExpectTransferFailure(downloader.DownloadAsync(one, root.Path));
                    Check(!File.Exists(Path.Combine(root.Path, one.FileName)) && PhysicalId(part) == id && File.ReadAllBytes(part).SequenceEqual(oneByte));
                }
            });
        }
        await WithFixture(async root => {
            using var source = new CoordinatorSource(); using var cancel = new CancellationTokenSource();
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", root.Path, expectedPrincipal: CoordinatorSource.Principal);
            var initial = new TestSink(); Downloader.BeforeExperimentalPromotionTestHook = cancel.Cancel;
            try {
                var cancelled = false;
                try { await coordinator.HydrateAsync(source.Identity, 0, Content.Length, initial, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
                Check(cancelled && initial.Failed == 1 && initial.Completed == 0 && initial.Bytes.Length == 0);
            } finally { Downloader.BeforeExperimentalPromotionTestHook = null; }
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single(); var id = PhysicalId(part);
            source.ResponseFactory = () => TailResponse(Content[^1..]);
            source.InspectRequest = request => Check(request.Headers.Range?.Ranges.Single().From == Content.Length - 1 && request.Headers.IfRange?.EntityTag?.ToString() == Spec.ETag);
            var retried = new TestSink(); await coordinator.HydrateAsync(source.Identity, 0, Content.Length, retried);
            var final = Directory.EnumerateFiles(root.Path, "output.bin", SearchOption.AllDirectories).Single();
            Check(source.Downloads == 2 && retried.Completed == 1 && retried.Failed == 0 && retried.Bytes.ToArray().SequenceEqual(Content) &&
                !File.Exists(part) && PhysicalId(final) == id);
        });
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
        await WithFixture(async root => {
            using var source = new CoordinatorSource();
            using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", root.Path, expectedPrincipal: CoordinatorSource.Principal);
            source.ResponseFactory = () => Response(Content.Concat(new byte[] { 42 }).ToArray());
            var token = new object(); var reached = false; var failed = new TestSink();
            ExperimentalOwnedStream.PrefixRestorationTokenTestHook = token;
            ExperimentalOwnedStream.BeforeRestoreFlushTestHook = () => { reached = true; throw new IOException("Synthetic rollback flush failure."); };
            try {
                await ExpectTransferFailure(coordinator.HydrateAsync(source.Identity, 0, Content.Length, failed));
                var reservationDir = Path.Combine(root.Path, "verified-hydration-v1", ".hydration-reservations-v2");
                Check(reached && failed.Failed == 1 && failed.Completed == 0 && failed.Bytes.Length == 0 &&
                    Directory.EnumerateFiles(reservationDir, "*.json").Count() == 1 && ExperimentalOwnedStream.QuarantinedCountForTest == 1);
            } finally { ExperimentalOwnedStream.BeforeRestoreFlushTestHook = null; ExperimentalOwnedStream.PrefixRestorationTokenTestHook = null; }
            var retained = Path.Combine(root.Path, "verified-hydration-v1", ".hydration-reservations-v2");
            var record = Directory.EnumerateFiles(retained, "*.json").Single(); var recordBytes = File.ReadAllBytes(record); var recordId = PhysicalId(record);
            using var document = System.Text.Json.JsonDocument.Parse(recordBytes); var growth = document.RootElement.GetProperty("Growth").GetInt64();
            var reservedBytes = typeof(PlaceholderHydrationCoordinator).GetMethod("ReservedBytes", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static) ?? throw new IOException("Quota scan unavailable.");
            void CheckReservation() {
                Check(File.Exists(record) && PhysicalId(record) == recordId && File.ReadAllBytes(record).SequenceEqual(recordBytes) &&
                    (long)reservedBytes.Invoke(null, [retained])! == growth);
            }
            CheckReservation();
            var entry = Path.Combine(root.Path, "verified-hydration-v1", source.Identity.ScopeKey, source.Identity.CacheKey);
            var other = new TestSink(); await ExpectQuarantineStaleGuard(() => coordinator.HydrateAsync(source.Identity, 0, Content.Length, other), entry);
            Check(other.Failed == 1 && other.Completed == 0 && source.Downloads == 1); CheckReservation();
            // Simulate a verified cache file appearing while the same entry's
            // partial owner is still quarantined. Eviction must not remove it
            // or reinterpret the live reservation as stale.
            var cached = Path.Combine(entry, source.Identity.FileName); File.WriteAllBytes(cached, Content);
            var hit = new TestSink(); await ExpectQuarantineStaleGuard(() => coordinator.HydrateAsync(source.Identity, 0, Content.Length, hit), entry);
            Check(hit.Failed == 1 && hit.Completed == 0 && source.Downloads == 1); CheckReservation();
            await ExpectQuarantineStaleGuard(() => coordinator.EvictVerifiedCacheAsync(source.Identity), entry);
            Check(File.ReadAllBytes(cached).SequenceEqual(Content)); CheckReservation();
            // Exercise the coordinator's real capacity check: with this
            // durable reservation counted, one extra byte is refused.
            var cacheRoot = Path.Combine(root.Path, "verified-hydration-v1");
            var used = Directory.EnumerateFiles(cacheRoot, "*", SearchOption.AllDirectories).Sum(path => new FileInfo(path).Length);
            using (var constrained = new PlaceholderHydrationCoordinator(source, "pilot", root.Path, maximumFileBytes: Content.Length,
                maximumCacheBytes: checked(used + growth), expectedPrincipal: CoordinatorSource.Principal)) {
                var capacity = typeof(PlaceholderHydrationCoordinator).GetMethod("RequireCapacity", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance) ?? throw new IOException("Quota admission unavailable.");
                capacity.Invoke(constrained, [0L, 1L]);
                var refusedCapacity = false;
                try { capacity.Invoke(constrained, [growth, 1L]); }
                catch (System.Reflection.TargetInvocationException error) when (error.InnerException is TransferException) { refusedCapacity = true; }
                Check(refusedCapacity);
            }
            var owner = ExperimentalOwnedStream.FindInjectedPrefixOwnerForTest(token);
            var refused = false; try { owner.Dispose(); } catch (InvalidOperationException) { refused = true; }
            Check(refused);
            owner.ReconcileInjectedPrefixForTest(token, []); owner.Dispose();
            Check(Directory.EnumerateFiles(retained, "*.json").Count() == 1 && ExperimentalOwnedStream.QuarantinedCountForTest == 0);
            source.ResponseFactory = null;
            var retried = new TestSink(); await coordinator.HydrateAsync(source.Identity, 0, Content.Length, retried);
            Check(retried.Completed == 1 && retried.Failed == 0 && retried.Bytes.ToArray().SequenceEqual(Content) && source.Downloads == 1 &&
                !Directory.EnumerateFiles(retained, "*.json").Any());
        });
        Check(PendingOwnedResources() == 0);
        Console.WriteLine("PASS gated synthetic Downloader: cold and resumed transfers, validation, collision, cancellation and coordinator recovery.");
    }
    private sealed class PrefixStream(byte[] data) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) =>
            ValueTask.FromResult(Read(Position == 0 ? buffer.Span[..Math.Min(buffer.Length, 4)] : buffer.Span));
    }
    private sealed class CancelAfterPrefix(byte[] data, CancellationTokenSource source) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            if (Position == 0) return ValueTask.FromResult(Read(buffer.Span[..Math.Min(buffer.Length, 4)]));
            source.Cancel(); throw new OperationCanceledException(token);
        }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLinkW(string newName, string existingName, nint security);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int kind, nint data, uint size);
    private static async Task ReceiptTransferRangesAsync(DirectoryFixture fixture)
    {
        var content = Enumerable.Range(0, 5001).Select(i => (byte)(i % 251)).ToArray();
        using var source = new CoordinatorSource(content); var identity = source.Identity;
        using var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", fixture.Path, maximumFileBytes: content.Length, maximumCacheBytes: 100000, expectedPrincipal: CoordinatorSource.Principal);
        var spec = (await source.ResolveAsync(identity.ResourceReference)).Spec;
        var root = Path.Combine(fixture.Path, "verified-hydration-v1"); var entryDir = Path.Combine(root, identity.ScopeKey, identity.CacheKey);
        var reservationDir = Path.Combine(root, ".hydration-reservations-v2"); Directory.CreateDirectory(entryDir); Directory.CreateDirectory(reservationDir);
        File.WriteAllBytes(Path.Combine(reservationDir, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
        HydrationCacheConcurrency.Lease? admission = await HydrationCacheConcurrency.AcquireAsync(root, identity.ScopeKey + identity.CacheKey, CancellationToken.None);
        ExperimentalEntryLease? entry = null; ExperimentalReservationOwner? owner = null; ExperimentalReservationOwner.LeaseReceipt? receipt = null; var completed = false;
        try {
        admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate); var alias = admission;
        entry = ExperimentalEntryLease.Open(admission, root, identity.ScopeKey, identity.CacheKey);
        var gate = admission.Quota;
        var growth = spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024;
        var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identity.ScopeKey, Entry = identity.CacheKey, Growth = growth });
        alias.RunExperimentalForRoot(root, () => HydrationQuotaGate.Run(gate, () => {
            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            owner = ExperimentalReservationOwner.CreateWithOwnedEntry(root, identity.ScopeKey, identity.CacheKey, bytes, spec, ref admission, ref entry, quota);
        }, CancellationToken.None));
        owner!.RunWithLeaseForTest(() => HydrationQuotaGate.Run(gate, () => {
            using var quota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            receipt = owner.ReleaseAndReturn(quota);
        }, CancellationToken.None));
        Check(await coordinator.ExperimentalAuthorizeAndStageAsync(identity, receipt!));
        foreach (var range in new[] { (Offset: 0L, Length: (long?)4096L), (Offset: 4096L, Length: (long?)905L), (Offset: 4096L, Length: (long?)null) }) {
            var fake = SyntheticReceiptDownloadSource.Create(spec, content); var sink = new TestSink();
            var session = await coordinator.ExperimentalStartReceiptTransferAsync(identity, receipt!, fake, sink, range.Offset, range.Length);
            try {
                await fake.Entered.WaitAsync(TimeSpan.FromSeconds(10)); fake.Release();
                await session.WaitAsync().WaitAsync(TimeSpan.FromSeconds(10));
                var actualLength = range.Length ?? (content.LongLength - range.Offset);
                Check(sink.Completed == 1 && sink.Failed == 0 && sink.Bytes.Length == range.Offset + actualLength &&
                    sink.Bytes.ToArray()[(int)range.Offset..].SequenceEqual(content[(int)range.Offset..(int)(range.Offset + actualLength)]));
            } finally { fake.Release(); }
            File.Delete(Path.Combine(entryDir, identity.FileName));
        }
        foreach (var range in new[] { (Offset: -1L, Length: 1L), (Offset: 1L, Length: 4096L), (Offset: 0L, Length: 0L), (Offset: 0L, Length: 4095L), (Offset: 4096L, Length: 906L), (Offset: long.MaxValue, Length: 1L) }) {
            var fake = SyntheticReceiptDownloadSource.Create(spec, content); var rejected = false;
            try { _ = await coordinator.ExperimentalStartReceiptTransferAsync(identity, receipt!, fake, new TestSink(), range.Offset, range.Length); }
            catch (TransferException) { rejected = true; }
            Check(rejected && !fake.Entered.IsCompleted);
        }
        receipt!.RemoveSyntheticReservationForTest(root, identity.ScopeKey + identity.CacheKey); receipt.Dispose(); receipt = null;
        completed = true;
        } finally {
            // A failed test may still own a native operation or pre-transfer lease.
            // Keep every exact reference alive and let WithFixture preserve its files.
            if (!completed) UncertainTestResources.Add((fixture, admission, entry, owner, receipt));
        }
    }
    private sealed class TestSink : IPlaceholderTransferSink
    {
        internal int Completed, Failed; internal bool ThrowOnWrite, HoldWrite, PartialThenThrow, ThrowOnComplete, CancelOnComplete, ThrowOnFail; internal MemoryStream Bytes { get; } = new();
        internal TaskCompletionSource WriteEntered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource WriteRelease { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task WriteAsync(long offset, ReadOnlyMemory<byte> data, CancellationToken token) { token.ThrowIfCancellationRequested(); if (ThrowOnWrite) throw new IOException("Synthetic sink failure."); if (HoldWrite) { WriteEntered.TrySetResult(); await WriteRelease.Task.WaitAsync(token); } Bytes.Position = offset; if (PartialThenThrow) { Bytes.Write(data.Span[..1]); throw new IOException("Synthetic partial sink failure."); } Bytes.Write(data.Span); }
        public Task CompleteAsync(CancellationToken token) { Completed++; if (ThrowOnComplete) throw new IOException("Synthetic completion failure."); if (CancelOnComplete) throw new OperationCanceledException(token); return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; if (ThrowOnFail) throw new IOException("Synthetic failure callback failed."); return Task.CompletedTask; }
    }
    private sealed class CoordinatorSource : IQueuedDownloadSource, IHydrationMutationAwareSource, IVerifiedHydrationDownloadSource, IDisposable
    {
        internal static readonly string Principal = "odqp1_" + new string('a', 64);
        internal readonly PlaceholderIdentity Identity;
        private readonly DownloadSpec resolvedSpec;
        private readonly Downloader downloader; internal int Downloads, Resolves; internal Func<ResolvedQueuedDownload, ResolvedQueuedDownload>? RewriteResolutionForTest; internal Exception? ResolveFailureForTest; internal Func<HttpResponseMessage>? ResponseFactory; internal Action<HttpRequestMessage>? InspectRequest;
        internal CoordinatorSource(byte[]? content = null) {
            var body = content ?? Content;
            resolvedSpec = Spec with { Length = body.Length, Sha256 = Convert.ToHexStringLower(SHA256.HashData(body)) };
            Identity = new("pilot", "synthetic", ExperimentalColdDownloaderTests.Origin.GetLeftPart(UriPartial.Authority), Principal,
                "odqr1_test", "oef1_" + new string('b', 64), "v1", resolvedSpec.FileName, resolvedSpec.Length, resolvedSpec.ETag, resolvedSpec.Sha256);
            downloader = Engine((request, _) => { Downloads++; InspectRequest?.Invoke(request); return ResponseFactory?.Invoke() ?? Response(body); });
        }
        public string Alias => "synthetic"; public Uri Origin => ExperimentalColdDownloaderTests.Origin;
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddMinutes(5)));
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            if (reference != Identity.ResourceReference) throw new ResourceUnavailableException();
            Resolves++;
            if (ResolveFailureForTest is not null) return Task.FromException<ResolvedQueuedDownload>(ResolveFailureForTest);
            var resolved = new ResolvedQueuedDownload(Principal, Identity.LogicalFileId, Identity.RemoteVersion,
                resolvedSpec with { OpaqueIdentity = Identity.LogicalFileId + ":" + Identity.RemoteVersion });
            return Task.FromResult(RewriteResolutionForTest?.Invoke(resolved) ?? resolved);
        }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => downloader.DownloadAsync(spec, destination, cancellationToken, progress);
        Task<VerifiedHydrationDownload> IVerifiedHydrationDownloadSource.DownloadForHydrationAsync(DownloadSpec spec, string destination, CancellationToken token) => downloader.DownloadVerifiedForHydrationAsync(spec, destination, token);
        public void Dispose() => downloader.Dispose();
    }
}
#endif
