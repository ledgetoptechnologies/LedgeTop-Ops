using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class WindowsAppReleaseClientTests
{
    private static readonly byte[] Bytes = "Synthetic EXE artifact, never executable or installed.\r\n"u8.ToArray();
    private static string Sha => Convert.ToHexStringLower(SHA256.HashData(Bytes));
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("Windows release fixed source configuration refuses before cached auth", Configuration),
        ("Windows release explicit no-release current and newer states never permit rollback", States),
        ("Windows release authenticated exact bytes stage in owned scope without URL or credential state", Stage),
        ("Windows release fresh authorized cache reuse hashes bytes and preserves foreign or modified files", Cache),
        ("Windows release strict native extension fields types versions paths and bounds fail closed", InvalidMetadata),
        ("Windows release transport statuses UTF8 duplicate keys redirects and body caps fail closed", Transport),
        ("Windows release wrong bytes lengths ETags and redirects never publish installers", InvalidBytes),
        ("Windows release token fences cover metadata body download completion and cached hash handoff", TokenFences),
        ("Windows release cancellation and metadata deadlines never authenticate interactively", Cancellation)
    ];
    private static void Check(bool condition) { if (!condition) throw new Exception("Windows release synthetic assertion failed."); }
    private static async Task Refuse<T>(Func<Task> work) where T : Exception
    { try { await work(); } catch (T) { return; } throw new Exception("Expected Windows release refusal: " + typeof(T).Name); }
    private static Dictionary<string, object?> Offer(string apiBase = "/api/app", string channel = "pilot", string version = "0.6.0.0") => new() {
        ["schemaVersion"] = 1, ["available"] = true, ["platform"] = "windows", ["channel"] = channel,
        ["version"] = version, ["sizeBytes"] = Bytes.Length, ["sha256"] = Sha, ["strongETag"] = "\"actual-immutable-version\"",
        ["sourceCommit"] = new string('b', 40), ["installerType"] = "exe", ["downloadUrl"] = apiBase + "/download/release.exe",
        ["minSupported"] = "Windows 11 x64", ["notes"] = "Synthetic fixture, no live producer."
    };
    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };

    private static async Task Configuration()
    {
        using var f = new Fixture();
        foreach (var origin in new[] { "http://release.example.invalid/", "https://other.example.invalid/", "https://release.example.invalid:443/", "https://release.example.invalid/path", "https://user@release.example.invalid/" })
            await Refuse<ArgumentException>(() => Task.FromResult(new WindowsAppReleaseClient(f.Session, new Uri(origin), "/api/app", "pilot", "0.5.0.0")));
        foreach (var apiBase in new[] { "/api", "/api/app/", "/api/staff/app", "https://other.invalid/api/app" })
            await Refuse<ArgumentException>(() => Task.FromResult(new WindowsAppReleaseClient(f.Session, f.Session.Origin, apiBase, "pilot", "0.5.0.0")));
        await Refuse<ArgumentException>(() => Task.FromResult(new WindowsAppReleaseClient(f.Session, f.Session.Origin, "/api/app", "developer", "0.5.0.0")));
        foreach (var version in new[] { "0.5", "00.5.0.0", "0.5.0.65536", "0.5.0.0 " })
            await Refuse<TransferException>(() => Task.FromResult(new WindowsAppReleaseClient(f.Session, f.Session.Origin, "/api/app", "pilot", version)));
        Check(f.Runner.Reads == 0 && f.Runner.Logins == 0);
    }
    private static async Task States()
    {
        using var f = new Fixture(); using var client = f.Client();
        f.Metadata = () => Json(new { schemaVersion = 1, available = false });
        Check((await client.CheckAsync()).Status == WindowsAppReleaseStatus.NoRelease);
        f.Metadata = () => Json(Offer(version: "0.5.0.0"));
        Check((await client.CheckAsync()).Status == WindowsAppReleaseStatus.Current);
        Check((await client.StageLatestAsync(f.StageRoot)).InstallerPath is null);
        f.Metadata = () => Json(Offer());
        Check((await client.CheckAsync()).Status == WindowsAppReleaseStatus.Available);
        f.Metadata = () => Json(Offer(version: "0.4.65535.65535"));
        await Refuse<TransferException>(() => client.CheckAsync());
        await Refuse<TransferException>(() => client.StageLatestAsync(f.StageRoot));
        Check(f.FileRequests == 0 && !Directory.EnumerateFileSystemEntries(f.StageRoot).Any());
    }
    private static async Task Stage()
    {
        foreach (var apiBase in new[] { "/api/app", "/api/client/app" }) {
            using var f = new Fixture(apiBase); var offer = Offer(apiBase); offer["downloadUrl"] += "?platform=windows&channel=pilot";
            f.Metadata = () => Json(offer); using var client = f.Client();
            var staged = await client.StageLatestAsync(f.StageRoot);
            Check(staged.Check.Status == WindowsAppReleaseStatus.Available && staged.InstallerPath is not null &&
                Path.GetFileName(staged.InstallerPath) == $"LedgeTop-Files-pilot-0.6.0.0-{Sha}.exe" &&
                File.ReadAllBytes(staged.InstallerPath).SequenceEqual(Bytes) && f.MetadataRequests == 1 && f.FileRequests == 1 && f.Runner.Logins == 0);
            var marker = File.ReadAllText(Path.Combine(f.StageRoot, ".ledgetop-app-updates-v1", "owner.json"));
            Check(!marker.Contains("https://", StringComparison.Ordinal) && !marker.Contains(f.Runner.Token, StringComparison.Ordinal) &&
                !marker.Contains(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(f.Runner.Token))), StringComparison.Ordinal));
            foreach (var state in Directory.EnumerateFiles(f.StageRoot, "*.json", SearchOption.AllDirectories))
                Check(!File.ReadAllText(state).Contains("/download/", StringComparison.Ordinal) && !File.ReadAllText(state).Contains(f.Runner.Token, StringComparison.Ordinal));
        }
    }
    private static async Task Cache()
    {
        using (var f = new Fixture()) {
            var arbitrary = Path.Combine(f.StageRoot, "caller-owned.txt"); File.WriteAllText(arbitrary, "preserve");
            using var client = f.Client(); var first = await client.StageLatestAsync(f.StageRoot);
            var second = await client.StageLatestAsync(f.StageRoot);
            Check(first.InstallerPath == second.InstallerPath && f.MetadataRequests == 2 && f.FileRequests == 1);
            File.WriteAllBytes(first.InstallerPath!, new byte[Bytes.Length]);
            await Refuse<TransferException>(() => client.StageLatestAsync(f.StageRoot));
            Check(File.ReadAllBytes(first.InstallerPath!).All(b => b == 0) && f.FileRequests == 1 && File.ReadAllText(arbitrary) == "preserve");
            f.Metadata = () => new(HttpStatusCode.Forbidden);
            await Refuse<AccessDeniedException>(() => client.StageLatestAsync(f.StageRoot)); Check(f.FileRequests == 1);
        }
        using (var f = new Fixture()) {
            var foreign = Path.Combine(f.StageRoot, ".ledgetop-app-updates-v1"); Directory.CreateDirectory(foreign); File.WriteAllText(Path.Combine(foreign, "owner.json"), "foreign");
            using var client = f.Client(); await Refuse<TransferException>(() => client.StageLatestAsync(f.StageRoot));
            Check(f.FileRequests == 0 && File.ReadAllText(Path.Combine(foreign, "owner.json")) == "foreign");
        }
        using (var f = new Fixture()) {
            using (var pilot = f.Client()) await pilot.StageLatestAsync(f.StageRoot);
            f.Metadata = () => Json(Offer(channel: "stable")); using var stable = f.Client(channel: "stable");
            await Refuse<TransferException>(() => stable.StageLatestAsync(f.StageRoot)); Check(f.FileRequests == 1);
        }
    }
    private static async Task InvalidMetadata()
    {
        var changes = new (string Key, object? Value)[] {
            ("schemaVersion", 2), ("available", "true"), ("platform", "linux"), ("channel", "stable"), ("installerType", "msix"),
            ("version", "0.6"), ("version", "0.06.0.0"), ("version", "0.6.0.65536"), ("sizeBytes", 0), ("sizeBytes", -1),
            ("sizeBytes", (1L << 30) + 1), ("sizeBytes", 1.5), ("sha256", Sha.ToUpperInvariant()), ("strongETag", "W/\"weak\""),
            ("strongETag", "*"), ("sourceCommit", new string('B', 40)), ("notes", new string('x', 601)),
            ("downloadUrl", "https://other.invalid/api/app/download/a.exe"), ("downloadUrl", "https://release.example.invalid/api/app/download/a.exe"),
            ("downloadUrl", "/api/client/app/download/a.exe"), ("downloadUrl", "/api/app/download/%2e%2e/a.exe"),
            ("downloadUrl", "/api/app/download/../a.exe"), ("downloadUrl", "/api/app/download/./a.exe"), ("downloadUrl", "/api/app/download//a.exe"),
            ("downloadUrl", "/api/app/download/a.exe#x"), ("downloadUrl", "/api/app/download/a.exe?token=x"),
            ("downloadUrl", "/api/app/download/a.exe?platform=windows&channel=stable"), ("downloadUrl", "/api/app/download/a.exe?platform=windows&channel=pilot&channel=pilot")
        };
        using var f = new Fixture(); using var client = f.Client();
        foreach (var (key, value) in changes) { var offer = Offer(); offer[key] = value; f.Metadata = () => Json(offer); await Refuse<TransferException>(() => client.CheckAsync()); }
        foreach (var key in Offer().Keys) {
            var offer = Offer(); offer[key] = new[] { offer[key] }; f.Metadata = () => Json(offer); await Refuse<TransferException>(() => client.CheckAsync());
        }
        foreach (var key in new[] { "schemaVersion", "strongETag", "sourceCommit", "installerType", "sizeBytes" }) {
            var offer = Offer(); offer.Remove(key); f.Metadata = () => Json(offer); await Refuse<TransferException>(() => client.CheckAsync());
        }
        var ambiguous = Offer(); ambiguous["size"] = Bytes.Length; f.Metadata = () => Json(ambiguous); await Refuse<TransferException>(() => client.CheckAsync());
        f.Metadata = () => Json(new { available = false }); await Refuse<TransferException>(() => client.CheckAsync());
        Check(f.FileRequests == 0 && f.Runner.Logins == 0 && !Directory.EnumerateFileSystemEntries(f.StageRoot).Any());
    }
    private static async Task Transport()
    {
        using var f = new Fixture(); using var client = f.Client();
        foreach (var status in new[] { HttpStatusCode.Redirect, HttpStatusCode.InternalServerError, HttpStatusCode.NoContent }) {
            f.Metadata = () => new(status); await Refuse<TransferException>(() => client.CheckAsync());
        }
        f.Metadata = () => new(HttpStatusCode.Unauthorized); await Refuse<LoginRequiredException>(() => client.CheckAsync());
        f.Metadata = () => new(HttpStatusCode.Forbidden); await Refuse<AccessDeniedException>(() => client.CheckAsync());
        f.Metadata = () => new(HttpStatusCode.NotFound); await Refuse<ResourceUnavailableException>(() => client.CheckAsync());
        foreach (var bytes in new[] { new byte[] { 0xff, 0xfe }, "{\"schemaVersion\":1,\"available\":false,\"available\":false}"u8.ToArray(), Encoding.UTF8.GetBytes(new string(' ', 65537)) }) {
            f.Metadata = () => RawJson(bytes); await Refuse<TransferException>(() => client.CheckAsync());
        }
        f.Metadata = () => RawJson(Encoding.UTF8.GetBytes(new string(' ', 65537)), () => { });
        await Refuse<TransferException>(() => client.CheckAsync()); // Stream without a declared Content-Length must also be bounded.
        f.Metadata = () => { var r = Json(Offer()); r.Content.Headers.ContentEncoding.Add("gzip"); return r; };
        await Refuse<TransferException>(() => client.CheckAsync());
        f.Metadata = () => { var r = Json(Offer()); r.Content.Headers.ContentType!.MediaType = "text/html"; return r; };
        await Refuse<TransferException>(() => client.CheckAsync());
        Check(f.FileRequests == 0 && f.Runner.Logins == 0);
    }
    private static async Task InvalidBytes()
    {
        foreach (var mode in new[] { "corrupt", "short", "etag", "redirect" }) {
            using var f = new Fixture();
            f.Content = () => {
                if (mode == "redirect") return new(HttpStatusCode.Redirect);
                var r = Good(mode == "corrupt" ? new byte[Bytes.Length] : mode == "short" ? Bytes[..^1] : Bytes);
                if (mode == "etag") r.Headers.ETag = EntityTagHeaderValue.Parse("\"different\""); return r;
            };
            using var client = f.Client(); await Refuse<TransferException>(() => client.StageLatestAsync(f.StageRoot));
            Check(!Directory.EnumerateFiles(f.StageRoot, "*.exe", SearchOption.AllDirectories).Any() && f.FileRequests == 1);
        }
    }
    private static async Task TokenFences()
    {
        foreach (var state in new[] { "none", "current", "available" }) {
            using var f = new Fixture();
            var body = JsonSerializer.SerializeToUtf8Bytes(state == "none" ? (object)new { schemaVersion = 1, available = false } : Offer(version: state == "current" ? "0.5.0.0" : "0.6.0.0"));
            f.Metadata = () => RawJson(body, () => f.Runner.Token = Runner.OtherToken);
            using var client = f.Client(); await Refuse<LoginRequiredException>(() => client.CheckAsync()); Check(f.FileRequests == 0);
        }
        using (var f = new Fixture()) {
            f.Metadata = () => RawJson(JsonSerializer.SerializeToUtf8Bytes(Offer()), () => f.Runner.Token = Runner.OtherToken);
            using var client = f.Client(); await Refuse<LoginRequiredException>(() => client.StageLatestAsync(f.StageRoot));
            Check(f.FileRequests == 0 && !Directory.EnumerateFileSystemEntries(f.StageRoot).Any());
        }
        using (var f = new Fixture()) {
            f.Content = () => { var response = Good(Bytes); response.Content = new StreamContent(new ObservedStream(Bytes, () => f.Runner.Token = Runner.OtherToken)); response.Content.Headers.ContentLength = Bytes.Length; return response; };
            using var client = f.Client(); await Refuse<LoginRequiredException>(() => client.StageLatestAsync(f.StageRoot));
            Check(Directory.EnumerateFiles(f.StageRoot, "*.exe", SearchOption.AllDirectories).Count() == 1);
            Check(File.ReadAllBytes(Directory.EnumerateFiles(f.StageRoot, "*.exe", SearchOption.AllDirectories).Single()).SequenceEqual(Bytes));
        }
        using (var f = new Fixture()) {
            using (var initial = f.Client()) await initial.StageLatestAsync(f.StageRoot);
            using var fenced = f.Client(boundary: () => f.Runner.Token = Runner.OtherToken);
            await Refuse<LoginRequiredException>(() => fenced.StageLatestAsync(f.StageRoot)); Check(f.FileRequests == 1);
        }
    }

    internal static async Task RunOfferFixtureAsync(string offerPath, string installerPath)
    {
        // Explicit offline interoperability mode: actual build bytes, fake HTTP and synthetic cached auth.
        var directory = Path.Combine("C:/Users/fstor/.codex/artifacts/LedgeTop-Files-2026-10-25/release-client/interop", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var stage = Path.Combine(directory, "Stage"); Directory.CreateDirectory(stage);
        var offerBytes = await File.ReadAllBytesAsync(offerPath);
        using var document = JsonDocument.Parse(offerBytes);
        var root = document.RootElement;
        var etag = root.GetProperty("strongETag").GetString()!;
        var downloadUrl = root.GetProperty("downloadUrl").GetString()!;
        var expectedSha = root.GetProperty("sha256").GetString()!;
        var expectedSize = root.GetProperty("sizeBytes").GetInt64();
        var helper = Path.Combine(directory, "synthetic-helper-never-executable.bin");
        await File.WriteAllTextAsync(helper, "Synthetic file pin only; helper never executed.");
        var runner = new Runner(); var origin = new Uri("https://updates.example");
        var session = new CloudflareAccessSession(new Uri(origin, "/protected"), helper, Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(helper))), runner);
        var metadataRequests = 0; var contentRequests = 0;
        void Headers(HttpRequestMessage request) => Check(request.Headers.GetValues("Cf-Access-Token").Single() == runner.Token &&
            request.Headers.Authorization is null && !request.Headers.Contains("Cookie") && request.RequestUri!.GetLeftPart(UriPartial.Authority) == "https://updates.example");
        using var client = new WindowsAppReleaseClient(session, origin, "/api/app", "pilot", "0.5.0.0",
            new Handler((request, _) => {
                metadataRequests++; Headers(request);
                Check(request.Method == HttpMethod.Get && request.RequestUri!.PathAndQuery == "/api/app/latest?platform=windows");
                return Task.FromResult(RawJson(offerBytes));
            }), new Downloader(new Handler((request, _) => {
                contentRequests++; Headers(request);
                Check(request.Method == HttpMethod.Get && request.RequestUri!.PathAndQuery == downloadUrl && request.Headers.IfMatch.Single().ToString() == etag);
                var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(File.OpenRead(installerPath)) };
                response.Headers.ETag = EntityTagHeaderValue.Parse(etag); response.Content.Headers.ContentLength = new FileInfo(installerPath).Length;
                return Task.FromResult(response);
            }), [origin], 1L << 30, session));
        var first = await client.StageLatestAsync(stage);
        var second = await client.StageLatestAsync(stage);
        Check(first.InstallerPath is not null && first.InstallerPath == second.InstallerPath &&
            first.Check.Status == WindowsAppReleaseStatus.Available && first.Check.Release!.Version == "0.5.1.0" &&
            metadataRequests == 2 && contentRequests == 1 && runner.Logins == 0 && new FileInfo(first.InstallerPath).Length == expectedSize);
        await using var original = File.OpenRead(installerPath); await using var staged = File.OpenRead(first.InstallerPath!);
        var actualSha = Convert.ToHexStringLower(await SHA256.HashDataAsync(original));
        Check(actualSha == expectedSha && Convert.ToHexStringLower(await SHA256.HashDataAsync(staged)) == expectedSha);
        var receipt = new { schemaVersion = 1, status = "offline_producer_consumer_interop_pass", version = first.Check.Release!.Version,
            sizeBytes = expectedSize, sha256 = actualSha, metadataRequests, contentRequests, cachedHelperReads = runner.Reads,
            interactiveLogins = runner.Logins, networkRequests = 0, executed = false, installed = false };
        await File.WriteAllBytesAsync(Path.Combine(directory, "receipt.json"), JsonSerializer.SerializeToUtf8Bytes(receipt));
        Console.WriteLine("PASS Windows release offline producer/consumer bytes and fresh-authorized cache reuse");
        Console.WriteLine(Path.Combine(directory, "receipt.json"));
    }
    private static async Task Cancellation()
    {
        using (var f = new Fixture()) {
            using var client = f.Client(); using var ct = new CancellationTokenSource(); ct.Cancel();
            await Refuse<OperationCanceledException>(() => client.StageLatestAsync(f.StageRoot, ct.Token)); Check(f.Runner.Reads == 0);
        }
        using (var f = new Fixture()) {
            f.MetadataWork = async token => { await Task.Delay(Timeout.Infinite, token); return Json(Offer()); };
            using var client = f.Client(timeout: TimeSpan.FromMilliseconds(30));
            await Refuse<TransferException>(() => client.CheckAsync()); Check(f.FileRequests == 0);
        }
        using (var f = new Fixture()) {
            f.MetadataWork = async token => { await Task.Delay(Timeout.Infinite, token); return Json(Offer()); };
            using var client = f.Client(); using var ct = new CancellationTokenSource(30);
            await Refuse<OperationCanceledException>(() => client.StageLatestAsync(f.StageRoot, ct.Token)); Check(f.Runner.Logins == 0 && f.FileRequests == 0);
        }
        using (var f = new Fixture()) {
            using var ct = new CancellationTokenSource();
            f.Content = () => { var response = Good(Bytes); response.Content = new StreamContent(new ObservedStream(Bytes, ct.Cancel)); response.Content.Headers.ContentLength = Bytes.Length; return response; };
            using var client = f.Client(); await Refuse<OperationCanceledException>(() => client.StageLatestAsync(f.StageRoot, ct.Token));
            Check(f.FileRequests == 1 && !Directory.EnumerateFiles(f.StageRoot, "*.exe", SearchOption.AllDirectories).Any());
        }
    }

    private static HttpResponseMessage RawJson(byte[] bytes, Action? body = null)
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = body is null ? new ByteArrayContent(bytes) : new StreamContent(new ObservedStream(bytes, body)) };
        response.Content.Headers.ContentType = new("application/json") { CharSet = "utf-8" }; return response;
    }
    private static HttpResponseMessage Good(byte[] bytes)
    { var r = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }; r.Headers.ETag = EntityTagHeaderValue.Parse("\"actual-immutable-version\""); return r; }
    private sealed class ObservedStream(byte[] bytes, Action boundary) : MemoryStream(bytes, false)
    {
        private bool observed;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { var read = base.ReadAsync(buffer, cancellationToken); if (!observed) { observed = true; boundary(); } return read; }
    }
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> action) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => action(request, token); }
    private sealed class Runner : IAccessCommandRunner
    {
        internal static string OtherToken => Jwt(DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 7200);
        internal string Token = Jwt(DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600);
        internal int Reads, Logins;
        public Task<AccessCommandResult> RunAsync(string binaryPath, IReadOnlyList<string> arguments, CancellationToken token)
        { token.ThrowIfCancellationRequested(); if (arguments[1] != "token") { Logins++; throw new Exception("Release client cannot start interactive login."); } Reads++; return Task.FromResult(new AccessCommandResult(0, Token, "")); }
        private static string Jwt(long expiry) => "e30." + Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(new { exp = expiry })).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".c3ludGhldGlj";
    }
    private sealed class Fixture : IDisposable
    {
        private readonly string root = Path.Combine("C:/Users/fstor/.codex/artifacts/LedgeTop-Files-2026-10-25/release-client/fixtures", Guid.NewGuid().ToString("N"));
        private readonly string apiBase;
        internal string StageRoot => Path.Combine(root, "Stage");
        internal Runner Runner = new();
        internal CloudflareAccessSession Session { get; }
        internal int MetadataRequests, FileRequests;
        internal Func<HttpResponseMessage> Metadata, Content = () => Good(Bytes);
        internal Func<CancellationToken, Task<HttpResponseMessage>>? MetadataWork;
        internal Fixture(string apiBase = "/api/app")
        {
            this.apiBase = apiBase; Directory.CreateDirectory(StageRoot);
            var binary = Path.Combine(root, "synthetic-helper-never-executable.bin"); File.WriteAllText(binary, "Synthetic file pin only; helper never executed.");
            Session = new(new Uri("https://release.example.invalid/protected"), binary, Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(binary))), Runner);
            Metadata = () => Json(Offer(apiBase));
        }
        internal WindowsAppReleaseClient Client(string channel = "pilot", TimeSpan? timeout = null, Action? boundary = null) => new(Session, Session.Origin, apiBase, channel, "0.5.0.0",
            new Handler(async (request, token) => {
                MetadataRequests++;
                Check(request.Method == HttpMethod.Get && request.RequestUri!.PathAndQuery == apiBase + "/latest?platform=windows");
                Headers(request); return MetadataWork is null ? Metadata() : await MetadataWork(token);
            }), new Downloader(new Handler((request, _) => {
                FileRequests++; Check(request.RequestUri!.AbsolutePath.StartsWith(apiBase + "/download/", StringComparison.Ordinal));
                Check(request.Headers.IfMatch.Single().ToString() == "\"actual-immutable-version\""); Headers(request); return Task.FromResult(Content());
            }), [Session.Origin], 1L << 30, Session), timeout, boundary);
        private void Headers(HttpRequestMessage request)
        { Check(request.RequestUri!.Host == "release.example.invalid" && request.Headers.GetValues("Cf-Access-Token").Single() == Runner.Token && !request.Headers.Contains("Cookie") && request.Headers.Authorization is null); }
        public void Dispose() { Check(Runner.Logins == 0); /* Retain synthetic source/evidence only inside the requested release-client folder. */ }
    }
}
