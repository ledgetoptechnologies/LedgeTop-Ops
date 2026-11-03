using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Ordinary-file feasibility only. This never calls the production cache or a
// Cloud Files provider. Its explicit local artifact root and random directory
// contain only fixed synthetic bytes. Failure retains the fixture.
internal static class ReservationHandlePrototype
{
    private const uint ReadAttributes = 0x80, Delete = 0x10000, GenericRead = 0x80000000;
    private const uint ShareRead = 1, ShareWrite = 2, OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    private const uint DirectoryAttribute = 0x10, ReparseAttribute = 0x400;
    private readonly record struct FileId(ulong Volume, Guid Id);
    private static readonly byte[] Owned = "synthetic-owned-reservation-v1\n"u8.ToArray();
    private static readonly byte[] Foreign = "synthetic-foreign-reservation\n"u8.ToArray();
    private static readonly byte[] Abrupt = "synthetic-abrupt-child-reservation\n"u8.ToArray();

    internal static void Run()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows-only handle comparison.");
        AbsenceEvidenceTests();
        var root = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        if (string.IsNullOrEmpty(root) || !Path.IsPathFullyQualified(root) || root.StartsWith("\\\\", StringComparison.Ordinal))
            throw new IOException("An existing local test artifact root is required.");
        root = Path.GetFullPath(root); CheckAncestors(root);
        using var parent = Open(root, ReadAttributes, ShareRead | ShareWrite, BackupSemantics | OpenReparsePoint);
        RequireKind(parent, isDirectory: true); var parentId = Id(parent); VerifyDirectoryBinding(root, parent, parentId);
        var fixture = Path.Combine(root, "reservation-handle-" + Guid.NewGuid().ToString("N"));
        if (!CreateDirectoryW(fixture, 0)) throw new IOException("Cannot create a new test fixture.");
        var record = Path.Combine(fixture, "owned.record"); var foreign = Path.Combine(fixture, "foreign.record");
        var childRecord = Path.Combine(fixture, "abrupt-child.record");
        var renamed = Path.Combine(fixture, "renamed.record");
        var verified = false; var cleanupComplete = false; var deleteDispositionsApplied = 0;
        try {
            CheckAncestors(fixture);
            using var directory = Open(fixture, ReadAttributes | Delete, ShareRead | ShareWrite, BackupSemantics | OpenReparsePoint);
            RequireKind(directory, isDirectory: true); var directoryId = Id(directory);
            VerifyDirectoryBinding(fixture, directory, directoryId);
            FileId ownerId, foreignId;
            using (var stream = new FileStream(record, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read)) {
                stream.Write(Owned); stream.Flush(true); ownerId = Id(stream.SafeFileHandle);
                RequireKind(stream.SafeFileHandle, isDirectory: false);
                if (!ReadExact(stream, Owned) || Id(stream.SafeFileHandle) != ownerId) throw new IOException("Retained-handle verification failed.");
                using (var other = new FileStream(foreign, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read)) {
                    other.Write(Foreign); other.Flush(true); foreignId = Id(other.SafeFileHandle);
                    if (!ReadExact(other, Foreign) || foreignId == ownerId) throw new IOException("Foreign fixture identity is ambiguous.");
                }
                var readRefused = false;
                try { using var unexpected = new FileStream(record, FileMode.Open, FileAccess.Read, FileShare.Read); }
                catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33) { readRefused = true; }
                if (!readRefused) throw new IOException("Incompatible second open was not refused.");
                var renameRefused = false; try { File.Move(record, renamed); } catch (IOException) { renameRefused = true; } catch (UnauthorizedAccessException) { renameRefused = true; }
                if (!renameRefused || File.Exists(renamed)) throw new IOException("Retained record rename was not refused.");
                var replaceRefused = false; try { File.Move(foreign, record, true); } catch (IOException) { replaceRefused = true; } catch (UnauthorizedAccessException) { replaceRefused = true; }
                if (!replaceRefused || !File.ReadAllBytes(foreign).SequenceEqual(Foreign) || !ReadExact(stream, Owned) || Id(stream.SafeFileHandle) != ownerId)
                    throw new IOException("Retained record replacement was not refused safely.");
            }
            // Simulates handle close only, not a process crash. The subsequent
            // path reopen must resolve to the original identity and exact bytes.
            using (var reopened = new FileStream(record, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                if (Id(reopened.SafeFileHandle) != ownerId || !ReadExact(reopened, Owned)) throw new IOException("Reopened record did not match.");
            }
            var wrongOwned = Owned.ToArray(); wrongOwned[0] ^= 1;
            if (TryDeleteExact(fixture, directory, directoryId, record, wrongOwned, ownerId) || TryDeleteExact(fixture, directory, directoryId, record, Owned, foreignId) ||
                !File.ReadAllBytes(record).SequenceEqual(Owned)) throw new IOException("Foreign identity or contents were accepted.");
            var childId = RunAbruptChild(fixture, directoryId);
            VerifyDirectoryBinding(fixture, directory, directoryId);
            using (var reopened = new FileStream(childRecord, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                RequireKind(reopened.SafeFileHandle, isDirectory: false);
                if (childId == ownerId || childId == foreignId || Id(reopened.SafeFileHandle) != childId || !ReadExact(reopened, Abrupt))
                    throw new IOException("Abrupt child record did not retain its exact identity and bytes.");
            }
            var wrongAbrupt = Abrupt.ToArray(); wrongAbrupt[0] ^= 1;
            if (TryDeleteExact(fixture, directory, directoryId, childRecord, wrongAbrupt, childId) ||
                TryDeleteExact(fixture, directory, directoryId, childRecord, Abrupt, ownerId))
                throw new IOException("Foreign abrupt-child cleanup evidence was accepted.");
            VerifyDirectoryBinding(fixture, directory, directoryId);
            verified = true;
            // Delete each exact owned file only through the verified file handle.
            if (!TryDeleteExact(fixture, directory, directoryId, record, Owned, ownerId)) throw new IOException("Exact synthetic file cleanup was not verified.");
            deleteDispositionsApplied++;
            if (!TryDeleteExact(fixture, directory, directoryId, foreign, Foreign, foreignId)) throw new IOException("Exact synthetic file cleanup was not verified.");
            deleteDispositionsApplied++;
            if (!TryDeleteExact(fixture, directory, directoryId, childRecord, Abrupt, childId)) throw new IOException("Exact synthetic child record cleanup was not verified.");
            deleteDispositionsApplied++;
            VerifyDirectoryBinding(fixture, directory, directoryId);
            if (Directory.EnumerateFileSystemEntries(fixture).Any() || Id(directory) != directoryId)
                throw new IOException("Synthetic fixture is not empty or its identity changed.");
            byte disposition = 1;
            if (!SetFileInformationByHandle(directory, 4, ref disposition, 1)) throw new IOException("Synthetic directory cleanup was not confirmed.");
            deleteDispositionsApplied++;
            directory.Dispose();
            if (!ConfirmedAbsent(() => File.GetAttributes(fixture), () => VerifyDirectoryBinding(root, parent, parentId)))
                throw new IOException("Synthetic directory absence and parent identity were not confirmed.");
            cleanupComplete = true;
        } finally {
            if (!cleanupComplete) Console.Error.WriteLine($"Synthetic fixture cleanup unconfirmed; partial cleanup may have occurred (checksPassed={verified}; deleteDispositionsApplied={deleteDispositionsApplied}): {fixture}");
        }
        Console.WriteLine("PASS ordinary Windows retained-handle identity, sharing, abrupt child termination/reopen and exact handle-bound cleanup. No native provider or OS crash tested.");
    }

