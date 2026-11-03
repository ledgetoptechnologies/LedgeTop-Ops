#if LEDGETOP_CACHE_RACE_TEST
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.WindowsDownload;

// Compile-gated experiment only. No production caller or rename implementation.
// This models handle ownership and sealing, not download, resume or promotion.
internal sealed class ExperimentalOwnedStream : IDisposable
{
    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, Delete = 0x10000, ReadAttributes = 0x80;
    private const uint ShareReadWrite = 3, CreateNewMode = 1, OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    private readonly object gate = new();
    private readonly List<SafeFileHandle> directories = [];
    private FileStream? stream;
    private bool sealedStream;
    internal static Action? BeforeSealFlushTestHook, BeforeSealHashTestHook, AfterStreamDisposeTestHook;
    internal readonly record struct Identity(ulong Volume, Guid FileId);
    internal Identity SourceIdentity { get; private set; }

    private ExperimentalOwnedStream() { }

    internal static ExperimentalOwnedStream CreateNew(string path)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\", StringComparison.Ordinal) ||
            !string.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase) ||
            string.IsNullOrEmpty(Path.GetFileName(path))) throw new IOException("Experimental path must be canonical local storage.");
        var owner = new ExperimentalOwnedStream();
        try {
            var parent = Path.GetDirectoryName(path) ?? throw new IOException("Missing parent.");
            var ancestors = new Stack<string>();
            for (string? part = parent; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
            while (ancestors.Count != 0) {
                var directory = Open(ancestors.Pop(), ReadAttributes, ShareReadWrite, OpenExisting, BackupSemantics | OpenReparsePoint);
                try { RequireRegularKind(directory, directory: true); owner.directories.Add(directory); }
                catch { directory.Dispose(); throw; }
            }
            var file = Open(path, GenericRead | GenericWrite | Delete, 0, CreateNewMode, OpenReparsePoint);
            try {
                RequireRegularKind(file, directory: false);
                owner.SourceIdentity = GetIdentity(file);
                owner.stream = new FileStream(file, FileAccess.ReadWrite);
            } catch { file.Dispose(); throw; }
            return owner;
        } catch { owner.Dispose(); throw; }
    }

    internal void Write(ReadOnlySpan<byte> bytes)
    {
        lock (gate) {
            if (sealedStream) throw new InvalidOperationException("Experimental stream is sealed.");
            (stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream))).Write(bytes);
        }
    }

    internal byte[] SealAndHash()
    {
        lock (gate) {
            var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (sealedStream) throw new InvalidOperationException("Experimental stream is already sealed.");
            // Enter quarantine before any flush or hash operation: if either
            // fails, no subsequent write or retry can reuse ambiguous bytes.
            sealedStream = true;
            BeforeSealFlushTestHook?.Invoke();
            file.Flush(true); file.Position = 0;
            BeforeSealHashTestHook?.Invoke();
            var digest = SHA256.HashData(file);
            if (GetIdentity(file.SafeFileHandle) != SourceIdentity) throw new IOException("Experimental source identity changed.");
            return digest;
        }
    }

    internal void RenameNoReplace() => throw new NotSupportedException("Experimental rename and pending-I/O lifecycle are not implemented.");

    public void Dispose()
    {
        lock (gate) {
            Exception? failure = null;
            try { if (stream is not null) { stream.Dispose(); AfterStreamDisposeTestHook?.Invoke(); } }
            catch (Exception error) { failure = error; }
            finally {
                stream = null;
                for (var i = directories.Count - 1; i >= 0; i--) {
                    try { directories[i].Dispose(); } catch (Exception error) { failure ??= error; }
                }
                directories.Clear();
            }
            if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }

    private static SafeFileHandle Open(string path, uint access, uint share, uint mode, uint flags)
    {
        var result = CreateFileW(path, access, share, 0, mode, flags, 0);
        if (!result.IsInvalid) return result;
        var error = Marshal.GetLastWin32Error(); result.Dispose(); throw new IOException("Experimental native open failed.", error);
    }
    private static void RequireRegularKind(SafeFileHandle handle, bool directory)
    {
        var memory = Marshal.AllocHGlobal(8);
        try {
            if (!GetFileInformationByHandleEx(handle, 9, memory, 8)) throw new IOException("Experimental attributes unavailable.");
            var attributes = unchecked((uint)Marshal.ReadInt32(memory));
            if ((attributes & 0x400) != 0 || ((attributes & 0x10) != 0) != directory) throw new IOException("Experimental path type is unsafe.");
        } finally { Marshal.FreeHGlobal(memory); }
    }
    private static Identity GetIdentity(SafeFileHandle handle)
    {
        var memory = Marshal.AllocHGlobal(24);
        try {
            if (!GetFileInformationByHandleEx(handle, 18, memory, 24)) throw new IOException("Experimental file ID unavailable.");
            var volume = unchecked((ulong)Marshal.ReadInt64(memory)); var bytes = new byte[16]; Marshal.Copy(memory + 8, bytes, 0, 16);
            var id = new Guid(bytes); if (id == Guid.Empty) throw new IOException("Experimental file ID is empty.");
            return new(volume, id);
        } finally { Marshal.FreeHGlobal(memory); }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, nint security, uint mode, uint flags, nint template);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, nint data, uint size);
}
#endif
