namespace LedgeTop.WindowsDownload;

// Shared only by the same canonical owned cache root. Waiters retain state; no semaphore is
// disposed while another coordinator can still hold or await it. No auth or filesystem effects.
internal static class HydrationCacheConcurrency
{
#if LEDGETOP_CACHE_RACE_TEST
    internal static Action<string>? BeforeEntryWaitTestHook;
#endif
    private sealed class Entry { internal readonly SemaphoreSlim Gate = new(1, 1); internal int References; }
    internal const int Capacity = 4;
    private sealed class Root
    {
        internal readonly SemaphoreSlim Slots = new(Capacity, Capacity);
        internal readonly SemaphoreSlim Admission = new(1, 1);
        internal readonly object Quota = new();
        internal readonly Dictionary<string, Entry> Entries = new(StringComparer.Ordinal);
        internal FileStream? ExclusiveLegacyLease;
#if LEDGETOP_CACHE_RACE_TEST
        internal ExperimentalRootMarkerOwner? ExperimentalMarkerOwner;
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
        internal object Quota { get; }
#if LEDGETOP_CACHE_RACE_TEST
        private readonly Func<ExperimentalRootMarkerOwner> markerOwner;
        private readonly object experimentalLeaseGate = new();
        internal ExperimentalRootMarkerOwner ExperimentalMarkers {
            get { lock (experimentalLeaseGate) { ObjectDisposedException.ThrowIf(release is null, this); return markerOwner(); } }
        }
#endif
        private readonly Action<string, FileMode> acquireLegacy;
        internal Lease(object quota, Action release, Action<string, FileMode> acquireLegacy
#if LEDGETOP_CACHE_RACE_TEST
            , Func<ExperimentalRootMarkerOwner> markerOwner
#endif
            ) { Quota = quota; this.release = release; this.acquireLegacy = acquireLegacy;
#if LEDGETOP_CACHE_RACE_TEST
            this.markerOwner = markerOwner;
#endif
        }
        internal void AcquireExclusiveLegacy(string path, FileMode mode) => acquireLegacy(path, mode);
        public void Dispose() {
#if LEDGETOP_CACHE_RACE_TEST
            lock (experimentalLeaseGate) Interlocked.Exchange(ref release, null)?.Invoke();
#else
            Interlocked.Exchange(ref release, null)?.Invoke();
#endif
        }
    }
    internal static async Task<Lease> AcquireAsync(string root, string key, CancellationToken token, bool exclusive = false, TimeSpan? testTimeout = null)
    {
        Root state; Entry entry;
        lock (Sync) {
            if (!Roots.TryGetValue(root, out state!)) {
                if (Roots.Count >= 256) throw new TransferException("Hydration cache admission is at capacity.");
                Roots.Add(root, state = new());
            }
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
#if LEDGETOP_CACHE_RACE_TEST
                    try { state.ExperimentalMarkerOwner?.Dispose(); state.ExclusiveLegacyLease?.Dispose(); state.Slots.Dispose(); state.Admission.Dispose(); }
                    catch { state.ExperimentalQuarantined = true; throw; }
                    Roots.Remove(root);
#else
                    Roots.Remove(root); state.ExclusiveLegacyLease?.Dispose(); state.Slots.Dispose(); state.Admission.Dispose();
#endif
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
            return new(state.Quota, Release, (path, mode) => {
                lock (Sync) {
                    if (state.ExclusiveLegacyLease is null) {
                        state.ExclusiveLegacyLease = new FileStream(path, mode, FileAccess.ReadWrite, FileShare.None);
#if LEDGETOP_CACHE_RACE_TEST
                        state.ExperimentalLegacyPath = Path.GetFullPath(path);
#endif
                    }
                }
            }
#if LEDGETOP_CACHE_RACE_TEST
            , () => { lock (Sync) {
                if (state.ExclusiveLegacyLease is null || state.ExperimentalQuarantined ||
                    !string.Equals(state.ExperimentalLegacyPath, Path.Combine(Path.GetFullPath(root), ".hydration-cache.lock"), StringComparison.OrdinalIgnoreCase))
                    throw new TransferException("Experimental marker ownership requires the root legacy lease.");
                return state.ExperimentalMarkerOwner ??= new ExperimentalRootMarkerOwner(root);
            } }
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
