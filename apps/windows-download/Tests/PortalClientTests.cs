using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class PortalClientTests
{
    private const string Base = "/api/client/operations/data/windows-catalog";
    private const string DownloadBase = "/api/client/operations/data/windows-successor/files/";
    private const string Folder = "wpc1_folder_opaque";
    private const string FileHandle = "wpc1_file_opaque";
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("portal discovery folder manifest and authenticated download round trip", RoundTrip),
        ("portal rejects unsafe handles before token or HTTP", UnsafeHandles),
        ("portal discovery refuses duplicate handles and mismatched folder identity", InvalidLists),
        ("portal manifest refuses malformed unsafe expired or ambiguous metadata", InvalidManifests),
        ("portal response bounds status and content type fail closed", InvalidResponses),
        ("renewed portal handles preserve resume only for identical trusted version", RenewedResume),
        ("portal exact page limits and display whitespace match server contracts", PageParity),
        ("continuous catalog binds schema purpose pagination and read-only availability without legacy fallback", CatalogContract)
    ];
    private static void Assert(bool value) { if (!value) throw new Exception("Portal assertion failed."); }
    private static async Task Throws<T>(Func<Task> action) where T : Exception {
        try { await action(); } catch (T) { return; } throw new Exception("Expected safe portal failure.");
    }
    private static string Token => "eyJhbGciOiJSUzI1NiJ9." + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c2ln";
    private static byte[] Bytes => "synthetic portal manifest-bound content"u8.ToArray();
    private static Dictionary<string, object?> Manifest(string handle = "wsp1_pinned_one", string version = "r2-version-1") => new() {
        ["schemaVersion"] = 1, ["logicalFileId"] = "ondf1_" + new string('a', 64), ["remoteVersion"] = version,
        ["strongETag"] = "\"version-1\"", ["size"] = Bytes.Length, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(Bytes)),
        ["name"] = "map.bin", ["downloadPath"] = DownloadBase + handle + "/download", ["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 600
    };
    private static object Discovery(object[]? items = null) => new { schemaVersion = 1, resourceMode = "windows_portal_catalog",
        items = items ?? [new { id = Folder, displayName = "Synthetic delivery" }], page = new { nextCursor = (string?)null } };
    private static Dictionary<string, object?> FolderPage() => new() {
        ["schemaVersion"] = 1, ["resourceMode"] = "windows_portal_catalog", ["folderId"] = Folder, ["prefix"] = "", ["cursor"] = null,
        ["folders"] = new object[] { new { id = "wpc1_child", name = "Subfolder" } },
        ["files"] = new object[] { new { id = FileHandle, name = "map.bin", size = Bytes.Length, downloadAvailable = true } },
        ["breadcrumbs"] = new object[] { new { id = Folder, name = "Synthetic delivery" } }
    };
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
    private static HttpResponseMessage Data(long offset = 0, Stream? body = null) {
        var response = new HttpResponseMessage(offset == 0 ? HttpStatusCode.OK : HttpStatusCode.PartialContent) {
            Content = new StreamContent(body ?? new MemoryStream(Bytes[(int)offset..]))
        };
        response.Headers.ETag = EntityTagHeaderValue.Parse("\"version-1\""); response.Content.Headers.ContentLength = Bytes.Length - offset;
        if (offset > 0) response.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset, Bytes.Length - 1, Bytes.Length);
        return response;
    }
    private static async Task RoundTrip() {
        using var fixture = new Fixture();
        var handler = new Handler(request => {
            Assert(request.Method == HttpMethod.Get && request.RequestUri!.Host == "portal.example.invalid");
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == fixture.Runner.LastToken);
            Assert(!request.Headers.Contains("Cookie"));
            return request.RequestUri!.AbsolutePath switch {
                Base + "/deliveries" => Json(Discovery()),
                Base + "/folders/" + Folder => Json(FolderPage()),
                Base + "/files/" + FileHandle + "/download-manifest" => Json(Manifest()),
                _ => throw new Exception("Unexpected route.")
            };
        });
        using var portal = new PortalClient(handler, fixture.Session);
        var deliveries = await portal.GetDeliveriesAsync(); var page = await portal.GetFolderAsync(deliveries.Items.Single().Handle);
        Assert(page.Files.Single().DownloadAvailable && page.Folders.Count == 1 && page.Breadcrumbs.Count == 1);
        var spec = await portal.GetDownloadManifestAsync(page.Files.Single().Handle);
        using var download = new Downloader(new Handler(request => {
            Assert(request.RequestUri!.AbsolutePath == DownloadBase + "wsp1_pinned_one/download");
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == fixture.Runner.LastToken); return Data();
        }), [fixture.Session.Origin], session: fixture.Session);
        var output = await download.DownloadAsync(spec, fixture.Root);
        Assert((await System.IO.File.ReadAllBytesAsync(output)).SequenceEqual(Bytes));
        Assert(fixture.Runner.Calls == 4);
    }
    private static async Task UnsafeHandles() {
        using var fixture = new Fixture(); var handler = new Handler(_ => throw new Exception("Must not run."));
        using var portal = new PortalClient(handler, fixture.Session);
        foreach (var handle in new[] { "https://evil.example.invalid", "wpc1_../secret", "wpc1_safe?x=y", "wpc1_%2f", "wpc1_a\r\nX:1", "ond1_legacy", "wsp1_bytes", "wpc1_", new string('x', 9000) }) {
            await Throws<TransferException>(() => portal.GetFolderAsync(handle));
            await Throws<TransferException>(() => portal.GetDownloadManifestAsync(handle));
            await Throws<TransferException>(() => portal.GetDeliveriesAsync(handle));
        }
        Assert(fixture.Runner.Calls == 0 && handler.Calls == 0);
    }
    private static async Task InvalidLists() {
        var duplicate = new object[] { new { id = Folder, displayName = "A" }, new { id = Folder, displayName = "B" } };
        using var fixture = new Fixture();
        using (var portal = new PortalClient(new Handler(_ => Json(Discovery(duplicate))), fixture.Session))
            await Throws<TransferException>(() => portal.GetDeliveriesAsync());
        foreach (var mutate in new Action<Dictionary<string, object?>>[] {
            value => value["folderId"] = "wpc1_other",
            value => value["resourceMode"] = "legacy",
            value => value["schemaVersion"] = 2,
            value => value["cursor"] = "https://evil.example.invalid",
            value => value["files"] = new[] { new { id = FileHandle, name = "safe", size = 1, downloadPath = "https://evil.example.invalid" } },
            value => value["files"] = new[] { new { id = FileHandle, name = "safe", size = 1, downloadPath = Base + "/files/wpc1_other/download" } },
            value => value["files"] = new[] { new { id = FileHandle, name = "safe", size = 1, downloadAvailable = "true" } },
            value => value["folders"] = new[] { new { id = FileHandle, name = "duplicate" } },
            value => value["prefix"] = "private/path"
        }) {
            var data = FolderPage(); mutate(data);
            using var portal = new PortalClient(new Handler(_ => Json(data)), fixture.Session);
            await Throws<TransferException>(() => portal.GetFolderAsync(Folder));
        }
        using var duplicatedProperty = new PortalClient(new Handler(_ => new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent("{\"resourceMode\":\"windows_portal_catalog\",\"items\":[],\"items\":[],\"page\":{\"nextCursor\":null}}", Encoding.UTF8, "application/json") }), fixture.Session);
        await Throws<TransferException>(() => duplicatedProperty.GetDeliveriesAsync());
    }
    private static async Task InvalidManifests() {
        using var fixture = new Fixture();
        foreach (var mutate in new Action<Dictionary<string, object?>>[] {
            value => value["schemaVersion"] = 2, value => value["logicalFileId"] = "local-name",
            value => value["remoteVersion"] = " ", value => value["remoteVersion"] = "bad\nversion",
            value => value["strongETag"] = "W/\"weak\"", value => value["sha256"] = new string('A', 64),
            value => value["size"] = -1, value => value["size"] = 9007199254740992,
            value => value["name"] = "../map.bin", value => value["name"] = "CON.txt",
            value => value["downloadPath"] = "https://evil.example.invalid/file",
            value => value["downloadPath"] = "//evil.example.invalid/file",
            value => value["downloadPath"] = DownloadBase + "wsp1_%2f/download",
            value => value["downloadPath"] = DownloadBase + "wpc1_metadata/download",
            value => value["downloadPath"] = "/api/client/operations/data/files/ond1_old/download",
            value => value["downloadPath"] = DownloadBase + "wsp1_safe/download?key=x",
            value => value["downloadPath"] = DownloadBase + "wsp1_safe/preview",
            value => value["expiresAt"] = 0, value => value["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 1800,
            value => value["unexpectedCredential"] = "must-not-be-accepted",
            value => value.Remove("sha256")
        }) {
            var data = Manifest(); mutate(data);
            using var portal = new PortalClient(new Handler(_ => Json(data)), fixture.Session);
            await Throws<TransferException>(() => portal.GetDownloadManifestAsync(FileHandle));
        }
    }
    private static async Task InvalidResponses() {
        using var fixture = new Fixture();
        foreach (var status in new[] { HttpStatusCode.Redirect, HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.NotFound, HttpStatusCode.Conflict }) {
            var handler = new Handler(_ => { var r = new HttpResponseMessage(status) { Content = new StringContent("secret-provider-body") }; r.Headers.Location = new Uri("https://evil.example.invalid"); return r; });
            using var portal = new PortalClient(handler, fixture.Session);
            if (status == HttpStatusCode.Unauthorized) await Throws<LoginRequiredException>(() => portal.GetDeliveriesAsync());
            else if (status == HttpStatusCode.Forbidden) await Throws<AccessDeniedException>(() => portal.GetDeliveriesAsync());
            else if (status is HttpStatusCode.NotFound or HttpStatusCode.Conflict) await Throws<ResourceUnavailableException>(() => portal.GetDeliveriesAsync());
            else await Throws<TransferException>(() => portal.GetDeliveriesAsync());
            Assert(handler.Calls == 1);
        }
        foreach (var content in new HttpContent[] { new StringContent("<html>login</html>", Encoding.UTF8, "text/html"),
            new StringContent(new string('x', 65537), Encoding.UTF8, "application/json"),
            new StreamContent(new MemoryStream(new byte[65537])), new StringContent("{", Encoding.UTF8, "application/json") }) {
            if (content is StreamContent) content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            using var portal = new PortalClient(new Handler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = content }), fixture.Session);
            await Throws<TransferException>(() => portal.GetDownloadManifestAsync(FileHandle));
        }
    }
    private static async Task RenewedResume() {
        using var fixture = new Fixture(); var pinned = "wsp1_pinned_one"; var version = "r2-version-1";
        using var portal = new PortalClient(new Handler(_ => Json(Manifest(pinned, version))), fixture.Session);
        var first = await portal.GetDownloadManifestAsync(FileHandle);
        using (var interrupted = new Downloader(new Handler(_ => Data(body: new InterruptedStream(Bytes, 9))), [fixture.Session.Origin], session: fixture.Session))
            await Throws<TransferException>(() => interrupted.DownloadAsync(first, fixture.Root));
        pinned = "wsp1_pinned_two";
        var renewed = await portal.GetDownloadManifestAsync(FileHandle);
        Assert(renewed.OpaqueIdentity == first.OpaqueIdentity && renewed.ContentUri != first.ContentUri);
        using (var resumed = new Downloader(new Handler(request => {
            Assert(request.RequestUri == renewed.ContentUri && request.Headers.Range!.Ranges.Single().From == 9); return Data(9);
        }), [fixture.Session.Origin], session: fixture.Session)) await resumed.DownloadAsync(renewed, fixture.Root);
        using var changed = new Fixture();
        using (var interrupted = new Downloader(new Handler(_ => Data(body: new InterruptedStream(Bytes, 9))), [changed.Session.Origin], session: changed.Session))
            await Throws<TransferException>(() => interrupted.DownloadAsync(first, changed.Root));
        version = "r2-version-2"; var next = await portal.GetDownloadManifestAsync(FileHandle);
        Assert(next.OpaqueIdentity != first.OpaqueIdentity);
        using (var restarted = new Downloader(new Handler(request => { Assert(request.Headers.Range is null); return Data(); }), [changed.Session.Origin], session: changed.Session))
            await restarted.DownloadAsync(next, changed.Root);
        foreach (var path in Directory.GetFiles(changed.Root, "*.json", SearchOption.AllDirectories)) {
            var text = System.IO.File.ReadAllText(path); Assert(!text.Contains("https://") && !text.Contains("wpc1_") && !text.Contains("eyJ"));
        }
    }

    private static async Task PageParity() {
        using var fixture = new Fixture();
        foreach (var count in new[] { 25, 26 }) {
            var items = Enumerable.Range(0, count).Select(i => (object)new { id = "wpc1_item_" + i, displayName = " Display name " }).ToArray();
            using var portal = new PortalClient(new Handler(_ => Json(Discovery(items))), fixture.Session);
            if (count == 26) await Throws<TransferException>(() => portal.GetDeliveriesAsync());
            else Assert((await portal.GetDeliveriesAsync()).Items.All(item => item.DisplayName == " Display name "));
        }
        foreach (var fileCount in new[] { 12, 13 }) {
            var page = FolderPage();
            page["folders"] = Enumerable.Range(0, 13).Select(i => new { id = "wpc1_folder_" + i, name = " Folder " }).ToArray();
            page["files"] = Enumerable.Range(0, fileCount).Select(i => new { id = "wpc1_file_" + i, name = " File ", size = 1, downloadAvailable = false }).ToArray();
            using var portal = new PortalClient(new Handler(_ => Json(page)), fixture.Session);
            if (fileCount == 13) await Throws<TransferException>(() => portal.GetFolderAsync(Folder));
            else {
                var result = await portal.GetFolderAsync(Folder);
                Assert(result.Folders.All(item => item.Name == " Folder ") && result.Files.All(item => item.Name == " File "));
            }
        }
        foreach (var count in new[] { 512, 513 }) {
            var page = FolderPage();
            page["breadcrumbs"] = Enumerable.Range(0, count).Select(i => new { id = "wpc1_crumb_" + i, name = " Crumb " }).ToArray();
            using var portal = new PortalClient(new Handler(_ => Json(page)), fixture.Session);
            if (count == 513) await Throws<TransferException>(() => portal.GetFolderAsync(Folder));
            else Assert((await portal.GetFolderAsync(Folder)).Breadcrumbs.All(item => item.Name == " Crumb "));
        }
        var manifest = Manifest(); manifest["name"] = " map.bin";
        using var accepted = new PortalClient(new Handler(_ => Json(manifest)), fixture.Session);
        Assert((await accepted.GetDownloadManifestAsync(FileHandle)).FileName == " map.bin");
    }
    private static async Task CatalogContract() {
        using var fixture = new Fixture(); var requests = new List<Uri>();
        using (var catalog = new PortalClient(new Handler(request => {
            requests.Add(request.RequestUri!);
            Assert(request.Method == HttpMethod.Get && request.RequestUri!.Host == "portal.example.invalid"
                && request.RequestUri.AbsolutePath.StartsWith(Base + "/", StringComparison.Ordinal)
                && request.Headers.Authorization is null && !request.Headers.Contains("Cookie"));
            if (request.RequestUri!.AbsolutePath.EndsWith("/deliveries", StringComparison.Ordinal)) {
                Assert(request.RequestUri.Query == "?cursor=wpc1_page_one");
                return Json(new { schemaVersion = 1, resourceMode = "windows_portal_catalog",
                    items = new[] { new { id = Folder, displayName = "Read-only delivery" } }, page = new { nextCursor = "wpc1_page_two" } });
            }
            Assert(request.RequestUri.AbsolutePath == Base + "/folders/" + Folder && request.RequestUri.Query == "?cursor=wpc1_folder_page");
            var page = FolderPage();
            page["files"] = new[] { new { id = FileHandle, name = "Read-only file", size = 1, downloadAvailable = false } };
            page["cursor"] = "wpc1_folder_next"; return Json(page);
        }), fixture.Session)) {
            var deliveries = await catalog.GetDeliveriesAsync("wpc1_page_one"); Assert(deliveries.NextCursor == "wpc1_page_two");
            var page = await catalog.GetFolderAsync(Folder, "wpc1_folder_page");
            Assert(!page.Files.Single().DownloadAvailable && page.NextCursor == "wpc1_folder_next" && requests.Count == 2);
        }
        var deniedCalls = 0;
        using (var unavailable = new PortalClient(new Handler(request => {
            deniedCalls++; Assert(request.RequestUri!.AbsolutePath == Base + "/deliveries");
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }), fixture.Session)) await Throws<ResourceUnavailableException>(() => unavailable.GetDeliveriesAsync());
        Assert(deniedCalls == 1); // Missing new service never falls back to ordinary catalog authority.
        foreach (var value in new object[] {
            new { resourceMode = "windows_portal_catalog", items = Array.Empty<object>(), page = new { nextCursor = (string?)null } },
            new { schemaVersion = 1, resourceMode = "operations_native_delivery", items = Array.Empty<object>(), page = new { nextCursor = (string?)null } },
            new { schemaVersion = 1, resourceMode = "windows_portal_catalog", items = Array.Empty<object>(), page = new { nextCursor = (string?)null }, privatePath = "not accepted" },
            new { schemaVersion = 1, resourceMode = "windows_portal_catalog", items = new[] { new { id = "ond1_legacy", displayName = "Old service" } }, page = new { nextCursor = (string?)null } }
        }) {
            using var malformed = new PortalClient(new Handler(_ => Json(value)), fixture.Session);
            await Throws<TransferException>(() => malformed.GetDeliveriesAsync());
        }
        foreach (var variant in new[] { "invalidUtf8", "foreignCharset", "encoding" }) {
            using var malformed = new PortalClient(new Handler(_ => {
                var response = Json(Discovery());
                if (variant == "invalidUtf8") {
                    response.Content = new ByteArrayContent([0xff]); response.Content.Headers.ContentType = new("application/json");
                } else if (variant == "foreignCharset") response.Content.Headers.ContentType!.CharSet = "utf-16";
                else response.Content.Headers.ContentEncoding.Add("gzip");
                return response;
            }), fixture.Session);
            await Throws<TransferException>(() => malformed.GetDeliveriesAsync());
        }
    }
    private sealed class InterruptedStream(byte[] bytes, int limit) : MemoryStream(bytes) {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
            if (Position >= limit) throw new IOException("Synthetic interruption.");
            return base.ReadAsync(buffer[..Math.Min(buffer.Length, limit - (int)Position)], cancellationToken);
        }
    }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> action) : HttpMessageHandler {
        internal int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) { Calls++; return Task.FromResult(action(request)); }
    }
    private sealed class Runner : IAccessCommandRunner {
        internal int Calls; internal string LastToken = "";
        public Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> arguments, CancellationToken cancellationToken) {
            Assert(arguments[1] == "token"); Calls++; LastToken = Token; return Task.FromResult(new AccessCommandResult(0, LastToken, ""));
        }
    }
    private sealed class Fixture : IDisposable {
        internal string Root = Path.Combine(Path.GetTempPath(), "ltds-portal-synthetic-" + Guid.NewGuid().ToString("N"));
        internal Runner Runner = new(); internal CloudflareAccessSession Session;
        internal Fixture() {
            Directory.CreateDirectory(Root); var binary = Path.Combine(Root, "fake-binary-never-run.bin"); System.IO.File.WriteAllText(binary, "synthetic");
            Session = new(new Uri("https://portal.example.invalid/portal"), binary, Convert.ToHexStringLower(SHA256.HashData(System.IO.File.ReadAllBytes(binary))), Runner);
        }
        public void Dispose() { Directory.Delete(Root, true); }
    }
}
