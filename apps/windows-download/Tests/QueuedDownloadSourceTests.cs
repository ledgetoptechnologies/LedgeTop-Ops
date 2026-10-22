using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class QueuedDownloadSourceTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Reference = "odqr1_synthetic_resource";
    private static byte[] Bytes => "synthetic durable source verified content"u8.ToArray();
    private static string Sha => Convert.ToHexStringLower(SHA256.HashData(Bytes));
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("queue source employee and portal metadata renews exact identity with human fixed-origin GETs", Metadata),
        ("queue source selection queries encode once and unsafe selectors reject before authentication", Selection),
        ("queue source manifests reject foreign URLs weak metadata and unknown JSON fields", InvalidManifests),
        ("queue source status redirects duplicate JSON invalid UTF8 and bounds fail closed", Responses),
        ("queue source verified downloader emits truthful progress without credential persistence", Download),
        ("queue source cancellation does not launch login or start another request", Cancellation),
        ("queue actual adapter joins lightweight reference durable enqueue renewal and verified completion", JoinedQueue)
    ];
    private static void Assert(bool value) { if (!value) throw new Exception("Queue source assertion failed."); }
    private static async Task Throws<T>(Func<Task> run) where T : Exception { try { await run(); } catch (T) { return; } throw new Exception("Expected safe queue source failure."); }
    private static string Base(bool employee) => employee ? "/api/staff/files" : "/api/client/operations/data";
    private static Dictionary<string, object?> Manifest(bool employee, string handle = "renewed") => new() {
        ["schemaVersion"] = 1, ["logicalFileId"] = (employee ? "oef1_" : "ondf1_") + new string('b',64), ["remoteVersion"] = employee ? Sha : "provider-version-one",
        ["strongETag"] = "\"" + Sha + "\"", ["size"] = Bytes.Length, ["sha256"] = Sha, ["name"] = "queue.bin",
        ["downloadPath"] = employee ? Base(true)+"/downloads/eof1_"+handle : Base(false)+"/files/ond1_"+handle+"/download",
        ["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds()+600
    };
    private static Dictionary<string, object?> Envelope(bool employee, bool selected = false) {
        var result = new Dictionary<string,object?> { ["schemaVersion"]=1,["principalId"]=Principal,["manifest"]=Manifest(employee) };
        if(selected) { result.Remove("manifest"); result["resourceRef"]=Reference; } return result;
    }
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) {Content=new StringContent(JsonSerializer.Serialize(value),Encoding.UTF8,"application/json")};
    private static async Task Metadata() {
        foreach(var employee in new[]{true,false}) {
            using var f = new Fixture(); var requests = new List<string>();
            using var source = f.Source(employee,new Handler((r,_)=>{
                Assert(r.RequestUri!.Host=="source.example.invalid" && r.Method==HttpMethod.Get && r.Headers.Authorization is null && !r.Headers.Contains("Cookie"));
                Assert(r.Headers.GetValues("Cf-Access-Token").Single()==f.Runner.Token); requests.Add(r.RequestUri.AbsolutePath);
                return Task.FromResult(r.RequestUri.AbsolutePath.EndsWith("/session",StringComparison.Ordinal)
                    ? Json(new{schemaVersion=1,principalId=Principal,expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600}) : Json(Envelope(employee)));
            }));
            Assert((await source.GetSessionAsync()).PrincipalId==Principal);
            var first=await source.ResolveAsync(Reference);var second=await source.ResolveAsync(Reference);
            Assert(first.PrincipalId==Principal && first.LogicalFileId==second.LogicalFileId && first.RemoteVersion==second.RemoteVersion && first.Spec==second.Spec);
            Assert(first.Spec.OpaqueIdentity==first.LogicalFileId+":"+first.RemoteVersion && first.Spec.ContentUri.Host=="source.example.invalid");
            Assert(requests.SequenceEqual(new[]{Base(employee)+"/queue/session",Base(employee)+"/queue/resolve",Base(employee)+"/queue/resolve"}));
            Assert(f.Runner.Logins==0);
        }
    }
    private static async Task Selection() {
        using var f=new Fixture();var path="Clients/Ben/中 #?.jpg";
        using var employee = new EmployeeQueuedDownloadSource("employee",f.Session,new Handler((r,_)=>{
            Assert(r.RequestUri!.Query=="?rootId=20000000-0000-4000-8000-000000000001&path="+Uri.EscapeDataString(path));return Task.FromResult(Json(Envelope(true,true)));
        }),new Downloader([f.Session.Origin]));
        var selected=await employee.GetReferenceAsync("20000000-0000-4000-8000-000000000001",path);Assert(selected.ResourceReference==Reference);
        var before=f.Runner.Calls;
        await Throws<ArgumentException>(()=>employee.GetReferenceAsync("invalid",path));
        await Throws<ArgumentException>(()=>employee.GetReferenceAsync("20000000-0000-4000-8000-000000000001","../escape"));
        foreach(var unsafePath in new[]{"file%20name","a:b","a\\b","a/\u200db","a/\ud800"})
            await Throws<ArgumentException>(()=>employee.GetReferenceAsync("20000000-0000-4000-8000-000000000001",unsafePath));
        await Throws<TransferException>(()=>employee.ResolveAsync("https://evil.example/"));Assert(f.Runner.Calls==before);
        using var portal=new PortalQueuedDownloadSource("portal",f.Session,new Handler((r,_)=>{
            Assert(r.RequestUri!.Query=="?fileHandle=ond1_current");return Task.FromResult(Json(Envelope(false,true)));
        }),new Downloader([f.Session.Origin]));
        Assert((await portal.GetReferenceAsync("ond1_current")).ResourceReference==Reference);
        await Throws<ArgumentException>(()=>portal.GetReferenceAsync("eof1_wrong_source"));
    }
    private static async Task InvalidManifests() {
        foreach(var employee in new[]{true,false}) foreach(var key in new[]{"downloadPath","logicalFileId","remoteVersion","strongETag","size","sha256","name","expiresAt","unknown"}) {
            using var f=new Fixture();var manifest=Manifest(employee);
            manifest[key]=key switch {
                "downloadPath"=>"https://evil.example/bytes", "logicalFileId"=>"oef1_wrong", "remoteVersion"=>employee?"wrong": " bad ", "strongETag"=>"W/\"weak\"",
                "size"=>-1,"sha256"=>new string('F',64),"name"=>"../unsafe","expiresAt"=>DateTimeOffset.UtcNow.ToUnixTimeSeconds()+901,_=>true
            };
            var envelope=Envelope(employee);envelope["manifest"]=manifest;
            using var source=f.Source(employee,new Handler((_,_)=>Task.FromResult(Json(envelope))));await Throws<TransferException>(()=>source.ResolveAsync(Reference));
        }
        using(var f=new Fixture()) {
            using var source=f.Source(true,new Handler((_,_)=>Task.FromResult(Json(new{schemaVersion=1,principalId="client-supplied",expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600}))));
            await Throws<TransferException>(()=>source.GetSessionAsync());
        }
        using(var f=new Fixture()) {
            var envelope=Envelope(false);var manifest=Manifest(false);manifest["name"]=" map.bin";envelope["manifest"]=manifest;
            using var source=f.Source(false,new Handler((_,_)=>Task.FromResult(Json(envelope))));
            Assert((await source.ResolveAsync(Reference)).Spec.FileName==" map.bin");
        }
    }
    private static async Task Responses() {
        foreach(var status in new[]{401,403,404,409,302,503}) {
            using var f=new Fixture();var calls=0;
            using var source=f.Source(true,new Handler((_,_)=>{calls++;return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status));}));
            if(status==401)await Throws<LoginRequiredException>(()=>source.ResolveAsync(Reference));
            else if(status==403)await Throws<AccessDeniedException>(()=>source.ResolveAsync(Reference));
            else if(status is 404 or 409)await Throws<ResourceUnavailableException>(()=>source.ResolveAsync(Reference));
            else await Throws<TransferException>(()=>source.ResolveAsync(Reference));
            Assert(calls==1 && f.Runner.Logins==0);
        }
        foreach(var variant in new[]{"duplicate","utf8","oversize","encoding"}) {
            using var f=new Fixture();
            using var source=f.Source(false,new Handler((_,_)=>{
                var r=Json(Envelope(false));
                if(variant=="duplicate") r.Content=new StringContent("{\"schemaVersion\":1,\"schemaVersion\":1}",Encoding.UTF8,"application/json");
                if(variant=="utf8") {r.Content=new ByteArrayContent([0xff]);r.Content.Headers.ContentType=new("application/json");}
                if(variant=="oversize")r.Content=new StringContent(new string(' ',96*1024+1),Encoding.UTF8,"application/json");
                if(variant=="encoding")r.Content.Headers.ContentEncoding.Add("gzip");
                return Task.FromResult(r);
            }));await Throws<TransferException>(()=>source.ResolveAsync(Reference));
        }
    }
    private static async Task Download() {
        using var f=new Fixture();var phases=new List<DownloadProgress>();
        using var source=f.Source(true,new Handler((_,_)=>Task.FromResult(Json(Envelope(true)))),new Handler((r,_)=>{
            Assert(r.Headers.GetValues("Cf-Access-Token").Single()==f.Runner.Token && r.Headers.IfMatch.Single().Tag=="\""+Sha+"\"");
            var result=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Bytes)};result.Headers.ETag=new EntityTagHeaderValue("\""+Sha+"\"");return Task.FromResult(result);
        }));
        var resolved=await source.ResolveAsync(Reference);var output=await source.DownloadAsync(resolved.Spec,f.Root,new ProgressSink(phases));
        Assert(File.ReadAllBytes(output).SequenceEqual(Bytes));Assert(phases.Last().Phase==DownloadPhase.Completed && phases.Last().BytesTransferred==Bytes.Length);
        await Throws<TransferException>(()=>source.DownloadAsync(resolved.Spec with {ContentUri=new Uri("https://evil.example/bytes")},f.Root));
    }
    private static async Task Cancellation() {
        using var f=new Fixture();using var source=f.Source(true,new Handler(async(_,token)=>{await Task.Delay(Timeout.Infinite,token);throw new Exception("unreachable");}));
        using var cancel=new CancellationTokenSource(50);await Throws<OperationCanceledException>(()=>source.ResolveAsync(Reference,cancel.Token));Assert(f.Runner.Logins==0);
    }
    private static async Task JoinedQueue() {
        using var f=new Fixture();int preparations=0,bytes=0;
        using var source=f.Source(true,new Handler((request,_)=>{
            var path=request.RequestUri!.AbsolutePath;
            if(path.EndsWith("/session",StringComparison.Ordinal))return Task.FromResult(Json(new{schemaVersion=1,principalId=Principal,expiresAt=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600}));
            if(path.EndsWith("/reference",StringComparison.Ordinal))return Task.FromResult(Json(Envelope(true,true)));
            preparations++;var envelope=Envelope(true);envelope["manifest"]=Manifest(true,"renewal"+preparations);return Task.FromResult(Json(envelope));
        }),new Handler((request,_)=>{
            bytes++;Assert(request.RequestUri!.AbsolutePath.EndsWith("eof1_renewal2",StringComparison.Ordinal));
            var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Bytes)};response.Headers.ETag=new("\""+Sha+"\"");return Task.FromResult(response);
        }));
        var selected=await ((EmployeeQueuedDownloadSource)source).GetReferenceAsync("20000000-0000-4000-8000-000000000001","folder/file");
        Assert(preparations==0 && selected.PrincipalId==Principal);
        var output=Path.Combine(f.Root,"output");Directory.CreateDirectory(output);
        var state=Path.Combine(f.Root,"state");Directory.CreateDirectory(state);
        await using(var queue=await TransferQueue.OpenAsync(state,source)) {
            var id=await queue.EnqueueAsync(selected.ResourceReference,output);Assert(preparations==1 && bytes==0);
            await queue.StartAsync(id);await queue.WaitForIdleAsync();
            Assert(preparations==2 && bytes==1 && (await queue.GetJobsAsync()).Single().State==QueuedTransferState.Completed);
        }
        Assert(File.ReadAllBytes(Path.Combine(output,"queue.bin")).SequenceEqual(Bytes));
        var durable=File.ReadAllText(Path.Combine(state,"queue.json"));
        Assert(durable.Contains(Reference,StringComparison.Ordinal) && !durable.Contains("eof1_",StringComparison.Ordinal) && !durable.Contains("Cf-Access",StringComparison.Ordinal)
            && !durable.Contains(f.Runner.Token,StringComparison.Ordinal));
        await using var reopened=await TransferQueue.OpenAsync(state,source);
        Assert((await reopened.GetJobsAsync()).Single().State==QueuedTransferState.Completed && bytes==1);
    }
    private sealed class ProgressSink(List<DownloadProgress> items):IProgress<DownloadProgress>{public void Report(DownloadProgress p)=>items.Add(p);}
    private sealed class Handler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> action):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>action(request,cancellationToken);
    }
    private sealed class Runner:IAccessCommandRunner {
        internal int Calls,Logins;internal string Token="";
        public Task<AccessCommandResult> RunAsync(string path,IReadOnlyList<string> arguments,CancellationToken ct) {
            Calls++;if(arguments.Contains("login"))Logins++;
            Token="eyJhbGciOiJSUzI1NiJ9."+Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new{sub="synthetic-person",exp=DateTimeOffset.UtcNow.ToUnixTimeSeconds()+3600})).TrimEnd('=').Replace('+','-').Replace('/','_')+".c2ln";
            return Task.FromResult(new AccessCommandResult(0,Token,""));
        }
    }
    private sealed class Fixture:IDisposable {
        internal string Root=Path.Combine(Path.GetTempPath(),"ltds-queue-source-synthetic-"+Guid.NewGuid().ToString("N"));internal Runner Runner=new();internal CloudflareAccessSession Session;
        internal Fixture(){Directory.CreateDirectory(Root);var binary=Path.Combine(Root,"synthetic.bin");File.WriteAllText(binary,"synthetic owned never executed");Session=new(new Uri("https://source.example.invalid/portal/"),binary,Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(binary))),Runner);}
        internal QueuedDownloadSource Source(bool employee,HttpMessageHandler metadata,HttpMessageHandler? data=null) {
            var downloader=data is null?new Downloader(Session):new Downloader(data,[Session.Origin],session:Session);
            return employee?new EmployeeQueuedDownloadSource("staff",Session,metadata,downloader):new PortalQueuedDownloadSource("portal",Session,metadata,downloader);
        }
        public void Dispose()=>Directory.Delete(Root,true);
    }
}
