using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Text.Json;

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
    private int disposed;
    private const string Marker = ".verified-hydration-owner";
    private const string Owner = "LedgeTop.VerifiedHydration/1\n";
#if LEDGETOP_CACHE_RACE_TEST
    // Synthetic-only deterministic barrier; excluded from normal and staging builds.
    internal static Action<string>? CacheWalkTestHook;
#endif

    public PlaceholderHydrationCoordinator(IQueuedDownloadSource source, string channel, string applicationStateRoot,
        long maximumFileBytes = 64L << 30, long maximumCacheBytes = 128L << 30, string? expectedPrincipal = null)
    {
        if (channel is not ("pilot" or "stable") || maximumFileBytes < 0 || maximumCacheBytes < maximumFileBytes || maximumCacheBytes < System.Text.Encoding.UTF8.GetByteCount(Owner)
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
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        using var admission = await HydrationCacheConcurrency.AcquireForReclamationAsync(root, identity.ScopeKey + identity.CacheKey, cancellationToken).ConfigureAwait(false);
        {
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
            var newQuota = Path.Combine(root, ".hydration-quota-v2.lock"); RequireSafe(newQuota);
            var modernQuota = File.Exists(newQuota);
            admission.AcquireExclusiveLegacy(quotaLock, FileMode.Open);
            var lockPath = Path.Combine(entry, ".hydration.lock"); RequireSafe(lockPath);
            using var held = await OpenEntryLeaseAsync(lockPath, FileMode.Open, cancellationToken, reclamation: true).ConfigureAwait(false);
            _ = OwnedExisting(root); _ = OwnedExisting(scope); _ = OwnedExisting(entry); RequireSafe(file);
            if (!OperatingSystem.IsWindows()) throw new TransferException("Verified cache reclamation requires Windows.");
            // DELETE access binds deletion to this verified file handle. Writes/rename/replacement are
            // excluded through hashing and setting delete disposition; no hash-close-path-delete race.
            using var handle = CacheNative.CreateFileW(NativeCacheFilePath(file), 0x80010000, 1, 0, 3, 0x40200000, 0);
            if (handle.IsInvalid) throw new IOException("Verified cache file could not be exclusively inspected.", System.Runtime.InteropServices.Marshal.GetHRForLastWin32Error());
            await using (var input = new FileStream(handle, FileAccess.Read, 65536, isAsync: true)) {
                if (input.Length != identity.Length || !CryptographicOperations.FixedTimeEquals(
                    await SHA256.HashDataAsync(input, cancellationToken).ConfigureAwait(false), Convert.FromHexString(identity.Sha256)))
                    throw new TransferException("Modified cache data was preserved.");
                cancellationToken.ThrowIfCancellationRequested(); ValidateSource(identity);
                if (!OwnedExisting(root) || !OwnedExisting(scope) || !OwnedExisting(entry))
                    throw new TransferException("Cache ownership changed during eviction.");
                // FILE_DISPOSITION_INFO is one BOOLEAN byte, not a four-byte Win32 BOOL.
                // https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info
                lock (admission.Quota) {
                    using var quota = modernQuota ? new FileStream(newQuota, FileMode.Open, FileAccess.ReadWrite, FileShare.None) : null;
                    RemoveExactStaleReservation(identity); // Offline immutable pins only; no source/auth call.
                    byte disposition = 1;
                    if (!CacheNative.SetFileInformationByHandle(handle, 4, ref disposition, 1))
                        throw new IOException("Verified cache deletion was not confirmed.", System.Runtime.InteropServices.Marshal.GetHRForLastWin32Error());
                }
            }
        }
    }
    public Task HydrateAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken = default) =>
        HydrateCoreAsync(identity, offset, length, sink, cancellationToken, null);
    internal Task HydrateTimedAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken, HydrationTiming timing) =>
        HydrateCoreAsync(identity, offset, length, sink, cancellationToken, timing);
    private async Task HydrateCoreAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken, HydrationTiming? timing)
    {
        var completed = false;
        var stage = HydrationStage.Context;
        VerifiedHydrationDownload? freshDownload = null;
        try {
            identity.Encode(); // Enforce the 4096-byte native FileIdentity ceiling, even before authorization.
            if (identity.Channel != channel || identity.SourceAlias != source.Alias || identity.Origin != source.Origin.GetLeftPart(UriPartial.Authority)
                || identity.Length > maximumFileBytes || offset < 0 || length < 0 || offset > identity.Length || length > identity.Length - offset || offset % 4096 != 0 || (length % 4096 != 0 && length != identity.Length - offset))
                throw new TransferException("Hydration identity or range is unavailable.");
            timing?.Enter(HydrationTimingStage.QueueWait);
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
#if LEDGETOP_NATIVE_DIAGNOSTICS
            NativeStallTrace.Record(NativeStallTrace.Stage.AdmissionEnter);
#endif
            using var admission = await HydrationCacheConcurrency.AcquireAsync(root, identity.ScopeKey + identity.CacheKey, cancellationToken,
                exclusive: source is not IHydrationMutationAwareSource { CoordinatesHydrationMutations: true });
            {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.AdmissionAcquired);
                NativeStallTrace.Record(NativeStallTrace.Stage.AuthorizationEnter);
#endif
                ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
                stage = HydrationStage.AuthorizationBefore; timing?.Enter(HydrationTimingStage.AuthorizationBefore);
                ResolvedQueuedDownload resolved;
                using (AuthorizationTimingScope.Begin(timing, identity, true)) resolved = await Authorize(identity, cancellationToken);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.AuthorizationExit);
#endif
                stage = HydrationStage.CachePreparation; timing?.Enter(HydrationTimingStage.CachePreparation);
                RequireSafe(root); Owned(root);
                var quotaLock = Path.Combine(root, ".hydration-cache.lock"); RequireSafe(quotaLock);
                // One process owns the legacy lease through all its active and queued work;
                // its two local slots still run concurrently. Other versions/processes refuse.
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheLegacyLeaseEnter);
#endif
                admission.AcquireExclusiveLegacy(quotaLock, FileMode.OpenOrCreate);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheLegacyLeaseAcquired);
