using System.Diagnostics;

namespace LedgeTop.WindowsDownload;

// Bounds only waiting to enter the in-process quota monitor. Once entered, the
// existing operation owns the lock until it finishes; an underlying blocked
// filesystem call cannot be safely interrupted or unlocked by this helper.
internal static class HydrationQuotaGate
{
    internal static readonly TimeSpan DefaultWait = TimeSpan.FromSeconds(30);
#if LEDGETOP_CACHE_RACE_TEST
    internal static TimeSpan? TestWait;
    internal static Action? BeforeWaitTestHook;
#endif
    internal static void Run(object gate, Action action, CancellationToken cancellationToken = default, TimeSpan? wait = null,
        Action<TimeSpan, TimeSpan>? observe = null)
    {
        ArgumentNullException.ThrowIfNull(gate);
        ArgumentNullException.ThrowIfNull(action);
        var limit = wait ??
#if LEDGETOP_CACHE_RACE_TEST
            TestWait ??
#endif
            DefaultWait;
        if (limit <= TimeSpan.Zero || limit > TimeSpan.FromMinutes(10)) throw new ArgumentOutOfRangeException(nameof(wait));
        var started = Stopwatch.GetTimestamp();
#if LEDGETOP_CACHE_RACE_TEST
        BeforeWaitTestHook?.Invoke();
#endif
        while (true) {
            cancellationToken.ThrowIfCancellationRequested();
            var remaining = limit - Stopwatch.GetElapsedTime(started);
            if (remaining <= TimeSpan.Zero) {
                try { observe?.Invoke(Stopwatch.GetElapsedTime(started), TimeSpan.Zero); } catch { /* Timing is observational only. */ }
                throw new TransferException("Hydration cache quota is busy.", TransferFailureReason.LocalCacheBusy);
            }
            var slice = remaining < TimeSpan.FromMilliseconds(50) ? remaining : TimeSpan.FromMilliseconds(50);
            if (!Monitor.TryEnter(gate, slice)) continue;
            var waited = Stopwatch.GetElapsedTime(started);
            var heldStarted = Stopwatch.GetTimestamp();
            try {
                // No mutation starts for a cancellation observed while waiting.
                cancellationToken.ThrowIfCancellationRequested();
                // TryEnter may return after its requested slice when the thread
                // is descheduled. Do not start a new mutation past the deadline.
                if (Stopwatch.GetElapsedTime(started) >= limit) throw new TransferException("Hydration cache quota is busy.", TransferFailureReason.LocalCacheBusy);
                action();
                return;
            } finally {
                var held = Stopwatch.GetElapsedTime(heldStarted);
                Monitor.Exit(gate);
                try { observe?.Invoke(waited, held); } catch { /* Timing is observational only. */ }
            }
        }
    }
}
