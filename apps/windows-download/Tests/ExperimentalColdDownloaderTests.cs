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
    private static int PendingOwnedResources() => ExperimentalOwnedStream.QuarantinedCountForTest + OwnedObservers.Count + UncertainTestResources.Count;
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
        await ObserverReaperTest();
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
                maximumCacheBytes: 128, expectedPrincipal: CoordinatorSource.Principal);
            var root = Path.Combine(fixture.Path, "verified-hydration-v1");
            var lease = await HydrationCacheConcurrency.AcquireAsync(root, "scan", CancellationToken.None);
            try {
                lease.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
                var scope = Path.Combine(root, "synthetic-scope"); Directory.CreateDirectory(scope);
                lease.ExperimentalMarkers.CreateNew(scope);
                var marker = Path.Combine(scope, ".verified-hydration-owner"); AssertOtherProcessCannotOpen(marker);
                var ownerLength = System.Text.Encoding.UTF8.GetByteCount("LedgeTop.VerifiedHydration/1\n");
                var used = coordinator.ExperimentalCheckMarkerCapacity(lease, 0, 0);
                Check(used == 2 * ownerLength && coordinator.ExperimentalCheckMarkerCapacity(lease, 0, 128 - used) == used);
                var rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(lease, 0, 129 - used); } catch (TransferException) { rejected = true; }
                Check(rejected);
                var foreign = Path.Combine(root, "foreign"); Directory.CreateDirectory(foreign);
                var foreignMarker = Path.Combine(foreign, ".verified-hydration-owner"); File.WriteAllBytes(foreignMarker, Foreign);
                rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(lease, 0, 0); } catch (IOException) { rejected = true; }
                Check(rejected && File.ReadAllBytes(foreignMarker).SequenceEqual(Foreign));
                File.Delete(foreignMarker);
                var variantMarker = Path.Combine(foreign, ".VERIFIED-HYDRATION-OWNER"); File.WriteAllBytes(variantMarker, "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                rejected = false; try { coordinator.ExperimentalCheckMarkerCapacity(lease, 0, 0); } catch (IOException) { rejected = true; }
                Check(rejected && File.Exists(variantMarker));
            } finally { lease.Dispose(); }
            var disposedRejected = false;
            try { coordinator.ExperimentalCheckMarkerCapacity(lease, 0, 0); } catch (ObjectDisposedException) { disposedRejected = true; }
            Check(disposedRejected);
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
        private readonly Downloader downloader; internal int Downloads; internal Func<HttpResponseMessage>? ResponseFactory; internal Action<HttpRequestMessage>? InspectRequest;
        internal CoordinatorSource() => downloader = Engine((request, _) => { Downloads++; InspectRequest?.Invoke(request); return ResponseFactory?.Invoke() ?? Response(Content); });
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
