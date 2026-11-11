using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

/// <summary>A bound selector comparison, never permission to read, adopt bytes or change a placeholder.
/// SessionBindingSha256 is an opaque server audit coordinate, not a client-verified session identity.
/// Callers still need fresh principal/Resolve checks, complete content verification and local ownership.</summary>
internal sealed record EmployeeReferenceSelectorMatch(string OldReferenceSha256, string NewReferenceSha256,
    string RequestNonceSha256, string SessionBindingSha256);

/// <summary>Explicit, employee-only counterpart to the version2 reference preview contract.
/// There is intentionally no App callsite or denied-Resolve fallback. Construction performs no IO.
/// Only exact successful selector comparisons are returned; the server's content/access claims must remain false.</summary>
internal sealed class EmployeeReferenceTransitionPreviewClient : IDisposable
{
    // Separate prefix preserves the legacy queue router's GET-only middleware.
    private const string Path = "/api/staff/files/reference-transition/v1/preview";
    private const int Limit = 8192;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly string[] MatchFields = ["samePrincipal", "sameGateway", "sameRoot", "sameRootGeneration",
        "sameRootFingerprint", "sameStaff", "sameAccessSubject", "sameAdmissionVersion", "sameCanonicalPath",
        "oldLogicalIdMatchesCurrentContext", "newGrantCurrent", "newGrantMatchesReference", "rootMetadataMatches", "newGrantRechecked"];
    private readonly CloudflareAccessSession session;
    private readonly HttpClient client;
    private readonly Func<string> createNonce;

