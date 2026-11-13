using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;
internal static class SyntheticNetworkBufferTests {
    private sealed class Chunks(byte[] data,int cap,int failAt=-1) : MemoryStream(data) {
        internal long Reads, RequestedBytes;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer,CancellationToken token=default) {
            Reads++;RequestedBytes+=buffer.Length;
            if(failAt>=0 && Position>=failAt)throw new IOException("synthetic interruption");
            var n=Math.Min(buffer.Length,cap);if(failAt>=0)n=(int)Math.Min(n,failAt-Position);
            return base.ReadAsync(buffer[..n],token);
        }
    }
    private static DownloadSpec Spec(byte[] data)=>new("buffer-synthetic",new Uri("https://buffer.example.invalid/content"),"buffer.bin",data.Length,"\"v1\"",Convert.ToHexStringLower(SHA256.HashData(data)));
    private static HttpResponseMessage Response(Stream stream,int length,long offset=0,long total=0) {
        var response=new HttpResponseMessage(offset==0?HttpStatusCode.OK:HttpStatusCode.PartialContent){Content=new StreamContent(stream)};
        response.Headers.ETag=new EntityTagHeaderValue("\"v1\"");response.Content.Headers.ContentLength=length;
        if(offset!=0)response.Content.Headers.ContentRange=new ContentRangeHeaderValue(offset,total-1,total);return response;
    }
    private static Downloader Engine(Func<HttpRequestMessage,HttpResponseMessage> response)=>new(new FakeHandler((request,_)=>response(request)),[new Uri("https://buffer.example.invalid")]);
    private static void Need(bool value){if(!value)throw new Exception("Synthetic network buffer contract failed");}
    internal static async Task RunAsync() {
        foreach(var small in new[]{Array.Empty<byte>(),new byte[]{42}}) {
            using var root=new DirectoryFixture();using var engine=Engine(_=>Response(new Chunks(small,1),small.Length));
            var path=await engine.DownloadAsync(Spec(small),root.Path);Need(File.ReadAllBytes(path).SequenceEqual(small));
        }
        using(var root=new DirectoryFixture()) {
            var expected=new byte[]{1,2,3};using var engine=Engine(_=>Response(new Chunks(new byte[]{1,2,4},3),3));
            try{await engine.DownloadAsync(Spec(expected),root.Path);throw new Exception("Digest mismatch accepted");}catch(TransferException){}
            Need(!File.Exists(Path.Combine(root.Path,"buffer.bin")));
        }
        using(var root=new DirectoryFixture()) using(var cancellation=new CancellationTokenSource()) {
            var expected=new byte[]{1,2,3};using var engine=Engine(_=>Response(new CancellingStream(expected,cancellation),3));
            try{await engine.DownloadAsync(Spec(expected),root.Path,cancellation.Token);throw new Exception("Cancellation accepted");}catch(OperationCanceledException){}
            Need(cancellation.IsCancellationRequested && !File.Exists(Path.Combine(root.Path,"buffer.bin")));
        }
        var bytes=new byte[1024*1024+117];for(var i=0;i<bytes.Length;i++)bytes[i]=(byte)(i%251);var spec=Spec(bytes);
        using(var root=new DirectoryFixture()) {
            var shortStream=new Chunks(bytes,1379);using var engine=Engine(_=>Response(shortStream,bytes.Length));var path=await engine.DownloadAsync(spec,root.Path);
            Need(File.ReadAllBytes(path).SequenceEqual(bytes) && shortStream.Reads>100);
        }
        using(var root=new DirectoryFixture()) {
            const int prefix=70001;using(var first=Engine(_=>Response(new Chunks(bytes,4093,prefix),bytes.Length))) {try{await first.DownloadAsync(spec,root.Path);throw new Exception("Interrupted stream accepted");}catch(TransferException){}}
            using var second=Engine(request=>{Need(request.Headers.Range?.Ranges.Single().From==prefix);return Response(new Chunks(bytes[prefix..],4093),bytes.Length-prefix,prefix,bytes.Length);});
            var path=await second.DownloadAsync(spec,root.Path);Need(File.ReadAllBytes(path).SequenceEqual(bytes));
        }
        using(var root=new DirectoryFixture()) {
            const int prefix=70001;using(var first=Engine(_=>Response(new Chunks(bytes,4093,prefix),bytes.Length))) {try{await first.DownloadAsync(spec,root.Path);throw new Exception("Interrupted stream accepted");}catch(TransferException){}}
            var extra=bytes[prefix..].Concat(new byte[]{42}).ToArray();
            using var second=Engine(request=>{Need(request.Headers.Range?.Ranges.Single().From==prefix);return Response(new Chunks(extra,4093),bytes.Length-prefix,prefix,bytes.Length);});
            try{await second.DownloadAsync(spec,root.Path);throw new Exception("Oversized resumed body accepted");}catch(TransferException){}
            var partial=Directory.GetFiles(root.Path,"*.part",SearchOption.AllDirectories).Single();Need(File.ReadAllBytes(partial).SequenceEqual(bytes[..prefix]) && !File.Exists(Path.Combine(root.Path,"buffer.bin")));
        }
        foreach(var oversized in new[]{false,true}) {
            using var root=new DirectoryFixture();var body=oversized?bytes.Concat(new byte[]{42}).ToArray():bytes[..^1];using var engine=Engine(_=>Response(new Chunks(body,3011),bytes.Length));
            try {await engine.DownloadAsync(spec,root.Path);throw new Exception("Invalid stream length accepted");}catch(TransferException){}
            Need(!File.Exists(Path.Combine(root.Path,"buffer.bin")));
        }
        Console.WriteLine("PASS synthetic short reads, nonaligned resume, truncated and oversized bodies; no native provider or network.");
    }
}
