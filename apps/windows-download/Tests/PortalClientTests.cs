using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class PortalClientTests
{
    private const string Base = "/api/client/operations/data";
    private const string Folder = "ond1_folder_opaque";
    private const string FileHandle = "ond1_file_opaque";
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("portal discovery folder manifest and authenticated download round trip", RoundTrip),
        ("portal rejects unsafe handles before token or HTTP", UnsafeHandles),
        ("portal discovery refuses duplicate handles and mismatched folder identity", InvalidLists),
        ("portal manifest refuses malformed unsafe expired or ambiguous metadata", InvalidManifests),
        ("portal response bounds status and content type fail closed", InvalidResponses),
        ("renewed portal handles preserve resume only for identical trusted version", RenewedResume),
        ("portal exact page limits and display whitespace match server contracts", PageParity)
    ];
    private static void Assert(bool value) { if (!value) throw new Exception("Portal assertion failed."); }
    private static async Task Throws<T>(Func<Task> action) where T : Exception {
        try { await action(); } catch (T) { return; } throw new Exception("Expected safe portal failure.");
    }
    private static string Token => "eyJhbGciOiJSUzI1NiJ9." + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c2ln";
    private static byte[] Bytes => "synthetic portal manifest-bound content"u8.ToArray();
    private static Dictionary<string, object?> Manifest(string handle = "ond1_pinned_one", string version = "r2-version-1") => new() {
        ["schemaVersion"] = 1, ["logicalFileId"] = "ondf1_" + new string('a', 64), ["remoteVersion"] = version,
        ["strongETag"] = "\"version-1\"", ["size"] = Bytes.Length, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(Bytes)),
        ["name"] = "map.bin", ["downloadPath"] = Base + "/files/" + handle + "/download", ["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 600
    };
    private static object Discovery(object[]? items = null) => new { resourceMode = "operations_native_delivery",
        items = items ?? [new { id = Folder, displayName = "Synthetic delivery" }], page = new { nextCursor = (string?)null } };
    private static Dictionary<string, object?> FolderPage() => new() {
        ["resourceMode"] = "operations_native_delivery", ["folderId"] = Folder, ["prefix"] = "", ["cursor"] = null,
        ["folders"] = new object[] { new { id = "ond1_child", name = "Subfolder" } },
        ["files"] = new object[] { new { id = FileHandle, name = "map.bin", size = Bytes.Length, downloadPath = Base + "/files/" + FileHandle + "/download" } },
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
            Assert(request.RequestUri!.AbsolutePath == Base + "/files/ond1_pinned_one/download");
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == fixture.Runner.LastToken); return Data();
        }), [fixture.Session.Origin], session: fixture.Session);
        var output = await download.DownloadAsync(spec, fixture.Root);
        Assert((await System.IO.File.ReadAllBytesAsync(output)).SequenceEqual(Bytes));
        Assert(fixture.Runner.Calls == 4);
    }
    private static async Task UnsafeHandles() {
        using var fixture = new Fixture(); var handler = new Handler(_ => throw new Exception("Must not run."));
        using var portal = new PortalClient(handler, fixture.Session);
        foreach (var handle in new[] { "https://evil.example.invalid", "ond1_../secret", "ond1_safe?x=y", "ond1_%2f", "ond1_a\r\nX:1", new string('x', 9000) }) {
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
            value => value["folderId"] = "ond1_other",
            value => value["resourceMode"] = "legacy",
            value => value["cursor"] = "https://evil.example.invalid",
            value => value["files"] = new[] { new { id = FileHandle, name = "safe", size = 1, downloadPath = "https://evil.example.invalid" } },
            value => value["files"] = new[] { new { id = FileHandle, name = "safe", size = 1, downloadPath = Base + "/files/ond1_other/download" } },
            value => value["folders"] = new[] { new { id = FileHandle, name = "duplicate" } },
            value => value["prefix"] = "private/path"
        }) {
            var data = FolderPage(); mutate(data);
            using var portal = new PortalClient(new Handler(_ => Json(data)), fixture.Session);
            await Throws<TransferException>(() => portal.GetFolderAsync(Folder));
        }
        using var duplicatedProperty = new PortalClient(new Handler(_ => new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent("{\"resourceMode\":\"operations_native_delivery\",\"items\":[],\"items\":[],\"page\":{\"nextCursor\":null}}", Encoding.UTF8, "application/json") }), fixture.Session);
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
            value => value["downloadPath"] = Base + "/files/ond1_%2f/download",
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
            else if (status == HttpStatusCode.NotFound) await Throws<ResourceUnavailableException>(() => portal.GetDeliveriesAsync());
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
        using var fixture = new Fixture(); var pinned = "ond1_pinned_one"; var version = "r2-version-1";
        using var portal = new PortalClient(new Handler(_ => Json(Manifest(pinned, version))), fixture.Session);
        var first = await portal.GetDownloadManifestAsync(FileHandle);
        using (var interrupted = new Downloader(new Handler(_ => Data(body: new InterruptedStream(Bytes, 9))), [fixture.Session.Origin], session: fixture.Session))
            await Throws<TransferException>(() => interrupted.DownloadAsync(first, fixture.Root));
        pinned = "ond1_pinned_two";
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
            var text = System.IO.File.ReadAllText(path); Assert(!text.Contains("https://") && !text.Contains("ond1_") && !text.Contains("eyJ"));
        }
    }

    private static async Task PageParity() {
        using var fixture = new Fixture();
        foreach (var count in new[] { 25, 26 }) {
            var items = Enumerable.Range(0, count).Select(i => (object)new { id = "ond1_item_" + i, displayName = " Display name " }).ToArray();
            using var portal = new PortalClient(new Handler(_ => Json(Discovery(items))), fixture.Session);
            if (count == 26) await Throws<TransferException>(() => portal.GetDeliveriesAsync());
            else Assert((await portal.GetDeliveriesAsync()).Items.All(item => item.DisplayName == " Display name "));
        }
        foreach (var fileCount in new[] { 12, 13 }) {
            var page = FolderPage();
            page["folders"] = Enumerable.Range(0, 13).Select(i => new { id = "ond1_folder_" + i, name = " Folder " }).ToArray();
            page["files"] = Enumerable.Range(0, fileCount).Select(i => new { id = "ond1_file_" + i, name = " File ", size = 1, downloadPath = (string?)null }).ToArray();
            using var portal = new PortalClient(new Handler(_ => Json(page)), fixture.Session);
            if (fileCount == 13) await Throws<TransferException>(() => portal.GetFolderAsync(Folder));
            else {
                var result = await portal.GetFolderAsync(Folder);
                Assert(result.Folders.All(item => item.Name == " Folder ") && result.Files.All(item => item.Name == " File "));
            }
        }
        foreach (var count in new[] { 512, 513 }) {
            var page = FolderPage();
            page["breadcrumbs"] = Enumerable.Range(0, count).Select(i => new { id = "ond1_crumb_" + i, name = " Crumb " }).ToArray();
            using var portal = new PortalClient(new Handler(_ => Json(page)), fixture.Session);
            if (count == 513) await Throws<TransferException>(() => portal.GetFolderAsync(Folder));
            else Assert((await portal.GetFolderAsync(Folder)).Breadcrumbs.All(item => item.Name == " Crumb "));
        }
        var manifest = Manifest(); manifest["name"] = " map.bin";
        using var accepted = new PortalClient(new Handler(_ => Json(manifest)), fixture.Session);
        Assert((await accepted.GetDownloadManifestAsync(FileHandle)).FileName == " map.bin");
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
