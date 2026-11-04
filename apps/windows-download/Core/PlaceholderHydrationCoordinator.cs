using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;
using Microsoft.Win32.SafeHandles;
using System.Text.Json;
using System.Diagnostics;

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
    private readonly Func<TimeSpan, CancellationToken, Task> authorizationRetryDelay;
    private readonly TimeProvider authorizationRetryClock;
    private int disposed;
    private RootOwnerPin? rootOwnerPin;
    private readonly object ownedDirectoryPinsSync = new();
    private readonly ConcurrentDictionary<string, RootOwnerPin> ownedDirectoryPins = new(StringComparer.OrdinalIgnoreCase);
    private int ownedDirectoryPinCount;
    private const int MaximumOwnedDirectoryPins = 512;
    private const string Marker = ".verified-hydration-owner";
    private const string Owner = "LedgeTop.VerifiedHydration/1\n";
    // Same-process coordinators can initialize a shared ownership directory at once.
    // Fixed stripes serialize only marker creation/verification and keep the gate table bounded.
    private static readonly object[] OwnedDirectoryGates = CreateOwnedDirectoryGates();
    private static object[] CreateOwnedDirectoryGates()
    {
        var gates = new object[64];
        for (var i = 0; i < gates.Length; i++) gates[i] = new object();
        return gates;
    }
#if LEDGETOP_CACHE_RACE_TEST
    internal string ExperimentalRootForTest => root;
    // Synthetic-only deterministic barrier; excluded from normal and staging builds.
    internal static Action<string>? CacheWalkTestHook;
    internal static Action<string>? CreatedMarkerTestHook;
    internal static Action<string>? BeforeOwnedDirectoryGateTestHook;
    internal static Action<string>? BeforeOwnedPinRegistrationTestHook;
    internal static Action<string>? OwnerMarkerReadTestHook;
    internal static Action<string>? ReservationCreatedTestHook;
    internal static Action<string>? AfterReservationMoveTestHook;
    internal static Action<bool>? ReservationIdentityTestHook;
    internal static Action? BeforeReservationReleaseTestHook;
    internal static Action<string>? QuarantineStaleGuardTestHook;
#endif

    public PlaceholderHydrationCoordinator(IQueuedDownloadSource source, string channel, string applicationStateRoot,
        long maximumFileBytes = 64L << 30, long maximumCacheBytes = 128L << 30, string? expectedPrincipal = null)
        : this(source, channel, applicationStateRoot, maximumFileBytes, maximumCacheBytes, expectedPrincipal, Task.Delay) { }

    internal PlaceholderHydrationCoordinator(IQueuedDownloadSource source, string channel, string applicationStateRoot,
        long maximumFileBytes, long maximumCacheBytes, string? expectedPrincipal, Func<TimeSpan, CancellationToken, Task> authorizationRetryDelay,
        TimeProvider? authorizationRetryClock = null)
    {
        ArgumentNullException.ThrowIfNull(authorizationRetryDelay);
        this.authorizationRetryDelay = authorizationRetryDelay;
        this.authorizationRetryClock = authorizationRetryClock ?? TimeProvider.System;
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
        if (OperatingSystem.IsWindows()) rootOwnerPin = RootOwnerPin.AcquireExisting(root);
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
            VerifyOwnedRoot();
            var scope = Path.Combine(root, identity.ScopeKey);
            if (!OwnedExistingCached(scope)) return;
            var entry = Path.Combine(scope, identity.CacheKey);
            if (!OwnedExistingCached(entry)) return;
            var file = Path.Combine(entry, identity.FileName); RequireSafe(file);
            if (!File.Exists(file)) { if (Directory.Exists(file)) throw new TransferException("Cache entry changed type."); return; }
            // Missing leases are ambiguous, never create locks/directories during offline eviction.
            var quotaLock = Path.Combine(root, ".hydration-cache.lock"); RequireSafe(quotaLock);
            var newQuota = Path.Combine(root, ".hydration-quota-v2.lock"); RequireSafe(newQuota);
            var modernQuota = File.Exists(newQuota);
            admission.AcquireExclusiveLegacy(quotaLock, FileMode.Open);
            var lockPath = Path.Combine(entry, ".hydration.lock"); RequireSafe(lockPath);
            using var held = await OpenEntryLeaseAsync(lockPath, FileMode.Open, cancellationToken, reclamation: true).ConfigureAwait(false);
            VerifyOwnedRoot(); _ = OwnedExistingCached(scope); _ = OwnedExistingCached(entry); RequireSafe(file);
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
                VerifyOwnedRoot();
                if (!OwnedExistingCached(scope) || !OwnedExistingCached(entry))
                    throw new TransferException("Cache ownership changed during eviction.");
                // FILE_DISPOSITION_INFO is one BOOLEAN byte, not a four-byte Win32 BOOL.
                // https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info
                HydrationQuotaGate.Run(admission.Quota, () => {
                    using var quota = modernQuota ? new FileStream(newQuota, FileMode.Open, FileAccess.ReadWrite, FileShare.None) : null;
                    RemoveExactStaleReservation(identity, admission.Quota); // Offline immutable pins only; no source/auth call.
                    byte disposition = 1;
                    if (!CacheNative.SetFileInformationByHandle(handle, 4, ref disposition, 1))
                        throw new IOException("Verified cache deletion was not confirmed.", System.Runtime.InteropServices.Marshal.GetHRForLastWin32Error());
                }, cancellationToken);
            }
        }
    }
    public Task HydrateAsync(PlaceholderIdentity identity, long offset, long length, IPlaceholderTransferSink sink, CancellationToken cancellationToken = default) =>
        HydrateCoreAsync(identity, offset, length, sink, cancellationToken, null);
