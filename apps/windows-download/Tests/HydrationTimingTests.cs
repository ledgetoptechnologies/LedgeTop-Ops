using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class HydrationTimingTests
{
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("hydration timing numeric bounds observer isolation and one terminal summary", Policy),
        ("hydration timing actual coordinator and fake native path distinguish cold and cached work", Pipeline),
        ("hydration timing queued cancellation and failure retain terminal isolation", Cancellation)
    ];
    private static void Check(bool ok) { if (!ok) throw new Exception("Bounded hydration timing assertion failed."); }
    private sealed class Clock : TimeProvider {
        internal long Now;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Now;
    }
    private static Task Policy()
    {
        var clock = new Clock(); var output = new List<HydrationTimingSummary>();
        using (var timing = new HydrationTiming(output.Add, clock)) {
            clock.Now = 7; timing.Enter(HydrationTimingStage.QueueWait);
            clock.Now = 12; timing.Enter(HydrationTimingStage.AuthorizationBefore);
            clock.Now = 22; timing.SetCacheHit(false); timing.Complete(HydrationTimingOutcome.Completed);
            timing.Complete(HydrationTimingOutcome.Failed); timing.Enter(HydrationTimingStage.Download);
        }
        Check(output.Count == 1 && output[0].TotalMilliseconds == 22 && output[0].PhaseMilliseconds.SequenceEqual(new long[] { 7, 5, 10, 0, 0, 0, 0, 0 }));
        var text = output[0].ActivityText;
        Check(text.Contains("cache=Miss") && text.Contains("outcome=Completed") && !text.Contains("https") && !text.Contains("token"));
        var mutable = new long[8]; var copied = new HydrationTimingSummary(HydrationTimingOutcome.Failed, null, 0, mutable); mutable[0] = 1;
        Check(copied.PhaseMilliseconds[0] == 0);
        using (var timing = new HydrationTiming(_ => throw new Exception("PRIVATE observer fault"), clock)) timing.Complete(HydrationTimingOutcome.Completed);
        var bounded = new List<HydrationTimingSummary>(); clock.Now = 0;
        using (var timing = new HydrationTiming(bounded.Add, clock)) { clock.Now = -100; timing.Enter(HydrationTimingStage.QueueWait); clock.Now = HydrationTimingSummary.MaximumMilliseconds * 2; }
        Check(bounded.Single().TotalMilliseconds == HydrationTimingSummary.MaximumMilliseconds && bounded[0].PhaseMilliseconds.Sum() == bounded[0].TotalMilliseconds);
        foreach (var phases in new[] { new long[7], new long[] { -1, 0, 0, 0, 0, 0, 0, 0 }, new long[] { 2, 0, 0, 0, 0, 0, 0, 0 } }) {
            try { _ = new HydrationTimingSummary(HydrationTimingOutcome.Completed, null, 1, phases); throw new Exception("Expected bounds refusal."); }
            catch (ArgumentException) { }
        }
        return Task.CompletedTask;
    }
    private static async Task Pipeline()
    {
        using var fixture = new Fixture(); var output = new List<HydrationTimingSummary>();
        await fixture.Run(output.Add);
        var cold = output.Single();
        Check(cold.Outcome == HydrationTimingOutcome.Completed && cold.CacheHit == false && fixture.Source.Downloads == 1 && fixture.Native.Transfers == 1);
        Check(cold.PhaseMilliseconds[2] == 40 && cold.PhaseMilliseconds[4] == 100 && cold.PhaseMilliseconds[6] == 40 && cold.PhaseMilliseconds[7] == 5);
        Check(cold.PhaseMilliseconds.Sum() == cold.TotalMilliseconds);
        output.Clear(); await fixture.Run(output.Add);
        var warm = output.Single();
        Check(warm.CacheHit == true && warm.PhaseMilliseconds[4] == 0 && warm.PhaseMilliseconds[2] == 40 && warm.PhaseMilliseconds[6] == 40 && fixture.Source.Downloads == 1);
        // A throwing Activity consumer cannot undo a committed native transfer.
        await fixture.Run(_ => throw new Exception("PRIVATE observer fault"));
        Check(fixture.Native.Transfers == 3);
        await fixture.RunWithoutTiming(); Check(fixture.Native.Transfers == 4 && fixture.Source.Downloads == 1);
        fixture.Source.Fail = true; output.Clear();
        try { await fixture.Run(output.Add); throw new Exception("Expected source refusal."); } catch (TransferException) { }
        Check(output.Single().Outcome == HydrationTimingOutcome.Failed && output[0].CacheHit is null && !output[0].ActivityText.Contains("PRIVATE"));
        output.Clear();
        try { await fixture.Run(output.Add, context: fixture.Context with { RequiredLength = 0 }); throw new Exception("Expected context refusal."); } catch (TransferException) { }
        Check(output.Single().Outcome == HydrationTimingOutcome.Failed);
    }
    private static async Task Cancellation()
    {
        using var fixture = new Fixture(); fixture.Source.Hold = true;
        var first = fixture.Run(_ => { }); await fixture.Source.Entered.Task;
        using var cancellation = new CancellationTokenSource(); var output = new List<HydrationTimingSummary>();
        var waiting = fixture.Run(output.Add, cancellation.Token); fixture.Clock.Now += 25; cancellation.Cancel();
        try {
            try { await waiting; throw new Exception("Expected cancellation."); } catch (OperationCanceledException) { }
            Check(output.Single().Outcome == HydrationTimingOutcome.Cancelled && output[0].PhaseMilliseconds[1] == 25 && output[0].PhaseMilliseconds[2] == 0 && output[0].CacheHit is null);
        } finally { fixture.Source.Release.TrySetResult(); await first; }
    }
    private sealed class Fixture : IDisposable {
        private readonly string root = CreateFixtureRoot();
        internal readonly Clock Clock = new();
        internal readonly Source Source;
        internal readonly Native Native;
        private readonly PlaceholderHydrationCoordinator coordinator;
        internal CloudFilesOperationContext Context => new(1, 2, 0, Source.Identity.Length, 0, Source.Identity.Length);
        internal Fixture() { Directory.CreateDirectory(root); Source = new(Clock); Native = new(Clock); coordinator = new(Source, "pilot", root, expectedPrincipal: Source.Identity.PrincipalId); }
        internal Task Run(Action<HydrationTimingSummary> observer, CancellationToken token = default, CloudFilesOperationContext? context = null) =>
            CloudFilesNativeTransfer.HydrateForCallbackAsync(coordinator, Source.Identity, context ?? Context, token, Native, TimeSpan.FromSeconds(20), observer, Clock);
        internal Task RunWithoutTiming() => CloudFilesNativeTransfer.HydrateForCallbackAsync(coordinator, Source.Identity, Context, CancellationToken.None, Native, TimeSpan.FromSeconds(20));
        public void Dispose() {
            coordinator.Dispose();
            // Retain only tiny synthetic evidence in the dedicated hidden artifact root. Never recursively delete an inferred path.
            File.WriteAllText(Path.Combine(root, "fixture-receipt.json"), "{\"schemaVersion\":1,\"syntheticOnly\":true,\"network\":false,\"nativeProvider\":false}");
        }
        private static string CreateFixtureRoot() {
            var selected = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? Path.Combine(AppContext.BaseDirectory, "test-artifacts", "hydration-timing");
            if (!Path.IsPathFullyQualified(selected) || selected.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Test artifacts require a dedicated local directory.");
            var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(selected));
            if (full == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!)) throw new IOException("A dedicated test artifact directory is required.");
            for (var part = full; part is not null; part = Path.GetDirectoryName(part)) {
                try { var attributes = File.GetAttributes(part); if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0) throw new IOException("Test artifacts cannot pass through aliases or files."); }
                catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            }
            var result = Path.Combine(full, "hydration-timing-" + Guid.NewGuid().ToString("N"));
            if (File.Exists(result) || Directory.Exists(result)) throw new IOException("A fresh synthetic fixture is required.");
            return result;
        }
    }
    private sealed class Native(Clock clock) : ICloudFilesTransferNative {
        internal int Transfers;
        public int Execute(nint info, nint parameters) { clock.Now += 5; Transfers++; return 0; }
        public int ReportProgress(long connectionKey, long transferKey, long total, long completed) => 0;
    }
    private sealed class Source(Clock clock) : IQueuedDownloadSource {
        internal static readonly byte[] Bytes = new byte[8192];
        internal readonly PlaceholderIdentity Identity = new("pilot", "employee", "https://timing.invalid", "odqp1_" + new string('a', 64), "odqr1_PRIVATE", "oef1_" + new string('b', 64), "v1", "PRIVATE.bin", Bytes.Length, "\"v1\"", Convert.ToHexStringLower(SHA256.HashData(Bytes)));
        internal bool Fail, Hold;
        internal int Downloads;
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously), Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Alias => "employee";
        public Uri Origin => new("https://timing.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) { clock.Now += 10; if (Fail) throw new IOException("PRIVATE source path"); return Task.FromResult(new QueuedDownloadSession(Identity.PrincipalId, DateTimeOffset.UtcNow.AddHours(1))); }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken cancellationToken = default) { clock.Now += 20; return Task.FromResult(new ResolvedQueuedDownload(Identity.PrincipalId, Identity.LogicalFileId, Identity.RemoteVersion, new DownloadSpec(Identity.LogicalFileId + ":" + Identity.RemoteVersion, new Uri(Origin, "/bytes"), Identity.FileName, Identity.Length, Identity.ETag, Identity.Sha256))); }
        public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) { Downloads++; Entered.TrySetResult(); if (Hold) await Release.Task.WaitAsync(cancellationToken); clock.Now += 100; var file = Path.Combine(destination, spec.FileName); await File.WriteAllBytesAsync(file, Bytes, cancellationToken); return file; }
    }
}
