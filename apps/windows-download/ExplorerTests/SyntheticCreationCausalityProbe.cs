using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using LedgeTop.Files.Explorer;

// Explicit, synthetic-only native probe. NOT a production adapter or a proof that
// CfCreatePlaceholders returns a retained handle. Never recursively deletes anything.
internal static class SyntheticCreationCausalityProbe
{
    private static string Fixture(Guid id) => Path.Combine(Path.GetFullPath(Path.GetTempPath()), "LedgeTop-CF-Probe-" + id.ToString("N"));
    private static byte[] Context(Guid id) => Encoding.UTF8.GetBytes("LedgeTop.Files.CreationProbe.v1:" + id.ToString("N"));

    internal static async Task<int> RunAsync()
    {
        if (!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
            throw new PlatformNotSupportedException("Synthetic creation probe requires Windows x64.");
        var id = Guid.NewGuid(); var fixture = Fixture(id); var root = Path.Combine(fixture, "root");
        var phases = new List<string>(); string? error = null; var removed = false; var safe = false;
        NativeRootRegistration? registration = null; Process? child = null;
        using var fence = new CandidateDirectoryFence();
        var temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        fence.HoldAncestors(temp); var fixtureId = fence.CreateExclusiveDirectory(fixture);
        var rootId = fence.CreateExclusiveDirectory(root);
        // This receipt exists before CfRegisterSyncRoot, including if registration succeeds
        // but its readback or the process fails. Reconciliation must use exact root/context.
        var owner = Path.Combine(fixture, "owner.json");
        using (var stream = new FileStream(owner, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough)) {
            JsonSerializer.Serialize(stream, new { id, fixture, root, fixtureId, rootId, context = Convert.ToHexString(Context(id)) }); stream.Flush(true);
        }
        try {
            registration = NativeRootRegistration.Register(root, Context(id)); registration.VerifyOwned();
            if (ObservePath(root) != new FileIdentity(rootId.Volume, rootId.FileId)) throw new IOException("Registered root identity changed.");
            phases.Add("native root registered and exact ownership verified");
            var sentinel = Path.Combine(root, "ordinary-collision.bin"); var sentinelBytes = Encoding.UTF8.GetBytes("synthetic sentinel");
            using (var file = new FileStream(sentinel, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.Write(sentinelBytes); file.Flush(true); }
            var sentinelId = ObservePath(sentinel); var sentinelAttributes = File.GetAttributes(sentinel); var sentinelWriteTime = File.GetLastWriteTimeUtc(sentinel);
            var ordinaryCollision = Create(root, "ordinary-collision.bin", Encoding.UTF8.GetBytes("synthetic-collision"));
            if (ordinaryCollision.Success || ObservePath(sentinel) != sentinelId || File.GetAttributes(sentinel) != sentinelAttributes ||
                File.GetLastWriteTimeUtc(sentinel) != sentinelWriteTime || !File.ReadAllBytes(sentinel).AsSpan().SequenceEqual(sentinelBytes))
                throw new IOException("Ordinary collision was overwritten or unexpectedly accepted.");
            phases.Add("ordinary existing file collision refused and exact bytes/id preserved");
            var placeholderIdentity = Encoding.UTF8.GetBytes("synthetic-create-" + id.ToString("N"));
            var created = Create(root, "created.bin", placeholderIdentity);
            if (!created.Success) throw new IOException("Synthetic CfCreatePlaceholders did not report successful creation.");
            var createdPath = Path.Combine(root, "created.bin");
            PlaceholderObservation first;
            using (var handle = OpenAttributes(createdPath)) first = ObservePlaceholder(handle, placeholderIdentity);
            if (first.Volume != rootId.Volume || (ulong)first.RootFileId != rootId.FileId) throw new IOException("Created placeholder belongs to a different root.");
            var existingCollision = Create(root, "created.bin", Encoding.UTF8.GetBytes("different-synthetic-identity"));
            using (var handle = OpenAttributes(createdPath)) {
                var after = ObservePlaceholder(handle, placeholderIdentity);
                if (existingCollision.Success || after.FileId != first.FileId || after.Volume != first.Volume)
                    throw new IOException("Existing placeholder collision was overwritten or unexpectedly accepted.");
            }
            phases.Add("existing placeholder collision refused and exact identity/id preserved");

            // CreateUsn and opened-handle USN are observations only: equality is not
            // asserted to prove causal identity or absence of a substitution race.
            phases.Add($"create result=0x{created.Result:X8}; entry=0x{created.EntryResult:X8}; processed={created.Processed}; createUsn={created.CreateUsn}; openedUsn={first.Usn}");
            var convertPath = Path.Combine(root, "convert.bin"); FileIdentity beforeConvert; PlaceholderObservation converted;
            var convertIdentity = Encoding.UTF8.GetBytes("synthetic-convert-" + id.ToString("N"));
            using (var stream = new FileStream(convertPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.WriteThrough)) {
                stream.SetLength(4096); stream.Flush(true); beforeConvert = Identify(stream.SafeFileHandle);
                var result = Native.CfConvertToPlaceholder(stream.SafeFileHandle, convertIdentity, (uint)convertIdentity.Length, 3, out var convertUsn, IntPtr.Zero);
                if (result < 0) throw new IOException($"Synthetic handle conversion failed: 0x{result:X8}.");
                converted = ObservePlaceholder(stream.SafeFileHandle, convertIdentity);
                if (converted.Volume != beforeConvert.Volume || converted.FileId != beforeConvert.FileId || (ulong)converted.RootFileId != rootId.FileId)
                    throw new IOException("Conversion changed the held file identity.");
                phases.Add($"exclusive same-handle conversion; convertUsn={convertUsn}; openedUsn={converted.Usn}");
            }
            using (var handle = OpenAttributes(convertPath)) {
                var reopened = ObservePlaceholder(handle, convertIdentity);
                if (reopened.Volume != converted.Volume || reopened.FileId != converted.FileId) throw new IOException("Converted placeholder changed after handle close.");
            }

            // A separate child holds an ordinary synthetic file exclusively. Killing only
            // that exact child models termination before conversion; it does not model OS crash.
            var exe = Environment.ProcessPath ?? throw new IOException("Test executable path unavailable.");
            var start = new ProcessStartInfo(exe) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                start.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
            using var parent = Process.GetCurrentProcess();
            start.ArgumentList.Add("--synthetic-creation-child"); start.ArgumentList.Add(id.ToString("N"));
            start.ArgumentList.Add(parent.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
            start.ArgumentList.Add(parent.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture));
            child = Process.Start(start) ?? throw new IOException("Synthetic child did not start.");
            var line = await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            var parts = line?.Split(':');
            if (parts is not ["READY", _, _] || !uint.TryParse(parts[1], out var childVolume) || !ulong.TryParse(parts[2], out var childId))
                throw new IOException("Synthetic child did not report its held file identity.");
            child.Kill(entireProcessTree: true); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            var crashPath = Path.Combine(root, "crash-window.bin"); var crashId = ObservePath(crashPath);
            if (crashId.Volume != childVolume || crashId.FileId != childId || (File.GetAttributes(crashPath) & FileAttributes.ReparsePoint) != 0 || new FileInfo(crashPath).Length != 4096)
                throw new IOException("Ordinary file after child termination differs from the held synthetic file.");
            phases.Add("terminated child left its same ordinary synthetic file visible before conversion");
            // No data deletion. Recheck every expected identity before unregistering only
            // this exact synthetic registration. Unknown/failed observations retain the root.
            registration.VerifyOwned();
            using (var handle = OpenAttributes(createdPath)) {
                var current = ObservePlaceholder(handle, placeholderIdentity);
                if (current.Volume != first.Volume || current.FileId != first.FileId || current.RootFileId != first.RootFileId)
                    throw new IOException("Created placeholder identity changed before unregister.");
            }
            using (var handle = OpenAttributes(convertPath)) {
                var current = ObservePlaceholder(handle, convertIdentity);
                if (current.Volume != converted.Volume || current.FileId != converted.FileId || current.RootFileId != converted.RootFileId)
                    throw new IOException("Converted placeholder identity changed before unregister.");
            }
            if (ObservePath(root) != new FileIdentity(rootId.Volume, rootId.FileId) || ObservePath(sentinel) != sentinelId || ObservePath(createdPath) != new FileIdentity(first.Volume, first.FileId) ||
                ObservePath(convertPath) != beforeConvert || ObservePath(crashPath) != crashId || !File.ReadAllBytes(sentinel).AsSpan().SequenceEqual(sentinelBytes))
                throw new IOException("Synthetic file identity changed before unregister.");
            safe = true;
        } catch (Exception exception) { error = exception.GetType().Name + ": " + exception.Message; }
        finally {
            if (child is not null) {
                try { if (!child.HasExited) { child.Kill(entireProcessTree: true); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20)); } }
                catch { safe = false; }
                child.Dispose();
            }
            if (safe && registration is not null) {
                try { registration.VerifyOwned(); registration.Unregister(); removed = true; }
                catch (Exception exception) { error ??= "Unregister: " + exception.GetType().Name + ": " + exception.Message; }
            }
            var receipt = Path.Combine(fixture, "receipt.json");
            using var stream = new FileStream(receipt, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
            JsonSerializer.Serialize(stream, new { id, root, generatedDataOnly = true, productionAccess = false, phases, removed, error, retainedFiles = true }); stream.Flush(true);
        }
        Console.WriteLine(JsonSerializer.Serialize(new { id, fixture, removed, error, phases }));
        return removed && error is null ? 0 : 1;
    }

    internal static async Task<int> ChildAsync(string value, string parentValue, string startValue)
    {
        StartChildWatchdog(); // Starts before any potentially blocking native/filesystem work.
        if (!Guid.TryParseExact(value, "N", out var id) || !int.TryParse(parentValue, out var parentId) || !long.TryParse(startValue, out var parentStart))
            throw new IOException("Invalid synthetic child identity.");
        using var parent = Process.GetProcessById(parentId);
        if (parent.HasExited || parent.StartTime.ToUniversalTime().Ticks != parentStart) throw new IOException("Synthetic parent identity differs.");
        var fixture = Fixture(id); var root = Path.Combine(fixture, "root"); var owner = Path.Combine(fixture, "owner.json");
        using var doc = JsonDocument.Parse(File.ReadAllBytes(owner));
        if (doc.RootElement.GetProperty("id").GetGuid() != id || doc.RootElement.GetProperty("root").GetString() != root)
            throw new IOException("Synthetic child ownership receipt differs.");
        var registration = NativeRootRegistration.OpenOwned(root, Context(id)); registration.VerifyOwned();
        var savedRoot = doc.RootElement.GetProperty("rootId");
        if (ObservePath(root) != new FileIdentity(savedRoot.GetProperty("Volume").GetUInt32(), savedRoot.GetProperty("FileId").GetUInt64()))
            throw new IOException("Synthetic child root identity differs.");
        using var file = new FileStream(Path.Combine(root, "crash-window.bin"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.WriteThrough);
        file.SetLength(4096); file.Flush(true); var identity = Identify(file.SafeFileHandle);
        Console.WriteLine($"READY:{identity.Volume}:{identity.FileId}"); await Console.Out.FlushAsync();
        // Parent death or a hard deadline releases the share-none handle even if
        // the parent crashes before its normal tracked-child cleanup.
        await AwaitParentOrTimeoutAsync(parent.WaitForExitAsync(), TimeSpan.FromSeconds(30)); return 0;
    }

    internal static async Task<bool> AwaitParentOrTimeoutAsync(Task parentExit, TimeSpan deadline)
    {
        if (deadline <= TimeSpan.Zero || deadline > TimeSpan.FromSeconds(30)) throw new ArgumentOutOfRangeException(nameof(deadline));
        return await Task.WhenAny(parentExit, Task.Delay(deadline)) == parentExit;
    }

    private static void StartChildWatchdog()
    {
        var thread = new Thread(() => { Thread.Sleep(TimeSpan.FromSeconds(30)); Environment.Exit(124); }) { IsBackground = true, Name = "SyntheticProbeDeadline" };
        thread.Start();
    }

    private static ProcessStartInfo StartSelf(params string[] arguments)
    {
        var exe = Environment.ProcessPath ?? throw new IOException("Test executable path unavailable.");
        var start = new ProcessStartInfo(exe) { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
        if (Path.GetFileNameWithoutExtension(exe).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
            start.ArgumentList.Add(System.Reflection.Assembly.GetExecutingAssembly().Location);
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        return start;
    }

    internal static async Task<int> LifetimeParentAsync()
    {
        StartChildWatchdog(); using var self = Process.GetCurrentProcess();
        using var child = Process.Start(StartSelf("--synthetic-lifetime-child", self.Id.ToString(), self.StartTime.ToUniversalTime().Ticks.ToString())) ?? throw new IOException("Lifetime child did not start.");
        if (await child.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)) != "WATCHING") throw new IOException("Lifetime child did not start watching.");
        Console.WriteLine($"READY:{child.Id}:{child.StartTime.ToUniversalTime().Ticks}"); await Console.Out.FlushAsync();
        await Task.Delay(TimeSpan.FromSeconds(30)); return 0;
    }

    internal static async Task<int> LifetimeChildAsync(string parentValue, string startValue)
    {
        StartChildWatchdog();
        if (!int.TryParse(parentValue, out var parentId) || !long.TryParse(startValue, out var parentStart)) return 1;
        using var parent = Process.GetProcessById(parentId);
        if (parent.HasExited || parent.StartTime.ToUniversalTime().Ticks != parentStart) return 1;
        Console.WriteLine("WATCHING"); await Console.Out.FlushAsync();
        return await AwaitParentOrTimeoutAsync(parent.WaitForExitAsync(), TimeSpan.FromSeconds(25)) ? 0 : 2;
    }

    internal static async Task<int> LifetimeTestsAsync()
    {
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var waiting = AwaitParentOrTimeoutAsync(exited.Task, TimeSpan.FromSeconds(2));
        exited.SetResult(); if (!await waiting.WaitAsync(TimeSpan.FromSeconds(1))) throw new IOException("Parent completion was missed.");
        if (await AwaitParentOrTimeoutAsync(new TaskCompletionSource().Task, TimeSpan.FromMilliseconds(20)).WaitAsync(TimeSpan.FromSeconds(1))) throw new IOException("Deadline was missed.");
        using var parent = Process.Start(StartSelf("--synthetic-lifetime-parent")) ?? throw new IOException("Lifetime parent did not start.");
        Process? child = null;
        try {
            var line = await parent.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15)); var parts = line?.Split(':');
            if (parts is not ["READY", _, _] || !int.TryParse(parts[1], out var childId) || !long.TryParse(parts[2], out var childStart)) throw new IOException("Lifetime parent did not report child identity.");
            child = Process.GetProcessById(childId);
            if (child.StartTime.ToUniversalTime().Ticks != childStart) throw new IOException("Lifetime child identity changed.");
            parent.Kill(entireProcessTree: false); await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            if (child.ExitCode != 0) throw new IOException("Lifetime child did not observe parent exit.");
        } finally {
            if (!parent.HasExited) { parent.Kill(entireProcessTree: false); await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
            if (child is not null) { if (!child.HasExited) { child.Kill(entireProcessTree: false); await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); } child.Dispose(); }
        }
        Console.WriteLine("PASS synthetic child parent-exit/deadline coordination and OS parent termination; no filesystem/native operations."); return 0;
    }