#if LEDGETOP_NATIVE_DIAGNOSTICS
    // Incremental synthetic-only comparison of the actual cache coordination
    // primitives. This does not authorize, download, or transfer data. The
    // reservation stage creates and verifies release of synthetic records only.
    internal static Action? SyntheticBeforeGapReacquire;
    internal async Task SyntheticCacheStageAsync(PlaceholderIdentity identity, string stage, CancellationToken token, bool exclusive = false, Func<Task>? transfer = null, bool failFastAdmission = false)
    {
        if (Environment.GetEnvironmentVariable("LEDGETOP_SYNTHETIC_MEMORY_PROBE") != "1" ||
            (exclusive && (Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_SERIAL") != "1" || stage != "quota-reservation" || transfer is null)) ||
            (failFastAdmission && (!exclusive || Environment.GetEnvironmentVariable("LEDGETOP_TEST_MEMORY_FAIL_FAST") != "1")) ||
            (!exclusive && transfer is not null) ||
            stage is not ("quota-only" or "quota-ownership" or "quota-capacity" or "quota-reservation" or "quota-reservation-gap" or "quota-reservation-precheck" or "reservation-owner-prewarm") || source.Alias != "synthetic" ||
            source.Origin.AbsoluteUri != "https://source.example.invalid/" || channel != "pilot" ||
            principal != "odqp1_" + new string('f', 64) || identity.PrincipalId != principal ||
            identity.Channel != "pilot" || identity.SourceAlias != "synthetic" || identity.Origin != "https://source.example.invalid" ||
            !System.Text.RegularExpressions.Regex.IsMatch(identity.FileName, "\\Asample-[0-3]\\.bin\\z") || identity.Length != 100_000 ||
            identity.Sha256 != Convert.ToHexStringLower(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(new string('x', 100_000)))))
            throw new TransferException("Synthetic cache diagnostic scope is invalid.");
        identity.Encode();
        var artifact = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT");
        if (string.IsNullOrEmpty(artifact) || !Path.IsPathFullyQualified(artifact) || artifact.StartsWith("\\\\", StringComparison.Ordinal))
            throw new TransferException("Synthetic artifact root is invalid.");
        var cache = Path.GetDirectoryName(root) ?? throw new TransferException("Synthetic cache is invalid.");
        var fixture = Path.GetDirectoryName(cache) ?? throw new TransferException("Synthetic fixture is invalid.");
        var fixtureId = Path.GetFileName(fixture);
        if (!Guid.TryParseExact(fixtureId, "N", out var parsed) || fixtureId != parsed.ToString("N") ||
            !string.Equals(cache, Path.Combine(Path.GetFullPath(artifact), "memory-native-fixtures", fixtureId, "Cache"), StringComparison.OrdinalIgnoreCase))
            throw new TransferException("Synthetic cache does not belong to this fixture.");
        RequireSafe(cache); RequireSafe(root);
        NativeStallTrace.Record(NativeStallTrace.Stage.AdmissionEnter);
        HydrationCacheConcurrency.Lease admission;
        try { admission = await HydrationCacheConcurrency.AcquireAsync(root, identity.ScopeKey + identity.CacheKey, token,
            exclusive: exclusive, testTimeout: failFastAdmission ? TimeSpan.FromSeconds(2) : null).ConfigureAwait(false); }
        catch (TransferException error) when (failFastAdmission && error.Reason == TransferFailureReason.Timeout) {
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticAdmissionTimedOut); throw;
        }
        using var ownedAdmission = admission;
        NativeStallTrace.Record(NativeStallTrace.Stage.AdmissionAcquired);
        TraceCacheAction(NativeStallTrace.Stage.SyntheticRootPrepareEnter, NativeStallTrace.Stage.SyntheticRootPrepareExit, VerifyOwnedRoot);
        var quotaLock = Path.Combine(root, ".hydration-cache.lock"); RequireSafe(quotaLock);
        NativeStallTrace.Record(NativeStallTrace.Stage.CacheLegacyLeaseEnter);
        admission.AcquireExclusiveLegacy(quotaLock, FileMode.OpenOrCreate);
        NativeStallTrace.Record(NativeStallTrace.Stage.CacheLegacyLeaseAcquired);
        var scope = Path.Combine(root, identity.ScopeKey);
        var entry = Path.Combine(scope, identity.CacheKey);
        var spec = new DownloadSpec(identity.ResourceReference, new Uri("https://source.example.invalid/content"), identity.FileName, identity.Length, identity.ETag, identity.Sha256);
        bool outsideScopeExists = false, outsideEntryExists = false;
        if (stage == "quota-reservation-precheck") {
            // Diagnostic comparison only. These observations may go stale before
            // the quota lock; never use this ordering as a production cache check.
            NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticOutsidePrecheckEnter);
            try {
                outsideScopeExists = TraceCacheValue(NativeStallTrace.Stage.CacheScopeCheckEnter, NativeStallTrace.Stage.CacheScopeCheckExit, () => OwnedExistingCached(scope));
                outsideEntryExists = TraceCacheValue(NativeStallTrace.Stage.CacheEntryCheckEnter, NativeStallTrace.Stage.CacheEntryCheckExit, () => OwnedExistingCached(entry));
            } finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticOutsidePrecheckExit); }
        }
        WithQuota(admission.Quota, () => {
            if (stage == "reservation-owner-prewarm") {
                var directory = Path.Combine(root, ".hydration-reservations-v2");
                var exists = OwnedExistingCached(directory);
                if (!exists) {
                    RequireCapacity(ReservedBytes(directory, admission.Quota), System.Text.Encoding.UTF8.GetByteCount(Owner));
                    OwnPinned(directory);
                }
            } else if (stage != "quota-only") {
                var scopeExists = stage == "quota-reservation-precheck" ? outsideScopeExists : TraceCacheValue(NativeStallTrace.Stage.CacheScopeCheckEnter, NativeStallTrace.Stage.CacheScopeCheckExit, () => OwnedExistingCached(scope));
                var entryExists = stage == "quota-reservation-precheck" ? outsideEntryExists : TraceCacheValue(NativeStallTrace.Stage.CacheEntryCheckEnter, NativeStallTrace.Stage.CacheEntryCheckExit, () => OwnedExistingCached(entry));
                // The ownership-only comparison intentionally omits capacity;
                // later stages run the production capacity path first.
                if (!scopeExists || !entryExists) {
                    if (stage is "quota-capacity" or "quota-reservation" or "quota-reservation-gap" or "quota-reservation-precheck") {
                        var directory = Path.Combine(root, ".hydration-reservations-v2");
                        var reservationDirectoryExists = TraceCacheValue(NativeStallTrace.Stage.CacheReservationDirCheckEnter, NativeStallTrace.Stage.CacheReservationDirCheckExit, () => OwnedExistingCached(directory));
                        var metadata = checked((scopeExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                            (entryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                            (reservationDirectoryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)));
                        RequireCapacity(ReservedBytes(directory, admission.Quota), checked(identity.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024 + metadata));
                    }
                    TraceCacheAction(NativeStallTrace.Stage.CacheScopeOwnEnter, NativeStallTrace.Stage.CacheScopeOwnExit, () => OwnPinned(scope));
                    TraceCacheAction(NativeStallTrace.Stage.CacheEntryOwnEnter, NativeStallTrace.Stage.CacheEntryOwnExit, () => OwnPinned(entry));
                }
            }
        }, token);
        if (stage is "quota-reservation" or "quota-reservation-gap" or "quota-reservation-precheck") {
            var lockPath = Path.Combine(entry, ".hydration.lock");
            TraceCacheAction(NativeStallTrace.Stage.CacheEntryPathSafeEnter, NativeStallTrace.Stage.CacheEntryPathSafeExit, () => RequireSafe(lockPath));
            NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseEnter);
            FileStream? held;
            try { held = await OpenEntryLeaseAsync(lockPath, FileMode.OpenOrCreate, token).ConfigureAwait(false); }
            finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseOpenExit); }
            NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseAcquired);
            try {
                // Comparison only: deliberately drop the physical entry lease while
                // reserving. This must never be used as the production lock order.
                if (stage == "quota-reservation-gap") { held.Dispose(); held = null; NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticEntryLeaseGapOpen); }
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheReserveEnter);
                var reservation = Reserve(admission.Quota, identity, spec, token);
                NativeStallTrace.Record(NativeStallTrace.Stage.CacheReserveAcquired);
                if (held is null) {
                    // If reacquisition fails or is cancelled, preserve the record.
                    SyntheticBeforeGapReacquire?.Invoke();
                    NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseEnter);
                    try { held = await OpenEntryLeaseAsync(lockPath, FileMode.Open, token).ConfigureAwait(false); }
                    finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseOpenExit); }
                    NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseAcquired);
                    NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticEntryLeaseGapClosed);
                }
                TraceCacheAction(NativeStallTrace.Stage.CacheReleaseEnter, NativeStallTrace.Stage.CacheReleaseExit, reservation.Dispose);
                if (transfer is not null) {
                    NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticSerialTransferEnter);
                    try { await transfer().ConfigureAwait(false); }
                    finally { NativeStallTrace.Record(NativeStallTrace.Stage.SyntheticSerialTransferExit); }
                }
            } finally { held?.Dispose(); }
        }
    }
#endif
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
                using (AuthorizationTimingScope.Begin(timing, identity, true)) resolved = await AuthorizeWithRetry(identity, cancellationToken);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                NativeStallTrace.Record(NativeStallTrace.Stage.AuthorizationExit);
#endif
                async Task<(FileStream Held, string File)> PrepareCacheAsync() {
                    stage = HydrationStage.CachePreparation; timing?.Enter(HydrationTimingStage.CachePreparation);
                    VerifyOwnedRoot();
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
#if LEDGETOP_NATIVE_DIAGNOSTICS
                        var scopeExists = TraceCacheValue(NativeStallTrace.Stage.CacheScopeCheckEnter, NativeStallTrace.Stage.CacheScopeCheckExit, () => OwnedExistingCached(scope));
                        var entryExists = TraceCacheValue(NativeStallTrace.Stage.CacheEntryCheckEnter, NativeStallTrace.Stage.CacheEntryCheckExit, () => OwnedExistingCached(entry));
#else
                        var scopeExists = OwnedExistingCached(scope); var entryExists = OwnedExistingCached(entry);
#endif
                        if (!scopeExists || !entryExists) {
                            var directory = Path.Combine(root, ".hydration-reservations-v2");
                            var reservationDirectoryExists =
#if LEDGETOP_NATIVE_DIAGNOSTICS
                            TraceCacheValue(NativeStallTrace.Stage.CacheReservationDirCheckEnter, NativeStallTrace.Stage.CacheReservationDirCheckExit, () => OwnedExistingCached(directory));
#else
                                OwnedExistingCached(directory);
#endif
                            var metadata = checked((scopeExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                                (entryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                                (reservationDirectoryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)));
                            RequireCapacity(ReservedBytes(directory, admission.Quota, timing), checked(identity.Length + Downloader.HydrationStateGrowthBudget(resolved.Spec) + 1024 + metadata), timing);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                            TraceCacheAction(NativeStallTrace.Stage.CacheScopeOwnEnter, NativeStallTrace.Stage.CacheScopeOwnExit, () => OwnPinned(scope));
                            TraceCacheAction(NativeStallTrace.Stage.CacheEntryOwnEnter, NativeStallTrace.Stage.CacheEntryOwnExit, () => OwnPinned(entry));
#else
                        OwnPinned(scope); OwnPinned(entry);
#endif
                        }
#if LEDGETOP_NATIVE_DIAGNOSTICS
                        } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheDirectoryExit); }
#endif
                    }, cancellationToken, timing);
                    var lockPath = Path.Combine(entry, ".hydration.lock");
#if LEDGETOP_NATIVE_DIAGNOSTICS
                    TraceCacheAction(NativeStallTrace.Stage.CacheEntryPathSafeEnter, NativeStallTrace.Stage.CacheEntryPathSafeExit, () => RequireSafe(lockPath));
                    NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseEnter);
                    FileStream held;
                    try { held = await OpenEntryLeaseAsync(lockPath, FileMode.OpenOrCreate, cancellationToken); }
                    finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseOpenExit); }
#else
                    RequireSafe(lockPath);
                    var held = await OpenEntryLeaseAsync(lockPath, FileMode.OpenOrCreate, cancellationToken);
