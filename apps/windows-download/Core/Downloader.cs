using System.Net;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

[assembly: InternalsVisibleTo("LedgeTop.WindowsDownload.Tests")]

namespace LedgeTop.WindowsDownload;

/// <summary>Trusted metadata must come from a future authenticated server adapter, not file-list guesses.</summary>
public sealed record DownloadSpec(string OpaqueIdentity, Uri ContentUri, string FileName, long Length, string ETag, string Sha256);
public enum DownloadPhase { Receiving, Verifying, Completed }
/// <summary>Received bytes include an existing partial; integrity is established only at Completed.</summary>
public sealed record DownloadProgress(long BytesTransferred, long TotalBytes, DownloadPhase Phase);
public sealed class TransferException(string message) : Exception(message);

/// <summary>Read-only prototype. No upload, filesystem placeholders or automatic updates.</summary>
public sealed class Downloader : IDisposable
{
    private const string StateDirectory = ".ltds-downloads-v1";
    private const string OwnerMarker = "LedgeTop.WindowsDownload/1\n";
    private readonly HttpClient client;
    private readonly HashSet<string> origins;
    private readonly long maximumBytes;
    private readonly CloudflareAccessSession? accessSession;
    private sealed record State(int Version, string Descriptor, long Length, string ETag, string Sha256);

