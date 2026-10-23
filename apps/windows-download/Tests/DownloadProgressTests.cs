using System.Net;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using LedgeTop.WindowsDownload;

internal static class DownloadProgressTests
{
    public static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("progress separates receiving verification and committed completion", Full),
        ("progress resumes at the owned prefix and never completes corrupt content", ResumeAndCorruption),
        ("progress observers cannot undo committed downloads or flood the UI per buffer", ObserverAndBounds),
    ];
    private static readonly byte[] Bytes = "synthetic-progress-content"u8.ToArray();
    private static DownloadSpec Spec(byte[] bytes) => new("progress-synthetic-resource", new("https://files.example.invalid/content"),
        "progress.bin", bytes.Length, "\"progress-version\"", Convert.ToHexStringLower(SHA256.HashData(bytes)));
    private static HttpResponseMessage Response(byte[] bytes, long offset = 0, Stream? stream = null, long? total = null)
    {
        var response = new HttpResponseMessage(offset == 0 ? HttpStatusCode.OK : HttpStatusCode.PartialContent) {
            Content = new StreamContent(stream ?? new MemoryStream(bytes))
        };
        response.Headers.ETag = new EntityTagHeaderValue("\"progress-version\"");
        response.Content.Headers.ContentLength = bytes.Length;
        if (offset != 0) response.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset, offset + bytes.Length - 1, total!.Value);
        return response;
    }
    private static Downloader Engine(HttpMessageHandler handler) => new(handler, [new Uri("https://files.example.invalid")]);
    private static void Check(bool value) { if (!value) throw new Exception("Progress contract violated."); }
    private sealed class Observer(Action<DownloadProgress> action) : IProgress<DownloadProgress> {
        public void Report(DownloadProgress value) => action(value);
    }
    private static async Task Full()
    {
        using var root = new DirectoryFixture(); var events = new List<DownloadProgress>();
        using var engine = Engine(new FakeHandler((_, _) => Response(Bytes)));
        var sawUncommitted = false; var sawCommitted = false;
        var path = await engine.DownloadAsync(Spec(Bytes), root.Path, progress: new Observer(value => {
            events.Add(value);
            if (value.Phase == DownloadPhase.Verifying) sawUncommitted = !File.Exists(Path.Combine(root.Path, "progress.bin"));
            if (value.Phase == DownloadPhase.Completed) sawCommitted = File.ReadAllBytes(Path.Combine(root.Path, "progress.bin")).SequenceEqual(Bytes);
        }));
        Check(events[0] == new DownloadProgress(0, Bytes.Length, DownloadPhase.Receiving));
        Check(events[^2] == new DownloadProgress(Bytes.Length, Bytes.Length, DownloadPhase.Verifying));
        Check(events[^1] == new DownloadProgress(Bytes.Length, Bytes.Length, DownloadPhase.Completed));
        Check(sawUncommitted && sawCommitted && File.Exists(path));
    }
    private static async Task ResumeAndCorruption()
    {
        using var root = new DirectoryFixture(); var events = new List<DownloadProgress>();
        using (var interrupted = Engine(new FakeHandler((_, _) => Response(Bytes, stream: new InterruptedStream(Bytes, 7))))) {
            try { await interrupted.DownloadAsync(Spec(Bytes), root.Path); throw new Exception("Interruption was accepted."); }
            catch (TransferException) { }
        }
        using (var resumed = Engine(new FakeHandler((request, _) => {
            Check(request.Headers.Range?.Ranges.Single().From == 7);
            return Response(Bytes[7..], 7, total: Bytes.Length);
        }))) await resumed.DownloadAsync(Spec(Bytes), root.Path, progress: new Observer(events.Add));
        Check(events[0] == new DownloadProgress(7, Bytes.Length, DownloadPhase.Receiving));
        Check(events[^1].Phase == DownloadPhase.Completed);
        using var corruptRoot = new DirectoryFixture(); events.Clear();
        using var corrupt = Engine(new FakeHandler((_, _) => Response(new byte[Bytes.Length])));
        try { await corrupt.DownloadAsync(Spec(Bytes), corruptRoot.Path, progress: new Observer(events.Add)); throw new Exception("Corruption was accepted."); }
        catch (TransferException) { }
        Check(events.Any(value => value.Phase == DownloadPhase.Verifying) && events.All(value => value.Phase != DownloadPhase.Completed));
        Check(!File.Exists(Path.Combine(corruptRoot.Path, "progress.bin")));
    }
    private static async Task ObserverAndBounds()
    {
        using var root = new DirectoryFixture();
        using (var engine = Engine(new FakeHandler((_, _) => Response(Bytes)))) {
            var path = await engine.DownloadAsync(Spec(Bytes), root.Path, progress: new Observer(_ => throw new InvalidOperationException("Synthetic observer failure")));
            Check(File.ReadAllBytes(path).SequenceEqual(Bytes));
        }
        using var largeRoot = new DirectoryFixture(); var bytes = new byte[8 * 1024 * 1024]; var events = new List<DownloadProgress>();
        using var large = Engine(new FakeHandler((_, _) => Response(bytes)));
        var elapsed = Stopwatch.StartNew();
        await large.DownloadAsync(Spec(bytes), largeRoot.Path, progress: new Observer(events.Add));
        Check(events.Count <= 4 + Math.Ceiling(elapsed.Elapsed.TotalMilliseconds / 100)
            && events.All(value => value.BytesTransferred >= 0 && value.BytesTransferred <= bytes.Length));
        Check(events[^1].Phase == DownloadPhase.Completed);
    }
}
