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
    // The open callback must only validate and open the quota file. The action
    // runs once, after a successful open; its failures are never retried. Deadlines
    // cannot interrupt a synchronous validation, open, action or handle close.
    internal static void RunWithFileLock(object gate, Func<IDisposable> open, Action action,
        CancellationToken cancellationToken = default, TimeSpan? wait = null, Action<TimeSpan, TimeSpan>? observe = null, Action? validate = null)
    {
        ArgumentNullException.ThrowIfNull(gate); ArgumentNullException.ThrowIfNull(open); ArgumentNullException.ThrowIfNull(action);
        if (Monitor.IsEntered(gate)) throw new InvalidOperationException("Quota file acquisition cannot be reentrant.");
        var limit = wait ??
#if LEDGETOP_CACHE_RACE_TEST
            TestWait ??
#endif
            DefaultWait;
        if (limit <= TimeSpan.Zero || limit > TimeSpan.FromMinutes(10)) throw new ArgumentOutOfRangeException(nameof(wait));
        var started = Stopwatch.GetTimestamp(); var totalHeld = TimeSpan.Zero; long? firstFileContention = null;
        try { while (true) {
            cancellationToken.ThrowIfCancellationRequested();
            var remaining = limit - Stopwatch.GetElapsedTime(started);
            if (firstFileContention is long contention) {
                var fileRemaining = TimeSpan.FromMilliseconds(500) - Stopwatch.GetElapsedTime(contention);
                if (fileRemaining < remaining) remaining = fileRemaining;
            }
            if (remaining <= TimeSpan.Zero) throw new TransferException("Hydration cache quota is busy.", TransferFailureReason.LocalCacheBusy);
            var slice = remaining < TimeSpan.FromMilliseconds(50) ? remaining : TimeSpan.FromMilliseconds(50);
            if (!Monitor.TryEnter(gate, slice)) continue;
            var heldStarted = Stopwatch.GetTimestamp(); bool retry = false;
            try {
                cancellationToken.ThrowIfCancellationRequested();
                if (Stopwatch.GetElapsedTime(started) >= limit || (firstFileContention is long fileStart && Stopwatch.GetElapsedTime(fileStart) >= TimeSpan.FromMilliseconds(500)))
                    throw new TransferException("Hydration cache quota is busy.", TransferFailureReason.LocalCacheBusy);
                validate?.Invoke();
                IDisposable? held = null;
                try { held = open(); }
                catch (IOException error) when (OperatingSystem.IsWindows() && error.HResult is unchecked((int)0x80070020) or unchecked((int)0x80070021)) { firstFileContention ??= Stopwatch.GetTimestamp(); retry = true; }
                if (!retry) {
                    using (held ?? throw new InvalidOperationException("Quota open returned no handle.")) {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (Stopwatch.GetElapsedTime(started) >= limit || (firstFileContention is long fileStartAfterOpen && Stopwatch.GetElapsedTime(fileStartAfterOpen) >= TimeSpan.FromMilliseconds(500)))
                            throw new TransferException("Hydration cache quota is busy.", TransferFailureReason.LocalCacheBusy);
                        action();
                    }
                    return;
                }
            } finally {
                totalHeld += Stopwatch.GetElapsedTime(heldStarted); Monitor.Exit(gate);
            }
            remaining = limit - Stopwatch.GetElapsedTime(started);
            if (firstFileContention is long contentionAfterOpen) {
                var fileRemaining = TimeSpan.FromMilliseconds(500) - Stopwatch.GetElapsedTime(contentionAfterOpen);
                if (fileRemaining < remaining) remaining = fileRemaining;
            }
            if (remaining > TimeSpan.Zero && cancellationToken.WaitHandle.WaitOne(remaining < TimeSpan.FromMilliseconds(25) ? remaining : TimeSpan.FromMilliseconds(25)))
                cancellationToken.ThrowIfCancellationRequested();
        } } finally {
            try { observe?.Invoke(Stopwatch.GetElapsedTime(started) - totalHeld, totalHeld); } catch { }
        }
    }
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