    private readonly record struct FileIdentity(uint Volume, ulong FileId);
    private readonly record struct PlaceholderObservation(uint Volume, ulong FileId, long RootFileId, long Usn);
    private readonly record struct CreateResult(int Result, int EntryResult, uint Processed, long CreateUsn) { internal bool Success => Result >= 0 && EntryResult >= 0 && Processed == 1; }
    private static FileIdentity ObservePath(string path) { using var handle = OpenAttributes(path); return Identify(handle); }
    private static FileIdentity Identify(SafeFileHandle handle)
    {
        if (handle.IsInvalid || !Native.GetFileInformationByHandle(handle, out var info) || info.Volume == 0 || info.Links != 1)
            throw new IOException("Synthetic file identity unavailable or aliased.");
        var id = ((ulong)info.IndexHigh << 32) | info.IndexLow; if (id == 0) throw new IOException("Synthetic file ID is unavailable.");
        return new(info.Volume, id);
    }
    private static SafeFileHandle OpenAttributes(string path)
    {
        var handle = Native.CreateFileW(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Synthetic file could not be opened without following reparse points."); }
        return handle;
    }
    private static PlaceholderObservation ObservePlaceholder(SafeFileHandle handle, byte[] identity)
    {
        var file = Identify(handle); var info = new byte[32 + 4096];
        var result = Native.CfGetPlaceholderInfo(handle, 0, info, (uint)info.Length, out var size);
        if (result < 0 || size < 28 || size > info.Length || BitConverter.ToInt64(info, 8) != (long)file.FileId ||
            BitConverter.ToInt64(info, 16) == 0 || BitConverter.ToUInt32(info, 24) != identity.Length ||
            28 + identity.Length > size || !info.AsSpan(28, identity.Length).SequenceEqual(identity))
            throw new IOException("Synthetic placeholder identity readback failed.");
        var usnBytes = new byte[4096];
        var ok = Native.DeviceIoControl(handle, 0x000900eb, IntPtr.Zero, 0, usnBytes, (uint)usnBytes.Length, out var returned, IntPtr.Zero);
        var usn = ok && returned >= 32 && BitConverter.ToUInt16(usnBytes, 4) == 2 ? BitConverter.ToInt64(usnBytes, 24) : -1;
        return new(file.Volume, file.FileId, BitConverter.ToInt64(info, 16), usn);
    }
    private static CreateResult Create(string root, string name, byte[] identity)
    {
        var filename = Marshal.StringToHGlobalUni(name); var opaque = Marshal.AllocHGlobal(identity.Length);
        try {
            Marshal.Copy(identity, 0, opaque, identity.Length); var now = DateTime.UtcNow.ToFileTimeUtc();
            var entry = new PlaceholderCreate { RelativeName = filename, Metadata = new() { Basic = new() { Creation = now, LastAccess = now, LastWrite = now, Change = now, Attributes = 1 }, Length = 4096 }, Identity = opaque, IdentityLength = (uint)identity.Length, Flags = 2 };
            var result = Native.CfCreatePlaceholders(root, ref entry, 1, 1, out var processed);
            return new(result, entry.Result, processed, entry.Usn);
        } finally { Marshal.FreeHGlobal(opaque); Marshal.FreeHGlobal(filename); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileBasic { internal long Creation, LastAccess, LastWrite, Change; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct FsMetadata { internal FileBasic Basic; internal long Length; }
    [StructLayout(LayoutKind.Sequential)] private struct PlaceholderCreate { internal nint RelativeName; internal FsMetadata Metadata; internal nint Identity; internal uint IdentityLength, Flags; internal int Result; internal long Usn; }
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    private static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleInfo info);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DeviceIoControl(SafeFileHandle handle, uint code, nint input, uint inputSize, byte[] output, uint outputSize, out uint returned, nint overlapped);
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] internal static extern int CfCreatePlaceholders(string root, ref PlaceholderCreate entry, uint count, uint flags, out uint processed);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] internal static extern int CfConvertToPlaceholder(SafeFileHandle handle, byte[] identity, uint identityLength, uint flags, out long usn, nint overlapped);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] internal static extern int CfGetPlaceholderInfo(SafeFileHandle handle, int kind, byte[] buffer, uint length, out uint returned);
    }
}
