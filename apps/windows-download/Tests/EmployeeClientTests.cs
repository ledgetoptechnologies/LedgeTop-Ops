using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class EmployeeClientTests
{
    private const string Base = "/api/staff/files";
    private const string RootId = "20000000-0000-4000-8000-000000000001";
    private const string GatewayId = "20000000-0000-4000-8000-000000000002";
    private static byte[] Bytes => "synthetic employee content verified end to end"u8.ToArray();
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("employee real owned subprocess discovery pages manifest verified download", RoundTrip),
        ("employee input paths cursors and root IDs reject before token or HTTP", UnsafeInputs),
        ("employee root and page bounds exact fields ordering and Unicode stay strict", Lists),
        ("employee manifest rejects mismatched hashes unsafe handles and metadata", Manifests),
        ("employee HTTP statuses UTF8 duplicate fields redirects and body bounds fail closed", Responses),
        ("employee renewed snapshots resume only the identical logical content version", Resume),
        ("employee wrong-person session cannot reuse file metadata or access discovery", WrongPerson),
        ("employee metadata cancellation is explicit and never launches login", Cancellation)
    ];
    private static void Assert(bool value) { if (!value) throw new Exception("Employee adapter assertion failed."); }
    private static async Task Throws<T>(Func<Task> action) where T : Exception {
        try { await action(); } catch (T) { return; } throw new Exception("Expected safe employee adapter failure.");
    }
    private static string Sha(byte[]? bytes = null) => Convert.ToHexStringLower(SHA256.HashData(bytes ?? Bytes));
    private static string Token(string subject) => "eyJhbGciOiJSUzI1NiJ9." + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(
        new { sub = subject, exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 })).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c2ln";
    private static object Roots(int count = 1) => new { schemaVersion = 1, roots = Enumerable.Range(0, count).Select(index => new {
        rootId = $"20000000-0000-4000-8000-{index + 1:000000000000}", gatewayId = GatewayId, displayName = " Client photos "
    }).ToArray() };
    private static object Page(int count = 1, string? cursor = null) => new { schemaVersion = 1,
        entries = Enumerable.Range(0, count).Select(index => new { name = $"photo-{index:0000}.jpg", kind = "file" }).ToArray(), nextCursor = cursor };
    private static Dictionary<string, object?> Manifest(string handle = "eof1_snapshot_one", byte[]? bytes = null) => new() {
        ["schemaVersion"] = 1, ["logicalFileId"] = "oef1_" + new string('a', 64), ["remoteVersion"] = Sha(bytes),
        ["sha256"] = Sha(bytes), ["strongETag"] = "\"" + Sha(bytes) + "\"", ["size"] = (bytes ?? Bytes).Length,
        ["name"] = "map.bin", ["downloadPath"] = Base + "/downloads/" + handle,
        ["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 600
    };
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) {
        Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json")
    };
    private static HttpResponseMessage Data(byte[]? bytes = null, long offset = 0, Stream? stream = null) {
        bytes ??= Bytes;
        var reply = new HttpResponseMessage(offset == 0 ? HttpStatusCode.OK : HttpStatusCode.PartialContent) {
            Content = new StreamContent(stream ?? new MemoryStream(bytes[(int)offset..]))
        };
        reply.Headers.ETag = EntityTagHeaderValue.Parse("\"" + Sha(bytes) + "\"");
        reply.Content.Headers.ContentLength = bytes.Length - offset;
        if (offset > 0) reply.Content.Headers.ContentRange = new ContentRangeHeaderValue(offset, bytes.Length - 1, bytes.Length);
        return reply;
    }

    private static async Task RoundTrip() {
        using var fixture = new Fixture(realProcess: true);
        const string source = "Clients/Ben Hamblin/中 #?.jpg";
        const string cursor = "opaque.selector+%?&=";
        var handler = new Handler((request, _) => {
            Assert(request.Method == HttpMethod.Get && request.RequestUri!.Host == "ops.example.invalid");
            Assert(!request.Headers.Contains("Cookie") && request.Headers.Authorization is null);
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == fixture.Runner.LastToken);
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == Base + "/roots") return Task.FromResult(Json(Roots()));
            if (uri.AbsolutePath.EndsWith("/entries", StringComparison.Ordinal)) {
                var query = uri.Query;
                if (query == "?path=") return Task.FromResult(Json(Page(200, cursor)));
                Assert(query == "?path=" + Uri.EscapeDataString(source) + "&cursor=" + Uri.EscapeDataString(cursor));
                return Task.FromResult(Json(Page()));
            }
            Assert(uri.AbsolutePath == Base + "/roots/" + RootId + "/manifest" && uri.Query == "?path=" + Uri.EscapeDataString(source));
            return Task.FromResult(Json(Manifest()));
        });
        using var employee = new EmployeeClient(handler, fixture.Session);
        var roots = await employee.GetRootsAsync(); Assert(roots.Single().DisplayName == " Client photos ");
        var page = await employee.GetEntriesAsync(roots.Single().RootId);
        Assert(page.Entries.Count == 200 && page.NextCursor == cursor);
        Assert((await employee.GetEntriesAsync(RootId, source, page.NextCursor)).NextCursor is null);
        var spec = await employee.GetDownloadManifestAsync(RootId, source);
        Assert(spec.OpaqueIdentity == "oef1_" + new string('a', 64) + ":" + Sha());
        using var downloader = new Downloader(new Handler((request, _) => {
            Assert(request.RequestUri!.AbsolutePath == Base + "/downloads/eof1_snapshot_one");
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == fixture.Runner.LastToken);
            Assert(request.Headers.IfMatch.Single().Tag == "\"" + Sha() + "\"");
            return Task.FromResult(Data());
        }), [fixture.Session.Origin], session: fixture.Session);
        var output = await downloader.DownloadAsync(spec, fixture.Root);
        Assert((await File.ReadAllBytesAsync(output)).SequenceEqual(Bytes));
        Assert(fixture.Runner.Calls == 5 && fixture.Runner.RealCalls == 5);
        var persisted = string.Join("", Directory.EnumerateFiles(fixture.Root, "*.json", SearchOption.AllDirectories).Select(File.ReadAllText));
        Assert(!persisted.Contains(fixture.Runner.LastToken, StringComparison.Ordinal) && !persisted.Contains("eof1_snapshot", StringComparison.Ordinal));
    }

    private static async Task UnsafeInputs() {
        using var fixture = new Fixture(); var handler = new Handler((_, _) => throw new Exception("No HTTP allowed."));
        using var employee = new EmployeeClient(handler, fixture.Session);
        foreach (var id in new[] { "../root", "A0000000-0000-4000-8000-000000000001", "https://evil.invalid", RootId + "?x=1", "00000000-0000-0000-0000-000000000000" }) {
            await Throws<TransferException>(() => employee.GetEntriesAsync(id));
            await Throws<TransferException>(() => employee.GetDownloadManifestAsync(id, "file"));
        }
        foreach (var path in new[] { "../file", "a/../b", "/file", "file/", "a//b", "a\\b", "a:b", "%2e%2e/file", "%252f", "a\u0000b", "a\u202eb", "\ud800", new string('a', 256), string.Join('/', Enumerable.Repeat("x", 65)) }) {
            await Throws<TransferException>(() => employee.GetEntriesAsync(RootId, path));
            await Throws<TransferException>(() => employee.GetDownloadManifestAsync(RootId, path));
        }
        await Throws<TransferException>(() => employee.GetDownloadManifestAsync(RootId, ""));
        foreach (var cursor in new[] { "", "a b", "line\n", "中", new string('a', 8193) })
            await Throws<TransferException>(() => employee.GetEntriesAsync(RootId, cursor: cursor));
        Assert(handler.Calls == 0 && fixture.Runner.Calls == 0);
    }

    private static async Task Lists() {
        using var fixture = new Fixture();
        using (var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(Roots(100)))), fixture.Session))
            Assert((await employee.GetRootsAsync()).Count == 100);
        foreach (var value in new object[] { Roots(101), new { schemaVersion = 1, roots = new[] {
            new { rootId = RootId, gatewayId = GatewayId, displayName = "one" }, new { rootId = RootId, gatewayId = GatewayId, displayName = "two" } } },
            new { schemaVersion = 1, roots = new[] { new { rootId = RootId, gatewayId = GatewayId, displayName = new string('x', 161) } } },
            new { schemaVersion = 1, roots = new[] { new { rootId = RootId, gatewayId = GatewayId, displayName = " " } } },
            new { schemaVersion = 1, roots = Array.Empty<object>(), extra = true } }) {
            using var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(value))), fixture.Session);
            await Throws<TransferException>(() => employee.GetRootsAsync());
        }
        foreach (var value in new object[] { Page(201), Page(1, "cursor"), new { schemaVersion = 1, nextCursor = (string?)null,
            entries = new[] { new { name = "z", kind = "file" }, new { name = "a", kind = "file" } } },
            new { schemaVersion = 1, nextCursor = (string?)null, entries = new[] { new { name = "same", kind = "file" }, new { name = "same", kind = "folder" } } },
            new { schemaVersion = 1, nextCursor = (string?)null, entries = new[] { new { name = "a/b", kind = "file" } } },
            new { schemaVersion = 1, nextCursor = (string?)null, entries = new[] { new { name = "a", kind = "symlink" } } } }) {
            using var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(value))), fixture.Session);
            await Throws<TransferException>(() => employee.GetEntriesAsync(RootId));
        }
        var unicode = new { schemaVersion = 1, nextCursor = (string?)null,
            entries = new[] { new { name = "é", kind = "file" }, new { name = "中", kind = "folder" }, new { name = "😀", kind = "file" } } };
        using var accepted = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(unicode))), fixture.Session);
        Assert((await accepted.GetEntriesAsync(RootId)).Entries.Count == 3);
    }

    private static async Task Manifests() {
        using var fixture = new Fixture();
        foreach (var mutate in new Action<Dictionary<string, object?>>[] {
            m => m["schemaVersion"] = 2, m => m["logicalFileId"] = "ondf1_" + new string('a', 64),
            m => m["remoteVersion"] = new string('b', 64), m => m["sha256"] = Sha().ToUpperInvariant(),
            m => m["strongETag"] = "W/\"" + Sha() + "\"", m => m["strongETag"] = "\"another\"",
            m => m["size"] = -1, m => m["size"] = (1L << 40) + 1, m => m["size"] = 1.5,
            m => m["name"] = "../map.bin", m => m["name"] = "CONIN$.txt", m => m["name"] = "LPT².txt",
            m => m["name"] = new string('a', 151), m => m["name"] = "\ud800", m => m["name"] = "map.bin ",
            m => m["downloadPath"] = "https://evil.invalid/content", m => m["downloadPath"] = "//evil.invalid/content",
            m => m["downloadPath"] = Base + "/downloads/eof1_%2f", m => m["downloadPath"] = Base + "/downloads/eof1_x?token=secret",
            m => m["downloadPath"] = Base + "/downloads/eof1_x/other", m => m["downloadPath"] = Base + "/downloads/" + "eof1_" + new string('a', 16380),
            m => m["expiresAt"] = 0, m => m["expiresAt"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 901,
            m => m["unexpected"] = "secret", m => m.Remove("name") }) {
            var manifest = Manifest(); mutate(manifest);
            // JSON encoders replace isolated UTF16 surrogates; raw escape covered separately.
            if (manifest.TryGetValue("name", out var name) && name is string text && text == "\ud800") continue;
            using var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(manifest))), fixture.Session);
            await Throws<TransferException>(() => employee.GetDownloadManifestAsync(RootId, "file"));
        }
        foreach (var raw in new[] { JsonSerializer.Serialize(Manifest()).Replace("map.bin", "\\uD800", StringComparison.Ordinal),
            JsonSerializer.Serialize(Manifest()).Replace("\"schemaVersion\":1", "\"schemaVersion\":1.0", StringComparison.Ordinal) }) {
            using var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
                Content = new StringContent(raw, Encoding.UTF8, "application/json") })), fixture.Session);
            await Throws<TransferException>(() => employee.GetDownloadManifestAsync(RootId, "file"));
        }
        var maximum = Manifest("eof1_" + new string('a', 16379)); maximum["size"] = 1L << 40;
        using var accepted = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(maximum))), fixture.Session);
        Assert((await accepted.GetDownloadManifestAsync(RootId, "file")).Length == 1L << 40);
    }

    private static async Task Responses() {
        using var fixture = new Fixture();
        foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.Conflict, HttpStatusCode.NotFound }) {
            using var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(new HttpResponseMessage(status))), fixture.Session);
            if (status == HttpStatusCode.Unauthorized) await Throws<LoginRequiredException>(() => employee.GetRootsAsync());
            else if (status == HttpStatusCode.Forbidden) await Throws<AccessDeniedException>(() => employee.GetRootsAsync());
            else await Throws<ResourceUnavailableException>(() => employee.GetDownloadManifestAsync(RootId, "file"));
        }
        foreach (var response in new Func<HttpResponseMessage>[] {
            () => new(HttpStatusCode.Redirect) { Headers = { Location = new Uri("https://elsewhere.invalid/login") } },
            () => new(HttpStatusCode.OK) { Content = new StringContent("<html>login</html>", Encoding.UTF8, "text/html") },
            () => new(HttpStatusCode.OK) { Content = new StringContent("{\"schemaVersion\":1,\"roots\":[],\"roots\":[]}", Encoding.UTF8, "application/json") },
            () => new(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.Unicode, "application/json") },
            () => { var reply = Json(Roots()); reply.Content.Headers.ContentEncoding.Add("gzip"); return reply; },
            () => { var reply = Json(Roots()); reply.Content.Headers.ContentLength = 262145; return reply; },
            () => { var reply = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new MemoryStream(new byte[262145])) }; reply.Content.Headers.ContentType = new("application/json"); return reply; },
            () => { var reply = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent([0xff, 0xfe]) }; reply.Content.Headers.ContentType = new("application/json"); return reply; }
        }) {
            var handler = new Handler((_, _) => Task.FromResult(response()));
            using var employee = new EmployeeClient(handler, fixture.Session);
            await Throws<TransferException>(() => employee.GetRootsAsync()); Assert(handler.Calls == 1);
        }
        foreach (var status in new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden, HttpStatusCode.Conflict, HttpStatusCode.NotFound }) {
            var spec = new DownloadSpec("employee-version", new Uri(fixture.Session.Origin, Base + "/downloads/eof1_old"), "map.bin", Bytes.Length, "\"" + Sha() + "\"", Sha());
            using var downloader = new Downloader(new Handler((_, _) => Task.FromResult(new HttpResponseMessage(status))), [fixture.Session.Origin], session: fixture.Session);
            if (status == HttpStatusCode.Unauthorized) await Throws<LoginRequiredException>(() => downloader.DownloadAsync(spec, fixture.Root));
            else if (status == HttpStatusCode.Forbidden) await Throws<AccessDeniedException>(() => downloader.DownloadAsync(spec, fixture.Root));
            else await Throws<ResourceUnavailableException>(() => downloader.DownloadAsync(spec, fixture.Root));
        }
    }

    private static async Task Resume() {
        using var fixture = new Fixture(); var version = Bytes; var generation = 0;
        using var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(Manifest("eof1_snapshot_" + ++generation, version)))), fixture.Session);
        var original = await employee.GetDownloadManifestAsync(RootId, "file");
        using (var downloader = new Downloader(new Handler((_, _) => Task.FromResult(Data(stream: new Interrupted(Bytes, 7)))), [fixture.Session.Origin], session: fixture.Session))
            await Throws<TransferException>(() => downloader.DownloadAsync(original, fixture.Root));
        var part = Directory.GetFiles(fixture.Root, "*.part", SearchOption.AllDirectories).Single();
        Assert(new FileInfo(part).Length == 7);
        var expired = new Handler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict)));
        using (var downloader = new Downloader(expired, [fixture.Session.Origin], session: fixture.Session))
            await Throws<ResourceUnavailableException>(() => downloader.DownloadAsync(original, fixture.Root));
        Assert(expired.Calls == 1 && new FileInfo(part).Length == 7);
        var renewed = await employee.GetDownloadManifestAsync(RootId, "file");
        Assert(renewed.OpaqueIdentity == original.OpaqueIdentity && renewed.ContentUri != original.ContentUri);
        using (var downloader = new Downloader(new Handler((request, _) => {
            Assert(request.RequestUri == renewed.ContentUri && request.Headers.Range!.Ranges.Single().From == 7);
            return Task.FromResult(Data(offset: 7));
        }), [fixture.Session.Origin], session: fixture.Session)) {
            var output = await downloader.DownloadAsync(renewed, fixture.Root); Assert((await File.ReadAllBytesAsync(output)).SequenceEqual(Bytes));
        }
        using var changedFixture = new Fixture();
        using (var downloader = new Downloader(new Handler((_, _) => Task.FromResult(Data(stream: new Interrupted(Bytes, 7)))), [changedFixture.Session.Origin], session: changedFixture.Session))
            await Throws<TransferException>(() => downloader.DownloadAsync(original, changedFixture.Root));
        var oldPart = Directory.GetFiles(changedFixture.Root, "*.part", SearchOption.AllDirectories).Single();
        version = "DIFFERENT employee version must start at zero"u8.ToArray();
        var changed = await employee.GetDownloadManifestAsync(RootId, "file"); Assert(changed.OpaqueIdentity != original.OpaqueIdentity);
        using (var downloader = new Downloader(new Handler((request, _) => {
            Assert(request.Headers.Range is null); return Task.FromResult(Data(version));
        }), [changedFixture.Session.Origin], session: changedFixture.Session)) {
            var output = await downloader.DownloadAsync(changed, changedFixture.Root);
            Assert((await File.ReadAllBytesAsync(output)).SequenceEqual(version));
        }
        Assert((await File.ReadAllBytesAsync(oldPart)).SequenceEqual(Bytes[..7]));
    }

    private static async Task WrongPerson() {
        using var owner = new Fixture(); using var outsider = new Fixture(); outsider.Runner.Subject = "outsider";
        using var employee = new EmployeeClient(new Handler((_, _) => Task.FromResult(Json(Manifest()))), owner.Session);
        var spec = await employee.GetDownloadManifestAsync(RootId, "file");
        var denied = new Handler((request, _) => {
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == outsider.Runner.LastToken);
            Assert(outsider.Runner.LastToken != owner.Runner.LastToken);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
        });
        using var otherEmployee = new EmployeeClient(denied, outsider.Session);
        await Throws<AccessDeniedException>(() => otherEmployee.GetRootsAsync());
        await Throws<AccessDeniedException>(() => otherEmployee.GetEntriesAsync(RootId));
        await Throws<AccessDeniedException>(() => otherEmployee.GetDownloadManifestAsync(RootId, "file"));
        using var downloader = new Downloader(new Handler((request, _) => {
            Assert(request.Headers.GetValues("Cf-Access-Token").Single() == outsider.Runner.LastToken);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));
        }), [outsider.Session.Origin], session: outsider.Session);
        await Throws<AccessDeniedException>(() => downloader.DownloadAsync(spec, outsider.Root));
        Assert(!File.Exists(Path.Combine(outsider.Root, "map.bin")) && denied.Calls == 3);
    }

    private static async Task Cancellation() {
        using var fixture = new Fixture();
        using var employee = new EmployeeClient(new Handler(async (_, token) => {
            Assert(token.CanBeCanceled); await Task.Delay(Timeout.Infinite, token); throw new Exception("Unreachable");
        }), fixture.Session);
        using var cancelled = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Throws<OperationCanceledException>(() => employee.GetDownloadManifestAsync(RootId, "file", cancelled.Token));
        Assert(fixture.Runner.Calls == 1);
    }

    private sealed class Interrupted(byte[] bytes, int limit) : MemoryStream(bytes) {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
            if (Position >= limit) throw new IOException("Synthetic interruption.");
            return base.ReadAsync(buffer[..Math.Min(buffer.Length, limit - (int)Position)], cancellationToken);
        }
    }
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> action) : HttpMessageHandler {
        internal int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) { Calls++; return action(request, cancellationToken); }
    }
    private sealed class Runner(bool realProcess) : IAccessCommandRunner {
        internal int Calls, RealCalls; internal string LastToken = "";
        internal string Subject = "owner";
        public async Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> arguments, CancellationToken cancellationToken) {
            Assert(arguments.SequenceEqual(new[] { "access", "token", "--app", "https://ops.example.invalid/api/staff/files/roots" }));
            Calls++; LastToken = Token(Subject);
            if (!realProcess) return new(0, LastToken, "");
            // Execute only this test assembly's own pinned apphost. The reserved
            // child echoes synthetic bytes; no real cloudflared/browser/network.
            var child = await new AccessCommandRunner().RunAsync(path, ["--synthetic-access-child-v1", "echo", LastToken, ""], cancellationToken);
            Assert(child.ExitCode == 7 && child.Stdout == LastToken && child.Stderr == ""); RealCalls++;
            return new(0, child.Stdout, "");
        }
    }
    private sealed class Fixture : IDisposable {
        internal string Root = Path.Combine(Path.GetTempPath(), "ltds-employee-synthetic-" + Guid.NewGuid().ToString("N"));
        internal Runner Runner; internal CloudflareAccessSession Session;
        internal Fixture(bool realProcess = false) {
            Directory.CreateDirectory(Root); Runner = new(realProcess);
            string binary;
            if (realProcess) {
                var assembly = typeof(EmployeeClientTests).Assembly.Location;
                binary = Path.Combine(Path.GetDirectoryName(assembly)!, Path.GetFileNameWithoutExtension(assembly) + (OperatingSystem.IsWindows() ? ".exe" : ""));
            } else { binary = Path.Combine(Root, "synthetic-never-executed.bin"); File.WriteAllText(binary, "owned synthetic file"); }
            Session = new(new Uri("https://ops.example.invalid/api/staff/files/roots"), binary, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(binary))), Runner);
        }
        public void Dispose() { Directory.Delete(Root, true); }
    }
}
