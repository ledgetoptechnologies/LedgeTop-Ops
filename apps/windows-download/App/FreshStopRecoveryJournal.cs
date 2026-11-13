using System.Security.Cryptography;
using System.Text.Json;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
using LedgeTop.Files.Updates;

namespace LedgeTop.Files;

// Experimental and deliberately unused by lifecycle code. A journal record is
// evidence of a reported step, not authority to retry, delete, or release files.
// Caller must hold the exact index lock and separately verify the OS/session.
// WriteThrough and readback do not prove power-loss-durable directory metadata.
internal static class FreshStopRecoveryJournal
{
    internal enum Observation { Missing, IntentRecordPresent, DrainRecordPresent, RetirementInProgress }
    private const string Owner = "LedgeTop.Files.FreshStopJournal/1";
    private static readonly object Writes = new();
    private sealed record Record(string Owner, string Operation, string SelectorSha256, string Step);

    internal static void RecordIntent(string directory, Guid operation, string selectorSha256, SelectorIndexOwnership ownership, Func<bool> exactSelector) =>
        Write(directory, operation, selectorSha256, "intent", ownership, exactSelector, null);

    internal static void RecordDrained(string directory, Guid operation, string selectorSha256, SelectorIndexOwnership ownership, Func<bool> exactSelector, Func<bool> drainConfirmed) =>
        Write(directory, operation, selectorSha256, "drained", ownership, exactSelector, drainConfirmed);

    // Discover at most one unresolved operation, with the caller's newly acquired
    // index ownership. Unexpected names, orphan receipts or multiple operations
    // require review. This is not proof that an uncooperative writer is absent.
    internal static (Guid Operation, Observation State)? Discover(string directory, string selectorSha256, SelectorIndexOwnership ownership, Func<bool> exactSelector)
    {
        Validate(directory, Guid.NewGuid(), selectorSha256, exactSelector);
        return ownership.WithHeld(Path.Combine(directory, "index.lock"), () => DiscoverHeld(directory, selectorSha256, Checked(ownership, exactSelector)));
    }
    private static (Guid Operation, Observation State)? DiscoverHeld(string directory, string selectorSha256, Func<bool> exactSelector)
    {
        lock (Writes) {
            var fence = Hold(directory);
            try {
                if (!exactSelector()) throw new IOException("Selector is unavailable.");
                Guid? operation = null; int count = 0;
                foreach (var entry in Directory.EnumerateFileSystemEntries(directory, "fresh-stop-*.json")) {
                    if (++count > 3) throw new IOException("Multiple stop journal records require review.");
                    var name = Path.GetFileName(entry);
                    const string prefix = "fresh-stop-";
                    if (!name.StartsWith(prefix, StringComparison.Ordinal) || name.Length < prefix.Length + 32 ||
                        !Guid.TryParseExact(name.Substring(prefix.Length, 32), "N", out var id) || id == Guid.Empty ||
                        !(name == Leaf(id, "intent") || name == Leaf(id, "drained") || name == Leaf(id, "retiring")) || operation is not null && operation != id)
                        throw new IOException("Unexpected stop journal requires review.");
                    operation = id;
                }
                if (!exactSelector()) throw new IOException("Selector changed during discovery.");
                if (operation is null) return null;
                var state = ObserveHeld(directory, operation.Value, selectorSha256, exactSelector);
                if (state == Observation.Missing) throw new IOException("Discovered stop journal disappeared.");
                return (operation.Value, state);
            } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
        }
    }

    // Only after a *new* caller has obtained the index lock. This observation
    // alone says nothing about native registration, the old process, or release.
    internal static Observation Observe(string directory, Guid operation, string selectorSha256, SelectorIndexOwnership ownership, Func<bool> exactSelector)
    {
        Validate(directory, operation, selectorSha256, exactSelector);
        return ownership.WithHeld(Path.Combine(directory, "index.lock"), () => ObserveHeld(directory, operation, selectorSha256, Checked(ownership, exactSelector)));
    }
    private static Observation ObserveHeld(string directory, Guid operation, string selectorSha256, Func<bool> exactSelector)
    {
        lock (Writes) {
            var fence = Hold(directory);
            try {
            if (!exactSelector()) throw new IOException("Selector is unavailable.");
            var intent = Read(directory, Leaf(operation, "intent"));
            var drained = Read(directory, Leaf(operation, "drained"));
            var retiring = Read(directory, Leaf(operation, "retiring"));
            if (!exactSelector()) throw new IOException("Selector changed during observation.");
            if (retiring is not null) {
                Check(retiring, operation, selectorSha256, "retiring");
                if (intent is not null) Check(intent, operation, selectorSha256, "intent");
                if (drained is not null) Check(drained, operation, selectorSha256, "drained");
                if (intent is null && drained is not null) throw new IOException("Stop retirement order is invalid.");
                return Observation.RetirementInProgress;
            }
            if (intent is null) {
                if (drained is not null) throw new IOException("Stop journal has a receipt without intent.");
                return Observation.Missing;
            }
            Check(intent, operation, selectorSha256, "intent");
            if (drained is null) return Observation.IntentRecordPresent;
            Check(drained, operation, selectorSha256, "drained");
            return Observation.DrainRecordPresent;
            } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
        }
    }

