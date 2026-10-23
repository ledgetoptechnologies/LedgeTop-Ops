using System.Security.Cryptography;

namespace LedgeTop.WindowsDownload;

/// <summary>Future native adapter boundary. Complete/Fail are mutually exclusive and called once per request.</summary>
public interface IPlaceholderTransferSink
{
    Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken);
    Task CompleteAsync(CancellationToken cancellationToken);
    Task FailAsync(string code);
}

/// <summary>Source-only read-only hydration rehearsal. No Cloud Files registration or placeholder mutation.
/// Whole-file staging verifies SHA before any sink bytes. Cache paths never become downloader placeholders.</summary>
public sealed class PlaceholderHydrationCoordinator : IDisposable
{
    private readonly IQueuedDownloadSource source;
    private readonly string channel, root;
    private readonly long maximumFileBytes, maximumCacheBytes;
    private readonly SemaphoreSlim serial = new(1, 1);
    private const string Marker = ".verified-hydration-owner";
    private const string Owner = "LedgeTop.VerifiedHydration/1\n";

    public PlaceholderHydrationCoordinator(IQueuedDownloadSource source, string channel, string applicationStateRoot,
        long maximumFileBytes = 64L << 30, long maximumCacheBytes = 128L << 30)
    {
        if (channel is not ("pilot" or "stable") || maximumFileBytes < 0 || maximumCacheBytes < maximumFileBytes
            || !Path.IsPathFullyQualified(applicationStateRoot) || applicationStateRoot.StartsWith("\\\\", StringComparison.Ordinal))
            throw new TransferException("Hydration configuration is invalid.");
        this.source = source; this.channel = channel; this.maximumFileBytes = maximumFileBytes; this.maximumCacheBytes = maximumCacheBytes;
        root = Path.Combine(Path.GetFullPath(applicationStateRoot), "verified-hydration-v1");
        RequireSafe(applicationStateRoot);
        if (!Directory.Exists(applicationStateRoot)) throw new TransferException("Application state root must already exist.");
        Owned(root);
    }
    public async Task HydrateAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken = default)
    {
        var completed = false;
        try {
            identity.Encode(); // Enforce the 4096-byte native FileIdentity ceiling, even before authorization.
            if (identity.Channel != channel || identity.SourceAlias != source.Alias || identity.Origin != source.Origin.GetLeftPart(UriPartial.Authority)
                || identity.Length > maximumFileBytes || offset < 0 || length < 0 || offset > identity.Length || length > identity.Length - offset || offset % 4096 != 0 || (length % 4096 != 0 && length != identity.Length - offset))
                throw new TransferException("Hydration identity or range is unavailable.");
            await serial.WaitAsync(cancellationToken);
            try {
                var resolved = await Authorize(identity, cancellationToken);
                RequireSafe(root); Owned(root);
                var quotaLock = Path.Combine(root, ".hydration-cache.lock"); RequireSafe(quotaLock);
                using var capacityLease = new FileStream(quotaLock, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                var scope = Path.Combine(root, identity.ScopeKey); Owned(scope);
                var entry = Path.Combine(scope, identity.CacheKey); Owned(entry);
                var lockPath = Path.Combine(entry, ".hydration.lock"); RequireSafe(lockPath);
                using var held = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                var file = Path.Combine(entry, identity.FileName); RequireSafe(file);
                if (!File.Exists(file)) {
                    var used = CacheBytes();
                    if (identity.Length > maximumCacheBytes - used) throw new TransferException("Hydration cache capacity exceeded.");
                    var downloaded = await source.DownloadAsync(resolved.Spec, entry, cancellationToken: cancellationToken);
                    if (Path.GetFullPath(downloaded) != file) throw new TransferException("Hydration source returned an unexpected cache path.");
                }
                RequireSafe(file);
                // Windows denies concurrent writes and replacement through verification and publication.
                await using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
                if (input.Length != identity.Length || !CryptographicOperations.FixedTimeEquals(await SHA256.HashDataAsync(input, cancellationToken), Convert.FromHexString(identity.Sha256)))
                    throw new TransferException("Hydration cache integrity check failed.");
                await Authorize(identity, cancellationToken); // Download/hash may be lengthy; never treat cached bytes as authority.
                await TransferVerifiedRange(input, offset, length, sink, cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                // Mark terminal before calling external code; its exception cannot cause a second terminal call.
                completed = true; await sink.CompleteAsync(cancellationToken);
            } finally { serial.Release(); }
        } catch (Exception e) {
            if (!completed) { completed = true; try { await sink.FailAsync(e is OperationCanceledException ? "cancelled" : "unavailable"); } catch { } }
            if (e is OperationCanceledException && cancellationToken.IsCancellationRequested) throw;
            throw new TransferException("Hydration unavailable; no automatic sign-in or retry was attempted.");
        }
    }
    internal static async Task TransferVerifiedRange(Stream input, long offset, long length, IPlaceholderTransferSink sink, CancellationToken token) {
        input.Position = offset; var remaining = length; var buffer = new byte[65536];
        while (remaining > 0) {
            token.ThrowIfCancellationRequested();
            var count = (int)Math.Min(buffer.Length, remaining);
            await input.ReadExactlyAsync(buffer.AsMemory(0, count), token);
            await sink.WriteAsync(input.Position - count, buffer.AsMemory(0, count), token); remaining -= count;
        }
    }
    private async Task<ResolvedQueuedDownload> Authorize(PlaceholderIdentity id, CancellationToken token)
    {
        ValidateSource(id);
        var session = await source.GetSessionAsync(token); ValidateSource(id);
        if (session.PrincipalId != id.PrincipalId || session.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5)) throw new AccessDeniedException();
        var r = await source.ResolveAsync(id.ResourceReference, token); ValidateSource(id);
        if (r.PrincipalId != id.PrincipalId || r.LogicalFileId != id.LogicalFileId || r.RemoteVersion != id.RemoteVersion
            || r.Spec.OpaqueIdentity != id.LogicalFileId + ":" + id.RemoteVersion || r.Spec.FileName != id.FileName || r.Spec.Length != id.Length
            || r.Spec.ETag != id.ETag || r.Spec.Sha256 != id.Sha256
            || !r.Spec.ContentUri.IsAbsoluteUri || r.Spec.ContentUri.Scheme != "https" || r.Spec.ContentUri.UserInfo.Length != 0
            || r.Spec.ContentUri.Fragment.Length != 0 || r.Spec.ContentUri.GetLeftPart(UriPartial.Authority) != id.Origin) throw new ResourceUnavailableException();
        session = await source.GetSessionAsync(token); ValidateSource(id);
        if (session.PrincipalId != id.PrincipalId || session.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5)) throw new AccessDeniedException();
        return r;
    }
    private void ValidateSource(PlaceholderIdentity id) {
        if (source.Alias != id.SourceAlias || source.Origin.GetLeftPart(UriPartial.Authority) != id.Origin) throw new AccessDeniedException();
    }
    private long CacheBytes()
    {
        long size = 0;
        foreach (var file in Walk(root)) { RequireSafe(file); size = checked(size + new FileInfo(file).Length); }
        return size;
    }
    private static IEnumerable<string> Walk(string directory)
    {
        RequireSafe(directory);
        foreach (var file in Directory.EnumerateFiles(directory)) { RequireSafe(file); yield return file; }
        foreach (var child in Directory.EnumerateDirectories(directory)) { RequireSafe(child); foreach (var file in Walk(child)) yield return file; }
    }
    private static void Owned(string directory)
    {
        RequireSafe(directory);
        if (!Directory.Exists(directory)) {
            if (File.Exists(directory)) throw new TransferException("Hydration cache is unavailable.");
            Directory.CreateDirectory(directory);
            using var marker = new FileStream(Path.Combine(directory, Marker), FileMode.CreateNew, FileAccess.Write, FileShare.None);
            marker.Write(System.Text.Encoding.UTF8.GetBytes(Owner)); marker.Flush(true);
        }
        var path = Path.Combine(directory, Marker); RequireSafe(path);
        if (!File.Exists(path) || new FileInfo(path).Length > 128 || File.ReadAllText(path) != Owner) throw new TransferException("Hydration cache is not owned by this application.");
    }
    private static void RequireSafe(string path)
    {
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current)) {
            try { if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new TransferException("Hydration cache reparse paths are unsupported."); }
            catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
        }
    }
    public void Dispose() => serial.Dispose();
}
