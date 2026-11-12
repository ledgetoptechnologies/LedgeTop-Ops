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
        if (observeBrand) throw new IOException("Branded observer is held pending independent review and VM validation.");
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
        var displayName = observeBrand ? ExplorerRootDisplayName.ForConnectedAlias("employee") : ShellRegistration.DisplayName;
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
                await ObserveBrandAsync(root, fixture, before);
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
                error = error.GetType().Name, unregisterAttempted }); } catch { }
            Console.Error.WriteLine("Held broker probe did not finish; retain fixture and reconcile its exact recorded identity.");
            Console.Error.WriteLine(error.GetType().Name);
            return 1;
        }
    }

    private sealed record BrokerOutcome(Guid id, string fixture, bool brokerCompatible, bool unregisterVerified,
        bool navigationVerified, bool brandingVerified, bool generatedDataOnly, bool productionAccess);
    private static BrokerOutcome BrokerOutcomeFor(Guid id, string fixture) => new(id, fixture, true, true, false, false, true, false);

    internal sealed record ObserverResult(long Hwnd, uint Pid, long StartTicks, uint Volume, ulong FileId, bool Closed, string Screenshot, bool LabelObserved);
    private static readonly JsonSerializerOptions observerJson = new() { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    internal static bool ValidObserverResult(ObserverResult? result, CandidateDirectoryFence.DirectoryIdentity expected, string screenshot) =>
        result is { Hwnd: > 0, Pid: > 0, StartTicks: > 0, Closed: true, LabelObserved: false } &&
        result.Volume == expected.Volume && result.FileId == expected.FileId &&
        string.Equals(result.Screenshot, screenshot, StringComparison.OrdinalIgnoreCase);

    private static async Task ObserveBrandAsync(string root, string fixture, CandidateDirectoryFence.DirectoryIdentity expected)
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
        foreach (var value in new[] { "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", script, "-Root", root, "-Volume", expected.Volume.ToString(System.Globalization.CultureInfo.InvariantCulture), "-FileId", expected.FileId.ToString(System.Globalization.CultureInfo.InvariantCulture), "-Fixture", fixture }) start.ArgumentList.Add(value);
        using var process = Process.Start(start) ?? throw new IOException("Observer process could not start.");
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(60)); }
        catch (TimeoutException) {
            // Never unregister on timeout. Terminate only the directly created observer; its Explorer window may persist.
            try {
                if (!process.HasExited) process.Kill();
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                if (!process.HasExited) throw new IOException("Observer exit was not confirmed.");
            } catch (Exception error) {
                throw new IOException("Observer timed out and child exit is unconfirmed; registration retained for review.", error);
            }
            throw new IOException("Observer timed out; child exited but registration is retained for review.");
        }
        var outputText = await stdout; _ = await stderr;
        if (process.ExitCode != 0 || outputText.Length > 8192) throw new IOException("Observer did not confirm window closure.");
        var result = JsonSerializer.Deserialize<ObserverResult>(outputText, observerJson);
        var screenshot = Path.Combine(fixture, "observer-window.png");
        if (!ValidObserverResult(result, expected, screenshot) || IsWindow(new IntPtr(result!.Hwnd))) throw new IOException("Observer result or window absence could not be verified.");
        var info = new System.IO.FileInfo(screenshot);
        if (!info.Exists || info.Length is < 1 or > 100000000) throw new IOException("Observer screenshot is unavailable.");
        WriteNew(Path.Combine(fixture, "observer-result.json"), new { result.Hwnd, result.Pid, result.StartTicks, result.Volume, result.FileId,
            result.Closed, navigationVerified = false, brandingVerified = false, screenshot = result.Screenshot, visualReviewRequired = true });
    }
    internal static int ObserverResultTests()
    {
        var root = new CandidateDirectoryFence.DirectoryIdentity(7, 44); const string shot = @"C:\synthetic\observer-window.png";
        var good = new ObserverResult(23, 24, 25, 7, 44, true, shot, false);
        if (!ValidObserverResult(good, root, shot) || ValidObserverResult(good with { Closed = false }, root, shot) ||
            ValidObserverResult(good with { FileId = 45 }, root, shot) || ValidObserverResult(good with { Screenshot = @"C:\other.png" }, root, shot) ||
            ValidObserverResult(good with { Pid = 0 }, root, shot) ||
            // A matching label on another (or duplicate) node is unbound; do not accept a claim that it identifies this root.
            ValidObserverResult(good with { LabelObserved = true }, root, shot))
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
        // A duplicate label on an unrelated node must never be promoted to test-root navigation evidence.
        // Until namespace-bound observation exists, the child must not search for any label or claim it observed one.
        if (script.Contains("FindFirst", StringComparison.Ordinal) || !script.Contains("LabelObserved=$false", StringComparison.Ordinal))
            throw new InvalidOperationException("Unbound navigation label could be claimed.");
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
