#if LEDGETOP_CACHE_RACE_TEST
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.WindowsDownload;

// Compile-gated experiment only. No production caller.
internal sealed class ExperimentalOwnedStream : IDisposable
{
    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000, Delete = 0x10000, ReadAttributes = 0x80, ListDirectory = 0x1;
    private const uint ShareReadWrite = 3, CreateNewMode = 1, OpenExistingMode = 3;
    private const uint BackupSemantics = 0x02000000, OpenReparsePoint = 0x00200000;
    private readonly object gate = new();
    private static readonly object QuarantineGate = new();
    private static readonly HashSet<ExperimentalOwnedStream> Quarantined = [];
    internal sealed record DirectoryPin(string Path, SafeFileHandle Handle, Identity Identity);
    private readonly List<DirectoryPin> directories = [];
    private FileStream? stream;
    private SafeFileHandle? sourceHandle;
    private string sourcePath = "";
    private bool sealedStream, verifiedSeal, moved, renameUncertain, disposeUncertain, sourceCloseReturned, injectedCloseBoundary, handedOff;
    private enum QuarantineReason { None, NativeOperation, BindingChange, InjectedBindingCheck, Disposal, PrefixRestoration, InjectedPrefixRestoration }
    private QuarantineReason quarantineReason;
    private object? bindingInjectionToken;
    private byte[]? sealedDigest;
    private string? successfulRenameTarget;
    internal static Action? BeforeSealFlushTestHook, BeforeSealHashTestHook, AfterStreamDisposeTestHook;
    internal static Action? AfterSuccessfulNativeRenameTestHook;
    internal static int QuarantinedCountForTest { get { lock (QuarantineGate) return Quarantined.Count; } }
    internal static bool HasQuarantineForEntryForTest(string entry)
    {
        var prefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(entry)) + Path.DirectorySeparatorChar;
        lock (QuarantineGate) return Quarantined.Any(owner => owner.sourcePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }
    internal static ExperimentalOwnedStream FindInjectedPrefixOwnerForTest(object token)
    {
        lock (QuarantineGate) {
            var matches = Quarantined.Where(owner => owner.quarantineReason == QuarantineReason.InjectedPrefixRestoration &&
                ReferenceEquals(owner.bindingInjectionToken, token)).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("Synthetic prefix owner is not unique.");
            return matches[0];
        }
    }
    internal static Func<nint, int>? SimulatedRenameStatusTestHook;
    internal static Func<uint>? SimulatedWaitTestHook;
    internal static Func<string, string>? PinExpectedPathTestHook;
    internal static object? BindingInjectionTokenTestHook;
    internal static object? PrefixRestorationTokenTestHook;
    internal static Action? BeforeRestoreLengthTestHook, BeforeRestoreFlushTestHook;
    internal readonly record struct Identity(ulong Volume, Guid FileId);
    internal Identity SourceIdentity { get; private set; }

    private ExperimentalOwnedStream() { }

