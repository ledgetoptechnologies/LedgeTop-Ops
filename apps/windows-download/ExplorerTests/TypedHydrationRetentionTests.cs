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
        activity.AddDownloadFailure(diagnostic);
        Check(activity.Snapshot().Count==2 && activity.Snapshot().Count(x=>x.Text==diagnostic.ActivityText)==1 && activity.Snapshot().All(x=>!x.RecentDownloadFailure));
        for(var i=0;i<150;i++) activity.Add("success " + i);
        var rows=activity.Snapshot();
        Check(rows.Count==101 && rows.Any(x=>x.Text.Contains("Recent file-download support code: hydrate/AuthorizationBefore/LoginRequired/Unknown; auth=CachedToken/HttpUnauthorized; HTTP 401",StringComparison.Ordinal)) &&
            rows.All(x=>!x.Text.Contains("private filename",StringComparison.Ordinal) && !x.Text.Contains("Secret/Password",StringComparison.Ordinal)));
        var other=new OrderedActivity();
        await Task.WhenAll(Enumerable.Range(0,8).Select(worker=>Task.Run(()=>{
            for(var i=0;i<200;i++) { other.AddDownloadFailure(new HydrationFailureDiagnostic((HydrationStage)worker,HydrationFailureCategory.LocalIO)); other.Add("success"); }
        })));
        rows=other.Snapshot();
        Check(rows.Count<=120 && Enumerable.Range(0,8).All(worker=>rows.Any(x=>x.Text.Contains($"hydrate/{(HydrationStage)worker}/LocalIO/Unknown",StringComparison.Ordinal))) && rows.Zip(rows.Skip(1),(a,b)=>a.Sequence<b.Sequence).All(x=>x));
        var many=new OrderedActivity();
        foreach(var stage in Enum.GetValues<HydrationStage>()) foreach(var category in new[]{HydrationFailureCategory.LocalIO,HydrationFailureCategory.Unknown,HydrationFailureCategory.LocalAccessDenied})
            many.AddDownloadFailure(new HydrationFailureDiagnostic(stage,category));
        for(var i=0;i<150;i++) many.Add("success");
        Check(many.Snapshot().Count(x=>x.RecentDownloadFailure)==20);
        var merged=OrderedActivity.Merge([new ActivityEntry(long.MinValue,"legacy one")],[new ActivityEntry(long.MinValue,"legacy two")]);
        Check(merged.Count==2 && merged.Any(x=>x.Text=="legacy one") && merged.Any(x=>x.Text=="legacy two"));
        // Synthetic event route: no native construction, filesystem, hydration, or registration.
        var session=OwnedExplorerRootSession.Generated(Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N")),Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N")));
        var provider=(NativePlaceholderProvider)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(NativePlaceholderProvider));
        var publicEvents=new List<string>(); provider.Activity += publicEvents.Add; provider.ActivityDetailed += session.OnProviderActivity;
        var notice=typeof(NativePlaceholderProvider).GetMethod("Notice",System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic,null,[typeof(string),typeof(HydrationFailureDiagnostic)],null)!;
        notice.Invoke(provider,[diagnostic.ActivityText,diagnostic]);
        var display=OrderedActivity.Merge(session.ActivityEntries, new OrderedActivity().Snapshot());
        Check(publicEvents.SequenceEqual([diagnostic.ActivityText]) && display.Count==1 && display[0].Text==diagnostic.ActivityText);
        for(var i=0;i<150;i++) session.OnProviderActivity("success",null);
        display=OrderedActivity.Merge(session.ActivityEntries, new OrderedActivity().Snapshot());
        Check(display.Count==101 && display.Any(x=>x.Text.Contains("auth=CachedToken/HttpUnauthorized; HTTP 401",StringComparison.Ordinal) && x.RecentDownloadFailure));
        var replacement=OwnedExplorerRootSession.Generated(Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N")),Path.Combine(Path.GetTempPath(),Guid.NewGuid().ToString("N")));
        Check(!OrderedActivity.Merge(replacement.ActivityEntries).Any(x=>x.RecentDownloadFailure));
        Check(new OrderedActivity().Snapshot().Count==0);
        Console.WriteLine("PASS typed in-memory hydration failure retention, concurrency, bounds and legacy collision"); return 0;
    }
}

