using System.Globalization;

namespace LedgeTop.WindowsDownload;

internal enum HydrationTimingStage { Context, QueueWait, AuthorizationBefore, CachePreparation, Download, CacheVerification, AuthorizationAfter, NativeTransfer }
internal enum HydrationTimingOutcome { Completed, Cancelled, Failed }

/// <summary>Numeric callback-local facts only. Download includes token/network/disk/downloader hash work.</summary>
internal sealed class HydrationTimingSummary
{
    internal const long MaximumMilliseconds = 86_400_000;
    internal HydrationTimingOutcome Outcome { get; }
    internal bool? CacheHit { get; }
    internal long TotalMilliseconds { get; }
    internal IReadOnlyList<long> PhaseMilliseconds { get; }
    internal HydrationTimingSummary(HydrationTimingOutcome outcome, bool? cacheHit, long totalMilliseconds, IReadOnlyList<long> phases)
    {
        if (!Enum.IsDefined(outcome) || totalMilliseconds is < 0 or > MaximumMilliseconds || phases.Count != 8 ||
            phases.Any(value => value is < 0 or > MaximumMilliseconds) || phases.Sum() > totalMilliseconds)
            throw new ArgumentException("Bounded hydration timings are required.");
        Outcome = outcome; CacheHit = cacheHit; TotalMilliseconds = totalMilliseconds;
        PhaseMilliseconds = Array.AsReadOnly(phases.ToArray());
    }
    internal string ActivityText => "Hydration timing: outcome=" + Outcome + "; cache=" + (CacheHit is null ? "Unknown" : CacheHit.Value ? "Hit" : "Miss") +
        "; totalMs=" + Number(TotalMilliseconds) + "; contextMs=" + Number(PhaseMilliseconds[0]) + "; queueMs=" + Number(PhaseMilliseconds[1]) +
        "; authBeforeMs=" + Number(PhaseMilliseconds[2]) + "; cachePrepareMs=" + Number(PhaseMilliseconds[3]) +
        "; downloadMs=" + Number(PhaseMilliseconds[4]) + "; cacheVerifyMs=" + Number(PhaseMilliseconds[5]) +
        "; authAfterMs=" + Number(PhaseMilliseconds[6]) + "; nativeTransferMs=" + Number(PhaseMilliseconds[7]);
    private static string Number(long value) => value.ToString(CultureInfo.InvariantCulture);
}

/// <summary>Optional observational lifetime. No file identity, source, exception, credential or wall clock is accepted.</summary>
internal sealed class HydrationTiming : IDisposable
{
    private readonly TimeProvider clock;
    private readonly long started;
    private readonly Action<HydrationTimingSummary> observer;
    private readonly object sync = new();
    private readonly long[] phases = new long[8];
    private HydrationTimingStage stage;
    private long elapsed;
    private bool? cacheHit;
    private bool completed;
    internal HydrationTiming(Action<HydrationTimingSummary> observer, TimeProvider? clock = null)
    {
        this.observer = observer ?? throw new ArgumentNullException(nameof(observer));
        this.clock = clock ?? TimeProvider.System; started = this.clock.GetTimestamp();
    }
    private long Advance()
    {
        var now = (long)Math.Clamp(clock.GetElapsedTime(started).TotalMilliseconds, 0, HydrationTimingSummary.MaximumMilliseconds);
        now = Math.Max(elapsed, now); phases[(int)stage] += now - elapsed; elapsed = now; return now;
    }
    internal void Enter(HydrationTimingStage next)
    {
        if (!Enum.IsDefined(next)) throw new ArgumentOutOfRangeException(nameof(next));
        lock (sync) { if (completed) return; Advance(); stage = next; }
    }
    internal void SetCacheHit(bool hit) { lock (sync) { if (!completed) cacheHit = hit; } }
    internal void Complete(HydrationTimingOutcome outcome)
    {
        if (!Enum.IsDefined(outcome)) throw new ArgumentOutOfRangeException(nameof(outcome));
        HydrationTimingSummary summary;
        lock (sync) { if (completed) return; Advance(); completed = true; summary = new(outcome, cacheHit, elapsed, phases); }
        try { observer(summary); } catch (Exception) { /* Observers cannot change transfer integrity, cancellation or settlement. */ }
    }
    public void Dispose() => Complete(HydrationTimingOutcome.Failed);
}