    public Downloader(IEnumerable<Uri> allowedOrigins, long maximumBytes = 1L << 40)
        : this(new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false,
            Credentials = null, AutomaticDecompression = DecompressionMethods.None,
            CheckCertificateRevocationList = true
        }, allowedOrigins, maximumBytes) { }

    public Downloader(CloudflareAccessSession session, long maximumBytes = 1L << 40)
        : this(new HttpClientHandler {
            AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false,
            Credentials = null, AutomaticDecompression = DecompressionMethods.None,
            CheckCertificateRevocationList = true
        }, [session.Origin], maximumBytes, session) { }

    // Synthetic tests may inject a handler. Production callers cannot install ambient authentication handlers.
    internal Downloader(HttpMessageHandler handler, IEnumerable<Uri> allowedOrigins, long maximumBytes = 1L << 40, CloudflareAccessSession? session = null)
    {
        if (maximumBytes < 0) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        this.maximumBytes = maximumBytes;
        origins = new HashSet<string>(allowedOrigins.Select(Origin), StringComparer.Ordinal);
        if (origins.Count == 0) throw new ArgumentException("An exact HTTPS origin allowlist is required.");
        if (session is not null && (origins.Count != 1 || !origins.Contains(Origin(session.Origin))))
            throw new ArgumentException("An Access session is restricted to its single exact origin.");
        accessSession = session;
        client = new HttpClient(handler, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private static string Origin(Uri value)
    {
        if (!value.IsAbsoluteUri || value.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(value.UserInfo)
            || !string.IsNullOrEmpty(value.Fragment)) throw new TransferException("Only approved HTTPS content is supported.");
        return value.GetComponents(UriComponents.SchemeAndServer, UriFormat.UriEscaped).ToLowerInvariant();
    }

    private void Validate(DownloadSpec spec)
    {
        if (!origins.Contains(Origin(spec.ContentUri))) throw new TransferException("Content origin is not approved.");
        if (string.IsNullOrWhiteSpace(spec.OpaqueIdentity) || spec.OpaqueIdentity.Length > 4096
            || spec.Length < 0 || spec.Length > maximumBytes) throw new TransferException("Download metadata is outside the supported bounds.");
        if (!EntityTagHeaderValue.TryParse(spec.ETag, out var etag) || etag.IsWeak || etag.Tag == "*"
            || etag.ToString() != spec.ETag || spec.ETag.Length > 512)
            throw new TransferException("A canonical strong ETag is required.");
        if (!Regex.IsMatch(spec.Sha256, "\\A[0-9a-fA-F]{64}\\z")) throw new TransferException("A trusted SHA-256 is required.");
        SafeFileName(spec.FileName);
    }

    internal static void SafeFileName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 150 || name is "." or ".." or StateDirectory
            || name.EndsWith('.') || name.EndsWith(' ') || name.Any(c => char.IsControl(c) || "<>:\"/\\|?*".Contains(c)))
            throw new TransferException("Choose a plain safe file basename.");
        var stem = name.Split('.')[0].ToUpperInvariant();
        if (stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$"
            || Regex.IsMatch(stem, "\\A(?:COM|LPT)[1-9¹²³]\\z")) throw new TransferException("Reserved device names are not supported.");
    }

    private static string HashText(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    // Each existing ancestor and every owned file is checked. This is not a sandbox against a hostile local user
    // replacing directories concurrently; select a private local directory controlled by the signed-in user.
    private static void CheckPath(string path)
    {
        var current = Path.GetFullPath(path);
        while (true) {
            try {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new TransferException("Symbolic links, junctions and reparse paths are not supported.");
            } catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
            var parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(parent) || parent == current) break;
            current = parent;
        }
    }

    private static void RequireRegularFile(string path)
    {
        CheckPath(path);
        if (Directory.Exists(path)) throw new TransferException("An owned transfer file was replaced by a directory.");
    }

    private static string ChooseRoot(string root)
    {
        if (!Path.IsPathFullyQualified(root) || (OperatingSystem.IsWindows() && root.StartsWith("\\\\", StringComparison.Ordinal)))
            throw new TransferException("Choose an existing absolute local directory.");
        root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        CheckPath(root);
        if (!Directory.Exists(root)) throw new TransferException("Choose an existing download directory.");
        return root;
    }

    private static string OwnedDirectory(string root)
    {
        var directory = Path.Combine(root, StateDirectory);
        CheckPath(directory);
        var marker = Path.Combine(directory, "owner.txt");
        if (Directory.Exists(directory)) {
            RequireRegularFile(marker);
            if (!File.Exists(marker) || new FileInfo(marker).Length > 128 || File.ReadAllText(marker) != OwnerMarker)
                throw new TransferException("The transfer state directory is not owned by this downloader.");
        } else {
            if (File.Exists(directory)) throw new TransferException("The transfer state directory is unavailable.");
            Directory.CreateDirectory(directory);
            CheckPath(directory);
            using var stream = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            stream.Write(Encoding.UTF8.GetBytes(OwnerMarker)); stream.Flush(true);
        }
        return directory;
    }

    private static State ReadState(string path)
    {
        RequireRegularFile(path);
        if (new FileInfo(path).Length > 4096) throw new TransferException("Transfer metadata is invalid.");
        try { return JsonSerializer.Deserialize<State>(File.ReadAllText(path)) ?? throw new TransferException("Transfer metadata is invalid."); }
        catch (JsonException) { throw new TransferException("Transfer metadata is invalid."); }
    }

    public async Task<string> DownloadAsync(DownloadSpec spec, string outputRoot, CancellationToken cancellationToken = default,
        IProgress<DownloadProgress>? progress = null)
    {
        cancellationToken.ThrowIfCancellationRequested(); Validate(spec);
        DownloadPhase? reportedPhase = null;
        long reportedAt = 0;
        void Report(long bytes, DownloadPhase phase)
        {
            if (progress is null) return;
            var now = Stopwatch.GetTimestamp();
            // A large transfer must not enqueue one UI callback per 64 KiB buffer.
            if (reportedPhase == phase && phase == DownloadPhase.Receiving
                && Stopwatch.GetElapsedTime(reportedAt, now) < TimeSpan.FromMilliseconds(100)) return;
            reportedPhase = phase; reportedAt = now;
            try { progress.Report(new(bytes, spec.Length, phase)); }
            catch (Exception) { /* An observer cannot change transfer integrity or undo promotion. */ }
        }
        var root = ChooseRoot(outputRoot);
        var finalPath = Path.Combine(root, spec.FileName);
        CheckPath(finalPath);
        if (File.Exists(finalPath) || Directory.Exists(finalPath)) throw new TransferException("The destination already exists; it will not be overwritten.");
        var directory = OwnedDirectory(root);
        var descriptor = HashText(JsonSerializer.Serialize(new { Identity = HashText(spec.OpaqueIdentity), spec.FileName, spec.Length,
            spec.ETag, Sha256 = spec.Sha256.ToLowerInvariant() }));
        var partialPath = Path.Combine(directory, descriptor + ".part");
        var statePath = Path.Combine(directory, descriptor + ".json");
        var lockPath = Path.Combine(directory, descriptor + ".lock");
        RequireRegularFile(lockPath);
        using var commandLock = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var expected = new State(1, descriptor, spec.Length, spec.ETag, spec.Sha256.ToLowerInvariant());
        RequireRegularFile(partialPath); RequireRegularFile(statePath);
        if (File.Exists(statePath)) {
            if (ReadState(statePath) != expected) throw new TransferException("Transfer metadata does not match this version.");
        } else {
            if (File.Exists(partialPath)) throw new TransferException("Unowned partial data cannot be resumed.");
            using var stateStream = new FileStream(statePath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            stateStream.Write(JsonSerializer.SerializeToUtf8Bytes(expected)); stateStream.Flush(true);
        }
        try {
            long offset = File.Exists(partialPath) ? new FileInfo(partialPath).Length : 0;
            if (offset > spec.Length) throw new TransferException("Partial data exceeds the trusted length.");
            // A full unpromoted partial may come from cancellation before the overflow probe or an invalid response.
            // Without a durable completed-response receipt, obtain fresh bytes rather than silently accepting it.
            if (File.Exists(partialPath) && offset == spec.Length) {
                RequireRegularFile(partialPath); File.Delete(partialPath); offset = 0;
            }
            Report(offset, DownloadPhase.Receiving);
            if (offset < spec.Length || !File.Exists(partialPath)) {
                using var request = new HttpRequestMessage(HttpMethod.Get, spec.ContentUri);
                request.Headers.IfMatch.Add(EntityTagHeaderValue.Parse(spec.ETag));
                request.Headers.AcceptEncoding.ParseAdd("identity");
                if (offset > 0) {
                    request.Headers.Range = new RangeHeaderValue(offset, null);
                    request.Headers.IfRange = new RangeConditionHeaderValue(EntityTagHeaderValue.Parse(spec.ETag));
                }
                if (accessSession is not null)
                    request.Headers.Add("Cf-Access-Token", await accessSession.GetTokenAsync(cancellationToken));
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                if (response.StatusCode == HttpStatusCode.Unauthorized) throw new LoginRequiredException();
                if (response.StatusCode == HttpStatusCode.Forbidden) throw new AccessDeniedException();
                if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Conflict) throw new ResourceUnavailableException();
                var remaining = spec.Length - offset;
                if ((offset > 0 && response.StatusCode != HttpStatusCode.PartialContent)
                    || (offset == 0 && response.StatusCode is not (HttpStatusCode.OK or HttpStatusCode.PartialContent)))
                    throw new TransferException("The server did not return the requested file version and range.");
                if (response.Headers.ETag?.ToString() != spec.ETag || response.Headers.ETag.IsWeak
                    || response.Content.Headers.ContentLength != remaining || response.Content.Headers.ContentEncoding.Count != 0)
                    throw new TransferException("The response version or length does not match trusted metadata.");
                if (response.StatusCode == HttpStatusCode.PartialContent) {
                    var range = response.Content.Headers.ContentRange;
                    if (range is null || range.Unit != "bytes" || range.From != offset || range.To != spec.Length - 1 || range.Length != spec.Length)
                        throw new TransferException("The response Content-Range does not match the requested range.");
                } else if (response.Content.Headers.ContentRange is not null) {
                    throw new TransferException("Unexpected Content-Range on a full response.");
                }
                RequireRegularFile(partialPath);
                await using (var output = new FileStream(partialPath, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous)) {
                    if (output.Length != offset) throw new TransferException("Partial data changed during the request.");
                    output.Position = offset;
                    await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
                    var buffer = new byte[65536];
                    long received = 0;
                    while (received < remaining) {
                        int count = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining - received)), cancellationToken);
                        if (count == 0) throw new TransferException("The response ended before the trusted length.");
                        await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken); received += count;
                        Report(offset + received, DownloadPhase.Receiving);
                    }
                    if (await input.ReadAsync(buffer.AsMemory(0, 1), cancellationToken) != 0) {
                        output.SetLength(offset); output.Flush(true); // Retain only the prefix trusted before this rejected response.
                        throw new TransferException("The response exceeds the trusted length.");
                    }
                    await output.FlushAsync(cancellationToken); output.Flush(true);
                }
            }
            cancellationToken.ThrowIfCancellationRequested();
            RequireRegularFile(partialPath);
            Report(spec.Length, DownloadPhase.Verifying);
            // Keep a read handle denying writes through final promotion (Windows permits rename via Delete sharing).
            await using (var verify = new FileStream(partialPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 65536, FileOptions.Asynchronous)) {
                if (verify.Length != spec.Length) throw new TransferException("Partial length changed before verification.");
                var actual = await SHA256.HashDataAsync(verify, cancellationToken);
                if (!CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(spec.Sha256))) {
                    RequireRegularFile(partialPath); File.Delete(partialPath);
                    throw new TransferException("SHA-256 verification failed; corrupt partial data was discarded.");
                }
                cancellationToken.ThrowIfCancellationRequested();
                CheckPath(finalPath); CheckPath(partialPath);
                File.Move(partialPath, finalPath, overwrite: false); // Same local root, atomic promotion; never replaces an existing file.
                Report(spec.Length, DownloadPhase.Completed);
                // Promotion is the commit boundary. Deferred state cleanup must not report a completed download as failed.
                try { RequireRegularFile(statePath); File.Delete(statePath); }
                catch (IOException) { } catch (UnauthorizedAccessException) { } catch (TransferException) { }
                return finalPath;
            }
        } catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (TransferException) { throw; }
        catch (HttpRequestException) { throw new TransferException("Download transport failed; authenticated content URLs are never logged."); }
        catch (IOException) { throw new TransferException("Download interrupted or destination unavailable; owned partial data can be retried."); }
    }

    public void Dispose() => client.Dispose();
}
