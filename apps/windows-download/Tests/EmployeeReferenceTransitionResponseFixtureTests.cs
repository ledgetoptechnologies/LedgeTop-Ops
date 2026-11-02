using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LedgeTop.WindowsDownload;

// Test-only transport bridge: a synthetic server fixture is never a source of file authority.
internal static class EmployeeReferenceTransitionResponseFixtureTests
{
    private const int MaximumEnvelopeBytes = 65536, MaximumResponseBytes = 8192;
    private const string Origin = "https://ops.example.invalid";
    private const string Route = Origin + "/api/staff/files/reference-transition/v1/preview";
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private sealed record Envelope(string Old, string New, string Logical, string Nonce, byte[] Response);
    private static string Sha(string value) => Convert.ToHexStringLower(SHA256.HashData(StrictUtf8.GetBytes(value)));
    private static void Require(bool value) { if (!value) throw new InvalidDataException("Synthetic fixture refused."); }

    internal static async Task ConsumeFixtureAsync(string path, CancellationToken token = default)
    {
        var envelope = await ReadAsync(path, token);
        using var scratch = new Scratch();
        await ConsumeAsync(envelope, scratch, token);
    }

    private static async Task<Envelope> ReadAsync(string path, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        Require(Path.IsPathFullyQualified(path) && !path.StartsWith("\\\\", StringComparison.Ordinal));
        var full = Path.GetFullPath(path);
        for (var item = new FileInfo(full) as FileSystemInfo; item is not null;
             item = item is FileInfo file ? file.Directory : ((DirectoryInfo)item).Parent)
            Require((item.Attributes & FileAttributes.ReparsePoint) == 0);
        await using var stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read,
            4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
        Require(stream.Length is > 0 and <= MaximumEnvelopeBytes);
        var bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, token);
        Require(await stream.ReadAsync(new byte[1], token) == 0);
        token.ThrowIfCancellationRequested();
        return Parse(bytes);
    }

    private static Envelope Parse(byte[] bytes)
    {
        Require(bytes.Length is > 0 and <= MaximumEnvelopeBytes);
        using var json = JsonDocument.Parse(StrictUtf8.GetString(bytes), new JsonDocumentOptions { MaxDepth = 8 });
        var root = json.RootElement;
        Exact(root, "body", "routeStatus", "responseContentType", "responseBodyBase64");
        Require(root.GetProperty("routeStatus").GetRawText() == "200");
        Require(Text(root, "responseContentType", 64) == "application/json");
        var body = root.GetProperty("body");
        Exact(body, "oldResourceRef", "newResourceRef", "oldLogicalFileId", "requestNonce");
        var old = Text(body, "oldResourceRef", 16384);
        var current = Text(body, "newResourceRef", 16384);
        var logical = Text(body, "oldLogicalFileId", 69);
        var nonce = Text(body, "requestNonce", 128);
        // The real client remains responsible for selector/nonce grammar and response semantics.
        var encoded = Text(root, "responseBodyBase64", 4 * ((MaximumResponseBytes + 2) / 3));
        var response = Convert.FromBase64String(encoded);
        Require(response.Length is > 0 and <= MaximumResponseBytes && Convert.ToBase64String(response) == encoded);
        return new(old, current, logical, nonce, response);
    }

    private static string Text(JsonElement value, string key, int maximum)
    {
        var field = value.GetProperty(key);
        Require(field.ValueKind == JsonValueKind.String);
        var text = field.GetString()!;
        Require(text.Length is > 0 && text.Length <= maximum);
        return text;
    }

    private static void Exact(JsonElement value, params string[] fields)
    {
        Require(value.ValueKind == JsonValueKind.Object);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var field in value.EnumerateObject()) Require(fields.Contains(field.Name, StringComparer.Ordinal) && seen.Add(field.Name));
        Require(seen.Count == fields.Length);
    }

    private static async Task ConsumeAsync(Envelope envelope, Scratch scratch, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var runner = new Runner();
        var helper = scratch.Create("synthetic-never-executed.bin", "generated helper pin only"u8.ToArray());
        var helperSha = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(helper)));
        var session = new CloudflareAccessSession(new Uri(Origin + "/api/staff/files/roots"), helper, helperSha, runner);
        // The injected runner serves only the cached-token command; it never launches a helper process.
        var handler = new Handler(envelope);
        using var client = new EmployeeReferenceTransitionPreviewClient(session, handler, () => envelope.Nonce);
        var evidence = await client.CompareSelectorsAsync(envelope.Old, envelope.New, envelope.Logical, token);
        token.ThrowIfCancellationRequested();
        Require(handler.Calls == 1 && runner.Calls == 1);
        Require(evidence.OldReferenceSha256 == Sha(envelope.Old) && evidence.NewReferenceSha256 == Sha(envelope.New)
            && evidence.RequestNonceSha256 == Sha(envelope.Nonce));
        // No authorization, content, native identity mutation, or App integration follows this result.
    }

    private sealed class Handler(Envelope envelope) : HttpMessageHandler
    {
        internal int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            token.ThrowIfCancellationRequested(); Calls++;
            Require(Calls == 1 && request.Method == HttpMethod.Post && request.RequestUri == new Uri(Route));
            Require(request.Headers.GetValues("Origin").Single() == Origin);
            Require(request.Headers.Accept.Single().MediaType == "application/json" && request.Headers.AcceptEncoding.Single().Value == "identity");
            Require(request.Headers.Contains("Cf-Access-Token") && !request.Headers.Contains("Cookie") && request.Headers.Authorization is null);
            Require(request.Content?.Headers.ContentType?.MediaType == "application/json");
            using var json = JsonDocument.Parse(await request.Content!.ReadAsByteArrayAsync(token));
            var body = json.RootElement;
            Exact(body, "schemaVersion", "oldResourceRef", "newResourceRef", "oldLogicalFileId", "requestNonce");
            Require(body.GetProperty("schemaVersion").GetRawText() == "2"
                && Text(body, "oldResourceRef", 16384) == envelope.Old && Text(body, "newResourceRef", 16384) == envelope.New
                && Text(body, "oldLogicalFileId", 69) == envelope.Logical && Text(body, "requestNonce", 128) == envelope.Nonce);
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(envelope.Response) };
            response.Content.Headers.ContentType = new("application/json");
            return response;
        }
    }

    private sealed class Runner : IAccessCommandRunner
    {
        internal int Calls;
        public Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> args, CancellationToken token)
        {
            token.ThrowIfCancellationRequested(); Calls++;
            Require(args.SequenceEqual(new[] { "access", "token", "--app", Origin + "/api/staff/files/roots" }));
            var payload = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new {
                sub = "synthetic-owner", exp = DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600 }))
                .TrimEnd('=').Replace('+', '-').Replace('/', '_');
            return Task.FromResult(new AccessCommandResult(0, "eyJhbGciOiJSUzI1NiJ9." + payload + ".c2ln", ""));
        }
    }

    private sealed class Scratch : IDisposable
    {
        private readonly string root = Path.Combine(AppContext.BaseDirectory, "reference-response-fixture-" + Guid.NewGuid().ToString("N"));
        private readonly List<(string Path, byte[] Bytes)> owned = [];
        internal Scratch() { Require(!Directory.Exists(root)); Directory.CreateDirectory(root); }
        internal string Create(string name, byte[] bytes)
        {
            Require(name == Path.GetFileName(name));
            var path = Path.Combine(root, name);
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) output.Write(bytes);
            owned.Add((path, bytes)); return path;
        }
        public void Dispose()
        {
            Require((File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0);
            foreach (var entry in owned) {
                Require((File.GetAttributes(entry.Path) & FileAttributes.ReparsePoint) == 0
                    && File.ReadAllBytes(entry.Path).AsSpan().SequenceEqual(entry.Bytes));
                File.Delete(entry.Path);
            }
            Directory.Delete(root, false);
        }
    }

    internal static async Task SelfTestsAsync()
    {
        const string old = "odqr1_old_fixture", current = "odqr1_new_fixture", nonce = "fixture_nonce_123456";
        var logical = "oef1_" + new string('a', 64);
        var response = JsonNode.Parse(JsonSerializer.Serialize(new {
            schemaVersion = 2, previewOnly = true, contentContinuityVerified = false, accessGranted = false, fileBytesFetched = false,
            identityContinuityMatched = true, matches = new { samePrincipal = true, sameGateway = true, sameRoot = true,
                sameRootGeneration = true, sameRootFingerprint = true, sameStaff = true, sameAccessSubject = true,
                sameAdmissionVersion = true, sameCanonicalPath = true, oldLogicalIdMatchesCurrentContext = true,
                newGrantCurrent = true, newGrantMatchesReference = true, rootMetadataMatches = true, newGrantRechecked = true },
            bindings = new { oldReferenceSHA256 = Sha(old), newReferenceSHA256 = Sha(current), requestNonceSHA256 = Sha(nonce), sessionBindingSHA256 = new string('f', 64) }
        }))!.AsObject();
        byte[] Wrap(byte[] raw) => JsonSerializer.SerializeToUtf8Bytes(new {
            body = new { oldResourceRef = old, newResourceRef = current, oldLogicalFileId = logical, requestNonce = nonce },
            routeStatus = 200, responseContentType = "application/json", responseBodyBase64 = Convert.ToBase64String(raw) });
        var good = Wrap(StrictUtf8.GetBytes(response.ToJsonString()));
        using (var scratch = new Scratch()) {
            var fixture = scratch.Create("valid.json", good);
            await ConsumeFixtureAsync(fixture);
            Require(File.ReadAllBytes(fixture).AsSpan().SequenceEqual(good));
        }
        foreach (var bad in new[] { "{"u8.ToArray(), StrictUtf8.GetBytes(response.ToJsonString().Replace(Sha(nonce), new string('0', 64), StringComparison.Ordinal)),
            StrictUtf8.GetBytes(response.ToJsonString().Replace("\"accessGranted\":false", "\"accessGranted\":true", StringComparison.Ordinal)), new byte[] { 0xff } }) {
            using var scratch = new Scratch();
            var fixture = scratch.Create("bad-response.json", Wrap(bad));
            await RefuseAsync<TransferException>(() => ConsumeFixtureAsync(fixture));
        }
        foreach (var bad in new[] { new byte[MaximumEnvelopeBytes + 1], StrictUtf8.GetBytes(StrictUtf8.GetString(good).Replace("\"routeStatus\":200", "\"routeStatus\":200,\"routeStatus\":200", StringComparison.Ordinal)),
            Wrap(new byte[MaximumResponseBytes + 1]), StrictUtf8.GetBytes(StrictUtf8.GetString(good).Replace("\"responseBodyBase64\":\"", "\"responseBodyBase64\":\" ", StringComparison.Ordinal)) }) {
            using var scratch = new Scratch();
            var fixture = scratch.Create("bad-envelope.json", bad);
            await RefuseAsync<InvalidDataException>(() => ConsumeFixtureAsync(fixture));
        }
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        await RefuseAsync<OperationCanceledException>(() => ConsumeFixtureAsync("not-an-absolute-file", cancelled.Token));
    }

    private static async Task RefuseAsync<T>(Func<Task> action) where T : Exception
    {
        try { await action(); } catch (T) { return; }
        throw new InvalidDataException("Synthetic refusal assertion failed.");
    }
}