#endif
                var scope = Path.Combine(root, identity.ScopeKey);
                var entry = Path.Combine(scope, identity.CacheKey);
                WithQuota(admission.Quota, () => {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                    NativeStallTrace.Record(NativeStallTrace.Stage.CacheDirectoryEnter);
                    try {
#endif
                    var scopeExists = OwnedExisting(scope); var entryExists = OwnedExisting(entry);
                    if (!scopeExists || !entryExists) {
                        var directory = Path.Combine(root, ".hydration-reservations-v2");
                        var metadata = checked((scopeExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                            (entryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                            (OwnedExisting(directory) ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)));
                        RequireCapacity(ReservedBytes(directory), checked(identity.Length + Downloader.HydrationStateGrowthBudget(resolved.Spec) + 1024 + metadata));
                        Owned(scope); Owned(entry);
                    }
#if LEDGETOP_NATIVE_DIAGNOSTICS
                    } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheDirectoryExit); }
#endif
                });
                var lockPath = Path.Combine(entry, ".hydration.lock"); RequireSafe(lockPath);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseEnter);
#endif
                using var held = await OpenEntryLeaseAsync(lockPath, FileMode.OpenOrCreate, cancellationToken);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseAcquired);
#endif
                var file = Path.Combine(entry, identity.FileName); RequireSafe(file);
                if (!File.Exists(file)) {
                    timing?.SetCacheHit(false);
                    stage = HydrationStage.Download; timing?.Enter(HydrationTimingStage.Download);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                    NativeStallTrace.Record(NativeStallTrace.Stage.CacheReserveEnter);
#endif
                    var reservation = Reserve(admission.Quota, identity, resolved.Spec); Exception? primary = null;
#if LEDGETOP_NATIVE_DIAGNOSTICS
                    NativeStallTrace.Record(NativeStallTrace.Stage.CacheReserveAcquired);
#endif
                    try {
                        string downloaded;
                        using (DownloadTimingScope.Begin(timing, identity))
                        using (HydrationMutationScope.Begin(action => WithQuota(admission.Quota, action), cancellationToken)) {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                            NativeStallTrace.Record(NativeStallTrace.Stage.CacheDownloadEnter);
                            try {
#endif
                            if (source is IVerifiedHydrationDownloadSource verifiedSource) {
                                freshDownload = await verifiedSource.DownloadForHydrationAsync(resolved.Spec, entry, cancellationToken).ConfigureAwait(false);
                                downloaded = freshDownload.Path;
                            } else downloaded = await source.DownloadAsync(resolved.Spec, entry, cancellationToken: cancellationToken);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                            } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheDownloadExit); }
#endif
                        }
                        if (Path.GetFullPath(downloaded) != file) throw new TransferException("Hydration source returned an unexpected cache path.");
                    } catch (Exception error) { primary = error; throw; }
                    finally {
                        // A cleanup failure retains the durable record. Never replace caller
                        // cancellation or the primary source/integrity diagnostic during unwind.
#if LEDGETOP_NATIVE_DIAGNOSTICS
                        NativeStallTrace.Record(NativeStallTrace.Stage.CacheReleaseEnter);
                        try {
#endif
                        if (primary is null) reservation.Dispose();
                        else { try { reservation.Dispose(); } catch { } }
#if LEDGETOP_NATIVE_DIAGNOSTICS
                        } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheReleaseExit); }