    internal static ExperimentalOwnedStream CreateNew(string path) => OpenOwned(path, CreateNewMode, null);
    internal static ExperimentalOwnedStream OpenExisting(string path, long expectedLength)
    {
        if (expectedLength < 0) throw new ArgumentOutOfRangeException(nameof(expectedLength));
        return OpenOwned(path, OpenExistingMode, expectedLength);
    }
    private static ExperimentalOwnedStream OpenOwned(string path, uint mode, long? expectedLength)
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
            var file = Open(path, GenericRead | GenericWrite | Delete, 0, mode, OpenReparsePoint);
            try {
                RequireRegularKind(file, directory: false);
                if (expectedLength is not null) RequireSingleLink(file);
                owner.SourceIdentity = GetIdentity(file);
                owner.stream = new FileStream(file, FileAccess.ReadWrite);
                owner.sourceHandle = file;
                owner.sourcePath = path;
                owner.VerifyOwnedPins();
                if (!string.Equals(FinalPath(file), path, StringComparison.OrdinalIgnoreCase)) {
                    owner.EnterQuarantine(QuarantineReason.BindingChange); throw new IOException("Experimental source binding changed.");
                }
                if (expectedLength is { } length) {
                    if (owner.stream.Length != length) throw new IOException("Experimental partial length changed.");
                    owner.stream.Position = length;
                }
            } catch { if (owner.stream is null) file.Dispose(); throw; }
            return owner;
        } catch { if (!owner.renameUncertain) owner.Dispose(); throw; }
    }

    internal void Write(ReadOnlySpan<byte> bytes)
    {
        lock (gate) {
            if (renameUncertain || disposeUncertain) throw new InvalidOperationException("Experimental ownership is uncertain.");
            if (sealedStream) throw new InvalidOperationException("Experimental stream is sealed.");
            VerifyOwnedPins();
            (stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream))).Write(bytes);
        }
    }

    internal void RestorePrefix(long length)
    {
        lock (gate) {
            if (renameUncertain || disposeUncertain || sealedStream || length < 0) throw new InvalidOperationException("Experimental prefix restoration is unavailable.");
            VerifyOwnedPins(); var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (length > file.Length) throw new IOException("Experimental prefix length changed.");
            var token = (BeforeRestoreLengthTestHook is not null || BeforeRestoreFlushTestHook is not null) ? PrefixRestorationTokenTestHook : null;
            EnterQuarantine(token is null ? QuarantineReason.PrefixRestoration : QuarantineReason.InjectedPrefixRestoration, token);
            BeforeRestoreLengthTestHook?.Invoke(); file.SetLength(length);
            BeforeRestoreFlushTestHook?.Invoke(); file.Flush(true);
            VerifyPins(directories);
            if (file.Length != length || GetIdentity(file.SafeFileHandle) != SourceIdentity ||
                !string.Equals(FinalPath(file.SafeFileHandle), sourcePath, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental partial restoration is uncertain.");
            LeaveQuarantine();
        }
    }

    internal byte ReadLastByteForTest()
    {
        lock (gate) {
            if (renameUncertain || disposeUncertain || sealedStream) throw new InvalidOperationException("Experimental source is unavailable.");
            VerifyOwnedPins(); var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (file.Length <= 0) throw new IOException("Experimental source is empty.");
            file.Position = file.Length - 1; var value = file.ReadByte(); file.Position = file.Length;
            if (value < 0 || GetIdentity(file.SafeFileHandle) != SourceIdentity) throw new IOException("Experimental source identity changed.");
            return checked((byte)value);
        }
    }

    internal byte[] SealAndHash()
    {
        lock (gate) {
            var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (renameUncertain || disposeUncertain) throw new InvalidOperationException("Experimental ownership is uncertain.");
            if (sealedStream) throw new InvalidOperationException("Experimental stream is already sealed.");
            // Enter quarantine before any flush or hash operation: if either
            // fails, no subsequent write or retry can reuse ambiguous bytes.
            sealedStream = true;
            VerifyOwnedPins();
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
                VerifyOwnedPins(); VerifyPins(destinationPins);
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
                    // Root the owner before issuing native I/O. A caller that
                    // drops its reference after an ambiguous result must not
                    // let SafeHandle finalizers close the quarantined handles.
                    EnterQuarantine(QuarantineReason.NativeOperation); inFlight = true;
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
                        VerifyPins(directories); VerifyPins(destinationPins);
                        if (GetIdentity(file.SafeFileHandle) != SourceIdentity ||
                            !string.Equals(FinalPath(file.SafeFileHandle), sourcePath, StringComparison.OrdinalIgnoreCase)) {
                            throw new IOException("Experimental collision outcome is uncertain.");
                        }
                        LeaveQuarantine();
                        return false;
                    }
                    if (status != 0) { renameUncertain = true; throw new IOException("Experimental rename was refused."); }
                    // From the successful kernel return until every binding is
                    // checked, retain all handles and refuse normal disposal.
                    moved = true;
                    successfulRenameTarget = Path.Combine(destinationDirectory, leaf);
                    AfterSuccessfulNativeRenameTestHook?.Invoke();
                    VerifyPins(directories); VerifyPins(destinationPins);
                    if (GetIdentity(file.SafeFileHandle) != SourceIdentity ||
                        !string.Equals(FinalPath(file.SafeFileHandle), successfulRenameTarget, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("Experimental rename outcome is uncertain.");
                    // The promoted source remains owned by this object. Keep
                    // destination ancestry pinned until the owner is disposed.
                    directories.AddRange(destinationPins); destinationPins.Clear();
                    LeaveQuarantine();
                    return true;
                } finally {
                    if (inFlight) ParkUncertain();
                    Marshal.FreeHGlobal(io); Marshal.FreeHGlobal(buffer);
                }
            } catch (Exception error) { primary = error; throw; }
            finally {
                if (renameUncertain && destinationPins.Count != 0) {
                    directories.AddRange(destinationPins); destinationPins.Clear();
                }
                Exception? failure = null;
                for (var i = destinationPins.Count - 1; i >= 0; i--) {
                    try { destinationPins[i].Handle.Dispose(); } catch (Exception error) { failure ??= error; }
                }
                if (failure is not null && primary is null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
            }
        }
    }

    // Test-only handoff: the facade never exposes the writable native handle.
    // Its disposal transfers to the whole owner, including directory pins.
    internal Stream OpenReadOnlyHandoff()
    {
        lock (gate) {
            if (!moved || handedOff || renameUncertain || disposeUncertain || stream is null) throw new InvalidOperationException("Experimental promotion is unavailable.");
            stream.Position = 0; handedOff = true; return new ReadOnlyHandoff(this);
        }
    }
    private sealed class ReadOnlyHandoff(ExperimentalOwnedStream owner) : Stream
    {
        private ExperimentalOwnedStream? current = owner;
        private ExperimentalOwnedStream Owner => current ?? throw new ObjectDisposedException(nameof(ReadOnlyHandoff));
        public override bool CanRead => current is not null;
        public override bool CanSeek => current is not null;
        public override bool CanWrite => false;
        public override long Length { get { var o = Owner; lock (o.gate) { o.VerifyOwnedPins(); return (o.stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream))).Length; } } }
        public override long Position {
            get { var o = Owner; lock (o.gate) { o.VerifyOwnedPins(); return (o.stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream))).Position; } }
            set { var o = Owner; lock (o.gate) { o.VerifyOwnedPins(); (o.stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream))).Position = value; } }
        }
        public override int Read(byte[] buffer, int offset, int count) { var o = Owner; lock (o.gate) { o.VerifyOwnedPins(); return (o.stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream))).Read(buffer, offset, count); } }
        public override long Seek(long offset, SeekOrigin origin) { var o = Owner; lock (o.gate) { o.VerifyOwnedPins(); return (o.stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream))).Seek(offset, origin); } }
        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) Interlocked.Exchange(ref current, null)?.Dispose(); base.Dispose(disposing); }
    }

    private static void ParkUncertain() { while (true) { try { Thread.Sleep(Timeout.Infinite); } catch (ThreadInterruptedException) { } } }

    private void EnterQuarantine(QuarantineReason reason, object? injectionToken = null)
    {
        lock (QuarantineGate) {
            if (!Quarantined.Add(this)) throw new InvalidOperationException("Experimental owner is already quarantined.");
            renameUncertain = true; quarantineReason = reason; bindingInjectionToken = injectionToken;
        }
    }
    private void LeaveQuarantine()
    {
        lock (QuarantineGate) {
            if (!Quarantined.Remove(this)) throw new InvalidOperationException("Experimental quarantine ownership was lost.");
            renameUncertain = false; quarantineReason = QuarantineReason.None; bindingInjectionToken = null;
        }
    }

    // Test-only recovery of a known-success return. Never reconstructs ownership
    // from a path or settles any unknown status; no production caller exists.
    internal void ReconcileSuccessfulRenameForTest()
    {
        lock (gate) {
            var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (!renameUncertain || quarantineReason != QuarantineReason.NativeOperation || !moved || successfulRenameTarget is null || sealedDigest is null)
                throw new InvalidOperationException("No known-success experimental rename to reconcile.");
            VerifyPins(directories);
            if (GetIdentity(file.SafeFileHandle) != SourceIdentity ||
                !string.Equals(FinalPath(file.SafeFileHandle), successfulRenameTarget, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental rename identity remains uncertain.");
            file.Position = 0;
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(file), sealedDigest))
                throw new IOException("Experimental rename content remains uncertain.");
            LeaveQuarantine();
        }
    }

    // Synthetic-only settlement after a simulated binding observation failure.
    internal void ReconcileOriginalSourceBindingForTest(object injectionToken)
    {
        lock (gate) {
            var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (!renameUncertain || quarantineReason != QuarantineReason.InjectedBindingCheck ||
                !ReferenceEquals(bindingInjectionToken, injectionToken) || disposeUncertain || moved)
                throw new InvalidOperationException("No injected original source binding to settle.");
            VerifyPins(directories);
            if (GetIdentity(file.SafeFileHandle) != SourceIdentity || !string.Equals(FinalPath(file.SafeFileHandle), sourcePath, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental source binding remains uncertain.");
            LeaveQuarantine();
        }
    }
    // Only for deliberately injected fixture failures, not real rollback I/O.
    internal void ReconcileInjectedPrefixForTest(object injectionToken, byte[] expectedBytes)
    {
        lock (gate) {
            var file = stream ?? throw new ObjectDisposedException(nameof(ExperimentalOwnedStream));
            if (!renameUncertain || quarantineReason != QuarantineReason.InjectedPrefixRestoration ||
                !ReferenceEquals(bindingInjectionToken, injectionToken) || sealedStream || disposeUncertain)
                throw new InvalidOperationException("No injected prefix restoration to settle.");
            VerifyPins(directories); file.Flush(true);
            if (GetIdentity(file.SafeFileHandle) != SourceIdentity || file.Length != expectedBytes.Length ||
                !string.Equals(FinalPath(file.SafeFileHandle), sourcePath, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental partial restoration remains uncertain.");
            file.Position = 0; var actual = new byte[expectedBytes.Length]; file.ReadExactly(actual);
            if (!actual.AsSpan().SequenceEqual(expectedBytes)) throw new IOException("Experimental prefix bytes changed.");
            LeaveQuarantine();
        }
    }

    public void Dispose()
    {
        lock (gate) {
            if (renameUncertain || disposeUncertain) throw new InvalidOperationException("Experimental ownership is uncertain; handles are retained.");
            if (stream is null && directories.Count == 0) return;
            EnterQuarantine(QuarantineReason.Disposal);
            try {
                if (stream is not null) {
                    VerifyPins(directories);
                    stream.Dispose(); sourceCloseReturned = true;
                    if (AfterStreamDisposeTestHook is not null) { injectedCloseBoundary = true; AfterStreamDisposeTestHook(); }
                }
                for (var i = directories.Count - 1; i >= 0; i--) directories[i].Handle.Dispose();
                directories.Clear(); stream = null; sourceHandle = null;
                LeaveQuarantine();
            } catch {
                // Do not discard the owner, source reference, or remaining
                // directory pins when any close result is uncertain.
                disposeUncertain = true;
                throw;
            }
        }
    }

    // Only settles the synthetic injection after a successful managed source
    // Dispose return; it is not a recovery path for a real close exception.
    internal void ReconcileInjectedDisposeFailureForTest()
    {
        lock (gate) {
            if (!disposeUncertain || quarantineReason != QuarantineReason.Disposal || !injectedCloseBoundary || !sourceCloseReturned || sourceHandle is null || !sourceHandle.IsClosed)
                throw new InvalidOperationException("Experimental close remains uncertain.");
            VerifyPins(directories);
            for (var i = directories.Count - 1; i >= 0; i--) directories[i].Handle.Dispose();
            directories.Clear(); stream = null; sourceHandle = null; disposeUncertain = false;
            LeaveQuarantine();
        }
    }

    internal static void PinDirectories(string path, List<DirectoryPin> pins)
    {
        var ancestors = new Stack<string>();
        for (string? part = path; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
        while (ancestors.Count != 0) {
            // Attribute-only opens can be exempt from Windows share checks.
            // Request directory-list access so deny-delete sharing is meaningful;
            // refuse if existing handles or ACLs do not permit it.
            var name = ancestors.Pop(); var directory = Open(name, ReadAttributes | ListDirectory, ShareReadWrite, OpenExistingMode, BackupSemantics | OpenReparsePoint);
            try { RequireRegularKind(directory, directory: true); pins.Add(new(name, directory, GetIdentity(directory))); }
            catch { directory.Dispose(); throw; }
        }
    }
    internal static void VerifyPins(IEnumerable<DirectoryPin> pins)
    {
        foreach (var pin in pins)
            if (GetIdentity(pin.Handle) != pin.Identity || !string.Equals(FinalPath(pin.Handle), PinExpectedPathTestHook?.Invoke(pin.Path) ?? pin.Path, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental directory binding changed.");
    }
    private void VerifyOwnedPins()
    {
        try { VerifyPins(directories); }
        catch {
            if (!renameUncertain) {
                var token = PinExpectedPathTestHook is not null ? BindingInjectionTokenTestHook : null;
                EnterQuarantine(token is null ? QuarantineReason.BindingChange : QuarantineReason.InjectedBindingCheck, token);
            }
            throw;
        }
    }
    internal int VerifyRetainedPinsForTest()
    {
        lock (gate) {
            if (!renameUncertain && !disposeUncertain) throw new InvalidOperationException("Experimental owner is not quarantined.");
            VerifyPins(directories); return directories.Count;
        }
    }
    internal static string FinalPath(SafeFileHandle handle)
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

    internal static SafeFileHandle Open(string path, uint access, uint share, uint mode, uint flags)
    {
        var result = CreateFileW(PlaceholderHydrationCoordinator.NativeCacheFilePath(path), access, share, 0, mode, flags, 0);
        if (!result.IsInvalid) return result;
        var error = Marshal.GetLastWin32Error(); result.Dispose(); throw new IOException("Experimental native open failed.", error);
    }
    internal static void RequireRegularKind(SafeFileHandle handle, bool directory)
    {
        var memory = Marshal.AllocHGlobal(8);
        try {
            if (!GetFileInformationByHandleEx(handle, 9, memory, 8)) throw new IOException("Experimental attributes unavailable.");
            var attributes = unchecked((uint)Marshal.ReadInt32(memory));
            if ((attributes & 0x400) != 0 || ((attributes & 0x10) != 0) != directory) throw new IOException("Experimental path type is unsafe.");
        } finally { Marshal.FreeHGlobal(memory); }
    }
    internal static void RequireSingleLink(SafeFileHandle handle)
    {
        var memory = Marshal.AllocHGlobal(24);
        try {
            if (!GetFileInformationByHandleEx(handle, 1, memory, 24)) throw new IOException("Experimental partial metadata unavailable.");
            if (Marshal.ReadInt32(memory, 16) != 1 || Marshal.ReadByte(memory, 20) != 0 || Marshal.ReadByte(memory, 21) != 0)
                throw new IOException("Experimental partial link or type is unsafe.");
        } finally { Marshal.FreeHGlobal(memory); }
    }
    internal static Identity GetIdentity(SafeFileHandle handle)
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