    internal static void RunChild(string fixture, string volumeText, string idText)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var root = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        if (string.IsNullOrEmpty(root) || !Path.IsPathFullyQualified(root) || root.StartsWith("\\\\", StringComparison.Ordinal) ||
            !Path.IsPathFullyQualified(fixture) || fixture.StartsWith("\\\\", StringComparison.Ordinal) ||
            !ulong.TryParse(volumeText, System.Globalization.NumberStyles.AllowHexSpecifier, System.Globalization.CultureInfo.InvariantCulture, out var volume) ||
            volumeText.Length != 16 || !Guid.TryParseExact(idText, "N", out var id) || idText != id.ToString("N"))
            throw new IOException("Invalid synthetic child scope.");
        root = Path.GetFullPath(root); fixture = Path.GetFullPath(fixture);
        var name = Path.GetFileName(fixture); const string prefix = "reservation-handle-";
        if (!string.Equals(Path.GetDirectoryName(fixture), root, StringComparison.OrdinalIgnoreCase) || !name.StartsWith(prefix, StringComparison.Ordinal) ||
            !Guid.TryParseExact(name[prefix.Length..], "N", out var fixtureId) || name != prefix + fixtureId.ToString("N"))
            throw new IOException("Synthetic child fixture is outside its explicit root.");
        CheckAncestors(fixture);
        using var directory = Open(fixture, ReadAttributes, ShareRead | ShareWrite | 4, BackupSemantics | OpenReparsePoint);
        RequireKind(directory, isDirectory: true);
        if (Id(directory) != new FileId(volume, id)) throw new IOException("Synthetic child directory identity changed.");
        using var record = new FileStream(Path.Combine(fixture, "abrupt-child.record"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
        record.Write(Abrupt); record.Flush(true); RequireKind(record.SafeFileHandle, isDirectory: false);
        if (!ReadExact(record, Abrupt)) throw new IOException("Synthetic child record did not flush.");
        var recordId = Id(record.SafeFileHandle);
        Console.WriteLine($"READY {recordId.Volume:X16} {recordId.Id:N}"); Console.Out.Flush();
        Thread.Sleep(Timeout.Infinite);
        throw new IOException("Synthetic child was not terminated by its owner.");
    }

    private static FileId RunAbruptChild(string fixture, FileId directoryId)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("Test executable path unavailable.");
        var start = new System.Diagnostics.ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase)) {
            var assembly = System.Reflection.Assembly.GetExecutingAssembly().Location;
            if (string.IsNullOrEmpty(assembly)) throw new IOException("Test assembly path unavailable.");
            start.ArgumentList.Add(assembly);
        }
        start.ArgumentList.Add("--reservation-handle-prototype-child"); start.ArgumentList.Add(fixture);
        start.ArgumentList.Add(directoryId.Volume.ToString("X16", System.Globalization.CultureInfo.InvariantCulture)); start.ArgumentList.Add(directoryId.Id.ToString("N"));
        using var child = System.Diagnostics.Process.Start(start) ?? throw new IOException("Synthetic child did not start.");
        var stdout = child.StandardOutput.ReadLineAsync(); var stderr = child.StandardError.ReadToEndAsync();
        try {
            var line = stdout.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
            var parts = line?.Split(' ', StringSplitOptions.None);
            if (parts is not { Length: 3 } || parts[0] != "READY" || parts[1].Length != 16 ||
                !ulong.TryParse(parts[1], System.Globalization.NumberStyles.AllowHexSpecifier, System.Globalization.CultureInfo.InvariantCulture, out var volume) ||
                !Guid.TryParseExact(parts[2], "N", out var id) || parts[2] != id.ToString("N") || id == Guid.Empty)
                throw new IOException("Synthetic child readiness evidence was invalid.");
            if (child.HasExited) throw new IOException("Synthetic child exited before controlled termination.");
            child.Kill();
            if (!child.WaitForExit(10_000) || child.ExitCode == 0) throw new IOException("Synthetic child termination was not verified.");
            if (!stderr.Wait(TimeSpan.FromSeconds(3))) throw new IOException("Synthetic child output did not drain.");
            return new FileId(volume, id);
        } finally {
            try {
                if (!child.HasExited) child.Kill();
                if (!child.WaitForExit(10_000)) Console.Error.WriteLine($"Synthetic owned child exit unconfirmed; process ID {child.Id}.");
                _ = stdout.Wait(TimeSpan.FromSeconds(3)); _ = stderr.Wait(TimeSpan.FromSeconds(3));
            } catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or AggregateException) {
                Console.Error.WriteLine("Synthetic owned child cleanup could not be confirmed.");
            }
        }
    }

    private static bool ConfirmedAbsent(Func<FileAttributes> inspect, Action verifyParent)
    {
        try { verifyParent(); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException) { return false; }
        try { _ = inspect(); return false; }
        catch (FileNotFoundException) {
            try { verifyParent(); return true; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException) { return false; }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException) { return false; }
    }
    private static void AbsenceEvidenceTests()
    {
        var calls = 0;
        if (!ConfirmedAbsent(() => throw new FileNotFoundException(), () => calls++) || calls != 2 ||
            ConfirmedAbsent(() => throw new DirectoryNotFoundException(), () => { }) ||
            ConfirmedAbsent(() => throw new UnauthorizedAccessException(), () => { }) ||
            ConfirmedAbsent(() => FileAttributes.Directory, () => { }) ||
            ConfirmedAbsent(() => throw new FileNotFoundException(), () => throw new DirectoryNotFoundException()))
            throw new IOException("Synthetic absence evidence classification failed.");
        calls = 0;
        if (ConfirmedAbsent(() => throw new FileNotFoundException(), () => { if (++calls == 2) throw new IOException("Parent changed."); }))
            throw new IOException("Synthetic absence accepted after parent changed.");
    }

    private static bool ReadExact(FileStream stream, byte[] expected)
    {
        if (stream.Length != expected.Length) return false;
        var bytes = new byte[expected.Length]; var read = RandomAccess.Read(stream.SafeFileHandle, bytes, 0);
        return read == bytes.Length && bytes.AsSpan().SequenceEqual(expected);
    }
    private static bool TryDeleteExact(string fixture, SafeFileHandle directory, FileId directoryId, string path, byte[] expected, FileId identity)
    {
        try {
            if (!string.Equals(Path.GetDirectoryName(path), fixture, StringComparison.OrdinalIgnoreCase)) return false;
            VerifyDirectoryBinding(fixture, directory, directoryId);
            using var handle = Open(path, GenericRead | Delete, ShareRead, OpenReparsePoint);
            RequireKind(handle, isDirectory: false);
            if (Id(handle) != identity) return false;
            using var input = new FileStream(handle, FileAccess.Read);
            if (!ReadExact(input, expected)) return false;
            VerifyDirectoryBinding(fixture, directory, directoryId);
            byte disposition = 1;
            return SetFileInformationByHandle(handle, 4, ref disposition, 1);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException) { return false; }
    }
    private static void VerifyDirectoryBinding(string path, SafeFileHandle held, FileId expected)
    {
        CheckAncestors(path);
        // The held directory has DELETE access; the observation handle must
        // permit sharing that existing access. The held handle denies anyone
        // else opening this directory for deletion while the test is running.
        using var current = Open(path, ReadAttributes, ShareRead | ShareWrite | 4, BackupSemantics | OpenReparsePoint);
        RequireKind(current, isDirectory: true);
        if (Id(held) != expected || Id(current) != expected) throw new IOException("Synthetic directory binding changed.");
    }
    private static void CheckAncestors(string path)
    {
        for (string? current = path; current is not null; current = Path.GetDirectoryName(current)) {
            var attributes = File.GetAttributes(current);
            if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0)
                throw new IOException("Synthetic path has an unsafe ancestor.");
        }
    }
    private static SafeFileHandle Open(string path, uint access, uint share, uint flags)
    {
        var handle = CreateFileW(path, access, share, 0, OpenExisting, flags, 0);
        if (!handle.IsInvalid) return handle;
        handle.Dispose(); throw new IOException("Synthetic handle open failed.");
    }
    private static void RequireKind(SafeFileHandle handle, bool isDirectory)
    {
        var memory = Marshal.AllocHGlobal(8);
        try {
            if (!GetFileInformationByHandleEx(handle, 9, memory, 8)) throw new IOException("Synthetic handle attributes unavailable.");
            var attributes = unchecked((uint)Marshal.ReadInt32(memory));
            if ((attributes & ReparseAttribute) != 0 || ((attributes & DirectoryAttribute) != 0) != isDirectory)
                throw new IOException("Synthetic handle type is unsafe.");
        } finally { Marshal.FreeHGlobal(memory); }
    }
    private static FileId Id(SafeFileHandle handle)
    {
        var memory = Marshal.AllocHGlobal(24);
        try {
            if (!GetFileInformationByHandleEx(handle, 18, memory, 24)) throw new IOException("Synthetic file identity unavailable.");
            var volume = unchecked((ulong)Marshal.ReadInt64(memory)); var idBytes = new byte[16]; Marshal.Copy(memory + 8, idBytes, 0, 16);
            var id = new Guid(idBytes); if (id == Guid.Empty) throw new IOException("Synthetic file identity is empty.");
            return new(volume, id);
        } finally { Marshal.FreeHGlobal(memory); }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(string path, nint securityAttributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, nint information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref byte information, uint size);
}
