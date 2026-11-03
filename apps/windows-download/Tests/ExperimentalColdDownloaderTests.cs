#if LEDGETOP_CACHE_RACE_TEST
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class ExperimentalColdDownloaderTests
{
    private static readonly byte[] Content = "experimental-synthetic-download"u8.ToArray();
    private static readonly byte[] Foreign = "do-not-replace"u8.ToArray();
    private static readonly Uri Origin = new("https://experimental.example.invalid");
    private static DownloadSpec Spec => new("synthetic-only", new Uri(Origin, "/data"), "output.bin", Content.Length, "\"v1\"", Convert.ToHexStringLower(SHA256.HashData(Content)));
    private static void Check(bool value) { if (!value) throw new IOException("Experimental cold download assertion failed."); }
    private static HttpResponseMessage Response(byte[] bytes, Stream? input = null) {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(input ?? new MemoryStream(bytes)) };
        response.Headers.ETag = new EntityTagHeaderValue("\"v1\""); response.Content.Headers.ContentLength = Content.Length; return response;
    }
    private static Downloader Engine(Func<HttpRequestMessage, CancellationToken, HttpResponseMessage> handler) =>
        new(new FakeHandler(handler), [Origin]) { ExperimentalColdOwnedStreamForTest = true };
    private static async Task ExpectTransferFailure(Task task) {
        try { await task; } catch (TransferException) { return; }
        throw new IOException("Experimental transfer should fail closed.");
    }
    internal static async Task RunAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        using (var root = new DirectoryFixture()) {
            var calls = 0;
            using var downloader = Engine((request, _) => {
                calls++; Check(request.Method == HttpMethod.Get && request.Headers.IfMatch.Single().ToString() == Spec.ETag && request.Headers.Range is null);
                return Response(Content);
            });
            await using (var result = await downloader.DownloadVerifiedForHydrationAsync(Spec, root.Path)) {
                Check(!result.Stream.CanWrite && result.IntegrityVerified);
                var actual = new byte[Content.Length]; await result.Stream.ReadExactlyAsync(actual);
                Check(actual.SequenceEqual(Content));
                var blocked = false; try { result.Stream.Write(Content); } catch (NotSupportedException) { blocked = true; }
                Check(blocked && calls == 1);
            }
            Check(File.ReadAllBytes(Path.Combine(root.Path, "output.bin")).SequenceEqual(Content));
        }
        using (var root = new DirectoryFixture()) {
            using var downloader = Engine((_, _) => { File.WriteAllBytes(Path.Combine(root.Path, "output.bin"), Foreign); return Response(Content); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(File.ReadAllBytes(Path.Combine(root.Path, "output.bin")).SequenceEqual(Foreign));
            Check(Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single() is var part && File.ReadAllBytes(part).SequenceEqual(Content));
        }
        using (var root = new DirectoryFixture()) {
            var corrupt = Content.ToArray(); corrupt[0] ^= 1; var calls = 0;
            using var downloader = Engine((_, _) => { calls++; return Response(corrupt); });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && File.ReadAllBytes(part).SequenceEqual(corrupt));
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(calls == 1 && File.ReadAllBytes(part).SequenceEqual(corrupt)); // resume is explicitly unsupported
        }
        using (var root = new DirectoryFixture()) {
            using var cancel = new CancellationTokenSource();
            using var downloader = Engine((_, _) => Response(Content, new CancelAfterPrefix(Content, cancel)));
            var cancelled = false;
            try { await downloader.DownloadAsync(Spec, root.Path, cancel.Token); } catch (OperationCanceledException) { cancelled = true; }
            Check(cancelled && !File.Exists(Path.Combine(root.Path, "output.bin")));
            var part = Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Single();
            Check(File.ReadAllBytes(part).SequenceEqual(Content[..4]));
        }
        using (var root = new DirectoryFixture()) {
            using var downloader = Engine((_, _) => { var response = Response(Content); response.Headers.ETag = new EntityTagHeaderValue("\"wrong\""); return response; });
            await ExpectTransferFailure(downloader.DownloadAsync(Spec, root.Path));
            Check(!File.Exists(Path.Combine(root.Path, "output.bin")) && !Directory.EnumerateFiles(root.Path, "*.part", SearchOption.AllDirectories).Any());
        }
        Console.WriteLine("PASS gated synthetic cold Downloader success, read-only handoff, collision, corrupt/resume refusal, and cancellation.");
    }
    private sealed class CancelAfterPrefix(byte[] data, CancellationTokenSource source) : MemoryStream(data)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            if (Position == 0) return ValueTask.FromResult(Read(buffer.Span[..Math.Min(buffer.Length, 4)]));
            source.Cancel(); throw new OperationCanceledException(token);
        }
    }
}
#endif
