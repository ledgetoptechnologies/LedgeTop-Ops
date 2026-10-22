using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

public sealed class ResourceUnavailableException() : Exception("This resource is unavailable. Refresh your authorized file list.");
public sealed record PortalDelivery(string Handle, string DisplayName);
public sealed record PortalDeliveries(IReadOnlyList<PortalDelivery> Items, string? NextCursor);
public sealed record PortalFolder(string Handle, string Name);
public sealed record PortalFile(string Handle, string Name, long Size, bool DownloadAvailable);
public sealed record PortalFolderPage(string FolderHandle, IReadOnlyList<PortalFolder> Folders, IReadOnlyList<PortalFile> Files,
    IReadOnlyList<PortalFolder> Breadcrumbs, string? NextCursor);

/// <summary>Read-only native portal adapter. The server authenticates the human and rechecks each grant.
/// No arbitrary URLs, cookies, credential persistence or automatic browser login are supported.</summary>
public sealed class PortalClient : IDisposable
{
    private const string Base = "/api/client/operations/data";
    private const long MaximumSafeInteger = 9007199254740991;
    private readonly CloudflareAccessSession session;
    private readonly HttpClient client;
    public PortalClient(CloudflareAccessSession session) : this(new HttpClientHandler {
        AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false, Credentials = null,
        AutomaticDecompression = DecompressionMethods.None, CheckCertificateRevocationList = true
    }, session) { }
    internal PortalClient(HttpMessageHandler handler, CloudflareAccessSession session)
    {
        this.session = session;
        client = new HttpClient(handler, true) { Timeout = TimeSpan.FromSeconds(60) };
    }

    public async Task<PortalDeliveries> GetDeliveriesAsync(string? cursor = null, CancellationToken cancellationToken = default)
    {
        using var json = await GetAsync(Base + "/deliveries" + Cursor(cursor), 5 * 1024 * 1024, cancellationToken);
        try {
            var root = json.RootElement; Mode(root);
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var items = Array(root, "items", 25).Select(item => {
                var handle = Handle(Text(item, "id", 8192)); Unique(ids, handle);
                return new PortalDelivery(handle, Text(item, "displayName", 500, canonical: false));
            }).ToArray();
            return new(items, OptionalHandle(root.GetProperty("page"), "nextCursor"));
        } catch (Exception error) when (Malformed(error)) { throw InvalidResponse(); }
    }

    public async Task<PortalFolderPage> GetFolderAsync(string folderHandle, string? cursor = null, CancellationToken cancellationToken = default)
    {
        Handle(folderHandle);
        using var json = await GetAsync(Base + "/folders/" + folderHandle + Cursor(cursor), 5 * 1024 * 1024, cancellationToken);
        try {
            var root = json.RootElement; Mode(root);
            if (Text(root, "folderId", 8192) != folderHandle || Text(root, "prefix", 0, empty: true) != "") throw InvalidResponse();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            var folders = Array(root, "folders", 25).Select(item => {
                var handle = Handle(Text(item, "id", 8192)); Unique(ids, handle);
                return new PortalFolder(handle, Text(item, "name", 500, canonical: false));
            }).ToArray();
            var files = Array(root, "files", 25).Select(item => {
                var handle = Handle(Text(item, "id", 8192)); Unique(ids, handle);
                var download = item.GetProperty("downloadPath");
                if (download.ValueKind != JsonValueKind.Null && download.GetString() != Base + "/files/" + handle + "/download") throw InvalidResponse();
                return new PortalFile(handle, Text(item, "name", 500, canonical: false), Size(item, "size"), download.ValueKind != JsonValueKind.Null);
            }).ToArray();
            if (folders.Length + files.Length > 25) throw InvalidResponse();
            var breadcrumbIds = new HashSet<string>(StringComparer.Ordinal);
            var crumbs = Array(root, "breadcrumbs", 512).Select(item => {
                var handle = Handle(Text(item, "id", 8192)); Unique(breadcrumbIds, handle);
                return new PortalFolder(handle, Text(item, "name", 500, canonical: false));
            }).ToArray();
            return new(folderHandle, folders, files, crumbs, OptionalHandle(root, "cursor"));
        } catch (Exception error) when (Malformed(error)) { throw InvalidResponse(); }
    }

