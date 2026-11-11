using System.Diagnostics;

namespace LedgeTop.WindowsDownload;

// Per-source dependency, replaceable by synthetic tests; never used as authority.
internal sealed record BusyRetryClock(Func<long> Now, Func<long, TimeSpan> Elapsed,
    Func<int, int> Jitter, Func<TimeSpan, CancellationToken, Task> Delay)
{
    internal static BusyRetryClock System { get; } = new(
        Stopwatch.GetTimestamp, Stopwatch.GetElapsedTime,
        cap => Random.Shared.Next(cap / 2, cap + 1), Task.Delay);
}
