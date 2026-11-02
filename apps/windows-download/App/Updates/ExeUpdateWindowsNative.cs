using System.ComponentModel;
using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Updates;

[SupportedOSPlatform("windows")]
internal static class ExeUpdateWindowsNative
{
    internal static string CurrentSid() => WindowsIdentity.GetCurrent().User?.Value ?? throw new IOException("Update identity unavailable.");
    internal static string GateName(string sid, int session, string channel) => @"Local\LedgeTop.Files.ExeUpdate." +
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sid + "\n" + session + "\n" + channel)));

    // Event handle lifetime, not thread-affine mutex ownership. The helper retains its own authenticated
    // handle before READY. Normal startup must honor existence; this is not an authorization capability.
    internal static SafeWaitHandle? CreateGate(string name, string sid)
    {
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;" + sid + ")", 1, out var descriptor, out _))
            throw new Win32Exception();
        try {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreateEvent(ref security, true, false, name);
            var error = Marshal.GetLastWin32Error();
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(error); }
            if (error == 183) { handle.Dispose(); return null; }
            return handle;
        } finally { LocalFree(descriptor); }
    }
    internal static SafeWaitHandle OpenGate(string name)
    {
        var handle = OpenEvent(0x00100000, false, name);
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Update ownership unavailable."); }
        return handle;
    }
    internal static bool GateExists(string name)
    {
        using var handle = OpenEvent(0x00100000, false, name);
        if (!handle.IsInvalid) return true;
        return Marshal.GetLastWin32Error() != 2; // Unknown/access-denied state blocks new provider work.
    }
    internal static int PipePeer(PipeStream pipe, bool server)
    {
        uint pid;
        if (!(server ? GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) : GetNamedPipeServerProcessId(pipe.SafePipeHandle, out pid)) || pid is 0 or > int.MaxValue)
            throw new IOException("Update peer unavailable.");
        return (int)pid;
    }
    internal static Process OpenBoundProcess(ExeUpdateParentIdentity expected, ExeUpdateInstalledOwner owner)
    {
        var process = Process.GetProcessById(expected.ProcessId);
        try {
            _ = process.Handle; // Retain the actual process object before querying the binding.
            VerifyProcess(process, expected, owner);
            return process;
        } catch { process.Dispose(); throw; }
    }
    internal static void VerifyProcess(Process process, ExeUpdateParentIdentity expected, ExeUpdateInstalledOwner owner)
    {
        if (process.Id != expected.ProcessId || process.HasExited || process.StartTime.ToUniversalTime().Ticks != expected.StartTimeUtcTicks || process.SessionId != owner.SessionId)
            throw new IOException("Update process identity changed.");
        if (!OpenProcessToken(process.Handle, 8, out var token)) throw new IOException("Update process identity unavailable.");
        string sid;
        using (token) sid = TokenSid(token);
        var path = new StringBuilder(32768); var count = path.Capacity;
        if (!QueryFullProcessImageName(process.Handle, 0, path, ref count) || !ExeUpdateWindowsPolicy.SamePeer(
            new(process.Id, process.StartTime.ToUniversalTime().Ticks, sid, process.SessionId, path.ToString()), expected, owner))
            throw new IOException("Update peer image refused.");
    }
    internal static ExeUpdateParentIdentity ProcessIdentity(Process process) => new(process.Id, process.StartTime.ToUniversalTime().Ticks);
    private static string TokenSid(SafeAccessTokenHandle token)
    {
        _ = GetTokenInformation(token, 1, IntPtr.Zero, 0, out var length);
        if (length is 0 or > 16384) throw new IOException("Update peer token refused.");
        var buffer = Marshal.AllocHGlobal(checked((int)length));
        try {
            if (!GetTokenInformation(token, 1, buffer, length, out _ ) || !ConvertSidToStringSid(Marshal.ReadIntPtr(buffer), out var text))
                throw new IOException("Update peer SID unavailable.");
            try {
                var sid = Marshal.PtrToStringUni(text);
                return sid is { Length: > 0 and <= 184 } ? sid : throw new IOException("Update peer SID refused.");
            } finally { LocalFree(text); }
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    internal static void NoAliases(string path)
    {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith("\\\\", StringComparison.Ordinal) || path.Contains('%') || path.AsSpan(2).Contains(':'))
            throw new IOException("Update local path refused.");
        var full = Path.GetFullPath(path);
        for (string? part = full; part is not null; part = Path.GetDirectoryName(part))
            if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new IOException("Update path alias refused.");
    }

    // Lock path ancestry as well as bytes: no directory deletion/rename while a verified path is used.
    internal static IDisposable HoldDirectoryChain(string directory)
    {
        var handles = new List<SafeFileHandle>();
        try {
            NoAliases(directory);
            for (string? part = directory; part is not null; part = Path.GetDirectoryName(part)) {
                var handle = CreateFile(part, 0, 1 | 2, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
                if (handle.IsInvalid) { handle.Dispose(); throw new IOException("Update directory fence unavailable."); }
                handles.Add(handle);
            }
            NoAliases(directory);
            return new DirectoryFence(handles);
        } catch { foreach (var handle in handles) handle.Dispose(); throw; }
    }
    private sealed class DirectoryFence(List<SafeFileHandle> handles) : IDisposable
    { public void Dispose() { foreach (var handle in handles) handle.Dispose(); handles.Clear(); } }
    internal sealed class GateLease(SafeWaitHandle handle) : IAsyncDisposable
    { public ValueTask DisposeAsync() { handle.Dispose(); return ValueTask.CompletedTask; } }

    // CreateProcess gives an atomic success + retained kernel handle. A deadline never kills a child.
    internal static SpawnedProcess Spawn(string executable, IReadOnlyList<string> arguments, bool hidden)
    {
        NoAliases(executable);
        if (executable.Contains('"') || arguments.Any(value => value.Length > 200 || value.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '.' or '/'))))
            throw new IOException("Update launch arguments refused.");
        var command = new StringBuilder('"' + executable + '"' + (arguments.Count == 0 ? "" : " " + string.Join(' ', arguments)));
        var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>(), Flags = hidden ? 1u : 0u };
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, hidden ? 0x08000000u : 0u,
            IntPtr.Zero, Path.GetDirectoryName(executable)!, ref startup, out var info)) throw new IOException("Update process could not start.");
        CloseHandle(info.Thread);
        return new(new SafeProcessHandle(info.Process, true), info.ProcessId);
    }
    internal sealed class SpawnedProcess(SafeProcessHandle handle, uint processId) : IDisposable, IExeUpdateInstallerProcess
    {
        internal int Id => checked((int)processId);
        internal ExeUpdateParentIdentity Identity {
            get {
                if (!GetProcessTimes(handle, out var created, out _, out _, out _)) throw new IOException("Update process time unavailable.");
                return new(Id, DateTime.FromFileTimeUtc(created).Ticks);
            }
        }
        public Task<bool> WaitAsync(TimeSpan timeout) => Task.Run(() => {
            var result = WaitForSingleObject(handle, checked((uint)timeout.TotalMilliseconds));
            if (result == 0) return true;
            if (result == 258) return false;
            throw new IOException("Update process wait unavailable.");
        });
        // On a lost/uncertain wait preserve the real handle and helper lifetime; manual reconciliation
        // is required. Never close the last gate or start another installer because a wait failed.
        public async Task WaitUntilConfirmedExitAsync()
        {
            while (true) {
                try { if (await WaitAsync(TimeSpan.FromSeconds(30)).ConfigureAwait(false)) return; }
                catch { /* Keep the operation owner alive and fail closed while termination is unknown. */ }
                await Task.Delay(TimeSpan.FromSeconds(1)).ConfigureAwait(false);
            }
        }
        public uint ExitCode => GetExitCodeProcess(handle, out var code) ? code : throw new IOException("Update exit code unavailable.");
        public void Dispose() => handle.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { internal int Length; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        internal int Size; internal IntPtr Reserved, Desktop, Title;
        internal uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        internal short Show, ReservedSize; internal IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { internal IntPtr Process, Thread; internal uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CreateProcess(string application, StringBuilder command,
        IntPtr processSecurity, IntPtr threadSecurity, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags,
        IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeProcessHandle handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(SafeProcessHandle handle, out uint exitCode);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle CreateEvent(ref SecurityAttributes security, [MarshalAs(UnmanagedType.Bool)] bool manual, [MarshalAs(UnmanagedType.Bool)] bool initial, string name);
    [DllImport("kernel32.dll", EntryPoint = "OpenEventW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle OpenEvent(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int kind, IntPtr buffer, uint size, out uint required);
    [DllImport("advapi32.dll", EntryPoint = "ConvertSidToStringSidW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr text);
    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
