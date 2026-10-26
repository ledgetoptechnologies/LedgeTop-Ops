using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LedgeTop.WindowsDownload;

public enum WindowsAppReleaseStatus { NoRelease, Current, Available }
public sealed record WindowsAppReleasePins(string Channel, string Version, long SizeBytes, string Sha256,
    string StrongETag, string SourceCommit, string InstallerType);
public sealed record WindowsAppReleaseCheck(WindowsAppReleaseStatus Status, string CurrentVersion, WindowsAppReleasePins? Release = null);
public sealed record WindowsAppReleaseStage(WindowsAppReleaseCheck Check, string? InstallerPath = null);

/// <summary>
/// Cached-authentication release check and verified staging only; never signs in, executes or installs.
/// The flat schema1 Windows extension requires strongETag/sourceCommit/installerType in addition to
/// the shared web DTO. That producer contract is proposed, not evidence a server route is deployed.
/// Failures throw sanitized typed exceptions; only explicit available:false means NoRelease.
/// </summary>
public sealed class WindowsAppReleaseClient : IDisposable
{
    private const int MetadataLimit = 64 * 1024;
    private const long MaximumInstallerBytes = 1L << 30;
    private const string StageNamespace = ".ledgetop-app-updates-v1";
    private readonly CloudflareAccessSession session;
    private readonly Uri origin;
    private readonly string apiBase, channel, currentText;
    private readonly Version current;
    private readonly HttpClient metadata;
    private readonly Downloader downloader;
    private readonly TimeSpan metadataTimeout;
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly byte[] stageMarker;
    private readonly Action? verifiedArtifactBoundary;
    private sealed record Configuration(CloudflareAccessSession Session, Uri Origin, string ApiBase, string Channel, string CurrentText, Version Current);
    private sealed record Offer(WindowsAppReleaseCheck Check, Uri? ContentUri);
    private sealed record Marker(int Schema, string Owner, string Channel, string OriginSha256);

    public WindowsAppReleaseClient(CloudflareAccessSession session, Uri origin, string apiBase, string expectedChannel, string currentVersion)
        : this(Configure(session, origin, apiBase, expectedChannel, currentVersion), Transport(),
            new Downloader(session, MaximumInstallerBytes), TimeSpan.FromSeconds(60), null) { }

    internal WindowsAppReleaseClient(CloudflareAccessSession session, Uri origin, string apiBase, string expectedChannel,
        string currentVersion, HttpMessageHandler metadataHandler, Downloader downloader, TimeSpan? metadataTimeout = null,
        Action? verifiedArtifactBoundary = null)
        : this(Configure(session, origin, apiBase, expectedChannel, currentVersion), metadataHandler, downloader,
            metadataTimeout ?? TimeSpan.FromSeconds(60), verifiedArtifactBoundary) { }

