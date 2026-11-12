#if LEDGETOP_NATIVE_DIAGNOSTICS
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// The outer VM supervisor creates/owns the job and gate. This helper only queries them;
// it never creates a job, modifies limits or terminates a process.
internal static class SyntheticBusySupervisor
{
    private const uint Query = 4, KillOnClose = 0x2000, Breakaway = 0x800 | 0x1000;
    [StructLayout(LayoutKind.Sequential)] private struct Basic {
        internal long PerProcessTime, PerJobTime; internal uint Flags; internal nuint Min, Max;
        internal uint ActiveLimit; internal nuint Affinity; internal uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Io { internal ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct Limits { internal Basic Basic; internal Io Io; internal nuint ProcessMemory, JobMemory, PeakProcess, PeakJob; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsProcessInJob(nint process, SafeFileHandle job, [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Limits limits, uint length, out uint returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder path, ref uint length);
    internal static bool FlagsSafe(uint flags) => (flags & KillOnClose) != 0 && (flags & Breakaway) == 0;
    internal static bool ValidNames(string job, string gate) => Regex.IsMatch(job, "\\ALedgeTopBusyJob-[a-f0-9]{32}\\z") &&
        gate == "LedgeTopBusyGate-" + job["LedgeTopBusyJob-".Length..];
    internal static void AwaitAndVerify() {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var job = Environment.GetEnvironmentVariable("LEDGETOP_EXTERNAL_JOB_NAME") ?? "";
        var gate = Environment.GetEnvironmentVariable("LEDGETOP_EXTERNAL_START_GATE") ?? "";
        if (!ValidNames(job, gate))
            throw new IOException("External comparison requires its named supervisor job and gate.");
        using (var start = EventWaitHandle.OpenExisting(gate))
            if (!start.WaitOne(TimeSpan.FromSeconds(20))) throw new TimeoutException("Supervisor did not release its job gate.");
        using var process = Process.GetCurrentProcess(); VerifyMember(job, process);
    }
    internal static void VerifyChild(Process child) => VerifyMember(Environment.GetEnvironmentVariable("LEDGETOP_EXTERNAL_JOB_NAME") ?? "", child);
    internal static string VerifyImage(Process process, string expected) {
        if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(expected)) throw new IOException("Synthetic reader executable is unavailable.");
        var buffer = new StringBuilder(32768); uint length = (uint)buffer.Capacity;
        // Query the actual process handle returned at launch, not a freshly looked-up PID.
        // This does not require user-mode MainModule enumeration to have finished loading.
        if (!QueryFullProcessImageNameW(process.SafeHandle, 0, buffer, ref length) || length == 0 || length >= buffer.Capacity)
            throw new IOException("Synthetic reader executable could not be queried.");
        var actual = buffer.ToString();
        if (!Path.IsPathFullyQualified(actual) || !string.Equals(Path.GetFullPath(actual), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
            throw new IOException("Synthetic reader executable changed.");
        return Path.GetFullPath(actual);
    }
    private static void VerifyMember(string jobName, Process process) {
        if (!OperatingSystem.IsWindows() || IntPtr.Size != 8 || Marshal.SizeOf<Limits>() != 144 || Marshal.OffsetOf<Basic>(nameof(Basic.Flags)).ToInt32() != 16)
            throw new PlatformNotSupportedException("Supervisor job ABI is unsupported.");
        using var job = OpenJobObjectW(Query, false, jobName);
        if (job.IsInvalid || !QueryInformationJobObject(job, 9, out var limits, (uint)Marshal.SizeOf<Limits>(), out _) || !FlagsSafe(limits.Basic.Flags) ||
            !IsProcessInJob(process.Handle, job, out var member) || !member)
            throw new IOException("Supervisor job membership or kill-on-close limits could not be verified.");
        // Close our query handle before starting more work; only the supervisor should
        // retain the job handle, so its deadline close can terminate the whole job.
    }
    internal static void WriteRecord(string owned, string leaf, object record) {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(record);
        using var stream = new FileStream(Path.Combine(owned, leaf), FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        stream.Write(bytes); stream.Flush(true);
    }
    internal static int ImageChild(string gateName) {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (!Regex.IsMatch(gateName, "\\ALedgeTopBusyImageTest-[a-f0-9]{32}\\z")) return 2;
        using var gate = EventWaitHandle.OpenExisting(gateName); return gate.WaitOne(TimeSpan.FromSeconds(10)) ? 0 : 2;
    }
    internal static int Tests() {
        var nonce = new string('a', 32);
        if (IntPtr.Size != 8 || Marshal.SizeOf<Limits>() != 144 || Marshal.OffsetOf<Basic>(nameof(Basic.Flags)).ToInt32() != 16 ||
            !ValidNames("LedgeTopBusyJob-" + nonce, "LedgeTopBusyGate-" + nonce) ||
            ValidNames("LedgeTopBusyJob-" + nonce, "LedgeTopBusyGate-" + new string('b', 32)) || ValidNames("bad", "bad"))
            throw new Exception("Supervisor job ABI or paired names are invalid.");
        if (!FlagsSafe(0x2000) || FlagsSafe(0) || FlagsSafe(0x2800) || FlagsSafe(0x3000)) throw new Exception("Job flags accepted unsafe termination or breakaway settings.");
        using (var self = Process.GetCurrentProcess()) {
            var expected = Environment.ProcessPath ?? throw new Exception("Current process path unavailable.");
            if (!string.Equals(VerifyImage(self, expected), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase)) throw new Exception("Current process image differed.");
            try { _ = VerifyImage(self, Path.Combine(Path.GetDirectoryName(expected)!, "not-this-program.exe")); throw new Exception("Foreign executable accepted."); }
            catch (IOException) { }
        }
        var executable = Environment.ProcessPath ?? throw new Exception("Process path unavailable.");
        var gateName = "LedgeTopBusyImageTest-" + Guid.NewGuid().ToString("N");
        using (var gate = new EventWaitHandle(false, EventResetMode.ManualReset, gateName)) {
            var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true };
            if (Path.GetFileNameWithoutExtension(executable).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
                info.ArgumentList.Add(System.Reflection.Assembly.GetEntryAssembly()?.Location ?? throw new Exception("Test assembly unavailable."));
            info.ArgumentList.Add("--synthetic-busy-image-child"); info.ArgumentList.Add(gateName);
            using var child = Process.Start(info) ?? throw new Exception("Synthetic image child did not start.");
            try {
                _ = VerifyImage(child, executable); // Immediately after Start, before child readiness.
                gate.Set(); if (!child.WaitForExit(10000) || child.ExitCode != 0) throw new Exception("Synthetic image child did not exit normally.");
            } finally {
                if (!child.HasExited) { child.Kill(); if (!child.WaitForExit(10000)) throw new Exception("Synthetic image child did not drain."); }
            }
        }
        var root = Path.Combine(Path.GetTempPath(), "lt-busy-supervisor-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try {
            var calls = 0;
            void StartOnce() {
                WriteRecord(root, "reader-0-intent.json", new { schema = 1, index = 0 });
                calls++; WriteRecord(root, "reader-0-started.json", new { schema = 1, pid = 123, startUtcTicks = 456, executable = "synthetic" });
            }
            StartOnce();
            try { StartOnce(); throw new Exception("Reader intent was replayed."); } catch (IOException) { }
            if (calls != 1 || !File.Exists(Path.Combine(root, "reader-0-started.json"))) throw new Exception("Reader ledger ordering differs.");
            Console.WriteLine("PASS supervisor flags, durable reader ledger and bounded child image check; no job or native registration created."); return 0;
        } finally { File.Delete(Path.Combine(root, "reader-0-intent.json")); File.Delete(Path.Combine(root, "reader-0-started.json")); Directory.Delete(root); }
    }
}
#endif
