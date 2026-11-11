namespace LedgeTop.WindowsDownload;

// Shared only by the same canonical owned cache root. Waiters retain state; no semaphore is
// disposed while another coordinator can still hold or await it. No auth or filesystem effects.
internal static class HydrationCacheConcurrency
{
#if LEDGETOP_CACHE_RACE_TEST
    internal static Action<string>? BeforeEntryWaitTestHook;
    internal static Action? BeforeLegacyAcquireTestHook;
#endif
#if LEDGETOP_CACHE_RACE_TEST
    internal sealed class ExperimentalRootStatus { internal readonly object Gate = new(); internal long Revision; internal bool Poisoned; }
#endif
    private sealed class Entry { internal readonly SemaphoreSlim Gate = new(1, 1); internal int References; }
    internal sealed record ActiveReservation(FileStream Stream, byte[] Bytes, long Growth);
    internal sealed class QuotaState { internal readonly Dictionary<string, ActiveReservation> Reservations = new(StringComparer.OrdinalIgnoreCase); }
    internal const int Capacity = 4;
    private sealed class Root
    {
        internal readonly SemaphoreSlim Slots = new(Capacity, Capacity);
        internal readonly SemaphoreSlim Admission = new(1, 1);
        internal readonly QuotaState Quota = new();
        internal readonly Dictionary<string, Entry> Entries = new(StringComparer.Ordinal);
        internal FileStream? ExclusiveLegacyLease;
        internal bool Quarantined;
#if LEDGETOP_CACHE_RACE_TEST
        internal ExperimentalRootMarkerOwner? ExperimentalMarkerOwner;
        internal readonly ExperimentalRootStatus Status = new();
        internal string? ExperimentalLegacyPath;
        internal bool ExperimentalQuarantined;
#endif
        internal int References;
    }
    private static readonly object Sync = new();
    private static readonly Dictionary<string, Root> Roots = new(StringComparer.OrdinalIgnoreCase);
    internal sealed class Lease : IDisposable
    {
        private Action? release;
        private readonly object leaseGate = new();
        internal object Quota { get; }
#if LEDGETOP_CACHE_RACE_TEST
        private readonly Func<ExperimentalRootMarkerOwner> markerOwner;
        private readonly string experimentalRoot, experimentalKey;
        internal ExperimentalRootStatus ExperimentalStatus { get; }
        private int experimentalEntryBindings;
        internal void RegisterExperimentalEntry() { lock (leaseGate) { ObjectDisposedException.ThrowIf(release is null, this); experimentalEntryBindings = checked(experimentalEntryBindings + 1); } }
        internal void UnregisterExperimentalEntry() { lock (leaseGate) { if (experimentalEntryBindings <= 0) throw new InvalidOperationException("Experimental entry binding missing."); experimentalEntryBindings--; } }
        internal bool ExperimentalGateHeld => Monitor.IsEntered(leaseGate);
        internal void RunExperimentalForEntry(string path, string key, Action operation) {
            lock (leaseGate) {
                ObjectDisposedException.ThrowIf(release is null, this);
                if (!string.Equals(experimentalRoot, Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase) || experimentalKey != key)
                    throw new TransferException("Experimental entry lease does not match admission.");
                operation();
            }
        }
        internal void RunExperimentalForRoot(string path, Action operation) {
            lock (leaseGate) {
                ObjectDisposedException.ThrowIf(release is null, this);
                if (!string.Equals(experimentalRoot, Path.GetFullPath(path), StringComparison.OrdinalIgnoreCase)) throw new TransferException("Experimental quota lease belongs to a different root.");
                operation();
            }
        }
        internal sealed class MarkerFacade(Lease lease)
        {
            internal void ValidateExisting(string directory, string name, byte[] expected) =>
                lease.UseExperimentalMarkers(owner => owner.ValidateExisting(directory, name, expected));
            internal void CreateNew(string directory) => lease.UseExperimentalMarkers(owner => owner.CreateNew(directory));
            internal long AccountMarker(string path) {
                long length = 0; lease.UseExperimentalMarkers(owner => length = owner.AccountMarker(path)); return length;
            }
        }
        // Move this admission to an experimental reservation owner without
        // releasing its root/entry reference. The old lease becomes unusable.
        internal Lease TransferForReservationTest(string expectedKey)
        {
            lock (leaseGate) {
                ObjectDisposedException.ThrowIf(release is null, this);
                if (experimentalKey != expectedKey) throw new TransferException("Experimental reservation entry does not match its lease.");
                if (experimentalEntryBindings != 0) throw new TransferException("Experimental entry binding requires a joint transfer.");
                var successor = new Lease(Quota, release, acquireLegacy, markerOwner, experimentalRoot, experimentalKey, ExperimentalStatus);
                release = null;
                return successor;
            }
        }
        internal (Lease Admission, ExperimentalEntryLease Entry) TransferExperimentalPair(ExperimentalEntryLease entry, string expectedKey, Action<Lease, ExperimentalEntryLease>? attach = null)
        {
            lock (leaseGate) {
                ObjectDisposedException.ThrowIf(release is null, this);
                if (experimentalKey != expectedKey || experimentalEntryBindings != 1)
                    throw new TransferException("Experimental admission and entry cannot be transferred.");
                var successor = new Lease(Quota, release, acquireLegacy, markerOwner, experimentalRoot, experimentalKey, ExperimentalStatus);
                var moved = entry.JointMoveTo(this, successor, next => { attach?.Invoke(successor, next); successor.experimentalEntryBindings = 1; experimentalEntryBindings = 0; release = null; });
                return (successor, moved);
            }
        }
        private void UseExperimentalMarkers(Action<ExperimentalRootMarkerOwner> operation)
        {
            lock (leaseGate) { ObjectDisposedException.ThrowIf(release is null, this); operation(markerOwner()); }
        }
        internal MarkerFacade ExperimentalMarkers {
            get { lock (leaseGate) { ObjectDisposedException.ThrowIf(release is null, this); _ = markerOwner(); return new(this); } }
        }
#endif
        private readonly Func<string, FileMode, CancellationToken, long, bool> acquireLegacy;
        internal Lease(object quota, Action release, Func<string, FileMode, CancellationToken, long, bool> acquireLegacy
#if LEDGETOP_CACHE_RACE_TEST
            , Func<ExperimentalRootMarkerOwner> markerOwner, string experimentalRoot, string experimentalKey, ExperimentalRootStatus experimentalStatus
#endif
            ) { Quota = quota; this.release = release; this.acquireLegacy = acquireLegacy;
#if LEDGETOP_CACHE_RACE_TEST
            this.markerOwner = markerOwner; this.experimentalRoot = Path.GetFullPath(experimentalRoot); this.experimentalKey = experimentalKey; ExperimentalStatus = experimentalStatus;
#endif
        }
        // The retry budget cannot interrupt synchronous validation, lock entry or file open.
        internal void AcquireExclusiveLegacy(string path, FileMode mode, CancellationToken token = default, Action? validate = null) {
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            while (true) {
                token.ThrowIfCancellationRequested();
                if (System.Diagnostics.Stopwatch.GetElapsedTime(started) >= TimeSpan.FromMilliseconds(500))
                    throw new TransferException("Hydration cache ownership is busy.", TransferFailureReason.LocalCacheBusy);
                lock (leaseGate) {
                    ObjectDisposedException.ThrowIf(release is null, this);
#if LEDGETOP_CACHE_RACE_TEST
                    BeforeLegacyAcquireTestHook?.Invoke();
#endif
                    validate?.Invoke(); token.ThrowIfCancellationRequested();
                    if (acquireLegacy(path, mode, token, started)) return;
                }
                var remaining = TimeSpan.FromMilliseconds(500) - System.Diagnostics.Stopwatch.GetElapsedTime(started);
                if (remaining <= TimeSpan.Zero) throw new TransferException("Hydration cache ownership is busy.", TransferFailureReason.LocalCacheBusy);
                if (token.WaitHandle.WaitOne(remaining < TimeSpan.FromMilliseconds(25) ? remaining : TimeSpan.FromMilliseconds(25))) token.ThrowIfCancellationRequested();
            }
        }
        public void Dispose() { lock (leaseGate) {
#if LEDGETOP_CACHE_RACE_TEST
            if (experimentalEntryBindings != 0) throw new IOException("Experimental entry binding remains active.");
#endif
            Interlocked.Exchange(ref release, null)?.Invoke();
        } }
    }
    private static QuotaState RequireQuota(object quota)
    {
        if (quota is not QuotaState state || !Monitor.IsEntered(state))
            throw new InvalidOperationException("Hydration quota gate is not held.");
        return state;
    }
    internal static void RegisterReservation(object quota, string path, byte[] bytes, long growth, FileStream stream)
    {
        var state = RequireQuota(quota); var key = Path.GetFullPath(path);
        if (growth < 0 || bytes.Length is <= 0 or > 1024 || !stream.CanRead || stream.Length != bytes.Length)
            throw new TransferException("Hydration reservation handle is unavailable.");
        stream.Position = 0; var observed = new byte[bytes.Length]; stream.ReadExactly(observed);
        if (!observed.AsSpan().SequenceEqual(bytes)) throw new TransferException("Hydration reservation changed.");
        stream.Position = 0;
        if (!state.Reservations.TryAdd(key, new(stream, bytes.ToArray(), growth)))
            throw new TransferException("Hydration reservation already has a live owner.");
    }
    internal static bool TryReadReservation(object quota, string path, out long growth)
    {
        var state = RequireQuota(quota);
        if (!state.Reservations.TryGetValue(Path.GetFullPath(path), out var active)) { growth = 0; return false; }
        var stream = active.Stream;
        if (!stream.CanRead || stream.Length != active.Bytes.Length) throw new TransferException("Active hydration reservation changed.");
        // On Windows, the retained read handle was opened with FileShare.Read, which denies
        // subsequent write/delete opens. The exact record was validated when registered, so a
        // quota scan need only confirm the handle and enumerated path remain present. Portable
        // synthetic runs retain the byte comparison because FileShare enforcement varies by OS.
        if (!OperatingSystem.IsWindows()) {
            stream.Position = 0; var observed = new byte[active.Bytes.Length]; stream.ReadExactly(observed); stream.Position = 0;
            if (!observed.AsSpan().SequenceEqual(active.Bytes)) throw new TransferException("Active hydration reservation changed.");
        }
        growth = active.Growth; return true;
    }
    internal static string[] ActiveReservationPaths(object quota) => RequireQuota(quota).Reservations.Keys.ToArray();
    internal static void ReleaseReservation(object quota, string path, byte[] expected)
    {
        var state = RequireQuota(quota); var key = Path.GetFullPath(path);
        if (!state.Reservations.TryGetValue(key, out var active) || !active.Bytes.AsSpan().SequenceEqual(expected))
            throw new TransferException("Active hydration reservation ownership changed.");
        _ = TryReadReservation(quota, key, out _);
        active.Stream.Dispose();
        state.Reservations.Remove(key);
    }
    private static void DisposeReservations(QuotaState quota)
    {
        foreach (var reservation in quota.Reservations.Values) reservation.Stream.Dispose();
        quota.Reservations.Clear();
    }
    internal static async Task<Lease> AcquireAsync(string root, string key, CancellationToken token, bool exclusive = false, TimeSpan? testTimeout = null)
    {
        Root state; Entry entry;
        lock (Sync) {
            if (!Roots.TryGetValue(root, out state!)) {
                if (Roots.Count >= 256) throw new TransferException("Hydration cache admission is at capacity.");
                Roots.Add(root, state = new());
            }
            if (state.Quarantined) throw new TransferException("Hydration cache ownership is uncertain.");
#if LEDGETOP_CACHE_RACE_TEST
            if (state.ExperimentalQuarantined) throw new TransferException("Experimental root ownership is uncertain.");
#endif
            if (!state.Entries.TryGetValue(key, out entry!)) {
                if (state.Entries.Count >= 4096) throw new TransferException("Hydration entry admission is at capacity.");
                state.Entries.Add(key, entry = new());
            }
            state.References++; entry.References++;
        }
        var entered = false; var slots = 0; var admission = false;
        void Release()
        {
            if (slots > 0) state.Slots.Release(slots);
            if (admission) state.Admission.Release();
            if (entered) entry.Gate.Release();
            lock (Sync) {
                if (--entry.References == 0) { state.Entries.Remove(key); entry.Gate.Dispose(); }
                if (--state.References == 0) {
                    try {
                        DisposeReservations(state.Quota);
#if LEDGETOP_CACHE_RACE_TEST
                        state.ExperimentalMarkerOwner?.Dispose(); state.ExclusiveLegacyLease?.Dispose(); state.Slots.Dispose(); state.Admission.Dispose();
#else
                        state.ExclusiveLegacyLease?.Dispose(); state.Slots.Dispose(); state.Admission.Dispose();
#endif
                        Roots.Remove(root);
                    } catch {
                        state.Quarantined = true;
#if LEDGETOP_CACHE_RACE_TEST
                        state.ExperimentalQuarantined = true;
#endif
                        throw;
                    }
                }
            }
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(testTimeout ?? TimeSpan.FromMinutes(2));
        try {
#if LEDGETOP_CACHE_RACE_TEST
            BeforeEntryWaitTestHook?.Invoke(key);
#endif
            await entry.Gate.WaitAsync(timeout.Token).ConfigureAwait(false); entered = true;
            // Same-entry waiters never consume a distinct-entry slot.
            await state.Admission.WaitAsync(timeout.Token).ConfigureAwait(false); admission = true;
            var required = exclusive ? Capacity : 1;
            while (slots < required) {
                await state.Slots.WaitAsync(timeout.Token).ConfigureAwait(false); slots++;
            }
            state.Admission.Release(); admission = false;
            return new(state.Quota, Release, (path, mode, token, started) => {
                lock (Sync) {
                    token.ThrowIfCancellationRequested();
                    if (System.Diagnostics.Stopwatch.GetElapsedTime(started) >= TimeSpan.FromMilliseconds(500))
                        throw new TransferException("Hydration cache ownership is busy.", TransferFailureReason.LocalCacheBusy);
                    if (state.ExclusiveLegacyLease is null) {
                        FileStream opened;
                        try { opened = new FileStream(path, mode, FileAccess.ReadWrite, FileShare.None); }
                        catch (IOException error) when (OperatingSystem.IsWindows() && error.HResult is unchecked((int)0x80070020) or unchecked((int)0x80070021)) { return false; }
                        try {
                            token.ThrowIfCancellationRequested();
                            if (System.Diagnostics.Stopwatch.GetElapsedTime(started) >= TimeSpan.FromMilliseconds(500))
                                throw new TransferException("Hydration cache ownership is busy.", TransferFailureReason.LocalCacheBusy);
                            state.ExclusiveLegacyLease = opened;
                        }
                        catch { opened.Dispose(); throw; }
#if LEDGETOP_CACHE_RACE_TEST
                        state.ExperimentalLegacyPath = Path.GetFullPath(path);
#endif
                    }
                    token.ThrowIfCancellationRequested();
                    return true;
                }
            }
#if LEDGETOP_CACHE_RACE_TEST
            , () => { lock (Sync) {
                if (state.ExclusiveLegacyLease is null || state.ExperimentalQuarantined ||
                    !string.Equals(state.ExperimentalLegacyPath, Path.Combine(Path.GetFullPath(root), ".hydration-cache.lock"), StringComparison.OrdinalIgnoreCase))
                    throw new TransferException("Experimental marker ownership requires the root legacy lease.");
                return state.ExperimentalMarkerOwner ??= new ExperimentalRootMarkerOwner(root);
            } }, root, key, state.Status
#endif
            );
        } catch (OperationCanceledException) when (!token.IsCancellationRequested) {
            Release(); throw new TransferException("Hydration cache admission timed out.", TransferFailureReason.Timeout);
        } catch { Release(); throw; }
    }
#if LEDGETOP_CACHE_RACE_TEST
    internal static void SettleInjectedMarkerCreateForTest(string root)
    {
        lock (Sync) {
            if (!Roots.TryGetValue(root, out var state) || !state.ExperimentalQuarantined || state.References != 0 || state.ExperimentalMarkerOwner is null)
                throw new InvalidOperationException("Experimental root is not quarantined.");
            state.ExperimentalMarkerOwner.SettleInjectedCreateFailureForTest();
            state.ExperimentalMarkerOwner.Dispose(); state.ExclusiveLegacyLease?.Dispose();
            state.Slots.Dispose(); state.Admission.Dispose(); Roots.Remove(root);
        }
    }
    internal static void SettleInjectedMarkerCloseForTest(string root)
    {
        lock (Sync) {
            if (!Roots.TryGetValue(root, out var state) || !state.ExperimentalQuarantined || state.References != 0 ||
                state.ExperimentalMarkerOwner?.InjectedCloseFailure != true || ExperimentalRootMarkerOwner.BeforeCloseTestHook is not null)
                throw new InvalidOperationException("Only injected pre-close failure can be settled.");
            state.ExperimentalMarkerOwner.Dispose(); state.ExclusiveLegacyLease?.Dispose();
            state.Slots.Dispose(); state.Admission.Dispose(); Roots.Remove(root);
        }
    }
#endif
    // The admission timeout means this cache root is busy, not that its bytes
    // failed verification. Limit the conversion to this acquisition boundary.
    internal static async Task<Lease> AcquireForReclamationAsync(string root, string key, CancellationToken token, TimeSpan? testTimeout = null)
    {
        try { return await AcquireAsync(root, key, token, testTimeout: testTimeout).ConfigureAwait(false); }
        catch (TransferException error) when (error.Reason == TransferFailureReason.Timeout) {
            token.ThrowIfCancellationRequested();
            throw new CacheLeaseContentionTimeoutException();
        }
    }
}