#endif
                    } // Source writes have fully joined; remaining bytes are now measured on disk.
                }
                else {
                    timing?.SetCacheHit(true);
                    WithQuota(admission.Quota, () => RemoveExactStaleReservation(identity));
                }
                stage = HydrationStage.CacheVerification; timing?.Enter(HydrationTimingStage.CacheVerification);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheVerifyEnter);
#endif
                RequireSafe(file);
                // On a cold cache, the production downloader hands off the exact still-open stream
                // it hashed before promotion. Cache hits and untrusted adapters are fully rehashed.
                await using var input = freshDownload?.Stream ?? new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
                if (input.Length != identity.Length || (freshDownload?.IntegrityVerified != true
                    && !CryptographicOperations.FixedTimeEquals(await SHA256.HashDataAsync(input, cancellationToken), Convert.FromHexString(identity.Sha256))))
                    throw new TransferException("Hydration cache integrity check failed.");
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheVerifyExit);
#endif
                stage = HydrationStage.AuthorizationAfter; timing?.Enter(HydrationTimingStage.AuthorizationAfter);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.AuthorizationAfterEnter);
                try {
#endif
                using (AuthorizationTimingScope.Begin(timing, identity, false)) await Authorize(identity, cancellationToken); // Download/hash may be lengthy; never treat cached bytes as authority.
#if LEDGETOP_NATIVE_DIAGNOSTICS
                } finally { NativeStallTrace.Record(NativeStallTrace.Stage.AuthorizationAfterExit); }
#endif
                stage = HydrationStage.Transfer; timing?.Enter(HydrationTimingStage.NativeTransfer);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.TransferEnter);
                try {
#endif
                await TransferVerifiedRange(input, offset, length, sink, cancellationToken);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                } finally { NativeStallTrace.Record(NativeStallTrace.Stage.TransferExit); }
