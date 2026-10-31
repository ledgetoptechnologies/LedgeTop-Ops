using System.Text.Json;
using LedgeTop.Files;

internal static class HydrationTimingDiagnosticStoreTests
{
    internal const string Sample = "Hydration timing: outcome=Completed; cache=Miss; totalMs=100; contextMs=1; queueMs=2; authBeforeMs=20; cachePrepareMs=1; downloadMs=40; cacheVerifyMs=1; authAfterMs=25; nativeTransferMs=10; authBeforeTokenMs=3; authBeforeHeadersMs=14; authAfterTokenMs=4; authAfterHeadersMs=17; authBeforeTokenCount=1; authBeforeHeadersCount=1; authAfterTokenCount=1; authAfterHeadersCount=1";
    internal static Task Run()
    {
        const string sample = Sample;
        var value = HydrationTimingDiagnosticStore.Parse(sample) ?? throw new Exception("Valid numeric timing rejected.");
        var extended = sample + "; downloadHeadersMs=1; downloadBodyMs=2; downloadFlushMs=3; downloadHashMs=4";
        Require(HydrationTimingDiagnosticStore.Parse(extended)?.Values.SequenceEqual(value.Values) == true, "extended timing preserves legacy record");
        Require(HydrationTimingDiagnosticStore.Parse(extended + "; token=secret") is null, "extended private fields rejected");
        Require(HydrationTimingDiagnosticStore.Parse(extended.Replace("downloadBodyMs=2", "downloadBodyMs=86400001")) is null, "extended bounds checked");
        Require(HydrationTimingDiagnosticStore.Parse(sample + "; filename=secret.jpg") is null, "extra private fields rejected");
        Require(HydrationTimingDiagnosticStore.Parse(sample.Replace("authBeforeHeadersMs=14", "authBeforeHeadersMs=999999999")) is null, "out-of-range rejected");
        Require(HydrationTimingDiagnosticStore.Parse(sample.Replace("authBeforeTokenCount=1", "authBeforeTokenCount=0").Replace("authBeforeHeadersCount=1", "authBeforeHeadersCount=0").Replace("authAfterTokenCount=1", "authAfterTokenCount=0").Replace("authAfterHeadersCount=1", "authAfterHeadersCount=0")) is null, "noninstrumented sample rejected");
        var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic root required.");
        var dir = Path.Combine(parent, "timing-" + Guid.NewGuid().ToString("N"), "connected-explorer-pilot-employee"); Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, HydrationTimingDiagnosticStore.Leaf); var now = DateTimeOffset.UtcNow;
        DiagnosticPathBoundaryTests.Run(parent,'t',HydrationTimingDiagnosticStore.Leaf,".last-hydration-timing.write.tmp",(d,owned)=>HydrationTimingDiagnosticStore.TrySave(d,owned,value,now));
        HydrationTimingDiagnosticStore.TrySave(dir, () => false, value, now); Require(!File.Exists(path), "unowned write refused");
        var extendedValue = HydrationTimingDiagnosticStore.Parse(extended)!;
        HydrationTimingDiagnosticStore.TrySave(dir, () => true, extendedValue, now);
        // A rolled-back build expects the exact 17-value schema and must be able
        // to decode and replace the previous observation on a later write.
        var afterUpgrade = File.ReadAllBytes(path);
        using (var prior = JsonDocument.Parse(afterUpgrade)) Require(prior.RootElement.GetProperty("values").GetArrayLength() == 17, "upgrade persists exact legacy value count");
        HydrationTimingDiagnosticStore.TrySave(dir, () => true, value, now.AddMilliseconds(1));
        Require(!File.ReadAllBytes(path).AsSpan().SequenceEqual(afterUpgrade), "legacy-shaped observation replaces upgraded record");
        var bytes = File.ReadAllBytes(path); using (var doc = JsonDocument.Parse(bytes)) {
            Require(doc.RootElement.GetProperty("values").GetArrayLength() == 17 && doc.RootElement.EnumerateObject().Count() == 8, "closed numeric schema");
        }
        HydrationTimingDiagnosticStore.TrySave(dir, () => true, value, now.AddSeconds(-1)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes), "older observation refused");
        var watch = System.Diagnostics.Stopwatch.StartNew();
        for (var i = 1; i <= 10; i++) HydrationTimingDiagnosticStore.TrySave(dir, () => true, value, now.AddMilliseconds(i + 1));
        watch.Stop(); Console.WriteLine("Synthetic timing-store 10 sequential local writes elapsed ms: " + watch.ElapsedMilliseconds);
        File.WriteAllText(path, "foreign-data"); HydrationTimingDiagnosticStore.TrySave(dir, () => true, value, now.AddMinutes(1));
        Require(File.ReadAllText(path) == "foreign-data", "unknown data preserved");
        return Task.CompletedTask;
    }
    private static void Require(bool value, string message) { if (!value) throw new Exception(message); }
}