#endif
                    try {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                        NativeStallTrace.Record(NativeStallTrace.Stage.CacheEntryLeaseAcquired);
#endif
                        var file = Path.Combine(entry, identity.FileName);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                        TraceCacheAction(NativeStallTrace.Stage.CacheFilePathSafeEnter, NativeStallTrace.Stage.CacheFilePathSafeExit, () => RequireSafe(file));
#else
                        RequireSafe(file);
#endif
                        if (!File.Exists(file)) {
                            timing?.SetCacheHit(false);
                            stage = HydrationStage.Download; timing?.Enter(HydrationTimingStage.Download);
#if LEDGETOP_NATIVE_DIAGNOSTICS
                            NativeStallTrace.Record(NativeStallTrace.Stage.CacheReserveEnter);
#endif
                            var reservation = Reserve(admission.Quota, identity, resolved.Spec, cancellationToken, timing); Exception? primary = null;
#if LEDGETOP_NATIVE_DIAGNOSTICS
                            NativeStallTrace.Record(NativeStallTrace.Stage.CacheReserveAcquired);
#endif
                            try {
                                string downloaded;
                                using (DownloadTimingScope.Begin(timing, identity))
                                using (HydrationMutationScope.Begin((action, waitToken) => WithQuota(admission.Quota, action, waitToken), cancellationToken)) {
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
#if LEDGETOP_CACHE_RACE_TEST
                                // A synthetic owned rollback may still have
                                // uncertain bytes. Keep this entry's durable
                                // reservation rather than claiming cleanup.
                                if (ExperimentalOwnedStream.HasQuarantineForEntryForTest(entry)) {
                                    if (primary is null) throw new TransferException("Experimental owner remains quarantined; reservation preserved.");
                                } else
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
                            WithQuota(admission.Quota, () => RemoveExactStaleReservation(identity, admission.Quota), cancellationToken);
                        }
                        return (held, file);
                    } catch { held.Dispose(); throw; }
                }
                var prepared = await PrepareCacheAsync();
                using var held = prepared.Held;
                var file = prepared.File;
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
                using (AuthorizationTimingScope.Begin(timing, identity, false)) await AuthorizeWithRetry(identity, cancellationToken); // Download/hash may be lengthy; never treat cached bytes as authority.
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
            throw new TransferException("Hydration unavailable; no automatic sign-in was attempted.",
                (sink as IPlaceholderFailureDiagnostics)?.PrimaryFailure ?? diagnostic);
        } finally {
            if (freshDownload is not null) await freshDownload.DisposeAsync().ConfigureAwait(false);
        }
    }
#if LEDGETOP_CACHE_RACE_TEST
    // Synthetic observation only: the result is not a reusable authorization
    // and cannot authorize a later reservation or mutation.
    internal async Task<long> ExperimentalObserveAuthorizedGrowthAsync(PlaceholderIdentity identity, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        return checked(resolved.Spec.Length + Downloader.HydrationStateGrowthBudget(resolved.Spec) + 1024);
    }
    private void ExperimentalValidateStagingIdentity(PlaceholderIdentity identity)
    {
        identity.Encode();
        if (principal is null || identity.PrincipalId != principal || identity.Channel != channel || identity.SourceAlias != source.Alias ||
            identity.Origin != source.Origin.GetLeftPart(UriPartial.Authority) || identity.Length > maximumFileBytes)
            throw new TransferException("Hydration identity is unavailable.");
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
    }
    internal static ManualResetEventSlim? ExperimentalAfterAuthorizationTestSignal, ExperimentalAfterAuthorizationReleaseTestSignal;
    internal static ManualResetEventSlim? ExperimentalAfterStageTestSignal, ExperimentalAfterStageReleaseTestSignal;
    private static void ExperimentalPauseAfterAuthorizationForTest()
    {
        if (ExperimentalAfterAuthorizationTestSignal is null) return;
        ExperimentalAfterAuthorizationTestSignal.Set();
        if (ExperimentalAfterAuthorizationReleaseTestSignal is null || !ExperimentalAfterAuthorizationReleaseTestSignal.Wait(TimeSpan.FromSeconds(10)))
            throw new IOException("Synthetic authorization boundary timed out.");
    }
    // Synchronous staging follows the fresh authority result directly. The
    // result is not exported as a token and remains synthetic-only.
    internal async Task<bool> ExperimentalAuthorizeAndStageAsync(PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt receipt, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity); ArgumentNullException.ThrowIfNull(receipt);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        ExperimentalPauseAfterAuthorizationForTest(); token.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (!receipt.StageSyntheticReservationForTest(root, identity, resolved.Spec, this, token)) return false;
        var completed = false;
        try {
            if (ExperimentalAfterStageTestSignal is not null) {
                ExperimentalAfterStageTestSignal.Set();
                if (ExperimentalAfterStageReleaseTestSignal is null || !ExperimentalAfterStageReleaseTestSignal.Wait(TimeSpan.FromSeconds(10)))
                    throw new IOException("Synthetic post-stage boundary timed out.");
            }
            token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            // The quota transaction is already closed; fresh authority is required
            // before this synthetic operation may report success.
            await ExperimentalReauthorizeStagedAsync(identity, receipt, token).ConfigureAwait(false);
            completed = true; return true;
        } finally {
            if (!completed) {
                // Preserve the original denial/cancellation. Cleanup uses no caller
                // cancellation and the exact retained record handle; if it is uncertain,
                // the receipt keeps its rooted handles and refuses disposal.
                try { receipt.RemoveSyntheticReservationForTest(root, identity.ScopeKey + identity.CacheKey); receipt.Dispose(); }
                catch { }
            }
        }
    }
    private static readonly object ExperimentalDownloadAuthority = new();
    internal static bool IsExperimentalDownloadAuthority(object value) => ReferenceEquals(value, ExperimentalDownloadAuthority);
    // Gated prerequisite for a native synthetic callback. It performs the same
    // metadata budget checks as hydration before adopting the real entry lease.
    // It does not stage a record, start a download, or authorize future delivery.
    internal async Task<ExperimentalReservationOwner.LeaseReceipt> ExperimentalPrepareReceiptAsync(PlaceholderIdentity identity, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity);
        if (identity.SourceAlias != "synthetic" || !source.Origin.Host.EndsWith(".invalid", StringComparison.OrdinalIgnoreCase))
            throw new TransferException("Synthetic receipt source is unsupported.");
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        HydrationCacheConcurrency.Lease? admission = null; ExperimentalEntryLease? entry = null; Exception? primary = null;
        try {
            admission = await HydrationCacheConcurrency.AcquireAsync(root, identity.ScopeKey + identity.CacheKey, token).ConfigureAwait(false);
            admission.AcquireExclusiveLegacy(Path.Combine(root, ".hydration-cache.lock"), FileMode.OpenOrCreate);
            var scope = Path.Combine(root, identity.ScopeKey); var entryPath = Path.Combine(scope, identity.CacheKey);
            var reservations = Path.Combine(root, ".hydration-reservations-v2");
            WithQuota(admission.Quota, () => {
                var scopeExists = OwnedExistingCached(scope); var entryExists = OwnedExistingCached(entryPath); var reservationsExist = OwnedExistingCached(reservations);
                if (!scopeExists || !entryExists || !reservationsExist) {
                    var metadata = checked((scopeExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                        (entryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)) +
                        (reservationsExist ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner)));
                    RequireCapacity(ReservedBytes(reservations, admission.Quota), checked(identity.Length + Downloader.HydrationStateGrowthBudget(resolved.Spec) + 1024 + metadata));
                    OwnPinned(scope); OwnPinned(entryPath); OwnPinned(reservations);
                }
            }, token);
            entry = ExperimentalEntryLease.Open(admission, root, identity.ScopeKey, identity.CacheKey);
            token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            return ExperimentalReservationOwner.CreateReceiptForAdmissionForTest(root, identity, ref admission, ref entry);
        } catch (Exception error) { primary = error; throw; }
        finally {
            // Moved tokens are nulled by the factory; uncertain owners remain
            // rooted by their gated registries if an injected failure occurs.
            try { try { entry?.Dispose(); } finally { admission?.Dispose(); } }
            catch when (primary is not null) { }
        }
    }
    // Synthetic downloader session only; it never returns file bytes or writes to a sink.
    internal async Task<ExperimentalReservationOwner.LeaseReceipt.DownloadSession> ExperimentalStartReceiptDownloadAsync(PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt receipt, SyntheticReceiptDownloadSource source, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity); ArgumentNullException.ThrowIfNull(receipt); ArgumentNullException.ThrowIfNull(source);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        return receipt.StartSyntheticDownloadForTest(root, identity, resolved.Spec, source, ExperimentalDownloadAuthority);
    }
    internal async Task<ExperimentalReservationOwner.LeaseReceipt.DownloadSession> ExperimentalStartHeldReceiptDownloadAsync(PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt receipt, SyntheticReceiptDownloadSource source, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity); ArgumentNullException.ThrowIfNull(receipt); ArgumentNullException.ThrowIfNull(source);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        return receipt.StartSyntheticDownloadForTest(root, identity, resolved.Spec, source, ExperimentalDownloadAuthority, holdVerified: true);
    }
    internal async Task<ExperimentalReservationOwner.LeaseReceipt.DownloadSession> ExperimentalStartReceiptTransferAsync(PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt receipt, SyntheticReceiptDownloadSource source, IPlaceholderTransferSink sink, long offset = 0, long? length = null, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity); ArgumentNullException.ThrowIfNull(receipt); ArgumentNullException.ThrowIfNull(source); ArgumentNullException.ThrowIfNull(sink);
        if (offset < 0 || offset > identity.Length) throw new TransferException("Synthetic native transfer range is unsupported.");
        var count = length ?? (identity.Length - offset);
        if (count <= 0 || count > identity.Length - offset || offset % 4096 != 0 || (count % 4096 != 0 && count != identity.Length - offset))
            throw new TransferException("Synthetic native transfer range is unsupported.");
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        return receipt.StartSyntheticDownloadForTest(root, identity, resolved.Spec, source, ExperimentalDownloadAuthority, this, sink, offset, count);
    }
    internal async Task ExperimentalAuthorizeReceiptTransferAsync(PlaceholderIdentity identity, DownloadSpec expected, CancellationToken token)
    {
        ExperimentalValidateStagingIdentity(identity);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (resolved.Spec != expected) throw new ResourceUnavailableException();
    }
    internal async Task ExperimentalAuthorizeActiveReceiptAsync(PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt.DownloadSession session, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity); ArgumentNullException.ThrowIfNull(session);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        session.VerifyActiveStagedForTest(root, identity, resolved.Spec, token);
    }
    // No sink or file bytes are exposed by this synthetic observation.
    internal async Task ExperimentalWaitReceiptDownloadAuthorizedAsync(PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt.DownloadSession session, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity); ArgumentNullException.ThrowIfNull(session);
        if (!session.Matches(root, identity)) throw new ResourceUnavailableException();
        await session.WaitAsync(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested(); ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (!session.Matches(root, identity, resolved.Spec)) throw new ResourceUnavailableException();
        session.VerifyStagedForTest(root, identity, resolved.Spec, token);
    }
    internal async Task ExperimentalReauthorizeStagedAsync(PlaceholderIdentity identity, ExperimentalReservationOwner.LeaseReceipt receipt, CancellationToken token = default)
    {
        ExperimentalValidateStagingIdentity(identity); ArgumentNullException.ThrowIfNull(receipt);
        var resolved = await AuthorizeWithRetry(identity, token).ConfigureAwait(false);
        ExperimentalPauseAfterAuthorizationForTest(); token.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        receipt.VerifySyntheticReservationForTest(root, identity, resolved.Spec, token);
    }