#endif
                cancellationToken.ThrowIfCancellationRequested();
                // Mark terminal before calling external code; its exception cannot cause a second terminal call.
                completed = true; await sink.CompleteAsync(cancellationToken);
            }
        } catch (Exception e) {
            // Native failure settlement is observed separately from the failed/queued phase.
            timing?.Enter(HydrationTimingStage.NativeTransfer);
            var diagnostic = HydrationFailureDiagnostic.FromException(stage, e);
            if (sink is IPlaceholderFailureDiagnostics observer) observer.ObservePrimaryFailure(diagnostic);
            if (!completed) { completed = true; try { await sink.FailAsync(e is OperationCanceledException ? "cancelled" : "unavailable"); } catch { } }
            if (e is OperationCanceledException && cancellationToken.IsCancellationRequested) throw;
            throw new TransferException("Hydration unavailable; no automatic sign-in or retry was attempted.",
                (sink as IPlaceholderFailureDiagnostics)?.PrimaryFailure ?? diagnostic);
        } finally {
            if (freshDownload is not null) await freshDownload.DisposeAsync().ConfigureAwait(false);
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
        var authoritativeResolve = source is IHydrationAuthoritySource { ResolveCarriesCurrentAuthority: true };
        if (!authoritativeResolve) {
            var session = await source.GetSessionAsync(token); ValidateSource(id);
            if (session.PrincipalId != id.PrincipalId) throw new AccessDeniedException(AccessDenialReason.PrincipalMismatch);
            if (session.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5)) throw new AccessDeniedException();
        }
        var r = await source.ResolveAsync(id.ResourceReference, token); ValidateSource(id);
        if (r.PrincipalId != id.PrincipalId || r.LogicalFileId != id.LogicalFileId || r.RemoteVersion != id.RemoteVersion
            || r.Spec.OpaqueIdentity != id.LogicalFileId + ":" + id.RemoteVersion || r.Spec.FileName != id.FileName || r.Spec.Length != id.Length
            || r.Spec.ETag != id.ETag || r.Spec.Sha256 != id.Sha256
            || !r.Spec.ContentUri.IsAbsoluteUri || r.Spec.ContentUri.Scheme != "https" || r.Spec.ContentUri.UserInfo.Length != 0
            || r.Spec.ContentUri.Fragment.Length != 0 || r.Spec.ContentUri.GetLeftPart(UriPartial.Authority) != id.Origin) throw new ResourceUnavailableException();
        if (!authoritativeResolve) {
            var session = await source.GetSessionAsync(token); ValidateSource(id);
            if (session.PrincipalId != id.PrincipalId) throw new AccessDeniedException(AccessDenialReason.PrincipalMismatch);
            if (session.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5)) throw new AccessDeniedException();
        }
        return r;
    }
    private void ValidateSource(PlaceholderIdentity id) {
        if (new[] { Marker, ".hydration.lock", ".hydration-cache.lock" }.Contains(id.FileName, StringComparer.OrdinalIgnoreCase))
            throw new TransferException("A source basename collides with hydration metadata.");
        if (source.Alias != id.SourceAlias || source.Origin.GetLeftPart(UriPartial.Authority) != id.Origin) throw new AccessDeniedException(AccessDenialReason.SourceConfiguration);
    }
    private sealed record Reservation(int Version, string Scope, string Entry, long Growth);
    private static long ReservationGrowth(PlaceholderIdentity identity) => checked(identity.Length +
        Downloader.HydrationStateGrowthBudget(identity.Length, identity.ETag, identity.Sha256) + 1024);
    // Caller owns this entry exclusively and holds the appropriate root quota/legacy lease.
    private void RemoveExactStaleReservation(PlaceholderIdentity identity)
    {
        var directory = Path.Combine(root, ".hydration-reservations-v2");
        if (!OwnedExisting(directory)) return;
        var path = Path.Combine(directory, identity.ScopeKey + "-" + identity.CacheKey + ".json"); RequireSafe(path);
        if (!File.Exists(path)) { if (Directory.Exists(path)) throw new TransferException("Hydration reservation changed type."); return; }
        var old = ReadReservation(path);
        if (old.Value.Scope != identity.ScopeKey || old.Value.Entry != identity.CacheKey || old.Value.Growth != ReservationGrowth(identity))
            throw new TransferException("Hydration reservation ownership changed.");
        DeleteReservation(path, old.Bytes);
    }
    internal static async Task<FileStream> OpenEntryLeaseAsync(string path, FileMode mode, CancellationToken token, bool reclamation = false, TimeSpan? testTimeout = null)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(testTimeout ?? TimeSpan.FromMinutes(2));
        try {
            while (true) {
                timeout.Token.ThrowIfCancellationRequested(); RequireSafe(path);
                try { return new FileStream(path, mode, FileAccess.ReadWrite, FileShare.None); }
                catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33) {
                    await Task.Delay(TimeSpan.FromMilliseconds(25), timeout.Token).ConfigureAwait(false);
                }
            }
        } catch (OperationCanceledException) when (!token.IsCancellationRequested) {
            if (reclamation) throw new CacheLeaseContentionTimeoutException();
            throw new TransferException("Hydration entry lease timed out.", TransferFailureReason.Timeout);
        }
    }
    private sealed class Release(Action release) : IDisposable
    {
        private Action? action = release;
        public void Dispose() => Interlocked.Exchange(ref action, null)?.Invoke();
    }
    private void WithQuota(object gate, Action action)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CacheQuotaEnter);
#endif
        lock (gate) {
#if LEDGETOP_NATIVE_DIAGNOSTICS
            NativeStallTrace.Record(NativeStallTrace.Stage.CacheQuotaAcquired);
            try {
#endif
            RequireSafe(root); _ = OwnedExisting(root);
            var path = Path.Combine(root, ".hydration-quota-v2.lock"); RequireSafe(path);
            // Cross-process contention is a conservative failure, never an ignored reservation.
            using var held = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            action();
#if LEDGETOP_NATIVE_DIAGNOSTICS
            } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheQuotaExit); }
