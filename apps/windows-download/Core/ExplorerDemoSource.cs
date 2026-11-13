using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

namespace LedgeTop.WindowsDownload;

/// <summary>A manifest entry for generated, valid files. Identity is metadata, never access authority.</summary>
public sealed record ExplorerDemoEntry(string RelativePath, PlaceholderIdentity Identity);

/// <summary>
/// Explicit synthetic source for the disposable Explorer preview. An injected in-memory transport runs
/// the real resumable, hash-verifying downloader; no request can reach a network or real account.
/// </summary>
public sealed class ExplorerDemoSource : IQueuedDownloadSource, IMemoryHydrationDownloadSource, IDisposable, IHydrationMutationAwareSource
{
    bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
    private sealed record Item(ExplorerDemoEntry Entry, byte[] Bytes, DownloadSpec Spec);
    private readonly object gate = new();
    private readonly Dictionary<string, Item> references = new(StringComparer.Ordinal);
    private readonly Dictionary<Uri, Item> content = [];
    private readonly TimeSpan chunkDelay;
    private bool signedIn, disposed;
    private long generation;
    private DateTimeOffset expires;

    public string Alias => "explorer-demo";
    public string Channel => "pilot";
    public Uri Origin { get; } = new("https://explorer-demo.invalid/");
    public string PrincipalId { get; } = "odqp1_" + Hash("LedgeTop Explorer generated preview principal v1"u8);
    public IReadOnlyList<ExplorerDemoEntry> Entries { get; }

    public ExplorerDemoSource(bool signedIn = false, TimeSpan? chunkDelay = null)
    {
        this.chunkDelay = chunkDelay ?? TimeSpan.FromMilliseconds(40);
        if (this.chunkDelay < TimeSpan.Zero || this.chunkDelay > TimeSpan.FromSeconds(5))
            throw new ArgumentOutOfRangeException(nameof(chunkDelay));
        Add("README.txt", "LedgeTop Files - Explorer preview\r\n\r\nThese are generated test files, not company or client data.\r\nOpen a file to try downloading on demand. Use Windows' Always keep on this device and Free up space commands when the provider preview enables them.\r\n\r\nThe preview uses simulated sign-in and an in-memory source; it does not access Ops, Project Alpha, R2 or your server.\r\n");
        var csv = new StringBuilder("sample_id,easting,northing,height_m\r\n");
        for (var i = 1; i <= 24000; i++)
            csv.Append(i.ToString(CultureInfo.InvariantCulture)).Append(',')
                .Append((500000 + i).ToString(CultureInfo.InvariantCulture)).Append(',')
                .Append((4900000 + i).ToString(CultureInfo.InvariantCulture)).Append(',')
                .Append((12 + i % 23).ToString(CultureInfo.InvariantCulture)).Append(".50\r\n");
        Add("Samples/sample.csv", csv.ToString());
        Add("Samples/diagram.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"320\" viewBox=\"0 0 640 320\"><rect width=\"640\" height=\"320\" fill=\"#17232e\"/><circle cx=\"110\" cy=\"160\" r=\"55\" fill=\"#ee5007\"/><path d=\"M185 160H290\" stroke=\"white\" stroke-width=\"8\"/><rect x=\"315\" y=\"110\" width=\"230\" height=\"100\" rx=\"16\" fill=\"#f3f5f7\"/><text x=\"320\" y=\"65\" fill=\"white\" font-family=\"sans-serif\" font-size=\"24\" text-anchor=\"middle\">LedgeTop Files - generated preview</text><text x=\"430\" y=\"168\" font-family=\"sans-serif\" font-size=\"22\" text-anchor=\"middle\">Downloaded on open</text></svg>\r\n");
        Add("Samples/Nested/notes.txt", "Generated nested folder sample.\r\nNo real project information is included.\r\n");
        Add("Samples/empty.txt", "");
        Entries = Array.AsReadOnly(references.Values.Select(item => item.Entry).ToArray());
        if (signedIn) SignIn();
    }

    private void Add(string relativePath, string text)
    {
        var segments = relativePath.Split('/');
        foreach (var segment in segments) Downloader.SafeFileName(segment);
        var bytes = Encoding.UTF8.GetBytes(text);
        var pathHash = Hash(Encoding.UTF8.GetBytes(relativePath));
        var sha = Hash(bytes);
        var reference = "odqr1_" + pathHash;
        var logical = "ondf1_" + pathHash;
        var identity = new PlaceholderIdentity(Channel, Alias, Origin.GetLeftPart(UriPartial.Authority), PrincipalId,
            reference, logical, sha, segments[^1], bytes.LongLength, "\"" + sha + "\"", sha);
        identity.Validate();
        var spec = new DownloadSpec(logical + ":" + sha, new Uri(Origin, "content/" + pathHash),
            identity.FileName, bytes.LongLength, identity.ETag, sha);
        var item = new Item(new(relativePath, identity), bytes, spec);
        references.Add(reference, item); content.Add(spec.ContentUri, item);
    }