#endif
    internal static async Task TransferVerifiedRange(Stream input, long offset, long length, IPlaceholderTransferSink sink, CancellationToken token) {
        input.Position = offset; var remaining = length; var buffer = new byte[65536];
        while (remaining > 0) {
            token.ThrowIfCancellationRequested();
            var count = (int)Math.Min(buffer.Length, remaining);
            await input.ReadExactlyAsync(buffer.AsMemory(0, count), token);
            await sink.WriteAsync(input.Position - count, buffer.AsMemory(0, count), token); remaining -= count;
        }
    }
    private async Task<ResolvedQueuedDownload> AuthorizeWithRetry(PlaceholderIdentity id, CancellationToken token)
    {
        if (source is not EmployeeQueuedDownloadSource && source is not LifetimeQueuedDownloadSource { TrustedEmployeeForAuthorizationRetry: true })
            return await Authorize(id, token).ConfigureAwait(false);
        // Both attempts share one deadline, so the second Resolve cannot restart
        // the first attempt's 15-minute budget. The caller still owns cancellation.
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(15), authorizationRetryClock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, deadline.Token);
        try {
            try {
                var result = await Authorize(id, linked.Token).ConfigureAwait(false);
                linked.Token.ThrowIfCancellationRequested(); return result;
            } catch (TransferException error) when (error.Reason == TransferFailureReason.UnexpectedHttpStatus && error.HttpStatus is 502 or 503 or 504) {
                linked.Token.ThrowIfCancellationRequested();
                var delay = TimeSpan.FromMilliseconds(Random.Shared.Next(125, 376));
                if (source is LifetimeQueuedDownloadSource lifetime)
                    await lifetime.DelayAuthorizationRetryAsync(delay, authorizationRetryDelay, linked.Token).ConfigureAwait(false);
                else await authorizationRetryDelay(delay, linked.Token).ConfigureAwait(false);
                linked.Token.ThrowIfCancellationRequested();
                // Retry the complete authority check once, before native transfer.
                // ServiceBusy, login, denial, malformed and unknown errors do not retry here.
                var result = await Authorize(id, linked.Token).ConfigureAwait(false);
                linked.Token.ThrowIfCancellationRequested(); return result;
            }
        } catch (OperationCanceledException) when (deadline.IsCancellationRequested && !token.IsCancellationRequested) {
            throw new TransferException("Hydration authorization timed out.", TransferFailureReason.Timeout);
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
    private void RemoveExactStaleReservation(PlaceholderIdentity identity, object quota)
    {
#if LEDGETOP_CACHE_RACE_TEST
        // All callers hold the same-entry admission/lease before the quota
        // gate. Never interpret a rooted experimental owner as stale; the
        // guard applies to fresh fetch, cache-hit and offline eviction alike.
        var guardedEntry = Path.Combine(root, identity.ScopeKey, identity.CacheKey);
        if (ExperimentalOwnedStream.HasQuarantineForEntryForTest(guardedEntry)) {
            QuarantineStaleGuardTestHook?.Invoke(guardedEntry);
            throw new TransferException("Experimental owner remains quarantined; reservation preserved.");
        }
#endif
        var directory = Path.Combine(root, ".hydration-reservations-v2");
        if (!OwnedExistingCached(directory)) return;
        var path = Path.Combine(directory, identity.ScopeKey + "-" + identity.CacheKey + ".json"); RequireSafe(path);
        if (!File.Exists(path)) { if (Directory.Exists(path)) throw new TransferException("Hydration reservation changed type."); return; }
        var old = ReadReservation(path);
        if (old.Value.Scope != identity.ScopeKey || old.Value.Entry != identity.CacheKey || old.Value.Growth != ReservationGrowth(identity))
            throw new TransferException("Hydration reservation ownership changed.");
        if (HydrationCacheConcurrency.TryReadReservation(quota, path, out _))
            HydrationCacheConcurrency.ReleaseReservation(quota, path, old.Bytes);
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
    private void WithQuota(object gate, Action action, CancellationToken cancellationToken = default, HydrationTiming? timing = null)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CacheQuotaEnter);
#endif
        HydrationQuotaGate.Run(gate, () => {
#if LEDGETOP_NATIVE_DIAGNOSTICS
            NativeStallTrace.Record(NativeStallTrace.Stage.CacheQuotaAcquired);
            try {
#endif
            VerifyOwnedRoot();
            var path = Path.Combine(root, ".hydration-quota-v2.lock"); RequireSafe(path);
            // Cross-process contention is a conservative failure, never an ignored reservation.
            using var held = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            action();
#if LEDGETOP_NATIVE_DIAGNOSTICS
            } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheQuotaExit); }
#endif
        }, cancellationToken, observe: timing is null ? null : timing.AddCacheQuotaTime);
    }
    private IDisposable Reserve(object gate, PlaceholderIdentity identity, DownloadSpec spec, CancellationToken cancellationToken, HydrationTiming? timing = null)
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
#if LEDGETOP_NATIVE_DIAGNOSTICS
            var directoryExists = TraceCacheValue(NativeStallTrace.Stage.ReserveOwnerExistsEnter, NativeStallTrace.Stage.ReserveOwnerExistsExit, () => OwnedExistingCached(directory));
            TraceCacheAction(NativeStallTrace.Stage.ReservePathSafeEnter, NativeStallTrace.Stage.ReservePathSafeExit, () => RequireSafe(path));
            TraceCacheAction(NativeStallTrace.Stage.ReserveStaleEnter, NativeStallTrace.Stage.ReserveStaleExit, () => RemoveExactStaleReservation(identity, gate));
#else
            var directoryExists = OwnedExistingCached(directory); RequireSafe(path);
            RemoveExactStaleReservation(identity, gate);
#endif
            RequireCapacity(ReservedBytes(directory, gate, timing), checked(growth + (directoryExists ? 0 : System.Text.Encoding.UTF8.GetByteCount(Owner))), timing);
            OwnPinned(directory);
            // Publish a fully-written temporary record atomically. A read-only guard on the
            // temporary file allows the rename; opening the published path with FileShare.Read
            // then denies write/delete/rename before ownership is registered. The final handle
            // remains read-only so other processes can safely inspect the durable reservation.
            var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                var output = TraceCacheValue(NativeStallTrace.Stage.ReservationTemporaryOpenEnter, NativeStallTrace.Stage.ReservationTemporaryOpenExit,
                    () => new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.Read));
                try {
                    TraceCacheAction(NativeStallTrace.Stage.ReservationWriteEnter, NativeStallTrace.Stage.ReservationWriteExit, () => output.Write(bytes));
                    TraceCacheAction(NativeStallTrace.Stage.ReservationFlushEnter, NativeStallTrace.Stage.ReservationFlushExit, () => output.Flush(true));
                } finally {
                    TraceCacheAction(NativeStallTrace.Stage.ReservationTemporaryDisposeEnter, NativeStallTrace.Stage.ReservationTemporaryDisposeExit, output.Dispose);
                }
                using var publishGuard = TraceCacheValue(NativeStallTrace.Stage.ReservationPublishGuardOpenEnter, NativeStallTrace.Stage.ReservationPublishGuardOpenExit,
                    () => new FileStream(temporary, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete));
                TraceCacheAction(NativeStallTrace.Stage.ReservationMoveEnter, NativeStallTrace.Stage.ReservationMoveExit, () => File.Move(temporary, path));
#else
                using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
                    output.Write(bytes); output.Flush(true);
                }
                using var publishGuard = new FileStream(temporary, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
                File.Move(temporary, path);
#endif
#if LEDGETOP_CACHE_RACE_TEST
                AfterReservationMoveTestHook?.Invoke(path);
#endif
#if LEDGETOP_NATIVE_DIAGNOSTICS
                var held = TraceCacheValue(NativeStallTrace.Stage.ReservationFinalOpenEnter, NativeStallTrace.Stage.ReservationFinalOpenExit,
                    () => new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read));
