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
using (var unsigned = new HttpClient(Handler())) {
    var parts = config.Token.Split('.'); parts[2] = (parts[2][0] == 'A' ? "B" : "A") + parts[2][1..];
    using var invalid = new HttpRequestMessage(HttpMethod.Get, new Uri(origin, "/api/client/operations/data/windows-catalog/deliveries"));
    invalid.Headers.Add("Cf-Access-Token", string.Join('.', parts));
    using var result = await unsigned.SendAsync(invalid);
    Assert(result.StatusCode == HttpStatusCode.Unauthorized, "Invalid RS256 signature was accepted.");
}
var dummy = Path.Combine(config.Output, "synthetic-helper.bin");
File.WriteAllText(dummy, "This is a synthetic test marker, never executed.");
var session = new CloudflareAccessSession(new Uri(origin, "/portal/"), dummy,
    Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(dummy))), new SyntheticTokenRunner(config.Token));
using var portal = new PortalClient(Handler(), session);
var deliveries = await portal.GetDeliveriesAsync();
Assert(deliveries.Items.Count == 1, "Expected only one explicitly provisioned synthetic delivery.");
var folder = await portal.GetFolderAsync(deliveries.Items.Single().Handle);
Assert(folder.Files.Count == 1 && folder.Files[0].Name == "map.bin", "Actual catalog did not return the seeded R2 file.");
var manifest = await portal.GetDownloadManifestAsync(folder.Files.Single().Handle);
Assert(manifest.Length == 2 * 1024 * 1024 && manifest.Sha256 == config.Sha256, "Worker manifest differs from fixture digest.");
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
using var admin = new HttpClient(Handler());
using var revoke = new HttpRequestMessage(HttpMethod.Post, new Uri(origin, "/__lab/revoke"));
revoke.Headers.Add("X-Local-Lab-Token", config.ControlToken);
using var revoked = await admin.SendAsync(revoke);
Assert(revoked.StatusCode == HttpStatusCode.OK, "Real D1 revoke command failed.");
var deniedDirectory = Path.Combine(config.Output, "revoked"); Directory.CreateDirectory(deniedDirectory);
using (var denied = new Downloader(Handler(), [origin], session: session)) {
    var refused = false;
    try { await denied.DownloadAsync(manifest, deniedDirectory); }
    catch (Exception e) when (e is TransferException or AccessDeniedException or ResourceUnavailableException) { refused = true; }
    Assert(refused && !File.Exists(Path.Combine(deniedDirectory, "map.bin")), "Saved handle bypassed D1 revocation.");
}
Console.WriteLine(JsonSerializer.Serialize(new { kind = "local-client-transport-v1", bytes = manifest.Length, sha256 = config.Sha256,
    retainedPrefixBytes = retained, tlsPinRejected = true, invalidSignatureRejected = true, catalogParsed = true, resumedDigestVerified = true, revokedHandleDenied = true }));
static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
sealed record Configuration(string Origin, string Certificate, string Output, string Token, string Sha256, string ControlToken);
sealed class SyntheticTokenRunner(string token) : IAccessCommandRunner {
    public Task<AccessCommandResult> RunAsync(string path, IReadOnlyList<string> arguments, CancellationToken cancellationToken) {
        if (arguments.Count != 4 || arguments[0] != "access" || arguments[1] != "token" || arguments[2] != "--app")
            throw new Exception("This harness never performs interactive login or executes a helper.");
        return Task.FromResult(new AccessCommandResult(0, token, ""));
    }
}