    public void SignIn()
    {
        lock (gate) {
            ObjectDisposedException.ThrowIf(disposed, this);
            generation++; signedIn = true; expires = DateTimeOffset.UtcNow.AddHours(8);
        }
    }

    /// <summary>Revokes this generated session, including in-flight source reads. Delivered bytes remain local.</summary>
    public void Revoke() { lock (gate) { generation++; signedIn = false; } }

    private long RequireSession(CancellationToken token, long? expectedGeneration = null)
    {
        token.ThrowIfCancellationRequested();
        lock (gate) {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!signedIn || expires <= DateTimeOffset.UtcNow.AddSeconds(5)
                || expectedGeneration is { } expected && generation != expected) throw new LoginRequiredException();
            return generation;
        }
    }

    public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
    {
        RequireSession(cancellationToken);
        lock (gate) {
            RequireSession(cancellationToken);
            return Task.FromResult(new QueuedDownloadSession(PrincipalId, expires));
        }
    }

    public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default)
    {
        RequireSession(cancellationToken);
        if (resourceReference is null || !references.TryGetValue(resourceReference, out var item)) throw new ResourceUnavailableException();
        return Task.FromResult(new ResolvedQueuedDownload(PrincipalId, item.Entry.Identity.LogicalFileId,
            item.Entry.Identity.RemoteVersion, item.Spec));
    }

    public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var epoch = RequireSession(cancellationToken);
        if (spec is null || !content.TryGetValue(spec.ContentUri, out var item) || item.Spec != spec)
            throw new TransferException("The generated preview download metadata is invalid.");
        using var downloader = new Downloader(new MemoryTransport(this, epoch), [Origin], maximumBytes: 2 * 1024 * 1024);
        return await downloader.DownloadAsync(spec, destination, cancellationToken: cancellationToken, progress: progress);
    }

    bool IMemoryHydrationDownloadSource.SupportsMemoryHydration => true;
    async Task IMemoryHydrationDownloadSource.DownloadVerifiedIntoAsync(DownloadSpec spec, byte[] destination, CancellationToken cancellationToken)
    {
        var epoch = RequireSession(cancellationToken);
        if (spec is null || !content.TryGetValue(spec.ContentUri, out var item) || item.Spec != spec)
            throw new TransferException("The generated preview download metadata is invalid.");
        using var downloader = new Downloader(new MemoryTransport(this, epoch), [Origin], maximumBytes: 2 * 1024 * 1024);
        await downloader.DownloadVerifiedIntoAsync(spec, destination, cancellationToken);
    }

    private sealed class MemoryTransport(ExplorerDemoSource owner, long epoch) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            owner.RequireSession(token, epoch);
            if (request.Method != HttpMethod.Get || request.RequestUri is null || !owner.content.TryGetValue(request.RequestUri, out var item))
                throw new TransferException("The generated preview transport refused this request.");
            var etag = item.Spec.ETag;
            if (request.Headers.IfMatch.Count != 1 || request.Headers.IfMatch.Single().ToString() != etag)
                throw new TransferException("The generated preview version does not match.");
            long offset = 0;
            if (request.Headers.Range is { } range) {
                if (range.Unit != "bytes" || range.Ranges.Count != 1 || range.Ranges.Single() is not { From: { } start, To: null }
                    || start <= 0 || start >= item.Bytes.LongLength || request.Headers.IfRange?.EntityTag?.ToString() != etag)
                    throw new TransferException("The generated preview range is invalid.");
                offset = start;
            }
            var response = new HttpResponseMessage(offset == 0 ? HttpStatusCode.OK : HttpStatusCode.PartialContent) {
                Content = new StreamContent(new GeneratedStream(owner, epoch, item.Bytes, checked((int)offset)))
            };
            response.Headers.ETag = EntityTagHeaderValue.Parse(etag);
            response.Content.Headers.ContentLength = item.Bytes.LongLength - offset;
            if (offset > 0) response.Content.Headers.ContentRange = new(offset, item.Bytes.LongLength - 1, item.Bytes.LongLength);
            return Task.FromResult(response);
        }
    }

    private sealed class GeneratedStream(ExplorerDemoSource owner, long epoch, byte[] bytes, int offset) : Stream
    {
        private readonly int start = offset;
        private int position = offset;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => bytes.LongLength - start;
        public override long Position { get => position - start; set => throw new NotSupportedException(); }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            owner.RequireSession(token, epoch);
            if (buffer.Length == 0 || position == bytes.Length) return 0;
            if (owner.chunkDelay > TimeSpan.Zero) await Task.Delay(owner.chunkDelay, token);
            owner.RequireSession(token, epoch);
            var count = Math.Min(Math.Min(buffer.Length, 16384), bytes.Length - position);
            bytes.AsMemory(position, count).CopyTo(buffer); position += count;
            return count;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) => ReadAsync(buffer.AsMemory(offset, count), token).AsTask();
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static string Hash(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    public void Dispose() { lock (gate) { disposed = true; signedIn = false; generation++; } }
}
