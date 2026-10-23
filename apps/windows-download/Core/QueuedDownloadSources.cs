using System.Net;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

public sealed record QueuedDownloadReference(string PrincipalId, string ResourceReference);

/// <summary>One configured human Access source. No credential or byte URL is persisted.
/// Metadata redirects, ambient cookies and alternate origins are never accepted.</summary>
public abstract class QueuedDownloadSource : IQueuedDownloadSource, IDisposable
{
    private readonly CloudflareAccessSession session;
    private readonly HttpClient client;
    private readonly Downloader downloader;
    private readonly bool employee;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    public string Alias { get; }
    public Uri Origin => session.Origin;
    private string Base => employee ? "/api/staff/files" : "/api/client/operations/data";

    protected QueuedDownloadSource(string alias, CloudflareAccessSession session, bool employee)
        : this(alias, session, employee, new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false, Credentials = null,
            AutomaticDecompression = DecompressionMethods.None, CheckCertificateRevocationList = true
        }, new Downloader(session)) { }

    internal QueuedDownloadSource(string alias, CloudflareAccessSession session, bool employee, HttpMessageHandler handler, Downloader downloader)
    {
        if (alias is null || !Regex.IsMatch(alias, "\\A[a-z0-9][a-z0-9_-]{0,63}\\z")) throw new ArgumentException("A stable trusted source alias is required.");
        Alias = alias; this.session = session; this.employee = employee; this.downloader = downloader;
        client = new HttpClient(handler, true) { Timeout = Timeout.InfiniteTimeSpan };
    }
    public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
    {
        using var doc = await GetAsync("/session", cancellationToken);
        try {
            var root = doc.RootElement; Exact(root, "schemaVersion", "principalId", "expiresAt"); Version(root);
            var expiry = Number(root, "expiresAt", 8_640_000_000_000);
            if (expiry <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()) throw Invalid();
            return new(Principal(root), DateTimeOffset.FromUnixTimeSeconds(expiry));
        } catch (Exception e) when (Malformed(e)) { throw Invalid(); }
    }
    public async Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default)
    {
        Reference(resourceReference);
        using var doc = await GetAsync("/resolve?resourceRef=" + Uri.EscapeDataString(resourceReference), cancellationToken);
        return Parse(doc.RootElement);
    }
    protected async Task<QueuedDownloadReference> SelectAsync(string query, CancellationToken cancellationToken)
    {
        using var doc = await GetAsync("/reference?" + query, cancellationToken);
        try {
            var root = doc.RootElement; Exact(root, "schemaVersion", "principalId", "resourceRef"); Version(root);
            return new(Principal(root), Reference(Text(root, "resourceRef", 16384)));
        } catch (Exception e) when (Malformed(e)) { throw Invalid(); }
    }
    public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default)
    {
        if (!spec.ContentUri.IsAbsoluteUri || spec.ContentUri.GetLeftPart(UriPartial.Authority) != Origin.GetLeftPart(UriPartial.Authority)
            || spec.ContentUri.UserInfo.Length != 0 || spec.ContentUri.Query.Length != 0 || spec.ContentUri.Fragment.Length != 0) throw Invalid();
        ContentPath(spec.ContentUri.AbsolutePath);
        return downloader.DownloadAsync(spec, destination, cancellationToken: cancellationToken, progress: progress);
    }
    private ResolvedQueuedDownload Parse(JsonElement root)
    {
        try {
            Exact(root, "schemaVersion", "principalId", "manifest"); Version(root);
            var principal = Principal(root);
            var m = root.GetProperty("manifest");
            Exact(m, "schemaVersion", "logicalFileId", "remoteVersion", "strongETag", "size", "sha256", "name", "downloadPath", "expiresAt"); Version(m);
            string logical = Text(m, "logicalFileId", 70), sha = Text(m, "sha256", 64), version = Text(m, "remoteVersion", 256), etag = Text(m, "strongETag", 256);
            if (!Regex.IsMatch(logical, employee ? "\\Aoef1_[a-f0-9]{64}\\z" : "\\Aondf1_[a-f0-9]{64}\\z") || !Regex.IsMatch(sha, "\\A[a-f0-9]{64}\\z")
                || (employee && (version != sha || etag != "\"" + sha + "\"")) || !Regex.IsMatch(etag, "\\A\"[\\x21\\x23-\\x7e]+\"\\z")) throw Invalid();
            var name = Text(m, "name", 150, canonical: false); Downloader.SafeFileName(name);
            var path = ContentPath(Text(m, "downloadPath", 16500));
            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds(), expiry = Number(m, "expiresAt", long.MaxValue);
            if (expiry <= now + 5 || expiry > now + 900) throw Invalid();
            var spec = new DownloadSpec(logical + ":" + version, new Uri(Origin, path), name, Number(m, "size", 1L << 40), etag, sha);
            return new(principal, logical, version, spec);
        } catch (Exception e) when (Malformed(e)) { throw Invalid(); }
    }
    private string ContentPath(string path)
    {
        var successor = !employee && path.StartsWith(Base + "/windows-successor/files/", StringComparison.Ordinal);
        var pattern = employee ? "\\A/api/staff/files/downloads/eof1_[A-Za-z0-9_-]+\\z"
            : successor ? "\\A/api/client/operations/data/windows-successor/files/wsp1_[A-Za-z0-9_-]+/download\\z"
            : "\\A/api/client/operations/data/files/ond1_[A-Za-z0-9_-]+/download\\z";
        var prefix = employee ? Base + "/downloads/" : Base + (successor ? "/windows-successor/files/" : "/files/");
        var suffix = employee ? 0 : "/download".Length;
        if (path.Length - prefix.Length - suffix > (employee ? 16384 : 8192) || !Regex.IsMatch(path, pattern)) throw Invalid();
        return path;
    }
    private async Task<JsonDocument> GetAsync(string tail, CancellationToken cancellationToken)
    {
        const int limit = 96 * 1024;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(tail.StartsWith("/resolve?", StringComparison.Ordinal) ? TimeSpan.FromMinutes(15) : TimeSpan.FromSeconds(60));
        try {
            using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(Origin, Base + "/queue" + tail));
            request.Headers.Accept.ParseAdd("application/json"); request.Headers.AcceptEncoding.ParseAdd("identity");
            request.Headers.Add("Cf-Access-Token", await session.GetTokenAsync(deadline.Token));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new LoginRequiredException();
            if (response.StatusCode == HttpStatusCode.Forbidden) throw new AccessDeniedException();
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Conflict) throw new ResourceUnavailableException();
            var type = response.Content.Headers.ContentType;
            if (response.StatusCode != HttpStatusCode.OK || type?.MediaType != "application/json"
                || type.CharSet is not null && !type.CharSet.Trim('"').Equals("utf-8", StringComparison.OrdinalIgnoreCase)
                || response.Content.Headers.ContentEncoding.Count != 0 || response.Content.Headers.ContentLength > limit) throw Invalid();
            using var stream = await response.Content.ReadAsStreamAsync(deadline.Token); using var output = new MemoryStream(); var bytes = new byte[8192];
            while (true) {
                var read = await stream.ReadAsync(bytes.AsMemory(0, Math.Min(bytes.Length, limit + 1 - (int)output.Length)), deadline.Token);
                if (read == 0) break; output.Write(bytes, 0, read); if (output.Length > limit) throw Invalid();
            }
            deadline.Token.ThrowIfCancellationRequested();
            var doc = JsonDocument.Parse(Utf8.GetString(output.ToArray()), new JsonDocumentOptions { MaxDepth = 12 });
            try { Unique(doc.RootElement); return doc; } catch { doc.Dispose(); throw; }
        } catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new TransferException("The queue source request timed out."); }
        catch (Exception e) when (e is HttpRequestException or IOException or JsonException or DecoderFallbackException) { throw Invalid(); }
    }
    private static void Unique(JsonElement e) {
        if (e.ValueKind == JsonValueKind.Object) { var seen = new HashSet<string>(StringComparer.Ordinal); foreach (var p in e.EnumerateObject()) { if (!seen.Add(p.Name)) throw Invalid(); Unique(p.Value); } }
        else if (e.ValueKind == JsonValueKind.Array) foreach (var v in e.EnumerateArray()) Unique(v);
    }
    private static void Exact(JsonElement e, params string[] names) { if (e.ValueKind != JsonValueKind.Object || !e.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(names.Order())) throw Invalid(); }
    private static void Version(JsonElement e) { if (e.GetProperty("schemaVersion").GetRawText() != "1") throw Invalid(); }
    private static string Text(JsonElement e, string name, int max, bool canonical = true) {
        var v = e.GetProperty(name).GetString();
        if (v is null || v.Length == 0 || v.Length > max || canonical && v.Trim() != v || v.Any(char.IsControl)) throw Invalid();
        for (var index = 0; index < v.Length;) { if (!Rune.TryGetRuneAt(v, index, out var rune)) throw Invalid(); index += rune.Utf16SequenceLength; }
        return v;
    }
    private static long Number(JsonElement e, string name, long max) { if (!e.GetProperty(name).TryGetInt64(out var v) || v < 0 || v > max) throw Invalid(); return v; }
    private static string Principal(JsonElement e) { var v = Text(e, "principalId", 70); if (!Regex.IsMatch(v, "\\Aodqp1_[a-f0-9]{64}\\z")) throw Invalid(); return v; }
    private static string Reference(string v) { if (v is null || v.Length > 16384 || !Regex.IsMatch(v, "\\Aodqr1_[A-Za-z0-9_-]+\\z")) throw Invalid(); return v; }
    private static bool Malformed(Exception e) => e is InvalidOperationException or KeyNotFoundException or FormatException or OverflowException or ArgumentOutOfRangeException;
    private static TransferException Invalid() => new("The queue source returned invalid metadata.");
    public void Dispose() { client.Dispose(); downloader.Dispose(); }
}