#endif
        }
    }
    private IDisposable Reserve(object gate, PlaceholderIdentity identity, DownloadSpec spec)
    {
        var directory = Path.Combine(root, ".hydration-reservations-v2");
        var name = identity.ScopeKey + "-" + identity.CacheKey + ".json";
        var path = Path.Combine(directory, name);
        // Includes the exact downloader JSON/marker growth plus the enforced maximum new
        // reservation record length. Partial bytes already counted on disk are NOT discounted.
        var growth = ReservationGrowth(identity);
        if (growth != checked(identity.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024))
            throw new TransferException("Hydration storage metadata changed.");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new Reservation(2, identity.ScopeKey, identity.CacheKey, growth));
        if (bytes.Length > 1024) throw new TransferException("Hydration reservation is outside its storage bound.");
        WithQuota(gate, () => {
            var directoryExists = OwnedExisting(directory); RequireSafe(path);
            RemoveExactStaleReservation(identity);
            RequireCapacity(ReservedBytes(directory), checked(growth + (directoryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner))));
            Owned(directory);
            using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            output.Write(bytes); output.Flush(true);
        });
        return new Release(() => WithQuota(gate, () => DeleteReservation(path, bytes)));
    }
    private void RequireCapacity(long reserved, long growth)
    {
        var used = CacheBytes();
        if (reserved > maximumCacheBytes || used > maximumCacheBytes - reserved || growth > maximumCacheBytes - reserved - used)
            throw new TransferException("Hydration cache capacity exceeded.");
    }
    private static long ReservedBytes(string directory)
    {
        if (!OwnedExisting(directory)) return 0;
        long reserved = 0; var count = 0;
        if (Directory.EnumerateDirectories(directory).Any()) throw new TransferException("Hydration reservation tree is unknown.");
        foreach (var item in Directory.EnumerateFiles(directory)) {
            if (Path.GetFileName(item) == Marker) continue;
            if (++count > 4096) throw new TransferException("Hydration reservation capacity exceeded.");
            reserved = checked(reserved + ReadReservation(item).Value.Growth);
        }
        return reserved;
    }
    private static (Reservation Value, byte[] Bytes) ReadReservation(string path)
    {
        RequireSafe(path);
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length is <= 0 or > 1024) throw new TransferException("Hydration reservation is unavailable.");
        var bytes = new byte[(int)input.Length]; input.ReadExactly(bytes);
        using var json = JsonDocument.Parse(bytes);
        var expected = new[] { "Version", "Scope", "Entry", "Growth" };
        if (json.RootElement.ValueKind != JsonValueKind.Object ||
            !json.RootElement.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(expected.Order()))
            throw new TransferException("Hydration reservation schema is unknown.");
        var row = JsonSerializer.Deserialize<Reservation>(bytes) ?? throw new TransferException("Hydration reservation is unknown.");
        if (row.Version != 2 || row.Growth < 0 ||
            !System.Text.RegularExpressions.Regex.IsMatch(row.Scope ?? "", "\\A[a-f0-9]{64}\\z") ||
            !System.Text.RegularExpressions.Regex.IsMatch(row.Entry ?? "", "\\A[a-f0-9]{64}\\z") ||
            Path.GetFileName(path) != row.Scope + "-" + row.Entry + ".json")
            throw new TransferException("Hydration reservation ownership is unknown.");
        return (row, bytes);
    }
    private static void DeleteReservation(string path, byte[] expected)
    {
        RequireSafe(path);
        if (OperatingSystem.IsWindows()) {
            using var handle = CacheNative.CreateFileW(NativeCacheFilePath(path), 0x80010000, 1, 0, 3, 0x40200000, 0);
            if (handle.IsInvalid) throw new IOException("Hydration reservation cannot be verified.");
            using var input = new FileStream(handle, FileAccess.Read);
            if (input.Length != expected.Length) throw new TransferException("Hydration reservation changed.");
            var observed = new byte[expected.Length]; input.ReadExactly(observed);
            if (!observed.AsSpan().SequenceEqual(expected)) throw new TransferException("Hydration reservation changed.");
            byte disposition = 1;
            if (!CacheNative.SetFileInformationByHandle(handle, 4, ref disposition, 1)) throw new IOException("Hydration reservation release was not confirmed.");
        } else {
            // Portable synthetic coordinator use only; native provider/eviction are Windows-only.
            using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
            var observed = new byte[expected.Length];
            if (input.Length != expected.Length) throw new TransferException("Hydration reservation changed.");
            input.ReadExactly(observed);
            if (!observed.AsSpan().SequenceEqual(expected)) throw new TransferException("Hydration reservation changed.");
            File.Delete(path);
        }
    }
    private long CacheBytes()
    {
        long size = 0;
        foreach (var file in Walk(root)) {
            RequireSafe(file);
#if LEDGETOP_CACHE_RACE_TEST
            CacheWalkTestHook?.Invoke(file);
#endif
            size = checked(size + new FileInfo(file).Length);
        }
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
    public void Dispose() => Interlocked.Exchange(ref disposed, 1);
}
