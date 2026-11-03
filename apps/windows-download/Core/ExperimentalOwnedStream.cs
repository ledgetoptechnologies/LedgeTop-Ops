#if LEDGETOP_CACHE_RACE_TEST
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.WindowsDownload;

// Compile-gated experiment only. No production caller, download or resume path.
internal sealed class ExperimentalOwnedStream : IDisposable
{
    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, Delete = 0x10000, ReadAttributes = 0x80;
    private const uint ShareReadWrite = 3, CreateNewMode = 1, OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    private readonly object gate = new();
    private sealed record DirectoryPin(string Path, SafeFileHandle Handle, Identity Identity);
    private readonly List<DirectoryPin> directories = [];
    private FileStream? stream;
    private string sourcePath = "";
    private bool sealedStream, verifiedSeal, moved, renameUncertain;
    private byte[]? sealedDigest;
    internal static Action? BeforeSealFlushTestHook, BeforeSealHashTestHook, AfterStreamDisposeTestHook;
    internal static Func<nint, int>? SimulatedRenameStatusTestHook;
    internal static Func<uint>? SimulatedWaitTestHook;
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
            PinDirectories(parent, owner.directories);
            VerifyPins(owner.directories);
            var file = Open(path, GenericRead | GenericWrite | Delete, 0, CreateNewMode, OpenReparsePoint);
            try {
                RequireRegularKind(file, directory: false);
                owner.SourceIdentity = GetIdentity(file);
                owner.stream = new FileStream(file, FileAccess.ReadWrite);
                owner.sourcePath = path;
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
            sealedDigest = digest; verifiedSeal = true;
            return digest.ToArray();
        }
    }

    internal bool RenameNoReplace(string destinationDirectory, string leaf, ReadOnlySpan<byte> expectedDigest)
    {
        lock (gate) {
            var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (!sealedStream || !verifiedSeal || moved || renameUncertain) throw new InvalidOperationException("Experimental source is not eligible for rename.");
            if (sealedDigest is null || expectedDigest.Length != 32 || !CryptographicOperations.FixedTimeEquals(sealedDigest, expectedDigest))
                throw new IOException("Experimental source digest does not match the expected content.");
            if (!Path.IsPathFullyQualified(destinationDirectory) || destinationDirectory.StartsWith(@"\\", StringComparison.Ordinal) ||
                !string.Equals(Path.GetFullPath(destinationDirectory), destinationDirectory, StringComparison.OrdinalIgnoreCase) ||
                string.IsNullOrEmpty(leaf) || leaf is "." or ".." || leaf.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                leaf.EndsWith(' ') || leaf.EndsWith('.') || Path.GetFileName(leaf) != leaf)
                throw new IOException("Experimental destination is invalid.");
            var destinationPins = new List<DirectoryPin>();
            Exception? primary = null;
            try {
                PinDirectories(destinationDirectory, destinationPins);
                VerifyPins(directories); VerifyPins(destinationPins);
                if (destinationPins[^1].Identity.Volume != SourceIdentity.Volume || GetIdentity(file.SafeFileHandle) != SourceIdentity ||
                    !string.Equals(FinalPath(file.SafeFileHandle), sourcePath, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Experimental source or directory binding changed.");
                var bytes = Encoding.Unicode.GetBytes(leaf);
                var nameOffset = IntPtr.Size == 8 ? 20 : 12; var rootOffset = IntPtr.Size == 8 ? 8 : 4;
                var lengthOffset = IntPtr.Size == 8 ? 16 : 8; var structSize = IntPtr.Size == 8 ? 24 : 16;
                var size = checked(structSize + bytes.Length);
                var buffer = Marshal.AllocHGlobal(size); var io = nint.Zero;
                var inFlight = false;
                try {
                    io = Marshal.AllocHGlobal(IntPtr.Size * 2);
                    for (var i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
                    Marshal.WriteIntPtr(buffer, rootOffset, destinationPins[^1].Handle.DangerousGetHandle());
                    Marshal.WriteInt32(buffer, lengthOffset, bytes.Length); Marshal.Copy(bytes, 0, buffer + nameOffset, bytes.Length);
                    Marshal.WriteIntPtr(io, 0, (nint)0x103); Marshal.WriteIntPtr(io, IntPtr.Size, 0);
                    inFlight = true;
                    var status = SimulatedRenameStatusTestHook?.Invoke(io) ?? NtSetInformationFile(file.SafeFileHandle, io, buffer, checked((uint)size), 10);
                    if (unchecked((uint)status) == 0x103) {
                        while (true) {
                            var wait = SimulatedWaitTestHook?.Invoke() ?? WaitForSingleObject(file.SafeFileHandle, 1000);
                            var terminal = Marshal.ReadInt32(io);
                            if (wait == 0 && terminal != 0x103) { status = terminal; break; }
                            if (wait != 0 && wait != 0x102) ParkUncertain();
                            if (wait == 0) Thread.Sleep(50);
                        }
                    }
                    inFlight = false;
                    if (unchecked((uint)status) == 0xc0000035) {
                        renameUncertain = true;
                        VerifyPins(directories); VerifyPins(destinationPins);
                        if (GetIdentity(file.SafeFileHandle) != SourceIdentity ||
                            !string.Equals(FinalPath(file.SafeFileHandle), sourcePath, StringComparison.OrdinalIgnoreCase)) {
                            throw new IOException("Experimental collision outcome is uncertain.");
                        }
                        renameUncertain = false;
                        return false;
                    }
                    if (status != 0) { renameUncertain = true; throw new IOException("Experimental rename was refused."); }
                    moved = true;
                    VerifyPins(directories); VerifyPins(destinationPins);
                    if (GetIdentity(file.SafeFileHandle) != SourceIdentity ||
                        !string.Equals(FinalPath(file.SafeFileHandle), Path.Combine(destinationDirectory, leaf), StringComparison.OrdinalIgnoreCase)) {
                        renameUncertain = true; throw new IOException("Experimental rename outcome is uncertain.");
                    }
                    // The promoted source remains owned by this object. Keep
                    // destination ancestry pinned until the owner is disposed.
                    directories.AddRange(destinationPins); destinationPins.Clear();
                    return true;
                } finally {
                    if (inFlight) ParkUncertain();
                    Marshal.FreeHGlobal(io); Marshal.FreeHGlobal(buffer);
                }
            } catch (Exception error) { primary = error; throw; }
            finally {
                Exception? failure = null;
                for (var i = destinationPins.Count - 1; i >= 0; i--) {
                    try { destinationPins[i].Handle.Dispose(); } catch (Exception error) { failure ??= error; }
                }
                if (failure is not null && primary is null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
            }
        }
    }

    private static void ParkUncertain() { while (true) { try { Thread.Sleep(Timeout.Infinite); } catch (ThreadInterruptedException) { } } }

    public void Dispose()
    {
        lock (gate) {
            Exception? failure = null;
            try { if (stream is not null) { stream.Dispose(); AfterStreamDisposeTestHook?.Invoke(); } }
            catch (Exception error) { failure = error; }
            finally {
                stream = null;
                for (var i = directories.Count - 1; i >= 0; i--) {
                    try { directories[i].Handle.Dispose(); } catch (Exception error) { failure ??= error; }
                }
                directories.Clear();
            }
            if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
        }
    }

    private static void PinDirectories(string path, List<DirectoryPin> pins)
    {
        var ancestors = new Stack<string>();
        for (string? part = path; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
        while (ancestors.Count != 0) {
            var name = ancestors.Pop(); var directory = Open(name, ReadAttributes, ShareReadWrite, OpenExisting, BackupSemantics | OpenReparsePoint);
            try { RequireRegularKind(directory, directory: true); pins.Add(new(name, directory, GetIdentity(directory))); }
            catch { directory.Dispose(); throw; }
        }
    }
    private static void VerifyPins(IEnumerable<DirectoryPin> pins)
    {
        foreach (var pin in pins)
            if (GetIdentity(pin.Handle) != pin.Identity || !string.Equals(FinalPath(pin.Handle), pin.Path, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental directory binding changed.");
    }
    private static string FinalPath(SafeFileHandle handle)
    {
        var needed = GetFinalPathNameByHandleW(handle, null, 0, 0);
        if (needed is 0 or > 32767) throw new IOException("Experimental handle path unavailable.");
        var value = new StringBuilder(checked((int)needed + 1));
        var written = GetFinalPathNameByHandleW(handle, value, checked((uint)value.Capacity), 0);
        if (written == 0 || written >= value.Capacity || written != value.Length) throw new IOException("Experimental handle path unavailable.");
        var path = value.ToString();
        if (!path.StartsWith(@"\\?\", StringComparison.Ordinal) || path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Experimental path is not local storage.");
        return path[4..];
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
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder? name, uint length, uint flags);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("ntdll.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern int NtSetInformationFile(SafeFileHandle handle, nint statusBlock, nint information, uint length, int informationClass);
}
#endif