public sealed class EmployeeQueuedDownloadSource : QueuedDownloadSource
{
    public EmployeeQueuedDownloadSource(string alias, CloudflareAccessSession session) : base(alias, session, true) { }
    internal EmployeeQueuedDownloadSource(string alias, CloudflareAccessSession session, HttpMessageHandler handler, Downloader downloader) : base(alias, session, true, handler, downloader) { }
    public Task<QueuedDownloadReference> GetReferenceAsync(string rootId, string path, CancellationToken cancellationToken = default)
    {
        if (rootId is null || !Regex.IsMatch(rootId, "\\A[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\z") || !CanonicalPath(path))
            throw new ArgumentException("A canonical employee root and relative file path are required.");
        return SelectAsync("rootId=" + rootId + "&path=" + Uri.EscapeDataString(path), cancellationToken);
    }
    private static bool CanonicalPath(string? path) {
        if (path is null || path.Length == 0) return false;
        var utf8 = new UTF8Encoding(false, true);
        for (var index = 0; index < path.Length;) {
            if (!Rune.TryGetRuneAt(path, index, out var rune) || Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.Surrogate) return false;
            index += rune.Utf16SequenceLength;
        }
        var parts = path.Split('/');
        return utf8.GetByteCount(path) <= 4096 && parts.Length <= 64 && !path.Any(c => "\\%:".Contains(c))
            && parts.All(part => part is not ("" or "." or "..") && utf8.GetByteCount(part) <= 255);
    }

}
public sealed class PortalQueuedDownloadSource : QueuedDownloadSource
{
    public PortalQueuedDownloadSource(string alias, CloudflareAccessSession session) : base(alias, session, false) { }
    internal PortalQueuedDownloadSource(string alias, CloudflareAccessSession session, HttpMessageHandler handler, Downloader downloader) : base(alias, session, false, handler, downloader) { }
    public Task<QueuedDownloadReference> GetReferenceAsync(string fileHandle, CancellationToken cancellationToken = default)
    {
        if (fileHandle is null || fileHandle.Length > 8192 || !Regex.IsMatch(fileHandle, "\\A(?:ond1|wpc1)_[A-Za-z0-9_-]+\\z")) throw new ArgumentException("A current native file selector is required.");
        return SelectAsync("fileHandle=" + Uri.EscapeDataString(fileHandle), cancellationToken);
    }
}
