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
    private static readonly HashSet<LeaseReceipt.DownloadSession> DownloadSessions = [];
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
    internal static ManualResetEventSlim? ReceiptStageBeforeCreateTestSignal, ReceiptStageBeforeCreateReleaseTestSignal;
    internal static ManualResetEventSlim? ReceiptStageAfterWriteTestSignal, ReceiptStageAfterWriteReleaseTestSignal;
    internal static object? ReceiptStagePreCreateTokenTestHook;
    internal static string? ReceiptQuotaFailureStageTestHook;
    internal static object? ReceiptQuotaFailureTokenTestHook;
    internal static bool ReceiptMarkerFailureTestHook, ReceiptCleanupFailureTestHook;
    internal static object? ReceiptMarkerFailureTokenTestHook;
    private readonly long growth;
    internal long Growth { get { lock (gate) { if (finished || uncertain) throw new IOException("Reservation owner unavailable."); return growth; } } }
    internal static int RetainedCount { get { lock (RegistryGate) return Registry.Count + Receipts.Count + DownloadSessions.Count; } }
    internal sealed class LeaseReceipt : IDisposable
    {
        private readonly object gate = new();
        private readonly string root, key;
        private HydrationCacheConcurrency.Lease? heldLease;
        private FileStream? heldEntry;
        private ExperimentalEntryLease? heldOwnedEntry;
        private SafeFileHandle? uncertainQuota, stagedHandle;
        private FileStream? stagedRecord;
        private string? stagedPath;
        private byte[]? stagedBytes;
        private ExperimentalOwnedStream.Identity stagedIdentity;
        private bool stagedVerified, quotaInProgress;
        private long stagedGrowth;
        private List<ExperimentalOwnedStream.DirectoryPin>? stagedPins;
        private ExperimentalOwnedStream.Identity quotaIdentity;
        private object? injectedQuotaToken, injectedMarkerToken;
        private string? injectedMarkerDirectory;
        private bool active, uncertain, executing;
        private DownloadUse? downloadUse;
        private void SetReceiptStatus(bool? newUncertain = null, bool? newQuotaInProgress = null)
        {
            var status = heldLease?.ExperimentalStatus ?? throw new InvalidOperationException("Receipt status root unavailable.");
            lock (status.Gate) {
                if (newUncertain.HasValue) uncertain = newUncertain.Value;
                if (newQuotaInProgress.HasValue) quotaInProgress = newQuotaInProgress.Value;
                if (status.Revision == long.MaxValue) status.Poisoned = true; else status.Revision++;
            }
        }
        internal LeaseReceipt(string root, string key, object authority) {
            if (!ReferenceEquals(authority, ReceiptAttachAuthority)) throw new InvalidOperationException("Receipt authority invalid.");
            this.root = root; this.key = key;
        }
        // Lifetime guard for a future synthetic async download. It exposes no
        // stream, admission, entry handle, callback, or authorization result.
        internal sealed class DownloadUse : IDisposable
        {
            private readonly LeaseReceipt owner;
            internal DownloadUse(LeaseReceipt owner, object authority) {
                if (!ReferenceEquals(authority, ReceiptAttachAuthority)) throw new InvalidOperationException("Download use authority invalid.");
                this.owner = owner;
            }
            internal void ValidateEntry() => owner.ValidateDownloadUse(this);
            public void Dispose() => owner.EndDownloadUse(this);
        }
        internal sealed class DownloadSession
        {
            private readonly LeaseReceipt owner; private readonly DownloadUse use; private readonly Downloader downloader;
            private readonly DownloadSpec spec; private readonly PlaceholderIdentity identity; private readonly string entryDirectory, expectedPath;
            private readonly PlaceholderHydrationCoordinator? transferCoordinator; private readonly IPlaceholderTransferSink? transferSink;
            private readonly long transferOffset, transferLength;
            private Task? task; private Task? cancellationTask; private int started;
            private readonly object cancellationGate = new(); private readonly CancellationTokenSource workerCancellation = new(); private bool workerFinished;
            internal DownloadSession(LeaseReceipt owner, DownloadUse use, Downloader downloader, PlaceholderIdentity identity, DownloadSpec spec, string entryDirectory, object authority, PlaceholderHydrationCoordinator? transferCoordinator = null, IPlaceholderTransferSink? transferSink = null, long transferOffset = 0, long transferLength = 0) {
                if (!ReferenceEquals(authority, ReceiptAttachAuthority)) throw new InvalidOperationException("Download session authority invalid.");
                this.owner = owner; this.use = use; this.downloader = downloader; this.identity = identity; this.spec = spec; this.entryDirectory = entryDirectory;
                this.transferCoordinator = transferCoordinator; this.transferSink = transferSink;
                this.transferOffset = transferOffset; this.transferLength = transferLength;
                expectedPath = Path.Combine(entryDirectory, spec.FileName);
            }
            internal void Start() { if (Interlocked.Exchange(ref started, 1) != 0) throw new InvalidOperationException("Synthetic download session already started."); task = FinishAsync(Task.Run(RunAsync)); _ = task.ContinueWith(completed => _ = completed.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default); }
            private async Task RunAsync() {
                VerifiedHydrationDownload? download = null; var terminal = false;
                try {
                    using (HydrationMutationScope.Begin((action, token) => owner.RunDownloadMutation(use, action, token), workerCancellation.Token))
                        download = await downloader.DownloadVerifiedForHydrationAsync(spec, entryDirectory, workerCancellation.Token).ConfigureAwait(false);
                    if (!string.Equals(Path.GetFullPath(download.Path), expectedPath, StringComparison.OrdinalIgnoreCase) || download.Stream.CanWrite || download.Stream.Length != spec.Length)
                        throw new IOException("Synthetic download result changed.");
                    if (!download.IntegrityVerified && !System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(
                        await System.Security.Cryptography.SHA256.HashDataAsync(download.Stream).ConfigureAwait(false), Convert.FromHexString(spec.Sha256)))
                        throw new IOException("Synthetic download integrity failed.");
                    if (transferCoordinator is not null && transferSink is not null) {
                        await transferCoordinator.ExperimentalAuthorizeReceiptTransferAsync(identity, spec, workerCancellation.Token).ConfigureAwait(false);
                        owner.RunDownloadMutation(use, () => owner.VerifyStagedDuringDownload(identity, spec), workerCancellation.Token);
                        await PlaceholderHydrationCoordinator.TransferVerifiedRange(download.Stream, transferOffset, transferLength, transferSink, workerCancellation.Token).ConfigureAwait(false);
                        workerCancellation.Token.ThrowIfCancellationRequested(); terminal = true;
                        await transferSink.CompleteAsync(workerCancellation.Token).ConfigureAwait(false);
                    }
                } catch (Exception e) {
                    if (transferSink is not null && !terminal) { terminal = true; try { await transferSink.FailAsync(e is OperationCanceledException ? "cancelled" : "unavailable").ConfigureAwait(false); } catch { } }
                    throw;
                } finally {
                    if (download is not null) {
                        try { await download.DisposeAsync().ConfigureAwait(false); }
                        catch { owner.MarkDownloadUncertain(use); throw; }
                    }
                }
            }
            // Keep all session ownership until both the worker and any cancellation callbacks
            // have actually settled. A blocked callback must never release the receipt early.
            private async Task FinishAsync(Task worker) {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo? failure = null;
                try { await worker.ConfigureAwait(false); }
                catch (Exception ex) { failure = System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(ex); }
                Task? pendingCancellation;
                lock (cancellationGate) { workerFinished = true; pendingCancellation = cancellationTask; }
                try {
                    if (pendingCancellation is not null) await pendingCancellation.ConfigureAwait(false);
                    downloader.Dispose();
                    lock (cancellationGate) workerCancellation.Dispose();
                    use.Dispose();
                } catch { owner.MarkDownloadUncertain(use); throw; }
                lock (RegistryGate) DownloadSessions.Remove(this);
                failure?.Throw();
            }
            internal bool Matches(string root, PlaceholderIdentity expectedIdentity, DownloadSpec? expectedSpec = null) =>
                identity == expectedIdentity && (expectedSpec is null || spec == expectedSpec) &&
                string.Equals(entryDirectory, Path.Combine(root, expectedIdentity.ScopeKey, expectedIdentity.CacheKey), StringComparison.OrdinalIgnoreCase);
            internal void VerifyStagedForTest(string root, PlaceholderIdentity expectedIdentity, DownloadSpec expectedSpec, CancellationToken token) {
                if (!Matches(root, expectedIdentity, expectedSpec)) throw new ResourceUnavailableException();
                owner.VerifySyntheticReservationForTest(root, expectedIdentity, expectedSpec, token);
            }
            internal async Task<bool> CancelWorkerAndWaitAsync(TimeSpan timeout, CancellationToken waitToken = default) {
                if (timeout <= TimeSpan.Zero || timeout > TimeSpan.FromSeconds(10)) throw new ArgumentOutOfRangeException(nameof(timeout));
                var running = task ?? throw new InvalidOperationException("Synthetic download session did not start.");
                lock (cancellationGate) { if (!workerFinished && cancellationTask is null) cancellationTask = Task.Run(() => workerCancellation.Cancel()); }
                try { await running.WaitAsync(timeout, waitToken).ConfigureAwait(false); return true; }
                catch (TimeoutException) when (!waitToken.IsCancellationRequested && !running.IsCompleted) { return false; }
                catch (OperationCanceledException) when (!waitToken.IsCancellationRequested && running.IsCompleted) { return true; }
                catch (Exception) when (!waitToken.IsCancellationRequested && running.IsCompleted) { return true; }
            }
            internal async Task WaitAsync(CancellationToken waitToken = default) {
                var running = task ?? throw new InvalidOperationException("Synthetic download session did not start.");
                await running.WaitAsync(waitToken).ConfigureAwait(false);
            }
        }
        internal DownloadSession StartSyntheticDownloadForTest(string requestedRoot, PlaceholderIdentity identity, DownloadSpec spec, SyntheticReceiptDownloadSource source, object authority, PlaceholderHydrationCoordinator? transferCoordinator = null, IPlaceholderTransferSink? transferSink = null, long transferOffset = 0, long transferLength = 0)
        {
            ArgumentNullException.ThrowIfNull(source);
            if (!PlaceholderHydrationCoordinator.IsExperimentalDownloadAuthority(authority)) throw new InvalidOperationException("Synthetic download authorization is unavailable.");
            lock (gate) {
                VerifySyntheticReservationForTest(requestedRoot, identity, spec);
                var use = BeginSyntheticDownloadUse(requestedRoot, identity.ScopeKey + identity.CacheKey);
                Downloader downloader;
                try { downloader = source.Claim(spec); } catch { use.Dispose(); throw; }
                var session = new DownloadSession(this, use, downloader, identity, spec, Path.Combine(root, identity.ScopeKey, identity.CacheKey), ReceiptAttachAuthority, transferCoordinator, transferSink, transferOffset, transferLength);
                lock (RegistryGate) DownloadSessions.Add(session);
                session.Start(); return session;
            }
        }
        private void VerifyStagedDuringDownload(PlaceholderIdentity identity, DownloadSpec spec) {
            var growth = checked(spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024);
            var expected = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identity.ScopeKey, Entry = identity.CacheKey, Growth = growth });
            var path = Path.Combine(root, ".hydration-reservations-v2", identity.ScopeKey + "-" + identity.CacheKey + ".json");
            if (!stagedVerified || stagedBytes is null || stagedPath is null || !stagedBytes.AsSpan().SequenceEqual(expected) ||
                !string.Equals(stagedPath, path, StringComparison.OrdinalIgnoreCase)) throw new ResourceUnavailableException();
            VerifyStagedRecord();
        }
        private void MarkDownloadUncertain(DownloadUse use) { lock (gate) { if (ReferenceEquals(downloadUse, use)) SetReceiptStatus(newUncertain: true); } }
        private void RunDownloadMutation(DownloadUse use, Action action, CancellationToken token)
        {
            lock (gate) {
                if (!active || uncertain || !ReferenceEquals(downloadUse, use) || heldLease is null || heldOwnedEntry is null)
                    throw new IOException("Synthetic download ownership is unavailable.");
                heldLease.RunExperimentalForEntry(root, key, () => RunQuota(_ => { action(); return true; }, token));
            }
        }
        internal DownloadUse BeginSyntheticDownloadUse(string requestedRoot, string requestedKey)
        {
            lock (gate) {
                if (!active || uncertain || heldLease is null || heldOwnedEntry is null) throw new ObjectDisposedException(nameof(LeaseReceipt));
                if (executing || downloadUse is not null) throw new InvalidOperationException("Receipt already has an active operation.");
                if (!string.Equals(root, Path.GetFullPath(requestedRoot), StringComparison.OrdinalIgnoreCase) || key != requestedKey)
                    throw new TransferException("Experimental receipt does not match its entry.");
                heldLease.RunExperimentalForEntry(root, key, () => { try { heldOwnedEntry.Validate(); } catch { SetReceiptStatus(newUncertain: true); throw; } });
                var use = new DownloadUse(this, ReceiptAttachAuthority); downloadUse = use; return use;
            }
        }
        private void ValidateDownloadUse(DownloadUse use)
        {
            lock (gate) {
                if (!active || uncertain || !ReferenceEquals(downloadUse, use) || heldLease is null || heldOwnedEntry is null)
                    throw new ObjectDisposedException(nameof(DownloadUse));
                heldLease.RunExperimentalForEntry(root, key, () => { try { heldOwnedEntry.Validate(); } catch { SetReceiptStatus(newUncertain: true); throw; } });
            }
        }
        private void EndDownloadUse(DownloadUse use)
        {
            lock (gate) {
                if (!ReferenceEquals(downloadUse, use)) throw new ObjectDisposedException(nameof(DownloadUse));
                if (uncertain) throw new IOException("Experimental download use remains uncertain.");
                downloadUse = null;
            }
        }
        private T Execute<T>(string requestedRoot, string requestedKey, Func<T> operation)
        {
            lock (gate) {
                if (!active || uncertain || heldLease is null || heldOwnedEntry is null) throw new ObjectDisposedException(nameof(LeaseReceipt));
                if (executing || downloadUse is not null) throw new InvalidOperationException("Experimental receipt operation is already active.");
                if (!string.Equals(root, Path.GetFullPath(requestedRoot), StringComparison.OrdinalIgnoreCase) || key != requestedKey)
                    throw new TransferException("Experimental receipt does not match its entry.");
                executing = true; T result = default!;
                try { heldLease.RunExperimentalForEntry(root, key, () => { try { heldOwnedEntry.Validate(); } catch { SetReceiptStatus(newUncertain: true); throw; } result = operation(); }); }
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
            } catch { SetReceiptStatus(newUncertain: true); throw; }
        });
        // Read-only observation; a later mutation must repeat admission in its own quota transaction.
        internal bool InspectCapacityForTest(string root, string key, PlaceholderHydrationCoordinator coordinator, long growth, CancellationToken token = default) => Execute(root, key, () => {
            ArgumentNullException.ThrowIfNull(coordinator);
            if (growth < 0) throw new ArgumentOutOfRangeException(nameof(growth));
            return RunQuota(quota => coordinator.ExperimentalCapacityUnderOwnedQuota(heldLease!, quota, growth).Fits, token);
        });
        internal long AccountMarkerUnderQuota(string root, string key, string directory, CancellationToken token = default) => Execute(root, key, () =>
            RunQuota(_ => heldLease!.ExperimentalMarkers.AccountMarker(Path.Combine(directory, ".verified-hydration-owner")), token));
        // Mechanics-only: accepts synthetic input, not an authorization proof.
        // A live staged record cannot yet participate in the coordinator ledger.
        internal bool StageSyntheticReservationForTest(string root, PlaceholderIdentity identity, DownloadSpec spec, PlaceholderHydrationCoordinator coordinator, CancellationToken token = default) =>
            Execute(root, identity.ScopeKey + identity.CacheKey, () => {
                if (stagedRecord is not null || stagedHandle is not null) throw new InvalidOperationException("A synthetic staged record already exists.");
                identity.Encode(); ArgumentNullException.ThrowIfNull(coordinator);
                if (!spec.ContentUri.IsAbsoluteUri || spec.ContentUri.Scheme != "https" || spec.ContentUri.UserInfo.Length != 0 || spec.ContentUri.Fragment.Length != 0 || !spec.ContentUri.Host.EndsWith(".invalid", StringComparison.OrdinalIgnoreCase) ||
                    spec.ContentUri.GetLeftPart(UriPartial.Authority) != identity.Origin || spec.OpaqueIdentity != identity.LogicalFileId + ":" + identity.RemoteVersion ||
                    spec.FileName != identity.FileName || spec.Length != identity.Length || spec.ETag != identity.ETag || spec.Sha256 != identity.Sha256)
                    throw new TransferException("Synthetic reservation identity does not match its specification.");
                var growth = checked(spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024);
                return RunQuota(quota => {
                    var capacity = coordinator.ExperimentalCapacityUnderOwnedQuota(heldLease!, quota, growth);
                    if (!capacity.Fits) return false;
                    if (ReceiptStageBeforeCreateTestSignal is not null) {
                        ReceiptStageBeforeCreateTestSignal.Set();
                        if (ReceiptStageBeforeCreateReleaseTestSignal is null || !ReceiptStageBeforeCreateReleaseTestSignal.Wait(TimeSpan.FromSeconds(10))) throw new IOException("Synthetic stage barrier timed out.");
                    }
                    var status = heldLease!.ExperimentalStatus;
                    lock (status.Gate) {
                        if (status.Poisoned || status.Revision != capacity.Revision) {
                            if (ReceiptStageBeforeCreateTestSignal is not null) injectedQuotaToken = ReceiptStagePreCreateTokenTestHook;
                            throw new TransferException("Synthetic receipt status changed before creation.");
                        }
                    }
                    var dir = Path.Combine(this.root, ".hydration-reservations-v2");
                    heldLease!.ExperimentalMarkers.ValidateExisting(dir, ".verified-hydration-owner", "LedgeTop.VerifiedHydration/1\n"u8.ToArray());
                    var path = Path.Combine(dir, identity.ScopeKey + "-" + identity.CacheKey + ".json");
                    var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identity.ScopeKey, Entry = identity.CacheKey, Growth = growth });
                    if (bytes.Length > 1024) throw new IOException("Synthetic reservation metadata exceeds its bound.");
                    stagedPins = [];
                    ExperimentalOwnedStream.PinDirectories(dir, stagedPins); ExperimentalOwnedStream.VerifyPins(stagedPins);
                    try { stagedHandle = ExperimentalOwnedStream.Open(path, 0xC0010080, 1, 1, 0x00200000); }
                    catch (IOException error) when (error.HResult is 80 or 183) {
                        foreach (var pin in stagedPins.AsEnumerable().Reverse()) pin.Handle.Dispose(); stagedPins = null; return false;
                    }
                    stagedPath = path; stagedBytes = bytes; stagedGrowth = growth;
                    stagedRecord = new FileStream(stagedHandle, FileAccess.ReadWrite); stagedHandle = null;
                    ExperimentalOwnedStream.RequireRegularKind(stagedRecord.SafeFileHandle, false); ExperimentalOwnedStream.RequireSingleLink(stagedRecord.SafeFileHandle);
                    stagedIdentity = ExperimentalOwnedStream.GetIdentity(stagedRecord.SafeFileHandle);
                    stagedRecord.Write(bytes); stagedRecord.Flush(true); VerifyStagedRecord();
                    if (ReceiptStageAfterWriteTestSignal is not null) {
                        ReceiptStageAfterWriteTestSignal.Set();
                        if (ReceiptStageAfterWriteReleaseTestSignal is null || !ReceiptStageAfterWriteReleaseTestSignal.Wait(TimeSpan.FromSeconds(10))) throw new IOException("Synthetic stage write barrier timed out.");
                    }
                    // Linearization point: only a matching revision may publish a
                    // fully flushed record as verified. No filesystem I/O holds this lock.
                    lock (status.Gate) {
                        if (status.Poisoned || status.Revision != capacity.Revision) throw new TransferException("Synthetic receipt status changed during creation.");
                        stagedVerified = true;
                    }
                    return true;
                }, token);
            });
        // Caller holds the root quota monitor; deliberately does not acquire the
        // receipt gate because another receipt may hold it while waiting for quota.
        private StagedSnapshot? SnapshotStagedUnderQuota(string requestedRoot, object quota)
        {
            if (!Monitor.IsEntered(quota)) throw new InvalidOperationException("Synthetic ledger requires the root quota gate.");
            if (!string.Equals(root, requestedRoot, StringComparison.OrdinalIgnoreCase)) return null;
            var admission = heldLease;
            if (admission is not null) lock (admission.ExperimentalStatus.Gate) {
                if (uncertain && !quotaInProgress) throw new IOException("Synthetic receipt remains uncertain.");
            }
            if (stagedPath is null && stagedRecord is null && stagedHandle is null) {
                if (stagedPins is not null) throw new IOException("Synthetic staged directory ownership remains uncertain.");
                return null;
            }
            if (admission is null || !ReferenceEquals(admission.Quota, quota)) throw new IOException("Synthetic staged quota root changed.");
            lock (admission.ExperimentalStatus.Gate) {
                if ((uncertain && !quotaInProgress) || !stagedVerified || stagedHandle is not null || stagedBytes is null || stagedPath is null)
                    throw new IOException("Synthetic staged reservation remains uncertain.");
            }
            VerifyStagedRecord(); return new(stagedPath, stagedBytes.Length, stagedGrowth);
        }
        internal static Dictionary<string, StagedSnapshot> SnapshotForRootUnderQuota(string root, object quota)
        {
            if (!Monitor.IsEntered(quota)) throw new InvalidOperationException("Synthetic ledger requires the root quota gate.");
            LeaseReceipt[] receipts;
            lock (RegistryGate) receipts = Receipts.ToArray();
            var result = new Dictionary<string, StagedSnapshot>(StringComparer.OrdinalIgnoreCase);
            foreach (var receipt in receipts) {
                var snapshot = receipt.SnapshotStagedUnderQuota(root, quota);
                if (snapshot is { } value && !result.TryAdd(value.Path, value)) throw new IOException("Duplicate synthetic staged reservation.");
            }
            return result;
        }
        internal void VerifySyntheticReservationForTest(string root, PlaceholderIdentity identity, DownloadSpec spec, CancellationToken token = default) =>
            Execute(root, identity.ScopeKey + identity.CacheKey, () => RunQuota(_ => {
                identity.Encode();
                if (spec.OpaqueIdentity != identity.LogicalFileId + ":" + identity.RemoteVersion || spec.FileName != identity.FileName ||
                    spec.Length != identity.Length || spec.ETag != identity.ETag || spec.Sha256 != identity.Sha256 ||
                    !spec.ContentUri.IsAbsoluteUri || spec.ContentUri.Scheme != "https" || spec.ContentUri.UserInfo.Length != 0 || spec.ContentUri.Fragment.Length != 0 ||
                    spec.ContentUri.GetLeftPart(UriPartial.Authority) != identity.Origin || !spec.ContentUri.Host.EndsWith(".invalid", StringComparison.OrdinalIgnoreCase))
                    throw new ResourceUnavailableException();
                var growth = checked(spec.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024);
                var expected = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = identity.ScopeKey, Entry = identity.CacheKey, Growth = growth });
                var expectedPath = Path.Combine(this.root, ".hydration-reservations-v2", identity.ScopeKey + "-" + identity.CacheKey + ".json");
                if (!stagedVerified || stagedBytes is null || stagedPath is null || !stagedBytes.AsSpan().SequenceEqual(expected) ||
                    !string.Equals(stagedPath, expectedPath, StringComparison.OrdinalIgnoreCase)) throw new ResourceUnavailableException();
                VerifyStagedRecord(); return true;
            }, token));
        private void VerifyStagedRecord()
        {
            if (stagedRecord is null || stagedBytes is null || stagedPath is null ||
                ExperimentalOwnedStream.GetIdentity(stagedRecord.SafeFileHandle) != stagedIdentity ||
                !string.Equals(ExperimentalOwnedStream.FinalPath(stagedRecord.SafeFileHandle), stagedPath, StringComparison.OrdinalIgnoreCase) || stagedRecord.Length != stagedBytes.Length)
                throw new IOException("Synthetic staged record binding changed.");
            if (stagedPins is null) throw new IOException("Synthetic staged directory pins are unavailable.");
            ExperimentalOwnedStream.VerifyPins(stagedPins);
            stagedRecord.Position = 0; var observed = new byte[stagedBytes.Length]; stagedRecord.ReadExactly(observed);
            if (!observed.AsSpan().SequenceEqual(stagedBytes)) throw new IOException("Synthetic staged record contents changed.");
        }
        internal void RemoveSyntheticReservationForTest(string root, string key, CancellationToken token = default) => Execute(root, key, () => RunQuota(_ => {
            if (!stagedVerified || stagedRecord is null || stagedPath is null) throw new IOException("Synthetic staged record is unavailable.");
            VerifyStagedRecord();
            if (ReceiptCleanupFailureTestHook) throw new IOException("Injected synthetic cleanup failure.");
            byte disposition = 1;
            if (!SetFileInformationByHandle(stagedRecord.SafeFileHandle, 4, ref disposition, 1)) throw new IOException("Synthetic staged record disposition failed.");
            stagedRecord.Dispose(); stagedRecord = null;
            try { using var unexpected = ExperimentalOwnedStream.Open(stagedPath, 0x80, 7, 3, 0x00200000); throw new IOException("Synthetic staged record remains present."); }
            catch (IOException error) when (error.HResult == 2) { }
            ExperimentalOwnedStream.VerifyPins(stagedPins!);
            foreach (var pin in stagedPins!.AsEnumerable().Reverse()) pin.Handle.Dispose(); stagedPins = null;
            stagedPath = null; stagedBytes = null; stagedVerified = false; stagedGrowth = 0;
            return true;
        }, token));
        private T RunQuota<T>(Func<SafeFileHandle, T> operation, CancellationToken token)
        {
            T result = default!;
            HydrationQuotaGate.Run(heldLease!.Quota, () => {
                SetReceiptStatus(newUncertain: true, newQuotaInProgress: true);
                try {
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
                uncertainQuota.Dispose(); uncertainQuota = null; SetReceiptStatus(newUncertain: false);
                } finally { SetReceiptStatus(newQuotaInProgress: false); }
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
                    injectedMarkerDirectory = null; injectedMarkerToken = null; SetReceiptStatus(newUncertain: false);
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
                    if (stagedRecord is not null || stagedHandle is not null) { if (!stagedVerified || stagedHandle is not null) throw new IOException("Synthetic staged record remains uncertain."); VerifyStagedRecord(); }
                    ExperimentalOwnedStream.RequireRegularKind(uncertainQuota, false); ExperimentalOwnedStream.RequireSingleLink(uncertainQuota);
                    if (ExperimentalOwnedStream.GetIdentity(uncertainQuota) != quotaIdentity ||
                        !string.Equals(ExperimentalOwnedStream.FinalPath(uncertainQuota), Path.Combine(root, ".hydration-quota-v2.lock"), StringComparison.OrdinalIgnoreCase))
                        throw new IOException("Experimental quota binding changed.");
                    uncertainQuota.Dispose(); uncertainQuota = null; injectedQuotaToken = null; SetReceiptStatus(newUncertain: false);
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
                if (stagedRecord is not null || stagedHandle is not null || stagedPath is not null || stagedPins is not null) throw new IOException("Synthetic staged record remains owned.");
                if (executing || downloadUse is not null) throw new InvalidOperationException("Experimental receipt operation is active.");
                if (uncertain) throw new IOException("Experimental returned lease closure remains uncertain.");
                SetReceiptStatus(newUncertain: true);
                if (heldOwnedEntry is not null) { heldOwnedEntry.Dispose(); heldOwnedEntry = null; }
                else { heldEntry!.Dispose(); heldEntry = null; }
                heldLease!.Dispose(); SetReceiptStatus(newUncertain: false); heldLease = null; active = false;
                lock (RegistryGate) Receipts.Remove(this);
            }
        }
    }
    internal static Action? ReceiptFactoryAfterTransferTestHook;
    // Synthetic coordinator bootstrap only: the receipt is rooted before either
    // lease moves. This does not create a reservation or grant file access.
    internal static LeaseReceipt CreateReceiptForAdmissionForTest(string requestedRoot, PlaceholderIdentity identity,
        ref HydrationCacheConcurrency.Lease? admission, ref ExperimentalEntryLease? entry)
    {
        identity.Encode();
        if (admission is null || entry is null || identity.SourceAlias != "synthetic" ||
            !Uri.TryCreate(identity.Origin, UriKind.Absolute, out var origin) || origin.Scheme != "https" ||
            !origin.Host.EndsWith(".invalid", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Synthetic receipt input invalid.");
        var root = Path.GetFullPath(requestedRoot); var key = identity.ScopeKey + identity.CacheKey;
        var originalAdmission = admission; var originalEntry = entry;
        var receipt = new LeaseReceipt(root, key, ReceiptAttachAuthority); var attached = false;
        lock (RegistryGate) Receipts.Add(receipt);
        try {
            originalAdmission.RunExperimentalForEntry(root, key, () => {
                // Accessing this facade verifies that this root holds its legacy lock.
                _ = originalAdmission.ExperimentalMarkers; originalEntry.Validate();
                _ = originalAdmission.TransferExperimentalPair(originalEntry, key, (nextAdmission, nextEntry) => {
                    receipt.Attach(nextAdmission, nextEntry, ReceiptAttachAuthority); attached = true;
                });
            });
            ReceiptFactoryAfterTransferTestHook?.Invoke();
            admission = null; entry = null; return receipt;
        } catch {
            // If attachment ever happened, preserve the pre-registered receipt and
            // all of its resources for investigation rather than guessing ownership.
            if (!attached) lock (RegistryGate) Receipts.Remove(receipt);
            throw;
        }
    }
    internal static void ExerciseReceiptReattachGuardForTest(LeaseReceipt receipt) => receipt.Attach(null!, (ExperimentalEntryLease)null!, ReceiptAttachAuthority);
    internal readonly record struct StagedSnapshot(string Path, long Bytes, long Growth);
    // Called only while the root quota monitor is held. Do not acquire another
    // receipt/admission gate here: another caller may hold it while waiting for quota.
    internal static Dictionary<string, StagedSnapshot> SnapshotStagedForRoot(string root, object quota) =>
        LeaseReceipt.SnapshotForRootUnderQuota(root, quota);
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
