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
            phases.Add($"create result=0x{created.Result:X8}; entry=0x{created.EntryResult:X8}; processed={created.Processed}; createUsn={created.CreateUsn}; openedUsn={UsnText(first.Usn)}");
            var convertPath = Path.Combine(root, "convert.bin"); FileIdentity beforeConvert; PlaceholderObservation converted;
            var convertIdentity = Encoding.UTF8.GetBytes("synthetic-convert-" + id.ToString("N"));
            using (var stream = new FileStream(convertPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.WriteThrough)) {
                stream.SetLength(4096); stream.Flush(true); beforeConvert = Identify(stream.SafeFileHandle);
                var result = Native.CfConvertToPlaceholder(stream.SafeFileHandle, convertIdentity, (uint)convertIdentity.Length, 3, out var convertUsn, IntPtr.Zero);
                if (result < 0) throw new IOException($"Synthetic handle conversion failed: 0x{result:X8}.");
                converted = ObservePlaceholder(stream.SafeFileHandle, convertIdentity);
                if (converted.Volume != beforeConvert.Volume || converted.FileId != beforeConvert.FileId || (ulong)converted.RootFileId != rootId.FileId)
                    throw new IOException("Conversion changed the held file identity.");
                phases.Add($"exclusive same-handle conversion; convertUsn={convertUsn}; openedUsn={UsnText(converted.Usn)}");
            }
            using (var handle = OpenAttributes(convertPath)) {
                var reopened = ObservePlaceholder(handle, convertIdentity);
                if (reopened.Volume != converted.Volume || reopened.FileId != converted.FileId) throw new IOException("Converted placeholder changed after handle close.");
            }

            var generatedObjects = await ProbeUsnChangesAsync(root, id, rootId, phases);

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
            foreach (var item in generatedObjects) {
                using var handle = OpenAttributes(item.Path); var current = ObservePlaceholder(handle, item.OpaqueIdentity);
                if (current.Volume != item.Identity.Volume || current.FileId != item.Identity.FileId || (ulong)current.RootFileId != rootId.FileId)
                    throw new IOException("A USN probe placeholder changed before unregister.");
            }
            var expectedNames = new HashSet<string>(generatedObjects.Select(item => Path.GetFileName(item.Path)), StringComparer.OrdinalIgnoreCase)
                { "ordinary-collision.bin", "created.bin", "convert.bin", "crash-window.bin" };
            if (!Directory.EnumerateFileSystemEntries(root).Select(Path.GetFileName).ToHashSet(StringComparer.OrdinalIgnoreCase).SetEquals(expectedNames))
                throw new IOException("Synthetic root contains an unexpected entry.");
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

    // The synthetic writer is separate and bounded because a native file open can
    // block while no provider is connected. Its only target is this exact owned file.
    internal static int WriteChild(string value, string parentValue, string startValue, string volumeValue, string fileValue)
    {
        StartChildWatchdog();
        if (!Guid.TryParseExact(value, "N", out var id) || !int.TryParse(parentValue, out var parentId) || !long.TryParse(startValue, out var parentStart) ||
            !uint.TryParse(volumeValue, out var expectedVolume) || !ulong.TryParse(fileValue, out var expectedFile)) return 2;
        using var parent = Process.GetProcessById(parentId);
        if (parent.HasExited || parent.StartTime.ToUniversalTime().Ticks != parentStart) return 2;
        var fixture = Fixture(id); var root = Path.Combine(fixture, "root");
        using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(fixture, "owner.json")));
        if (doc.RootElement.GetProperty("id").GetGuid() != id || doc.RootElement.GetProperty("root").GetString() != root) return 2;
        var registration = NativeRootRegistration.OpenOwned(root, Context(id)); registration.VerifyOwned();
        var rootId = doc.RootElement.GetProperty("rootId");
        if (ObservePath(root) != new FileIdentity(rootId.GetProperty("Volume").GetUInt32(), rootId.GetProperty("FileId").GetUInt64())) return 2;
        var path = Path.Combine(root, "usn-write.bin"); var opaque = Encoding.UTF8.GetBytes("synthetic-usn-write-" + id.ToString("N"));
        using var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.WriteThrough);
        var before = ObservePlaceholder(stream.SafeFileHandle, opaque);
        if (before.Volume != expectedVolume || before.FileId != expectedFile || (ulong)before.RootFileId != rootId.GetProperty("FileId").GetUInt64()) return 2;
        stream.WriteByte(0x5a); stream.Flush(true);
        if (Identify(stream.SafeFileHandle) != new FileIdentity(expectedVolume, expectedFile)) return 2;
        Console.WriteLine("SYNTHETIC_WRITE_COMPLETED"); return 0;
    }

    private sealed record GeneratedObject(string Path, byte[] OpaqueIdentity, FileIdentity Identity);
    private static async Task<IReadOnlyList<GeneratedObject>> ProbeUsnChangesAsync(string root, Guid id,
        CandidateDirectoryFence.DirectoryIdentity rootId, List<string> phases)
    {
        var result = new List<GeneratedObject>(); var stamp = DateTime.UtcNow.ToFileTimeUtc();
        var writeOpaque = Encoding.UTF8.GetBytes("synthetic-usn-write-" + id.ToString("N"));
        var writeCreate = Create(root, "usn-write.bin", writeOpaque, 0, stamp, 0x80);
        if (!writeCreate.Success) throw new IOException("Zero-length synthetic placeholder creation failed.");
        var writePath = Path.Combine(root, "usn-write.bin"); PlaceholderObservation writeBefore;
        using (var handle = OpenAttributes(writePath)) writeBefore = ObservePlaceholder(handle, writeOpaque);
        RequireRoot(writeBefore, rootId);
        using (var parent = Process.GetCurrentProcess()) {
            using var writer = Process.Start(StartSelf("--synthetic-usn-write-child", id.ToString("N"), parent.Id.ToString(),
                parent.StartTime.ToUniversalTime().Ticks.ToString(), writeBefore.Volume.ToString(), writeBefore.FileId.ToString())) ?? throw new IOException("Synthetic writer did not start.");
            try {
                var line = await writer.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(35));
                await writer.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                if (writer.ExitCode != 0 || line != "SYNTHETIC_WRITE_COMPLETED") throw new IOException("Synthetic placeholder write did not complete.");
            } finally {
                if (!writer.HasExited) { writer.Kill(entireProcessTree: true); await writer.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
            }
        }
        PlaceholderObservation writeAfter;
        using (var handle = OpenAttributes(writePath)) writeAfter = ObservePlaceholder(handle, writeOpaque);
        RequireRoot(writeAfter, rootId);
        if (writeAfter.Volume != writeBefore.Volume || writeAfter.FileId != writeBefore.FileId) throw new IOException("Synthetic write changed file identity.");
        phases.Add($"write observation: createUsn={writeCreate.CreateUsn}; beforeUsn={UsnText(writeBefore.Usn)}; afterUsn={UsnText(writeAfter.Usn)}; fileId={writeAfter.FileId}");
        result.Add(new(writePath, writeOpaque, new(writeAfter.Volume, writeAfter.FileId)));

        var recreateOpaque = Encoding.UTF8.GetBytes("synthetic-usn-recreate-" + id.ToString("N"));
        var firstCreate = Create(root, "usn-recreate.bin", recreateOpaque, 4096, stamp, 0x80);
        if (!firstCreate.Success) throw new IOException("First synthetic recreation placeholder failed.");
        var recreatePath = Path.Combine(root, "usn-recreate.bin"); PlaceholderObservation first;
        using (var handle = OpenForDelete(recreatePath)) {
            first = ObservePlaceholder(handle, recreateOpaque); RequireRoot(first, rootId);
            var disposition = new FileDisposition { DeleteFile = 1 };
            if (!Native.SetFileInformationByHandle(handle, 4, ref disposition, (uint)Marshal.SizeOf<FileDisposition>())) throw new IOException("Exact synthetic placeholder deletion failed.");
        }
        var secondCreate = Create(root, "usn-recreate.bin", recreateOpaque, 4096, stamp, 0x80);
        if (!secondCreate.Success) throw new IOException("Second synthetic recreation placeholder failed.");
        PlaceholderObservation second;
        using (var handle = OpenAttributes(recreatePath)) second = ObservePlaceholder(handle, recreateOpaque);
        RequireRoot(second, rootId);
        phases.Add($"delete/recreate observation: firstCreateUsn={firstCreate.CreateUsn}; firstOpenedUsn={UsnText(first.Usn)}; firstFileId={first.FileId}; secondCreateUsn={secondCreate.CreateUsn}; secondOpenedUsn={UsnText(second.Usn)}; secondFileId={second.FileId}; metadataInputsEqual=true");
        result.Add(new(recreatePath, recreateOpaque, new(second.Volume, second.FileId)));

        var renameOpaque = Encoding.UTF8.GetBytes("synthetic-usn-rename-" + id.ToString("N"));
        var renameCreate = Create(root, "usn-rename.bin", renameOpaque, 4096, stamp, 0x80);
        if (!renameCreate.Success) throw new IOException("Synthetic rename placeholder creation failed.");
        var renamePath = Path.Combine(root, "usn-rename.bin"); var movedPath = Path.Combine(root, "usn-renamed.bin"); PlaceholderObservation renameBefore;
        using (var parentHandle = OpenForRenameParent(root)) using (var handle = OpenForDelete(renamePath)) {
            if (Identify(parentHandle) != new FileIdentity(rootId.Volume, rootId.FileId)) throw new IOException("Rename parent differs.");
            renameBefore = ObservePlaceholder(handle, renameOpaque); RequireRoot(renameBefore, rootId);
            RenameByHandleNoReplace(handle, parentHandle, "usn-renamed.bin");
            var heldAfter = ObservePlaceholder(handle, renameOpaque);
            if (heldAfter.Volume != renameBefore.Volume || heldAfter.FileId != renameBefore.FileId) throw new IOException("Held renamed object changed identity.");
        }
        PlaceholderObservation moved;
        using (var handle = OpenAttributes(movedPath)) moved = ObservePlaceholder(handle, renameOpaque);
        RequireRoot(moved, rootId);
        if (moved.Volume != renameBefore.Volume || moved.FileId != renameBefore.FileId) throw new IOException("Synthetic rename changed file identity.");
        var replacementCreate = Create(root, "usn-rename.bin", renameOpaque, 4096, stamp, 0x80);
        if (!replacementCreate.Success) throw new IOException("Synthetic rename replacement creation failed.");
        PlaceholderObservation replacement;
        using (var handle = OpenAttributes(renamePath)) replacement = ObservePlaceholder(handle, renameOpaque);
        RequireRoot(replacement, rootId);
        phases.Add($"rename/replacement observation: firstCreateUsn={renameCreate.CreateUsn}; beforeUsn={UsnText(renameBefore.Usn)}; movedUsn={UsnText(moved.Usn)}; movedFileId={moved.FileId}; replacementCreateUsn={replacementCreate.CreateUsn}; replacementUsn={UsnText(replacement.Usn)}; replacementFileId={replacement.FileId}; metadataInputsEqual=true");
        result.Add(new(movedPath, renameOpaque, new(moved.Volume, moved.FileId)));
        result.Add(new(renamePath, renameOpaque, new(replacement.Volume, replacement.FileId)));
        return result.AsReadOnly();
    }
    private static void RequireRoot(PlaceholderObservation observation, CandidateDirectoryFence.DirectoryIdentity root) {
        if (observation.Volume != root.Volume || (ulong)observation.RootFileId != root.FileId) throw new IOException("Synthetic placeholder belongs to a different root.");
    }
    private static string UsnText(long usn) => usn < 0 ? "unavailable" : usn.ToString(System.Globalization.CultureInfo.InvariantCulture);

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
        if (Marshal.SizeOf<FileDisposition>() != 1 || Marshal.SizeOf<PlaceholderCreate>() != 88 ||
            Marshal.OffsetOf<PlaceholderCreate>(nameof(PlaceholderCreate.Usn)).ToInt32() != 80)
            throw new IOException("Synthetic native probe ABI differs.");
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
    private static SafeFileHandle OpenForDelete(string path)
    {
        var handle = Native.CreateFileW(path, 0x00010080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Synthetic file could not be opened for an exact mutation."); }
        return handle;
    }
    private static SafeFileHandle OpenForRenameParent(string path)
    {
        var handle = Native.CreateFileW(path, 0x82, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero); // FILE_ADD_FILE | FILE_READ_ATTRIBUTES.
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Synthetic rename parent could not be opened."); }
        return handle;
    }
    private static void RenameByHandleNoReplace(SafeFileHandle handle, SafeFileHandle parent, string leaf)
    {
        if (leaf != "usn-renamed.bin") throw new IOException("Unexpected synthetic rename target.");
        var name = Encoding.Unicode.GetBytes(leaf); var length = checked(20 + name.Length); var data = Marshal.AllocHGlobal(length);
        try {
            for (var index = 0; index < length; index++) Marshal.WriteByte(data, index, 0);
            Marshal.WriteInt32(data, 0, 0); // ReplaceIfExists = FALSE.
            Marshal.WriteIntPtr(data, 8, parent.DangerousGetHandle()); Marshal.WriteInt32(data, 16, name.Length); Marshal.Copy(name, 0, data + 20, name.Length);
            if (!Native.SetFileInformationByHandlePointer(handle, 3, data, (uint)length)) throw new IOException("Exact synthetic handle rename failed.");
        } finally { Marshal.FreeHGlobal(data); }
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
    private static CreateResult Create(string root, string name, byte[] identity, long length = 4096, long? timestamp = null, uint attributes = 1)
    {
        var filename = Marshal.StringToHGlobalUni(name); var opaque = Marshal.AllocHGlobal(identity.Length);
        try {
            Marshal.Copy(identity, 0, opaque, identity.Length); var now = timestamp ?? DateTime.UtcNow.ToFileTimeUtc();
            var entry = new PlaceholderCreate { RelativeName = filename, Metadata = new() { Basic = new() { Creation = now, LastAccess = now, LastWrite = now, Change = now, Attributes = attributes }, Length = length }, Identity = opaque, IdentityLength = (uint)identity.Length, Flags = 2 };
            var result = Native.CfCreatePlaceholders(root, ref entry, 1, 1, out var processed);
            return new(result, entry.Result, processed, entry.Usn);
        } finally { Marshal.FreeHGlobal(opaque); Marshal.FreeHGlobal(filename); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileBasic { internal long Creation, LastAccess, LastWrite, Change; internal uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct FsMetadata { internal FileBasic Basic; internal long Length; }
    [StructLayout(LayoutKind.Sequential)] private struct PlaceholderCreate { internal nint RelativeName; internal FsMetadata Metadata; internal nint Identity; internal uint IdentityLength, Flags; internal int Result; internal long Usn; }
    [StructLayout(LayoutKind.Sequential)] private struct FileDisposition { internal byte DeleteFile; } // Windows BOOLEAN, not BOOL.
    [StructLayout(LayoutKind.Sequential)] private struct ByHandleInfo { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
    private static class Native
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleInfo info);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool DeviceIoControl(SafeFileHandle handle, uint code, nint input, uint inputSize, byte[] output, uint outputSize, out uint returned, nint overlapped);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref FileDisposition info, uint size);
        [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetFileInformationByHandlePointer(SafeFileHandle handle, int kind, nint info, uint size);
        [DllImport("CldApi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] internal static extern int CfCreatePlaceholders(string root, ref PlaceholderCreate entry, uint count, uint flags, out uint processed);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] internal static extern int CfConvertToPlaceholder(SafeFileHandle handle, byte[] identity, uint identityLength, uint flags, out long usn, nint overlapped);
        [DllImport("CldApi.dll", ExactSpelling = true)] [DefaultDllImportSearchPaths(DllImportSearchPath.System32)] internal static extern int CfGetPlaceholderInfo(SafeFileHandle handle, int kind, byte[] buffer, uint length, out uint returned);
    }
}
