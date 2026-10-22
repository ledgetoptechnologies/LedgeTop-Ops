using System.Runtime.InteropServices;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class CloudFilesCallbackTests
{
    private const string Principal="odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly byte[] Bytes=Enumerable.Range(0,150123).Select(i=>(byte)(i%251)).ToArray();
    private static PlaceholderIdentity Identity=>new("pilot","portal","https://source.example.invalid",Principal,"odqr1_dummy",
        "ondf1_"+new string('b',64),"v1","file.bin",Bytes.Length,"\"v1\"",Convert.ToHexStringLower(SHA256.HashData(Bytes)));
    private static CloudFilesOperationContext Context(long request=0)=>new(123,456,request,Bytes.Length,0,-1);
    internal static IEnumerable<(string Name,Func<Task> Run)> Groups=>[
        ("callback copied immutable identity deduplicates request and performs actual verified download",CopiedAndDeduplicated),
        ("callback malformed foreign context and conflicting key cannot reach hydration",Boundaries),
        ("callback cancellation drains only matching request and refuses unsupported subsets",Cancel),
        ("callback stop rejects new requests and drains terminal and keepalive before disposal",Stop),
        ("callback native EOF normalization bounded active map and failure redaction",Limits),
        ("callback actual managed native adapter marshals only verified coordinator bytes",NativeBoundary)
    ];
    private static void Assert(bool value){if(!value)throw new Exception("Callback assertion failed.");}
    private static async Task Reject(Func<Task> action){try{await action();}catch(TransferException){return;}throw new Exception("Expected callback rejection.");}
    private static async Task Cancelled(Task task){try{await task;throw new Exception("Expected cancellation.");}catch(OperationCanceledException){}}
    private static async Task CopiedAndDeduplicated()
    {
        using var f=new Fixture();var started=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var sinks=new List<Sink>();
        await using var dispatcher=f.Create(async(c,id,context,token)=>{started.TrySetResult();await release.Task.WaitAsync(token);var sink=new Sink();sinks.Add(sink);await c.HydrateAsync(id,context.RequiredOffset,context.RequiredLength,sink,token);},1);
        var bytes=Identity.Encode();var task=dispatcher.FetchDataAsync(bytes,Context());await started.Task;
        await Reject(()=>dispatcher.FetchDataAsync(bytes,Context(1)));
        await Reject(()=>dispatcher.FetchDataAsync(bytes,Context() with{RequiredLength=4096}));
        await Reject(()=>dispatcher.FetchDataAsync((Identity with{RemoteVersion="v2"}).Encode(),Context()));
        var again=dispatcher.FetchDataAsync(bytes,Context());Assert(ReferenceEquals(task,again));Array.Fill(bytes,(byte)0);release.SetResult();await task;
        Assert(sinks.Single().Data.SequenceEqual(Bytes)&&sinks.Single().Complete==1&&f.Source.Downloads==1);
        var later=dispatcher.FetchDataAsync(Identity.Encode(),Context() with {RequiredOffset=4096,RequiredLength=4096});await later;Assert(!ReferenceEquals(task,later)&&sinks.Count==2&&f.Source.Downloads==1);
    }
    private static async Task Boundaries()
    {
        using var f=new Fixture();var calls=0;await using var dispatcher=f.Create((c,id,context,t)=>{calls++;return c.HydrateAsync(id,context.RequiredOffset,context.RequiredLength,new Sink(),t);});
        foreach(var id in new[]{Identity with{Channel="stable"},Identity with{PrincipalId="odqp1_"+new string('c',64)},Identity with{Origin="https://other.example.invalid"}})
            await Reject(()=>dispatcher.FetchDataAsync(id.Encode(),Context()));
        foreach(var context in new[]{Context() with{ConnectionKey=9},Context() with{FileSize=0},Context() with{RequiredOffset=1},Context() with{RequiredLength=long.MaxValue},Context() with{RequiredLength=0}})
            await Reject(()=>dispatcher.FetchDataAsync(Identity.Encode(),context));
        await Reject(()=>dispatcher.FetchDataAsync(new byte[4097],Context()));await Reject(()=>dispatcher.FetchDataAsync("bad"u8.ToArray(),Context()));Assert(calls==0);
        await dispatcher.FetchDataAsync(Identity.Encode(),Context());
        await dispatcher.FetchDataAsync(Identity.Encode(),Context() with{RequiredLength=4096});Assert(calls==2);
        f.Source.Revoked=true;await Reject(()=>dispatcher.FetchDataAsync(Identity.Encode(),Context(1)));Assert(f.Source.Downloads==1);
    }
    private static async Task Cancel()
    {
        using var f=new Fixture();var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var drain=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var terminal=new Sink();
        await using var dispatcher=f.Create(async(c,id,context,t)=>{
            if(context.RequestKey==1){await c.HydrateAsync(id,context.RequiredOffset,context.RequiredLength,new Sink(),t);return;}
            var sink=new Sink {Write=async()=>{entered.TrySetResult();try{await Task.Delay(Timeout.Infinite,t);}finally{await drain.Task;}}};
            terminal=sink;await c.HydrateAsync(id,context.RequiredOffset,context.RequiredLength,sink,t);
        });
        var task=dispatcher.FetchDataAsync(Identity.Encode(),Context());await entered.Task;
        var unrelated=dispatcher.FetchDataAsync(Identity.Encode(),Context(1));
        var key=new CloudFilesRequestKey(123,456,0);
        Assert(await dispatcher.CancelFetchDataAsync(key,4096,4096)==CloudFilesCancelResult.UnsupportedRange&&!task.IsCompleted);
        Assert(await dispatcher.CancelFetchDataAsync(key with{RequestKey=2},0,Bytes.Length)==CloudFilesCancelResult.NotFound);
        var cancel=dispatcher.CancelFetchDataAsync(key,0,Bytes.Length);await Task.Yield();Assert(!cancel.IsCompleted);drain.SetResult();Assert(await cancel==CloudFilesCancelResult.Drained);await Cancelled(task);await unrelated;Assert(terminal.Failed==1&&terminal.Complete==0);
    }
    private static async Task Stop()
    {
        using var f=new Fixture();var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);var keepaliveJoined=false;
        var dispatcher=f.Create(async(c,id,context,t)=>{
            try{await c.HydrateAsync(id,context.RequiredOffset,context.RequiredLength,new Sink {Write=async()=>{entered.TrySetResult();await Task.Delay(Timeout.Infinite,t);}},t);}
            finally{await release.Task;keepaliveJoined=true;}
        });
        var task=dispatcher.FetchDataAsync(Identity.Encode(),Context());await entered.Task;
        using var timeout=new CancellationTokenSource();var stop=dispatcher.StopAsync(timeout.Token);timeout.Cancel();await Cancelled(stop);Assert(!keepaliveJoined);
        await Reject(()=>dispatcher.FetchDataAsync(Identity.Encode(),Context(1)));
        var drained=dispatcher.StopAsync();Assert(!drained.IsCompleted);release.SetResult();await drained;await Cancelled(task);Assert(keepaliveJoined);await dispatcher.DisposeAsync();
        Assert(await dispatcher.CancelFetchDataAsync(new(123,456,0),0,Bytes.Length)==CloudFilesCancelResult.NotFound);
    }
    private static async Task Limits()
    {
        using var f=new Fixture();CloudFilesOperationContext? received=null;
        await using var dispatcher=f.Create((c,id,context,t)=>{received=context;return c.HydrateAsync(id,context.RequiredOffset,context.RequiredLength,new Sink(),t);},1);
        await dispatcher.FetchDataAsync(Identity.Encode(),Context());Assert(received!.RequiredLength==Bytes.Length);
        for(var index=1;index<12;index++)await dispatcher.FetchDataAsync(Identity.Encode(),Context(index));
        using var other=new Fixture();await using var broken=other.Create((c,id,context,t)=>throw new Exception("synthetic-secret-do-not-leak"));
        try{await broken.FetchDataAsync(Identity.Encode(),Context());throw new Exception("Expected failure");}catch(TransferException e){Assert(!e.Message.Contains("synthetic-secret"));}
    }
    private static async Task NativeBoundary() {
        using var f=new Fixture();var native=new CapturingNative();
        await using var dispatcher=f.Create((c,id,context,t)=>CloudFilesNativeTransfer.HydrateForCallbackAsync(c,id,context,t,native,TimeSpan.FromSeconds(20)));
        await dispatcher.FetchDataAsync(Identity.Encode(),Context());
        Assert(native.Data.SequenceEqual(Bytes)&&native.Offsets.SequenceEqual(new long[]{0,65536,131072})&&native.Progress>=1);
        await dispatcher.StopAsync();var calls=native.Progress;await Task.Yield();Assert(native.Progress==calls);
    }
    private sealed class CapturingNative:ICloudFilesTransferNative {
        internal List<byte> Data=[];internal List<long> Offsets=[];internal int Progress;
        public int ReportProgress(long connection,long transfer,long total,long complete){Assert(connection==123&&transfer==456&&total==1&&complete==0);Progress++;return 0;}
        public int Execute(nint op,nint parameters){
            var info=Marshal.PtrToStructure<CloudOperationInfo>(op);var p=Marshal.PtrToStructure<CloudOperationParameters>(parameters);
            Assert(info.ConnectionKey.Internal==123&&info.TransferKey==456&&info.RequestKey==0&&p.TransferData.CompletionStatus==0);
            var bytes=new byte[checked((int)p.TransferData.Length)];Marshal.Copy(p.TransferData.Buffer,bytes,0,bytes.Length);Data.AddRange(bytes);Offsets.Add(p.TransferData.Offset);return 0;
        }
    }
    private sealed class Sink:IPlaceholderTransferSink
    {
        internal List<byte> Data=[];internal int Complete,Failed;internal Func<Task>? Write;
        public async Task WriteAsync(long offset,ReadOnlyMemory<byte> bytes,CancellationToken t){Data.AddRange(bytes.ToArray());if(Write is not null)await Write();}
        public Task CompleteAsync(CancellationToken t){Complete++;return Task.CompletedTask;}public Task FailAsync(string code){Failed++;return Task.CompletedTask;}
    }
    private sealed class Source:IQueuedDownloadSource,IDisposable
    {
        internal bool Revoked;internal int Downloads;private readonly Downloader engine=new(new Handler(),[new Uri("https://source.example.invalid")]);
        public string Alias=>"portal";public Uri Origin=>new("https://source.example.invalid");
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken t=default)=>Task.FromResult(new QueuedDownloadSession(Principal,DateTimeOffset.UtcNow.AddHours(1)));
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference,CancellationToken t=default){if(Revoked)throw new AccessDeniedException();var id=Identity;return Task.FromResult(new ResolvedQueuedDownload(Principal,id.LogicalFileId,id.RemoteVersion,new(id.LogicalFileId+":"+id.RemoteVersion,new Uri(Origin,"/content"),id.FileName,id.Length,id.ETag,id.Sha256)));}
        public async Task<string> DownloadAsync(DownloadSpec spec,string destination,IProgress<DownloadProgress>? progress=null,CancellationToken cancellationToken=default){Downloads++;return await engine.DownloadAsync(spec,destination,cancellationToken,progress);}
        public void Dispose()=>engine.Dispose();
        private sealed class Handler:HttpMessageHandler{protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken t){var response=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(Bytes)};response.Headers.ETag=EntityTagHeaderValue.Parse(Identity.ETag);return Task.FromResult(response);}}
    }
    private sealed class Fixture:IDisposable
    {
        private readonly string root=Path.Combine(Path.GetTempPath(),"ltds-callback-"+Guid.NewGuid().ToString("N"));internal Source Source=new();
        internal Fixture()=>Directory.CreateDirectory(root);
        internal CloudFilesCallbackDispatcher Create(CloudFilesCallbackHydrator hydrate,int limit=256)=>new(Source,"pilot",Principal,123,root,hydrate,limit);
        public void Dispose(){Source.Dispose();Directory.Delete(root,true);}
    }
}