    internal EmployeeReferenceTransitionPreviewClient(CloudflareAccessSession session) : this(session,
        new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false,
            Credentials = null, AutomaticDecompression = DecompressionMethods.None, CheckCertificateRevocationList = true }) { }

    internal EmployeeReferenceTransitionPreviewClient(CloudflareAccessSession session, HttpMessageHandler handler,
        Func<string>? createNonce = null)
    {
        this.session = session;
        client = new HttpClient(handler, true) { Timeout = Timeout.InfiniteTimeSpan };
        this.createNonce = createNonce ?? (() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_'));
    }

    internal async Task<EmployeeReferenceSelectorMatch> CompareSelectorsAsync(string oldResourceReference,
        string newResourceReference, string oldLogicalFileId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Reference(oldResourceReference); Reference(newResourceReference);
        if (oldLogicalFileId is null || !Regex.IsMatch(oldLogicalFileId, "\\Aoef1_[a-f0-9]{64}\\z")) throw Invalid();
        var nonce = createNonce();
        if (nonce is null || !Regex.IsMatch(nonce, "\\A[A-Za-z0-9_-]{16,128}\\z")) throw Invalid();
        var oldHash = Sha(oldResourceReference); var newHash = Sha(newResourceReference); var nonceHash = Sha(nonce);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(60));
        try {
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(session.Origin, Path));
            request.Headers.Accept.ParseAdd("application/json"); request.Headers.AcceptEncoding.ParseAdd("identity");
            request.Headers.Add("Origin", session.Origin.GetLeftPart(UriPartial.Authority));
            request.Headers.Add("Cf-Access-Token", await session.GetTokenAsync(deadline.Token));
            request.Content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(new {
                schemaVersion = 2, oldResourceRef = oldResourceReference, newResourceRef = newResourceReference,
                oldLogicalFileId, requestNonce = nonce
            }));
            request.Content.Headers.ContentType = new("application/json");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (response.StatusCode == HttpStatusCode.Unauthorized) throw new LoginRequiredException();
            if (response.StatusCode == HttpStatusCode.Forbidden) throw new AccessDeniedException();
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Conflict) throw new ResourceUnavailableException();
            if ((int)response.StatusCode is < 100 or > 599) throw Invalid();
            if (response.StatusCode != HttpStatusCode.OK)
                throw new TransferException("The employee reference check returned an unexpected HTTP status.",
                    TransferFailureReason.UnexpectedHttpStatus, (int)response.StatusCode);
            var type = response.Content.Headers.ContentType;
            if (type?.MediaType != "application/json" ||
                type.CharSet is not null && !type.CharSet.Trim('"').Equals("utf-8", StringComparison.OrdinalIgnoreCase) ||
                response.Content.Headers.ContentEncoding.Count != 0 || response.Content.Headers.ContentLength > Limit) throw Invalid();
            using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var output = new MemoryStream(); var buffer = new byte[2048];
            while (true) {
                var count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, Limit + 1 - (int)output.Length)), deadline.Token);
                if (count == 0) break;
                output.Write(buffer, 0, count); if (output.Length > Limit) throw Invalid();
            }
            deadline.Token.ThrowIfCancellationRequested();
            using var json = JsonDocument.Parse(StrictUtf8.GetString(output.ToArray()), new JsonDocumentOptions { MaxDepth = 8 });
            var root = json.RootElement;
            Exact(root, "schemaVersion", "previewOnly", "contentContinuityVerified", "accessGranted", "fileBytesFetched",
                "identityContinuityMatched", "matches", "bindings");
            if (root.GetProperty("schemaVersion").GetRawText() != "2") throw Invalid();
            Flag(root, "previewOnly", true); Flag(root, "contentContinuityVerified", false);
            Flag(root, "accessGranted", false); Flag(root, "fileBytesFetched", false); Flag(root, "identityContinuityMatched", true);
            var matches = root.GetProperty("matches"); Exact(matches, MatchFields);
            foreach (var field in MatchFields) Flag(matches, field, true);
            var bindings = root.GetProperty("bindings");
            Exact(bindings, "oldReferenceSHA256", "newReferenceSHA256", "sessionBindingSHA256", "requestNonceSHA256");
            if (Hash(bindings, "oldReferenceSHA256") != oldHash || Hash(bindings, "newReferenceSHA256") != newHash ||
                Hash(bindings, "requestNonceSHA256") != nonceHash) throw Invalid();
            var sessionBinding = Hash(bindings, "sessionBindingSHA256");
            deadline.Token.ThrowIfCancellationRequested();
            return new(oldHash, newHash, nonceHash, sessionBinding);
        } catch (HttpRequestException) { throw new TransferException("The employee reference check could not be completed.", TransferFailureReason.Network); }
        catch (IOException) { throw new TransferException("The employee reference response could not be read.", TransferFailureReason.ResponseRead); }
        catch (Exception error) when (error is JsonException or DecoderFallbackException or InvalidOperationException or KeyNotFoundException or FormatException or OverflowException) { throw Invalid(); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) {
            throw new TransferException("The employee reference check timed out.", TransferFailureReason.Timeout);
        }
    }

    private static void Exact(JsonElement value, params string[] fields)
    {
        // Comparing the complete property multiset rejects duplicates as well as missing/unknown fields.
        if (value.ValueKind != JsonValueKind.Object ||
            !value.EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal).SequenceEqual(fields.Order(StringComparer.Ordinal))) throw Invalid();
    }
    private static void Flag(JsonElement value, string field, bool expected)
    {
        if (value.GetProperty(field).ValueKind != (expected ? JsonValueKind.True : JsonValueKind.False)) throw Invalid();
    }
    private static string Hash(JsonElement value, string field)
    {
        var text = value.GetProperty(field).GetString();
        if (text is null || !Regex.IsMatch(text, "\\A[a-f0-9]{64}\\z")) throw Invalid(); return text;
    }
    private static void Reference(string value)
    {
        if (value is null || value.Length > 16384 || !Regex.IsMatch(value, "\\Aodqr1_[A-Za-z0-9_-]+\\z")) throw Invalid();
    }
    private static string Sha(string value) => Convert.ToHexStringLower(SHA256.HashData(StrictUtf8.GetBytes(value)));
    private static TransferException Invalid() => new("The employee reference check returned unsupported metadata.", TransferFailureReason.InvalidMetadata);
    public void Dispose() => client.Dispose();
}
