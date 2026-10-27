using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class ExplorerSourceGatePolicyTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly DownloadSpec Spec = new("synthetic", new Uri("https://source.example.invalid/file"), "test.txt", 0, "\"v1\"", new string('a', 64));
    internal static async Task<int> RunAsync()
    {
        var source = new Source();
        using var gate = new ExplorerSourceGate(source, new("pilot", source.Alias, source.Origin.GetLeftPart(UriPartial.Authority), Principal));
        await Throws<DownloadsPausedException>(() => gate.GetSessionAsync());
        await Throws<DownloadsPausedException>(() => gate.ResolveAsync("synthetic"));
        await Throws<DownloadsPausedException>(() => gate.DownloadAsync(Spec, "never-used"));
        Require(source.Calls == 0);
        using (var cancelled = new CancellationTokenSource()) {
            cancelled.Cancel();
            await Throws<OperationCanceledException>(() => gate.GetSessionAsync(cancelled.Token));
            Require(source.Calls == 0);
        }
        await gate.ResumeAsync();
        Require(source.Calls == 1);
        _ = await gate.GetSessionAsync(); _ = await gate.ResolveAsync("synthetic"); _ = await gate.DownloadAsync(Spec, "never-used");
        Require(source.Calls == 4);
        source.LoginRequired = true;
        await Throws<LoginRequiredException>(() => gate.GetSessionAsync());
        source.LoginRequired = false;
        source.Expiry = DateTimeOffset.UtcNow.AddSeconds(-1);
        await Throws<LoginRequiredException>(() => gate.GetSessionAsync());
        gate.Pause();
        await Throws<LoginRequiredException>(() => gate.ResumeAsync()); // Actual expired session remains authentication failure.
        var calls = source.Calls;
        await Throws<DownloadsPausedException>(() => gate.GetSessionAsync()); Require(source.Calls == calls);
        source.Expiry = DateTimeOffset.UtcNow.AddHours(1); await gate.ResumeAsync();
        source.Pending = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var inFlight = gate.GetSessionAsync(); gate.Pause();
        source.Pending.SetResult(new(Principal, source.Expiry));
        await Throws<OperationCanceledException>(() => inFlight); // Old epoch stays cancelled even if source ignores cancellation.
        source.Pending = null; await gate.ResumeAsync(); _ = await gate.GetSessionAsync();
        Console.WriteLine("PASS paused gate makes zero underlying calls; resume permits reads; real login/expiry and epoch/caller cancellation stay distinct. No helper/network/native/provider calls.");
        return 0;
    }
    private static async Task Throws<T>(Func<Task> run) where T : Exception
    {
        try { await run(); } catch (T) { return; }
        throw new IOException("Expected source-gate outcome was not observed.");
    }
    private static void Require(bool value) { if (!value) throw new IOException("Source-gate policy failed."); }
    private sealed class Source : IQueuedDownloadSource
    {
        public string Alias => "employee";
        public Uri Origin => new("https://source.example.invalid");
        internal int Calls;
        internal bool LoginRequired;
        internal DateTimeOffset Expiry = DateTimeOffset.UtcNow.AddHours(1);
        internal TaskCompletionSource<QueuedDownloadSession>? Pending;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            if (LoginRequired) throw new LoginRequiredException();
            return Pending?.Task ?? Task.FromResult(new QueuedDownloadSession(Principal, Expiry));
        }
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default)
        { Calls++; return Task.FromResult(new ResolvedQueuedDownload(Principal, "synthetic", "v1", Spec)); }
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
        { Calls++; return Task.FromResult("synthetic-no-file"); }
    }
}
