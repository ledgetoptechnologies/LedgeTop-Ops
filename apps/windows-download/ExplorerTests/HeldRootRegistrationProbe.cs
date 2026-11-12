using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using LedgeTop.Files.Explorer;

// Explicit native-only compatibility experiment. This must never run as part of default tests.
// A failed or interrupted registration is intentionally retained for manual reconciliation.
internal static class HeldRootRegistrationProbe
{
    internal static int Run(string artifactBase)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var canonicalBase = Path.GetFullPath(artifactBase);
        if (!Path.IsPathFullyQualified(artifactBase) || !string.Equals(canonicalBase, artifactBase, StringComparison.OrdinalIgnoreCase) ||
            canonicalBase.StartsWith(@"\\", StringComparison.Ordinal) || !Directory.Exists(canonicalBase))
            throw new IOException("A canonical existing local fixture base is required.");
        var id = Guid.NewGuid();
        var fixture = Path.Combine(canonicalBase, "held-root-" + id.ToString("N"));
        var root = Path.Combine(fixture, "Files");
        var context = Encoding.UTF8.GetBytes("LedgeTop.Files.HeldRootProbe.v1:" + id.ToString("N"));
        using var directories = new CandidateDirectoryFence();
        directories.HoldAncestors(canonicalBase);
        directories.CreateExclusiveDirectory(fixture);
        var created = directories.CreateExclusiveDirectory(root);
        using var held = CreateFileW(root, 0x80, 3, 0, 3, 0x02200000, 0); // READ_ATTRIBUTES, no delete sharing, open reparse point.
        var before = Identity(held);
        if (before != created) throw new IOException("Held root identity differs from the exclusively created root.");
        WriteNew(Path.Combine(fixture, "intent.json"), new { id, root, volume = before.Volume, fileId = before.FileId,
            context = Convert.ToBase64String(context), generatedDataOnly = true, productionAccess = false });
        Console.WriteLine(JsonSerializer.Serialize(new { fixture, phase = "intent-persisted" }));
        NativeRootRegistration? registration = null;
        var unregisterAttempted = false;
        try {
            // The exact owned handle and parent fences stay alive during the broker call.
            registration = NativeRootRegistration.Register(root, context);
            var after = Identity(held);
            var observed = NativeRootRegistration.Inspect(root, context);
            if (!Matches(before, after, observed))
                throw new IOException("Registration readback or held root identity differs; registration retained.");
            WriteNew(Path.Combine(fixture, "registered.json"), new { id, volume = after.Volume, fileId = after.FileId,
                observed.RootFileId, observed.ExpectedContextMatches });
            // Unregister only this successful receipt after verifying the held physical root identity again.
            if (Identity(held) != before) throw new IOException("Root identity changed; registration retained.");
            registration.VerifyOwned();
            unregisterAttempted = true;
            registration.Unregister();
            registration = null;
            var absent = NativeRootRegistration.Inspect(root, context);
            if (absent.Hresult != unchecked((int)0x80070186)) throw new IOException("Registration absence could not be verified.");
            WriteNew(Path.Combine(fixture, "result.json"), new { id, compatible = true, unregisterVerified = true,
                generatedDataOnly = true, productionAccess = false });
            Console.WriteLine(JsonSerializer.Serialize(new { fixture, compatible = true, unregisterVerified = true }));
            return 0;
        } catch (Exception error) {
            // A thrown Register can follow a successful OS mutation. Never infer absence or retry.
            try { WriteNew(Path.Combine(fixture, "uncertain.json"), new { id, phase = registration is null ? "registration-or-readback" : "post-registration",
                error = error.GetType().Name, unregisterAttempted }); } catch { }
            Console.Error.WriteLine("Held-root probe did not finish; retain fixture and reconcile its exact recorded identity.");
            Console.Error.WriteLine(error.GetType().Name);
            return 1;
        }
    }

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
        Console.WriteLine("PASS held-root identity decision tests; no registration performed.");
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
}