#else
                var held = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
#endif
                var registered = false;
                try {
                    if (OperatingSystem.IsWindows()) {
#if LEDGETOP_NATIVE_DIAGNOSTICS
                        var sameFile = TraceCacheValue(NativeStallTrace.Stage.ReservationIdentityEnter, NativeStallTrace.Stage.ReservationIdentityExit,
                            () => SameFileIdentity(publishGuard, held));
#else
                        var sameFile = SameFileIdentity(publishGuard, held);
#endif
#if LEDGETOP_CACHE_RACE_TEST
                        ReservationIdentityTestHook?.Invoke(sameFile);
#endif
                        if (!sameFile) throw new TransferException("Hydration reservation path changed during publication.");
                    }
#if LEDGETOP_CACHE_RACE_TEST
                    ReservationCreatedTestHook?.Invoke(path);
#endif
#if LEDGETOP_NATIVE_DIAGNOSTICS
                    TraceCacheAction(NativeStallTrace.Stage.ReservationRegisterEnter, NativeStallTrace.Stage.ReservationRegisterExit,
                        () => HydrationCacheConcurrency.RegisterReservation(gate, path, bytes, growth, held));
#else
                    HydrationCacheConcurrency.RegisterReservation(gate, path, bytes, growth, held);
#endif
                    registered = true;
                } finally { if (!registered) held.Dispose(); }
            } catch {
                if (File.Exists(temporary)) File.Delete(temporary);
                throw;
            }
        }, cancellationToken, timing);
        return new Release(() => {
#if LEDGETOP_CACHE_RACE_TEST
            BeforeReservationReleaseTestHook?.Invoke();
#endif
            WithQuota(gate, () => {
                HydrationCacheConcurrency.ReleaseReservation(gate, path, bytes);
                DeleteReservation(path, bytes);
            });
        });
    }
    private void RequireCapacity(long reserved, long growth, HydrationTiming? timing = null)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CacheCapacityEnter);
        try {
#endif
        var scanStarted = Stopwatch.GetTimestamp();
        long used;
        try { used = CacheBytes(); }
        finally { timing?.AddCacheWalkTime(Stopwatch.GetElapsedTime(scanStarted)); }
        RequireCapacityForUsed(used, reserved, growth);
#if LEDGETOP_NATIVE_DIAGNOSTICS
        } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheCapacityExit); }
#endif
    }
    private void RequireCapacityForUsed(long used, long reserved, long growth)
    {
        if (reserved > maximumCacheBytes || used > maximumCacheBytes - reserved || growth > maximumCacheBytes - reserved - used)
            throw new TransferException("Hydration cache capacity exceeded.");
    }
#if LEDGETOP_CACHE_RACE_TEST
    // Isolated coordinator/scanner experiment; not called from hydration or eviction.
    internal static Func<string, bool>? ExperimentalOmitReservationFromWalkTestHook;
    internal static ManualResetEventSlim? ExperimentalScanStatusEnteredTestSignal, ExperimentalScanStatusReleaseTestSignal;
    internal long ExperimentalCheckMarkerCapacity(HydrationCacheConcurrency.Lease admission, long growth, CancellationToken token = default)
    {
        var result = ExperimentalCapacityDecision(admission, growth, token);
        if (!result.Fits) throw new TransferException("Hydration cache capacity exceeded.");
        return result.Used;
    }
    private (long Used, bool Fits) ExperimentalCapacityDecision(HydrationCacheConcurrency.Lease admission, long growth, CancellationToken token)
    {
        if (growth < 0) throw new ArgumentOutOfRangeException(nameof(growth));
        (long Used, bool Fits, long Revision) result = default;
        admission.RunExperimentalForRoot(root, () => WithQuota(admission.Quota, () => result = ExperimentalScanUnderQuota(admission, growth), token));
        return (result.Used, result.Fits);
    }
    internal (bool Fits, long Revision) ExperimentalCapacityUnderOwnedQuota(HydrationCacheConcurrency.Lease admission, SafeFileHandle quota, long growth)
    {
        if (growth < 0) throw new ArgumentOutOfRangeException(nameof(growth));
        if (!admission.ExperimentalGateHeld || !Monitor.IsEntered(admission.Quota)) throw new InvalidOperationException("Experimental quota transaction is not held.");
        (bool Fits, long Revision) result = default;
        admission.RunExperimentalForRoot(root, () => {
            ExperimentalOwnedStream.RequireRegularKind(quota, false); ExperimentalOwnedStream.RequireSingleLink(quota);
            if (!string.Equals(ExperimentalOwnedStream.FinalPath(quota), Path.Combine(root, ".hydration-quota-v2.lock"), StringComparison.OrdinalIgnoreCase))
                throw new IOException("Experimental quota binding changed.");
            var scan = ExperimentalScanUnderQuota(admission, growth); result = (scan.Fits, scan.Revision);
        });
        return result;
    }
    private (long Used, bool Fits, long Revision) ExperimentalScanUnderQuota(HydrationCacheConcurrency.Lease admission, long growth)
    {
        var status = admission.ExperimentalStatus; long revision;
        lock (status.Gate) { if (status.Poisoned) throw new TransferException("Synthetic receipt status is unavailable."); revision = status.Revision; }
        var markers = admission.ExperimentalMarkers;
        var retained = ExperimentalReservationOwner.SnapshotForRoot(root);
        var staged = ExperimentalReservationOwner.SnapshotStagedForRoot(root, admission.Quota);
        if (staged.Keys.Any(retained.ContainsKey)) throw new TransferException("Reservation is retained by two owners.");
        var expected = new HashSet<string>(retained.Keys, StringComparer.OrdinalIgnoreCase); expected.UnionWith(staged.Keys);
        var walked = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long used = 0;
        foreach (var file in Walk(root)) {
            RequireSafe(file);
            if (retained.TryGetValue(file, out var live)) {
                if (ExperimentalOmitReservationFromWalkTestHook?.Invoke(file) == true) continue;
                if (!walked.Add(file)) throw new TransferException("Retained reservation appears more than once.");
                used = checked(used + live.RecordBytes);
            } else if (staged.TryGetValue(file, out var stagedRecord)) {
                if (ExperimentalOmitReservationFromWalkTestHook?.Invoke(file) == true) continue;
                if (!walked.Add(file)) throw new TransferException("Staged reservation appears more than once.");
                used = checked(used + stagedRecord.Bytes);
            } else used = checked(used + (string.Equals(Path.GetFileName(file), Marker, StringComparison.OrdinalIgnoreCase) ? markers.AccountMarker(file) : new FileInfo(file).Length));
        }
        if (!walked.SetEquals(expected)) throw new TransferException("Retained reservation is missing from the cache walk.");
        var reserved = ExperimentalReservedBytes(Path.Combine(root, ".hydration-reservations-v2"), retained, staged);
        if (ExperimentalScanStatusEnteredTestSignal is not null) {
            ExperimentalScanStatusEnteredTestSignal.Set();
            if (ExperimentalScanStatusReleaseTestSignal is null || !ExperimentalScanStatusReleaseTestSignal.Wait(TimeSpan.FromSeconds(10))) throw new IOException("Synthetic scanner status barrier timed out.");
        }
        lock (status.Gate) if (status.Poisoned || status.Revision != revision) throw new TransferException("Synthetic receipt status changed during the scan.");
        return (used, reserved <= maximumCacheBytes && used <= maximumCacheBytes - reserved && growth <= maximumCacheBytes - reserved - used, revision);
    }
    private long ExperimentalReservedBytes(string directory, Dictionary<string, ExperimentalReservationOwner> retained, Dictionary<string, ExperimentalReservationOwner.StagedSnapshot> staged)
    {
        if (!OwnedExistingCached(directory)) {
            if (retained.Count != 0 || staged.Count != 0) throw new TransferException("Retained reservation directory is missing.");
            return 0;
        }
        if (Directory.EnumerateDirectories(directory).Any()) throw new TransferException("Hydration reservation tree is unknown.");
        long reserved = 0; var count = 0; var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in Directory.EnumerateFiles(directory)) {
            if (Path.GetFileName(file) == Marker) continue;
            if (++count > 4096 || !seen.Add(file)) throw new TransferException("Hydration reservation capacity exceeded.");
            if (retained.TryGetValue(file, out var live)) { live.Verify(); reserved = checked(reserved + live.Growth); }
            else if (staged.TryGetValue(file, out var stagedRecord)) reserved = checked(reserved + stagedRecord.Growth);
            else reserved = checked(reserved + ReadReservation(file).Value.Growth);
        }
        foreach (var path in retained.Keys) if (!seen.Contains(path)) throw new TransferException("Retained reservation is missing from the directory.");
        foreach (var path in staged.Keys) if (!seen.Contains(path)) throw new TransferException("Staged reservation is missing from the directory.");
        return reserved;
    }
