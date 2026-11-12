using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using LedgeTop.Files.Explorer;

// Explicit native-only compatibility experiment. This must never run as part of default tests.
// A failed or interrupted registration is intentionally retained for manual reconciliation.
internal static class HeldShellBrokerProbe
{
    internal static async Task<int> RunAsync(string artifactBase)
    {
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
        var icon = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shell32.dll") + ",3";
        var unregisterAttempted = false;
        try {
            // The exact owned handle and parent fences stay alive during the broker call.
            registration = await ShellRegistration.RegisterAsync(root, shellId, icon, context);
            var after = Identity(held);
            var observed = NativeRootRegistration.Inspect(root, context);
            if (!Matches(before, after, observed))
                throw new IOException("Registration readback or held root identity differs; registration retained.");
            WriteNew(Path.Combine(fixture, "registered.json"), new { id, volume = after.Volume, fileId = after.FileId,
                observed.RootFileId, observed.ExpectedContextMatches, registration.NamespaceClsid });
            // Unregister only this successful receipt after verifying the held physical root identity again.
            if (Identity(held) != before) throw new IOException("Root identity changed; registration retained.");
            if (registration.NamespaceClsid == Guid.Empty || unchecked((ulong)registration.RootFileId) != before.FileId)
                throw new IOException("Shell receipt identity differs; registration retained.");
            var shellNamespace = registration.NamespaceClsid;
            registration.VerifyOwned();
            unregisterAttempted = true;
            registration.Unregister();
            registration = null;
            var absent = ShellRegistration.Inspect(root, shellId, context, shellNamespace, icon);
            if (!absent.CompleteAbsenceVerified) throw new IOException("Shell registration absence could not be verified.");
            WriteNew(Path.Combine(fixture, "result.json"), new { id, compatible = true, unregisterVerified = true,
                generatedDataOnly = true, productionAccess = false });
            Console.WriteLine(JsonSerializer.Serialize(new { fixture, compatible = true, unregisterVerified = true }));
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
