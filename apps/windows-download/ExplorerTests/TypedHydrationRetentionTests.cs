using LedgeTop.Files.Explorer;
using LedgeTop.WindowsDownload;
internal static class TypedHydrationRetentionTests
{
    private static void Check(bool condition) { if (!condition) throw new IOException("Typed hydration retention assertion failed."); }
    internal static async Task<int> RunAsync() {
        var activity=new OrderedActivity();
        var diagnostic=new HydrationFailureDiagnostic(HydrationStage.AuthorizationBefore,HydrationFailureCategory.LoginRequired,
            loginReason:LoginFailureReason.HttpUnauthorized,loginOperation:LoginFailureOperation.CachedToken);
        activity.Add("Downloading private filename Support code: hydrate/Secret/Password");
        activity.RecordDownloadFailure(diagnostic);
        for(var i=0;i<150;i++) activity.Add("success " + i);
        var rows=activity.Snapshot();
        Check(rows.Count==101 && rows.Any(x=>x.Text.Contains("Recent file-download support code: hydrate/AuthorizationBefore/LoginRequired/Unknown; auth=CachedToken/HttpUnauthorized; HTTP 401",StringComparison.Ordinal)) &&
            rows.All(x=>!x.Text.Contains("private filename",StringComparison.Ordinal) && !x.Text.Contains("Secret/Password",StringComparison.Ordinal)));
        var other=new OrderedActivity();
        await Task.WhenAll(Enumerable.Range(0,8).Select(worker=>Task.Run(()=>{
            for(var i=0;i<200;i++) { other.RecordDownloadFailure(new HydrationFailureDiagnostic((HydrationStage)worker,HydrationFailureCategory.LocalIO)); other.Add("success"); }
        })));
        rows=other.Snapshot();
        Check(rows.Count<=120 && rows.Count(x=>x.RecentDownloadFailure)==8 && rows.Zip(rows.Skip(1),(a,b)=>a.Sequence<b.Sequence).All(x=>x));
        var many=new OrderedActivity();
        foreach(var stage in Enum.GetValues<HydrationStage>()) foreach(var category in new[]{HydrationFailureCategory.LocalIO,HydrationFailureCategory.Unknown,HydrationFailureCategory.LocalAccessDenied})
            many.RecordDownloadFailure(new HydrationFailureDiagnostic(stage,category));
        Check(many.Snapshot().Count(x=>x.RecentDownloadFailure)==20);
        var merged=OrderedActivity.Merge([new ActivityEntry(long.MinValue,"legacy one")],[new ActivityEntry(long.MinValue,"legacy two")]);
        Check(merged.Count==2 && merged.Any(x=>x.Text=="legacy one") && merged.Any(x=>x.Text=="legacy two"));
        Check(new OrderedActivity().Snapshot().Count==0);
        Console.WriteLine("PASS typed in-memory hydration failure retention, concurrency, bounds and legacy collision"); return 0;
    }
}
