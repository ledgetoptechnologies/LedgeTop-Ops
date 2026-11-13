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
    internal IReadOnlyList<long> AuthorizationMilliseconds { get; }
    internal IReadOnlyList<int> AuthorizationCounts { get; }
    internal IReadOnlyList<long> DownloadMilliseconds { get; }
    internal IReadOnlyList<long> CacheMilliseconds { get; }
    internal string? ContentProtocol { get; }
    internal HydrationTimingSummary(HydrationTimingOutcome outcome, bool? cacheHit, long totalMilliseconds, IReadOnlyList<long> phases,
        IReadOnlyList<long>? authorization = null, IReadOnlyList<int>? authorizationCounts = null, IReadOnlyList<long>? download = null,
        IReadOnlyList<long>? cache = null, string? contentProtocol = null)
    {
        if (!Enum.IsDefined(outcome) || totalMilliseconds is < 0 or > MaximumMilliseconds || phases.Count != 8 ||
            phases.Any(value => value is < 0 or > MaximumMilliseconds) || phases.Sum() > totalMilliseconds)
            throw new ArgumentException("Bounded hydration timings are required.");
        if (contentProtocol is not null && contentProtocol is not ("HTTP/1.0" or "HTTP/1.1" or "HTTP/2" or "HTTP/3" or "Other"))
            throw new ArgumentException("A bounded content protocol label is required.");
        Outcome = outcome; CacheHit = cacheHit; TotalMilliseconds = totalMilliseconds; ContentProtocol = contentProtocol;
        PhaseMilliseconds = Array.AsReadOnly(phases.ToArray());
        authorization ??= new long[4]; authorizationCounts ??= new int[4];
        if (authorization.Count != 4 || authorizationCounts.Count != 4 || authorization.Any(x => x is < 0 or > MaximumMilliseconds) || authorizationCounts.Any(x => x is < 0 or > 1000)) throw new ArgumentException("Bounded authorization timings are required.");
        AuthorizationMilliseconds = Array.AsReadOnly(authorization.ToArray()); AuthorizationCounts = Array.AsReadOnly(authorizationCounts.ToArray());
        download ??= new long[4];
        if (download.Count != 4 || download.Any(x => x is < 0 or > MaximumMilliseconds)) throw new ArgumentException("Bounded download timings are required.");
        DownloadMilliseconds = Array.AsReadOnly(download.ToArray());
        cache ??= new long[4];
        if (cache.Count != 4 || cache.Any(x => x is < 0 or > MaximumMilliseconds)) throw new ArgumentException("Bounded cache timings are required.");
        CacheMilliseconds = Array.AsReadOnly(cache.ToArray());
    }
    internal string ActivityText => "Hydration timing: outcome=" + Outcome + "; cache=" + (CacheHit is null ? "Unknown" : CacheHit.Value ? "Hit" : "Miss") +
        "; totalMs=" + Number(TotalMilliseconds) + "; contextMs=" + Number(PhaseMilliseconds[0]) + "; queueMs=" + Number(PhaseMilliseconds[1]) +
        "; authBeforeMs=" + Number(PhaseMilliseconds[2]) + "; cachePrepareMs=" + Number(PhaseMilliseconds[3]) +
        "; downloadMs=" + Number(PhaseMilliseconds[4]) + "; cacheVerifyMs=" + Number(PhaseMilliseconds[5]) +
        "; authAfterMs=" + Number(PhaseMilliseconds[6]) + "; nativeTransferMs=" + Number(PhaseMilliseconds[7]) +
        (AuthorizationCounts.Any(x => x > 0) ? "; authBeforeTokenMs=" + Number(AuthorizationMilliseconds[0]) + "; authBeforeHeadersMs=" + Number(AuthorizationMilliseconds[1]) +
            "; authAfterTokenMs=" + Number(AuthorizationMilliseconds[2]) + "; authAfterHeadersMs=" + Number(AuthorizationMilliseconds[3]) +
            "; authBeforeTokenCount=" + Number(AuthorizationCounts[0]) + "; authBeforeHeadersCount=" + Number(AuthorizationCounts[1]) +
            "; authAfterTokenCount=" + Number(AuthorizationCounts[2]) + "; authAfterHeadersCount=" + Number(AuthorizationCounts[3]) +
            "; downloadHeadersMs=" + Number(DownloadMilliseconds[0]) + "; downloadBodyMs=" + Number(DownloadMilliseconds[1]) +
            "; downloadFlushMs=" + Number(DownloadMilliseconds[2]) + "; downloadHashMs=" + Number(DownloadMilliseconds[3]) : "") +
        "; cacheQuotaWaitMs=" + Number(CacheMilliseconds[0]) + "; cacheQuotaHeldMs=" + Number(CacheMilliseconds[1]) +
        "; cacheWalkMs=" + Number(CacheMilliseconds[2]) + "; reservationScanMs=" + Number(CacheMilliseconds[3]) +
        (ContentProtocol is null ? "" : "; contentProtocol=" + ContentProtocol);
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
    private readonly long[] authorization = new long[4];
    private readonly int[] authorizationCounts = new int[4];
    private readonly long[] download = new long[4];
    private readonly long[] cache = new long[4];
    private string? contentProtocol;
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
    internal void AddAuthorizationTime(bool before, bool token, TimeSpan elapsedTime)
    {
        var index = (before ? 0 : 2) + (token ? 0 : 1);
        lock (sync) { if (completed) return; authorization[index] = Math.Min(HydrationTimingSummary.MaximumMilliseconds, authorization[index] + (long)Math.Clamp(elapsedTime.TotalMilliseconds, 0, HydrationTimingSummary.MaximumMilliseconds)); authorizationCounts[index] = Math.Min(1000, authorizationCounts[index] + 1); }
    }
    internal void AddDownloadTime(int phase, TimeSpan elapsedTime)
    {
        if (phase is < 0 or > 3) throw new ArgumentOutOfRangeException(nameof(phase));
        lock (sync) { if (!completed) download[phase] = Math.Min(HydrationTimingSummary.MaximumMilliseconds, download[phase] + (long)Math.Clamp(elapsedTime.TotalMilliseconds, 0, HydrationTimingSummary.MaximumMilliseconds)); }
    }
    internal void SetContentProtocol(Version version)
    {
        ArgumentNullException.ThrowIfNull(version);
        var label = version == System.Net.HttpVersion.Version10 ? "HTTP/1.0" :
            version == System.Net.HttpVersion.Version11 ? "HTTP/1.1" :
            version == System.Net.HttpVersion.Version20 ? "HTTP/2" :
            version == System.Net.HttpVersion.Version30 ? "HTTP/3" : "Other";
        lock (sync) { if (!completed) contentProtocol = label; }
    }
    internal void AddCacheQuotaTime(TimeSpan wait, TimeSpan held)
    {
        lock (sync) {
            if (completed) return;
            AddCache(0, wait); AddCache(1, held);
        }
    }
    internal void AddCacheWalkTime(TimeSpan elapsedTime) { lock (sync) { if (!completed) AddCache(2, elapsedTime); } }
    internal void AddReservationScanTime(TimeSpan elapsedTime) { lock (sync) { if (!completed) AddCache(3, elapsedTime); } }
    private void AddCache(int index, TimeSpan elapsedTime) => cache[index] = Math.Min(HydrationTimingSummary.MaximumMilliseconds,
        cache[index] + (long)Math.Clamp(elapsedTime.TotalMilliseconds, 0, HydrationTimingSummary.MaximumMilliseconds));
    internal void Complete(HydrationTimingOutcome outcome)
    {
        if (!Enum.IsDefined(outcome)) throw new ArgumentOutOfRangeException(nameof(outcome));
        HydrationTimingSummary summary;
        lock (sync) { if (completed) return; Advance(); completed = true; summary = new(outcome, cacheHit, elapsed, phases, authorization, authorizationCounts, download, cache, contentProtocol); }
        try { observer(summary); } catch (Exception) { /* Observers cannot change transfer integrity, cancellation or settlement. */ }
    }
    public void Dispose() => Complete(HydrationTimingOutcome.Failed);
}
