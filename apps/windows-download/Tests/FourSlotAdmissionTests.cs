using LedgeTop.WindowsDownload;

internal static class FourSlotAdmissionTests {
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("four occupied hydration slots drain before exclusive work", Drain),
        ("cancelled exclusive admission recovers all four permits", Cancel)
    ];
    static Task<HydrationCacheConcurrency.Lease> Take(string root, string key, CancellationToken ct = default, bool exclusive = false) =>
        HydrationCacheConcurrency.AcquireAsync(root, key, ct, exclusive);
    static void Need(bool condition) { if (!condition) throw new IOException("Four-slot admission invariant failed."); }
    static async Task Drain() {
        var root = Guid.NewGuid().ToString(); var held = new List<HydrationCacheConcurrency.Lease>();
        HydrationCacheConcurrency.Lease? exclusiveLease = null, nextLease = null;
        try {
            for (int i=0; i<4; i++) held.Add(await Take(root, "file-"+i));
            var exclusive = Take(root,"exclusive",exclusive:true);
            held[0].Dispose(); held[1].Dispose(); held[2].Dispose();
            Need(!exclusive.IsCompleted);
            var next = Take(root,"next"); Need(!next.IsCompleted);
            held[3].Dispose(); exclusiveLease = await exclusive.WaitAsync(TimeSpan.FromSeconds(8));
            Need(!next.IsCompleted); exclusiveLease.Dispose();
            nextLease = await next.WaitAsync(TimeSpan.FromSeconds(8));
        } finally { exclusiveLease?.Dispose(); nextLease?.Dispose(); foreach (var item in held) item.Dispose(); }
    }
    static async Task Cancel() {
        var root = Guid.NewGuid().ToString(); var held = new List<HydrationCacheConcurrency.Lease>(); var recovered = new List<HydrationCacheConcurrency.Lease>();
        using var cancel = new CancellationTokenSource();
        try {
            for (int i=0; i<4; i++) held.Add(await Take(root,"file-"+i));
            var exclusive = Take(root,"exclusive",cancel.Token,exclusive:true);
            held[0].Dispose(); held[1].Dispose(); cancel.Cancel();
            try { await exclusive.WaitAsync(TimeSpan.FromSeconds(8)); throw new IOException("Expected cancellation."); } catch (OperationCanceledException) { }
            held[2].Dispose(); held[3].Dispose();
            for (int i=0; i<4; i++) recovered.Add(await Take(root,"recovered-"+i).WaitAsync(TimeSpan.FromSeconds(8)));
            Need(recovered.Count == 4);
        } finally { foreach (var item in held) item.Dispose(); foreach (var item in recovered) item.Dispose(); }
    }
}
