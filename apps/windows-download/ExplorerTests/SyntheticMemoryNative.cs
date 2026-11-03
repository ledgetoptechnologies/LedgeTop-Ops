#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
#if LEDGETOP_CACHE_RACE_TEST
using System.Net;
using System.Net.Http.Headers;
using System.Collections.Concurrent;
#endif
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Diagnostic only: distinct external readers against a fresh synthetic native
// root. Never selects production sources or uses cache I/O in FETCH_DATA.
internal static class SyntheticMemoryNative {
    private sealed record ReaderPipe(Process Process, string File, string Nonce, NamedPipeServerStream Server, Task<byte[]?> Evidence);
    internal static readonly byte[] Bytes = Encoding.UTF8.GetBytes(new string('x', 100_000));
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    private static readonly string Principal = "odqp1_" + new string('f', 64);
    private static void Phase(string phase, Guid id) {
        try {
            Console.WriteLine($"Synthetic memory phase: probe={id:N}; phase={phase}");
            Console.Out.Flush();
        } catch (IOException) { /* A closed log must not interrupt native cleanup. */ }
    }
    internal static async Task<int> Reader(string path, string startName, string readyName, string? pipeName = null, string? nonce = null) {
        string? outcome = null; var hresult = 0;
        var exit = ReaderOperation(() => {
            using var start = EventWaitHandle.OpenExisting(startName); using var ready = EventWaitHandle.OpenExisting(readyName);
            ready.Set(); if (!start.WaitOne(TimeSpan.FromSeconds(15))) throw new TimeoutException("Reader start gate timed out.");
            return File.ReadAllBytes(path);
        }, (value, code) => { outcome = value; hresult = code; ReaderReport(Path.GetFileName(path), value, code); });
        if (pipeName is null && nonce is null) return exit;
        if (pipeName is null || nonce is null || outcome is null ||
            !await SyntheticReaderEvidence.SendAsync(pipeName, nonce, Path.GetFileName(path), outcome, hresult).ConfigureAwait(false)) return 2;
        return exit;
    }
    private static int ReaderOperation(Func<byte[]> read, Action<string, int> report) {
        try {
            var bytes = read();
            var matches = CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), SHA256.HashData(Bytes));
            report(matches ? "matched" : "hash-mismatch", 0);
            return matches ? 0 : 1;
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or TimeoutException or WaitHandleCannotBeOpenedException) {
            report(error.GetType().Name, error.HResult);
            return 1;
        }
    }
    private static void ReaderReport(string name, string outcome, int code) {
        try {
            Console.WriteLine($"Synthetic reader: pid={Environment.ProcessId}; file={name}; outcome={outcome}; hresult=0x{code:X8}");
            Console.Out.Flush();
        } catch (IOException) { }
    }
    private static void RequireLocalDirectory(string path) {
        var full = Path.GetFullPath(path);
        if (full.StartsWith("\\\\", StringComparison.Ordinal) || !Directory.Exists(full)) throw new IOException("Existing local test directory required.");
        for (string? current = full; current is not null; current = Path.GetDirectoryName(current))
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException("Test directory may not traverse aliases.");
    }
    private static bool SyntheticReservationsEmpty(string cache) {
        try {
            var directory = Path.Combine(cache, "verified-hydration-v1", ".hydration-reservations-v2");
            RequireLocalDirectory(directory);
            return SyntheticReservationSnapshotValid(Directory.EnumerateDirectories(directory).Any(), Directory.EnumerateFiles(directory).ToArray(), File.GetAttributes, File.ReadAllText);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException or ArgumentException or NotSupportedException) { return false; }
    }
    internal static bool SyntheticReservationSnapshotValid(bool hasDirectories, string[] files, Func<string, FileAttributes> attributes, Func<string, string> read) =>
        !hasDirectories && files.Length == 1 && Path.GetFileName(files[0]) == ".verified-hydration-owner" &&
        (attributes(files[0]) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0 && read(files[0]) == "LedgeTop.VerifiedHydration/1\n";
    internal static bool SyntheticFailFastTraceValid(NativeStallTrace.Event[] events, long attempted, long dropped, bool requireTransfer) =>
        dropped == 0 && attempted == events.LongLength && events.Count(e => e.Kind == NativeStallTrace.Stage.CallbackArrival) == 2 &&
        events.Count(e => e.Kind == NativeStallTrace.Stage.CallbackQueued) == 2 &&
        events.Count(e => e.Kind == NativeStallTrace.Stage.SyntheticAdmissionTimedOut) == 1 &&
        (!requireTransfer || (events.Count(e => e.Kind == NativeStallTrace.Stage.SyntheticSerialTransferEnter) == 1 &&
            events.Count(e => e.Kind == NativeStallTrace.Stage.SyntheticSerialTransferExit) == 1));
    internal static bool CleanupVerified(bool registrationAttempted, bool registrationReturned, bool readersJoined, bool disposeCompleted, bool unregisterVerified, bool committedCleanupUncertain = false) =>
        !committedCleanupUncertain && readersJoined && (!registrationAttempted || (registrationReturned && disposeCompleted && unregisterVerified));
    internal static bool MayUnregister(bool registrationReturned, bool readersJoined, bool disposeCompleted, bool committedCleanupUncertain) =>
        registrationReturned && readersJoined && disposeCompleted && !committedCleanupUncertain;
    internal static async Task<byte[]> TrackReadAsync(Task<byte[]> read, TimeSpan timeout, Action<bool> setJoined) {
        setJoined(false);
        try { return await read.WaitAsync(timeout).ConfigureAwait(false); }
        finally { if (read.IsCompleted) setJoined(true); }
    }
    internal static bool RetryOptionsValid(Func<string, string?> get) =>
        get("LEDGETOP_TEST_BLOCK_SELF_IMPLICIT_HYDRATION") != "1" &&
        get("LEDGETOP_TEST_DISABLE_AVAILABILITY_SCANNER") != "1" &&
        get("LEDGETOP_TEST_SUPPRESS_NATIVE_PROGRESS") != "1";
    internal static string DiagnosticSettings(Func<string, string?> get) {
        var blockSelf = get("LEDGETOP_TEST_BLOCK_SELF_IMPLICIT_HYDRATION") == "1";
        var disableScanner = get("LEDGETOP_TEST_DISABLE_AVAILABILITY_SCANNER") == "1";
        var suppressProgress = get("LEDGETOP_TEST_SUPPRESS_NATIVE_PROGRESS") == "1";
        var markerIo = DiagnosticMemoryMarkerIo.Mode(get("LEDGETOP_TEST_MEMORY_MARKER_IO"));
        var cacheStage = CacheStage(get("LEDGETOP_TEST_MEMORY_CACHE_STAGE"));
        var prewarm = PrewarmMode(get("LEDGETOP_TEST_MEMORY_PREWARM"));
        var serial = SerialMode(get("LEDGETOP_TEST_MEMORY_SERIAL"));
        var failFast = SerialMode(get("LEDGETOP_TEST_MEMORY_FAIL_FAST"));
        var processInfo = SerialMode(get("LEDGETOP_TEST_REQUIRE_PROCESS_INFO"));
        var pending = PendingMode(get("LEDGETOP_TEST_PENDING_MARKER"));
        return $"Synthetic memory options: blockSelf={blockSelf}; disableScanner={disableScanner}; suppressProgress={suppressProgress}; markerIo={markerIo}; cacheStage={cacheStage}; prewarm={prewarm}; serial={serial}; failFast={failFast}; processInfo={processInfo}; pendingMarker={pending}";
    }
    private static string PendingMode(string? value) => value switch { null or "off" => "off", "reopen" => "reopen", "retained" => "retained", "mutated" => "mutated", "mutated-retained" => "mutated-retained", "mutated-shared-reopen" => "mutated-shared-reopen", _ => "invalid" };
#if LEDGETOP_CACHE_RACE_TEST
    internal static bool OwnedOptionsValid(string option, int count, bool retry, string marker, string cache, string prewarm, string serial, string failFast, string pending, Func<string, string?> get) =>
        option == "0" || (option == "1" && count is >= 1 and <= 2 && !retry && marker == "none" && cache == "none" && prewarm == "off" && serial == "off" && failFast == "off" && pending == "off" && RetryOptionsValid(get));
    internal static bool ReceiptOptionsValid(string receipt, string owned) => receipt == "0" || (receipt == "1" && owned == "1");
    internal static async Task<int> OwnedSourceContractTests() {
        string? Off(string _) => null;
        if (!ReceiptOptionsValid("1", "1") || ReceiptOptionsValid("1", "0") || ReceiptOptionsValid("bad", "1") ||
            !OwnedOptionsValid("1", 2, false, "none", "none", "off", "off", "off", "off", Off) ||
            OwnedOptionsValid("1", 3, false, "none", "none", "off", "off", "off", "off", Off) ||
            OwnedOptionsValid("1", 1, true, "none", "none", "off", "off", "off", "off", Off) ||
            OwnedOptionsValid("1", 1, false, "none", "quota-only", "off", "off", "off", "off", Off) ||
            OwnedOptionsValid("bad", 1, false, "none", "none", "off", "off", "off", "off", Off)) throw new IOException("Owned source scope options accepted unsafe combination.");
        var id = new PlaceholderIdentity("pilot", "synthetic", "https://source.example.invalid", Principal, "odqr1_0", "oef1_" + new string('a', 64), Sha, "sample-0.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
        using var source = new OwnedDownloaderSource([id]); var session = await source.GetSessionAsync(); var resolved = await source.ResolveAsync(id.ResourceReference);
        if (session.PrincipalId != Principal || resolved.PrincipalId != Principal || resolved.LogicalFileId != id.LogicalFileId || resolved.RemoteVersion != id.RemoteVersion ||
            resolved.Spec.OpaqueIdentity != id.LogicalFileId + ":" + id.RemoteVersion || resolved.Spec.FileName != id.FileName || resolved.Spec.Length != id.Length ||
            resolved.Spec.ETag != id.ETag || resolved.Spec.Sha256 != id.Sha256 || resolved.Spec.ContentUri.AbsoluteUri != "https://source.example.invalid/synthetic-content")
            throw new IOException("Synthetic owned source changed manifest pins.");
        var refused = false; try { await source.ResolveAsync("odqr1_unknown"); } catch (ResourceUnavailableException) { refused = true; }
        if (!refused) throw new IOException("Synthetic source accepted unknown reference.");
        _ = source.CreateReceiptSource(id);
        refused = false; try { _ = source.CreateReceiptSource(id with { FileName = "other.bin" }); } catch (ResourceUnavailableException) { refused = true; }
        if (!refused) throw new IOException("Synthetic receipt source accepted changed identity.");
        var context = new CloudFilesOperationContext(1, 2, 3, id.Length, 0, id.Length);
        source.ReceiptCompleted(id, context); source.ReceiptCompleted(id, context with { RequestKey = 4 });
        if (source.ReceiptCompletions != 2 || !source.CompletedExactly([id])) throw new IOException("Synthetic receipt completion evidence was invalid.");
        await OwnedDownloaderSource.VerifyHandlerForTest();
        Console.WriteLine("PASS synthetic owned source manifest and scope controls; no native root or network."); return 0;
    }
#endif
    internal static bool PendingOptionsValid(int count, bool retryProbe, string marker, string stage, string prewarm, string serial, string failFast, string pending, Func<string, string?> get) =>
        pending == "off" || (pending is "reopen" or "retained" or "mutated" or "mutated-retained" or "mutated-shared-reopen" && count == 2 && !retryProbe && marker == "none" && stage == "none" && prewarm == "off" && serial == "off" && failFast == "off" && RetryOptionsValid(get));
    internal static bool PendingTraceValid(NativeStallTrace.Event[] events, long attempted, long dropped, string mode = "reopen") {
        if (dropped != 0 || attempted != events.LongLength || events.Count(e => e.Kind == NativeStallTrace.Stage.CallbackArrival) != 2 || events.Count(e => e.Kind == NativeStallTrace.Stage.CallbackQueued) != 2 ||
            events.Any(e => e.Kind == NativeStallTrace.Stage.PendingMarkerInvalid)) return false;
        var mutation = new[] { NativeStallTrace.Stage.PendingMarkerMutateOpenEnter, NativeStallTrace.Stage.PendingMarkerMutateOpenVerified, NativeStallTrace.Stage.PendingMarkerMutateWriteComplete, NativeStallTrace.Stage.PendingMarkerMutateFlushComplete, NativeStallTrace.Stage.PendingMarkerMutateCloseComplete };
        if (mode is not ("mutated" or "mutated-retained" or "mutated-shared-reopen") && mutation.Any(stage => events.Any(e => e.Kind == stage))) return false;
        var stages = (mode is "mutated" or "mutated-retained" or "mutated-shared-reopen" ? mutation : Array.Empty<NativeStallTrace.Stage>()).Concat(new[] { NativeStallTrace.Stage.PendingMarkerAWaiting, NativeStallTrace.Stage.PendingMarkerBReadEnter, NativeStallTrace.Stage.PendingMarkerBReadVerified, NativeStallTrace.Stage.PendingMarkerBReadExit, NativeStallTrace.Stage.PendingMarkerAReleased }).ToArray();
        if (stages.Any(stage => events.Count(e => e.Kind == stage) != 1)) return false;
        var positions = stages.Select(stage => events.Single(e => e.Kind == stage).Sequence).ToArray();
        return positions.Zip(positions.Skip(1), (a, b) => a < b).All(ordered => ordered);
    }
    private static string SerialMode(string? value) => value switch { null or "0" => "off", "1" => "on", _ => "invalid" };
    internal static bool FailFastOptionsValid(int count, bool retryProbe, string marker, string stage, string prewarm, string serial, string failFast, Func<string, string?> get) =>
        failFast == "off" || (failFast == "on" && count == 2 && !retryProbe && marker == "none" && stage == "quota-reservation" && prewarm == "off" && serial == "on" && RetryOptionsValid(get));
    private static string PrewarmMode(string? value) => value switch { null or "0" => "off", "1" => "entries", "2" => "entries+reservation", _ => "invalid" };
    private static string CacheStage(string? value) => value switch { null or "none" => "none", "quota-only" => "quota-only", "quota-ownership" => "quota-ownership", "quota-capacity" => "quota-capacity", "quota-reservation" => "quota-reservation", "quota-reservation-gap" => "quota-reservation-gap", "quota-reservation-precheck" => "quota-reservation-precheck", _ => "invalid" };
    private static async Task PrewarmOwnedAsync(string cache, IReadOnlyCollection<PlaceholderIdentity> identities, bool reservationOwner = false) {
        if (identities.Count is < 1 or > 4 || identities.Select(identity => identity.FileName).Distinct(StringComparer.Ordinal).Count() != identities.Count)
            throw new IOException("Synthetic prewarm identity count is invalid.");
        using var coordinator = new PlaceholderHydrationCoordinator(new Source(), "pilot", cache, expectedPrincipal: Principal);
        foreach (var identity in identities) await coordinator.SyntheticCacheStageAsync(identity, "quota-capacity", CancellationToken.None);
        if (reservationOwner) {
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticReservationOwnerPrewarmStart);
            await coordinator.SyntheticCacheStageAsync(identities.First(), "reservation-owner-prewarm", CancellationToken.None);
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticReservationOwnerPrewarmComplete);
        }
    }
    // Test-only use of the production handle-bound primitive: it verifies the
    // exact expected bytes on the deletion handle and refuses unsafe paths.
    // An assertion failure or uncertainty about this trace record keeps the fixture intact.
    private static bool TraceRecordAbsent(Func<FileAttributes> inspect) {
        try { _ = inspect(); return false; }
        catch (FileNotFoundException) { return true; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException or ArgumentException or NotSupportedException) { return false; }
    }
    private static bool TryDeleteTraceRecord(string path, byte[] expected, bool checksPassed) {
        if (!checksPassed || !OperatingSystem.IsWindows()) return false;
        var delete = typeof(PlaceholderHydrationCoordinator).GetMethod("DeleteReservation", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
        if (delete is null) return false;
        try { delete.Invoke(null, new object[] { path, expected }); return TraceRecordAbsent(() => File.GetAttributes(path)); }
        catch (Exception error) when (error is System.Reflection.TargetInvocationException or ArgumentException or UnauthorizedAccessException) { return false; }
    }
    private static async Task PendingControlTests(string cache, Action<bool> retainFixture)
    {
        async Task Case(string mode, Func<DiagnosticPendingMarkerControl.Scope, Task> test, Func<byte[]>? read = null, TimeSpan? timeout = null) {
            DiagnosticPendingMarkerControl.Scope? scope = null; var passed = false; retainFixture(true);
            try {
                scope = DiagnosticPendingMarkerControl.Begin(cache, mode, timeout ?? TimeSpan.FromSeconds(2), read);
                await test(scope); passed = true;
            } finally {
                if (scope is not null) {
                    try { scope.Dispose(); }
                    catch { passed = false; }
                    if (passed) {
                        if (TryDeleteTraceRecord(scope.MarkerPath, scope.CleanupExpected, true)) {
                            Directory.Delete(Path.GetDirectoryName(scope.MarkerPath)!); retainFixture(false);
                        } else passed = false;
                    }
                }
            }
            if (!passed) throw new IOException("Synthetic pending control case did not drain.");
        }
        foreach (var mode in new[] { "reopen", "retained", "mutated", "mutated-retained", "mutated-shared-reopen" }) {
            await Case(mode, async scope => {
                var trace = NativeStallTrace.Enable();
                try {
                    NativeStallTrace.Record(NativeStallTrace.Stage.CallbackArrival); NativeStallTrace.Record(NativeStallTrace.Stage.CallbackQueued);
                    var b = scope.RunAsync(cache, "sample-1.bin", () => Task.CompletedTask, CancellationToken.None);
                    NativeStallTrace.Record(NativeStallTrace.Stage.CallbackArrival); NativeStallTrace.Record(NativeStallTrace.Stage.CallbackQueued);
                    var a = scope.RunAsync(cache, "sample-0.bin", () => Task.CompletedTask, CancellationToken.None);
                    await Task.WhenAll(a, b).WaitAsync(TimeSpan.FromSeconds(2));
                    var events = NativeStallTrace.Snapshot(trace);
                    var outOfOrder = events.Select(e => e.Kind == NativeStallTrace.Stage.PendingMarkerAReleased ? e with { Sequence = 0 } : e).ToArray();
                    var missingMutation = events.Where(e => e.Kind != NativeStallTrace.Stage.PendingMarkerMutateFlushComplete).ToArray();
                    if (!scope.EvidenceValid || !PendingTraceValid(events, NativeStallTrace.Attempted(trace), NativeStallTrace.Dropped(trace), mode) ||
                        PendingTraceValid(events, NativeStallTrace.Attempted(trace), 1, mode) || PendingTraceValid(outOfOrder, outOfOrder.LongLength, 0, mode) ||
                        (mode is "mutated" or "mutated-retained" or "mutated-shared-reopen" && PendingTraceValid(missingMutation, missingMutation.LongLength, 0, mode)))
                        throw new IOException("Synthetic pending evidence was incorrect.");
                } finally { NativeStallTrace.Disable(trace); }
            });
        }
        await Case("retained", async scope => {
            var a = scope.RunAsync(cache, "sample-0.bin", () => Task.CompletedTask, CancellationToken.None);
            var refused = false; try { scope.Dispose(); } catch (IOException) { refused = true; }
            var b = scope.RunAsync(cache, "sample-1.bin", () => Task.CompletedTask, CancellationToken.None);
            await Task.WhenAll(a, b).WaitAsync(TimeSpan.FromSeconds(2));
            if (!refused || !scope.EvidenceValid) throw new IOException("Active synthetic callback allowed handle disposal.");
        });
        await Case("reopen", async scope => {
            var a = scope.RunAsync(cache, "sample-0.bin", () => Task.CompletedTask, CancellationToken.None);
            var duplicate = scope.RunAsync(cache, "sample-0.bin", () => Task.CompletedTask, CancellationToken.None);
            var rejected = 0; try { await duplicate; } catch (IOException) { rejected++; }
            try { await a; } catch (IOException) { rejected++; }
            if (rejected != 2 || scope.EvidenceValid) throw new IOException("Duplicate synthetic callback was accepted.");
        });
        await Case("retained", async scope => {
            using var cancellation = new CancellationTokenSource();
            var b = scope.RunAsync(cache, "sample-1.bin", () => Task.CompletedTask, cancellation.Token); cancellation.Cancel();
            var cancelled = false; try { await b; } catch (OperationCanceledException) { cancelled = true; }
            var a = scope.RunAsync(cache, "sample-0.bin", () => Task.CompletedTask, CancellationToken.None);
            var rejected = false; try { await a; } catch (IOException) { rejected = true; }
            if (!cancelled || !rejected || scope.EvidenceValid) throw new IOException("Synthetic pending cancellation was not drained.");
        });
        await Case("reopen", async scope => {
            var a = scope.RunAsync(cache, "sample-0.bin", () => Task.CompletedTask, CancellationToken.None);
            var timedOut = false; try { await a; } catch (TimeoutException) { timedOut = true; }
            if (!timedOut || scope.EvidenceValid) throw new IOException("Synthetic missing callback did not time out.");
        }, timeout: TimeSpan.FromMilliseconds(50));
        await Case("retained", async scope => {
            var a = scope.RunAsync(cache, "sample-0.bin", () => Task.CompletedTask, CancellationToken.None);
            var b = scope.RunAsync(cache, "sample-1.bin", () => Task.CompletedTask, CancellationToken.None);
            var rejected = 0; try { await a; } catch (IOException) { rejected++; }
            try { await b; } catch (IOException) { rejected++; }
            if (rejected != 2 || scope.EvidenceValid) throw new IOException("Synthetic marker mismatch was not drained.");
        }, () => [0]);
    }
    internal static async Task<int> CacheStageTests() {
        var basePath = Path.Combine(Path.GetTempPath(), "LedgeTop-cache-stage-" + Guid.NewGuid().ToString("N"));
        var fixtures = Path.Combine(basePath, "memory-native-fixtures");
        var owned = Path.Combine(fixtures, Guid.NewGuid().ToString("N"));
        var cache = Path.Combine(owned, "Cache"); Directory.CreateDirectory(cache);
        var previousProbe = Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE");
        var previousBase = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        var previousSerial = Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_SERIAL");
        var identity = new PlaceholderIdentity("pilot", "synthetic", "https://source.example.invalid", Principal, "odqr1_0",
            "oef1_" + new string('a', 64), Sha, "sample-0.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
        var root = Path.Combine(cache, "verified-hydration-v1");
        var scope = Path.Combine(root, identity.ScopeKey); var entry = Path.Combine(scope, identity.CacheKey);
        var second = identity with { ResourceReference = "odqr1_1", LogicalFileId = "oef1_" + new string('b', 64), FileName = "sample-1.bin" };
        var secondEntry = Path.Combine(scope, second.CacheKey);
        var third = identity with { ResourceReference = "odqr1_2", LogicalFileId = "oef1_" + new string('c', 64), FileName = "sample-2.bin" };
        var thirdEntry = Path.Combine(scope, third.CacheKey);
        var retainTraceFixture = false;
        try {
            Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE", "1");
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT", basePath);
            using var coordinator = new PlaceholderHydrationCoordinator(new Source(), "pilot", cache, expectedPrincipal: Principal);
            var capture = NativeStallTrace.Enable();
            try {
                await coordinator.SyntheticCacheStageAsync(identity, "quota-only", CancellationToken.None);
                if (Directory.Exists(scope)) throw new IOException("Quota-only created ownership entries.");
                await coordinator.SyntheticCacheStageAsync(identity, "quota-capacity", CancellationToken.None);
                if (!File.Exists(Path.Combine(scope, ".verified-hydration-owner")) || !File.Exists(Path.Combine(entry, ".verified-hydration-owner")))
                    throw new IOException("Synthetic ownership stage did not create expected markers.");
                await coordinator.SyntheticCacheStageAsync(identity, "quota-reservation", CancellationToken.None);
                await coordinator.SyntheticCacheStageAsync(identity, "quota-reservation-gap", CancellationToken.None);
                var reservations = Path.Combine(root, ".hydration-reservations-v2");
                if (Directory.EnumerateFiles(reservations).Any(path => Path.GetFileName(path) != ".verified-hydration-owner"))
                    throw new IOException("Synthetic reservation was not released.");
                await coordinator.SyntheticCacheStageAsync(identity, "quota-ownership", CancellationToken.None);
                await coordinator.SyntheticCacheStageAsync(identity, "quota-ownership", CancellationToken.None);
                await coordinator.SyntheticCacheStageAsync(second, "quota-reservation-precheck", CancellationToken.None);
                if (!File.Exists(Path.Combine(secondEntry, ".verified-hydration-owner"))) throw new IOException("Precheck control did not create its synthetic entry.");
                var events = NativeStallTrace.Snapshot(capture).Select(e => e.Kind).ToArray();
                var outsideEnd = Array.IndexOf(events, NativeStallTrace.Stage.SyntheticOutsidePrecheckExit);
                if (events.Count(e => e == NativeStallTrace.Stage.CacheQuotaAcquired) != 13 ||
                    events.Count(e => e == NativeStallTrace.Stage.SyntheticRootPrepareExit) != 7 ||
                    events.Count(e => e == NativeStallTrace.Stage.CacheScopeOwnEnter) != 2 ||
                    events.Count(e => e == NativeStallTrace.Stage.CacheEntryOwnEnter) != 2 ||
                    events.Count(e => e == NativeStallTrace.Stage.CacheCapacityExit) != 5 ||
                    outsideEnd < 0 || Array.IndexOf(events, NativeStallTrace.Stage.CacheQuotaEnter, outsideEnd) <= outsideEnd ||
                    Array.IndexOf(events, NativeStallTrace.Stage.SyntheticEntryLeaseGapOpen) >= Array.IndexOf(events, NativeStallTrace.Stage.SyntheticEntryLeaseGapClosed) ||
                    !events.Contains(NativeStallTrace.Stage.SyntheticEntryLeaseGapOpen) || !events.Contains(NativeStallTrace.Stage.SyntheticEntryLeaseGapClosed) ||
                    !events.Contains(NativeStallTrace.Stage.CacheReserveAcquired) || !events.Contains(NativeStallTrace.Stage.CacheReleaseExit) ||
                    !events.Contains(NativeStallTrace.Stage.ReserveOwnerExistsEnter) || !events.Contains(NativeStallTrace.Stage.ReserveOwnerExistsExit) ||
                    !events.Contains(NativeStallTrace.Stage.ReservePathSafeExit) || !events.Contains(NativeStallTrace.Stage.ReserveStaleExit) ||
                    !events.Contains(NativeStallTrace.Stage.OwnedMarkerFlushExit)) throw new IOException("Synthetic cache stages omitted expected trace.");
            } finally { NativeStallTrace.Disable(capture); }
            // A distinct, exact synthetic record makes ReservedBytes enumerate
            // and read a record without the current identity's stale cleanup
            // removing it. No record contents enter the trace.
            var traceRecordDirectory = Path.Combine(root, ".hydration-reservations-v2");
            var traceRecord = Path.Combine(traceRecordDirectory, second.ScopeKey + "-" + second.CacheKey + ".json");
            var traceSpec = new DownloadSpec(second.ResourceReference, new Uri("https://source.example.invalid/content"), second.FileName, second.Length, second.ETag, second.Sha256);
            var traceBytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = second.ScopeKey, Entry = second.CacheKey,
                Growth = checked(second.Length + Downloader.HydrationStateGrowthBudget(traceSpec) + 1024) });
            using (var output = new FileStream(traceRecord, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { retainTraceFixture = true; output.Write(traceBytes); }
            var tracePassed = false;
            try {
                if (TryDeleteTraceRecord(traceRecord, traceBytes, false) || !File.Exists(traceRecord)) throw new IOException("Failed-check cleanup removed a synthetic record.");
                var wrongBytes = traceBytes.ToArray(); wrongBytes[0] ^= 1;
                if (TryDeleteTraceRecord(traceRecord, wrongBytes, true) || !File.ReadAllBytes(traceRecord).SequenceEqual(traceBytes))
                    throw new IOException("Mismatched cleanup removed or changed a synthetic record.");
                var scanTrace = NativeStallTrace.Enable();
                try {
                    await coordinator.SyntheticCacheStageAsync(identity, "quota-reservation", CancellationToken.None);
                    var events = NativeStallTrace.Snapshot(scanTrace).Select(e => e.Kind).ToArray();
                    foreach (var (enter, exit) in new[] {
                        (NativeStallTrace.Stage.ReservedOwnerCheckEnter, NativeStallTrace.Stage.ReservedOwnerCheckExit),
                        (NativeStallTrace.Stage.ReservedDirectoriesCheckEnter, NativeStallTrace.Stage.ReservedDirectoriesCheckExit),
                        (NativeStallTrace.Stage.ReservedFilesEnumeratorEnter, NativeStallTrace.Stage.ReservedFilesEnumeratorExit),
                        (NativeStallTrace.Stage.ReservedFilesMoveEnter, NativeStallTrace.Stage.ReservedFilesMoveExit),
                        (NativeStallTrace.Stage.ReservedFilesDisposeEnter, NativeStallTrace.Stage.ReservedFilesDisposeExit),
                        (NativeStallTrace.Stage.ReservedRecordReadEnter, NativeStallTrace.Stage.ReservedRecordReadExit) })
                        if (!events.Contains(enter) || events.Count(e => e == enter) != events.Count(e => e == exit))
                            throw new IOException("Synthetic reservation scan trace is incomplete.");
                    if (NativeStallTrace.Dropped(scanTrace) != 0) throw new IOException("Synthetic reservation scan trace dropped events.");
                } finally { NativeStallTrace.Disable(scanTrace); }
                if (!File.ReadAllBytes(traceRecord).SequenceEqual(traceBytes)) throw new IOException("Unrelated synthetic reservation changed.");
                tracePassed = true;
            } finally { if (TryDeleteTraceRecord(traceRecord, traceBytes, tracePassed)) retainTraceFixture = false; }
            if (retainTraceFixture) throw new IOException("Synthetic trace record cleanup was not verified; fixture retained.");
            await PendingControlTests(cache, value => retainTraceFixture = value);
            var scopeMarker = Path.Combine(scope, ".verified-hydration-owner"); var originalScope = File.ReadAllBytes(scopeMarker);
            await PrewarmOwnedAsync(cache, new[] { third });
            if (!File.Exists(Path.Combine(thirdEntry, ".verified-hydration-owner")) || !File.ReadAllBytes(scopeMarker).SequenceEqual(originalScope))
                throw new IOException("Synthetic prewarm did not preserve existing ownership.");
            var reservationOwnerDirectory = Path.Combine(root, ".hydration-reservations-v2");
            if (Directory.EnumerateFiles(reservationOwnerDirectory).Any(path => Path.GetFileName(path) != ".verified-hydration-owner"))
                throw new IOException("Synthetic reservation fixture is not empty.");
            File.Delete(Path.Combine(reservationOwnerDirectory, ".verified-hydration-owner")); Directory.Delete(reservationOwnerDirectory);
            var warmTrace = NativeStallTrace.Enable();
            try {
                await PrewarmOwnedAsync(cache, new[] { third }, reservationOwner: true);
                var warmEvents = NativeStallTrace.Snapshot(warmTrace).Select(e => e.Kind).ToArray();
                if (Array.IndexOf(warmEvents, NativeStallTrace.Stage.SyntheticReservationOwnerPrewarmStart) < 0 ||
                    Array.IndexOf(warmEvents, NativeStallTrace.Stage.SyntheticReservationOwnerPrewarmComplete) <= Array.IndexOf(warmEvents, NativeStallTrace.Stage.SyntheticReservationOwnerPrewarmStart))
                    throw new IOException("Synthetic reservation-owner prewarm trace is incomplete.");
            } finally { NativeStallTrace.Disable(warmTrace); }
            if (!File.Exists(Path.Combine(reservationOwnerDirectory, ".verified-hydration-owner")) ||
                Directory.EnumerateFiles(reservationOwnerDirectory).Count() != 1 || !File.ReadAllBytes(scopeMarker).SequenceEqual(originalScope))
                throw new IOException("Synthetic reservation-owner prewarm failed or changed other ownership.");
            var ownerMarker = Path.Combine(reservationOwnerDirectory, ".verified-hydration-owner"); var ownedBytes = File.ReadAllBytes(ownerMarker);
            File.WriteAllText(ownerMarker, "foreign synthetic owner");
            var foreignRejected = false; try { await PrewarmOwnedAsync(cache, new[] { third }, reservationOwner: true); } catch (TransferException) { foreignRejected = true; }
            if (!foreignRejected || File.ReadAllText(ownerMarker) != "foreign synthetic owner") throw new IOException("Foreign reservation owner was overwritten.");
            File.WriteAllBytes(ownerMarker, ownedBytes);
            var duplicateRejected = false; try { await PrewarmOwnedAsync(cache, new[] { third, third }); } catch (IOException) { duplicateRejected = true; }
            if (!duplicateRejected) throw new IOException("Synthetic prewarm accepted duplicate fixture entries.");
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_MEMORY_SERIAL", "1");
            var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var firstRelease = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var secondStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var secondEntered = false;
            using (var cancel = new CancellationTokenSource()) {
                var firstSerial = Task.Run(() => coordinator.SyntheticCacheStageAsync(identity, "quota-reservation", CancellationToken.None, true,
                    async () => { firstEntered.TrySetResult(); await firstRelease.Task; }));
                Task? secondSerial = null;
                try {
                    await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    secondSerial = Task.Run(async () => { secondStarted.TrySetResult(); await coordinator.SyntheticCacheStageAsync(second, "quota-reservation", cancel.Token, true,
                        () => { secondEntered = true; return Task.CompletedTask; }); });
                    await secondStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    if (secondSerial.IsCompleted || secondEntered) throw new IOException("Synthetic exclusive admission overlapped.");
                    cancel.Cancel();
                    var cancelled = false; try { await secondSerial.WaitAsync(TimeSpan.FromSeconds(5)); } catch (OperationCanceledException) { cancelled = true; }
                    if (!cancelled || secondEntered) throw new IOException("Queued synthetic exclusive work was not cancelled.");
                } finally { firstRelease.TrySetResult(); await firstSerial.WaitAsync(TimeSpan.FromSeconds(5)); }
                await coordinator.SyntheticCacheStageAsync(second, "quota-reservation", CancellationToken.None, true, () => Task.CompletedTask).WaitAsync(TimeSpan.FromSeconds(5));
            }
            var native = new FakeMemoryNative();
            var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var context = new CloudFilesOperationContext(1, 2, 3, Bytes.Length, 0, Bytes.Length);
            var hydration = CloudFilesNativeTransfer.HydrateSyntheticMemoryAsync(identity, context, Bytes, CancellationToken.None, native,
                async (transfer, _) => { waiting.TrySetResult(); await release.Task; await transfer(); }, TimeSpan.FromMilliseconds(20));
            try {
                await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
                await native.TwoReports.Task.WaitAsync(TimeSpan.FromSeconds(5));
                if (hydration.IsCompleted || native.Executes != 0) throw new IOException("Synthetic wait transferred before admission.");
            } finally { release.TrySetResult(); }
            await hydration.WaitAsync(TimeSpan.FromSeconds(5));
            if (native.Executes == 0) throw new IOException("Synthetic transfer did not finish after admission.");
            var cancelledNative = new FakeMemoryNative();
            using (var cancelledWait = new CancellationTokenSource()) {
                var queued = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var cancelledHydration = CloudFilesNativeTransfer.HydrateSyntheticMemoryAsync(identity, context, Bytes, cancelledWait.Token, cancelledNative,
                    async (_, sinkToken) => { queued.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, sinkToken); }, TimeSpan.FromMilliseconds(20));
                await queued.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancelledWait.Cancel();
                var stopped = false; try { await cancelledHydration.WaitAsync(TimeSpan.FromSeconds(5)); } catch (OperationCanceledException) { stopped = true; }
                if (!stopped || cancelledNative.Executes != 1) throw new IOException("Cancelled synthetic native wait was not settled exactly once.");
            }
            var failedHeartbeat = new FakeMemoryNative { FailAfterFirstReport = true };
            var heartbeatQueued = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var heartbeatWait = CloudFilesNativeTransfer.HydrateSyntheticMemoryAsync(identity, context, Bytes, CancellationToken.None, failedHeartbeat,
                async (_, sinkToken) => { heartbeatQueued.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, sinkToken); }, TimeSpan.FromMilliseconds(20));
            await heartbeatQueued.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var heartbeatStopped = false;
            try { await heartbeatWait.WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (TransferException error) { heartbeatStopped = error.HydrationFailure is { Stage: HydrationStage.NativeProgress, Category: HydrationFailureCategory.Native }; }
            if (!heartbeatStopped || failedHeartbeat.Executes != 1 || failedHeartbeat.LastStatus != CloudFilesNativeTransfer.Unavailable)
                throw new IOException("Heartbeat failure did not cancel and settle the queued synthetic request.");
            var reportsAfterStop = failedHeartbeat.Reports; await Task.Delay(80);
            if (failedHeartbeat.Reports != reportsAfterStop) throw new IOException("Failed synthetic heartbeat did not drain.");
            var committed = new FakeMemoryNative(); var committedCleanupUncertain = false;
            await CloudFilesNativeTransfer.HydrateSyntheticMemoryAsync(identity, context, Bytes, CancellationToken.None, committed,
                async (transfer, _) => { await transfer(); throw new IOException("Synthetic cleanup failure after commit."); },
                committedCleanupUncertain: () => committedCleanupUncertain = true);
            if (committed.Executes != 2 || committed.LastStatus != 0 || !committedCleanupUncertain ||
                CleanupVerified(true, true, true, true, true, committedCleanupUncertain))
                throw new IOException("Committed synthetic cleanup uncertainty was not retained.");
            var beforeCommit = new FakeMemoryNative();
            var refused = false;
            try { await CloudFilesNativeTransfer.HydrateSyntheticMemoryAsync(identity, context, Bytes, CancellationToken.None, beforeCommit,
                (_, _) => throw new IOException("Synthetic failure before commit.")); }
            catch (TransferException error) { refused = error.HydrationFailure?.Category == HydrationFailureCategory.LocalIO; }
            if (!refused || beforeCommit.Executes != 1 || beforeCommit.LastStatus != CloudFilesNativeTransfer.Unavailable)
                throw new IOException("Uncommitted synthetic failure was not settled exactly once.");
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_MEMORY_SERIAL", previousSerial);
            var rejected = false; try { await coordinator.SyntheticCacheStageAsync(identity, "unknown", CancellationToken.None); } catch (TransferException) { rejected = true; }
            if (!rejected) throw new IOException("Invalid synthetic stage accepted.");
            using (var cancellation = new CancellationTokenSource()) {
                PlaceholderHydrationCoordinator.SyntheticBeforeGapReacquire = cancellation.Cancel;
                var cancelled = false;
                try { await coordinator.SyntheticCacheStageAsync(identity, "quota-reservation-gap", cancellation.Token); }
                catch (OperationCanceledException) { cancelled = true; }
                finally { PlaceholderHydrationCoordinator.SyntheticBeforeGapReacquire = null; }
                var record = Path.Combine(root, ".hydration-reservations-v2", identity.ScopeKey + "-" + identity.CacheKey + ".json");
                if (!cancelled || !File.Exists(record)) throw new IOException("Cancelled synthetic gap did not preserve its reservation.");
                // This is the exact synthetic record just created in this test's
                // isolated fixture; the production path never removes it here.
                File.Delete(record);
            }
            rejected = false; try { await coordinator.SyntheticCacheStageAsync(identity with { Length = 1 }, "quota-reservation", CancellationToken.None); } catch (TransferException) { rejected = true; }
            if (!rejected) throw new IOException("Non-fixture synthetic size accepted.");
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT", Path.GetTempPath());
            rejected = false; try { await coordinator.SyntheticCacheStageAsync(identity, "quota-only", CancellationToken.None); } catch (TransferException) { rejected = true; }
            if (!rejected) throw new IOException("Foreign synthetic artifact root accepted.");
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT", basePath);
            Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE", null);
            rejected = false; try { await coordinator.SyntheticCacheStageAsync(identity, "quota-only", CancellationToken.None); } catch (TransferException) { rejected = true; }
            if (!rejected) throw new IOException("Synthetic cache stage ran without diagnostic opt-in.");
        } finally {
            Environment.SetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE", previousProbe);
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT", previousBase);
            Environment.SetEnvironmentVariable("LEDGETOP_TEST_MEMORY_SERIAL", previousSerial);
            if (retainTraceFixture) {
                Console.Error.WriteLine("Synthetic fixture retained because trace-record or pending-marker cleanup was not verified: " + basePath);
            } else {
            File.Delete(Path.Combine(entry, ".hydration.lock")); File.Delete(Path.Combine(entry, ".verified-hydration-owner")); if (Directory.Exists(entry)) Directory.Delete(entry);
            File.Delete(Path.Combine(secondEntry, ".hydration.lock")); File.Delete(Path.Combine(secondEntry, ".verified-hydration-owner")); if (Directory.Exists(secondEntry)) Directory.Delete(secondEntry);
            File.Delete(Path.Combine(thirdEntry, ".hydration.lock")); File.Delete(Path.Combine(thirdEntry, ".verified-hydration-owner")); if (Directory.Exists(thirdEntry)) Directory.Delete(thirdEntry);
            File.Delete(Path.Combine(scope, ".verified-hydration-owner")); if (Directory.Exists(scope)) Directory.Delete(scope);
            var reservationDirectory = Path.Combine(root, ".hydration-reservations-v2");
            File.Delete(Path.Combine(reservationDirectory, ".verified-hydration-owner")); if (Directory.Exists(reservationDirectory)) Directory.Delete(reservationDirectory);
            File.Delete(Path.Combine(root, ".hydration-cache.lock")); File.Delete(Path.Combine(root, ".hydration-quota-v2.lock"));
            File.Delete(Path.Combine(root, ".verified-hydration-owner")); if (Directory.Exists(root)) Directory.Delete(root);
            Directory.Delete(cache); Directory.Delete(owned); Directory.Delete(fixtures); Directory.Delete(basePath);
            }
        }
        Console.WriteLine("PASS synthetic actual cache admission, quota, ownership and scope refusals without native registration."); return 0;
    }
    private sealed class FakeMemoryNative : ICloudFilesTransferNative {
        private int reports, executes, lastStatus;
        internal bool FailAfterFirstReport;
        internal readonly TaskCompletionSource TwoReports = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int Executes => Volatile.Read(ref executes);
        internal int Reports => Volatile.Read(ref reports);
        internal int LastStatus => Volatile.Read(ref lastStatus);
        public int Execute(nint operationInfo, nint parameters) { Volatile.Write(ref lastStatus, System.Runtime.InteropServices.Marshal.ReadInt32(parameters, 12)); Interlocked.Increment(ref executes); return 0; }
        public int ReportProgress(long connectionKey, long transferKey, long total, long completed) {
            var count = Interlocked.Increment(ref reports); if (count >= 2) TwoReports.TrySetResult();
            return FailAfterFirstReport && count >= 2 ? unchecked((int)0x80004005) : 0;
        }
    }
    internal static int CleanupEvidenceTests() {
        if (!PendingOptionsValid(2, false, "none", "none", "off", "off", "off", "reopen", _ => null) ||
            !PendingOptionsValid(2, false, "none", "none", "off", "off", "off", "mutated", _ => null) ||
            !PendingOptionsValid(2, false, "none", "none", "off", "off", "off", "mutated-retained", _ => null) ||
            !PendingOptionsValid(2, false, "none", "none", "off", "off", "off", "mutated-shared-reopen", _ => null) ||
            PendingOptionsValid(2, false, "none", "none", "off", "on", "off", "mutated-shared-reopen", _ => null) ||
            PendingOptionsValid(2, false, "none", "none", "off", "on", "off", "mutated-retained", _ => null) ||
            PendingOptionsValid(2, false, "none", "none", "off", "on", "off", "mutated", _ => null) ||
            PendingOptionsValid(1, false, "none", "none", "off", "off", "off", "retained", _ => null) ||
            PendingOptionsValid(2, false, "none", "quota-reservation", "off", "off", "off", "reopen", _ => null) ||
            PendingOptionsValid(2, false, "none", "none", "off", "off", "off", "retained", key => key == "LEDGETOP_TEST_SUPPRESS_NATIVE_PROGRESS" ? "1" : null))
            throw new IOException("Synthetic pending options were not constrained.");
        if (!TraceRecordAbsent(() => throw new FileNotFoundException()) || TraceRecordAbsent(() => throw new DirectoryNotFoundException()) ||
            TraceRecordAbsent(() => throw new UnauthorizedAccessException()) || TraceRecordAbsent(() => throw new IOException()) ||
            TraceRecordAbsent(() => FileAttributes.Normal))
            throw new IOException("Synthetic trace record absence classification is unsafe.");
        if (PrewarmMode(null) != "off" || PrewarmMode("0") != "off" || PrewarmMode("1") != "entries" || PrewarmMode("2") != "entries+reservation" || PrewarmMode("unexpected") != "invalid")
            throw new IOException("Synthetic prewarm option validation failed.");
        var joined = true;
        var pendingRead = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        try { TrackReadAsync(pendingRead.Task, TimeSpan.FromMilliseconds(20), value => joined = value).GetAwaiter().GetResult(); throw new IOException("Timed read unexpectedly completed."); }
        catch (TimeoutException) { }
        if (joined || CleanupVerified(true, true, joined, true, true)) throw new IOException("Pending read incorrectly authorized cleanup.");
        pendingRead.SetResult([1]);
        if (joined) throw new IOException("Late read completion silently changed cleanup evidence.");
        var immediate = TrackReadAsync(Task.FromResult(new byte[] { 2 }), TimeSpan.FromSeconds(1), value => joined = value).GetAwaiter().GetResult();
        if (!joined || immediate.Length != 1 || immediate[0] != 2) throw new IOException("Completed read did not produce joined evidence.");
        var syntheticBase = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "synthetic-retry-scope"));
        var syntheticRoot = Path.Combine(syntheticBase, "memory-native-fixtures", "12345678123412341234123456789abc", "Files");
        var principal = "odqp1_" + new string('f', 64);
        bool InScope(string root, bool enabled, string alias) => SyntheticKeepFault.IsScope(root, syntheticBase, enabled, alias, "https://source.example.invalid/", "pilot", principal, 1, true);
        if (!InScope(syntheticRoot, true, "synthetic") || InScope(syntheticRoot, false, "synthetic") ||
            InScope(syntheticRoot, true, "company") || InScope(Path.Combine(syntheticBase, "foreign"), true, "synthetic"))
            throw new IOException("Synthetic Keep fault scope validation failed.");
        var fault = new SyntheticKeepFault();
        var refused = false; try { fault.Arm(false); } catch (InvalidOperationException) { refused = true; }
        if (!refused || fault.Attempts != 0) throw new IOException("Unscoped synthetic fault was accepted.");
        fault.Arm(true);
        if (!fault.ShouldFail() || fault.ShouldFail() || fault.Attempts != 2) throw new IOException("Synthetic Keep fault did not fire exactly once.");
        refused = false; try { fault.Arm(true); } catch (InvalidOperationException) { refused = true; }
        if (!refused) throw new IOException("Synthetic Keep fault could be rearmed.");
        if (!RetryOptionsValid(_ => null) || RetryOptionsValid(name => name == "LEDGETOP_TEST_DISABLE_AVAILABILITY_SCANNER" ? "1" : null) ||
            RetryOptionsValid(name => name == "LEDGETOP_TEST_BLOCK_SELF_IMPLICIT_HYDRATION" ? "1" : null) ||
            RetryOptionsValid(name => name == "LEDGETOP_TEST_SUPPRESS_NATIVE_PROGRESS" ? "1" : null))
            throw new IOException("Unsafe synthetic retry options accepted.");
        if (!CleanupVerified(false, false, true, true, false) ||
            CleanupVerified(true, false, true, true, false) ||
            CleanupVerified(true, true, true, false, false) ||
            CleanupVerified(true, true, false, true, true) ||
            CleanupVerified(true, true, true, true, false) ||
            !CleanupVerified(true, true, true, true, true) || CleanupVerified(true, true, true, true, true, true) ||
            MayUnregister(true, true, true, true) || !MayUnregister(true, true, true, false)) throw new IOException("Synthetic registration cleanup evidence is incorrect.");
        if (!FailFastOptionsValid(2, false, "none", "quota-reservation", "off", "on", "on", _ => null) ||
            FailFastOptionsValid(1, false, "none", "quota-reservation", "off", "on", "on", _ => null) ||
            FailFastOptionsValid(2, true, "none", "quota-reservation", "off", "on", "on", _ => null) ||
            FailFastOptionsValid(2, false, "none", "quota-reservation", "entries", "on", "on", _ => null) ||
            FailFastOptionsValid(2, false, "none", "quota-reservation", "off", "on", "on", name => name == "LEDGETOP_TEST_DISABLE_AVAILABILITY_SCANNER" ? "1" : null))
            throw new IOException("Unsafe synthetic fail-fast options accepted.");
        var marker = Path.Combine(Path.GetTempPath(), ".verified-hydration-owner");
        bool Valid(bool directories, string[] files, FileAttributes attributes, string contents) =>
            SyntheticReservationSnapshotValid(directories, files, _ => attributes, _ => contents);
        if (!Valid(false, [marker], FileAttributes.Normal, "LedgeTop.VerifiedHydration/1\n") ||
            Valid(true, [marker], FileAttributes.Normal, "LedgeTop.VerifiedHydration/1\n") ||
            Valid(false, [marker, marker + ".json"], FileAttributes.Normal, "LedgeTop.VerifiedHydration/1\n") ||
            Valid(false, [marker], FileAttributes.ReparsePoint, "LedgeTop.VerifiedHydration/1\n") ||
            Valid(false, [marker], FileAttributes.Normal, "foreign"))
            throw new IOException("Synthetic reservation cleanup evidence accepted unsafe contents.");
        var stages = new[] { NativeStallTrace.Stage.CallbackArrival, NativeStallTrace.Stage.CallbackArrival,
            NativeStallTrace.Stage.CallbackQueued, NativeStallTrace.Stage.CallbackQueued, NativeStallTrace.Stage.SyntheticAdmissionTimedOut,
            NativeStallTrace.Stage.SyntheticSerialTransferEnter, NativeStallTrace.Stage.SyntheticSerialTransferExit };
        var cleanTrace = stages.Select((stage, index) => new NativeStallTrace.Event(index, 0, 1, stage)).ToArray();
        if (!SyntheticFailFastTraceValid(cleanTrace, cleanTrace.Length, 0, true) || SyntheticFailFastTraceValid(cleanTrace, cleanTrace.Length, 1, true) ||
            SyntheticFailFastTraceValid(cleanTrace, cleanTrace.Length + 1, 0, true) ||
            SyntheticFailFastTraceValid(cleanTrace.Append(cleanTrace[0]).ToArray(), cleanTrace.Length + 1, 0, true) ||
            SyntheticFailFastTraceValid(cleanTrace[..^1], cleanTrace.Length - 1, 0, true)) throw new IOException("Synthetic callback trace accepted ambiguous evidence.");
        var receiptNonce = "12345678123412341234123456789abc";
        byte[] Receipt(int pid, string file, string nonce, string outcome, int code) => System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new SyntheticReaderEvidence.Receipt(1, pid, file, nonce, outcome, code));
        var cloud = unchecked((int)0x80070185);
        if (SyntheticReaderEvidence.Classify(Receipt(123, "sample-1.bin", receiptNonce, "IOException", cloud), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.CloudUnavailable ||
            SyntheticReaderEvidence.Classify(Receipt(123, "sample-1.bin", receiptNonce, "matched", 0), 123, "sample-1.bin", receiptNonce, 0) != SyntheticReaderEvidence.Classification.Matched ||
            SyntheticReaderEvidence.Classify(Receipt(124, "sample-1.bin", receiptNonce, "IOException", cloud), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.Invalid ||
            SyntheticReaderEvidence.Classify(Receipt(123, "sample-1.bin", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "IOException", cloud), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.Invalid ||
            SyntheticReaderEvidence.Classify(Receipt(123, "sample-0.bin", receiptNonce, "IOException", cloud), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.Invalid ||
            SyntheticReaderEvidence.Classify(Receipt(123, "sample-1.bin", receiptNonce, "TimeoutException", cloud), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.Invalid ||
            SyntheticReaderEvidence.Classify(Receipt(123, "sample-1.bin", receiptNonce, "hash-mismatch", 0), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.Invalid ||
            SyntheticReaderEvidence.Classify(Receipt(123, "sample-1.bin", receiptNonce, "IOException", 5), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.Invalid ||
            SyntheticReaderEvidence.Classify(Receipt(123, "sample-1.bin", receiptNonce, "IOException", cloud), 123, "sample-1.bin", receiptNonce, 0) != SyntheticReaderEvidence.Classification.Invalid ||
            SyntheticReaderEvidence.Classify(Encoding.UTF8.GetBytes("{\"Version\":1,\"Version\":1}"), 123, "sample-1.bin", receiptNonce, 1) != SyntheticReaderEvidence.Classification.Invalid)
            throw new IOException("Synthetic reader evidence accepted an ambiguous outcome.");
        var options = DiagnosticSettings(name => name == "LEDGETOP_TEST_BLOCK_SELF_IMPLICIT_HYDRATION" ? "1" : "synthetic-secret");
        if (options != "Synthetic memory options: blockSelf=True; disableScanner=False; suppressProgress=False; markerIo=invalid; cacheStage=invalid; prewarm=invalid; serial=invalid; failFast=invalid; processInfo=invalid; pendingMarker=invalid")
            throw new IOException("Synthetic diagnostic option reporting is incorrect.");
        if (DiagnosticSettings(name => name is "LEDGETOP_TEST_MEMORY_MARKER_IO" or "LEDGETOP_TEST_MEMORY_CACHE_STAGE" or "LEDGETOP_TEST_MEMORY_PREWARM" or "LEDGETOP_TEST_MEMORY_SERIAL" or "LEDGETOP_TEST_MEMORY_FAIL_FAST" or "LEDGETOP_TEST_REQUIRE_PROCESS_INFO" or "LEDGETOP_TEST_PENDING_MARKER" ? null : "1") != "Synthetic memory options: blockSelf=True; disableScanner=True; suppressProgress=True; markerIo=none; cacheStage=none; prewarm=off; serial=off; failFast=off; processInfo=off; pendingMarker=off")
            throw new IOException("Synthetic diagnostic option reporting did not capture opt-ins.");
        var observations = new List<(string, int)>();
        void Capture(string outcome, int code) => observations.Add((outcome, code));
        if (ReaderOperation(() => Bytes, Capture) != 0 || ReaderOperation(() => [], Capture) != 1 ||
            ReaderOperation(() => throw new IOException("synthetic"), Capture) != 1 ||
            observations.Count != 3 || observations[0].Item1 != "matched" || observations[1].Item1 != "hash-mismatch" ||
            observations[2].Item1 != "IOException" || observations[2].Item2 == 0)
            throw new IOException("Synthetic reader outcome reporting is incorrect.");
        Console.WriteLine("PASS diagnostic options and failed-registration/disposal cleanup evidence."); return 0;
    }
    internal static int MarkerIoTests() {
        var seen = new List<string>();
        string Fake(string path) { seen.Add(path); return DiagnosticMemoryMarkerIo.Marker; }
        DiagnosticMemoryMarkerIo.Read("none", "C:\\fixture", "ignored", Fake);
        DiagnosticMemoryMarkerIo.Read("shared-marker", "C:\\fixture", "sample-0.bin", Fake);
        DiagnosticMemoryMarkerIo.Read("shared-marker", "C:\\fixture", "sample-1.bin", Fake);
        DiagnosticMemoryMarkerIo.Read("distinct-marker", "C:\\fixture", "sample-0.bin", Fake);
        DiagnosticMemoryMarkerIo.Read("distinct-marker", "C:\\fixture", "sample-1.bin", Fake);
        if (seen.Count != 4 || seen[0] != seen[1] || seen[2] == seen[3] || DiagnosticMemoryMarkerIo.Mode("secret-value") != "invalid") throw new IOException("Synthetic marker routing is incorrect.");
        var rejected = false; try { DiagnosticMemoryMarkerIo.Read("distinct-marker", "C:\\fixture", "../other", Fake); } catch (IOException) { rejected = true; }
        if (!rejected) throw new IOException("Synthetic marker name escaped the fixture.");
        rejected = false; try { DiagnosticMemoryMarkerIo.Read("shared-marker", "C:\\fixture", "sample-0.bin", _ => "foreign"); } catch (IOException) { rejected = true; }
        if (!rejected) throw new IOException("Foreign synthetic marker was accepted.");
        rejected = false; try { DiagnosticMemoryMarkerIo.Read("preopened-distinct", "C:\\fixture", "sample-0.bin"); } catch (IOException) { rejected = true; }
        if (!rejected || DiagnosticMemoryMarkerIo.Mode("preopened-distinct") != "preopened-distinct") throw new IOException("Unbound synthetic handles accepted.");
        var fixture = Path.Combine(Path.GetTempPath(), "LedgeTop-marker-test-" + Guid.NewGuid().ToString("N"));
        var directory = Path.Combine(fixture, "synthetic-memory-markers");
        var one = Path.Combine(directory, "sample-0.bin.marker"); var two = Path.Combine(directory, "sample-1.bin.marker");
        var created = Path.Combine(directory, "sample-0.bin.created");
        Directory.CreateDirectory(directory);
        try {
            File.WriteAllText(one, DiagnosticMemoryMarkerIo.Marker); File.WriteAllText(two, DiagnosticMemoryMarkerIo.Marker);
            using (var bound = new DiagnosticMemoryMarkerIo.Preopened(fixture, new[] { "sample-0.bin", "sample-1.bin" })) {
                DiagnosticMemoryMarkerIo.Read("preopened-distinct", fixture, "sample-0.bin");
                DiagnosticMemoryMarkerIo.Read("preopened-distinct", fixture, "sample-1.bin");
                rejected = false; try { DiagnosticMemoryMarkerIo.Read("preopened-distinct", fixture, "sample-2.bin"); } catch (IOException) { rejected = true; }
                if (!rejected) throw new IOException("Unbound synthetic filename accepted.");
                rejected = false; try { DiagnosticMemoryMarkerIo.Read("preopened-distinct", Path.GetTempPath(), "sample-0.bin"); } catch (IOException) { rejected = true; }
                if (!rejected) throw new IOException("Foreign synthetic fixture accepted.");
            }
            rejected = false; try { DiagnosticMemoryMarkerIo.Read("preopened-distinct", fixture, "sample-0.bin"); } catch (IOException) { rejected = true; }
            if (!rejected) throw new IOException("Disposed synthetic binding remained active.");
            using var createScope = new DiagnosticMemoryMarkerIo.CreateScope(fixture);
            var createCapture = NativeStallTrace.Enable();
            try {
                DiagnosticMemoryMarkerIo.Read("create-flush-distinct", fixture, "sample-0.bin");
                var events = NativeStallTrace.Snapshot(createCapture).Select(e => e.Kind).ToArray();
                if (!events.SequenceEqual(new[] { NativeStallTrace.Stage.SyntheticMarkerCreateEnter, NativeStallTrace.Stage.SyntheticMarkerCreateExit,
                    NativeStallTrace.Stage.SyntheticMarkerWriteEnter, NativeStallTrace.Stage.SyntheticMarkerWriteExit,
                    NativeStallTrace.Stage.SyntheticMarkerFlushEnter, NativeStallTrace.Stage.SyntheticMarkerFlushExit,
                    NativeStallTrace.Stage.SyntheticMarkerCloseEnter, NativeStallTrace.Stage.SyntheticMarkerCloseExit }))
                    throw new IOException("Synthetic create/write/flush trace was not balanced.");
            } finally { NativeStallTrace.Disable(createCapture); }
            if (File.ReadAllText(created) != DiagnosticMemoryMarkerIo.Marker) throw new IOException("Created synthetic marker differs.");
            rejected = false; try { DiagnosticMemoryMarkerIo.Read("create-flush-distinct", fixture, "sample-0.bin"); } catch (IOException) { rejected = true; }
            if (!rejected || File.ReadAllText(created) != DiagnosticMemoryMarkerIo.Marker) throw new IOException("Repeated synthetic create replaced existing data.");
            rejected = false; try { DiagnosticMemoryMarkerIo.Read("create-flush-distinct", fixture, "../escape"); } catch (IOException) { rejected = true; }
            if (!rejected) throw new IOException("Synthetic create escaped fixture.");
            rejected = false; try { DiagnosticMemoryMarkerIo.Read("create-flush-distinct", Path.GetTempPath(), "sample-1.bin"); } catch (IOException) { rejected = true; }
            if (!rejected) throw new IOException("Foreign synthetic create fixture accepted.");
        } finally { File.Delete(created); File.Delete(one); File.Delete(two); Directory.Delete(directory); Directory.Delete(fixture); }
        var capture = NativeStallTrace.Enable();
        try {
            DiagnosticMemoryMarkerIo.Read("shared-marker", "C:\\fixture", "sample-0.bin", Fake);
            var events = NativeStallTrace.Snapshot(capture).Select(value => value.Kind).ToArray();
            if (!events.SequenceEqual(new[] { NativeStallTrace.Stage.SyntheticMarkerReadEnter, NativeStallTrace.Stage.SyntheticMarkerReadExit }))
                throw new IOException("Synthetic marker trace was not balanced.");
        } finally { NativeStallTrace.Disable(capture); }
        Console.WriteLine("PASS shared/distinct marker routing and refusals without native registration."); return 0;
    }
    internal static async Task<int> RunAsync(int count, bool retryProbe = false) {
        if (!OperatingSystem.IsWindows() || count is < 1 or > 4 ||
            Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") != "1") return 2;
        Console.WriteLine(DiagnosticSettings(Environment.GetEnvironmentVariable));
        var markerMode = DiagnosticMemoryMarkerIo.Mode(Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_MARKER_IO"));
        var cacheStage = CacheStage(Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_CACHE_STAGE"));
        var prewarm = PrewarmMode(Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_PREWARM"));
        var serial = SerialMode(Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_SERIAL"));
        var failFast = SerialMode(Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_FAIL_FAST"));
        var processInfo = SerialMode(Environment.GetEnvironmentVariable("LEDGETOP_TEST_REQUIRE_PROCESS_INFO"));
        var pending = PendingMode(Environment.GetEnvironmentVariable("LEDGETOP_TEST_PENDING_MARKER"));
        var ownedDownloader = Environment.GetEnvironmentVariable("LEDGETOP_TEST_SYNTHETIC_OWNED_DOWNLOADER") ?? "0";
        var receiptTransfer = Environment.GetEnvironmentVariable("LEDGETOP_TEST_SYNTHETIC_RECEIPT_TRANSFER") ?? "0";
#if LEDGETOP_CACHE_RACE_TEST
        if (!ReceiptOptionsValid(receiptTransfer, ownedDownloader) || !OwnedOptionsValid(ownedDownloader, count, retryProbe, markerMode, cacheStage, prewarm, serial, failFast, pending, Environment.GetEnvironmentVariable)) return 2;
#else
        if (ownedDownloader != "0" || receiptTransfer != "0") return 2;
#endif
        Console.WriteLine($"Synthetic owned downloader: {(ownedDownloader == "1" ? "on" : "off")}");
        Console.WriteLine($"Synthetic receipt transfer: {(receiptTransfer == "1" ? "on" : "off")}");
        if (receiptTransfer == "1") Console.WriteLine("Synthetic receipt transfer uses a verified cache-hit open for later ranges; callback overlap and stall behavior require trace review.");
        if (markerMode == "invalid" || cacheStage == "invalid" || prewarm == "invalid" || serial == "invalid" || failFast == "invalid" || processInfo == "invalid" || pending == "invalid" || (markerMode != "none" && cacheStage != "none") ||
            (serial == "on" && (markerMode != "none" || cacheStage != "quota-reservation")) ||
            (prewarm != "off" && (markerMode != "none" || cacheStage != "quota-reservation")) ||
            !FailFastOptionsValid(count, retryProbe, markerMode, cacheStage, prewarm, serial, failFast, Environment.GetEnvironmentVariable) ||
            !PendingOptionsValid(count, retryProbe, markerMode, cacheStage, prewarm, serial, failFast, pending, Environment.GetEnvironmentVariable)) return 2;
        if (retryProbe && (count != 1 || markerMode != "none" || cacheStage != "none" || prewarm != "off" || serial != "off" || failFast != "off" || !RetryOptionsValid(Environment.GetEnvironmentVariable))) return 2;
        if (failFast == "on") Console.WriteLine("Synthetic fail-fast bounds admission semaphore waiting only; the initial global Sync lock and filesystem/native calls are not hard-bounded. Reader evidence uses current-user pipes, which can perturb timing.");
        var basePath = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        if (string.IsNullOrEmpty(basePath) || !Path.IsPathFullyQualified(basePath) || basePath.StartsWith("\\\\", StringComparison.Ordinal)) return 2;
        RequireLocalDirectory(basePath);
        var fixtureBase = Path.Combine(basePath, "memory-native-fixtures");
        if (!Directory.Exists(fixtureBase)) Directory.CreateDirectory(fixtureBase);
        RequireLocalDirectory(fixtureBase);
        var id = Guid.NewGuid(); var owned = Path.Combine(fixtureBase, id.ToString("N"));
        Phase("fixture-setup-start", id);
        if (Directory.Exists(owned) || File.Exists(owned)) throw new IOException("Test fixture already exists.");
        var root = Path.Combine(owned, "Files"); var cache = Path.Combine(owned, "Cache");
        Directory.CreateDirectory(root); Directory.CreateDirectory(cache);
        RequireLocalDirectory(root); RequireLocalDirectory(cache);
        var manifest = Enumerable.Range(0, count).ToDictionary(i => retryProbe ? $"Retry\\sample-{i}.bin" : $"sample-{i}.bin", i => new PlaceholderIdentity(
            "pilot", "synthetic", "https://source.example.invalid", Principal, "odqr1_" + i,
            "oef1_" + new string((char)('a' + i), 64), Sha, $"sample-{i}.bin", Bytes.Length, "\"" + Sha + "\"", Sha), StringComparer.OrdinalIgnoreCase);
        if (markerMode != "none") {
            var markerDirectory = Path.Combine(cache, "synthetic-memory-markers"); Directory.CreateDirectory(markerDirectory); RequireLocalDirectory(markerDirectory);
            IEnumerable<string> markerNames = markerMode == "shared-marker" ? new[] { "shared.marker" } : markerMode == "create-flush-distinct" ? [] : manifest.Keys.Select(name => name + ".marker");
            foreach (var markerName in markerNames) {
                using var marker = new FileStream(Path.Combine(markerDirectory, markerName), FileMode.CreateNew, FileAccess.Write, FileShare.None);
                marker.Write(Encoding.UTF8.GetBytes(DiagnosticMemoryMarkerIo.Marker)); marker.Flush(true);
            }
        }
        NativeRootRegistration? registration = null; NativePlaceholderProvider? provider = null;
#if LEDGETOP_CACHE_RACE_TEST
        OwnedDownloaderSource? ownedSource = null;
#endif
        DiagnosticMemoryMarkerIo.Preopened? preopened = null;
        DiagnosticMemoryMarkerIo.CreateScope? createScope = null;
        DiagnosticPendingMarkerControl.Scope? pendingScope = null;
        var readers = new List<Process>(); var readerFiles = new Dictionary<int, string>(); var readyHandles = new List<EventWaitHandle>(); var success = false;
        var readerPipes = new List<ReaderPipe>(); var readerEvidence = new Dictionary<int, SyntheticReaderEvidence.Classification>();
        var evidenceStop = new CancellationTokenSource();
        var registrationAttempted = false; var readersJoined = true; var disposeCompleted = false;
        var disposeTimedOut = false; var unregisterVerified = false; var readerPipeTasksJoined = true;
        var loggedSettlements = 0;
        void ReportSettlements() {
            if (provider is null || failFast != "on") return;
            var values = provider.SyntheticFailureSettlements;
            while (loggedSettlements < values.Length) {
                var item = values[loggedSettlements++];
                try {
                    Console.WriteLine($"Synthetic failure settlement: request={item.RequestKey}; file={item.FileName}; status=0x{item.CompletionStatus:X8}; nativeResult={(item.NativeResult is { } result ? $"0x{result:X8}" : "threw")}");
                    Console.Out.Flush();
                } catch (IOException) { }
            }
        }
        var startName = "Local\\LedgeTopMemoryProbe-" + id.ToString("N");
        using var start = new EventWaitHandle(false, EventResetMode.ManualReset, startName);
        var trace = NativeStallTrace.Enable();
        try {
            if (pending != "off") {
                Phase("pending-marker-setup-start", id);
                pendingScope = DiagnosticPendingMarkerControl.Begin(cache, pending);
                Phase("pending-marker-setup-complete", id);
            }
            if (prewarm != "off") {
                Phase("prewarm-start", id); NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticPrewarmStart);
                await PrewarmOwnedAsync(cache, manifest.Values.ToArray(), prewarm == "entries+reservation");
                NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticPrewarmComplete); Phase("prewarm-complete", id);
            }
            if (markerMode == "preopened-distinct") {
                Phase("marker-preopen-start", id);
                preopened = new DiagnosticMemoryMarkerIo.Preopened(cache, manifest.Keys);
                Phase("marker-preopen-complete", id);
            }
            if (markerMode == "create-flush-distinct") createScope = new DiagnosticMemoryMarkerIo.CreateScope(cache);
            Phase("registration-start", id);
            registrationAttempted = true;
            registration = NativeRootRegistration.Register(root, Encoding.UTF8.GetBytes("LedgeTop.Files.MemoryNativeTest.v1:" + id));
            Phase("registration-returned", id);
#if LEDGETOP_CACHE_RACE_TEST
            IQueuedDownloadSource selectedSource = ownedDownloader == "1" ? (ownedSource = new OwnedDownloaderSource(manifest.Values)) : new Source();
#else
            IQueuedDownloadSource selectedSource = new Source();
#endif
            provider = new NativePlaceholderProvider(registration, cache, selectedSource, "pilot", Principal, manifest, []);
#if LEDGETOP_CACHE_RACE_TEST
            if (ownedDownloader == "1") provider.Activity += message => {
                if (message.StartsWith("Hydration timing:", StringComparison.Ordinal)) { Console.WriteLine(message); Console.Out.Flush(); }
            };
#endif
            var failedKeep = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var kept = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            if (retryProbe) provider.Activity += message => {
                if (message.StartsWith("Could not change local availability.", StringComparison.Ordinal)) failedKeep.TrySetResult();
                if (message == "Kept on this device: sample-0.bin") kept.TrySetResult();
            };
            if (retryProbe) provider.ArmSyntheticKeepFailure();
            await provider.ConnectAndPopulateAsync();
            Phase("provider-connected", id);
            if (retryProbe) {
                Phase("simulated-keep-failure-test-start", id);
                provider.SetFolderAvailabilityIntent("Retry", true);
                await failedKeep.Task.WaitAsync(TimeSpan.FromSeconds(25));
                // Allow multiple scanner cycles; the same failed intent must remain suppressed.
                await Task.Delay(TimeSpan.FromSeconds(6));
                var failedAttributes = (uint)provider.InspectAttributes("Retry\\sample-0.bin");
                if (provider.SyntheticKeepAttempts != 1 || (failedAttributes & 0x80000) == 0 || (failedAttributes & 0x1000) == 0)
                    throw new IOException("Simulated Keep failure did not remain pinned, online-only and suppressed.");
                if (!provider.RetryFailedAvailability()) throw new IOException("Synthetic retry request was refused.");
                await kept.Task.WaitAsync(TimeSpan.FromSeconds(30));
                var keptAttributes = (uint)provider.InspectAttributes("Retry\\sample-0.bin");
                if (provider.SyntheticKeepAttempts != 2 || (keptAttributes & 0x80000) == 0 || (keptAttributes & (0x1000u | 0x40000u | 0x400000u)) != 0)
                    throw new IOException("Synthetic retry did not produce a pinned local file in exactly two attempts.");
                var contentTask = File.ReadAllBytesAsync(Path.Combine(root, "Retry", "sample-0.bin"));
                var content = await TrackReadAsync(contentTask, TimeSpan.FromSeconds(15), joined => readersJoined = joined);
                if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(content), SHA256.HashData(Bytes)))
                    throw new IOException("Synthetic retry content hash differed.");
                Phase("simulated-keep-failure-retry-verified", id);
                success = true;
            } else {
            var executable = Environment.ProcessPath ?? throw new IOException("Self-contained test apphost required.");
            if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                throw new IOException("Use the self-contained test apphost.");
            Phase("reader-start", id);
            foreach (var name in manifest.Keys) {
                var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
                var readyName = startName + "-" + readyHandles.Count;
                readyHandles.Add(new EventWaitHandle(false, EventResetMode.ManualReset, readyName));
                info.ArgumentList.Add("--synthetic-memory-native-reader"); info.ArgumentList.Add(Path.Combine(root, name));
                info.ArgumentList.Add(startName); info.ArgumentList.Add(readyName);
                string? nonce = null; NamedPipeServerStream? pipe = null;
                if (failFast == "on") {
                    nonce = Guid.NewGuid().ToString("N"); pipe = SyntheticReaderEvidence.CreateServer(nonce);
                    info.ArgumentList.Add(SyntheticReaderEvidence.PipeName(nonce)); info.ArgumentList.Add(nonce);
                }
                Process reader;
                try { reader = Process.Start(info) ?? throw new IOException("Synthetic reader failed to start."); }
                catch { pipe?.Dispose(); throw; }
                readers.Add(reader);
                readerFiles.Add(reader.Id, name);
                if (pipe is not null && nonce is not null)
                    readerPipes.Add(new(reader, name, nonce, pipe, SyntheticReaderEvidence.ReceiveAsync(pipe, reader.Id, evidenceStop.Token)));
                Phase($"reader-started-{readyHandles.Count - 1}-pid-{reader.Id}", id);
            }
            Phase("reader-ready-wait", id);
            if (!WaitHandle.WaitAll(readyHandles.ToArray(), TimeSpan.FromSeconds(10))) throw new TimeoutException("Synthetic readers did not reach the start gate.");
            start.Set();
            Phase("reader-exit-wait", id);
            var clock = Stopwatch.StartNew(); var loggedReaders = new HashSet<int>(); TimeSpan? allExited = null;
            while (true) {
                foreach (var reader in readers) if (!loggedReaders.Contains(reader.Id) && reader.HasExited) {
                    loggedReaders.Add(reader.Id); Phase($"reader-exited-pid-{reader.Id}-code-{reader.ExitCode}", id);
                }
                foreach (var ticket in readerPipes) if (ticket.Process.HasExited && ticket.Evidence.IsCompleted && !readerEvidence.ContainsKey(ticket.Process.Id)) {
                    byte[]? data = null; try { data = await ticket.Evidence.ConfigureAwait(false); } catch { }
                    var value = data is null ? SyntheticReaderEvidence.Classification.Invalid :
                        SyntheticReaderEvidence.Classify(data, ticket.Process.Id, Path.GetFileName(ticket.File), ticket.Nonce, ticket.Process.ExitCode);
                    readerEvidence.Add(ticket.Process.Id, value);
                    Phase($"reader-evidence-pid-{ticket.Process.Id}-{value}", id);
                }
                ReportSettlements();
                if (loggedReaders.Count == readers.Count) {
                    allExited ??= clock.Elapsed;
                    if (failFast != "on" || (readerEvidence.Count == readers.Count && provider.SyntheticFailureSettlementsAttempted > 0 &&
                        provider.SyntheticFailureSettlements.Length == provider.SyntheticFailureSettlementsAttempted) || clock.Elapsed - allExited.Value >= TimeSpan.FromSeconds(3)) break;
                }
                if (clock.Elapsed >= TimeSpan.FromSeconds(25)) throw new TimeoutException("Synthetic readers did not exit.");
                await Task.Delay(100).ConfigureAwait(false);
            }
            Phase("readers-exited", id);
            var settlements = provider.SyntheticFailureSettlements;
            success = failFast == "on"
                ? readers.Count(p => p.ExitCode == 0) == 1 && readers.Count(p => p.ExitCode == 1) == 1 &&
                  provider.SyntheticFailureSettlementsAttempted == 1 && settlements.Length == 1 &&
                  settlements[0].CompletionStatus == CloudFilesNativeTransfer.Unavailable && settlements[0].NativeResult == 0 &&
                  Path.GetFileName(readerFiles[readers.Single(p => p.ExitCode == 1).Id]) == settlements[0].FileName &&
                  readerEvidence.Count == 2 && readerEvidence[readers.Single(p => p.ExitCode == 0).Id] == SyntheticReaderEvidence.Classification.Matched &&
                  readerEvidence[readers.Single(p => p.ExitCode == 1).Id] == SyntheticReaderEvidence.Classification.CloudUnavailable &&
                  SyntheticFailFastTraceValid(NativeStallTrace.Snapshot(trace), NativeStallTrace.Attempted(trace), NativeStallTrace.Dropped(trace), false)
                : readers.All(p => p.ExitCode == 0);
            }
        } catch (Exception error) { Console.Error.WriteLine($"Synthetic memory native: {error.GetType().Name}: {error.Message}"); Console.Error.Flush(); }
        finally {
            Phase("cleanup-start", id);
            foreach (var reader in readers) {
                try {
                    if (!reader.HasExited) { Phase($"reader-stop-pid-{reader.Id}", id); reader.Kill(); await reader.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
                    Phase($"reader-joined-pid-{reader.Id}-code-{reader.ExitCode}", id);
                }
                catch { readersJoined = false; }
                reader.Dispose();
            }
            foreach (var ready in readyHandles) ready.Dispose();
            evidenceStop.Cancel();
            foreach (var ticket in readerPipes) ticket.Server.Dispose();
            var evidenceDrain = Task.WhenAll(readerPipes.Select(ticket => ticket.Evidence));
            try { await evidenceDrain.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false); }
            catch { if (!evidenceDrain.IsCompleted) { readerPipeTasksJoined = false; readersJoined = false; } }
            if (evidenceDrain.IsCompleted) evidenceStop.Dispose();
            if (provider is null) disposeCompleted = true;
            else try { await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(20)); disposeCompleted = true; }
            catch (TimeoutException) { disposeTimedOut = true; }
            catch { }
            var committedCleanupUncertain = provider?.SyntheticCommittedCleanupUncertain == true;
            ReportSettlements();
            if (failFast == "on" && provider is not null) {
                Console.WriteLine($"Synthetic failure settlement totals: attempted={provider.SyntheticFailureSettlementsAttempted}; published={provider.SyntheticFailureSettlements.Length}");
                // Recheck after provider drain: a late duplicate callback or
                // settlement invalidates any provisional success evidence.
                var finalTrace = NativeStallTrace.Snapshot(trace);
                var finalSettlements = provider.SyntheticFailureSettlements;
                Console.WriteLine($"Synthetic final audit: callbackArrivals={finalTrace.Count(e => e.Kind == NativeStallTrace.Stage.CallbackArrival)}; queued={finalTrace.Count(e => e.Kind == NativeStallTrace.Stage.CallbackQueued)}; admissionTimeouts={finalTrace.Count(e => e.Kind == NativeStallTrace.Stage.SyntheticAdmissionTimedOut)}; transfersStarted={finalTrace.Count(e => e.Kind == NativeStallTrace.Stage.SyntheticSerialTransferEnter)}; transfersExited={finalTrace.Count(e => e.Kind == NativeStallTrace.Stage.SyntheticSerialTransferExit)}; readerPipeTasksJoined={readerPipeTasksJoined}");
                success = success && SyntheticFailFastTraceValid(finalTrace, NativeStallTrace.Attempted(trace), NativeStallTrace.Dropped(trace), true) &&
                    provider.SyntheticFailureSettlementsAttempted == 1 && finalSettlements.Length == 1 &&
                    finalSettlements[0].CompletionStatus == CloudFilesNativeTransfer.Unavailable && finalSettlements[0].NativeResult == 0;
            }
            // For this deliberate failure, also preserve the registered root
            // unless the expected loser settled, readers/drain completed, and
            // the synthetic reservation directory has no outstanding record.
            var failFastEvidence = failFast != "on" || (success && readersJoined && disposeCompleted && SyntheticReservationsEmpty(cache));
            if (failFast == "on") Console.WriteLine($"Synthetic fail-fast reservation cleanup verified: {failFastEvidence}");
#if LEDGETOP_CACHE_RACE_TEST
            var sourceClosed = ownedSource is null;
            if (ownedSource is not null && (provider is null || (disposeCompleted && readersJoined))) {
                try { ownedSource.Dispose(); sourceClosed = true; } catch { sourceClosed = false; }
            }
            var ownedTrace = NativeStallTrace.Snapshot(trace);
            var ownedEvidence = ownedDownloader != "1" || (success && readersJoined && disposeCompleted && sourceClosed && ownedSource is not null &&
                ownedSource.CompletedExactly(manifest.Values) && SyntheticReservationsEmpty(cache) && NativeStallTrace.Dropped(trace) == 0 &&
                NativeStallTrace.Attempted(trace) == ownedTrace.LongLength);
            if (ownedDownloader == "1") Console.WriteLine($"Synthetic owned downloader evidence verified: {ownedEvidence}");
            if (receiptTransfer == "1" && ownedSource is not null)
                foreach (var line in ownedSource.ReceiptEvidence()) Console.WriteLine(line);
#else
            const bool ownedEvidence = true;
#endif
            var finalPendingTrace = NativeStallTrace.Snapshot(trace);
            var pendingEvidence = pending == "off" || (success && readersJoined && disposeCompleted && pendingScope?.EvidenceValid == true &&
                PendingTraceValid(finalPendingTrace, NativeStallTrace.Attempted(trace), NativeStallTrace.Dropped(trace), pending));
            if (pendingScope is not null && disposeCompleted) {
                try { pendingScope.Dispose(); pendingScope = null; } catch { pendingEvidence = false; }
            }
            if (pending != "off") Console.WriteLine($"Synthetic pending-marker evidence verified: {pendingEvidence}; control={pending}");
            if (failFastEvidence && pendingEvidence && ownedEvidence && MayUnregister(registration is not null, readersJoined, disposeCompleted, committedCleanupUncertain))
                try { registration!.Unregister(); unregisterVerified = true; } catch { }
            // A timed-out provider may still be executing callbacks. Retain its
            // handles instead of closing them while that work may use them.
            if (disposeCompleted) { preopened?.Dispose(); preopened = null; }
            if (disposeCompleted) { createScope?.Dispose(); createScope = null; }
            Phase(preopened is null ? "preopened-handles-released" : "preopened-handles-retained", id);
            Phase(createScope is null ? "create-scope-released" : "create-scope-retained", id);
            var cleanupVerified = pendingEvidence && ownedEvidence && CleanupVerified(registrationAttempted, registration is not null, readersJoined, disposeCompleted, unregisterVerified, committedCleanupUncertain);
            if (!cleanupVerified) success = false;
            foreach (var item in NativeStallTrace.Snapshot(trace).Where(e => ownedDownloader == "1" || pending != "off" || cacheStage != "none" || (processInfo == "on" && e.Kind == NativeStallTrace.Stage.WorkerStart && e.CallbackId != 0) || e.Kind is NativeStallTrace.Stage.SyntheticCallbackProcess or NativeStallTrace.Stage.SyntheticMarkerReadEnter or NativeStallTrace.Stage.SyntheticMarkerReadExit
                or NativeStallTrace.Stage.SyntheticMarkerCreateEnter or NativeStallTrace.Stage.SyntheticMarkerCreateExit
                or NativeStallTrace.Stage.SyntheticMarkerWriteEnter or NativeStallTrace.Stage.SyntheticMarkerWriteExit
                or NativeStallTrace.Stage.SyntheticMarkerFlushEnter or NativeStallTrace.Stage.SyntheticMarkerFlushExit
                or NativeStallTrace.Stage.SyntheticMarkerCloseEnter or NativeStallTrace.Stage.SyntheticMarkerCloseExit))
                if (item.Kind == NativeStallTrace.Stage.SyntheticCallbackProcess)
                    Console.WriteLine($"Synthetic callback trace: seq={item.Sequence}; thread={item.ThreadId}; callback={item.CallbackId}; processInfo={(SyntheticCallbackProcessInfo.Status)item.ProcessInfoStatus}; pid={item.ProcessId}");
                else Console.WriteLine($"Synthetic marker trace: seq={item.Sequence}; thread={item.ThreadId}; stage={item.Kind}; callback={item.CallbackId}");
            Console.WriteLine($"Synthetic marker trace: attempted={NativeStallTrace.Attempted(trace)}; dropped={NativeStallTrace.Dropped(trace)}");
            NativeStallTrace.Disable(trace);
            Console.WriteLine($"Synthetic memory native: count={count}; success={success}; nativeRegistrationCleanupVerified={cleanupVerified}; committedCleanupUncertain={committedCleanupUncertain}; fixtureDirectoriesRemoved=False; disposeTimedOut={disposeTimedOut}; registrationAttempted={registrationAttempted}; registrationReturned={registration is not null}; root={root}; registrationContext=LedgeTop.Files.MemoryNativeTest.v1:{id}");
            Console.Out.Flush();
        }
        return success ? 0 : 1;
    }
#if LEDGETOP_CACHE_RACE_TEST
    // No credentials, DNS, or network: this source is bound to the exact
    // generated manifest and an in-memory HttpMessageHandler only.
    private sealed class OwnedDownloaderSource : IQueuedDownloadSource, IVerifiedHydrationDownloadSource, IHydrationMutationAwareSource, IDiagnosticOwnedDownloaderSource, IDisposable {
        private readonly Dictionary<string, PlaceholderIdentity> identities;
        private readonly Downloader downloader;
        private readonly ConcurrentDictionary<string, byte> completed = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<(string File, long Request, long Offset, long Length), int> receiptCompletions = new();
        internal OwnedDownloaderSource(IEnumerable<PlaceholderIdentity> manifest) {
            identities = manifest.ToDictionary(value => value.ResourceReference, StringComparer.Ordinal);
            downloader = new Downloader(new SyntheticHandler(), [Origin]) { ExperimentalColdOwnedStreamForTest = true };
        }
        public string Alias => "synthetic";
        public Uri Origin => new("https://source.example.invalid");
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) {
            token.ThrowIfCancellationRequested(); return Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddMinutes(10)));
        }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            token.ThrowIfCancellationRequested();
            if (!identities.TryGetValue(reference, out var id)) throw new ResourceUnavailableException();
            var spec = new DownloadSpec(id.LogicalFileId + ":" + id.RemoteVersion, new Uri(Origin, "/synthetic-content"), id.FileName, id.Length, id.ETag, id.Sha256);
            return Task.FromResult(new ResolvedQueuedDownload(Principal, id.LogicalFileId, id.RemoteVersion, spec));
        }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) =>
            downloader.DownloadAsync(spec, destination, cancellationToken, progress);
        async Task<VerifiedHydrationDownload> IVerifiedHydrationDownloadSource.DownloadForHydrationAsync(DownloadSpec spec, string destination, CancellationToken token) {
            var result = await downloader.DownloadVerifiedForHydrationAsync(spec, destination, token).ConfigureAwait(false);
            completed.TryAdd(spec.FileName, 0); return result;
        }
        internal bool CompletedExactly(IEnumerable<PlaceholderIdentity> manifest) =>
            completed.Keys.Order(StringComparer.Ordinal).SequenceEqual(manifest.Select(item => item.FileName).Order(StringComparer.Ordinal));
        public SyntheticReceiptDownloadSource CreateReceiptSource(PlaceholderIdentity identity) {
            if (!identities.TryGetValue(identity.ResourceReference, out var expected) || expected != identity) throw new ResourceUnavailableException();
            var spec = new DownloadSpec(identity.LogicalFileId + ":" + identity.RemoteVersion, new Uri(Origin, "/synthetic-content"), identity.FileName, identity.Length, identity.ETag, identity.Sha256);
            return SyntheticReceiptDownloadSource.Create(spec, Bytes);
        }
        internal int ReceiptCompletions => receiptCompletions.Values.Sum();
        internal string[] ReceiptEvidence() => receiptCompletions.OrderBy(pair => pair.Key.File, StringComparer.Ordinal).ThenBy(pair => pair.Key.Request).Select(pair =>
            $"Synthetic receipt range: file={pair.Key.File}; request={pair.Key.Request}; offset={pair.Key.Offset}; length={pair.Key.Length}; count={pair.Value}").ToArray();
        public void ReceiptCompleted(PlaceholderIdentity identity, CloudFilesOperationContext context) {
            if (!identities.TryGetValue(identity.ResourceReference, out var expected) || expected != identity || context.FileSize != identity.Length ||
                context.RequiredOffset < 0 || context.RequiredLength <= 0 || context.RequiredOffset > identity.Length || context.RequiredLength > identity.Length - context.RequiredOffset)
                throw new IOException("Synthetic receipt completion changed identity or range.");
            receiptCompletions.AddOrUpdate((identity.FileName, context.RequestKey, context.RequiredOffset, context.RequiredLength), 1, (_, count) => checked(count + 1));
            if (receiptCompletions.Count > 1000 || ReceiptCompletions > 1000) throw new IOException("Synthetic receipt completion evidence overflow.");
            completed.TryAdd(identity.FileName, 0);
        }
        public void Dispose() => downloader.Dispose();
        internal static async Task VerifyHandlerForTest() {
            using var client = new HttpMessageInvoker(new SyntheticHandler());
            using var request = new HttpRequestMessage(HttpMethod.Get, "https://source.example.invalid/synthetic-content");
            request.Headers.IfMatch.Add(new EntityTagHeaderValue("\"" + Sha + "\""));
            using var response = await client.SendAsync(request, CancellationToken.None).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.OK || response.Headers.ETag?.ToString() != "\"" + Sha + "\"" ||
                !(await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false)).SequenceEqual(Bytes)) throw new IOException("Synthetic handler returned invalid bytes.");
        }
        private sealed class SyntheticHandler : HttpMessageHandler {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
                token.ThrowIfCancellationRequested();
                if (request.Method != HttpMethod.Get || request.RequestUri?.AbsoluteUri != "https://source.example.invalid/synthetic-content" ||
                    request.Headers.IfMatch.Count != 1 || request.Headers.IfMatch.Single().ToString() != "\"" + Sha + "\"" ||
                    request.Headers.Range is not null || request.Headers.Authorization is not null || request.Headers.Contains("Cookie") || request.Headers.Contains("Cf-Access-Token"))
                    throw new IOException("Synthetic request scope mismatch.");
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(Bytes) };
                response.Headers.ETag = new EntityTagHeaderValue("\"" + Sha + "\"");
                return Task.FromResult(response);
            }
        }
    }
#endif
    private sealed class Source : IQueuedDownloadSource {
        public string Alias => "synthetic";
        public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
    }
}
#endif