    public async Task<DownloadSpec> GetDownloadManifestAsync(string fileHandle, CancellationToken cancellationToken = default)
    {
        Handle(fileHandle);
        using var json = await GetAsync(Base + "/files/" + fileHandle + "/download-manifest", 64 * 1024, cancellationToken);
        try {
            var root = json.RootElement;
            string[] fields = ["schemaVersion", "logicalFileId", "remoteVersion", "strongETag", "size", "sha256", "name", "downloadPath", "expiresAt"];
            if (root.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(fields.Order()) is false
                || root.GetProperty("schemaVersion").GetInt32() != 1) throw InvalidResponse();
            var identity = Text(root, "logicalFileId", 70); var version = Text(root, "remoteVersion", 256);
            var sha = Text(root, "sha256", 64); var etag = Text(root, "strongETag", 512);
            if (!Regex.IsMatch(identity, "\\Aondf1_[a-f0-9]{64}\\z") || !Regex.IsMatch(sha, "\\A[a-f0-9]{64}\\z")
                || !Regex.IsMatch(etag, "\\A\"[\\x21\\x23-\\x7e]+\"\\z")
                || !EntityTagHeaderValue.TryParse(etag, out var parsed) || parsed.IsWeak || parsed.ToString() != etag) throw InvalidResponse();
            var name = Text(root, "name", 150, canonical: false); Downloader.SafeFileName(name);
            var path = Text(root, "downloadPath", 8300);
            var prefix = Base + "/files/"; const string suffix = "/download";
            if (!path.StartsWith(prefix, StringComparison.Ordinal) || !path.EndsWith(suffix, StringComparison.Ordinal)) throw InvalidResponse();
            Handle(path[prefix.Length..^suffix.Length]);
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds(); var expires = Size(root, "expiresAt");
            if (expires <= now + 5 || expires > now + 900) throw InvalidResponse();
            // The opaque state identity deliberately excludes short-lived resource handles and URLs.
            return new(identity + ":" + version, new Uri(session.Origin, path), name, Size(root, "size"), etag, sha);
        } catch (Exception error) when (Malformed(error)) { throw InvalidResponse(); }
    }

    private async Task<JsonDocument> GetAsync(string path, int limit, CancellationToken cancellationToken)
    {
        var uri = new Uri(session.Origin, path);
        if (uri.GetLeftPart(UriPartial.Authority) != session.Origin.GetLeftPart(UriPartial.Authority)) throw InvalidResponse();
        try {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Accept.ParseAdd("application/json"); request.Headers.AcceptEncoding.ParseAdd("identity");
            request.Headers.Add("Cf-Access-Token", await session.GetTokenAsync(cancellationToken));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new LoginRequiredException();
            if (response.StatusCode == HttpStatusCode.Forbidden) throw new AccessDeniedException();
            if (response.StatusCode == HttpStatusCode.NotFound) throw new ResourceUnavailableException();
            if (response.StatusCode != HttpStatusCode.OK || response.Content.Headers.ContentType?.MediaType != "application/json"
                || response.Content.Headers.ContentEncoding.Count != 0 || response.Content.Headers.ContentLength > limit) throw InvalidResponse();
            using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var output = new MemoryStream(); var buffer = new byte[8192];
            while (true) {
                var read = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, limit + 1 - (int)output.Length)), cancellationToken);
                if (read == 0) break;
                output.Write(buffer, 0, read); if (output.Length > limit) throw InvalidResponse();
            }
            var json = JsonDocument.Parse(output.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
            try { NoDuplicateProperties(json.RootElement); } catch { json.Dispose(); throw; }
            return json;
        } catch (HttpRequestException) { throw new TransferException("The portal request could not be completed."); }
        catch (IOException) { throw new TransferException("The portal response could not be read."); }
        catch (JsonException) { throw InvalidResponse(); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw new TransferException("The portal request timed out."); }
    }
    private static void NoDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object) {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject()) { Unique(names, property.Name); NoDuplicateProperties(property.Value); }
        } else if (element.ValueKind == JsonValueKind.Array) foreach (var item in element.EnumerateArray()) NoDuplicateProperties(item);
    }
    private static void Mode(JsonElement root) { if (Text(root, "resourceMode", 100) != "operations_native_delivery") throw InvalidResponse(); }
    private static JsonElement.ArrayEnumerator Array(JsonElement root, string name, int maximum) {
        var array = root.GetProperty(name); if (array.GetArrayLength() > maximum) throw InvalidResponse(); return array.EnumerateArray();
    }
    private static string Text(JsonElement root, string name, int maximum, bool empty = false, bool canonical = true) {
        var value = root.GetProperty(name).GetString();
        if (value is null || (!empty && value.Length == 0) || value.Length > maximum || (canonical && value.Trim() != value) || value.Any(char.IsControl)) throw InvalidResponse(); return value;
    }
    private static long Size(JsonElement root, string name) {
        if (!root.GetProperty(name).TryGetInt64(out var value) || value < 0 || value > MaximumSafeInteger) throw InvalidResponse(); return value;
    }
    private static string Handle(string value) {
        if (value.Length > 8192 || !Regex.IsMatch(value, "\\Aond1_[A-Za-z0-9_-]+\\z")) throw InvalidResponse(); return value;
    }
    private static string? OptionalHandle(JsonElement root, string name) => root.GetProperty(name).ValueKind == JsonValueKind.Null ? null : Handle(Text(root, name, 8192));
    private static string Cursor(string? cursor) => cursor is null ? "" : "?cursor=" + Handle(cursor);
    private static void Unique(HashSet<string> values, string value) { if (!values.Add(value)) throw InvalidResponse(); }
    private static bool Malformed(Exception error) => error is InvalidOperationException or KeyNotFoundException or FormatException or OverflowException;
    private static TransferException InvalidResponse() => new("The portal returned unsupported or unsafe download metadata.");
    public void Dispose() => client.Dispose();
}
