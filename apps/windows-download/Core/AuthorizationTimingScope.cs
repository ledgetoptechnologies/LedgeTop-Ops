using System.Diagnostics;

namespace LedgeTop.WindowsDownload;

// Callback-local numeric timings only. No request, token, origin, error or filename is retained.
internal sealed class AuthorizationTimingScope : IDisposable
{
    private static readonly AsyncLocal<AuthorizationTimingScope?> Current = new();
    private readonly AuthorizationTimingScope? previous;
    private readonly HydrationTiming timing;
    private readonly bool before;
    private AuthorizationTimingScope(HydrationTiming timing, bool before) { this.timing = timing; this.before = before; previous = Current.Value; Current.Value = this; }
    internal static IDisposable? Begin(HydrationTiming? timing, PlaceholderIdentity identity, bool before)
    {
#if LEDGETOP_AUTH_TIMING_STAGING
        if (timing is not null && identity.Channel == "pilot" && identity.SourceAlias == "employee" && identity.Origin == "https://ops-staging.ledgetopdroneservices.com") return new AuthorizationTimingScope(timing, before);
#endif
        return null;
    }
    internal static IDisposable BeginForTest(HydrationTiming timing, bool before) => new AuthorizationTimingScope(timing, before);
    internal static async Task<T> MeasureAsync<T>(bool token, Func<Task<T>> operation)
    {
        var scope = Current.Value;
        if (scope is null) return await operation().ConfigureAwait(false);
        var start = Stopwatch.GetTimestamp();
        try { return await operation().ConfigureAwait(false); }
        finally { try { scope.timing.AddAuthorizationTime(scope.before, token, Stopwatch.GetElapsedTime(start)); } catch { } }
    }
    public void Dispose() { if (ReferenceEquals(Current.Value, this)) Current.Value = previous; }
}
