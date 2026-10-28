using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

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
    private readonly string? principal;
    private readonly long maximumFileBytes, maximumCacheBytes;
    private readonly SemaphoreSlim serial = new(1, 1);
    private const string Marker = ".verified-hydration-owner";
    private const string Owner = "LedgeTop.VerifiedHydration/1\n";

    public PlaceholderHydrationCoordinator(IQueuedDownloadSource source, string channel, string applicationStateRoot,
        long maximumFileBytes = 64L << 30, long maximumCacheBytes = 128L << 30, string? expectedPrincipal = null)
    {
        if (channel is not ("pilot" or "stable") || maximumFileBytes < 0 || maximumCacheBytes < maximumFileBytes
            || !Path.IsPathFullyQualified(applicationStateRoot) || applicationStateRoot.StartsWith("\\\\", StringComparison.Ordinal))
            throw new TransferException("Hydration configuration is invalid.");
        if (expectedPrincipal is not null && !System.Text.RegularExpressions.Regex.IsMatch(expectedPrincipal, "\\Aodqp1_[a-f0-9]{64}\\z"))
            throw new TransferException("Hydration principal is invalid.");
        this.source = source; this.channel = channel; principal = expectedPrincipal; this.maximumFileBytes = maximumFileBytes; this.maximumCacheBytes = maximumCacheBytes;
        root = Path.Combine(Path.GetFullPath(applicationStateRoot), "verified-hydration-v1");
        RequireSafe(applicationStateRoot);
        if (!Directory.Exists(applicationStateRoot)) throw new TransferException("Application state root must already exist.");
        Owned(root);
    }
    /// <summary>Offline exact-cache reclamation after successful native dehydration. Never authenticates or touches placeholders.</summary>
    internal async Task EvictVerifiedCacheAsync(PlaceholderIdentity identity, CancellationToken cancellationToken = default)
    {
        identity.Encode();
        if (principal is null || identity.PrincipalId != principal || identity.Channel != channel || identity.Length > maximumFileBytes)
            throw new TransferException("Cache eviction does not match this provider.");
        ValidateSource(identity);
        await serial.WaitAsync(cancellationToken).ConfigureAwait(false);
        try {
            cancellationToken.ThrowIfCancellationRequested(); ValidateSource(identity);
            if (!OwnedExisting(root)) return;
            var scope = Path.Combine(root, identity.ScopeKey);
            if (!OwnedExisting(scope)) return;
            var entry = Path.Combine(scope, identity.CacheKey);
            if (!OwnedExisting(entry)) return;
            var file = Path.Combine(entry, identity.FileName); RequireSafe(file);
            if (!File.Exists(file)) { if (Directory.Exists(file)) throw new TransferException("Cache entry changed type."); return; }
            // Missing leases are ambiguous, never create locks/directories during offline eviction.
            var quotaLock = Path.Combine(root, ".hydration-cache.lock"); RequireSafe(quotaLock);
            using var capacityLease = new FileStream(quotaLock, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            var lockPath = Path.Combine(entry, ".hydration.lock"); RequireSafe(lockPath);
            using var held = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            _ = OwnedExisting(root); _ = OwnedExisting(scope); _ = OwnedExisting(entry); RequireSafe(file);
            if (!OperatingSystem.IsWindows()) throw new TransferException("Verified cache reclamation requires Windows.");
            // DELETE access binds deletion to this verified file handle. Writes/rename/replacement are
            // excluded through hashing and setting delete disposition; no hash-close-path-delete race.
            using var handle = CacheNative.CreateFileW(NativeCacheFilePath(file), 0x80010000, 1, 0, 3, 0x40200000, 0);
            if (handle.IsInvalid) throw new IOException("Verified cache file could not be exclusively inspected.");
            await using (var input = new FileStream(handle, FileAccess.Read, 65536, isAsync: true)) {
                if (input.Length != identity.Length || !CryptographicOperations.FixedTimeEquals(
                    await SHA256.HashDataAsync(input, cancellationToken).ConfigureAwait(false), Convert.FromHexString(identity.Sha256)))
                    throw new TransferException("Modified cache data was preserved.");
                cancellationToken.ThrowIfCancellationRequested(); ValidateSource(identity);
                if (!OwnedExisting(root) || !OwnedExisting(scope) || !OwnedExisting(entry))
                    throw new TransferException("Cache ownership changed during eviction.");
                // FILE_DISPOSITION_INFO is one BOOLEAN byte, not a four-byte Win32 BOOL.
                // https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info
                byte disposition = 1;
                if (!CacheNative.SetFileInformationByHandle(handle, 4, ref disposition, 1))
                    throw new IOException("Verified cache deletion was not confirmed.");
            }
        } finally { serial.Release(); }
    }
    public Task HydrateAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken = default) =>
        HydrateCoreAsync(identity, offset, length, sink, cancellationToken, null);
    internal Task HydrateTimedAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken, HydrationTiming timing) =>
        HydrateCoreAsync(identity, offset, length, sink, cancellationToken, timing);
    private async Task HydrateCoreAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken, HydrationTiming? timing)
    {
        var completed = false;
        var stage = HydrationStage.Context;
        try {
            identity.Encode(); // Enforce the 4096-byte native FileIdentity ceiling, even before authorization.
            if (identity.Channel != channel || identity.SourceAlias != source.Alias || identity.Origin != source.Origin.GetLeftPart(UriPartial.Authority)
                || identity.Length > maximumFileBytes || offset < 0 || length < 0 || offset > identity.Length || length > identity.Length - offset || offset % 4096 != 0 || (length % 4096 != 0 && length != identity.Length - offset))
                throw new TransferException("Hydration identity or range is unavailable.");
            timing?.Enter(HydrationTimingStage.QueueWait);
            await serial.WaitAsync(cancellationToken);
            try {
                stage = HydrationStage.AuthorizationBefore; timing?.Enter(HydrationTimingStage.AuthorizationBefore);
                var resolved = await Authorize(identity, cancellationToken);
                stage = HydrationStage.CachePreparation; timing?.Enter(HydrationTimingStage.CachePreparation);
                RequireSafe(root); Owned(root);
                var quotaLock = Path.Combine(root, ".hydration-cache.lock"); RequireSafe(quotaLock);
                using var capacityLease = new FileStream(quotaLock, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                var scope = Path.Combine(root, identity.ScopeKey); Owned(scope);
                var entry = Path.Combine(scope, identity.CacheKey); Owned(entry);
                var lockPath = Path.Combine(entry, ".hydration.lock"); RequireSafe(lockPath);
                using var held = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                var file = Path.Combine(entry, identity.FileName); RequireSafe(file);
                if (!File.Exists(file)) {
                    timing?.SetCacheHit(false);
                    var used = CacheBytes();
                    if (identity.Length > maximumCacheBytes - used) throw new TransferException("Hydration cache capacity exceeded.");
                    stage = HydrationStage.Download; timing?.Enter(HydrationTimingStage.Download);
                    var downloaded = await source.DownloadAsync(resolved.Spec, entry, cancellationToken: cancellationToken);
                    if (Path.GetFullPath(downloaded) != file) throw new TransferException("Hydration source returned an unexpected cache path.");
                }
                else timing?.SetCacheHit(true);
                stage = HydrationStage.CacheVerification; timing?.Enter(HydrationTimingStage.CacheVerification);
                RequireSafe(file);
                // Windows denies concurrent writes and replacement through verification and publication.
                await using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
                if (input.Length != identity.Length || !CryptographicOperations.FixedTimeEquals(await SHA256.HashDataAsync(input, cancellationToken), Convert.FromHexString(identity.Sha256)))
                    throw new TransferException("Hydration cache integrity check failed.");
                stage = HydrationStage.AuthorizationAfter; timing?.Enter(HydrationTimingStage.AuthorizationAfter);
                await Authorize(identity, cancellationToken); // Download/hash may be lengthy; never treat cached bytes as authority.
                stage = HydrationStage.Transfer; timing?.Enter(HydrationTimingStage.NativeTransfer);
                await TransferVerifiedRange(input, offset, length, sink, cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                // Mark terminal before calling external code; its exception cannot cause a second terminal call.
                completed = true; await sink.CompleteAsync(cancellationToken);
            } finally { serial.Release(); }
        } catch (Exception e) {
            // Native failure settlement is observed separately from the failed/queued phase.
            timing?.Enter(HydrationTimingStage.NativeTransfer);
            var diagnostic = HydrationFailureDiagnostic.FromException(stage, e);
            if (sink is IPlaceholderFailureDiagnostics observer) observer.ObservePrimaryFailure(diagnostic);
            if (!completed) { completed = true; try { await sink.FailAsync(e is OperationCanceledException ? "cancelled" : "unavailable"); } catch { } }
            if (e is OperationCanceledException && cancellationToken.IsCancellationRequested) throw;
            throw new TransferException("Hydration unavailable; no automatic sign-in or retry was attempted.",
                (sink as IPlaceholderFailureDiagnostics)?.PrimaryFailure ?? diagnostic);
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
        if (new[] { Marker, ".hydration.lock", ".hydration-cache.lock" }.Contains(id.FileName, StringComparer.OrdinalIgnoreCase))
            throw new TransferException("A source basename collides with hydration metadata.");
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
    private static bool OwnedExisting(string directory)
    {
        RequireSafe(directory);
        if (!Directory.Exists(directory)) {
            if (File.Exists(directory)) throw new TransferException("Cache directory changed type.");
            return false;
        }
        var path = Path.Combine(directory, Marker); RequireSafe(path);
        if (!File.Exists(path) || new FileInfo(path).Length > 128 || File.ReadAllText(path) != Owner)
            throw new TransferException("Cache ownership is unavailable.");
        return true;
    }
    private static class CacheNative
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref byte disposition, uint size);
    }
    // Managed file APIs already support the long owned cache hierarchy. The installed apphost need
    // not opt into process-wide Win32 long paths; give this exact native open the same DOS path.
    // This is not an admission path: callers have already checked ownership, no-reparse ancestry,
    // source/principal, cache keys and leases. Never accept UNC, device namespaces or normalization.
    internal static string NativeCacheFilePath(string path)
    {
        if (path.Length < 3 || !char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\' ||
            Path.GetFullPath(path) != path)
            throw new TransferException("A canonical local cache path is required.");
        return @"\\?\" + path;
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
