using System.Text;
using System.Text.Json;
using LedgeTop.Files;
using LedgeTop.WindowsDownload;

internal static class HydrationFailureDiagnosticStoreTests
{
    internal static Task Run()
    {
        var parent=Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? throw new IOException("Synthetic root required.");
        var dir=Path.Combine(parent,"failure-"+Guid.NewGuid().ToString("N"),"connected-explorer-pilot-employee"); Directory.CreateDirectory(dir);
        var path=Path.Combine(dir,HydrationFailureDiagnosticStore.Leaf); var now=DateTimeOffset.UtcNow;
        var value=new HydrationFailureDiagnosticStore.Observation(HydrationStage.Download,HydrationFailureCategory.Transfer,TransferFailureReason.UnexpectedHttpStatus,503);
        DiagnosticPathBoundaryTests.Run(parent,'f',HydrationFailureDiagnosticStore.Leaf,".latest-hydration-failure.write.tmp",(d,owned)=>HydrationFailureDiagnosticStore.TrySave(d,owned,value,now));
        HydrationFailureDiagnosticStore.TrySave(dir,()=>false,value,now); Require(!File.Exists(path),"unowned failure was written");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value,now);
        var review = value with { Stage=HydrationStage.CachePreparation, Reason=TransferFailureReason.LocalCacheReview, HttpStatus=null };
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,review,now.AddTicks(1));
        using (var doc=JsonDocument.Parse(File.ReadAllBytes(path))) Require(doc.RootElement.GetProperty("reason").GetString()=="Unknown" &&
            doc.RootElement.GetProperty("httpStatus").ValueKind==JsonValueKind.Null, "review reason must remain readable by legacy V1 readers");
        var busy = value with { Stage=HydrationStage.AuthorizationBefore, Reason=TransferFailureReason.ServiceBusy, HttpStatus=null };
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,busy,now.AddMilliseconds(1));
        using (var doc=JsonDocument.Parse(File.ReadAllBytes(path))) {
            Require(doc.RootElement.GetProperty("reason").GetString()=="UnexpectedHttpStatus" && doc.RootElement.GetProperty("httpStatus").GetInt32()==503,
                "busy evidence must remain readable by the legacy V1 reader");
        }
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value,now.AddMilliseconds(2));
        using (var doc=JsonDocument.Parse(File.ReadAllBytes(path))) Require(doc.RootElement.GetProperty("stage").GetString()=="Download","legacy-readable busy evidence blocked subsequent updates");
        now=now.AddMilliseconds(2);
        var bytes=File.ReadAllBytes(path); using (var doc=JsonDocument.Parse(bytes)) {
            var root=doc.RootElement;
            Require(root.EnumerateObject().Count()==14 && root.GetProperty("processId").GetInt32()>0 && root.GetProperty("processStartUtcTicks").GetInt64()>0 && root.GetProperty("stage").GetString()=="Download" &&
                root.GetProperty("category").GetString()=="Transfer" && root.GetProperty("reason").GetString()=="UnexpectedHttpStatus" && root.GetProperty("httpStatus").GetInt32()==503,
                "closed failure fields differ");
            Require(!Encoding.UTF8.GetString(bytes).Contains("secret",StringComparison.OrdinalIgnoreCase),"unexpected private text persisted");
        }
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value,now.AddSeconds(-1)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes),"older observation replaced latest");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value with { Stage=(HydrationStage)999 },now.AddSeconds(1)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes),"unknown stage accepted");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value with { HttpStatus=999 },now.AddSeconds(1)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes),"invalid HTTP status accepted");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value with { Reason=TransferFailureReason.Unknown },now.AddSeconds(1)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes),"status with incompatible reason accepted");
        var newer=value with { Stage=HydrationStage.AuthorizationBefore, Category=HydrationFailureCategory.LoginRequired, Reason=TransferFailureReason.Unknown, HttpStatus=null };
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,newer,now.AddSeconds(1));
        using (var doc=JsonDocument.Parse(File.ReadAllBytes(path))) Require(doc.RootElement.GetProperty("stage").GetString()=="AuthorizationBefore", "newer failure not saved");
        var unauthorized=newer with { LoginOperation=LoginFailureOperation.CachedToken, LoginReason=LoginFailureReason.HttpUnauthorized, HttpStatus=401 };
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,unauthorized,now.AddSeconds(2));
        var authBytes=File.ReadAllBytes(path); using (var doc=JsonDocument.Parse(authBytes))
            Require(doc.RootElement.GetProperty("loginOperation").GetString()=="CachedToken" && doc.RootElement.GetProperty("loginReason").GetString()=="HttpUnauthorized" &&
                doc.RootElement.GetProperty("httpStatus").GetInt32()==401,"bounded login reason/status missing");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,unauthorized with { LoginOperation=(LoginFailureOperation)999 },now.AddSeconds(3)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(authBytes),"unknown login operation accepted");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,unauthorized with { Category=HydrationFailureCategory.Transfer },now.AddSeconds(3)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(authBytes),"login fields under wrong category accepted");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,unauthorized with { HttpStatus=403 },now.AddSeconds(3)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(authBytes),"contradictory unauthorized status accepted");
        foreach (var reason in new[] { AccessDenialReason.HttpForbidden, AccessDenialReason.SourceConfiguration, AccessDenialReason.PrincipalMismatch }) {
            var observation=new HydrationFailureDiagnosticStore.Observation(HydrationStage.AuthorizationBefore,HydrationFailureCategory.AccessDenied,TransferFailureReason.Unknown,null,AccessReason:reason);
            HydrationFailureDiagnosticStore.TrySave(dir,()=>true,observation,now.AddSeconds(4));
            using var doc=JsonDocument.Parse(File.ReadAllBytes(path)); Require(doc.RootElement.GetProperty("accessReason").GetString()==reason.ToString(),"denial reason not saved");
        }
        var deniedBytes=File.ReadAllBytes(path);
        var invalid=new HydrationFailureDiagnosticStore.Observation(HydrationStage.AuthorizationBefore,HydrationFailureCategory.AccessDenied,TransferFailureReason.Unknown,null,AccessReason:(AccessDenialReason)999);
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,invalid,now.AddSeconds(5)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(deniedBytes),"invalid denial accepted");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,invalid with { Category=HydrationFailureCategory.Transfer, AccessReason=AccessDenialReason.HttpForbidden },now.AddSeconds(5)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(deniedBytes),"denial under wrong category accepted");
        var details=new HydrationFailureDiagnosticStore.Observation(HydrationStage.AuthorizationBefore,HydrationFailureCategory.AccessDenied,TransferFailureReason.Unknown,null,AccessReason:AccessDenialReason.HttpForbidden,DenialOperation:DenialOperation.QueueResolve,DenialMediaType:DenialMediaType.Html);
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,details,now.AddSeconds(5));
        var detailBytes=File.ReadAllBytes(path); using (var doc=JsonDocument.Parse(detailBytes)) Require(doc.RootElement.GetProperty("denialOperation").GetString()=="QueueResolve" && doc.RootElement.GetProperty("denialMediaType").GetString()=="Html","bounded denial details missing");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,details with { DenialMediaType=(DenialMediaType)999 },now.AddSeconds(6)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(detailBytes),"invalid media accepted");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,details with { AccessReason=AccessDenialReason.PrincipalMismatch },now.AddSeconds(6)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(detailBytes),"media with non-HTTP reason accepted");
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,details with { DenialMediaType=null },now.AddSeconds(6)); Require(File.ReadAllBytes(path).AsSpan().SequenceEqual(detailBytes),"partial denial metadata accepted");
        var previous=System.Text.Json.Nodes.JsonNode.Parse(deniedBytes)!.AsObject(); previous.Remove("denialOperation"); previous.Remove("denialMediaType"); File.WriteAllText(path,previous.ToJsonString());
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value,now.AddSeconds(6)); using (var doc=JsonDocument.Parse(File.ReadAllBytes(path))) Require(doc.RootElement.GetProperty("stage").GetString()=="Download","12-field record blocked update");
        var legacy=System.Text.Json.Nodes.JsonNode.Parse(deniedBytes)!.AsObject(); legacy.Remove("accessReason"); legacy.Remove("denialOperation"); legacy.Remove("denialMediaType"); File.WriteAllText(path,legacy.ToJsonString());
        HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value,now.AddSeconds(6)); using (var doc=JsonDocument.Parse(File.ReadAllBytes(path))) Require(doc.RootElement.GetProperty("stage").GetString()=="Download","legacy record blocked update");
        foreach (var extra in new[] { "denialOperation", "denialMediaType" }) {
            var partial=System.Text.Json.Nodes.JsonNode.Parse(deniedBytes)!.AsObject();
            partial.Remove("accessReason"); partial.Remove("denialOperation"); partial.Remove("denialMediaType"); partial[extra]=null;
            var raw=partial.ToJsonString(); File.WriteAllText(path,raw);
            HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value,now.AddMinutes(1));
            Require(File.ReadAllText(path)==raw,"unknown 12-field shape replaced");
        }
        File.WriteAllText(path,"foreign-data"); HydrationFailureDiagnosticStore.TrySave(dir,()=>true,value,now.AddMinutes(1)); Require(File.ReadAllText(path)=="foreign-data","unknown record replaced");
        return Task.CompletedTask;
    }
    private static void Require(bool condition,string message) { if (!condition) throw new Exception(message); }
}
