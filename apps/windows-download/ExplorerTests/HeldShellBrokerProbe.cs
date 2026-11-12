using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json.Serialization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using LedgeTop.Files.Explorer;

// Explicit native-only compatibility experiment. This must never run as part of default tests.
// A failed or interrupted registration is intentionally retained for manual reconciliation.
internal static class HeldShellBrokerProbe
{
    internal static async Task<int> RunAsync(string artifactBase, bool observeBrand = false)
    {
#if !LEDGETOP_BRAND_OBSERVER_TEST
        if (observeBrand) throw new IOException("Branded observer requires an isolated test build.");
#endif
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var canonicalBase = Path.GetFullPath(artifactBase);
        var driveRoot = Path.GetPathRoot(canonicalBase) ?? throw new IOException("Fixture drive unavailable.");
        if (!BasicPath(artifactBase, canonicalBase, driveRoot)) throw new IOException("A dedicated local fixture path is required.");
        var drive = new DriveInfo(driveRoot);
        var driveType = drive.DriveType;
        if (driveType != DriveType.Fixed) throw new IOException("A fixed local fixture drive is required.");
        var format = drive.DriveFormat;
        if (!AdmittedPath(artifactBase, canonicalBase, driveRoot, driveType, format))
            throw new IOException("A dedicated empty fixed NTFS fixture base is required.");
        if (!Directory.Exists(canonicalBase)) throw new IOException("Fixture base is unavailable.");
        if (!GetVolumeInformationW(driveRoot, null, 0, out var serial, out _, out _, null, 0) || serial == 0)
            throw new IOException("Fixture volume identity is unavailable.");
        if (Directory.EnumerateFileSystemEntries(canonicalBase).Any()) throw new IOException("Fixture base is not empty.");
        var id = Guid.NewGuid();
        var fixture = Path.Combine(canonicalBase, "held-broker-" + id.ToString("N"));
        var root = Path.Combine(fixture, "Files");
        var context = Encoding.UTF8.GetBytes("LedgeTop.Files.HeldBrokerProbe.v1:" + id.ToString("N"));
        using var directories = new CandidateDirectoryFence();
        directories.HoldAncestors(canonicalBase);
        if (Directory.EnumerateFileSystemEntries(canonicalBase).Any()) throw new IOException("Fixture base changed before creation.");
        directories.CreateExclusiveDirectory(fixture);
        var created = directories.CreateExclusiveDirectory(root);
        using var held = CreateFileW(root, 0x80, 3, 0, 3, 0x02200000, 0); // READ_ATTRIBUTES, no delete sharing, open reparse point.
        var before = Identity(held);
        if (before != created || before.Volume != serial) throw new IOException("Held root identity differs from the exclusively created root or admitted volume.");
        WriteNew(Path.Combine(fixture, "intent.json"), new { id, root, volume = before.Volume, fileId = before.FileId,
            admission = new { basePath = canonicalBase, driveRoot, driveType = driveType.ToString(), format, serial, emptyBeforeCreation = true },
            context = Convert.ToBase64String(context), shellId = ShellRegistration.CreateId(id), generatedDataOnly = true, productionAccess = false });
        Console.WriteLine(JsonSerializer.Serialize(new { fixture, phase = "intent-persisted" }));
        ShellRegistration? registration = null;
        var shellId = ShellRegistration.CreateId(id);
        var icon = observeBrand ? ExplorerBrandIcon.EnsureResource() : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3";
#if LEDGETOP_BRAND_OBSERVER_TEST
        var displayName = observeBrand ? "LedgeTop Files Test " + id.ToString("N") : ShellRegistration.DisplayName;
        if (observeBrand && Windows.Storage.Provider.StorageProviderSyncRootManager.GetCurrentSyncRoots().Any(item => string.Equals(item.DisplayNameResource, displayName, StringComparison.Ordinal)))
            throw new IOException("The generated test label already exists; no registration was attempted.");
#else
        var displayName = observeBrand ? ExplorerRootDisplayName.ForConnectedAlias("employee") : ShellRegistration.DisplayName;
#endif
        var unregisterAttempted = false;
        try {
            // The exact owned handle and parent fences stay alive during the broker call.
            registration = await ShellRegistration.RegisterAsync(root, shellId, icon, context, displayName);
            var after = Identity(held);
            var observed = NativeRootRegistration.Inspect(root, context);
            if (!Matches(before, after, observed))
                throw new IOException("Registration readback or held root identity differs; registration retained.");
            WriteNew(Path.Combine(fixture, "registered.json"), new { id, volume = after.Volume, fileId = after.FileId,
                observed.RootFileId, observed.ExpectedContextMatches, registration.NamespaceClsid });
            if (observeBrand) {
                if (registration.NamespaceClsid == Guid.Empty || unchecked((ulong)registration.RootFileId) != before.FileId) throw new IOException("Shell identity differs before observation.");
                await ObserveBrandAsync(root, fixture, before, displayName);
                if (Identity(held) != before || !Matches(before, Identity(held), NativeRootRegistration.Inspect(root, context))) throw new IOException("Root identity changed during observation.");
            }
            // Unregister only this successful receipt after verifying the held physical root identity again.
            if (Identity(held) != before) throw new IOException("Root identity changed; registration retained.");
            if (registration.NamespaceClsid == Guid.Empty || unchecked((ulong)registration.RootFileId) != before.FileId)
                throw new IOException("Shell receipt identity differs; registration retained.");
            var shellNamespace = registration.NamespaceClsid;
            registration.VerifyOwned();
            unregisterAttempted = true;
            registration.Unregister();
            registration = null;
            var absent = ShellRegistration.Inspect(root, shellId, context, shellNamespace, icon, displayName);
            if (!absent.CompleteAbsenceVerified) throw new IOException("Shell registration absence could not be verified.");
            var outcome = BrokerOutcomeFor(id, fixture);
            WriteNew(Path.Combine(fixture, "result.json"), outcome);
            Console.WriteLine(JsonSerializer.Serialize(outcome));
            return 0;
        } catch (Exception error) {
            if (error is ShellRegistrationException partial) {
                try { WriteNew(Path.Combine(fixture, "shell-partial.json"), new { id, shellId, rootFileId = partial.OwnedPartial.RootFileId, namespaceClsid = partial.OwnedPartial.NamespaceClsid, ownershipVerified = false }); } catch { }
            }
            // A thrown Register can follow a successful OS mutation. Never infer absence or retry.
            try { WriteNew(Path.Combine(fixture, "uncertain.json"), new { id, phase = registration is null ? "registration-or-readback" : "post-registration",
                error = error.GetType().Name, observerCode = (error as ObserverFailure)?.Code,
                observerExitCode = (error as ObserverFailure)?.ExitCode, observerLastStage = (error as ObserverFailure)?.LastStage, observerStderrTruncated = (error as ObserverFailure)?.StderrTruncated, unregisterAttempted }); } catch { }
            Console.Error.WriteLine("Held broker probe did not finish; retain fixture and reconcile its exact recorded identity.");
            Console.Error.WriteLine(error.GetType().Name);
            return 1;
        }
    }

