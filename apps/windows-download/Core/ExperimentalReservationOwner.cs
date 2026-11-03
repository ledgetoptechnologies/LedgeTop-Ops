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
    private static readonly HashSet<LeaseReceipt> Receipts = [];
    private readonly object gate = new();
    private readonly HydrationCacheConcurrency.Lease lease;
    private FileStream? entry;
    private ExperimentalEntryLease? ownedEntry;
    private readonly string leaseKey;
    private readonly List<ExperimentalOwnedStream.DirectoryPin> pins = [];
    private readonly string root, path, quotaPath;
    private FileStream? record;
    private SafeFileHandle? uncertainHandle;
    private ExperimentalOwnedStream.Identity recordId;
    private readonly byte[] expected;
    private bool finished, uncertain, injectedDispositionFailure, injectedPostDispositionFailure;
    internal static Action? BeforeDispositionTestHook, AfterDispositionCloseTestHook;
    internal static Action<string>? BeforeTeardownTestHook;
    private readonly long growth;
    internal long Growth { get { lock (gate) { if (finished || uncertain) throw new IOException("Reservation owner unavailable."); return growth; } } }
    internal static int RetainedCount { get { lock (RegistryGate) return Registry.Count + Receipts.Count; } }
    internal sealed class LeaseReceipt : IDisposable
    {
        private readonly object gate = new();
        private HydrationCacheConcurrency.Lease? heldLease;
        private FileStream? heldEntry;
        private ExperimentalEntryLease? heldOwnedEntry;
        private bool active, uncertain;
        internal void Attach(HydrationCacheConcurrency.Lease value, FileStream file) { heldLease = value; heldEntry = file; active = true; }
        internal void Attach(HydrationCacheConcurrency.Lease value, ExperimentalEntryLease file) { heldLease = value; heldOwnedEntry = file; active = true; }
        public void Dispose() {
            lock (gate) {
                if (!active) return;
                if (uncertain) throw new IOException("Experimental returned lease closure remains uncertain.");
                uncertain = true;
                if (heldOwnedEntry is not null) { heldOwnedEntry.Dispose(); heldOwnedEntry = null; }
                else { heldEntry!.Dispose(); heldEntry = null; }
                heldLease!.Dispose(); heldLease = null; active = false; uncertain = false;
                lock (RegistryGate) Receipts.Remove(this);
            }
        }
    }
    internal static Dictionary<string, ExperimentalReservationOwner> SnapshotForRoot(string root)
    {
        ExperimentalReservationOwner[] snapshot;
        lock (RegistryGate) snapshot = Registry.Where(owner => string.Equals(owner.root, root, StringComparison.OrdinalIgnoreCase)).ToArray();
        var result = new Dictionary<string, ExperimentalReservationOwner>(StringComparer.OrdinalIgnoreCase);
        foreach (var owner in snapshot) { owner.Verify(); _ = owner.Growth; if (!result.TryAdd(owner.path, owner)) throw new IOException("Duplicate retained reservation."); }
        return result;
    }
    internal long RecordBytes { get { lock (gate) { if (finished || uncertain) throw new IOException("Reservation owner unavailable."); VerifyCore(); return expected.Length; } } }

    private ExperimentalReservationOwner(HydrationCacheConcurrency.Lease lease, FileStream entry, string path, byte[] expected, long growth, string leaseKey)
    { this.lease = lease; this.entry = entry; this.path = path; this.leaseKey = leaseKey; root = Directory.GetParent(Path.GetDirectoryName(path)!)!.FullName; quotaPath = Path.Combine(Directory.GetParent(Path.GetDirectoryName(path)!)!.FullName, ".hydration-quota-v2.lock"); this.expected = expected; this.growth = growth; }

    private ExperimentalReservationOwner(HydrationCacheConcurrency.Lease lease, ExperimentalEntryLease entry, string path, byte[] expected, long growth, string leaseKey)
    { this.lease = lease; ownedEntry = entry; this.path = path; this.leaseKey = leaseKey; root = Directory.GetParent(Path.GetDirectoryName(path)!)!.FullName; quotaPath = Path.Combine(root, ".hydration-quota-v2.lock"); this.expected = expected; this.growth = growth; }

    internal static ExperimentalReservationOwner CreateWithOwnedEntry(string root, string scope, string key, byte[] bytes, DownloadSpec spec,
        ref HydrationCacheConcurrency.Lease? lease, ref ExperimentalEntryLease? entry, FileStream quota)
    {
        if (lease is null || entry is null || !lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota)) throw new InvalidOperationException("Reservation requires its quota transaction and entry owner.");
        if (!System.Text.RegularExpressions.Regex.IsMatch(scope, "\\A[a-f0-9]{64}\\z") || !System.Text.RegularExpressions.Regex.IsMatch(key, "\\A[a-f0-9]{64}\\z")) throw new IOException("Reservation identity invalid.");
        root = Path.GetFullPath(root);
        if (!string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), Path.Combine(root, ".hydration-quota-v2.lock"), StringComparison.OrdinalIgnoreCase)) throw new IOException("Reservation quota binding invalid.");
        long growth;
        using (var doc = JsonDocument.Parse(bytes)) {
            var node = doc.RootElement; string[] keys = ["Entry", "Growth", "Scope", "Version"];
            if (bytes.Length is <= 0 or > 1024 || node.ValueKind != JsonValueKind.Object ||
                !node.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(keys) || node.GetProperty("Version").GetInt32() != 2 ||
                node.GetProperty("Scope").GetString() != scope || node.GetProperty("Entry").GetString() != key || (growth = node.GetProperty("Growth").GetInt64()) < 0)
                throw new IOException("Reservation metadata invalid.");
        }
        if (growth != checked(spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024)) throw new IOException("Reservation growth does not match its download specification.");
        var path = Path.Combine(root, ".hydration-reservations-v2", scope + "-" + key + ".json");
        ExperimentalReservationOwner? owner = null; var originalLease = lease; var originalEntry = entry;
        originalLease.RunExperimentalForRoot(root, () => {
            originalLease.ExperimentalMarkers.ValidateExisting(Path.GetDirectoryName(path)!, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            var pair = originalLease.TransferExperimentalPair(originalEntry, scope + key);
            owner = new ExperimentalReservationOwner(pair.Admission, pair.Entry, path, bytes.ToArray(), growth, scope + key);
        });
        lease = null; entry = null;
        return CreateRecord(owner!, bytes);
    }

    internal static ExperimentalReservationOwner Create(string root, string scope, string key, byte[] bytes, DownloadSpec spec,
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
        if (growth != checked(spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024))
            throw new IOException("Reservation growth does not match its download specification.");
        var path = Path.Combine(root, ".hydration-reservations-v2", scope + "-" + key + ".json");
        ExperimentalReservationOwner? owner = null;
        var originalLease = lease; var originalEntry = entry;
        originalLease.RunExperimentalForRoot(root, () => {
            originalLease.ExperimentalMarkers.ValidateExisting(Path.GetDirectoryName(path)!, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
            var moved = originalLease.TransferForReservationTest(scope + key);
            owner = new ExperimentalReservationOwner(moved, originalEntry, path, bytes.ToArray(), growth, scope + key);
        });
        lease = null; entry = null;
        return CreateRecord(owner!, bytes);
    }
    private static ExperimentalReservationOwner CreateRecord(ExperimentalReservationOwner result, byte[] bytes)
    {
        lock (RegistryGate) Registry.Add(result);
        try {
            ExperimentalOwnedStream.PinDirectories(Path.GetDirectoryName(result.path)!, result.pins);
            ExperimentalOwnedStream.VerifyPins(result.pins);
            var handle = ExperimentalOwnedStream.Open(result.path, 0xC0010080, 1, 1, 0x00200000);
            result.uncertainHandle = handle; result.uncertain = true;
            result.record = new FileStream(handle, FileAccess.ReadWrite); result.uncertainHandle = null;
            ExperimentalOwnedStream.RequireRegularKind(result.record.SafeFileHandle, false);
            ExperimentalOwnedStream.RequireSingleLink(result.record.SafeFileHandle);
            result.recordId = ExperimentalOwnedStream.GetIdentity(result.record.SafeFileHandle);
            result.record.Write(bytes); result.record.Flush(true); result.VerifyCore(); result.uncertain = false;
            return result;
        } catch {
            if (!result.uncertain) {
                try {
                    foreach (var pin in result.pins.AsEnumerable().Reverse()) pin.Handle.Dispose(); result.pins.Clear();
                    if (result.ownedEntry is not null) { result.ownedEntry.Dispose(); result.ownedEntry = null; }
                    else result.entry!.Dispose();
                    result.lease.Dispose(); result.finished = true;
                    lock (RegistryGate) Registry.Remove(result);
                } catch { result.uncertain = true; }
            }
            throw;
        }
    }
    internal void Verify() { lock (gate) { if (uncertain) throw new IOException("Reservation owner unavailable."); VerifyCore(); } }
    private void VerifyCore()
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
    internal void Release(FileStream quota) => ReleaseCore(quota, returnLeases: false);
    internal LeaseReceipt ReleaseAndReturn(FileStream quota) => ReleaseCore(quota, returnLeases: true)!;
    private LeaseReceipt? ReleaseCore(FileStream quota, bool returnLeases)
    {
        lock (gate) {
        if (!lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota) || !string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), quotaPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Reservation release requires its quota transaction.");
        if (uncertain) throw new IOException("Reservation ownership remains uncertain.");
        Verify(); uncertain = true;
        try { BeforeDispositionTestHook?.Invoke(); } catch { injectedDispositionFailure = true; throw; }
        byte disposition = 1;
        if (!SetFileInformationByHandle(record!.SafeFileHandle, 4, ref disposition, 1)) throw new IOException("Reservation disposition not confirmed.");
        BeforeTeardownTestHook?.Invoke("record");
        record.Dispose(); record = null;
        try { AfterDispositionCloseTestHook?.Invoke(); } catch { injectedPostDispositionFailure = true; throw; }
        return FinishAfterDisposition(returnLeases);
        }
    }
    private LeaseReceipt? FinishAfterDisposition(bool returnLeases = false)
    {
        ExperimentalOwnedStream.VerifyPins(pins);
        using var probe = CreateFileW(PlaceholderHydrationCoordinator.NativeCacheFilePath(path), 0x80, 7, 0, 3, 0x00200000, 0);
        if (!probe.IsInvalid) throw new IOException("Reservation remains present after disposition.");
        if (Marshal.GetLastWin32Error() != 2) throw new IOException("Reservation absence cannot be confirmed.");
        ExperimentalOwnedStream.VerifyPins(pins);
        foreach (var pin in pins.AsEnumerable().Reverse()) { BeforeTeardownTestHook?.Invoke("directory"); pin.Handle.Dispose(); } pins.Clear();
        LeaseReceipt? receipt = null;
        if (returnLeases) {
            receipt = new LeaseReceipt();
            lock (RegistryGate) Receipts.Add(receipt);
            try {
                if (ownedEntry is not null) {
                    var pair = lease.TransferExperimentalPair(ownedEntry, leaseKey);
                    receipt.Attach(pair.Admission, pair.Entry); ownedEntry = null;
                } else {
                    var moved = lease.TransferForReservationTest(leaseKey);
                    receipt.Attach(moved, entry!); entry = null;
                }
            } catch { lock (RegistryGate) Receipts.Remove(receipt); throw; }
        } else {
            BeforeTeardownTestHook?.Invoke("entry");
            if (ownedEntry is not null) { ownedEntry.Dispose(); ownedEntry = null; }
            else { entry!.Dispose(); entry = null; }
            BeforeTeardownTestHook?.Invoke("lease"); lease.Dispose();
        }
        finished = true; uncertain = false;
        lock (RegistryGate) Registry.Remove(this);
        return receipt;
    }
    internal void SettleInjectedPostDispositionFailureForTest(FileStream quota)
    {
        lock (gate) {
            if (!lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota) || !injectedPostDispositionFailure ||
                AfterDispositionCloseTestHook is not null || record is not null ||
                !string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), quotaPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Only an injected post-disposition failure can be settled.");
            FinishAfterDisposition(); injectedPostDispositionFailure = false;
        }
    }
    internal void SettleInjectedDispositionFailureForTest(FileStream quota)
    {
        lock (gate) {
        if (!lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota) || !injectedDispositionFailure || BeforeDispositionTestHook is not null ||
            !string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), quotaPath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Only an injected pre-disposition failure can be settled.");
        VerifyCore(); injectedDispositionFailure = false; uncertain = false;
        Release(quota);
        }
    }
    internal LeaseReceipt SettleInjectedDispositionFailureAndReturnForTest(FileStream quota)
    {
        lock (gate) {
            if (!lease.ExperimentalGateHeld || !Monitor.IsEntered(lease.Quota) || !injectedDispositionFailure || BeforeDispositionTestHook is not null ||
                !string.Equals(ExperimentalOwnedStream.FinalPath(quota.SafeFileHandle), quotaPath, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Only an injected pre-disposition failure can be settled.");
            VerifyCore(); injectedDispositionFailure = false; uncertain = false;
            return ReleaseAndReturn(quota);
        }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint mode, uint flags, nint template);
    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref byte disposition, uint size);
}
#endif
