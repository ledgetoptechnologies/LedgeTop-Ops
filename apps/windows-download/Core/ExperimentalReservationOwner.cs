#if LEDGETOP_CACHE_RACE_TEST
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.WindowsDownload;

// Handle-lifetime experiment only. Not used by the live coordinator.
// The caller must be inside the coordinator's quota transaction and transfer
// its entry FileStream by nulling the original reference before invoking this.
internal sealed class ExperimentalReservationOwner
{
    private static readonly object RegistryGate = new();
    private static readonly HashSet<ExperimentalReservationOwner> Registry = [];
    private readonly HydrationCacheConcurrency.Lease lease;
    private readonly FileStream entry;
    private readonly List<ExperimentalOwnedStream.DirectoryPin> pins = [];
    private readonly string root, path, quotaPath;
    private FileStream? record;
    private SafeFileHandle? uncertainHandle;
    private ExperimentalOwnedStream.Identity recordId;
    private readonly byte[] expected;
    private bool finished, uncertain, injectedDispositionFailure;
    internal static Action? BeforeDispositionTestHook;
    internal long Growth { get; }
    internal static int RetainedCount { get { lock (RegistryGate) return Registry.Count; } }

    private ExperimentalReservationOwner(HydrationCacheConcurrency.Lease lease, FileStream entry, string path, byte[] expected, long growth)
    { this.lease = lease; this.entry = entry; this.path = path; root = Directory.GetParent(Path.GetDirectoryName(path)!)!.FullName; quotaPath = Path.Combine(Directory.GetParent(Path.GetDirectoryName(path)!)!.FullName, ".hydration-quota-v2.lock"); this.expected = expected; Growth = growth; }

    internal static ExperimentalReservationOwner Create(string root, string scope, string key, byte[] bytes,
        ref HydrationCacheConcurrency.Lease? lease, ref FileStream? entry, FileStream quota)
    {
        if (lease is null || entry is null || !lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota)) throw new InvalidOperationException("Reservation requires its quota transaction and entry owner.");
        if (!System.Text.RegularExpressions.Regex.IsMatch(scope, "\\A[a-f0-9]{64}\\z") || !System.Text.RegularExpressions.Regex.IsMatch(key, "\\A[a-f0-9]{64}\\z"))
            throw new IOException("Reservation identity invalid.");
        root = Path.GetFullPath(root);
        var entryPath = Path.Combine(root, scope, key, ".hydration.lock");
        var quotaPath = Path.Combine(root, ".hydration-quota-v2.lock");
        if (!string.Equals(ExperimentalOwnedStream.FinalPath(entry.SafeFileHandle), entryPath, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), quotaPath, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Reservation lease binding invalid.");
        long growth;
        using (var doc = JsonDocument.Parse(bytes)) {
            var node = doc.RootElement; string[] keys = ["Entry", "Growth", "Scope", "Version"];
            if (bytes.Length is <= 0 or > 1024 || node.ValueKind != JsonValueKind.Object ||
                !node.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(keys) ||
                node.GetProperty("Version").GetInt32() != 2 || node.GetProperty("Scope").GetString() != scope ||
                node.GetProperty("Entry").GetString() != key || (growth = node.GetProperty("Growth").GetInt64()) < 0)
                throw new IOException("Reservation metadata invalid.");
        }
        var path = Path.Combine(root, ".hydration-reservations-v2", scope + "-" + key + ".json");
        ExperimentalReservationOwner? owner = null;
        var originalLease = lease; var originalEntry = entry;
        originalLease.RunExperimentalForRoot(root, () => {
            originalLease.ExperimentalMarkers.ValidateExisting(Path.GetDirectoryName(path)!, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            var moved = originalLease.TransferForReservationTest(scope + key);
            owner = new ExperimentalReservationOwner(moved, originalEntry, path, bytes.ToArray(), growth);
        });
        lease = null; entry = null;
        var result = owner!;
        lock (RegistryGate) Registry.Add(result);
        try {
            ExperimentalOwnedStream.PinDirectories(Path.GetDirectoryName(path)!, result.pins);
            ExperimentalOwnedStream.VerifyPins(result.pins);
            var handle = ExperimentalOwnedStream.Open(path, 0xC0010080, 1, 1, 0x00200000);
            result.uncertainHandle = handle; result.uncertain = true;
            result.record = new FileStream(handle, FileAccess.ReadWrite); result.uncertainHandle = null;
            ExperimentalOwnedStream.RequireRegularKind(result.record.SafeFileHandle, false);
            ExperimentalOwnedStream.RequireSingleLink(result.record.SafeFileHandle);
            result.recordId = ExperimentalOwnedStream.GetIdentity(result.record.SafeFileHandle);
            result.record.Write(bytes); result.record.Flush(true); result.Verify(); result.uncertain = false;
            return result;
        } catch {
            if (!result.uncertain) {
                try {
                    foreach (var pin in result.pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); result.pins.Clear();
                    result.entry.Dispose(); result.lease.Dispose(); result.finished = true;
                    lock (RegistryGate) Registry.Remove(result);
                } catch { result.uncertain = true; }
            }
            throw;
        }
    }
    internal void Verify()
    {
        if (finished || record is null) throw new IOException("Reservation owner unavailable.");
        ExperimentalOwnedStream.VerifyPins(pins);
        if (ExperimentalOwnedStream.GetIdentity(record.SafeFileHandle) != recordId ||
            !string.Equals(ExperimentalOwnedStream.FinalPath(record.SafeFileHandle), path, StringComparison.OrdinalIgnoreCase) || record.Length != expected.Length)
            throw new IOException("Reservation binding changed.");
        record.Position = 0; var observed = new byte[expected.Length]; record.ReadExactly(observed);
        if (!observed.AsSpan().SequenceEqual(expected)) throw new IOException("Reservation contents changed.");
    }
    internal void RunWithLeaseForTest(Action action) => lease.RunExperimentalForRoot(root, action);
    internal void Release(FileStream quota)
    {
        if (!lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota) || !string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), quotaPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Reservation release requires its quota transaction.");
        if (uncertain) throw new IOException("Reservation ownership remains uncertain.");
        Verify(); uncertain = true;
        try { BeforeDispositionTestHook?.Invoke(); } catch { injectedDispositionFailure = true; throw; }
        byte disposition = 1;
        if (!SetFileInformationByHandle(record!.SafeFileHandle, 4, ref disposition, 1)) throw new IOException("Reservation disposition not confirmed.");
        record.Dispose(); record = null;
        foreach (var pin in pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); pins.Clear();
        entry.Dispose(); lease.Dispose(); finished = true; uncertain = false;
        lock (RegistryGate) Registry.Remove(this);
    }
    internal void SettleInjectedDispositionFailureForTest(FileStream quota)
    {
        if (!lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota) || !injectedDispositionFailure || BeforeDispositionTestHook is not null ||
            !string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), quotaPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Only an injected pre-disposition failure can be settled.");
        Verify(); injectedDispositionFailure = false; uncertain = false;
        Release(quota);
    }
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref byte disposition, uint size);
}
#endif
