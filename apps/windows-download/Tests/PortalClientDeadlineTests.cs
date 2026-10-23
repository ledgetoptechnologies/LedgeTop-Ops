using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class PortalClientDeadlineTests
{
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("portal metadata deadline cancels a response body stalled after headers and prefix", BodyDeadline),
        ("portal metadata caller cancellation stays distinct and disposes stalled body", CallerCancellation),
        ("portal metadata deadline also bounds cached token lookup and response headers", EarlierStages),
        ("portal metadata internal deadline injection refuses unbounded or invalid values", TimeoutBounds)
    ];
    private static void Assert(bool value) { if (!value) throw new Exception("Portal deadline assertion failed."); }
    private static readonly TimeSpan Deadline = TimeSpan.FromMilliseconds(150);
    private static async Task BodyDeadline() {
        using var fixture = new Fixture();
        using var caller = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var body = new StalledBody();
        var handler = new Handler((_, _) => Task.FromResult(Response(body)));
        using (var portal = new PortalClient(handler, fixture.Session, Deadline)) {
            try { await portal.GetDeliveriesAsync(cancellationToken: caller.Token); throw new Exception("Expected timeout."); }
            catch (TransferException error) { Assert(error.Message == "The portal request timed out."); }
            Assert(!caller.IsCancellationRequested && body.Reads == 2 && body.CancellationObserved && body.Disposed);
            Assert(handler.Calls == 1 && fixture.Runner.Calls == 1);
        }
        Assert(handler.Disposed);
    }
    private static async Task CallerCancellation() {
        using var fixture = new Fixture();
        using var caller = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var body = new StalledBody();
        using var portal = new PortalClient(new Handler((_, _) => Task.FromResult(Response(body))), fixture.Session);
        var operation = portal.GetDeliveriesAsync(cancellationToken: caller.Token);
        await body.Stalled.Task.WaitAsync(TimeSpan.FromSeconds(2));
        caller.Cancel();
        try { await operation; throw new Exception("Expected caller cancellation."); }
        catch (OperationCanceledException) { Assert(caller.IsCancellationRequested); }
        Assert(body.Reads == 2 && body.CancellationObserved && body.Disposed);
    }
    private static async Task EarlierStages() {
        foreach (var tokenStage in new[] { true, false }) {
            using var fixture = new Fixture(tokenStage);
            using var caller = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            var headerCancelled = false;
            using var portal = new PortalClient(new Handler(async (_, cancellation) => {
                try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellation); }
                catch (OperationCanceledException) { headerCancelled = true; throw; }
                throw new Exception("Unreachable.");
            }), fixture.Session, Deadline);
            try { await portal.GetDeliveriesAsync(cancellationToken: caller.Token); throw new Exception("Expected timeout."); }
            catch (TransferException error) { Assert(error.Message == "The portal request timed out."); }
            Assert(!caller.IsCancellationRequested && fixture.Runner.Calls == 1);
            Assert(tokenStage ? fixture.Runner.Cancelled && !headerCancelled : headerCancelled && !fixture.Runner.Cancelled);
        }
    }
    private static Task TimeoutBounds() {
        using var fixture = new Fixture();
        foreach (var timeout in new[] { TimeSpan.Zero, TimeSpan.FromTicks(-1), Timeout.InfiniteTimeSpan, TimeSpan.FromSeconds(61), TimeSpan.MaxValue }) {
            using var handler = new Handler((_, _) => throw new Exception("Must not run."));
            try { using var portal = new PortalClient(handler, fixture.Session, timeout); throw new Exception("Expected invalid deadline."); }
            catch (ArgumentOutOfRangeException) { Assert(handler.Calls == 0 && fixture.Runner.Calls == 0); }
        }
        return Task.CompletedTask;
    }
    private static HttpResponseMessage Response(Stream body) {
        var content = new StreamContent(body);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return new(HttpStatusCode.OK) { Content = content };
    }
    private sealed class StalledBody : Stream {
        internal int Reads; internal bool CancellationObserved, Disposed;
        internal TaskCompletionSource Stalled = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
            Reads++;
            if (Reads == 1) { buffer.Span[0] = (byte)'{'; return 1; }
            Stalled.TrySetResult();
            try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); }
            catch (OperationCanceledException) { CancellationObserved = true; throw; }
            throw new Exception("Unreachable.");
        }
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> action) : HttpMessageHandler {
        internal int Calls; internal bool Disposed;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) { Calls++; return action(request, cancellationToken); }
        protected override void Dispose(bool disposing) { Disposed = true; base.Dispose(disposing); }
    }
    private sealed class Runner(bool stall) : IAccessCommandRunner {
        internal int Calls; internal bool Cancelled;
        public async Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> arguments, CancellationToken cancellationToken) {
            Assert(arguments[1] == "token"); Calls++;
            if (stall) {
                try { await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken); }
                catch (OperationCanceledException) { Cancelled = true; throw; }
            }
            var payload = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 })).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            return new(0, "eyJhbGciOiJSUzI1NiJ9." + payload + ".c2ln", "");
        }
    }
    private sealed class Fixture : IDisposable {
        private readonly string parent = Path.GetFullPath(Path.GetTempPath());
        private readonly string root;
        internal Runner Runner; internal CloudflareAccessSession Session;
        internal Fixture(bool stallToken = false) {
            root = Path.Combine(parent, "portal-deadline-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var binary = Path.Combine(root, "synthetic-never-run.bin"); File.WriteAllText(binary, "synthetic");
            Runner = new(stallToken);
            Session = new(new Uri("https://portal.example.invalid/portal"), binary, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(binary))), Runner);
        }
        public void Dispose() {
            Assert(Path.GetDirectoryName(Path.GetFullPath(root)) == Path.TrimEndingDirectorySeparator(parent));
            Assert(Path.GetFileName(root).StartsWith("portal-deadline-", StringComparison.Ordinal));
            Assert(!File.GetAttributes(root).HasFlag(FileAttributes.ReparsePoint));
            Directory.Delete(root, true);
        }
    }
}
