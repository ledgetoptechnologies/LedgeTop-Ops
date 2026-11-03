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
    private static readonly byte[] Watchdog = "synthetic-watchdog-child-reservation\n"u8.ToArray();

    internal static void Run()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows-only handle comparison.");
        AbsenceEvidenceTests();
        SupervisorEvidenceTests();
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
        var watchdogRecord = Path.Combine(fixture, "watchdog-child.record");
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
                ActiveAccountingControl(record, stream, ownerId, foreign, foreignId);
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
            var watchdogId = RunParentDeathTest(fixture, directoryId);
            VerifyDirectoryBinding(fixture, directory, directoryId);
            using (var reopened = new FileStream(watchdogRecord, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                RequireKind(reopened.SafeFileHandle, isDirectory: false);
                if (watchdogId == ownerId || watchdogId == foreignId || watchdogId == childId || Id(reopened.SafeFileHandle) != watchdogId || !ReadExact(reopened, Watchdog))
                    throw new IOException("Watchdog child record did not retain its exact identity and bytes.");
            }
            PhysicalAccountingControl(fixture, directory, directoryId, childRecord, childId, () => deleteDispositionsApplied++);
            VerifyDirectoryBinding(fixture, directory, directoryId);
            verified = true;
            // Delete each exact owned file only through the verified file handle.
            if (!TryDeleteExact(fixture, directory, directoryId, record, Owned, ownerId)) throw new IOException("Exact synthetic file cleanup was not verified.");
            deleteDispositionsApplied++;
            if (!TryDeleteExact(fixture, directory, directoryId, foreign, Foreign, foreignId)) throw new IOException("Exact synthetic file cleanup was not verified.");
            deleteDispositionsApplied++;
            if (!TryDeleteExact(fixture, directory, directoryId, watchdogRecord, Watchdog, watchdogId)) throw new IOException("Exact synthetic watchdog record cleanup was not verified.");
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
        Console.WriteLine("PASS ordinary Windows retained-handle identity, abrupt child termination, watchdog after parent death, and exact cleanup. No native provider or OS crash tested.");
    }

    // Isolated feasibility control, not used by the provider. The caller must
    // already own a stable root directory and an exclusive interprocess lease.
    // No cancellation, crash-atomic registry, or product recovery is implied.
    private sealed class PhysicalAccounting(string root, SafeFileHandle directory, FileId directoryId, Action recordDisposition)
    {
        private sealed record Row(FileStream Handle, FileId Identity, byte[] Bytes, long Growth);
        private readonly object gate = new();
        private readonly Dictionary<string, Row> rows = new(StringComparer.OrdinalIgnoreCase);
        internal void Register(string path, byte[] expected, long growth, FileId expectedId)
        {
            lock (gate) {
                if (!string.Equals(Path.GetDirectoryName(path), root, StringComparison.OrdinalIgnoreCase) || growth <= 0 || rows.ContainsKey(path))
                    throw new IOException("Invalid active record.");
                VerifyDirectoryBinding(root, directory, directoryId);
                var h = Open(path, GenericRead | Delete, ShareRead, OpenReparsePoint);
                var input = new FileStream(h, FileAccess.Read);
                try {
                    RequireKind(h, isDirectory: false); var id = Id(h);
                    if (id != expectedId || !ReadExact(input, expected)) throw new IOException("Unexpected active record identity or contents.");
                    rows.Add(path, new(input, id, expected.ToArray(), growth));
                } catch { input.Dispose(); throw; }
            }
        }
        internal long Count(string[] paths, Func<string, long> unknown)
        {
            lock (gate) {
                VerifyDirectoryBinding(root, directory, directoryId);
                long result = 0; var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var path in paths) {
                    if (!seen.Add(path)) throw new IOException("Duplicate record.");
                    if (rows.TryGetValue(path, out var row)) {
                        if (Id(row.Handle.SafeFileHandle) != row.Identity || !ReadExact(row.Handle, row.Bytes))
                            throw new IOException("Active record changed.");
                        result = checked(result + row.Growth);
                    } else result = checked(result + unknown(path));
                }
                if (rows.Keys.Any(path => !seen.Contains(path))) throw new IOException("Missing active record.");
                return result;
            }
        }
        internal bool Release(string path, byte[] expected, bool simulateBeforeDeleteFailure = false, bool simulateAfterDispositionFailure = false)
        {
            lock (gate) {
                if (!rows.TryGetValue(path, out var row) || !row.Bytes.AsSpan().SequenceEqual(expected) ||
                    Id(row.Handle.SafeFileHandle) != row.Identity || !ReadExact(row.Handle, row.Bytes)) return false;
                VerifyDirectoryBinding(root, directory, directoryId);
                if (simulateBeforeDeleteFailure) return false;
                byte disposition = 1;
                if (!SetFileInformationByHandle(row.Handle.SafeFileHandle, 4, ref disposition, 1)) return false;
                recordDisposition(); // report a real disposition even if later observation fails
                // Keep its charge until confirmed absent. If observation fails,
                // the caller must quarantine the registry rather than reuse it.
                row.Handle.Dispose();
                if (simulateAfterDispositionFailure) throw new IOException("Injected post-disposition observation failure.");
                if (!ConfirmedAbsent(() => File.GetAttributes(path), () => VerifyDirectoryBinding(root, directory, directoryId)))
                    throw new IOException("Delete outcome uncertain; registry remains charged.");
                rows.Remove(path); return true;
            }
        }
    }

    private static void PhysicalAccountingControl(string root, SafeFileHandle directory, FileId directoryId, string childRecord, FileId childId, Action recordDisposition)
    {
        var recorded = 0;
        void Record() { recorded++; recordDisposition(); }
        var path = Path.Combine(root, "accounting.record");
        FileId createdId;
        using (var created = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { created.Write(Owned); created.Flush(true); createdId = Id(created.SafeFileHandle); }
        var registry = new PhysicalAccounting(root, directory, directoryId, Record);
        var mismatchRejected = false;
        try { registry.Register(path, Owned, 100, childId); } catch (IOException) { mismatchRejected = true; }
        if (!mismatchRejected) throw new IOException("Foreign record identity was accepted.");
        registry.Register(path, Owned, 100, createdId);
        var calls = Enumerable.Range(0, 8).Select(_ => Task.Run(() => registry.Count(new[] { path }, _ => throw new IOException("Unexpected record.")))).ToArray();
        Task.WaitAll(calls);
        if (calls.Any(t => t.Result != 100)) throw new IOException("Concurrent accounting disagreed.");
        if (registry.Release(path, Foreign) || registry.Release(path, Owned, simulateBeforeDeleteFailure: true) ||
            registry.Count(new[] { path }, _ => throw new IOException("Unexpected record.")) != 100)
            throw new IOException("Failed delete lost active accounting.");
        var unknownRejected = false;
        try { registry.Count(new[] { path, childRecord }, _ => throw new IOException("Unknown record.")); } catch (IOException) { unknownRejected = true; }
        if (!unknownRejected || registry.Count(new[] { path }, _ => throw new IOException("Unexpected record.")) != 100)
            throw new IOException("Unknown record was ignored or active charge was lost.");
        if (!registry.Release(path, Owned)) throw new IOException("Retained-handle delete failed.");
        if (registry.Count(Array.Empty<string>(), _ => throw new IOException("Unexpected record.")) != 0)
            throw new IOException("Confirmed delete remained charged.");
        // The existing separate child process wrote this record and exited
        // abruptly; rebuild a fresh registry after the child's handle closed.
        var recovered = new PhysicalAccounting(root, directory, directoryId, Record);
        recovered.Register(childRecord, Abrupt, 80, childId);
        if (recovered.Count(new[] { childRecord }, _ => throw new IOException("Unexpected record.")) != 80 ||
            !recovered.Release(childRecord, Abrupt)) throw new IOException("Child record recovery failed.");

        // Test that a successful OS disposition is reported even when the
        // following verification fails. Quarantine this test registry, then
        // independently confirm the fixture file is absent before proceeding.
        var faultPath = Path.Combine(root, "accounting-fault.record"); FileId faultId;
        using (var created = new FileStream(faultPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
            created.Write(Owned); created.Flush(true); faultId = Id(created.SafeFileHandle);
        }
        var faulted = new PhysicalAccounting(root, directory, directoryId, Record);
        faulted.Register(faultPath, Owned, 100, faultId);
        var before = recorded;
        var failed = false;
        try { faulted.Release(faultPath, Owned, simulateAfterDispositionFailure: true); } catch (IOException) { failed = true; }
        if (!failed || recorded != before + 1 || !ConfirmedAbsent(() => File.GetAttributes(faultPath), () => VerifyDirectoryBinding(root, directory, directoryId)))
            throw new IOException("Injected post-disposition failure was not contained.");
    }

    // Narrow test-only accounting model. It deliberately accepts a supplied
    // enumeration and verified stream; it does not implement durable deletion,
    // a quota lock, concurrent processes, or production reconciliation.
    private sealed class ActiveAccounting
    {
        private readonly Dictionary<string, (FileStream Handle, FileId Id, long Growth)> active = new(StringComparer.OrdinalIgnoreCase);
        internal void Register(string path, FileStream handle, FileId expected, long growth) {
            if (growth <= 0 || Id(handle.SafeFileHandle) != expected || !active.TryAdd(path, (handle, expected, growth)))
                throw new IOException("Unverified or duplicate active reservation.");
        }
        internal long Count(IEnumerable<string> paths, Func<string, long> readUnknown) {
            long total = 0; var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var path in paths) {
                if (!seen.Add(path)) throw new IOException("Duplicate reservation path.");
                if (active.TryGetValue(path, out var row)) {
                    if (Id(row.Handle.SafeFileHandle) != row.Id) throw new IOException("Active handle identity changed.");
                    total = checked(total + row.Growth);
                } else total = checked(total + readUnknown(path));
            }
            if (active.Keys.Any(path => !seen.Contains(path))) throw new IOException("Active reservation missing from enumeration.");
            return total;
        }
        internal void Release(string path, FileId expected, bool exactDeleteConfirmed) {
            if (!active.TryGetValue(path, out var row) || row.Id != expected || Id(row.Handle.SafeFileHandle) != expected)
                throw new IOException("Reservation identity mismatch.");
            if (exactDeleteConfirmed) active.Remove(path);
        }
    }

    private static void ActiveAccountingControl(string record, FileStream retained, FileId ownerId, string foreign, FileId foreignId)
    {
        var shared = new ActiveAccounting(); var coordinatorA = shared; var coordinatorB = shared;
        coordinatorA.Register(record, retained, ownerId, 100);
        var unknownReads = 0;
        long ReadUnknown(string path) {
            unknownReads++;
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (path != foreign || Id(file.SafeFileHandle) != foreignId || !ReadExact(file, Foreign))
                throw new IOException("Unknown reservation cannot be verified.");
            return 50;
        }
        var paths = new[] { record, foreign };
        if (coordinatorB.Count(paths, ReadUnknown) != 150 || unknownReads != 1)
            throw new IOException("Active and unknown records were not conservatively counted.");
        coordinatorA.Release(record, ownerId, exactDeleteConfirmed: false);
        if (coordinatorB.Count(paths, ReadUnknown) != 150) throw new IOException("Failed release discarded accounting.");
        var rejected = false;
        try { coordinatorB.Release(record, foreignId, exactDeleteConfirmed: true); } catch (IOException) { rejected = true; }
        if (!rejected || coordinatorA.Count(paths, ReadUnknown) != 150) throw new IOException("Foreign identity released accounting.");
        rejected = false;
        try { coordinatorB.Count(new[] { foreign }, ReadUnknown); } catch (IOException) { rejected = true; }
        if (!rejected) throw new IOException("A missing active path was ignored.");
        rejected = false;
        try { coordinatorB.Count(paths, _ => throw new IOException("Unknown record")); } catch (IOException) { rejected = true; }
        if (!rejected || coordinatorA.Count(paths, ReadUnknown) != 150) throw new IOException("Unknown record failure discarded accounting.");
        // A fake receipt exercises state transitions only; no file is removed.
        coordinatorA.Release(record, ownerId, exactDeleteConfirmed: true);
        if (coordinatorB.Count(new[] { foreign }, ReadUnknown) != 50) throw new IOException("Confirmed release remained charged.");
    }

    internal static void RunChild(string fixture, string volumeText, string idText, string recordName)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var watchdogValue = Environment.GetEnvironmentVariable("LEDGETOP_TEST_HANDLE_WATCHDOG_SECONDS") ?? "15";
        if (!int.TryParse(watchdogValue, out var seconds) || seconds is < 2 or > 30) throw new IOException("Invalid synthetic watchdog duration.");
        // Start before filesystem operations: a blocked file open/flush must not
        // bypass the deadline after a test parent dies. The parent tests wait on
        // the process handle and never assume TerminateProcess has completed.
        var watchdog = new Thread(() => {
            Thread.Sleep(TimeSpan.FromSeconds(seconds));
            if (!TerminateProcess(GetCurrentProcess(), 3)) Environment.Exit(3);
        }) { IsBackground = true, Name = "synthetic-reservation-watchdog" };
        watchdog.Start();
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
        if (recordName is not ("abrupt-child.record" or "watchdog-child.record")) throw new IOException("Invalid synthetic record name.");
        var payload = recordName == "abrupt-child.record" ? Abrupt : Watchdog;
        using var record = new FileStream(Path.Combine(fixture, recordName), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
        record.Write(payload); record.Flush(true); RequireKind(record.SafeFileHandle, isDirectory: false);
        if (!ReadExact(record, payload)) throw new IOException("Synthetic child record did not flush.");
        var recordId = Id(record.SafeFileHandle);
        Console.WriteLine($"READY {recordId.Volume:X16} {recordId.Id:N}"); Console.Out.Flush();
        Thread.Sleep(Timeout.Infinite);
    }

    private static System.Diagnostics.ProcessStartInfo OwnProcessStart(params string[] args)
    {
        var executable = Environment.ProcessPath ?? throw new IOException("Test executable path unavailable.");
        var start = new System.Diagnostics.ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (string.Equals(Path.GetFileNameWithoutExtension(executable), "dotnet", StringComparison.OrdinalIgnoreCase)) {
            var assembly = System.Reflection.Assembly.GetExecutingAssembly().Location;
            if (string.IsNullOrEmpty(assembly)) throw new IOException("Test assembly path unavailable.");
            start.ArgumentList.Add(assembly);
        }
        foreach (var arg in args) start.ArgumentList.Add(arg);
        return start;
    }
    private static FileId ParseReady(string? line)
    {
        var parts = line?.Split(' ', StringSplitOptions.None);
        if (parts is not { Length: 3 } || parts[0] != "READY" || parts[1].Length != 16 ||
            !ulong.TryParse(parts[1], System.Globalization.NumberStyles.AllowHexSpecifier, System.Globalization.CultureInfo.InvariantCulture, out var volume) ||
            !Guid.TryParseExact(parts[2], "N", out var id) || parts[2] != id.ToString("N") || id == Guid.Empty)
            throw new IOException("Synthetic child readiness evidence was invalid.");
        return new FileId(volume, id);
    }
    private static bool DrainOutput(Task<string?> firstLine, StreamReader output, ref Task<string>? remainder, Task<string> errors, TimeSpan? timeout = null)
    {
        var limit = timeout ?? TimeSpan.FromSeconds(3);
        if (!firstLine.Wait(limit)) return false;
        remainder ??= output.ReadToEndAsync();
        return remainder.Wait(limit) && errors.Wait(limit);
    }
    private readonly record struct WorkerReady(uint Pid, long StartTicks, FileId RecordId);
    private static WorkerReady ParseWorkerReady(string? line)
    {
        var parts = line?.Split(' ', StringSplitOptions.None);
        if (parts is not { Length: 5 } || parts[0] != "WORKER" || !uint.TryParse(parts[1], out var pid) || pid == 0 ||
            !long.TryParse(parts[2], out var startTicks) || startTicks <= 0 || parts[3].Length != 16 ||
            !ulong.TryParse(parts[3], System.Globalization.NumberStyles.AllowHexSpecifier, System.Globalization.CultureInfo.InvariantCulture, out var volume) ||
            !Guid.TryParseExact(parts[4], "N", out var id) || parts[4] != id.ToString("N") || id == Guid.Empty)
            throw new IOException("Synthetic watchdog readiness evidence was invalid.");
        return new WorkerReady(pid, startTicks, new FileId(volume, id));
    }
    private static bool WorkerIsLive(uint waitResult) => waitResult == 258;
    private static bool WorkerExitProven(bool identified, uint waitResult) => identified && waitResult == 0;
    private static void SupervisorEvidenceTests()
    {
        foreach (var bad in new string?[] { null, "", "WORKER", "WORKER 0 1 0000000000000000 00000000000000000000000000000001", "WORKER 1 1 bad invalid" }) {
            var rejected = false; try { _ = ParseWorkerReady(bad); } catch (IOException) { rejected = true; }
            if (!rejected) throw new IOException("Invalid supervisor readiness was accepted.");
        }
        var parsed = ParseWorkerReady("WORKER 42 123 0000000000000001 00000000000000000000000000000001");
        if (parsed.Pid != 42 || parsed.StartTicks != 123 || !WorkerIsLive(258) || WorkerIsLive(0) || WorkerIsLive(uint.MaxValue) ||
            WorkerExitProven(false, 0) || WorkerExitProven(true, 258) || !WorkerExitProven(true, 0))
            throw new IOException("Late or unidentified worker evidence was accepted.");
        var late = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var output = new StreamReader(new MemoryStream()); Task<string>? remainder = null;
        if (DrainOutput(late.Task, output, ref remainder, Task.FromResult(""), TimeSpan.FromMilliseconds(20)))
            throw new IOException("A pending readiness stream was considered drained.");
        late.SetResult("late");
        if (!DrainOutput(late.Task, output, ref remainder, Task.FromResult(""), TimeSpan.FromSeconds(1)))
            throw new IOException("A completed synthetic stream did not drain.");
    }
    private static FileId RunAbruptChild(string fixture, FileId directoryId)
    {
        var start = OwnProcessStart("--reservation-handle-prototype-child", fixture,
            directoryId.Volume.ToString("X16", System.Globalization.CultureInfo.InvariantCulture), directoryId.Id.ToString("N"), "abrupt-child.record");
        start.Environment["LEDGETOP_TEST_HANDLE_WATCHDOG_SECONDS"] = "15";
        using var child = System.Diagnostics.Process.Start(start) ?? throw new IOException("Synthetic child did not start.");
        var stdout = child.StandardOutput.ReadLineAsync(); var stderr = child.StandardError.ReadToEndAsync(); Task<string>? tail = null;
        try {
            var id = ParseReady(stdout.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult());
            if (child.HasExited) throw new IOException("Synthetic child exited before controlled termination.");
            child.Kill();
            if (!child.WaitForExit(10_000) || child.ExitCode == 0) throw new IOException("Synthetic child termination was not verified.");
            return id;
        } finally {
            var joined = false;
            try {
                if (!child.HasExited) child.Kill();
                joined = child.WaitForExit(10_000) && DrainOutput(stdout, child.StandardOutput, ref tail, stderr);
            } catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or AggregateException) {
                joined = false;
            }
            if (!joined) throw new IOException("Synthetic owned child exit or stream drain was not confirmed.");
        }
    }

    internal static void RunWatchdogSupervisor(string fixture, string volumeText, string idText)
    {
        var start = OwnProcessStart("--reservation-handle-prototype-child", fixture, volumeText, idText, "watchdog-child.record");
        start.Environment["LEDGETOP_TEST_HANDLE_WATCHDOG_SECONDS"] = "5";
        using var child = System.Diagnostics.Process.Start(start) ?? throw new IOException("Synthetic watchdog child did not start.");
        var stdout = child.StandardOutput.ReadLineAsync(); var stderr = child.StandardError.ReadToEndAsync(); Task<string>? tail = null;
        try {
            var identity = ParseReady(stdout.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult());
            if (child.HasExited) throw new IOException("Synthetic watchdog child exited before parent-death test.");
            Console.WriteLine($"WORKER {child.Id} {child.StartTime.ToUniversalTime().Ticks} {identity.Volume:X16} {identity.Id:N}"); Console.Out.Flush();
            if (!child.WaitForExit(15_000)) throw new IOException("Synthetic watchdog did not finish.");
        } finally {
            var joined = false;
            try {
                if (!child.HasExited) child.Kill();
                joined = child.WaitForExit(10_000) && DrainOutput(stdout, child.StandardOutput, ref tail, stderr);
            } catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or AggregateException) { joined = false; }
            if (!joined) throw new IOException("Synthetic watchdog child exit or streams were not confirmed.");
        }
    }

    private static FileId RunParentDeathTest(string fixture, FileId directoryId)
    {
        var start = OwnProcessStart("--reservation-handle-watchdog-supervisor", fixture,
            directoryId.Volume.ToString("X16", System.Globalization.CultureInfo.InvariantCulture), directoryId.Id.ToString("N"));
        using var supervisor = System.Diagnostics.Process.Start(start) ?? throw new IOException("Synthetic supervisor did not start.");
        var stdout = supervisor.StandardOutput.ReadLineAsync(); var stderr = supervisor.StandardError.ReadToEndAsync(); Task<string>? tail = null;
        SafeWaitHandle? worker = null; var workerIdentityVerified = false;
        try {
            var ready = ParseWorkerReady(stdout.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult());
            worker = OpenProcess(0x00101000, false, ready.Pid); // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
            if (worker.IsInvalid || GetProcessId(worker) != ready.Pid || !GetProcessTimes(worker, out var creation, out _, out _, out _) ||
                DateTime.FromFileTimeUtc(creation).Ticks != ready.StartTicks || !WorkerIsLive(WaitForSingleObject(worker, 0)))
                throw new IOException("Synthetic watchdog worker identity or live state was not confirmed.");
            workerIdentityVerified = true;
            if (supervisor.HasExited) throw new IOException("Synthetic supervisor exited before controlled termination.");
            supervisor.Kill();
            if (!supervisor.WaitForExit(10_000) || supervisor.ExitCode == 0) throw new IOException("Synthetic supervisor termination was not confirmed.");
            if (!WorkerExitProven(workerIdentityVerified, WaitForSingleObject(worker, 15_000)) || !GetExitCodeProcess(worker, out var exitCode) || exitCode != 3)
                throw new IOException("Synthetic worker watchdog exit was not confirmed.");
            return ready.RecordId;
        } finally {
            // Once the supervisor has started, an unidentified worker is
            // uncertain even if readiness failed or arrived too late.
            var supervisorJoined = false; var workerJoined = false;
            try {
                if (!supervisor.HasExited) supervisor.Kill();
                supervisorJoined = supervisor.WaitForExit(10_000) && DrainOutput(stdout, supervisor.StandardOutput, ref tail, stderr);
                if (worker is not null && !worker.IsInvalid && workerIdentityVerified) workerJoined = WorkerExitProven(true, WaitForSingleObject(worker, 15_000));
            } catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or AggregateException) {
                supervisorJoined = false;
            } finally { worker?.Dispose(); }
            if (!supervisorJoined || !workerJoined) throw new IOException("Synthetic supervisor, worker, or stream drain was not confirmed; an unidentified worker may remain. Its watchdog is configured to trigger after managed startup.");
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
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeWaitHandle OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetProcessId(SafeWaitHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(SafeWaitHandle process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(SafeWaitHandle process, out long creationTime, out long exitTime, out long kernelTime, out long userTime);
    [DllImport("kernel32.dll")]
    private static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(nint process, uint exitCode);
}
