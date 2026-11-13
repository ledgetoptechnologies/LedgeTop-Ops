using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;

internal static class LocalAvailabilityOperationTests
{
    internal static int Run()
    {
        var success = new Native(); LocalAvailabilityOperations.FreeNative(success, default);
        Require(success.Calls.SequenceEqual(["Open", "Unpin", "Dehydrate", "Close"]));
        var positiveSuccess = new Native { SuccessResult = 1 }; LocalAvailabilityOperations.FreeNative(positiveSuccess, default);
        Require(positiveSuccess.Calls.SequenceEqual(["Open", "Unpin", "Dehydrate", "Close"])); // HRESULT >= 0 remains success.
        foreach (var stage in new[] { LocalAvailabilityStage.Open, LocalAvailabilityStage.Unpin, LocalAvailabilityStage.Dehydrate }) {
            var native = new Native { Failure = stage };
            try { LocalAvailabilityOperations.FreeNative(native, default); throw new Exception("Expected native failure."); }
            catch (LocalAvailabilityException error) {
                Require(error.Stage == stage && error.Kind == LocalAvailabilityFailureKind.Native && error.NativeHResult == unchecked((int)0x80070187));
                Require(error.ActivityText.Contains("availability/" + stage + "/Native; native=0x80070187") && error.InnerException is null);
            }
            Require(native.Calls.Count(call => call == "Close") == (stage == LocalAvailabilityStage.Open ? 0 : 1));
            Require(native.Calls.SequenceEqual(stage switch {
                LocalAvailabilityStage.Open => new[] { "Open" },
                LocalAvailabilityStage.Unpin => ["Open", "Unpin", "Close"],
                _ => ["Open", "Unpin", "Dehydrate", "Close"]
            }));
        }
        var thrown = new Native { Failure = LocalAvailabilityStage.Dehydrate, Throw = true };
        try { LocalAvailabilityOperations.FreeNative(thrown, default); throw new Exception("Expected bounded throw."); }
        catch (LocalAvailabilityException error) {
            Require(error.Stage == LocalAvailabilityStage.Dehydrate && error.Kind == LocalAvailabilityFailureKind.Unknown && error.NativeHResult is null);
            Require(!error.ActivityText.Contains("SECRET") && !error.ToString().Contains("https://") && error.InnerException is null);
            Require(ReferenceEquals(error, LocalAvailabilityException.FromException(LocalAvailabilityStage.Inspect, error)));
        }
        Require(thrown.Calls.Last() == "Close");
        var cache = LocalAvailabilityException.FromException(LocalAvailabilityStage.CacheReclamation, new TransferException("SECRET https://private.invalid/token"));
        Require(cache.Stage == LocalAvailabilityStage.CacheReclamation && cache.Kind == LocalAvailabilityFailureKind.Transfer && cache.NativeHResult is null && !cache.ActivityText.Contains("SECRET"));
        Require(cache.ActivityText.StartsWith("The file is online-only, but its temporary download cache could not be cleared.", StringComparison.Ordinal));
        Require(!cache.ActivityText.Contains("Could not change local availability", StringComparison.Ordinal));
        foreach (var pair in new[] {
            (CacheReclamationFailureKind.Busy, LocalAvailabilityFailureKind.CacheBusy),
            (CacheReclamationFailureKind.AccessDenied, LocalAvailabilityFailureKind.CacheAccessDenied),
            (CacheReclamationFailureKind.Unverified, LocalAvailabilityFailureKind.CacheUnverified),
            (CacheReclamationFailureKind.Other, LocalAvailabilityFailureKind.CacheOther) }) {
            var classified = LocalAvailabilityException.FromException(LocalAvailabilityStage.CacheReclamation, new CacheReclamationException(pair.Item1));
            Require(classified.Kind == pair.Item2 && classified.ActivityText.Contains("online-only") && classified.InnerException is null);
        }
        using var stop = new CancellationTokenSource(); stop.Cancel(); var cancelled = new Native();
        var sawCancellation = false;
        try { LocalAvailabilityOperations.FreeNative(cancelled, stop.Token); } catch (OperationCanceledException) { sawCancellation = true; }
        Require(sawCancellation && cancelled.Calls.Count == 0);
        Console.WriteLine("PASS unchanged Free native order/protection seam, exact stage/HRESULT, fail-close once, redaction/cache boundary and pre-cancellation; fake native only.");
        return 0;
    }
    private static void Require(bool value) { if (!value) throw new IOException("Local availability diagnostic fixture failed."); }
    private sealed class Native : ILocalAvailabilityNative
    {
        internal readonly List<string> Calls = [];
        internal LocalAvailabilityStage? Failure;
        internal bool Throw;
        internal int SuccessResult;
        private int Result(LocalAvailabilityStage stage) {
            Calls.Add(stage.ToString());
            if (stage != Failure) return SuccessResult;
            if (Throw) throw new Exception("SECRET https://private.invalid/token");
            return unchecked((int)0x80070187);
        }
        public int Open(out nint handle) { handle = 123; return Result(LocalAvailabilityStage.Open); }
        public int Unpin(nint handle) { Require(handle == 123); return Result(LocalAvailabilityStage.Unpin); }
        public int Dehydrate(nint handle) { Require(handle == 123); return Result(LocalAvailabilityStage.Dehydrate); }
        public void Close(nint handle) { Require(handle == 123); Calls.Add("Close"); }
    }
}
