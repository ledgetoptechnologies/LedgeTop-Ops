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
    private static readonly object ReceiptAttachAuthority = new();
    private readonly object gate = new();
    private HydrationCacheConcurrency.Lease lease;
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
    internal static Action? BeforeDispositionTestHook, AfterDispositionCloseTestHook, AfterPairTransferTestHook;
    internal static object? PairTransferTokenTestHook;
    private object? injectedPairToken;
    internal static Action<string>? BeforeTeardownTestHook;
    internal static ManualResetEventSlim? ReceiptQuotaEnteredTestSignal, ReceiptQuotaReleaseTestSignal;
    internal static string? ReceiptQuotaFailureStageTestHook;
    internal static object? ReceiptQuotaFailureTokenTestHook;
    internal static bool ReceiptMarkerFailureTestHook;
    internal static object? ReceiptMarkerFailureTokenTestHook;
    private readonly long growth;
    internal long Growth { get { lock (gate) { if (finished || uncertain) throw new IOException("Reservation owner unavailable."); return growth; } } }
    internal static int RetainedCount { get { lock (RegistryGate) return Registry.Count + Receipts.Count; } }
    internal sealed class LeaseReceipt : IDisposable
    {
        private readonly object gate = new();
        private readonly string root, key;
        private HydrationCacheConcurrency.Lease? heldLease;
        private FileStream? heldEntry;
        private ExperimentalEntryLease? heldOwnedEntry;
        private SafeFileHandle? uncertainQuota;
        private ExperimentalOwnedStream.Identity quotaIdentity;
        private object? injectedQuotaToken, injectedMarkerToken;
        private string? injectedMarkerDirectory;
        private bool active, uncertain, executing;
        internal LeaseReceipt(string root, string key, object authority) {
            if (!ReferenceEquals(authority, ReceiptAttachAuthority)) throw new InvalidOperationException("Receipt authority invalid.");
            this.root = root; this.key = key;
        }
        private T Execute<T>(string requestedRoot, string requestedKey, Func<T> operation)
        {
            lock (gate) {
                if (!active || uncertain || heldLease is null || heldOwnedEntry is null) throw new ObjectDisposedException(nameof(LeaseReceipt));
                if (executing) throw new InvalidOperationException("Experimental receipt operation is already active.");
                if (!string.Equals(root, Path.GetFullPath(requestedRoot), StringComparison.OrdinalIgnoreCase) || key != requestedKey)
                    throw new TransferException("Experimental receipt does not match its entry.");
                executing = true; T result = default!;
                try { heldLease.RunExperimentalForEntry(root, key, () => { try { heldOwnedEntry.Validate(); } catch { uncertain = true; throw; } result = operation(); }); }
                finally { executing = false; }
                return result;
            }
        }
        internal void ValidateEntry(string root, string key) => Execute(root, key, () => true);
        internal long AccountMarker(string root, string key, string directory) => Execute(root, key, () => {
            try {
                var length = heldLease!.ExperimentalMarkers.AccountMarker(Path.Combine(directory, ".verified-hydration-owner"));
                if (ReceiptMarkerFailureTestHook) {
                    injectedMarkerToken = ReceiptMarkerFailureTokenTestHook; injectedMarkerDirectory = Path.GetFullPath(directory);
                    throw new IOException("Injected receipt marker failure.");
                }
                return length;
            } catch { uncertain = true; throw; }
        });
        // Read-only observation; a later mutation must repeat admission in its own quota transaction.
        internal bool InspectCapacityForTest(string root, string key, PlaceholderHydrationCoordinator coordinator, long growth, CancellationToken token = default) => Execute(root, key, () => {
            ArgumentNullException.ThrowIfNull(coordinator);
            if (growth < 0) throw new ArgumentOutOfRangeException(nameof(growth));
            return RunQuota(quota => coordinator.ExperimentalCanReserveUnderOwnedQuota(heldLease!, quota, growth), token);
        });
        internal long AccountMarkerUnderQuota(string root, string key, string directory, CancellationToken token = default) => Execute(root, key, () =>
            RunQuota(_ => heldLease!.ExperimentalMarkers.AccountMarker(Path.Combine(directory, ".verified-hydration-owner")), token));
        private T RunQuota<T>(Func<SafeFileHandle, T> operation, CancellationToken token)
        {
            T result = default!;
            HydrationQuotaGate.Run(heldLease!.Quota, () => {
                uncertain = true;
                heldOwnedEntry!.Validate();
                heldLease.ExperimentalMarkers.ValidateExisting(root, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                var path = Path.Combine(root, ".hydration-quota-v2.lock");
                uncertainQuota = ExperimentalOwnedStream.Open(path, 0xC0000080, 0, 4, 0x00200000);
                quotaIdentity = ExperimentalOwnedStream.GetIdentity(uncertainQuota);
                InjectQuotaFailureForTest("validation");
                ExperimentalOwnedStream.RequireRegularKind(uncertainQuota, false); ExperimentalOwnedStream.RequireSingleLink(uncertainQuota);
                if (!string.Equals(ExperimentalOwnedStream.FinalPath(uncertainQuota), path, StringComparison.OrdinalIgnoreCase)) throw new IOException("Experimental quota binding changed.");
                if (ReceiptQuotaEnteredTestSignal is not null) {
                    ReceiptQuotaEnteredTestSignal.Set();
                    if (ReceiptQuotaReleaseTestSignal is null || !ReceiptQuotaReleaseTestSignal.Wait(TimeSpan.FromSeconds(10))) throw new IOException("Synthetic receipt barrier timed out.");
                }
                result = operation(uncertainQuota);
                heldOwnedEntry.Validate(); InjectQuotaFailureForTest("close");
                uncertainQuota.Dispose(); uncertainQuota = null; uncertain = false;
            }, token);
            return result;
        }
        internal void SettleInjectedMarkerFailureForTest(object token) {
            lock (gate) {
                if (!active || !uncertain || !ReferenceEquals(injectedMarkerToken, token) || token is null || ReceiptMarkerFailureTestHook ||
                    injectedMarkerDirectory is null || uncertainQuota is not null || heldLease is null || heldOwnedEntry is null)
                    throw new InvalidOperationException("Only an injected marker failure can be settled.");
                heldLease.RunExperimentalForEntry(root, key, () => {
                    heldOwnedEntry.Validate();
                    heldLease.ExperimentalMarkers.ValidateExisting(injectedMarkerDirectory, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                    injectedMarkerDirectory = null; injectedMarkerToken = null; uncertain = false;
                });
            }
        }
        private void InjectQuotaFailureForTest(string stage) {
            if (ReceiptQuotaFailureStageTestHook != stage) return;
            injectedQuotaToken = ReceiptQuotaFailureTokenTestHook;
            throw new IOException("Injected receipt quota " + stage + " failure.");
        }
        internal void SettleInjectedQuotaFailureForTest(object token) {
            lock (gate) {
                if (!active || !uncertain || !ReferenceEquals(injectedQuotaToken, token) || token is null || ReceiptQuotaFailureStageTestHook is not null ||
                    uncertainQuota is null || heldLease is null || heldOwnedEntry is null) throw new InvalidOperationException("Only an injected quota failure can be settled.");
                heldLease.RunExperimentalForEntry(root, key, () => {
                    heldOwnedEntry.Validate();
                    heldLease.ExperimentalMarkers.ValidateExisting(root, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                    ExperimentalOwnedStream.RequireRegularKind(uncertainQuota, false); ExperimentalOwnedStream.RequireSingleLink(uncertainQuota);
                    if (ExperimentalOwnedStream.GetIdentity(uncertainQuota) != quotaIdentity ||
                        !string.Equals(ExperimentalOwnedStream.FinalPath(uncertainQuota), Path.Combine(root, ".hydration-quota-v2.lock"), StringComparison.OrdinalIgnoreCase))
                        throw new IOException("Experimental quota binding changed.");
                    uncertainQuota.Dispose(); uncertainQuota = null; injectedQuotaToken = null; uncertain = false;
                });
            }
        }
        private void CheckAttach(object authority) {
            if (!ReferenceEquals(authority, ReceiptAttachAuthority) || active || uncertain || heldLease is not null || heldEntry is not null || heldOwnedEntry is not null)
                throw new InvalidOperationException("Receipt attachment is not permitted.");
            lock (RegistryGate) if (!Receipts.Contains(this)) throw new InvalidOperationException("Receipt is not registered.");
        }
        internal void Attach(HydrationCacheConcurrency.Lease value, FileStream file, object authority) { lock (gate) { CheckAttach(authority); ArgumentNullException.ThrowIfNull(value); ArgumentNullException.ThrowIfNull(file); heldLease = value; heldEntry = file; active = true; } }
        internal void Attach(HydrationCacheConcurrency.Lease value, ExperimentalEntryLease file, object authority) { lock (gate) { CheckAttach(authority); ArgumentNullException.ThrowIfNull(value); ArgumentNullException.ThrowIfNull(file); heldLease = value; heldOwnedEntry = file; active = true; } }
        public void Dispose() {
            lock (gate) {
                if (!active) return;
                if (executing) throw new InvalidOperationException("Experimental receipt scope is active.");
                if (uncertain) throw new IOException("Experimental returned lease closure remains uncertain.");
                uncertain = true;
                if (heldOwnedEntry is not null) { heldOwnedEntry.Dispose(); heldOwnedEntry = null; }
                else { heldEntry!.Dispose(); heldEntry = null; }
                heldLease!.Dispose(); heldLease = null; active = false; uncertain = false;
                lock (RegistryGate) Receipts.Remove(this);
            }
        }
    }
    internal static void ExerciseReceiptReattachGuardForTest(LeaseReceipt receipt) => receipt.Attach(null!, (ExperimentalEntryLease)null!, ReceiptAttachAuthority);
    internal static Dictionary<string, ExperimentalReservationOwner> SnapshotForRoot(string root)
    {
        ExperimentalReservationOwner[] snapshot;
        lock (RegistryGate) snapshot = Registry.Where(owner => string.Equals(owner.root, root, StringComparison.OrdinalIgnoreCase)).ToArray();
        var result = new Dictionary<string, ExperimentalReservationOwner>(StringComparer.OrdinalIgnoreCase);
        foreach (var owner in snapshot) { owner.Verify(); _ = owner.Growth; if (!result.TryAdd(owner.path, owner)) throw new IOException("Duplicate retained reservation."); }
        return result;
    }
    internal static ExperimentalReservationOwner FindInjectedPairFailureForTest(object token)
    {
        lock (RegistryGate) {
            var matches = Registry.Where(owner => ReferenceEquals(owner.injectedPairToken, token)).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("Injected pair failure is not unique.");
            return matches[0];
        }
    }
    internal void SettleInjectedPairFailureForTest(object token)
    {
        lease.RunExperimentalForRoot(root, () => {
            lock (gate) {
                if (!ReferenceEquals(injectedPairToken, token) || token is null || AfterPairTransferTestHook is not null ||
                    record is not null || uncertainHandle is not null || pins.Count != 0 || ownedEntry is null)
                    throw new InvalidOperationException("Only an injected pre-record pair handoff can be settled.");
                ownedEntry.Dispose(); ownedEntry = null; lease.Dispose(); finished = true; uncertain = false; injectedPairToken = null;
                lock (RegistryGate) Registry.Remove(this);
            }
        });
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
        var originalLease = lease; var originalEntry = entry;
        var owner = new ExperimentalReservationOwner(originalLease, originalEntry, path, bytes.ToArray(), growth, scope + key);
        lock (RegistryGate) Registry.Add(owner);
        var transferred = false;
        try {
            originalLease.RunExperimentalForRoot(root, () => {
                originalLease.ExperimentalMarkers.ValidateExisting(Path.GetDirectoryName(path)!, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                _ = originalLease.TransferExperimentalPair(originalEntry, scope + key, (nextLease, nextEntry) => { owner.lease = nextLease; owner.ownedEntry = nextEntry; });
                transferred = true;
            });
            lease = null; entry = null;
            try { AfterPairTransferTestHook?.Invoke(); }
            catch { owner.injectedPairToken = PairTransferTokenTestHook; owner.uncertain = true; throw; }
            return CreateRecord(owner, bytes);
        } catch {
            if (!transferred) lock (RegistryGate) Registry.Remove(owner);
            throw;
        }
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
            receipt = new LeaseReceipt(root, leaseKey, ReceiptAttachAuthority);
            lock (RegistryGate) Receipts.Add(receipt);
            try {
                if (ownedEntry is not null) {
                    _ = lease.TransferExperimentalPair(ownedEntry, leaseKey, (nextLease, nextEntry) => receipt.Attach(nextLease, nextEntry, ReceiptAttachAuthority));
                    ownedEntry = null;
                } else {
                    var moved = lease.TransferForReservationTest(leaseKey);
                    receipt.Attach(moved, entry!, ReceiptAttachAuthority); entry = null;
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
