using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class DownloaderInactivityTests
{
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("download subphase timing observes synthetic transfer without exposing request data", DownloadTiming),
        ("download timing isolates parallel requests and records failure and cancellation", DownloadTimingFailures),
        ("download stalled headers expire without publishing or leaking request resources", HeaderStall),
        ("download stalled body preserves owned prefix and resumes with range and final SHA", BodyStallResume),
        ("download stream creation and final EOF probe have inactivity bounds", CreationAndEofStalls),
        ("download caller cancellation stays distinct from network inactivity", ExplicitCancellation),
        ("download progressing chunks may exceed one inactivity interval in total", ActiveProgress),
        ("download network inactivity configuration rejects invalid or unbounded budgets", Configuration),
        ("hydration diagnostics byte GET preserves actual HTTP versus invalid metadata and network", FailureFacts),
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
        ("memory download mid-body stall is Timeout and caller cancellation stays distinct", MemoryBodyStallAndCancel),
#endif
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
            Assert(error.Reason == TransferFailureReason.Timeout && error.HttpStatus is null, "Inactivity diagnostic lost its bounded reason.");
        } catch (TimeoutException) {
            cleanup.Cancel(); try { await transfer; } catch (OperationCanceledException) { }
            throw new Exception("Network inactivity budget did not stop the stalled transfer.");
        }
    }
    private static void NoFinal(DirectoryFixture root) => Assert(!File.Exists(Path.Combine(root.Path,"map.bin")),"Unverified file was published.");
    private static async Task DownloadTiming() {
        using var root = new DirectoryFixture();
        using var engine = Engine(new AsyncHandler(async (_, ct) => { await Task.Delay(20, ct); var response = Response(new ByteArrayContent(Bytes)); response.Version = System.Net.HttpVersion.Version20; return response; }));
        var observed = new List<HydrationTimingSummary>();
        using var timing = new HydrationTiming(observed.Add);
        using (DownloadTimingScope.BeginForTest(timing)) {
            var output = await engine.DownloadAsync(Spec(), root.Path);
            Assert((await File.ReadAllBytesAsync(output)).SequenceEqual(Bytes), "Timed transfer changed bytes.");
        }
        timing.AddAuthorizationTime(true, true, TimeSpan.Zero);
        timing.Complete(HydrationTimingOutcome.Completed);
        var summary = observed.Single();
        Assert(summary.DownloadMilliseconds[0] >= 10, "Delayed synthetic headers were not recorded.");
        Assert(summary.ActivityText.Contains("downloadHashMs=") && summary.ActivityText.Contains("contentProtocol=HTTP/2") && !summary.ActivityText.Contains("never-log-this"), "Protocol timing or private request redaction failed.");
    }
    private static async Task DownloadTimingFailures() {
        async Task<HydrationTimingSummary> Run(int delay, bool fail, bool cancel) {
            using var root = new DirectoryFixture();
            using var engine = Engine(new AsyncHandler(async (_, ct) => {
                await Task.Delay(delay, ct);
                if (fail) throw new HttpRequestException("PRIVATE connection");
                return Response(new ByteArrayContent(Bytes));
            }), TimeSpan.FromSeconds(3));
            using var cancellation = new CancellationTokenSource();
            var observed = new List<HydrationTimingSummary>();
            using var timing = new HydrationTiming(observed.Add);
            if (cancel) cancellation.CancelAfter(30);
            using (DownloadTimingScope.BeginForTest(timing)) {
                try {
                    await engine.DownloadAsync(Spec(), root.Path, cancellation.Token);
                    Assert(!fail && !cancel, "Synthetic failure unexpectedly completed.");
                } catch (OperationCanceledException) when (cancel) { }
                catch (TransferException) when (fail) { }
            }
            timing.AddAuthorizationTime(true, true, TimeSpan.Zero);
            timing.Complete(cancel ? HydrationTimingOutcome.Cancelled : fail ? HydrationTimingOutcome.Failed : HydrationTimingOutcome.Completed);
            return observed.Single();
        }
        var concurrent = await Task.WhenAll(Run(20, false, false), Run(100, false, false), Run(50, true, false), Run(1000, false, true));
        Assert(concurrent[0].DownloadMilliseconds[0] >= 10 && concurrent[1].DownloadMilliseconds[0] >= 80 && concurrent[0].DownloadMilliseconds[0] < concurrent[1].DownloadMilliseconds[0], "Concurrent timings mixed or missing.");
        Assert(concurrent[2].Outcome == HydrationTimingOutcome.Failed && concurrent[2].DownloadMilliseconds[0] >= 40 && concurrent[2].DownloadMilliseconds[1] == 0, "Failed header timing missing.");
        Assert(concurrent[3].Outcome == HydrationTimingOutcome.Cancelled && concurrent[3].DownloadMilliseconds[0] >= 10 && concurrent[3].DownloadMilliseconds[1] == 0, "Cancelled header timing missing.");
        Assert(concurrent.All(x => !x.ActivityText.Contains("PRIVATE") && !x.ActivityText.Contains("never-log-this")), "Private details escaped timing.");
    }
    private static async Task HeaderStall() {
        using var root = new DirectoryFixture(); using var cleanup = new CancellationTokenSource();
        var handler = new StalledHeaders(); using var engine = Engine(handler);
        var transfer = engine.DownloadAsync(Spec(),root.Path,cleanup.Token);
        await handler.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); await ExpectIdle(transfer,cleanup);
        Assert(handler.Cancelled && handler.RequestContent.Disposed,"Stalled header request was not cancelled/disposed."); NoFinal(root);
    }
    private static async Task FailureFacts() {
        foreach(var status in new[]{302,429,502,503}) {
            using var root=new DirectoryFixture();var calls=0;
            using var engine=Engine(new AsyncHandler((_,_)=>{calls++;return Task.FromResult(new HttpResponseMessage((HttpStatusCode)status){Content=new StringContent("SECRET response")});}));
            try{await engine.DownloadAsync(Spec(),root.Path);throw new Exception("Unexpected download success");}
            catch(TransferException error){Assert(error.Reason==TransferFailureReason.UnexpectedHttpStatus&&error.HttpStatus==status&&error.InnerException is null&&!error.Message.Contains("SECRET"),"HTTP diagnostic lost or leaked");}
            Assert(calls==1,"Failure was retried");NoFinal(root);
        }
        using(var root=new DirectoryFixture())using(var engine=Engine(new AsyncHandler((_,_)=>{
            var response=Response(new ByteArrayContent(Bytes));response.Content.Headers.ContentLength=Bytes.Length+1;return Task.FromResult(response);
        }))) {
            try{await engine.DownloadAsync(Spec(),root.Path);throw new Exception("Invalid length accepted");}
            catch(TransferException error){Assert(error.Reason==TransferFailureReason.InvalidMetadata&&error.HttpStatus is null,"A successful HTTP envelope with invalid length was misclassified");}
            NoFinal(root);
        }
        using(var root=new DirectoryFixture())using(var engine=Engine(new AsyncHandler((_,_)=>Task.FromResult(new HttpResponseMessage(HttpStatusCode.Created){Content=new ByteArrayContent(Bytes)})))) {
            try{await engine.DownloadAsync(Spec(),root.Path);throw new Exception("Unsupported successful HTTP contract accepted");}
            catch(TransferException error){Assert(error.Reason==TransferFailureReason.InvalidMetadata&&error.HttpStatus is null,"A successful but unsupported response was called an HTTP service failure");}
            NoFinal(root);
        }
        using(var root=new DirectoryFixture())using(var engine=Engine(new AsyncHandler((_,_)=>throw new HttpRequestException("SECRET transport URL")))) {
            try{await engine.DownloadAsync(Spec(),root.Path);throw new Exception("Missing network refusal");}
            catch(TransferException error){Assert(error.Reason==TransferFailureReason.Network&&error.HttpStatus is null&&error.InnerException is null&&!error.Message.Contains("SECRET"),"Network failure leaked or lost classification");}
            NoFinal(root);
        }
    }
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
    private static async Task MemoryBodyStallAndCancel() {
        // Inactivity after 7 of 32 body bytes: bounded Timeout, stream cancelled and disposed, nothing returned.
        var stalled = new StalledBody(7); var buffer = new byte[Bytes.Length];
        using (var engine = Engine(new AsyncHandler((_,_) => Task.FromResult(Response(new StreamContent(stalled)))))) {
            var transfer = engine.DownloadVerifiedIntoAsync(Spec(), buffer);
            await stalled.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            try { await transfer.WaitAsync(TimeSpan.FromSeconds(2)); throw new Exception("Stalled memory body completed."); }
            catch (TransferException error) { Assert(error.Reason == TransferFailureReason.Timeout && error.HttpStatus is null && error.Message == "Download stalled; no bytes were used.", "Memory stall lost its Timeout classification."); }
        }
        Assert(stalled.Cancelled && stalled.Disposed, "Stalled memory body was not cancelled/disposed.");
        Assert(buffer.All(b => b == 0), "Stalled memory body left received bytes in the buffer.");
        // Caller cancellation mid-body (after 7 bytes, long inactivity budget) surfaces as cancellation, not Timeout.
        var held = new StalledBody(7); using var caller = new CancellationTokenSource(); var held2 = new byte[Bytes.Length];
        using (var engine = Engine(new AsyncHandler((_,_) => Task.FromResult(Response(new StreamContent(held)))), TimeSpan.FromMinutes(5))) {
            var transfer = engine.DownloadVerifiedIntoAsync(Spec(), held2, caller.Token);
            await held.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2)); caller.Cancel();
            try { await transfer.WaitAsync(TimeSpan.FromSeconds(2)); throw new Exception("Cancelled memory body completed."); }
            catch (OperationCanceledException) { }
        }
        Assert(held.Cancelled && held.Disposed, "Cancelled memory body was not cancelled/disposed.");
        Assert(held2.All(b => b == 0), "Cancelled memory body left received bytes in the buffer.");
        // A buffer that does not match the trusted length is refused before any request.
        var calls = 0;
        using (var engine = Engine(new AsyncHandler((_,_) => { calls++; return Task.FromResult(Response(new ByteArrayContent(Bytes))); }))) {
            try { await engine.DownloadVerifiedIntoAsync(Spec(), new byte[Bytes.Length - 1]); throw new Exception("Mismatched memory buffer accepted."); }
            catch (TransferException) { }
        }
        Assert(calls == 0, "Mismatched memory buffer sent a request.");
        // Disposal fault after a fully verified body: classified failure, buffer wiped (success is set only after disposal).
        var faulty = new DisposeFaultContent(Bytes); var wiped = new byte[Bytes.Length];
        using (var engine = Engine(new AsyncHandler((_,_) => { var r = Response(faulty); return Task.FromResult(r); }))) {
            try { await engine.DownloadVerifiedIntoAsync(Spec(), wiped); throw new Exception("Disposal fault was hidden."); }
            catch (TransferException error) { Assert(error.Reason == TransferFailureReason.ResponseRead, "Disposal fault lost its classification."); }
        }
        Assert(faulty.Disposed && wiped.All(b => b == 0), "Disposal fault left verified bytes in the buffer.");
    }
#endif
#if LEDGETOP_MEMORY_HYDRATION_TEST_HOOKS
    private sealed class DisposeFaultContent(byte[] bytes) : HttpContent {
        internal bool Disposed;
        protected override Task SerializeToStreamAsync(Stream stream, System.Net.TransportContext? context) => stream.WriteAsync(bytes).AsTask();
        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new FaultStream(bytes, this));
        protected override bool TryComputeLength(out long length) { length = bytes.Length; return true; }
        private sealed class FaultStream(byte[] bytes, DisposeFaultContent owner) : MemoryStream(bytes) {
            public override ValueTask DisposeAsync() { owner.Disposed = true; base.Dispose(); throw new IOException("synthetic disposal fault"); }
            protected override void Dispose(bool disposing) { owner.Disposed = true; base.Dispose(disposing); }
        }
    }
#endif
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