#endif
    private long ReservedBytes(string directory, object quota, HydrationTiming? timing = null)
    {
        var scanStarted = Stopwatch.GetTimestamp();
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CacheReservedBytesEnter);
#endif
        try {
        var activePaths = HydrationCacheConcurrency.ActiveReservationPaths(quota);
        var canonicalDirectory = Path.GetFullPath(directory);
#if LEDGETOP_NATIVE_DIAGNOSTICS
        if (!TraceCacheValue(NativeStallTrace.Stage.ReservedOwnerCheckEnter, NativeStallTrace.Stage.ReservedOwnerCheckExit, () => OwnedExistingCached(directory))) {
            if (activePaths.Any(path => string.Equals(Path.GetDirectoryName(path), canonicalDirectory, StringComparison.OrdinalIgnoreCase)))
                throw new TransferException("Active hydration reservation directory is missing.");
            return 0;
        }
#else
        if (!OwnedExistingCached(directory)) {
            if (activePaths.Any(path => string.Equals(Path.GetDirectoryName(path), canonicalDirectory, StringComparison.OrdinalIgnoreCase)))
                throw new TransferException("Active hydration reservation directory is missing.");
            return 0;
        }
#endif
        if (activePaths.Length > 4096) throw new TransferException("Hydration reservation capacity exceeded.");
        long reserved = 0; var count = 0; var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
#if LEDGETOP_NATIVE_DIAGNOSTICS
        if (TraceCacheValue(NativeStallTrace.Stage.ReservedDirectoriesCheckEnter, NativeStallTrace.Stage.ReservedDirectoriesCheckExit, () => Directory.EnumerateDirectories(directory).Any())) throw new TransferException("Hydration reservation tree is unknown.");
        var enumerator = TraceCacheValue(NativeStallTrace.Stage.ReservedFilesEnumeratorEnter, NativeStallTrace.Stage.ReservedFilesEnumeratorExit, () => Directory.EnumerateFiles(directory).GetEnumerator());
        try {
        while (TraceCacheValue(NativeStallTrace.Stage.ReservedFilesMoveEnter, NativeStallTrace.Stage.ReservedFilesMoveExit, enumerator.MoveNext)) {
            var item = enumerator.Current;
#else
        if (Directory.EnumerateDirectories(directory).Any()) throw new TransferException("Hydration reservation tree is unknown.");
        foreach (var item in Directory.EnumerateFiles(directory)) {
#endif
            if (Path.GetFileName(item) == Marker) continue;
            var canonicalItem = Path.GetFullPath(item);
            if (++count > 4096 || !seen.Add(canonicalItem)) throw new TransferException("Hydration reservation capacity exceeded.");
            if (HydrationCacheConcurrency.TryReadReservation(quota, canonicalItem, out var activeGrowth))
                reserved = checked(reserved + activeGrowth);
            else reserved = checked(reserved + ReadReservation(item).Value.Growth);
        }
#if LEDGETOP_NATIVE_DIAGNOSTICS
        } finally { TraceCacheAction(NativeStallTrace.Stage.ReservedFilesDisposeEnter, NativeStallTrace.Stage.ReservedFilesDisposeExit, enumerator.Dispose); }
#endif
        foreach (var active in activePaths)
            if (!string.Equals(Path.GetDirectoryName(active), canonicalDirectory, StringComparison.OrdinalIgnoreCase) || !seen.Contains(active))
                throw new TransferException("Active hydration reservation is missing from the directory.");
        return reserved;
        } finally {
#if LEDGETOP_NATIVE_DIAGNOSTICS
            NativeStallTrace.Record(NativeStallTrace.Stage.CacheReservedBytesExit);
#endif
            timing?.AddReservationScanTime(Stopwatch.GetElapsedTime(scanStarted));
        }
    }
    private static (Reservation Value, byte[] Bytes) ReadReservation(string path)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.ReservedRecordReadEnter);
        try {
#endif
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
#if LEDGETOP_NATIVE_DIAGNOSTICS
        } finally { NativeStallTrace.Record(NativeStallTrace.Stage.ReservedRecordReadExit); }
#endif
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
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.CacheWalkEnter);
        try {
#endif
        long size = 0;
        foreach (var file in Walk(root)) {
            RequireSafe(file);
#if LEDGETOP_CACHE_RACE_TEST
            CacheWalkTestHook?.Invoke(file);
#endif
            size = checked(size + new FileInfo(file).Length);
        }
        return size;
#if LEDGETOP_NATIVE_DIAGNOSTICS
        } finally { NativeStallTrace.Record(NativeStallTrace.Stage.CacheWalkExit); }
#endif
    }
#if LEDGETOP_NATIVE_DIAGNOSTICS
    private static T TraceCacheValue<T>(NativeStallTrace.Stage enter, NativeStallTrace.Stage exit, Func<T> action)
    {
        NativeStallTrace.Record(enter);
        try { return action(); } finally { NativeStallTrace.Record(exit); }
    }
    private static void TraceCacheAction(NativeStallTrace.Stage enter, NativeStallTrace.Stage exit, Action action)
    {
        NativeStallTrace.Record(enter);
        try { action(); } finally { NativeStallTrace.Record(exit); }
    }
#endif
    private static IEnumerable<string> Walk(string directory)
    {
        RequireSafe(directory);
        foreach (var file in Directory.EnumerateFiles(directory)) { RequireSafe(file); yield return file; }
        foreach (var child in Directory.EnumerateDirectories(directory)) { RequireSafe(child); foreach (var file in Walk(child)) yield return file; }
    }
    private static void Owned(string directory)
    {
        var canonical = Path.GetFullPath(directory);
        var gate = OwnedDirectoryGates[StringComparer.OrdinalIgnoreCase.GetHashCode(canonical) & (OwnedDirectoryGates.Length - 1)];
#if LEDGETOP_NATIVE_DIAGNOSTICS
        NativeStallTrace.Record(NativeStallTrace.Stage.OwnedDirectoryGateEnter);
#endif
#if LEDGETOP_CACHE_RACE_TEST
        BeforeOwnedDirectoryGateTestHook?.Invoke(canonical);
#endif
        lock (gate) {
#if LEDGETOP_NATIVE_DIAGNOSTICS
            NativeStallTrace.Record(NativeStallTrace.Stage.OwnedDirectoryGateAcquired);
            try {
#endif
                OwnedLocked(directory);
#if LEDGETOP_NATIVE_DIAGNOSTICS
            } finally { NativeStallTrace.Record(NativeStallTrace.Stage.OwnedDirectoryGateExit); }
#endif
        }
    }
    private static void OwnedLocked(string directory)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        TraceCacheAction(NativeStallTrace.Stage.OwnedSafeEnter, NativeStallTrace.Stage.OwnedSafeExit, () => RequireSafe(directory));
        var exists = TraceCacheValue(NativeStallTrace.Stage.OwnedDirectoryExistsEnter, NativeStallTrace.Stage.OwnedDirectoryExistsExit, () => Directory.Exists(directory));
        if (!exists) {
            if (TraceCacheValue(NativeStallTrace.Stage.OwnedFileExistsEnter, NativeStallTrace.Stage.OwnedFileExistsExit, () => File.Exists(directory))) throw new TransferException("Hydration cache is unavailable.");
            TraceCacheAction(NativeStallTrace.Stage.OwnedCreateEnter, NativeStallTrace.Stage.OwnedCreateExit, () => Directory.CreateDirectory(directory));
            var createdPath = Path.Combine(directory, Marker);
            using var marker = TraceCacheValue(NativeStallTrace.Stage.OwnedMarkerOpenEnter, NativeStallTrace.Stage.OwnedMarkerOpenExit, () => new FileStream(createdPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None));
            var expected = System.Text.Encoding.UTF8.GetBytes(Owner);
            TraceCacheAction(NativeStallTrace.Stage.OwnedMarkerWriteEnter, NativeStallTrace.Stage.OwnedMarkerWriteExit, () => marker.Write(expected));
            TraceCacheAction(NativeStallTrace.Stage.OwnedMarkerFlushEnter, NativeStallTrace.Stage.OwnedMarkerFlushExit, () => marker.Flush(true));
#if LEDGETOP_CACHE_RACE_TEST
            CreatedMarkerTestHook?.Invoke(createdPath);
#endif
            TraceCacheAction(NativeStallTrace.Stage.OwnedMarkerSafeEnter, NativeStallTrace.Stage.OwnedMarkerSafeExit, () => RequireSafe(createdPath));
            if (!TraceCacheValue(NativeStallTrace.Stage.OwnedMarkerVerifyEnter, NativeStallTrace.Stage.OwnedMarkerVerifyExit, () => VerifyCreatedMarker(marker, expected))) throw new TransferException("Hydration cache is not owned by this application.");
            return;
        }
        var path = Path.Combine(directory, Marker);
        TraceCacheAction(NativeStallTrace.Stage.OwnedMarkerSafeEnter, NativeStallTrace.Stage.OwnedMarkerSafeExit, () => RequireSafe(path));
        if (!TraceCacheValue(NativeStallTrace.Stage.OwnedMarkerVerifyEnter, NativeStallTrace.Stage.OwnedMarkerVerifyExit, () =>
            TraceCacheValue(NativeStallTrace.Stage.OwnedVerifyExistsEnter, NativeStallTrace.Stage.OwnedVerifyExistsExit, () => File.Exists(path)) &&
            TraceCacheValue(NativeStallTrace.Stage.OwnedVerifyLengthEnter, NativeStallTrace.Stage.OwnedVerifyLengthExit, () => new FileInfo(path).Length) <= 128 &&
            TraceCacheValue(NativeStallTrace.Stage.OwnedVerifyReadEnter, NativeStallTrace.Stage.OwnedVerifyReadExit, () => ReadOwnerMarker(path)) == Owner)) throw new TransferException("Hydration cache is not owned by this application.");
