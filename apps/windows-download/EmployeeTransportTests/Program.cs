// Opt-in loopback acceptance only. No credentials, trust-store changes or live endpoints.
using System.Net;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using LedgeTop.WindowsDownload;

if (args.Length != 2) throw new ArgumentException("Expected --certificate or --run and one owned temporary path.");
if (args[0] == "--certificate") {
    using var key = RSA.Create(2048);
    var request = new CertificateRequest("CN=synthetic-loopback-only", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    var san = new SubjectAlternativeNameBuilder(); san.AddIpAddress(IPAddress.Loopback);
    request.CertificateExtensions.Add(san.Build());
    using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddMinutes(20));
    File.WriteAllText(Path.Combine(args[1], "certificate.pem"), certificate.ExportCertificatePem());
    File.WriteAllText(Path.Combine(args[1], "key.pem"), key.ExportPkcs8PrivateKeyPem());
    return;
}
if (args[0] != "--run") throw new ArgumentException("Unknown mode.");
var config = JsonSerializer.Deserialize<Configuration>(File.ReadAllText(args[1])) ?? throw new Exception("Missing fixture.");
var origin = new Uri(config.Origin);
if (origin.Scheme != "https" || origin.Host != "127.0.0.1" || origin.Port < 1024 || origin.AbsolutePath != "/")
    throw new Exception("Only loopback TLS is permitted by this harness.");
using var certificatePin = X509CertificateLoader.LoadCertificateFromFile(config.Certificate);
var pin = certificatePin.GetCertHashString(HashAlgorithmName.SHA256);
HttpClientHandler Handler(string? expected = null) => new() {
    AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false, AutomaticDecompression = DecompressionMethods.None,
    ServerCertificateCustomValidationCallback = (message, cert, _, errors) => message.RequestUri?.GetLeftPart(UriPartial.Authority) == origin.GetLeftPart(UriPartial.Authority)
        && cert is not null && cert.GetCertHashString(HashAlgorithmName.SHA256) == (expected ?? pin)
        && (errors & SslPolicyErrors.RemoteCertificateNameMismatch) == 0
};
using (var wrongPin = new HttpClient(Handler(new string('0', 64)))) {
    try { await wrongPin.GetAsync(new Uri(origin, "/")); throw new Exception("Wrong TLS pin was accepted."); }
    catch (HttpRequestException) { }
}
var dummy = Path.Combine(config.Output, "synthetic-helper.bin");
File.WriteAllText(dummy, "This is a synthetic test marker, never executed.");
var session = new CloudflareAccessSession(new Uri(origin, "/portal/"), dummy,
    Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(dummy))), new SyntheticTokenRunner(config.Token));
using var employee = new EmployeeClient(Handler(), session);
var roots = await employee.GetRootsAsync();
Assert(roots.Count == 1 && roots[0].RootId == config.RootId, "Expected exact provisioned employee root.");
var entries = await employee.GetEntriesAsync(config.RootId);
Assert(entries.Entries.Count == 1 && entries.Entries[0].Name == "map.bin", "Actual gateway directory differs.");
var manifest = await employee.GetDownloadManifestAsync(config.RootId, "map.bin");
Assert(manifest.Length == 2 * 1024 * 1024 && manifest.Sha256 == config.Sha256, "Gateway manifest digest differs.");
var destination = Path.Combine(config.Output, "resumed"); Directory.CreateDirectory(destination);
using (var first = new Downloader(Handler(), [origin], session: session)) {
    try { await first.DownloadAsync(manifest, destination); throw new Exception("Interrupted transport unexpectedly completed."); }
    catch (TransferException) { }
}
Assert(!File.Exists(Path.Combine(destination, "map.bin")), "Interrupted bytes were published.");
var partial = Directory.GetFiles(destination, "*.part", SearchOption.AllDirectories).Single();
var retained = new FileInfo(partial).Length;
Assert(retained > 0 && retained < manifest.Length, "No real network prefix was retained.");
using (var resumed = new Downloader(Handler(), [origin], session: session)) {
    var result = await resumed.DownloadAsync(manifest, destination);
    Assert(Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(result))) == config.Sha256, "Resumed file digest differs.");
}
using var raw = new HttpClient(Handler());
async Task<HttpResponseMessage> Read(Uri uri, string assertion, string? etag = null) {
    using var request = new HttpRequestMessage(HttpMethod.Get, uri);
    request.Headers.Add("Cf-Access-Token", assertion);
    if (etag is not null) request.Headers.Add("If-Match", etag);
    return await raw.SendAsync(request);
}
using (var other = await Read(manifest.ContentUri, config.OtherToken, manifest.ETag))
    Assert(other.StatusCode == HttpStatusCode.Forbidden, "Another admitted user reused this handle.");
using (var traversal = await Read(new Uri(origin, "/api/staff/files/roots/" + config.RootId + "/manifest?path=..%2Foutside.bin"), config.Token))
    Assert(traversal.StatusCode == HttpStatusCode.BadRequest, "Traversal reached source.");
async Task Control(string path) {
    using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/__lab/" + path));
    request.Headers.Add("X-Local-Lab-Token", config.ControlToken);
    using var response = await raw.SendAsync(request);
    Assert(response.StatusCode == HttpStatusCode.OK, "Synthetic control failed.");
}
await Control("mutate");
var newer = await employee.GetDownloadManifestAsync(config.RootId, "map.bin");
Assert(newer.Length == manifest.Length && newer.Sha256 != manifest.Sha256, "Actual same-size source mutation did not change manifest.");
using (var stale = await Read(newer.ContentUri, config.Token, manifest.ETag))
    Assert(stale.StatusCode == HttpStatusCode.PreconditionFailed, "Stale version precondition was accepted.");
await Control("revoke");
var deniedDirectory = Path.Combine(config.Output, "revoked"); Directory.CreateDirectory(deniedDirectory);
using (var denied = new Downloader(Handler(), [origin], session: session)) {
    var refused = false;
    try { await denied.DownloadAsync(newer, deniedDirectory); }
    catch (Exception e) when (e is TransferException or AccessDeniedException or ResourceUnavailableException) { refused = true; }
    Assert(refused && !File.Exists(Path.Combine(deniedDirectory, "map.bin")), "Saved handle bypassed real grant revocation.");
}
Console.WriteLine(JsonSerializer.Serialize(new { kind = "local-employee-transport-v1", bytes = manifest.Length, sha256 = config.Sha256,
    retainedPrefixBytes = retained, tlsPinRejected = true, rootsAndListingParsed = true, resumedDigestVerified = true,
    crossUserDenied = true, traversalDenied = true, staleVersionRejected = true, revokedHandleDenied = true }));
static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
sealed record Configuration(string Origin, string Certificate, string Output, string Token, string Sha256, string ControlToken, string RootId, string OtherToken);
sealed class SyntheticTokenRunner(string token) : IAccessCommandRunner {
    public Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> arguments, CancellationToken cancellationToken) {
        if (arguments.Count != 4 || arguments[0] != "access" || arguments[1] != "token" || arguments[2] != "--app")
            throw new Exception("This harness never performs interactive login or executes a helper.");
        return Task.FromResult(new AccessCommandResult(0, token, ""));
    }
}
