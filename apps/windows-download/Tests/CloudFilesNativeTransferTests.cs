using System.Runtime.InteropServices;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class CloudFilesNativeTransferTests {
    private const string Principal="odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly byte[] Bytes=Enumerable.Range(0,150123).Select(i=>(byte)(i%251)).ToArray();
    private static PlaceholderIdentity Identity=>new("pilot","portal","https://source.example.invalid",Principal,
        "odqr1_native_synthetic","ondf1_"+new string('b',64),"v1","example.bin",Bytes.Length,"\"v1\"",Convert.ToHexStringLower(SHA256.HashData(Bytes)));
    private static CloudFilesOperationContext Context=>new(0x1234567891234567,-0x1234567891234567,0,Bytes.Length,0,Bytes.Length);
    internal static IEnumerable<(string Name,Func<Task> Run)> Groups=>[
        ("native x64 ABI and pinned verified chunks preserve full keys and EOF range",Transfer),
        ("native malformed and empty callback ranges reject before native calls",Bounds),
        ("native post-download authorization denies all bytes and settles unavailable",Authorization),
        ("native HRESULT and thrown failure do not retry data",Failures),
        ("native cancellation preserves synchronous pin and settles only uncommitted IO",Cancellation),
        ("native progress heartbeat joins before final success and unavailable settlement",Progress)
    ];
    private static void Assert(bool value){if(!value)throw new Exception("Native transfer assertion failed.");}
    private static async Task Reject(Func<Task> run){try{await run();}catch(TransferException e){Assert(!e.Message.Contains("SECRET"));return;}throw new Exception("Expected native rejection.");}
    private static Task Run(Fixture f,Boundary b,CancellationToken token=default,CloudFilesOperationContext? context=null)=>
        CloudFilesNativeTransfer.HydrateForCallbackAsync(f.Coordinator,Identity,context??Context,token,b,TimeSpan.FromMilliseconds(5));
    private static async Task Transfer(){
        CloudFilesNativeTransfer.AssertAbi();
        Assert(Marshal.OffsetOf<CloudOperationInfo>(nameof(CloudOperationInfo.Type)).ToInt32()==4);
        Assert(Marshal.OffsetOf<CloudTransferData>(nameof(CloudTransferData.CompletionStatus)).ToInt32()==4);
        using var f=new Fixture();var b=new Boundary();await Run(f,b);
        Assert(b.Successes.SelectMany(x=>x.Data).SequenceEqual(Bytes));
        Assert(b.Successes.Select(x=>x.Offset).SequenceEqual(new long[]{0,65536,131072}));
        Assert(b.Failures.Count==0&&b.Events.Last()=="success"&&f.Source.Resolves==2);
        var count=b.Events.Count;await Task.Delay(25);Assert(b.Events.Count==count);
        using var partial=new Fixture();var p=new Boundary();
        await Run(partial,p,context:Context with{RequiredOffset=147456,RequiredLength=Bytes.Length-147456});
        Assert(p.Successes.Single().Data.SequenceEqual(Bytes.Skip(147456)));
    }
    private static async Task Bounds(){
        using var f=new Fixture();
        foreach(var c in new[]{Context with{FileSize=Bytes.Length+1},Context with{RequiredOffset=-1},Context with{RequiredLength=0},
            Context with{RequiredLength=-1},Context with{RequiredOffset=1,RequiredLength=4096},Context with{RequiredLength=1},
            Context with{RequiredOffset=long.MaxValue},Context with{RequiredLength=long.MaxValue},Context with{FileSize=0,RequiredLength=0}}){
            var b=new Boundary();await Reject(()=>Run(f,b,context:c));Assert(b.Events.Count==0);
        }
        Assert(f.Source.Resolves==0);
    }
    private static async Task Authorization(){
        using var f=new Fixture();f.Source.AfterDownload=()=>f.Source.Denied=true;var b=new Boundary();
        await Reject(()=>Run(f,b));Assert(b.Successes.Count==0&&b.Failures.Single().Status==CloudFilesNativeTransfer.Unavailable);
        Assert(b.Failures.Single().Length==Bytes.Length&&b.Events.Last()=="failure");
    }
    private static async Task Failures(){
        foreach(var mode in new[]{"HRESULT","throw"}){
            using var f=new Fixture();var b=new Boundary{FailureMode=mode};await Reject(()=>Run(f,b));
            Assert(b.Successes.Count==1&&b.Failures.Count==1);
            Assert(b.Failures[0].Offset==0&&b.Failures[0].Length==Bytes.Length);
        }
    }
    private static async Task Cancellation(){
        using(var f=new Fixture())using(var cancel=new CancellationTokenSource()){
            var b=new Boundary{DuringSuccess=_=>cancel.Cancel()};
            try{await Run(f,b,cancel.Token);throw new Exception("Expected cancellation");}catch(OperationCanceledException){}
            Assert(b.Successes.Count==1&&b.Successes[0].Data.SequenceEqual(Bytes.Take(65536)));
            Assert(b.Failures.Single().Status==CloudFilesNativeTransfer.Cancelled);
        }
        // Native success is a commit boundary, even when cancellation fires inside the final call.
        using(var f=new Fixture())using(var cancel=new CancellationTokenSource()){
            var b=new Boundary{DuringSuccess=end=>{if(end==Bytes.Length)cancel.Cancel();}};
            await Run(f,b,cancel.Token);Assert(b.Successes.Count==3&&b.Failures.Count==0&&b.Events.Last()=="success");
            var count=b.Events.Count;await Task.Delay(25);Assert(b.Events.Count==count);
        }
        using(var f=new Fixture())using(var cancel=new CancellationTokenSource()){
            cancel.Cancel();var b=new Boundary();
            try{await Run(f,b,cancel.Token);throw new Exception("Expected cancellation");}catch(OperationCanceledException){}
            Assert(b.Successes.Count==0&&b.Failures.Single().Status==CloudFilesNativeTransfer.Cancelled);
        }
    }
    private static async Task Progress(){
        using(var f=new Fixture()){
            var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            f.Source.BeforeDownload=token=>release.Task.WaitAsync(token);var b=new Boundary();var running=Run(f,b);
            await b.TwoReports.Task.WaitAsync(TimeSpan.FromSeconds(5));Assert(b.Successes.Count==0);release.SetResult();await running;
            Assert(b.ProgressCalls>=2&&b.Events.Last()=="success");var count=b.Events.Count;await Task.Delay(30);Assert(b.Events.Count==count);
        }
        foreach(var throwObserver in new[]{false,true})using(var f=new Fixture()){
            f.Source.BeforeDownload=async token=>{
                using var observer=token.Register(()=>{if(throwObserver)throw new Exception("SECRET observer");});
                await Task.Delay(Timeout.Infinite,token);
            };
            var b=new Boundary{FailProgressAfter=2};await Reject(()=>Run(f,b).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert(b.Successes.Count==0&&b.Failures.Single().Status==CloudFilesNativeTransfer.Unavailable&&b.Events.Last()=="failure");
        }
        using(var f=new Fixture()){
            var b=new Boundary{FailProgressAfter=1};await Reject(()=>Run(f,b));Assert(b.Failures.Count==1&&f.Source.Resolves==0);
        }
    }
    private sealed record Call(int Status,long Offset,long Length,byte[] Data);
    private sealed class Boundary:ICloudFilesTransferNative{
        internal readonly List<Call> Successes=[],Failures=[];
        internal readonly List<string> Events=[];
        internal readonly TaskCompletionSource TwoReports=new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal string FailureMode="";internal int FailProgressAfter=int.MaxValue,ProgressCalls;
        internal Action<long>? DuringSuccess;
        public int ReportProgress(long connectionKey,long transferKey,long total,long completed){
            Assert(connectionKey==Context.ConnectionKey&&transferKey==Context.TransferKey&&total==1&&completed==0);
            ProgressCalls++;Events.Add("progress");if(ProgressCalls>=2)TwoReports.TrySetResult();
            return ProgressCalls>=FailProgressAfter?unchecked((int)0x80004005):0;
        }
        public int Execute(nint info,nint parameters){
            // Inspect actual unmanaged memory while the synchronous call owns all pointers.
            Assert(Marshal.ReadInt32(info)==48&&Marshal.ReadInt32(info,4)==0);
            Assert(Marshal.ReadInt64(info,8)==Context.ConnectionKey&&Marshal.ReadInt64(info,16)==Context.TransferKey);
            Assert(Marshal.ReadInt64(info,24)==0&&Marshal.ReadInt64(info,32)==0&&Marshal.ReadInt64(info,40)==0);
            Assert(Marshal.ReadInt32(parameters)==40&&Marshal.ReadInt32(parameters,8)==0);
            var status=Marshal.ReadInt32(parameters,12);var pointer=Marshal.ReadIntPtr(parameters,16);
            var offset=Marshal.ReadInt64(parameters,24);var length=Marshal.ReadInt64(parameters,32);
            Assert(offset%4096==0&&length>0&&(length%4096==0||offset+length==Bytes.Length));
            if(status!=0){Assert(pointer==0);Failures.Add(new(status,offset,length,[]));Events.Add("failure");return 0;}
            Assert(pointer!=0&&length<=65536);DuringSuccess?.Invoke(offset+length);GC.Collect();GC.WaitForPendingFinalizers();
            var bytes=new byte[(int)length];Marshal.Copy(pointer,bytes,0,bytes.Length);
            Assert(bytes.SequenceEqual(Bytes.Skip((int)offset).Take((int)length)));
            Successes.Add(new(status,offset,length,bytes));Events.Add("success");
            if(FailureMode=="throw")throw new Exception("SECRET native error");
            return FailureMode=="HRESULT"?unchecked((int)0x80004005):0;
        }
    }
    private sealed class Source:IQueuedDownloadSource{
        public string Alias=>"portal";public Uri Origin=>new("https://source.example.invalid");
        internal int Resolves;internal bool Denied;internal Action? AfterDownload;internal Func<CancellationToken,Task>? BeforeDownload;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken=default){
            cancellationToken.ThrowIfCancellationRequested();if(Denied)throw new AccessDeniedException();
            return Task.FromResult(new QueuedDownloadSession(Principal,DateTimeOffset.UtcNow.AddHours(1)));
        }
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference,CancellationToken cancellationToken=default){
            cancellationToken.ThrowIfCancellationRequested();Resolves++;var id=Identity;
            return Task.FromResult(new ResolvedQueuedDownload(Principal,id.LogicalFileId,id.RemoteVersion,
                new DownloadSpec(id.LogicalFileId+":"+id.RemoteVersion,new Uri(Origin,"/synthetic"),id.FileName,id.Length,id.ETag,id.Sha256)));
        }
        public async Task<string> DownloadAsync(DownloadSpec spec,string destination,IProgress<DownloadProgress>? progress=null,CancellationToken cancellationToken=default){
            if(BeforeDownload is not null)await BeforeDownload(cancellationToken);
            var path=Path.Combine(destination,spec.FileName);await File.WriteAllBytesAsync(path,Bytes,cancellationToken);AfterDownload?.Invoke();return path;
        }
    }
    private sealed class Fixture:IDisposable{
        private readonly string root=Path.Combine(Path.GetTempPath(),"ltds-native-transfer-"+Guid.NewGuid().ToString("N"));
        internal Source Source=new();internal PlaceholderHydrationCoordinator Coordinator;
        internal Fixture(){Directory.CreateDirectory(root);Coordinator=new(Source,"pilot",root);}
        public void Dispose(){Coordinator.Dispose();Directory.Delete(root,true);}
    }
}