    private WindowsAppReleaseClient(Configuration config, HttpMessageHandler handler, Downloader downloader, TimeSpan timeout, Action? verifiedArtifactBoundary)
    {
        if (timeout < TimeSpan.FromMilliseconds(1) || timeout > TimeSpan.FromMinutes(2)) throw new ArgumentOutOfRangeException(nameof(timeout));
        session = config.Session; origin = config.Origin; apiBase = config.ApiBase; channel = config.Channel;
        currentText = config.CurrentText; current = config.Current; this.downloader = downloader; metadataTimeout = timeout;
        metadata = new HttpClient(handler, true) { Timeout = Timeout.InfiniteTimeSpan };
        this.verifiedArtifactBoundary = verifiedArtifactBoundary; // Synthetic boundary observer only; public construction cannot inject it.
        stageMarker = JsonSerializer.SerializeToUtf8Bytes(new Marker(1, "LedgeTop.WindowsAppReleaseStage/1", channel,
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(origin.GetLeftPart(UriPartial.Authority))))));
    }

    private static HttpMessageHandler Transport() => new HttpClientHandler {
        AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false, Credentials = null,
        AutomaticDecompression = DecompressionMethods.None, CheckCertificateRevocationList = true
    };

    private static Configuration Configure(CloudflareAccessSession session, Uri origin, string apiBase, string channel, string current)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (origin is null || !origin.IsAbsoluteUri || origin.Scheme != "https" || origin.UserInfo.Length != 0 ||
            origin.Query.Length != 0 || origin.Fragment.Length != 0 || origin.AbsolutePath != "/" || !origin.IsDefaultPort ||
            origin.GetLeftPart(UriPartial.Authority) != session.Origin.GetLeftPart(UriPartial.Authority) ||
            origin.OriginalString != origin.GetLeftPart(UriPartial.Authority) && origin.OriginalString != origin.GetLeftPart(UriPartial.Authority) + "/" ||
            apiBase is not ("/api/app" or "/api/client/app") || channel is not ("pilot" or "stable"))
            throw new ArgumentException("A fixed session-bound HTTPS origin, explicit app API base and release channel are required.");
        return new(session, origin, apiBase, channel, current, ParseVersion(current));
    }

    public async Task<WindowsAppReleaseCheck> CheckAsync(CancellationToken cancellationToken = default)
    {
        await operations.WaitAsync(cancellationToken).ConfigureAwait(false);
        try {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(metadataTimeout);
            try {
                using var pin = await session.PinCachedTokenAsync(deadline.Token).ConfigureAwait(false);
                var offer = await ReadLatestAsync(deadline.Token).ConfigureAwait(false);
                _ = await session.GetTokenAsync(deadline.Token).ConfigureAwait(false);
                return offer.Check;
            } catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw TimeoutError(); }
            catch (Exception error) when (Sanitize(error)) { throw Invalid(); }
        } finally { operations.Release(); }
    }

    public async Task<WindowsAppReleaseStage> StageLatestAsync(string existingDedicatedRoot,
        CancellationToken cancellationToken = default, IProgress<DownloadProgress>? progress = null)
    {
        // Refuse aliases before authentication or any app-owned directory write.
        string root;
        try { root = StagingRoot(existingDedicatedRoot); }
        catch (Exception error) when (Sanitize(error)) { throw Invalid(); }
        await operations.WaitAsync(cancellationToken).ConfigureAwait(false);
        try {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(metadataTimeout);
            try {
                using var pin = await session.PinCachedTokenAsync(deadline.Token).ConfigureAwait(false);
                var offer = await ReadLatestAsync(deadline.Token).ConfigureAwait(false);
                _ = await session.GetTokenAsync(deadline.Token).ConfigureAwait(false);
                deadline.CancelAfter(Timeout.InfiniteTimeSpan);
                if (offer.Check.Status != WindowsAppReleaseStatus.Available) return new(offer.Check);
                var release = offer.Check.Release!;
                var owned = OwnedStage(root);
                var basename = $"LedgeTop-Files-{channel}-{release.Version}-{release.Sha256}.exe";
                var target = Path.Combine(owned, basename);
                CheckAliases(target, allowMissingLeaf: true);
                if (Directory.Exists(target)) throw Invalid();
                if (File.Exists(target)) {
                    await VerifyExistingAsync(target, release, cancellationToken).ConfigureAwait(false);
                    verifiedArtifactBoundary?.Invoke();
                    _ = await session.GetTokenAsync(cancellationToken).ConfigureAwait(false);
                    return new(offer.Check, target);
                }
                var spec = new DownloadSpec($"WindowsAppRelease/1:{origin.GetLeftPart(UriPartial.Authority)}:{apiBase}:{channel}:{release.Version}:{release.Sha256}",
                    offer.ContentUri!, basename, release.SizeBytes, release.StrongETag, release.Sha256);
                var staged = await downloader.DownloadAsync(spec, owned, cancellationToken, progress).ConfigureAwait(false);
                verifiedArtifactBoundary?.Invoke();
                _ = await session.GetTokenAsync(cancellationToken).ConfigureAwait(false);
                return new(offer.Check, staged);
            } catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { throw TimeoutError(); }
            catch (Exception error) when (Sanitize(error)) { throw Invalid(); }
        } finally { operations.Release(); }
    }

    private async Task<Offer> ReadLatestAsync(CancellationToken token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(origin,
            apiBase + "/latest?platform=windows&channel=" + channel + "&schemaVersion=1"));
        request.Headers.Accept.ParseAdd("application/json"); request.Headers.AcceptEncoding.ParseAdd("identity");
        request.Headers.Add("Cf-Access-Token", await session.GetTokenAsync(token).ConfigureAwait(false));
        using var response = await metadata.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.Unauthorized) throw new LoginRequiredException();
        if (response.StatusCode == HttpStatusCode.Forbidden) throw new AccessDeniedException();
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Conflict) throw new ResourceUnavailableException();
        var type = response.Content.Headers.ContentType;
        if (response.StatusCode != HttpStatusCode.OK || type?.MediaType != "application/json" ||
            type.CharSet is not null && !type.CharSet.Trim('"').Equals("utf-8", StringComparison.OrdinalIgnoreCase) ||
            response.Content.Headers.ContentEncoding.Count != 0 || response.Content.Headers.ContentLength > MetadataLimit) throw Invalid();
        await using var input = await response.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
        using var output = new MemoryStream(); var buffer = new byte[8192];
        while (true) {
            var read = await input.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, MetadataLimit + 1 - (int)output.Length)), token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (read == 0) break;
            output.Write(buffer, 0, read); if (output.Length > MetadataLimit) throw Invalid();
        }
        token.ThrowIfCancellationRequested();
        using var document = JsonDocument.Parse(new UTF8Encoding(false, true).GetString(output.ToArray()), new JsonDocumentOptions { MaxDepth = 8 });
        var root = document.RootElement; Unique(root);
        if (root.ValueKind != JsonValueKind.Object || root.GetProperty("schemaVersion").GetRawText() != "1") throw Invalid();
        var available = root.GetProperty("available");
        if (available.ValueKind == JsonValueKind.False) {
            Exact(root, ["schemaVersion", "available"], []);
            return new(new(WindowsAppReleaseStatus.NoRelease, currentText), null);
        }
        if (available.ValueKind != JsonValueKind.True) throw Invalid();
        Exact(root, ["schemaVersion", "available", "platform", "channel", "version", "sizeBytes", "sha256", "strongETag", "sourceCommit", "installerType", "downloadUrl"], ["minSupported", "notes"]);
        if (Text(root, "platform", 16) != "windows" || Text(root, "channel", 6) != channel || Text(root, "installerType", 8) != "exe") throw Invalid();
        var versionText = Text(root, "version", 23); var version = ParseVersion(versionText);
        if (version < current) throw new TransferException("The release feed offered an older version; downgrades are refused.");
        var sha = Text(root, "sha256", 64); var commit = Text(root, "sourceCommit", 40); var etag = Text(root, "strongETag", 512);
        if (!Regex.IsMatch(sha, "\\A[0-9a-f]{64}\\z") || !Regex.IsMatch(commit, "\\A[0-9a-f]{40}\\z") ||
            !Regex.IsMatch(etag, "\\A\"[\\x21\\x23-\\x7e]+\"\\z") || !EntityTagHeaderValue.TryParse(etag, out var parsedETag) || parsedETag.IsWeak || parsedETag.Tag == "*" || parsedETag.ToString() != etag ||
            !root.GetProperty("sizeBytes").TryGetInt64(out var length) || length is <= 0 or > MaximumInstallerBytes) throw Invalid();
        if (root.TryGetProperty("minSupported", out _)) _ = Text(root, "minSupported", 120);
        if (root.TryGetProperty("notes", out _)) _ = Text(root, "notes", 600);
        var path = Text(root, "downloadUrl", 512);
        var split = path.Split('?');
        if (split.Length > 2 || split.Length == 2 && split[1] != $"platform=windows&channel={channel}" ||
            !split[0].StartsWith(apiBase + "/download/", StringComparison.Ordinal) || split[0].Contains("..", StringComparison.Ordinal) || split[0].Contains("//", StringComparison.Ordinal) ||
            !Regex.IsMatch(split[0], "\\A/[A-Za-z0-9._~/-]+\\z") || split[0].EndsWith('/') || split[0].Split('/').Skip(1).Any(segment => segment == ".")) throw Invalid();
        var uri = new Uri(origin, path);
        if (uri.GetLeftPart(UriPartial.Authority) != origin.GetLeftPart(UriPartial.Authority) || uri.PathAndQuery != path) throw Invalid();
        return new(new(version == current ? WindowsAppReleaseStatus.Current : WindowsAppReleaseStatus.Available, currentText,
            new(channel, versionText, length, sha, etag, commit, "exe")), uri);
    }

    private string OwnedStage(string root)
    {
        var path = Path.Combine(root, StageNamespace); CheckAliases(path, true);
        if (!Directory.Exists(path)) {
            if (File.Exists(path)) throw Invalid();
            var temporary = Path.Combine(root, ".ledgetop-app-updates-create-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporary); CheckAliases(temporary, false);
            using (var output = new FileStream(Path.Combine(temporary, "owner.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
                output.Write(stageMarker); output.Flush(true);
            }
            Directory.Move(temporary, path); // Publish only a complete marker; never adopt/overwrite a racing directory.
        }
        CheckAliases(path, false);
        var marker = Path.Combine(path, "owner.json"); CheckAliases(marker, false);
        var info = new FileInfo(marker);
        if (info.Length != stageMarker.Length) throw Invalid();
        using var input = new FileStream(marker, FileMode.Open, FileAccess.Read, FileShare.Read);
        var bytes = new byte[stageMarker.Length]; input.ReadExactly(bytes);
        if (!bytes.AsSpan().SequenceEqual(stageMarker)) throw Invalid();
        return path;
    }

    private static async Task VerifyExistingAsync(string path, WindowsAppReleasePins release, CancellationToken token)
    {
        CheckAliases(path, false);
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
        if (input.Length != release.SizeBytes || Convert.ToHexStringLower(await SHA256.HashDataAsync(input, token).ConfigureAwait(false)) != release.Sha256) throw Invalid();
    }

    private static string StagingRoot(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.StartsWith("\\\\", StringComparison.Ordinal)) throw Invalid();
        var raw = path.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
        foreach (var part in raw[Path.GetPathRoot(raw)!.Length..].Split(Path.DirectorySeparatorChar)) Downloader.SafeFileName(part);
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        if (!Directory.Exists(full) || full == Path.TrimEndingDirectorySeparator(Path.GetPathRoot(full)!)) throw Invalid();
        if (new DriveInfo(Path.GetPathRoot(full)!).DriveType == DriveType.Network) throw Invalid();
        CheckAliases(full, false); return full;
    }
    private static void CheckAliases(string path, bool allowMissingLeaf)
    {
        for (var part = path; part is not null; part = Path.GetDirectoryName(part)) {
            try { if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw Invalid(); }
            catch (FileNotFoundException) when (allowMissingLeaf && part == path) { }
            catch (DirectoryNotFoundException) when (allowMissingLeaf && part == path) { }
        }
    }
    private static Version ParseVersion(string value)
    {
        if (value is null || !Regex.IsMatch(value, "\\A(?:0|[1-9][0-9]{0,4})\\.(?:0|[1-9][0-9]{0,4})\\.(?:0|[1-9][0-9]{0,4})\\.(?:0|[1-9][0-9]{0,4})\\z") ||
            value.Split('.').Any(part => !ushort.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out _))) throw Invalid();
        return Version.Parse(value);
    }
    private static void Exact(JsonElement root, string[] required, string[] optional)
    {
        var names = root.EnumerateObject().Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
        if (required.Any(name => !names.Contains(name)) || names.Except(required.Concat(optional), StringComparer.Ordinal).Any()) throw Invalid();
    }
    private static string Text(JsonElement root, string key, int maximum)
    {
        var value = root.GetProperty(key).GetString();
        if (string.IsNullOrEmpty(value) || value.Length > maximum || value.Trim() != value || value.Any(char.IsControl)) throw Invalid();
        return value;
    }
    private static void Unique(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object) {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in root.EnumerateObject()) { if (!seen.Add(property.Name)) throw Invalid(); Unique(property.Value); }
        } else if (root.ValueKind == JsonValueKind.Array) foreach (var element in root.EnumerateArray()) Unique(element);
    }
    private static bool Sanitize(Exception error) => error is HttpRequestException or IOException or UnauthorizedAccessException or JsonException or
        DecoderFallbackException or InvalidOperationException or KeyNotFoundException or FormatException or OverflowException or ArgumentException;
    private static TransferException Invalid() => new("The Windows release feed or staged artifact is invalid or unsupported.");
    private static TransferException TimeoutError() => new("The Windows release request timed out.");
    public void Dispose() { metadata.Dispose(); downloader.Dispose(); }
}
