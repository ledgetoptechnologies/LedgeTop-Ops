using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

public sealed record EmployeeRoot(string RootId, string GatewayId, string DisplayName);
public sealed record EmployeeEntry(string Name, string Kind);
public sealed record EmployeeDirectoryPage(IReadOnlyList<EmployeeEntry> Entries, string? NextCursor);

/// <summary>Human-authenticated, read-only employee adapter for one fixed Ops origin.
/// Cursors and content handles select resources; Ops rechecks current authority on every use.</summary>
public sealed class EmployeeClient : IDisposable
{
    private const string Base = "/api/staff/files";
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private readonly CloudflareAccessSession session;
    private readonly HttpClient client;

    public EmployeeClient(CloudflareAccessSession session) : this(new HttpClientHandler {
        AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false, Credentials = null,
        AutomaticDecompression = DecompressionMethods.None, CheckCertificateRevocationList = true
    }, session) { }

    internal EmployeeClient(HttpMessageHandler handler, CloudflareAccessSession session)
    {
        this.session = session;
        client = new HttpClient(handler, true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    public async Task<IReadOnlyList<EmployeeRoot>> GetRootsAsync(CancellationToken cancellationToken = default)
    {
        using var json = await GetAsync(Base + "/roots", 256 * 1024, TimeSpan.FromSeconds(60), cancellationToken);
        try {
            var root = json.RootElement; Exact(root, "schemaVersion", "roots"); Version(root);
            var roots = Array(root, "roots", 100); var seen = new HashSet<string>(StringComparer.Ordinal);
            return roots.Select(item => {
                Exact(item, "rootId", "gatewayId", "displayName");
                var id = Uuid(Text(item, "rootId", 36));
                if (!seen.Add(id)) throw Invalid();
                var label = Text(item, "displayName", 160);
                if (string.IsNullOrWhiteSpace(label)) throw Invalid();
                return new EmployeeRoot(id, Uuid(Text(item, "gatewayId", 36)), label);
            }).ToArray();
        } catch (Exception error) when (Malformed(error)) { throw Invalid(); }
    }

    public async Task<EmployeeDirectoryPage> GetEntriesAsync(string rootId, string path = "", string? cursor = null,
        CancellationToken cancellationToken = default)
    {
        Uuid(rootId); SourcePath(path, allowEmpty: true); if (cursor is not null) Cursor(cursor);
        var requestPath = Base + "/roots/" + rootId + "/entries?path=" + Uri.EscapeDataString(path)
            + (cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor));
        using var json = await GetAsync(requestPath, 256 * 1024, TimeSpan.FromSeconds(60), cancellationToken);
        try {
            var root = json.RootElement; Exact(root, "schemaVersion", "entries", "nextCursor"); Version(root);
            byte[]? previous = null;
            var entries = Array(root, "entries", 200).Select(item => {
                Exact(item, "name", "kind");
                var name = Text(item, "name", 255); SourcePath(name, allowEmpty: false);
                if (name.Contains('/')) throw Invalid();
                var encoded = StrictUtf8.GetBytes(name);
                if (previous is not null && previous.AsSpan().SequenceCompareTo(encoded) >= 0) throw Invalid();
                previous = encoded;
                var kind = Text(item, "kind", 6); if (kind is not ("file" or "folder")) throw Invalid();
                return new EmployeeEntry(name, kind);
            }).ToArray();
            var next = root.GetProperty("nextCursor");
            var value = next.ValueKind == JsonValueKind.Null ? null : Cursor(next.GetString() ?? throw Invalid());
            if (value is not null && (entries.Length != 200 || value == cursor)) throw Invalid();
            return new(entries, value);
        } catch (Exception error) when (Malformed(error)) { throw Invalid(); }
    }

    public async Task<DownloadSpec> GetDownloadManifestAsync(string rootId, string path, CancellationToken cancellationToken = default)
    {
        Uuid(rootId); SourcePath(path, allowEmpty: false);
        using var json = await GetAsync(Base + "/roots/" + rootId + "/manifest?path=" + Uri.EscapeDataString(path),
            64 * 1024, TimeSpan.FromMinutes(15), cancellationToken);
        try {
            var root = json.RootElement;
            Exact(root, "schemaVersion", "logicalFileId", "remoteVersion", "strongETag", "size", "sha256", "name", "downloadPath", "expiresAt");
            Version(root);
            var logical = Text(root, "logicalFileId", 69); var sha = Text(root, "sha256", 64);
            var version = Text(root, "remoteVersion", 64); var etag = Text(root, "strongETag", 66);
            if (!Regex.IsMatch(logical, "\\Aoef1_[a-f0-9]{64}\\z") || !Regex.IsMatch(sha, "\\A[a-f0-9]{64}\\z")
                || version != sha || etag != "\"" + sha + "\"") throw Invalid();
            var name = Text(root, "name", 150); Downloader.SafeFileName(name);
            var download = Text(root, "downloadPath", Base.Length + 11 + 16384);
            const string prefix = Base + "/downloads/";
            if (!download.StartsWith(prefix, StringComparison.Ordinal)) throw Invalid();
            var handle = download[prefix.Length..];
            if (handle.Length > 16384 || !Regex.IsMatch(handle, "\\Aeof1_[A-Za-z0-9_-]+\\z")) throw Invalid();
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds(); var expiry = Integer(root, "expiresAt", long.MaxValue);
            if (expiry <= now + 5 || expiry > now + 900) throw Invalid();
            // Snapshot/handle renewal must preserve a same-content resume state.
            return new(logical + ":" + sha, new Uri(session.Origin, download), name, Integer(root, "size", 1L << 40), etag, sha);
        } catch (Exception error) when (Malformed(error)) { throw Invalid(); }
    }

    private async Task<JsonDocument> GetAsync(string path, int limit, TimeSpan timeout, CancellationToken cancellationToken)
    {
        var uri = new Uri(session.Origin, path);
        if (uri.GetLeftPart(UriPartial.Authority) != session.Origin.GetLeftPart(UriPartial.Authority)) throw Invalid();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        try {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Accept.ParseAdd("application/json"); request.Headers.AcceptEncoding.ParseAdd("identity");
            request.Headers.Add("Cf-Access-Token", await session.GetTokenAsync(deadline.Token));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new LoginRequiredException();
            if (response.StatusCode == HttpStatusCode.Forbidden) throw new AccessDeniedException();
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Conflict) throw new ResourceUnavailableException();
            var type = response.Content.Headers.ContentType;
            if (response.StatusCode != HttpStatusCode.OK || type?.MediaType != "application/json"
                || (type.CharSet is not null && !type.CharSet.Trim('"').Equals("utf-8", StringComparison.OrdinalIgnoreCase))
                || response.Content.Headers.ContentEncoding.Count != 0 || response.Content.Headers.ContentLength > limit) throw Invalid();
            using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var output = new MemoryStream(); var buffer = new byte[8192];
            while (true) {
                var count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, limit + 1 - (int)output.Length)), deadline.Token);
                if (count == 0) break;
                output.Write(buffer, 0, count); if (output.Length > limit) throw Invalid();
            }
            var text = StrictUtf8.GetString(output.ToArray());
            var json = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 16 });
            try { NoDuplicates(json.RootElement); } catch { json.Dispose(); throw; }
            return json;
        } catch (HttpRequestException) { throw new TransferException("The employee file request could not be completed."); }
        catch (IOException) { throw new TransferException("The employee file response could not be read."); }
        catch (JsonException) { throw Invalid(); }
        catch (DecoderFallbackException) { throw Invalid(); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new TransferException("The employee file request timed out."); }
    }

    private static void Exact(JsonElement value, params string[] fields)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(fields.Order())) throw Invalid();
    }
    private static void Version(JsonElement value) { if (value.GetProperty("schemaVersion").GetRawText() != "1") throw Invalid(); }
    private static JsonElement.ArrayEnumerator Array(JsonElement value, string name, int maximum)
    {
        var array = value.GetProperty(name); if (array.GetArrayLength() > maximum) throw Invalid(); return array.EnumerateArray();
    }
    private static string Text(JsonElement value, string name, int maximum)
    {
        var text = value.GetProperty(name).GetString();
        if (text is null || text.Length == 0 || text.Length > maximum) throw Invalid();
        Unicode(text); return text;
    }
    private static void Unicode(string value)
    {
        for (var index = 0; index < value.Length;) {
            if (!Rune.TryGetRuneAt(value, index, out var rune) || Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.Surrogate) throw Invalid();
            index += rune.Utf16SequenceLength;
        }
    }
    private static string Uuid(string value)
    {
        if (value is null || !Regex.IsMatch(value, "\\A[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\z")) throw Invalid(); return value;
    }
    private static string Cursor(string value)
    {
        if (value.Length == 0 || value.Length > 8192 || value.Any(c => c < 0x21 || c > 0x7e)) throw Invalid(); return value;
    }
    private static void SourcePath(string value, bool allowEmpty)
    {
        if (value is null) throw Invalid();
        Unicode(value);
        if (value.Length == 0) { if (allowEmpty) return; throw Invalid(); }
        var parts = value.Split('/');
        if (StrictUtf8.GetByteCount(value) > 4096 || parts.Length > 64 || value.Any(c => "\\%:".Contains(c))
            || parts.Any(part => part is "" or "." or ".." || StrictUtf8.GetByteCount(part) > 255)) throw Invalid();
    }
    private static long Integer(JsonElement value, string name, long maximum)
    {
        if (!value.GetProperty(name).TryGetInt64(out var number) || number < 0 || number > maximum) throw Invalid(); return number;
    }
    private static void NoDuplicates(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object) {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject()) { if (!seen.Add(property.Name)) throw Invalid(); NoDuplicates(property.Value); }
        } else if (value.ValueKind == JsonValueKind.Array) foreach (var item in value.EnumerateArray()) NoDuplicates(item);
    }
    private static bool Malformed(Exception error) => error is InvalidOperationException or KeyNotFoundException or FormatException or OverflowException;
    private static TransferException Invalid() => new("Ops returned unsupported or unsafe employee file metadata.");
    public void Dispose() => client.Dispose();
}
