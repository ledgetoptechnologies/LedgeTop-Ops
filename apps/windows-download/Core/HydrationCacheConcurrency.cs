namespace LedgeTop.WindowsDownload;

// Shared only by the same canonical owned cache root. Waiters retain state; no semaphore is
// disposed while another coordinator can still hold or await it. No auth or filesystem effects.
internal static class HydrationCacheConcurrency
{
    private sealed class Entry { internal readonly SemaphoreSlim Gate = new(1, 1); internal int References; }
    private sealed class Root
    {
        internal readonly SemaphoreSlim Slots = new(2, 2);
        internal readonly object Quota = new();
        internal readonly Dictionary<string, Entry> Entries = new(StringComparer.Ordinal);
        internal int References;
    }
    private static readonly object Sync = new();
    private static readonly Dictionary<string, Root> Roots = new(StringComparer.OrdinalIgnoreCase);
    internal sealed class Lease : IDisposable
    {
        private Action? release;
        internal object Quota { get; }
        internal Lease(object quota, Action release) { Quota = quota; this.release = release; }
        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }
    internal static async Task<Lease> AcquireAsync(string root, string key, CancellationToken token)
    {
        Root state; Entry entry;
        lock (Sync) {
            if (!Roots.TryGetValue(root, out state!)) {
                if (Roots.Count >= 256) throw new TransferException("Hydration cache admission is at capacity.");
                Roots.Add(root, state = new());
            }
            if (!state.Entries.TryGetValue(key, out entry!)) {
                if (state.Entries.Count >= 4096) throw new TransferException("Hydration entry admission is at capacity.");
                state.Entries.Add(key, entry = new());
            }
            state.References++; entry.References++;
        }
        var entered = false; var slotted = false;
        void Release()
        {
            if (slotted) state.Slots.Release();
            if (entered) entry.Gate.Release();
            lock (Sync) {
                if (--entry.References == 0) { state.Entries.Remove(key); entry.Gate.Dispose(); }
                if (--state.References == 0) { Roots.Remove(root); state.Slots.Dispose(); }
            }
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromMinutes(2));
        try {
            await entry.Gate.WaitAsync(timeout.Token).ConfigureAwait(false); entered = true;
            // Same-entry waiters never consume a distinct-entry slot.
            await state.Slots.WaitAsync(timeout.Token).ConfigureAwait(false); slotted = true;
            return new(state.Quota, Release);
        } catch (OperationCanceledException) when (!token.IsCancellationRequested) {
            Release(); throw new TransferException("Hydration cache admission timed out.", TransferFailureReason.Timeout);
        } catch { Release(); throw; }
    }
}