#else
        RequireSafe(directory);
        if (!Directory.Exists(directory)) {
            if (File.Exists(directory)) throw new TransferException("Hydration cache is unavailable.");
            Directory.CreateDirectory(directory);
            var createdPath = Path.Combine(directory, Marker);
            using var marker = new FileStream(createdPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            var expected = System.Text.Encoding.UTF8.GetBytes(Owner);
            marker.Write(expected); marker.Flush(true); RequireSafe(createdPath);
#if LEDGETOP_CACHE_RACE_TEST
            CreatedMarkerTestHook?.Invoke(createdPath);
#endif
            if (!VerifyCreatedMarker(marker, expected)) throw new TransferException("Hydration cache is not owned by this application.");
            return;
        }
        var path = Path.Combine(directory, Marker); RequireSafe(path);
        if (!File.Exists(path) || new FileInfo(path).Length > 128 || File.ReadAllText(path) != Owner) throw new TransferException("Hydration cache is not owned by this application.");
#endif
    }
    private static string ReadOwnerMarker(string path)
    {
#if LEDGETOP_CACHE_RACE_TEST
        OwnerMarkerReadTestHook?.Invoke(path);
#endif
#if LEDGETOP_NATIVE_DIAGNOSTICS
        StreamReader? reader = null;
        try
        {
            TraceCacheAction(NativeStallTrace.Stage.OwnedVerifyReaderOpenEnter, NativeStallTrace.Stage.OwnedVerifyReaderOpenExit,
                () => reader = new StreamReader(path, System.Text.Encoding.UTF8, detectEncodingFromByteOrderMarks: true));
            return TraceCacheValue(NativeStallTrace.Stage.OwnedVerifyContentReadEnter, NativeStallTrace.Stage.OwnedVerifyContentReadExit,
                () => reader!.ReadToEnd());
        }
        finally
        {
            if (reader is not null)
                TraceCacheAction(NativeStallTrace.Stage.OwnedVerifyReaderDisposeEnter, NativeStallTrace.Stage.OwnedVerifyReaderDisposeExit,
                    reader.Dispose);
        }
#else
        return File.ReadAllText(path);
#endif
    }
    // The newly created marker is exclusively open through flush, path safety
    // validation and readback. Verify those same bytes without a second open.
    private static bool VerifyCreatedMarker(FileStream marker, byte[] expected)
    {
        if (expected.Length > 128 || marker.Length != expected.Length) return false;
        marker.Position = 0;
        var actual = new byte[expected.Length]; marker.ReadExactly(actual);
        return actual.AsSpan().SequenceEqual(expected);
    }
    private static bool OwnedExisting(string directory)
    {
#if LEDGETOP_NATIVE_DIAGNOSTICS
        TraceCacheAction(NativeStallTrace.Stage.CacheOwnerPathSafeEnter, NativeStallTrace.Stage.CacheOwnerPathSafeExit, () => RequireSafe(directory));
        if (!TraceCacheValue(NativeStallTrace.Stage.CacheOwnerDirectoryExistsEnter, NativeStallTrace.Stage.CacheOwnerDirectoryExistsExit, () => Directory.Exists(directory))) {
            if (TraceCacheValue(NativeStallTrace.Stage.CacheOwnerFileExistsEnter, NativeStallTrace.Stage.CacheOwnerFileExistsExit, () => File.Exists(directory)))
                throw new TransferException("Cache directory changed type.");
            return false;
        }
        var tracedPath = Path.Combine(directory, Marker);
        TraceCacheAction(NativeStallTrace.Stage.CacheOwnerMarkerPathSafeEnter, NativeStallTrace.Stage.CacheOwnerMarkerPathSafeExit, () => RequireSafe(tracedPath));
        var markerExists = TraceCacheValue(NativeStallTrace.Stage.CacheOwnerMarkerExistsEnter, NativeStallTrace.Stage.CacheOwnerMarkerExistsExit, () => File.Exists(tracedPath));
        var markerLength = markerExists ? TraceCacheValue(NativeStallTrace.Stage.CacheOwnerMarkerLengthEnter, NativeStallTrace.Stage.CacheOwnerMarkerLengthExit, () => new FileInfo(tracedPath).Length) : long.MaxValue;
        var markerContents = markerExists && markerLength <= 128
            ? TraceCacheValue(NativeStallTrace.Stage.CacheOwnerMarkerReadEnter, NativeStallTrace.Stage.CacheOwnerMarkerReadExit, () => File.ReadAllText(tracedPath))
            : null;
        if (!markerExists || markerLength > 128 || markerContents != Owner) throw new TransferException("Cache ownership is unavailable.");
#else
        RequireSafe(directory);
        if (!Directory.Exists(directory)) {
            if (File.Exists(directory)) throw new TransferException("Cache directory changed type.");
            return false;
        }
        var path = Path.Combine(directory, Marker); RequireSafe(path);
        if (!File.Exists(path) || new FileInfo(path).Length > 128 || File.ReadAllText(path) != Owner)
            throw new TransferException("Cache ownership is unavailable.");
#endif
        return true;
    }
    private static class CacheNative
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct FileIdInfo { internal ulong VolumeSerialNumber, IdLow, IdHigh; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        internal static extern SafeFileHandle CreateFileW(string path, uint access, uint share, nint security, uint disposition, uint flags, nint template);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, out FileIdInfo info, uint size);
        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, ref byte disposition, uint size);
    }
    private void VerifyOwnedRoot()
    {
        if (rootOwnerPin is { } pin)
        {
#if LEDGETOP_NATIVE_DIAGNOSTICS
            TraceCacheAction(NativeStallTrace.Stage.RootOwnerPinVerifyEnter, NativeStallTrace.Stage.RootOwnerPinVerifyExit, pin.Verify);
#else
            pin.Verify();
#endif
            return;
        }
        RequireSafe(root); Owned(root);
    }
    private bool OwnedExistingCached(string directory)
    {
        var canonical = Path.GetFullPath(directory);
        if (!OperatingSystem.IsWindows()) return OwnedExisting(canonical);
        if (string.Equals(canonical, root, StringComparison.OrdinalIgnoreCase)) { VerifyOwnedRoot(); return true; }
        if (ownedDirectoryPins.TryGetValue(canonical, out var cached)) { cached.Verify(); return true; }
        var gate = OwnedDirectoryGates[StringComparer.OrdinalIgnoreCase.GetHashCode(canonical) & (OwnedDirectoryGates.Length - 1)];
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            if (ownedDirectoryPins.TryGetValue(canonical, out cached)) { cached.Verify(); return true; }
            cached = RootOwnerPin.TryAcquireShared(canonical);
            if (cached is not null)
            {
                if (TryCacheOwnedDirectoryPin(canonical, cached)) { cached.Verify(); return true; }
                cached.Dispose();
            }
            if (Volatile.Read(ref ownedDirectoryPinCount) >= MaximumOwnedDirectoryPins) return OwnedExisting(canonical);
            var pin = RootOwnerPin.TryOpenExisting(canonical);
            if (pin is null) return false;
            pin = RootOwnerPin.Register(pin);
            if (!TryCacheOwnedDirectoryPin(canonical, pin)) pin.Dispose();
            return true;
        }
    }
    private void OwnPinned(string directory)
    {
        var canonical = Path.GetFullPath(directory);
        if (!OperatingSystem.IsWindows()) { Owned(canonical); return; }
        if (string.Equals(canonical, root, StringComparison.OrdinalIgnoreCase)) { VerifyOwnedRoot(); return; }
        if (OwnedExistingCached(canonical)) return;
        var gate = OwnedDirectoryGates[StringComparer.OrdinalIgnoreCase.GetHashCode(canonical) & (OwnedDirectoryGates.Length - 1)];
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            if (ownedDirectoryPins.TryGetValue(canonical, out var cached)) { cached.Verify(); return; }
            cached = RootOwnerPin.TryAcquireShared(canonical);
            if (cached is not null)
            {
                if (TryCacheOwnedDirectoryPin(canonical, cached)) { cached.Verify(); return; }
                cached.Dispose();
            }
            if (Volatile.Read(ref ownedDirectoryPinCount) >= MaximumOwnedDirectoryPins) { Owned(canonical); return; }
            var pin = RootOwnerPin.AcquireOrCreate(canonical);
            if (!TryCacheOwnedDirectoryPin(canonical, pin)) pin.Dispose();
        }
    }
    private bool TryCacheOwnedDirectoryPin(string canonical, RootOwnerPin pin)
    {
#if LEDGETOP_CACHE_RACE_TEST
        BeforeOwnedPinRegistrationTestHook?.Invoke(canonical);
#endif
        // Serialize registration with Dispose so every successfully cached reference
        // is either visible to the disposer or rejected and released by its caller.
        lock (ownedDirectoryPinsSync)
        {
            if (Volatile.Read(ref disposed) != 0 || ownedDirectoryPinCount >= MaximumOwnedDirectoryPins ||
                !ownedDirectoryPins.TryAdd(canonical, pin))
                return false;
            ownedDirectoryPinCount++;
            return true;
        }
    }
#if LEDGETOP_CACHE_RACE_TEST
    internal string RootOwnershipDirectoryForTest => root;
    internal bool OwnedExistingCachedForTest(string directory) => OwnedExistingCached(directory);