    private sealed record BrokerOutcome(Guid id, string fixture, bool brokerCompatible, bool unregisterVerified,
        bool navigationVerified, bool brandingVerified, bool generatedDataOnly, bool productionAccess);
    private static BrokerOutcome BrokerOutcomeFor(Guid id, string fixture) => new(id, fixture, true, true, false, false, true, false);

    internal sealed record ObserverResult(long Hwnd, uint Pid, long StartTicks, uint Volume, ulong FileId, bool Closed, string Screenshot, bool LabelObserved, int LabelCount);
    private static readonly JsonSerializerOptions observerJson = new() { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    internal static bool ValidObserverResult(ObserverResult? result, CandidateDirectoryFence.DirectoryIdentity expected, string screenshot) =>
        result is { Hwnd: > 0, Pid: > 0, StartTicks: > 0, Closed: true, LabelObserved: true, LabelCount: 1 } &&
        result.Volume == expected.Volume && result.FileId == expected.FileId &&
        string.Equals(result.Screenshot, screenshot, StringComparison.OrdinalIgnoreCase);

    private static async Task ObserveBrandAsync(string root, string fixture, CandidateDirectoryFence.DirectoryIdentity expected, string displayName)
    {
        var script = Path.Combine(fixture, "observer.ps1");
        using (var embedded = Assembly.GetExecutingAssembly().GetManifestResourceStream("WindowsDownload.Explorer.Tests.OwnedBrandObserver.ps1")
            ?? throw new IOException("Observer resource is unavailable."))
        using (var output = new FileStream(script, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            // Windows PowerShell 5.1 reads BOM-marked UTF-8 scripts consistently.
            output.Write([0xef, 0xbb, 0xbf]); embedded.CopyTo(output); output.Flush(true);
        }
        using var scriptPin = new FileStream(script, FileMode.Open, FileAccess.Read, FileShare.Read);
        var powerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
        var start = new ProcessStartInfo(powerShell) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        foreach (var value in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", script, "-Root", root, "-Volume", expected.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture), "-FileId", expected.FileId.ToString(System.Globalization.CultureInfo.InvariantCulture), "-Fixture", fixture, "-Label", displayName }) start.ArgumentList.Add(value);
        using var process = Process.Start(start) ?? throw new IOException("Observer process could not start.");
        using var streamCancellation = new CancellationTokenSource();
        var stdout = ReadBoundedAsync(process.StandardOutput, 8192, streamCancellation.Token);
        var stderr = ReadBoundedAsync(process.StandardError, 8192, streamCancellation.Token);
        ObserveStreamFault(stdout); ObserveStreamFault(stderr);
        try {
            await WaitForObserverOrRetainAsync(process.WaitForExitAsync(), ObserverDeadline, async () => {
                // Kill only the directly created observer; its Explorer window may persist.
                if (!process.HasExited) process.Kill();
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                return process.HasExited;
            });
        } catch {
            streamCancellation.Cancel();
            throw;
        }
        var (capturedOut, capturedErr) = await DrainObserverOutputAsync(stdout, stderr, streamCancellation, TimeSpan.FromSeconds(5), process.ExitCode);
        if (process.ExitCode != 0) throw ObserverFailure.FromExit(process.ExitCode, capturedErr.Text, capturedErr.Truncated);
        if (capturedOut.Truncated) throw new ObserverFailure("output-too-large", process.ExitCode, capturedErr.Truncated);
        var outputText = capturedOut.Text;
        var result = JsonSerializer.Deserialize<ObserverResult>(outputText, observerJson);
        var screenshot = Path.Combine(fixture, "observer-window.png");
        if (!ValidObserverResult(result, expected, screenshot) || IsWindow(new IntPtr(result!.Hwnd))) throw new IOException("Observer result or window absence could not be verified.");
        var info = new System.IO.FileInfo(screenshot);
        if (!info.Exists || info.Length is < 1 or > 100000000) throw new IOException("Observer screenshot is unavailable.");
        WriteNew(Path.Combine(fixture, "observer-result.json"), new { result.Hwnd, result.Pid, result.StartTicks, result.Volume, result.FileId,
            result.Closed, navigationVerified = false, brandingVerified = false, screenshot = result.Screenshot, visualReviewRequired = true });
    }
    // Consume both redirected streams fully so a noisy child cannot deadlock, but retain only
    // a small prefix. Child text is never written to the receipt or console.
    internal sealed record BoundedText(string Text, bool Truncated);
    internal static async Task<BoundedText> ReadBoundedAsync(TextReader input, int maximum, CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (maximum is < 1 or > 8192) throw new ArgumentOutOfRangeException(nameof(maximum));
        var retained = new StringBuilder(maximum); var buffer = new char[1024]; var truncated = false;
        int read;
        while ((read = await input.ReadAsync(buffer.AsMemory(), token).ConfigureAwait(false)) != 0) {
            var take = Math.Min(read, maximum - retained.Length);
            if (take > 0) retained.Append(buffer, 0, take);
            if (take != read) truncated = true;
        }
        return new(retained.ToString(), truncated);
    }
    private static void ObserveStreamFault(Task<BoundedText> stream) =>
        _ = stream.ContinueWith(t => _ = t.Exception, CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);

    // A descendant can keep an inherited pipe open even after the direct child exits.
    // Bound the join and request cancellation; observe any late task faults without waiting
    // indefinitely for a reader that does not honor cancellation. This is uncertain cleanup.
    internal static async Task<(BoundedText Output, BoundedText Error)> DrainObserverOutputAsync(
        Task<BoundedText> output, Task<BoundedText> error, CancellationTokenSource cancellation, TimeSpan timeout, int exitCode)
    {
        var joined = Task.WhenAll(output, error);
        try {
            var values = await joined.WaitAsync(timeout).ConfigureAwait(false);
            return (values[0], values[1]);
        } catch (TimeoutException) {
            cancellation.Cancel();
            // Observe the aggregate if any stream faults later. No child content is logged.
            _ = joined.ContinueWith(t => _ = t.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            throw new ObserverFailure("stream-drain-timeout", exitCode, true);
        }
    }
    // Known static messages only. Never record arbitrary stderr, paths, labels, or tokens.
    internal sealed class ObserverFailure(string code, int exitCode, bool stderrTruncated, string stage = "unknown") : IOException("Observer did not confirm window closure.")
    {
        internal string Code { get; } = code;
        internal int ExitCode { get; } = exitCode;
        internal bool StderrTruncated { get; } = stderrTruncated;
        internal string LastStage { get; } = stage;
        internal static ObserverFailure FromExit(int exitCode, string stderr, bool truncated)
        {
            var known = new (string Message, string Code)[] {
                ("Root identity unavailable.", "root-identity-unavailable"), ("Root identity changed.", "root-identity-changed"),
                ("Window identity unavailable.", "window-identity-unavailable"), ("Window is not Explorer.", "window-not-explorer"),
                ("Explorer path changed.", "explorer-path-changed"), ("The unique test label is ambiguous.", "label-ambiguous"),
                ("The unique test label did not appear.", "label-not-found"), ("Multiple candidate Explorer windows.", "window-ambiguous"),
                ("No unique new Explorer window.", "window-not-found"), ("Explorer automation is unavailable.", "uia-unavailable"),
                ("Window bounds unavailable.", "window-bounds-unavailable"), ("Window bounds invalid.", "window-bounds-invalid"),
                ("Screenshot capture failed.", "screenshot-failed"), ("Window closure or identity was not confirmed.", "window-close-unconfirmed")
            };
            var matches = known.Where(item => stderr.Contains(item.Message, StringComparison.Ordinal)).Select(item => item.Code).Distinct().ToArray();
            var stage = "unknown"; var position = -1;
            foreach (var candidate in new[] { "initializing", "opening-window", "finding-label", "capturing", "closing" }) {
                var index = stderr.LastIndexOf("OBSERVER_STAGE:" + candidate, StringComparison.Ordinal);
                if (index > position) { position = index; stage = candidate; }
            }
            return new(matches.Length == 1 ? matches[0] : "observer-failed", exitCode, truncated, stage);
        }
    }
    internal static async Task<int> ObserverDiagnosticTests()
    {
        var fake = "OBSERVER_STAGE:opening-window SECRET C:\\private\\file token=abc No unique new Explorer window. " + new string('x', 10000);
        var bounded = await ReadBoundedAsync(new StringReader(fake), 128);
        var classified = ObserverFailure.FromExit(1, bounded.Text, bounded.Truncated);
        if (bounded.Text.Length != 128 || !bounded.Truncated || classified.Code != "window-not-found" ||
            classified.ExitCode != 1 || classified.LastStage != "opening-window" || !classified.StderrTruncated || classified.Message.Contains("SECRET", StringComparison.Ordinal))
            throw new IOException("Observer diagnostic classification failed.");
        var serialized = JsonSerializer.Serialize(new { classified.Code, classified.ExitCode, classified.LastStage, classified.StderrTruncated });
        if (serialized.Contains("SECRET", StringComparison.Ordinal) || serialized.Contains("private", StringComparison.Ordinal) || serialized.Contains("token", StringComparison.Ordinal))
            throw new IOException("Observer diagnostic exposed child text.");
        var unknown = ObserverFailure.FromExit(42, "SECRET C:\\private\\token", false);
        if (unknown.Code != "observer-failed" || unknown.ExitCode != 42 || unknown.LastStage != "unknown" || unknown.StderrTruncated) throw new IOException("Unknown error was not bounded.");
        var ambiguous = ObserverFailure.FromExit(2, "No unique new Explorer window. Root identity changed.", false);
        if (ambiguous.Code != "observer-failed") throw new IOException("Ambiguous child error was overclassified.");
        var exact = await ReadBoundedAsync(new StringReader("1234"), 4);
        if (exact.Truncated || exact.Text != "1234") throw new IOException("Exact bound was misclassified.");
        using (var cancel = new CancellationTokenSource()) {
            var never = new TaskCompletionSource<BoundedText>(TaskCreationOptions.RunContinuationsAsynchronously);
            var good = Task.FromResult(new BoundedText("ok", false));
            try {
                await DrainObserverOutputAsync(good, never.Task, cancel, TimeSpan.FromMilliseconds(20), 3);
                throw new IOException("Hung stream was accepted.");
            } catch (ObserverFailure failure) when (failure.Code == "stream-drain-timeout" && failure.ExitCode == 3 && failure.StderrTruncated && cancel.IsCancellationRequested) { }
            // Simulate a reader that faults only after cancellation. The aggregate has an
            // observing continuation, so the later exception is consumed rather than ignored.
            never.TrySetException(new IOException("private late fault"));
        }
        using (var cancel = new CancellationTokenSource()) {
            var delayed = new TaskCompletionSource<BoundedText>(TaskCreationOptions.RunContinuationsAsynchronously);
            var result = DrainObserverOutputAsync(Task.FromResult(new BoundedText("A", false)), delayed.Task, cancel, TimeSpan.FromSeconds(1), 0);
            delayed.SetResult(new BoundedText("B", false));
            var pair = await result;
            if (pair.Output.Text != "A" || pair.Error.Text != "B" || cancel.IsCancellationRequested) throw new IOException("Completed stream join failed.");
        }
        Console.WriteLine("PASS observer diagnostics retain bounded safe codes, never child text; no broker or UI."); return 0;
    }
    // The child has up to 30s to open, 120 x 250ms to observe the label,
    // and 10s to close its window. Allow startup/UIA overhead and cleanup time.
    internal static readonly TimeSpan ObserverDeadline = TimeSpan.FromSeconds(120);
    internal static async Task WaitForObserverOrRetainAsync(Task exit, TimeSpan deadline, Func<Task<bool>> terminateAndConfirm)
    {
        try { await exit.WaitAsync(deadline).ConfigureAwait(false); }
        catch (TimeoutException) {
            // Even confirmed child exit is not proof its separate Explorer window closed.
            try {
                if (!await terminateAndConfirm().WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false))
                    throw new IOException("Observer exit was not confirmed.");
            } catch (Exception error) {
                throw new IOException("Observer timed out and child exit is unconfirmed; registration retained for review.", error);
            }
            throw new IOException("Observer timed out; child exited but registration is retained for review.");
        }
    }
    internal static async Task<int> ObserverTimeoutTests()
    {
        if (ObserverDeadline < TimeSpan.FromSeconds(90)) throw new IOException("Observer deadline lacks cleanup margin.");
        foreach (var outcome in new[] { "exited", "unconfirmed", "throws" }) {
            var never = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var terminationCalls = 0; var unregisterCalls = 0;
            try {
                await WaitForObserverOrRetainAsync(never.Task, TimeSpan.FromMilliseconds(20), () => {
                    terminationCalls++;
                    if (outcome == "throws") throw new IOException("synthetic termination failure");
                    return Task.FromResult(outcome == "exited");
                });
                unregisterCalls++; // Mirrors the later, unreachable success path.
                throw new IOException("Timed-out observer was accepted.");
            } catch (IOException error) {
                var expected = outcome == "exited" ? "Observer timed out; child exited but registration is retained for review."
                    : "Observer timed out and child exit is unconfirmed; registration retained for review.";
                if (error.Message != expected || terminationCalls != 1 || unregisterCalls != 0) throw;
            } finally { never.TrySetResult(); }
        }
        var called = false;
        await WaitForObserverOrRetainAsync(Task.CompletedTask, TimeSpan.FromSeconds(1), () => { called = true; return Task.FromResult(true); });
        if (called) throw new IOException("An already exited observer was terminated.");
        Console.WriteLine("PASS observer timeout retains registration for confirmed and uncertain child outcomes; no process or native registration."); return 0;
    }
    internal static int ObserverResultTests()
    {
        var root = new CandidateDirectoryFence.DirectoryIdentity(7, 44); const string shot = @"C:\synthetic\observer-window.png";
        var good = new ObserverResult(23, 24, 25, 7, 44, true, shot, true, 1);
        if (!ValidObserverResult(good, root, shot) || ValidObserverResult(good with { Closed = false }, root, shot) ||
            ValidObserverResult(good with { FileId = 45 }, root, shot) || ValidObserverResult(good with { Screenshot = @"C:\other.png" }, root, shot) ||
            ValidObserverResult(good with { Pid = 0 }, root, shot) ||
            // A matching label on another (or duplicate) node is unbound; do not accept a claim that it identifies this root.
            ValidObserverResult(good with { LabelObserved = false }, root, shot) || ValidObserverResult(good with { LabelCount = 2 }, root, shot) || ValidObserverResult(good with { LabelCount = 0 }, root, shot))
            throw new InvalidOperationException("Observer result validation failed.");
        using var outcome = JsonDocument.Parse(JsonSerializer.Serialize(BrokerOutcomeFor(Guid.NewGuid(), @"C:\synthetic")));
        if (!outcome.RootElement.GetProperty("brokerCompatible").GetBoolean() ||
            outcome.RootElement.GetProperty("navigationVerified").GetBoolean() || outcome.RootElement.GetProperty("brandingVerified").GetBoolean() ||
            outcome.RootElement.TryGetProperty("compatible", out _))
            throw new InvalidOperationException("Broker outcome overstates Explorer acceptance.");
        using var embedded = Assembly.GetExecutingAssembly().GetManifestResourceStream("WindowsDownload.Explorer.Tests.OwnedBrandObserver.ps1")
            ?? throw new InvalidOperationException("Embedded observer resource missing.");
        using var reader = new StreamReader(embedded, Encoding.UTF8);
        var script = reader.ReadToEnd();
        if (!script.Contains("FindAll", StringComparison.Ordinal) || !script.Contains("Wait-UniqueTestLabel", StringComparison.Ordinal))
            throw new InvalidOperationException("Observer must reject absent and duplicate test labels.");
        Console.WriteLine("PASS observer completion decision tests; no Explorer window opened."); return 0;
    }
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(IntPtr hwnd);

    internal static bool AdmittedPath(string requested, string canonical, string driveRoot, DriveType driveType, string format) =>
        BasicPath(requested, canonical, driveRoot) && driveType == DriveType.Fixed && string.Equals(format, "NTFS", StringComparison.OrdinalIgnoreCase);

    private static bool BasicPath(string requested, string canonical, string driveRoot) =>
        Path.IsPathFullyQualified(requested) && string.Equals(canonical, requested, StringComparison.OrdinalIgnoreCase) &&
        !canonical.StartsWith(@"\\", StringComparison.Ordinal) &&
        Regex.IsMatch(driveRoot, @"\A[A-Za-z]:\\\z", RegexOptions.CultureInvariant) &&
        Regex.IsMatch(Path.GetFileName(canonical), @"\ALedgeTopHeldBrokerProbe-[a-f0-9]{32}\z", RegexOptions.CultureInvariant);

    internal static bool Matches(CandidateDirectoryFence.DirectoryIdentity before, CandidateDirectoryFence.DirectoryIdentity after,
        NativeRootObservation observed) => before.Volume != 0 && before.FileId != 0 && before == after &&
        observed.Hresult == 0 && observed.ExpectedContextMatches && unchecked((ulong)observed.RootFileId) == before.FileId;

    internal static int DecisionTests()
    {
        var root = new CandidateDirectoryFence.DirectoryIdentity(7, 44);
        var observation = new NativeRootObservation(0, 44, true, true, true, 2, 0, 3, 0, 1023, 0);
        if (!Matches(root, root, observation) || Matches(root, root with { FileId = 45 }, observation) ||
            Matches(root, root with { Volume = 8 }, observation) || Matches(root, root, observation with { ExpectedContextMatches = false }) ||
            Matches(root, root, observation with { RootFileId = 45 }) || Matches(root, root, observation with { Hresult = -1 }) ||
            Matches(new(0, 44), new(0, 44), observation)) throw new InvalidOperationException("Probe decision boundary failed.");
        const string basePath = @"C:\Temp\LedgeTopHeldBrokerProbe-0123456789abcdef0123456789abcdef";
        if (!AdmittedPath(basePath, basePath, @"C:\", DriveType.Fixed, "NTFS") ||
            AdmittedPath(basePath, basePath, @"C:\", DriveType.Network, "NTFS") ||
            AdmittedPath(@"S:\Temp\LedgeTopHeldBrokerProbe-0123456789abcdef0123456789abcdef", @"S:\Temp\LedgeTopHeldBrokerProbe-0123456789abcdef0123456789abcdef", @"S:\", DriveType.Network, "NTFS") ||
            AdmittedPath(basePath, basePath, @"C:\", DriveType.Fixed, "FAT32") ||
            AdmittedPath(@"\\server\share\LedgeTopHeldBrokerProbe-0123456789abcdef0123456789abcdef", @"\\server\share\LedgeTopHeldBrokerProbe-0123456789abcdef0123456789abcdef", @"\\server\share\", DriveType.Network, "NTFS") ||
            AdmittedPath(@"C:\Temp\other", @"C:\Temp\other", @"C:\", DriveType.Fixed, "NTFS"))
            throw new InvalidOperationException("Fixture admission boundary failed.");
        Console.WriteLine("PASS held broker identity decision tests; no registration performed.");
        return 0;
    }

    private static void WriteNew(string path, object value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        stream.Write(bytes); stream.Flush(flushToDisk: true);
    }
    private static CandidateDirectoryFence.DirectoryIdentity Identity(SafeFileHandle handle)
    {
        if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) || (info.Attributes & 0x10) == 0)
            throw new IOException("Held root is unavailable.");
        var id = ((ulong)info.IndexHigh << 32) | info.IndexLow;
        if (info.Volume == 0 || id == 0) throw new IOException("Held root identity is unavailable.");
        return new(info.Volume, id);
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetVolumeInformationW(string root, StringBuilder? volume, uint volumeSize, out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder? fileSystem, uint fileSystemSize);
}
