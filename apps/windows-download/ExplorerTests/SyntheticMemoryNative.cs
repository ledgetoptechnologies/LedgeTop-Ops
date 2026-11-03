#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

// Diagnostic only: distinct external readers against a fresh synthetic native
// root. Never selects production sources or uses cache I/O in FETCH_DATA.
internal static class SyntheticMemoryNative {
    internal static readonly byte[] Bytes = Encoding.UTF8.GetBytes(new string('x', 100_000));
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    private static readonly string Principal = "odqp1_" + new string('f', 64);
    private static void Phase(string phase, Guid id) {
        try {
            Console.WriteLine($"Synthetic memory phase: probe={id:N}; phase={phase}");
            Console.Out.Flush();
        } catch (IOException) { /* A closed log must not interrupt native cleanup. */ }
    }
    internal static int Reader(string path, string startName, string readyName) {
        return ReaderOperation(() => {
            using var start = EventWaitHandle.OpenExisting(startName); using var ready = EventWaitHandle.OpenExisting(readyName);
            ready.Set(); if (!start.WaitOne(TimeSpan.FromSeconds(15))) throw new TimeoutException("Reader start gate timed out.");
            return File.ReadAllBytes(path);
        }, (outcome, code) => ReaderReport(Path.GetFileName(path), outcome, code));
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
    internal static bool CleanupVerified(bool registrationAttempted, bool registrationReturned, bool readersJoined, bool disposeCompleted, bool unregisterVerified) =>
        readersJoined && (!registrationAttempted || (registrationReturned && disposeCompleted && unregisterVerified));
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
        return $"Synthetic memory options: blockSelf={blockSelf}; disableScanner={disableScanner}; suppressProgress={suppressProgress}; markerIo={markerIo}; cacheStage={cacheStage}";
    }
    private static string CacheStage(string? value) => value switch { null or "none" => "none", "quota-only" => "quota-only", "quota-ownership" => "quota-ownership", "quota-capacity" => "quota-capacity", "quota-reservation" => "quota-reservation", "quota-reservation-gap" => "quota-reservation-gap", _ => "invalid" };
    internal static async Task<int> CacheStageTests() {
        var basePath = Path.Combine(Path.GetTempPath(), "LedgeTop-cache-stage-" + Guid.NewGuid().ToString("N"));
        var fixtures = Path.Combine(basePath, "memory-native-fixtures");
        var owned = Path.Combine(fixtures, Guid.NewGuid().ToString("N"));
        var cache = Path.Combine(owned, "Cache"); Directory.CreateDirectory(cache);
        var previousProbe = Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE");
        var previousBase = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        var identity = new PlaceholderIdentity("pilot", "synthetic", "https://source.example.invalid", Principal, "odqr1_0",
            "oef1_" + new string('a', 64), Sha, "sample-0.bin", Bytes.Length, "\"" + Sha + "\"", Sha);
        var root = Path.Combine(cache, "verified-hydration-v1");
        var scope = Path.Combine(root, identity.ScopeKey); var entry = Path.Combine(scope, identity.CacheKey);
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
                var events = NativeStallTrace.Snapshot(capture).Select(e => e.Kind).ToArray();
                if (events.Count(e => e == NativeStallTrace.Stage.CacheQuotaAcquired) != 10 ||
                    events.Count(e => e == NativeStallTrace.Stage.SyntheticRootPrepareExit) != 6 ||
                    events.Count(e => e == NativeStallTrace.Stage.CacheScopeOwnEnter) != 1 ||
                    events.Count(e => e == NativeStallTrace.Stage.CacheEntryOwnEnter) != 1 ||
                    events.Count(e => e == NativeStallTrace.Stage.CacheCapacityExit) != 3 ||
                    Array.IndexOf(events, NativeStallTrace.Stage.SyntheticEntryLeaseGapOpen) >= Array.IndexOf(events, NativeStallTrace.Stage.SyntheticEntryLeaseGapClosed) ||
                    !events.Contains(NativeStallTrace.Stage.SyntheticEntryLeaseGapOpen) || !events.Contains(NativeStallTrace.Stage.SyntheticEntryLeaseGapClosed) ||
                    !events.Contains(NativeStallTrace.Stage.CacheReserveAcquired) || !events.Contains(NativeStallTrace.Stage.CacheReleaseExit) ||
                    !events.Contains(NativeStallTrace.Stage.OwnedMarkerFlushExit)) throw new IOException("Synthetic cache stages omitted expected trace.");
            } finally { NativeStallTrace.Disable(capture); }
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
            File.Delete(Path.Combine(entry, ".hydration.lock")); File.Delete(Path.Combine(entry, ".verified-hydration-owner")); if (Directory.Exists(entry)) Directory.Delete(entry);
            File.Delete(Path.Combine(scope, ".verified-hydration-owner")); if (Directory.Exists(scope)) Directory.Delete(scope);
            var reservationDirectory = Path.Combine(root, ".hydration-reservations-v2");
            File.Delete(Path.Combine(reservationDirectory, ".verified-hydration-owner")); if (Directory.Exists(reservationDirectory)) Directory.Delete(reservationDirectory);
            File.Delete(Path.Combine(root, ".hydration-cache.lock")); File.Delete(Path.Combine(root, ".hydration-quota-v2.lock"));
            File.Delete(Path.Combine(root, ".verified-hydration-owner")); if (Directory.Exists(root)) Directory.Delete(root);
            Directory.Delete(cache); Directory.Delete(owned); Directory.Delete(fixtures); Directory.Delete(basePath);
        }
        Console.WriteLine("PASS synthetic actual cache admission, quota, ownership and scope refusals without native registration."); return 0;
    }
    internal static int CleanupEvidenceTests() {
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
            !CleanupVerified(true, true, true, true, true)) throw new IOException("Synthetic registration cleanup evidence is incorrect.");
        var options = DiagnosticSettings(name => name == "LEDGETOP_TEST_BLOCK_SELF_IMPLICIT_HYDRATION" ? "1" : "synthetic-secret");
        if (options != "Synthetic memory options: blockSelf=True; disableScanner=False; suppressProgress=False; markerIo=invalid; cacheStage=invalid")
            throw new IOException("Synthetic diagnostic option reporting is incorrect.");
        if (DiagnosticSettings(name => name is "LEDGETOP_TEST_MEMORY_MARKER_IO" or "LEDGETOP_TEST_MEMORY_CACHE_STAGE" ? null : "1") != "Synthetic memory options: blockSelf=True; disableScanner=True; suppressProgress=True; markerIo=none; cacheStage=none")
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
        if (markerMode == "invalid" || cacheStage == "invalid" || (markerMode != "none" && cacheStage != "none")) return 2;
        if (retryProbe && (count != 1 || markerMode != "none" || cacheStage != "none" || !RetryOptionsValid(Environment.GetEnvironmentVariable))) return 2;
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
        DiagnosticMemoryMarkerIo.Preopened? preopened = null;
        DiagnosticMemoryMarkerIo.CreateScope? createScope = null;
        var readers = new List<Process>(); var readyHandles = new List<EventWaitHandle>(); var success = false;
        var registrationAttempted = false; var readersJoined = true; var disposeCompleted = false;
        var disposeTimedOut = false; var unregisterVerified = false;
        var startName = "Local\\LedgeTopMemoryProbe-" + id.ToString("N");
        using var start = new EventWaitHandle(false, EventResetMode.ManualReset, startName);
        var trace = NativeStallTrace.Enable();
        try {
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
            provider = new NativePlaceholderProvider(registration, cache, new Source(), "pilot", Principal, manifest, []);
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
                var reader = Process.Start(info) ?? throw new IOException("Synthetic reader failed to start.");
                readers.Add(reader);
                Phase($"reader-started-{readyHandles.Count - 1}-pid-{reader.Id}", id);
            }
            Phase("reader-ready-wait", id);
            if (!WaitHandle.WaitAll(readyHandles.ToArray(), TimeSpan.FromSeconds(10))) throw new TimeoutException("Synthetic readers did not reach the start gate.");
            start.Set();
            Phase("reader-exit-wait", id);
            await Task.WhenAll(readers.Select(p => p.WaitForExitAsync())).WaitAsync(TimeSpan.FromSeconds(25));
            Phase("readers-exited", id);
            foreach (var reader in readers) Phase($"reader-exited-pid-{reader.Id}-code-{reader.ExitCode}", id);
            success = readers.All(p => p.ExitCode == 0);
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
            if (provider is null) disposeCompleted = true;
            else try { await provider.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(20)); disposeCompleted = true; }
            catch (TimeoutException) { disposeTimedOut = true; }
            catch { }
            if (registration is not null && readersJoined && disposeCompleted)
                try { registration.Unregister(); unregisterVerified = true; } catch { }
            // A timed-out provider may still be executing callbacks. Retain its
            // handles instead of closing them while that work may use them.
            if (disposeCompleted) { preopened?.Dispose(); preopened = null; }
            if (disposeCompleted) { createScope?.Dispose(); createScope = null; }
            Phase(preopened is null ? "preopened-handles-released" : "preopened-handles-retained", id);
            Phase(createScope is null ? "create-scope-released" : "create-scope-retained", id);
            var cleanupVerified = CleanupVerified(registrationAttempted, registration is not null, readersJoined, disposeCompleted, unregisterVerified);
            if (!cleanupVerified) success = false;
            foreach (var item in NativeStallTrace.Snapshot(trace).Where(e => cacheStage != "none" || e.Kind is NativeStallTrace.Stage.SyntheticMarkerReadEnter or NativeStallTrace.Stage.SyntheticMarkerReadExit
                or NativeStallTrace.Stage.SyntheticMarkerCreateEnter or NativeStallTrace.Stage.SyntheticMarkerCreateExit
                or NativeStallTrace.Stage.SyntheticMarkerWriteEnter or NativeStallTrace.Stage.SyntheticMarkerWriteExit
                or NativeStallTrace.Stage.SyntheticMarkerFlushEnter or NativeStallTrace.Stage.SyntheticMarkerFlushExit
                or NativeStallTrace.Stage.SyntheticMarkerCloseEnter or NativeStallTrace.Stage.SyntheticMarkerCloseExit))
                Console.WriteLine($"Synthetic marker trace: seq={item.Sequence}; thread={item.ThreadId}; stage={item.Kind}");
            Console.WriteLine($"Synthetic marker trace: attempted={NativeStallTrace.Attempted(trace)}; dropped={NativeStallTrace.Dropped(trace)}");
            NativeStallTrace.Disable(trace);
            Console.WriteLine($"Synthetic memory native: count={count}; success={success}; nativeRegistrationCleanupVerified={cleanupVerified}; fixtureDirectoriesRemoved=False; disposeTimedOut={disposeTimedOut}; registrationAttempted={registrationAttempted}; registrationReturned={registration is not null}; root={root}; registrationContext=LedgeTop.Files.MemoryNativeTest.v1:{id}");
            Console.Out.Flush();
        }
        return success ? 0 : 1;
    }
    private sealed class Source : IQueuedDownloadSource {
        public string Alias => "synthetic";
        public Uri Origin => new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new InvalidOperationException("Synthetic memory probe must not access a source.");
    }
}
#endif