    // Experimental only. The caller must supply independently acquired and held
    // index/root/session ownership and an actual native/session reconciliation;
    // a journal receipt, a process exit, or a status flag is not that proof.
    // Marker first, then drained -> intent -> marker, makes each interrupted
    // state discoverable. Every retry rechecks the independently held proofs.
    internal static void Retire(string directory, Guid operation, string selectorSha256,
        SelectorIndexOwnership ownership, Func<bool> exactSelector, Func<bool> nativeAndSessionReconciled)
    {
        ArgumentNullException.ThrowIfNull(nativeAndSessionReconciled);
        Validate(directory, operation, selectorSha256, exactSelector);
        ownership.WithHeld(Path.Combine(directory, "index.lock"), () => {
            var selector = Checked(ownership, exactSelector);
            var native = Checked(ownership, nativeAndSessionReconciled);
            lock (Writes) {
                var fence = Hold(directory);
                try {
                    if (!selector() || !native()) throw new IOException("Stop retirement ownership is unavailable.");
                    var found = DiscoverHeld(directory, selectorSha256, selector);
                    if (found is null || found.Value.Operation != operation || found.Value.State is not (Observation.DrainRecordPresent or Observation.RetirementInProgress))
                        throw new IOException("Exact drained stop journal is required.");
                    if (found.Value.State == Observation.DrainRecordPresent) {
                        var marker = JsonSerializer.SerializeToUtf8Bytes(new Record(Owner, operation.ToString("N"), selectorSha256, "retiring"));
                        using (var output = new FileStream(Path.Combine(directory, Leaf(operation, "retiring")), FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { output.Write(marker); output.Flush(true); }
                        var saved = Read(directory, Leaf(operation, "retiring"));
                        if (!selector() || !native() || saved is null || !saved.AsSpan().SequenceEqual(marker)) throw new IOException("Stop retirement marker is uncertain.");
                    }
                    foreach (var step in new[] { "drained", "intent", "retiring" }) {
                        if (!selector() || !native()) throw new IOException("Stop retirement proof changed.");
                        var path = Path.Combine(directory, Leaf(operation, step));
                        if (Read(directory, Leaf(operation, step)) is null) continue;
                        DeleteExact(path, operation, selectorSha256, step);
#if DEBUG
                        AfterRetirementStepForTest?.Invoke(step); ownership.AssertHeldOperationHealthy();
#endif
                    }
                    if (!selector() || !native() || DiscoverHeld(directory, selectorSha256, selector) is not null)
                        throw new IOException("Stop retirement outcome is uncertain.");
                } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
            }
            return true;
        });
    }
#if DEBUG
    internal static Action<string>? AfterRetirementStepForTest;
#endif
    // Request deletion of the validated exact file handle, never a path-based
    // delete after releasing it. Share mode excludes concurrent writers/deletes.
    private static void DeleteExact(string path, Guid operation, string hash, string step)
    {
        using (var handle = CreateFileW(path, 0x80010080, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero)) {
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out var info) || GetFileType(handle) != 1 ||
                (info.Attributes & (0x400u | 0x10u)) != 0 || info.Links != 1) throw new IOException("Stop journal file identity is invalid.");
            var final = new StringBuilder(32768); var length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
            if (length is 0 or >= 32768 || !string.Equals(final.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Stop journal file path changed.");
            using var stream = new FileStream(handle, FileAccess.Read, 4096, false);
            if (stream.Length is < 2 or > 512) throw new IOException("Stop journal size is invalid.");
            var bytes = new byte[(int)stream.Length]; stream.ReadExactly(bytes); Check(bytes, operation, hash, step);
            byte disposition = 1;
            if (!SetFileInformationByHandle(handle, 4, ref disposition, 1)) throw new IOException("Stop journal deletion is uncertain.");
        }
        using var probe = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
        if (!probe.IsInvalid || Marshal.GetLastWin32Error() != 2) throw new IOException("Stop journal deletion is uncertain.");
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation {
        internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
    [DllImport("kernel32.dll")] private static extern uint GetFileType(SafeFileHandle file);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, ref byte disposition, uint length);

    private static void Write(string directory, Guid operation, string selectorSha256, string step,
        SelectorIndexOwnership ownership, Func<bool> exactSelector, Func<bool>? drainConfirmed)
    {
        Validate(directory, operation, selectorSha256, exactSelector);
        ownership.WithHeld(Path.Combine(directory, "index.lock"), () => {
            WriteHeld(directory, operation, selectorSha256, step, Checked(ownership, exactSelector), drainConfirmed is null ? null : Checked(ownership, drainConfirmed));
            return true;
        });
    }
    private static Func<bool> Checked(SelectorIndexOwnership ownership, Func<bool> callback) => () => {
        bool result = callback();
        // Callbacks are caller supplied and Monitor locks are reentrant. Even if
        // they swallow a failed mutation, never continue this journal operation.
        ownership.AssertHeldOperationHealthy();
        return result;
    };
    private static void WriteHeld(string directory, Guid operation, string selectorSha256, string step,
        Func<bool> exactSelector, Func<bool>? drainConfirmed)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new Record(Owner, operation.ToString("N"), selectorSha256, step));
        lock (Writes) {
            var fence = Hold(directory);
            try {
            if (!exactSelector()) throw new IOException("Selector is unavailable.");
            if (step == "intent" && DiscoverHeld(directory, selectorSha256, exactSelector) is not null)
                throw new IOException("An unresolved stop journal already exists.");
            if (step == "drained") {
                if (DiscoverHeld(directory, selectorSha256, exactSelector) != (operation, Observation.IntentRecordPresent))
                    throw new IOException("A single matching stop intent is required.");
                var intent = Read(directory, Leaf(operation, "intent")) ?? throw new IOException("Stop intent is unavailable.");
                Check(intent, operation, selectorSha256, "intent");
                if (drainConfirmed is null || !drainConfirmed()) throw new IOException("Provider drain is not confirmed.");
            }
            var path = Path.Combine(directory, Leaf(operation, step));
            // Never overwrite or delete: interruption/uncertainty is for review.
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
                stream.Write(bytes); stream.Flush(true);
            }
            var observed = Read(directory, Leaf(operation, step));
            if (!exactSelector() || (step == "drained" && !drainConfirmed!()) || observed is null || !observed.AsSpan().SequenceEqual(bytes))
                throw new IOException("Stop journal publication is uncertain; retain it for review.");
            } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
        }
    }
    private static void Validate(string directory, Guid operation, string hash, Func<bool> exactOwner)
    {
        ArgumentNullException.ThrowIfNull(exactOwner);
        if (!Path.IsPathFullyQualified(directory) || directory.StartsWith(@"\\", StringComparison.Ordinal) ||
            !string.Equals(Path.GetFullPath(directory), directory, StringComparison.OrdinalIgnoreCase) ||
            Path.GetFileName(directory) != "connected-explorer-pilot-employee" || operation == Guid.Empty ||
            hash is null || hash.Length != 64 || hash.Any(c => !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))))
            throw new IOException("Stop journal identity is invalid.");
    }
    private static string Leaf(Guid operation, string step) => $"fresh-stop-{operation:N}.{step}.json";
    private static VerifiedInstalledPayload Hold(string directory)
    {
        var fence = new VerifiedInstalledPayload(directory);
        try {
            var ancestors = new Stack<string>();
            for (string? part = directory; part is not null; part = Path.GetDirectoryName(part)) ancestors.Push(part);
            while (ancestors.TryPop(out var part)) fence.HoldDirectory(part);
            return fence;
        } catch { fence.DisposeAsync().GetAwaiter().GetResult(); throw; }
    }
    private static byte[]? Read(string directory, string leaf)
    {
        try { _ = File.GetAttributes(Path.Combine(directory, leaf)); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        var fence = new VerifiedInstalledPayload(directory);
        try {
            var file = fence.HoldFile(leaf);
            if (file.Length is < 2 or > 512) throw new IOException("Stop journal size is invalid.");
            var bytes = new byte[(int)file.Length]; file.ReadExactly(bytes); return bytes;
        } finally { fence.DisposeAsync().GetAwaiter().GetResult(); }
    }
    private static void Check(byte[] bytes, Guid operation, string hash, string step)
    {
        // Byte-exact canonical form rejects unknown, duplicate or malformed fields.
        var expected = JsonSerializer.SerializeToUtf8Bytes(new Record(Owner, operation.ToString("N"), hash, step));
        if (!CryptographicOperations.FixedTimeEquals(bytes, expected)) throw new IOException("Stop journal evidence differs.");
    }
}
