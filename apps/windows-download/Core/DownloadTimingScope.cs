using System.Diagnostics;

namespace LedgeTop.WindowsDownload;

// Scoped to a single staging callback; records numeric durations only.
internal sealed class DownloadTimingScope : IDisposable
{
    private static readonly AsyncLocal<DownloadTimingScope?> Current = new();
    private readonly DownloadTimingScope? previous;
    private readonly HydrationTiming timing;
    private DownloadTimingScope(HydrationTiming timing) { this.timing = timing; previous = Current.Value; Current.Value = this; }
    internal static IDisposable? Begin(HydrationTiming? timing, PlaceholderIdentity identity)
    {
#if LEDGETOP_AUTH_TIMING_STAGING
        if (timing is not null && identity.Channel == "pilot" && identity.SourceAlias == "employee" && identity.Origin == "https://ops-staging.ledgetopdroneservices.com") return new DownloadTimingScope(timing);
#endif
        return null;
    }
    internal static IDisposable BeginForTest(HydrationTiming timing) => new DownloadTimingScope(timing);
    internal static IDisposable? Measure(int phase) => Current.Value is { } current ? new Measurement(current.timing, phase) : null;
    public void Dispose() { if (ReferenceEquals(Current.Value, this)) Current.Value = previous; }
    private sealed class Measurement(HydrationTiming timing, int phase) : IDisposable
    {
        private readonly long start = Stopwatch.GetTimestamp();
        public void Dispose() { try { timing.AddDownloadTime(phase, Stopwatch.GetElapsedTime(start)); } catch { } }
    }
}