#endif
    private sealed class RootOwnerPin : IDisposable
    {
        private static readonly object SharedPinsSync = new();
        private static readonly Dictionary<string, RootOwnerPin> SharedPins = new(StringComparer.OrdinalIgnoreCase);
        private readonly string directory, markerPath;
        private readonly SafeFileHandle directoryHandle;
        private readonly FileStream markerStream;
        private readonly CacheNative.FileIdInfo directoryId, markerId;
        private readonly ReaderWriterLockSlim lifetime = new(LockRecursionPolicy.NoRecursion);
        private int disposeRequested;
        private int references = 1;
        private int handlesClosed;
        private RootOwnerPin(string directory, string markerPath, SafeFileHandle directoryHandle, FileStream markerStream,
            CacheNative.FileIdInfo directoryId, CacheNative.FileIdInfo markerId)
        {
            this.directory = directory; this.markerPath = markerPath; this.directoryHandle = directoryHandle;
            this.markerStream = markerStream; this.directoryId = directoryId; this.markerId = markerId;
        }
        internal static RootOwnerPin Open(string directory)
        {
            var markerPath = Path.Combine(directory, Marker);
            RequireSafe(directory); RequireSafe(markerPath);
            SafeFileHandle? directoryHandle = null;
            FileStream? markerStream = null;
            try
            {
                directoryHandle = CacheNative.CreateFileW(NativeCacheFilePath(directory), 0x80, 1, 0, 3, 0x02200000, 0);
                if (directoryHandle.IsInvalid) throw new IOException("Hydration cache root identity is unavailable.", Marshal.GetHRForLastWin32Error());
                var markerHandle = CacheNative.CreateFileW(NativeCacheFilePath(markerPath), 0x81, 1, 0, 3, 0x00200000, 0);
                if (markerHandle.IsInvalid) { markerHandle.Dispose(); throw new IOException("Hydration owner marker identity is unavailable.", Marshal.GetHRForLastWin32Error()); }
                markerStream = new FileStream(markerHandle, FileAccess.Read, 128, isAsync: false);
                if (markerStream.Length > 128) throw new TransferException("Hydration cache is not owned by this application.");
                var content = new byte[checked((int)markerStream.Length)];
                markerStream.ReadExactly(content);
                if (System.Text.Encoding.UTF8.GetString(content) != Owner)
                    throw new TransferException("Hydration cache is not owned by this application.");
                markerStream.Position = 0;
                RequireSafe(directory); RequireSafe(markerPath);
                var directoryId = GetIdentity(directoryHandle, "Hydration cache root identity is unavailable.");
                var markerId = GetIdentity(markerStream.SafeFileHandle, "Hydration owner marker identity is unavailable.");
                return new RootOwnerPin(directory, markerPath, directoryHandle, markerStream, directoryId, markerId);
            }
            catch { markerStream?.Dispose(); directoryHandle?.Dispose(); throw; }
        }
        internal static RootOwnerPin? TryAcquireShared(string directory)
        {
            var canonical = Path.GetFullPath(directory);
            lock (SharedPinsSync)
            {
                if (!SharedPins.TryGetValue(canonical, out var pin)) return null;
                checked { pin.references++; }
                return pin;
            }
        }
        internal static RootOwnerPin AcquireExisting(string directory)
        {
            var shared = TryAcquireShared(directory);
            return shared ?? Register(Open(directory));
        }
        internal static RootOwnerPin AcquireOrCreate(string directory)
        {
            var shared = TryAcquireShared(directory);
            if (shared is not null) return shared;
            return Register(TryOpenExisting(directory) ?? Create(directory));
        }
        internal static RootOwnerPin Register(RootOwnerPin pin)
        {
            var canonical = Path.GetFullPath(pin.directory);
            lock (SharedPinsSync)
            {
                if (SharedPins.TryGetValue(canonical, out var existing))
                {
                    checked { existing.references++; }
                    pin.CloseHandles();
                    return existing;
                }
                SharedPins.Add(canonical, pin);
                return pin;
            }
        }
        internal static RootOwnerPin? TryOpenExisting(string directory)
        {
            RequireSafe(directory);
            if (!Directory.Exists(directory))
            {
                if (File.Exists(directory)) throw new TransferException("Cache directory changed type.");
                return null;
            }
            return Open(directory);
        }
        internal static RootOwnerPin Create(string directory)
        {
            RequireSafe(directory);
            if (Directory.Exists(directory)) return Open(directory);
            if (File.Exists(directory)) throw new TransferException("Cache directory changed type.");
            Directory.CreateDirectory(directory);
            var markerPath = Path.Combine(directory, Marker);
            RequireSafe(directory); RequireSafe(markerPath);
            var directoryGuard = CacheNative.CreateFileW(NativeCacheFilePath(directory), 0x80, 1, 0, 3, 0x02200000, 0);
            if (directoryGuard.IsInvalid) throw new IOException("Hydration cache root identity is unavailable.", Marshal.GetHRForLastWin32Error());
            var directoryId = GetIdentity(directoryGuard, "Hydration cache root identity is unavailable.");
            FileStream? markerStream = null;
            try
            {
                markerStream = new FileStream(markerPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
                var expected = System.Text.Encoding.UTF8.GetBytes(Owner);
                markerStream.Write(expected); markerStream.Flush(true);
#if LEDGETOP_CACHE_RACE_TEST
                CreatedMarkerTestHook?.Invoke(markerPath);
#endif
                RequireSafe(directory); RequireSafe(markerPath);
                if (!VerifyCreatedMarker(markerStream, expected)) throw new TransferException("Hydration cache is not owned by this application.");
                markerStream.Position = 0;
                var markerId = GetIdentity(markerStream.SafeFileHandle, "Hydration owner marker identity is unavailable.");
                var pin = new RootOwnerPin(directory, markerPath, directoryGuard, markerStream, directoryId, markerId);
                directoryGuard.SetHandleAsInvalid();
                markerStream = null;
                return pin;
            }
            catch { markerStream?.Dispose(); directoryGuard.Dispose(); throw; }
        }
        internal void Verify()
        {
            if (Volatile.Read(ref disposeRequested) != 0) throw new ObjectDisposedException(nameof(PlaceholderHydrationCoordinator));
            lifetime.EnterReadLock();
            try
            {
                if (Volatile.Read(ref disposeRequested) != 0) throw new ObjectDisposedException(nameof(PlaceholderHydrationCoordinator));
                RequireSafe(directory); RequireSafe(markerPath);
                using var currentDirectory = CacheNative.CreateFileW(NativeCacheFilePath(directory), 0x80, 1, 0, 3, 0x02200000, 0);
                if (currentDirectory.IsInvalid || !SameIdentity(directoryId, GetIdentity(currentDirectory, "Hydration cache root identity is unavailable.")))
                    throw new TransferException("Hydration cache root identity changed.");
                using var currentMarker = CacheNative.CreateFileW(NativeCacheFilePath(markerPath), 0x80, 1, 0, 3, 0x00200000, 0);
                if (currentMarker.IsInvalid || !SameIdentity(markerId, GetIdentity(currentMarker, "Hydration owner marker identity is unavailable.")))
                    throw new TransferException("Hydration owner marker identity changed.");
            }
            finally { lifetime.ExitReadLock(); }
        }
        private static CacheNative.FileIdInfo GetIdentity(SafeFileHandle handle, string message)
        {
            var size = (uint)Marshal.SizeOf<CacheNative.FileIdInfo>();
            if (!CacheNative.GetFileInformationByHandleEx(handle, 18, out var identity, size))
                throw new TransferException(message);
            return identity;
        }
        private static bool SameIdentity(CacheNative.FileIdInfo left, CacheNative.FileIdInfo right) =>
            left.VolumeSerialNumber == right.VolumeSerialNumber && left.IdLow == right.IdLow && left.IdHigh == right.IdHigh;
        public void Dispose()
        {
            lock (SharedPinsSync)
            {
                if (references <= 0) return;
                references--;
                if (references != 0) return;
                SharedPins.Remove(Path.GetFullPath(directory));
                Interlocked.Exchange(ref disposeRequested, 1);
                CloseHandles();
            }
        }
        private void CloseHandles()
        {
            if (Interlocked.Exchange(ref handlesClosed, 1) != 0) return;
            lifetime.EnterWriteLock();
            try { markerStream.Dispose(); directoryHandle.Dispose(); }
            finally { lifetime.ExitWriteLock(); }
        }
    }
    private static bool SameFileIdentity(FileStream expected, FileStream actual)
    {
        var size = (uint)Marshal.SizeOf<CacheNative.FileIdInfo>();
        if (!CacheNative.GetFileInformationByHandleEx(expected.SafeFileHandle, 18, out var left, size) ||
            !CacheNative.GetFileInformationByHandleEx(actual.SafeFileHandle, 18, out var right, size))
            throw new TransferException("Hydration reservation file identity is unavailable.");
        return left.VolumeSerialNumber == right.VolumeSerialNumber && left.IdLow == right.IdLow && left.IdHigh == right.IdHigh;
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
    public void Dispose()
    {
        RootOwnerPin[] pins;
        lock (ownedDirectoryPinsSync)
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            pins = ownedDirectoryPins.Values.ToArray();
            ownedDirectoryPins.Clear();
            ownedDirectoryPinCount = 0;
        }
        rootOwnerPin?.Dispose();
        foreach (var pin in pins) pin.Dispose();
    }
}
