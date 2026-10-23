using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class DownloaderInactivityTests
{
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("download stalled headers expire without publishing or leaking request resources", HeaderStall),
        ("download stalled body preserves owned prefix and resumes with range and final SHA", BodyStallResume),
        ("download stream creation and final EOF probe have inactivity bounds", CreationAndEofStalls),
        ("download caller cancellation stays distinct from network inactivity", ExplicitCancellation),
        ("download progressing chunks may exceed one inactivity interval in total", ActiveProgress),
        ("download network inactivity configuration rejects invalid or unbounded budgets", Configuration)
    ];
    private static readonly Uri Origin = new("https://synthetic-files.example.invalid");
    private static readonly byte[] Bytes = Enumerable.Range(0,32).Select(i => (byte)(i * 7)).ToArray();
    private static readonly TimeSpan Idle = TimeSpan.FromMilliseconds(150);
    private static DownloadSpec Spec() => new("synthetic-stall-resource", new Uri(Origin,"/content?secret=never-log-this"),
        "map.bin", Bytes.Length, "\"synthetic-version\"", Convert.ToHexStringLower(SHA256.HashData(Bytes)));
    private static Downloader Engine(HttpMessageHandler handler, TimeSpan? timeout = null) => new(handler,[Origin],networkInactivityTimeout:timeout ?? Idle);
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    private static HttpResponseMessage Response(HttpContent content, long offset = 0) {
        var response = new HttpResponseMessage(offset == 0 ? HttpStatusCode.OK : HttpStatusCode.PartialContent) { Content = content };
        response.Headers.ETag = EntityTagHeaderValue.Parse(Spec().ETag); content.Headers.ContentLength = Bytes.Length - offset;
        if (offset > 0) content.Headers.ContentRange = new ContentRangeHeaderValue(offset,Bytes.Length-1,Bytes.Length);
        return response;
    }
    private static async Task ExpectIdle(Task<string> transfer, CancellationTokenSource cleanup) {
        try { await transfer.WaitAsync(TimeSpan.FromSeconds(2)); throw new Exception("Stalled transfer unexpectedly completed."); }
        catch (TransferException error) {
            Assert(error.Message == "Download stalled; owned partial data can be retried.", "Inactivity must have a static retryable error.");
        } catch (TimeoutException) {
            cleanup.Cancel(); try { await transfer; } catch (OperationCanceledException) { }
            throw new Exception("Network inactivity budget did not stop the stalled transfer.");
        }
    }
    private static void NoFinal(DirectoryFixture root) => Assert(!File.Exists(Path.Combine(root.Path,"map.bin")),"Unverified file was published.");
    private static async Task HeaderStall() {
        using var root = new DirectoryFixture(); using var cleanup = new CancellationTokenSource();
        var handler = new StalledHeaders(); using var engine = Engine(handler);
        var transfer = engine.DownloadAsync(Spec(),root.Path,cleanup.Token);
        await handler.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); await ExpectIdle(transfer,cleanup);
        Assert(handler.Cancelled && handler.RequestContent.Disposed,"Stalled header request was not cancelled/disposed."); NoFinal(root);
    }
    private static async Task BodyStallResume() {
        using var root = new DirectoryFixture(); using var cleanup = new CancellationTokenSource();
        var stream = new StalledBody(7); using (var engine = Engine(new AsyncHandler((_,_) => Task.FromResult(Response(new StreamContent(stream)))))) {
            var transfer = engine.DownloadAsync(Spec(),root.Path,cleanup.Token);
            await stream.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); await ExpectIdle(transfer,cleanup);
        }
        Assert(stream.Cancelled && stream.Disposed,"Stalled body was not cancelled/disposed."); NoFinal(root);
        var partial = Directory.GetFiles(root.Path,"*.part",SearchOption.AllDirectories).Single();
        Assert((await File.ReadAllBytesAsync(partial)).SequenceEqual(Bytes[..7]),"Descriptor-bound resume prefix changed.");
        using var resumed = Engine(new AsyncHandler((request,_) => {
            Assert(request.Headers.Range?.ToString() == "bytes=7-" && request.Headers.IfMatch.Single().ToString() == Spec().ETag,
                "Retry did not retain exact version and range.");
            return Task.FromResult(Response(new ByteArrayContent(Bytes[7..]),7));
        }));
        var output = await resumed.DownloadAsync(Spec(),root.Path);
        await using var verified = File.OpenRead(output);
        Assert((await SHA256.HashDataAsync(verified)).SequenceEqual(SHA256.HashData(Bytes)),"Resumed final SHA mismatch.");
    }
    private static async Task CreationAndEofStalls() {
        using (var root = new DirectoryFixture()) {
            using var cleanup = new CancellationTokenSource(); var content = new StalledCreation();
            using var engine = Engine(new AsyncHandler((_,_) => Task.FromResult(Response(content))));
            var transfer=engine.DownloadAsync(Spec(),root.Path,cleanup.Token);
            await content.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); await ExpectIdle(transfer,cleanup);
            Assert(content.Cancelled && content.Disposed,"Stream creation did not cancel/dispose."); NoFinal(root);
        }
        using (var root = new DirectoryFixture()) {
            using var cleanup = new CancellationTokenSource(); var stream = new StalledBody(Bytes.Length);
            using (var engine = Engine(new AsyncHandler((_,_) => Task.FromResult(Response(new StreamContent(stream)))))) {
                var transfer=engine.DownloadAsync(Spec(),root.Path,cleanup.Token);
                await stream.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); await ExpectIdle(transfer,cleanup);
            }
            NoFinal(root); Assert(stream.Cancelled && stream.Disposed,"EOF probe did not cancel/dispose.");
            using var retry = Engine(new AsyncHandler((request,_) => {
                Assert(request.Headers.Range is null,"Unconfirmed full response was resumed as completed.");
                return Task.FromResult(Response(new ByteArrayContent(Bytes)));
            }));
            Assert((await File.ReadAllBytesAsync(await retry.DownloadAsync(Spec(),root.Path))).SequenceEqual(Bytes),"EOF retry failed.");
        }
    }
    private static async Task ExplicitCancellation() {
        foreach (var kind in new[] {"headers","creation","body"}) {
            using var root = new DirectoryFixture(); using var cancellation = new CancellationTokenSource();
            var headers=new StalledHeaders(); var creation=new StalledCreation(); var stream=new StalledBody(7);
            using var engine = Engine(kind == "headers" ? headers : new AsyncHandler((_,_) => Task.FromResult(Response(kind == "creation" ? creation : new StreamContent(stream)))),TimeSpan.FromSeconds(5));
            var transfer=engine.DownloadAsync(Spec(),root.Path,cancellation.Token);
            var entered=kind == "headers" ? headers.Entered : kind == "creation" ? creation.Entered : stream.Entered;
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); cancellation.Cancel();
            try { await transfer.WaitAsync(TimeSpan.FromSeconds(2)); throw new Exception("Caller cancellation was ignored."); }
            catch (OperationCanceledException) { Assert(cancellation.IsCancellationRequested,"Cancellation was not caller-owned."); }
            NoFinal(root);
        }
    }
    private static async Task ActiveProgress() {
        using var root = new DirectoryFixture(); var stream=new AdvancingBody();
        var timeout=TimeSpan.FromMilliseconds(500); using var engine=Engine(new AsyncHandler((_,_) => Task.FromResult(Response(new StreamContent(stream)))),timeout);
        var clock=Stopwatch.StartNew(); var output=await engine.DownloadAsync(Spec(),root.Path).WaitAsync(TimeSpan.FromSeconds(10));
        Assert(clock.Elapsed > timeout && (await File.ReadAllBytesAsync(output)).SequenceEqual(Bytes),"An active transfer hit a total-time cap.");
    }
    private static Task Configuration() {
        foreach(var value in new[]{TimeSpan.Zero,Timeout.InfiniteTimeSpan,TimeSpan.FromTicks(1),TimeSpan.FromMinutes(10)+TimeSpan.FromMilliseconds(1)}) {
            try { using var engine=Engine(new AsyncHandler((_,_)=>throw new Exception("Unexpected HTTP")),value); throw new Exception("Invalid inactivity budget accepted."); }
            catch(ArgumentOutOfRangeException) { }
        }
        return Task.CompletedTask;
    }
    private sealed class AsyncHandler(Func<HttpRequestMessage,CancellationToken,Task<HttpResponseMessage>> action):HttpMessageHandler {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)=>action(request,cancellationToken);
    }
    private sealed class TrackedContent():ByteArrayContent([]) {
        internal bool Disposed; protected override void Dispose(bool disposing){Disposed=true;base.Dispose(disposing);}
    }
    private sealed class StalledHeaders:HttpMessageHandler {
        internal TaskCompletionSource Entered=new(TaskCreationOptions.RunContinuationsAsynchronously); internal bool Cancelled;
        internal TrackedContent RequestContent=new();
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken){
            request.Content=RequestContent;Entered.TrySetResult();
            try{await Task.Delay(Timeout.Infinite,cancellationToken);throw new Exception("Unreachable");}catch(OperationCanceledException){Cancelled=true;throw;}
        }
    }
    private sealed class StalledBody(int stop):MemoryStream(Bytes) {
        internal TaskCompletionSource Entered=new(TaskCreationOptions.RunContinuationsAsynchronously);internal bool Cancelled,Disposed;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken cancellationToken=default){
            if(Position<stop)return await base.ReadAsync(buffer[..Math.Min(buffer.Length,stop-(int)Position)],cancellationToken);
            Entered.TrySetResult();try{await Task.Delay(Timeout.Infinite,cancellationToken);return 0;}catch(OperationCanceledException){Cancelled=true;throw;}
        }
        protected override void Dispose(bool disposing){Disposed=true;base.Dispose(disposing);}
    }
    private sealed class StalledCreation:HttpContent {
        internal TaskCompletionSource Entered=new(TaskCreationOptions.RunContinuationsAsynchronously);internal bool Cancelled,Disposed;
        protected override bool TryComputeLength(out long length){length=Bytes.Length;return true;}
        protected override Task SerializeToStreamAsync(Stream stream,TransportContext? context)=>throw new Exception("Unexpected buffering");
        protected override async Task<Stream> CreateContentReadStreamAsync(CancellationToken cancellationToken){
            Entered.TrySetResult();try{await Task.Delay(Timeout.Infinite,cancellationToken);throw new Exception("Unreachable");}catch(OperationCanceledException){Cancelled=true;throw;}
        }
        protected override void Dispose(bool disposing){Disposed=true;base.Dispose(disposing);}
    }
    private sealed class AdvancingBody():MemoryStream(Bytes) {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken cancellationToken=default){
            await Task.Delay(100,cancellationToken);return await base.ReadAsync(buffer[..Math.Min(4,buffer.Length)],cancellationToken);
        }
    }
}
