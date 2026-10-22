using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class PlaceholderHydrationTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly byte[] Bytes = Enumerable.Range(0, 150123).Select(i => (byte)(i % 251)).ToArray();
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    private static PlaceholderIdentity Identity => new("pilot", "portal", "https://source.example.invalid", Principal,
        "odqr1_synthetic", "ondf1_" + new string('b',64), "v1", "example.bin", Bytes.Length, "\"v1\"", Sha);
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("placeholder identity strict versioned nonauthorizing codec", Codec),
        ("placeholder actual downloader verifies full bytes before bounded aligned range publication and cache reuse", Full),
        ("placeholder rejects revoked principal and version after lengthy download before any sink bytes", Authorization),
        ("placeholder hashes cached bytes again before publication and refuses tampering", Corruption),
        ("placeholder cancellation and native alignment/overflow limits fail without excess bytes", Ranges),
        ("placeholder channel/source/root isolation and bounded cache refuse unsafe inputs", Scope),
        ("placeholder write exclusion and terminal sink failures never double complete", Sharing)
    ];
    private static void Assert(bool value) { if (!value) throw new Exception("Hydration assertion failed."); }
    private static async Task Reject(Func<Task> action) { try { await action(); } catch (TransferException) { return; } throw new Exception("Expected hydration rejection."); }
    private static async Task Codec()
    {
        var padded = Identity with { ResourceReference = "odqr1_" };
        padded = padded with { ResourceReference = "odqr1_x" };
        var remaining = 4096 - padded.Encode().Length;
        padded = padded with { ResourceReference = padded.ResourceReference + new string('x', remaining) };
        Assert(padded.Encode().Length == 4096);
        await Reject(() => { (padded with { ResourceReference = padded.ResourceReference + "x" }).Encode(); return Task.CompletedTask; });
        var encoded = Identity.Encode(); Assert(PlaceholderIdentity.Decode(encoded) == Identity);
        var text = Encoding.UTF8.GetString(encoded); Assert(!text.Contains("https://source.example.invalid/"));
        foreach (var invalid in new[] {text.Replace("\"Version\":1", "\"Version\":2"), text.Replace("\"Version\":1", "\"Version\":1,\"Version\":1"), text.Replace("\"Identity\":{", "\"Unknown\":true,\"Identity\":{"), text.Replace("\"Length\":150123,", ""), text.Replace("odqr1_synthetic", "https://secret.invalid/token")})
            await Reject(() => { PlaceholderIdentity.Decode(Encoding.UTF8.GetBytes(invalid)); return Task.CompletedTask; });
    }
    private static async Task Full()
    {
        using var f = new Fixture(); var sink = new Sink { BeforeWrite = () => Assert(f.Source.Downloads == 1 && f.Source.Resolves == 2) };
        await f.Coordinator.HydrateAsync(Identity, 4096, 8192, sink);
        Assert(sink.Data.SequenceEqual(Bytes.Skip(4096).Take(8192)) && sink.Offsets.SequenceEqual(new long[] {4096}) && sink.Complete == 1 && sink.Failed == 0);
        var second = new Sink(); await f.Coordinator.HydrateAsync(Identity, 0, Bytes.Length, second);
        Assert(second.Data.SequenceEqual(Bytes) && f.Source.Downloads == 1 && second.Offsets.SequenceEqual(new long[] {0,65536,131072}));
        Assert(!Directory.GetFiles(f.Root, "*", SearchOption.AllDirectories).Any(path => File.ReadAllText(path).Contains("synthetic-secret-token")));
    }
    private static async Task Authorization()
    {
        foreach (var change in new[] {"revoke","principal","version","etag","hash","alias","origin","uri"}) {
            using var f = new Fixture(); f.Source.AfterDownload = () => f.Source.Mode = change; var sink = new Sink();
            await Reject(() => f.Coordinator.HydrateAsync(Identity, 0, Bytes.Length, sink));
            Assert(f.Source.Downloads == 1 && sink.Data.Count == 0 && sink.Failed == 1 && sink.Complete == 0);
        }
    }
    private static async Task Corruption()
    {
        using var f = new Fixture(); await f.Coordinator.HydrateAsync(Identity, 0, 4096, new Sink());
        f.Source.Mode = "revoke"; var denied = new Sink(); await Reject(() => f.Coordinator.HydrateAsync(Identity,0,4096,denied)); Assert(denied.Data.Count == 0); f.Source.Mode = "";
        var file = Directory.GetFiles(f.Root,"example.bin",SearchOption.AllDirectories).Single();
        var bytes = File.ReadAllBytes(file); bytes[4000] ^= 1; File.WriteAllBytes(file, bytes);
        var sink = new Sink(); await Reject(() => f.Coordinator.HydrateAsync(Identity, 0, 4096, sink)); Assert(sink.Data.Count == 0 && sink.Failed == 1);
        using var corrupt = new Fixture(); corrupt.Source.CorruptTransport = true; var never = new Sink();
        await Reject(() => corrupt.Coordinator.HydrateAsync(Identity,0,Bytes.Length,never)); Assert(never.Data.Count == 0);
    }
    private static async Task Ranges()
    {
        using var f = new Fixture();
        foreach (var range in new[] {(-1L,1L),(0L,-1L),(long.MaxValue,1L),(0L,long.MaxValue),(1L,4096L),(0L,1L),(151552L,0L)}) {
            var sink = new Sink(); await Reject(() => f.Coordinator.HydrateAsync(Identity,range.Item1,range.Item2,sink)); Assert(sink.Failed == 1 && sink.Data.Count == 0);
        }
        using var stop = new CancellationTokenSource(); var cancel = new Sink { AfterWrite = () => stop.Cancel() };
        try { await f.Coordinator.HydrateAsync(Identity,0,Bytes.Length,cancel,stop.Token); throw new Exception("Expected cancellation"); } catch (OperationCanceledException) { }
        Assert(cancel.Data.Count == 65536 && cancel.Failed == 1 && cancel.Complete == 0);
        using var shortRead = new ShortReads(Bytes); var sliced = new Sink();
        await PlaceholderHydrationCoordinator.TransferVerifiedRange(shortRead,0,Bytes.Length,sliced,CancellationToken.None);
        Assert(sliced.Data.SequenceEqual(Bytes) && sliced.Offsets.SequenceEqual(new long[] {0,65536,131072}));
        var eof = new Sink(); await f.Coordinator.HydrateAsync(Identity,147456,Bytes.Length-147456,eof); Assert(eof.Data.SequenceEqual(Bytes.Skip(147456)));
    }
    private static async Task Scope()
    {
        using var f = new Fixture();
        foreach (var id in new[] {Identity with {Channel="stable"},Identity with {SourceAlias="other"},Identity with {Origin="https://other.example.invalid"},Identity with {PrincipalId="odqp1_"+new string('c',64)}}) {
            var sink = new Sink(); await Reject(()=>f.Coordinator.HydrateAsync(id,0,4096,sink)); Assert(sink.Data.Count==0);
        }
        using var tiny = new PlaceholderHydrationCoordinator(f.Source,"pilot",f.Root,Bytes.Length,Bytes.Length);
        await Reject(()=>tiny.HydrateAsync(Identity,0,4096,new Sink()));
        var unowned = Path.Combine(f.Root,"unowned");Directory.CreateDirectory(unowned);Directory.CreateDirectory(Path.Combine(unowned,"verified-hydration-v1"));
        await Reject(()=>{using var c = new PlaceholderHydrationCoordinator(f.Source,"pilot",unowned);return Task.CompletedTask;});
    }
    private static async Task Sharing()
    {
        using var f = new Fixture(); var blocked = false;
        var sink = new Sink {BeforeWrite=()=>{var file=Directory.GetFiles(f.Root,"example.bin",SearchOption.AllDirectories).Single();try {using var writer=new FileStream(file,FileMode.Open,FileAccess.Write,FileShare.ReadWrite);}catch(IOException){blocked=true;}}};
        await f.Coordinator.HydrateAsync(Identity,0,4096,sink);Assert(blocked);
        using var another = new PlaceholderHydrationCoordinator(f.Source,"pilot",f.Root);
        var attempted = false; var exclusive = new Sink { BeforeWrite = () => { var nested = new Sink(); try { another.HydrateAsync(Identity,0,4096,nested).GetAwaiter().GetResult(); } catch(TransferException) { attempted = true; } } };
        await f.Coordinator.HydrateAsync(Identity,0,4096,exclusive); Assert(attempted);
        var bad = new Sink {ThrowComplete=true};await Reject(()=>f.Coordinator.HydrateAsync(Identity,0,4096,bad));Assert(bad.Complete==1&&bad.Failed==0);
    }
    private sealed class Sink : IPlaceholderTransferSink
    {
        internal List<byte> Data = []; internal List<long> Offsets = [];internal int Complete,Failed;internal Action? BeforeWrite,AfterWrite;internal bool ThrowComplete;
        public Task WriteAsync(long offset,ReadOnlyMemory<byte> bytes,CancellationToken token){token.ThrowIfCancellationRequested();BeforeWrite?.Invoke();Offsets.Add(offset);Data.AddRange(bytes.ToArray());AfterWrite?.Invoke();return Task.CompletedTask;}
        public Task CompleteAsync(CancellationToken token){Complete++;if(ThrowComplete)throw new IOException("synthetic-secret-token");return Task.CompletedTask;}
        public Task FailAsync(string code){Assert(code is "cancelled" or "unavailable");Failed++;return Task.CompletedTask;}
    }
    private sealed class Source : IQueuedDownloadSource, IDisposable
    {
        private readonly Downloader engine;internal int Downloads,Resolves;internal string Mode="";internal Action? AfterDownload;internal bool CorruptTransport;
        public string Alias=>Mode=="alias"?"changed":"portal";public Uri Origin=>new(Mode=="origin"?"https://changed.example.invalid":"https://source.example.invalid");
        internal Source(){engine=new Downloader(new Handler(this),[Origin]);}
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token=default)=>Task.FromResult(new QueuedDownloadSession(Mode=="principal"?"odqp1_"+new string('c',64):Principal,DateTimeOffset.UtcNow.AddHours(1)));
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference,CancellationToken token=default){Resolves++;if(Mode=="revoke")throw new AccessDeniedException();var id=Identity;return Task.FromResult(new ResolvedQueuedDownload(Principal,id.LogicalFileId,Mode=="version"?"v2":id.RemoteVersion,new DownloadSpec(id.LogicalFileId+":"+id.RemoteVersion,new Uri(Mode=="uri"?new Uri("https://changed.example.invalid"):Origin,"/content?synthetic-secret-token"),id.FileName,id.Length,Mode=="etag"?"\"v2\"":id.ETag,Mode=="hash"?new string('0',64):id.Sha256)));}
        public async Task<string> DownloadAsync(DownloadSpec spec,string destination,IProgress<DownloadProgress>? progress=null,CancellationToken cancellationToken=default){Downloads++;var path=await engine.DownloadAsync(spec,destination,cancellationToken,progress);AfterDownload?.Invoke();return path;}
        public void Dispose()=>engine.Dispose();
        private sealed class Handler(Source source) : HttpMessageHandler {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){var data=Bytes.ToArray();if(source.CorruptTransport)data[5]^=1;var r=new HttpResponseMessage(HttpStatusCode.OK){Content=new ByteArrayContent(data)};r.Headers.ETag=EntityTagHeaderValue.Parse(Identity.ETag);r.Content.Headers.ContentLength=data.Length;return Task.FromResult(r);}
        }
    }
    private sealed class ShortReads(byte[] data) : MemoryStream(data) {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken token=default) => base.ReadAsync(buffer[..Math.Min(13,buffer.Length)],token);
    }
    private sealed class Fixture : IDisposable
    {
        internal string Root=Path.Combine(Path.GetTempPath(),"ltds-hydration-"+Guid.NewGuid().ToString("N"));internal Source Source=new();internal PlaceholderHydrationCoordinator Coordinator;
        internal Fixture(){Directory.CreateDirectory(Root);Coordinator=new(Source,"pilot",Root);}
        public void Dispose(){Coordinator.Dispose();Source.Dispose();Directory.Delete(Root,true);}
    }
}

