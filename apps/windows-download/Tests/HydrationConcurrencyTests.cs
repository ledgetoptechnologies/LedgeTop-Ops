using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using LedgeTop.WindowsDownload;

internal static class HydrationConcurrencyTests
{
    private const string Principal = "odqp1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static readonly byte[] Bytes = Enumerable.Range(0, 8192).Select(i => (byte)(i % 251)).ToArray();
    private static readonly string Sha = Convert.ToHexStringLower(SHA256.HashData(Bytes));
    private static PlaceholderIdentity Identity(int i) => new("pilot", "portal", "https://concurrency.example.invalid", Principal,
        "odqr1_" + i, "ondf1_" + new string((char)('a' + i), 64), "v1", "sample" + i + ".bin", Bytes.Length, "\"v1\"", Sha);
    internal static IEnumerable<(string Name, Func<Task> Run)> Groups => [
        ("quota preserves unverified exact-shaped reservation temporaries and refuses admission", StaleReservationTemporaryRecovery),
#if LEDGETOP_CACHE_RACE_TEST
        ("concurrent cache ownership initialization serializes marker creation", ConcurrentOwnershipInitialization),
        ("coordinator disposal releases a pin acquired before registration", DisposeDuringPinRegistration),
        ("pinned ownership markers avoid hot-path reads and prevent mutation while active", RootOwnerPinHotPath),
        ("new hydration marker remains exclusively held through verification", CreatedMarkerExclusive),
        ("disappearing cache entry refuses admission without publishing and permits a later explicit retry", CacheDisappears),
        ("cache promotion waits for quota scan while concurrent downloads remain active", () => PromotionWaits(0)),
        ("cancellation while promotion waits does not publish the file", () => PromotionWaits(1)),
        ("generation cancellation while promotion waits does not publish the file", () => PromotionWaits(2)),
        ("custom source exclusively drains local hydration slots and remains compatible", UnknownSource),
        ("custom-source admission drains active slots and cancels queued exclusive requests", UnknownDrain),
        ("custom admission releases cancelled waiters and completes other queued requests", UnknownWaiters),
        ("quota timeout retains exact reservation and retry safely recovers", ReservationReleaseTimeout),
        ("byte-identical reservation path replacement during publish is refused", ReservationPathSwapRefused),
        ("cancellation after reservation guard opens prevents publication", ReservationGuardCancellation),
        ("cancellation after reservation replacement preserves foreign path", ReservationGuardCancellationReplacement),
        ("active reservation survives queued same-entry hydration and eviction while legacy lease remains held", ActiveReservationExcludesStaleRemoval),
#endif
        ("hydration concurrency shares four distinct slots across coordinators and cancels queued work", Distinct),
        ("hydration concurrency excludes duplicate entries but independently authorizes and settles sinks", SameEntry),
        ("failed cache preparation releases entry lease before sink failure and permits retry", PreparationFailureReleasesLease),
        ("hydration concurrency reserves capacity before network and releases exact records after cancellation", Quota),
        ("hydration concurrency rejected distinct admissions do not consume marker bytes beyond quota", DeniedMetadata),
        ("hydration concurrency reclaims only exact stale records under the exclusive entry lease", Stale),
        ("hydration concurrency cancellation retains counted owned partial and resumes verified bytes", Partial),
        ("hydration concurrency reservation cleanup cannot mask primary cancellation or source failure", CleanupFailure),
        ("hydration concurrency promoted-cache crash records reconcile on cache hit and offline eviction", PromotedStale),
        ("corrupted cached bytes are rejected before any native sink write", CorruptCacheHit),
        ("hydration concurrency rejects malformed and foreign durable reservations without deleting them", Reservations),
        ("hydration concurrency excludes legacy leases and does not hold short quota lock over network", Legacy),
        ("hydration concurrency eviction waits matching sink while unrelated entry progresses", Eviction),
        ("hydration concurrency dispatcher stop drains four active and one queued request exactly once", Drain),
        ("hydration concurrency metadata growth uses the actual bounded downloader serialization", Metadata),
        ("hydration scope rejects foreign and malformed existing ownership markers", ForeignScopeMarkers)
    ];
    private static void Check(bool value) { if (!value) throw new InvalidOperationException("Concurrency assertion failed."); }
    private static async Task Reject(Task task) { try { await task.WaitAsync(TimeSpan.FromSeconds(5)); } catch (Exception e) when (e is TransferException or IOException) { return; } throw new InvalidOperationException("Expected refusal."); }
    private static async Task Cancelled(Task task) { try { await task.WaitAsync(TimeSpan.FromSeconds(5)); } catch (OperationCanceledException) { return; } throw new InvalidOperationException("Expected cancellation."); }
    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
#if LEDGETOP_CACHE_RACE_TEST
    private static async Task ReservationGuardCancellationReplacement()
    {
        if (!OperatingSystem.IsWindows()) return;
        foreach (var swapStage in new[] { "before-open", "after-open", "before-disposition", "disposition-failure" }) {
            using var f = new Fixture(); var id = Identity(0); using var cancellation = new CancellationTokenSource();
            var reservation = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2", id.ScopeKey + "-" + id.CacheKey + ".json");
            string? temporary = null, displaced = null; byte[]? replacement = null;
            void Swap(string temp) {
                temporary = temp; displaced = temp + ".displaced"; File.Move(temp, displaced);
                File.Copy(displaced, temp); replacement = File.ReadAllBytes(temp); cancellation.Cancel();
            }
            if (swapStage == "before-open") PlaceholderHydrationCoordinator.BeforeReservationGuardOpenTestHook = Swap;
            else if (swapStage == "after-open") PlaceholderHydrationCoordinator.AfterReservationGuardOpenTestHook = _ =>
                Swap(Directory.GetFiles(Path.GetDirectoryName(reservation)!, Path.GetFileName(reservation) + ".*.tmp").Single());
            else {
                PlaceholderHydrationCoordinator.AfterReservationGuardOpenTestHook = _ => {
                    temporary = Directory.GetFiles(Path.GetDirectoryName(reservation)!, Path.GetFileName(reservation) + ".*.tmp").Single();
                    displaced = temporary + ".displaced"; replacement = File.ReadAllBytes(temporary); cancellation.Cancel();
                };
                PlaceholderHydrationCoordinator.BeforeCancelledTemporaryDispositionTestHook = path => {
                    if (swapStage == "disposition-failure") throw new IOException("Synthetic disposition failure.");
                    File.Move(path, displaced!); File.WriteAllBytes(path, replacement!);
                };
            }
            try {
                await Cancelled(f.Run(0, token: cancellation.Token));
                Check(temporary is not null && displaced is not null && replacement is not null &&
                    (swapStage is "before-disposition" or "disposition-failure" ? !File.Exists(displaced) : File.Exists(displaced)) &&
                    File.Exists(temporary) && File.ReadAllBytes(temporary).AsSpan().SequenceEqual(replacement) &&
                    !File.Exists(reservation) && f.Source.Downloads == 0);
            } finally {
                PlaceholderHydrationCoordinator.BeforeReservationGuardOpenTestHook = null;
                PlaceholderHydrationCoordinator.AfterReservationGuardOpenTestHook = null;
                PlaceholderHydrationCoordinator.BeforeCancelledTemporaryDispositionTestHook = null;
            }
        }
    }
    private static async Task ReservationGuardCancellation()
    {
        using var f = new Fixture(); var id = Identity(0); var entered = Signal(); using var release = new ManualResetEventSlim();
        using var cancellation = new CancellationTokenSource(); var sink = new Sink();
        var reservation = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2", id.ScopeKey + "-" + id.CacheKey + ".json");
        PlaceholderHydrationCoordinator.AfterReservationGuardOpenTestHook = path => {
            if (!StringComparer.OrdinalIgnoreCase.Equals(path, reservation)) return;
            entered.TrySetResult(); if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Guard hook did not resume.");
        };
        var operation = Task.Run(() => f.Run(0, sink: sink, token: cancellation.Token));
        try {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancellation.Cancel(); release.Set();
            await Cancelled(operation);
            var folder = Path.GetDirectoryName(reservation)!;
            var remaining = Directory.EnumerateFiles(folder, "*.tmp").ToArray();
            Check(!File.Exists(reservation) && f.Source.Downloads == 0 && sink.Complete == 0 && sink.Failed == 1);
            PlaceholderHydrationCoordinator.AfterReservationGuardOpenTestHook = null;
            if (OperatingSystem.IsWindows()) {
                Check(remaining.Length == 0);
                await f.Run(0).WaitAsync(TimeSpan.FromSeconds(5)); // Exact cleanup permits a normal retry.
                Check(f.Source.Downloads == 1 && !File.Exists(reservation));
            } else {
                // Portable fallback cannot prove exact object identity for deletion. Preserve
                // the record, and require admission to fail closed without downloading.
                Check(remaining.Length == 1); var before = File.ReadAllBytes(remaining[0]);
                await Reject(f.Run(0));
                Check(f.Source.Downloads == 0 && File.Exists(remaining[0]) && File.ReadAllBytes(remaining[0]).AsSpan().SequenceEqual(before));
            }
        } finally {
            release.Set(); PlaceholderHydrationCoordinator.AfterReservationGuardOpenTestHook = null;
            try { await operation.WaitAsync(TimeSpan.FromSeconds(5)); } catch (OperationCanceledException) { }
        }
    }
    private static async Task DisposeDuringPinRegistration()
    {
        if (!OperatingSystem.IsWindows()) return;
        var root = Path.Combine(Path.GetTempPath(), "ltt-owned-dispose-race-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var source = new Source();
        var coordinator = new PlaceholderHydrationCoordinator(source, "pilot", root, expectedPrincipal: Principal);
        var owned = Path.Combine(coordinator.RootOwnershipDirectoryForTest, "owned");
        Directory.CreateDirectory(owned);
        var marker = Path.Combine(owned, ".verified-hydration-owner");
        File.WriteAllText(marker, "LedgeTop.VerifiedHydration/1\n");
        using var acquired = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var hookCount = 0;
        PlaceholderHydrationCoordinator.BeforeOwnedPinRegistrationTestHook = directory => {
            if (!StringComparer.OrdinalIgnoreCase.Equals(directory, owned) || Interlocked.Increment(ref hookCount) != 1) return;
            acquired.Set();
            if (!release.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Pin registration race did not resume.");
        };
        Task<bool>? registration = null;
        try
        {
            registration = Task.Run(() => coordinator.OwnedExistingCachedForTest(owned));
            if (!acquired.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Directory pin was not acquired.");
            coordinator.Dispose();
            release.Set();
            Check(await registration.WaitAsync(TimeSpan.FromSeconds(5)));
            using var exclusive = new FileStream(marker, FileMode.Open, FileAccess.Write, FileShare.None);
        }
        finally
        {
            release.Set();
            PlaceholderHydrationCoordinator.BeforeOwnedPinRegistrationTestHook = null;
            if (registration is not null) try { await registration.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            coordinator.Dispose();
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task RootOwnerPinHotPath()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var f = new Fixture(); using var coordinator = f.Coordinator();
        var root = coordinator.RootOwnershipDirectoryForTest;
        var marker = Path.Combine(root, ".verified-hydration-owner");
        var markerReadCount = 0;
        PlaceholderHydrationCoordinator.OwnerMarkerReadTestHook = _ => Interlocked.Increment(ref markerReadCount);
        static void Refused(Action action, string operation)
        {
            try { action(); throw new InvalidOperationException($"Root owner pin permitted {operation}."); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        try
        {
            await f.Run(0, coordinator).WaitAsync(TimeSpan.FromSeconds(10));
            Check(Volatile.Read(ref markerReadCount) == 0);
            Refused(() => { using var stream = new FileStream(marker, FileMode.Open, FileAccess.Write, FileShare.Read); }, "marker writes");
            Refused(() => File.Delete(marker), "marker deletion");
            Refused(() => File.Move(marker, marker + ".moved"), "marker replacement");
            Refused(() => Directory.Move(root, root + ".moved"), "cache-root rename");
            Check(File.Exists(marker));
            Check(Volatile.Read(ref markerReadCount) == 0);
        }
        finally { PlaceholderHydrationCoordinator.OwnerMarkerReadTestHook = null; }
    }
    private static async Task ActiveReservationExcludesStaleRemoval()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var f = new Fixture(); using var other = f.Coordinator();
        var reached = Signal(); using var resume = new ManualResetEventSlim();
        using var cancelHydration = new CancellationTokenSource(); using var cancelEviction = new CancellationTokenSource();
        PlaceholderHydrationCoordinator.BeforeReservationReleaseTestHook = () => {
            reached.TrySetResult(); if (!resume.Wait(TimeSpan.FromSeconds(20))) throw new TimeoutException();
        };
        Task? first = null, second = null, eviction = null;
        var root = Path.Combine(f.Root, "verified-hydration-v1"); var id = Identity(0);
        var reservation = Path.Combine(root, ".hydration-reservations-v2", id.ScopeKey + "-" + id.CacheKey + ".json");
        var creationWasExclusive = 0;
        PlaceholderHydrationCoordinator.ReservationCreatedTestHook = created => {
            if (!string.Equals(Path.GetFullPath(created), Path.GetFullPath(reservation), StringComparison.OrdinalIgnoreCase)) return;
            static void ExpectDenied(Action action, string operation) {
                try { action(); throw new InvalidOperationException($"Active reservation allowed {operation} during creation."); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            ExpectDenied(() => { using var tamper = new FileStream(created, FileMode.Open, FileAccess.Write, FileShare.Read); }, "a write handle");
            ExpectDenied(() => File.Move(created, created + ".moved"), "a rename");
            ExpectDenied(() => File.Delete(created), "deletion");
            Check(File.ReadAllBytes(created).Length > 0);
            Interlocked.Exchange(ref creationWasExclusive, 1);
        };
        try {
            first = Task.Run(() => f.Run(0));
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Check(Volatile.Read(ref creationWasExclusive) == 1);
            Check(File.Exists(reservation)); var bytes = File.ReadAllBytes(reservation);
            var arrived = Signal(); var arrivals = 0;
            HydrationCacheConcurrency.BeforeEntryWaitTestHook = key => {
                if (key == id.ScopeKey + id.CacheKey && Interlocked.Increment(ref arrivals) == 2) arrived.TrySetResult();
            };
            second = f.Run(0, other, token: cancelHydration.Token);
            eviction = other.EvictVerifiedCacheAsync(id, cancelEviction.Token);
            await arrived.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Check(!second.IsCompleted && !eviction.IsCompleted);
            Check(await LegacyChild(Path.Combine(root, ".hydration-cache.lock"), "ReadWrite") == 17);
            Check(File.ReadAllBytes(reservation).SequenceEqual(bytes));
            try { using var tamper = new FileStream(reservation, FileMode.Open, FileAccess.Write, FileShare.Read); throw new InvalidOperationException("Active reservation allowed a write handle."); }
            catch (IOException) { }
            try { File.Move(reservation, reservation + ".moved"); throw new InvalidOperationException("Active reservation allowed a rename."); }
            catch (IOException) { }
            try { File.Delete(reservation); throw new InvalidOperationException("Active reservation allowed deletion."); }
            catch (IOException) { }
            Check(File.Exists(reservation));
            cancelHydration.Cancel(); cancelEviction.Cancel();
            await Cancelled(second); await Cancelled(eviction);
            Check(File.ReadAllBytes(reservation).SequenceEqual(bytes));
            PlaceholderHydrationCoordinator.BeforeReservationReleaseTestHook = null;
            await f.Run(1, other).WaitAsync(TimeSpan.FromSeconds(10)); // quota scan must count the other active reservation from its held handle
            resume.Set(); await first.WaitAsync(TimeSpan.FromSeconds(10));
            Check(!File.Exists(reservation));
            Check(await LegacyChild(Path.Combine(root, ".hydration-cache.lock"), "ReadWrite") == 0);
            await f.Run(0, other); // normal cache hit remains usable after teardown
        } finally {
            PlaceholderHydrationCoordinator.ReservationCreatedTestHook = null;
            PlaceholderHydrationCoordinator.BeforeReservationReleaseTestHook = null;
            HydrationCacheConcurrency.BeforeEntryWaitTestHook = null;
            cancelHydration.Cancel(); cancelEviction.Cancel(); resume.Set();
            if (second is not null) { try { await second.WaitAsync(TimeSpan.FromSeconds(10)); } catch (OperationCanceledException) { } }
            if (eviction is not null) { try { await eviction.WaitAsync(TimeSpan.FromSeconds(10)); } catch (OperationCanceledException) { } }
            if (first is not null) await first.WaitAsync(TimeSpan.FromSeconds(10));
        }
    }
    private static async Task ReservationPathSwapRefused()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var f = new Fixture(); var id = Identity(0);
        var reservation = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2", id.ScopeKey + "-" + id.CacheKey + ".json");
        var displaced = reservation + ".displaced"; var refused = false; var swapped = 0; var mismatchObserved = 0;
        PlaceholderHydrationCoordinator.AfterReservationMoveTestHook = published => {
            if (!string.Equals(Path.GetFullPath(published), Path.GetFullPath(reservation), StringComparison.OrdinalIgnoreCase)) return;
            File.Move(published, displaced);
            File.Copy(displaced, published); // Same bytes, different file identity.
            Interlocked.Exchange(ref swapped, 1);
        };
        PlaceholderHydrationCoordinator.ReservationIdentityTestHook = sameFile => { if (!sameFile) Interlocked.Exchange(ref mismatchObserved, 1); };
        try {
            try { await f.Run(0).WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (TransferException) { refused = true; }
            Check(refused && Volatile.Read(ref swapped) == 1 && Volatile.Read(ref mismatchObserved) == 1);
        } finally {
            PlaceholderHydrationCoordinator.AfterReservationMoveTestHook = null;
            PlaceholderHydrationCoordinator.ReservationIdentityTestHook = null;
            if (File.Exists(displaced)) {
                if (File.Exists(reservation)) File.Delete(reservation);
                File.Move(displaced, reservation);
            }
        }
    }
    private static async Task ReservationReleaseTimeout()
    {
        using var f = new Fixture(); var reached = Signal(); using var resume = new ManualResetEventSlim();
        using var releaseOwner = new ManualResetEventSlim(); Task? owner = null;
        PlaceholderHydrationCoordinator.BeforeReservationReleaseTestHook = () => { reached.TrySetResult(); if (!resume.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException(); };
        var sink = new Sink(); var first = Task.Run(() => f.Run(0, sink: sink));
        try {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            using var holder = await HydrationCacheConcurrency.AcquireAsync(Path.Combine(f.Root, "verified-hydration-v1"), "test-other", default);
            var ownerEntered = Signal();
            owner = Task.Run(() => { lock (holder.Quota) { ownerEntered.TrySetResult(); if (!releaseOwner.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException(); } });
            await ownerEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            HydrationQuotaGate.TestWait = TimeSpan.FromMilliseconds(120); resume.Set();
            try { await first.WaitAsync(TimeSpan.FromSeconds(3)); throw new InvalidOperationException("Expected quota refusal."); }
            catch (TransferException error) { Check(error.HydrationFailure?.Reason == TransferFailureReason.LocalCacheBusy); }
            var id = Identity(0); var reservation = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2", id.ScopeKey + "-" + id.CacheKey + ".json");
            Check(File.Exists(reservation) && File.ReadAllText(reservation).Contains(id.CacheKey, StringComparison.Ordinal));
            Check(sink.Failed == 1 && sink.Complete == 0 && !owner.IsCompleted);
            PlaceholderHydrationCoordinator.BeforeReservationReleaseTestHook = null;
            HydrationQuotaGate.TestWait = null; releaseOwner.Set(); await owner.WaitAsync(TimeSpan.FromSeconds(5));
            await f.Run(0).WaitAsync(TimeSpan.FromSeconds(5));
            Check(!File.Exists(reservation));
        } finally {
            PlaceholderHydrationCoordinator.BeforeReservationReleaseTestHook = null; HydrationQuotaGate.TestWait = null;
            resume.Set(); releaseOwner.Set();
            if (owner is not null) await owner.WaitAsync(TimeSpan.FromSeconds(5));
            try { await first.WaitAsync(TimeSpan.FromSeconds(5)); } catch (TransferException) { }
        }
    }
    private static async Task ConcurrentOwnershipInitialization()
    {
        if (!OperatingSystem.IsWindows()) return;
        var root = Path.Combine(Path.GetTempPath(), "ltt-owned-initialization-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        using var source = new Source();
        var owned = Path.Combine(root, "verified-hydration-v1");
        var marker = Path.Combine(owned, ".verified-hydration-owner");
        using var firstMarkerHeld = new ManualResetEventSlim();
        using var secondGateAttempted = new ManualResetEventSlim();
        using var releaseFirst = new ManualResetEventSlim();
        var gateAttempts = 0; var markerCreates = 0;
        PlaceholderHydrationCoordinator? first = null; PlaceholderHydrationCoordinator? second = null;
        Task? firstTask = null; Task? secondTask = null;
        PlaceholderHydrationCoordinator.BeforeOwnedDirectoryGateTestHook = path => {
            if (StringComparer.OrdinalIgnoreCase.Equals(path, owned) && Interlocked.Increment(ref gateAttempts) == 2) secondGateAttempted.Set();
        };
        PlaceholderHydrationCoordinator.CreatedMarkerTestHook = path => {
            if (!StringComparer.OrdinalIgnoreCase.Equals(path, marker) || Interlocked.Increment(ref markerCreates) != 1) return;
            firstMarkerHeld.Set();
            if (!releaseFirst.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Concurrent ownership test did not release the first marker.");
        };
        try {
            firstTask = Task.Run(() => first = new PlaceholderHydrationCoordinator(source, "pilot", root, expectedPrincipal: Principal));
            if (!firstMarkerHeld.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("First ownership marker was not held.");
            secondTask = Task.Run(() => second = new PlaceholderHydrationCoordinator(source, "pilot", root, expectedPrincipal: Principal));
            if (!secondGateAttempted.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Second coordinator did not reach the ownership gate.");
            releaseFirst.Set();
            await Task.WhenAll(firstTask, secondTask).WaitAsync(TimeSpan.FromSeconds(5));
            Check(markerCreates == 1 && File.ReadAllText(marker) == "LedgeTop.VerifiedHydration/1\n");
        } finally {
            releaseFirst.Set();
            PlaceholderHydrationCoordinator.BeforeOwnedDirectoryGateTestHook = null;
            PlaceholderHydrationCoordinator.CreatedMarkerTestHook = null;
            if (firstTask is not null) try { await firstTask.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            if (secondTask is not null) try { await secondTask.WaitAsync(TimeSpan.FromSeconds(5)); } catch { }
            first?.Dispose(); second?.Dispose();
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
    private static async Task CreatedMarkerExclusive()
    {
        if (!OperatingSystem.IsWindows()) return;
        using var f = new Fixture(); var attempted = 0;
        PlaceholderHydrationCoordinator.CreatedMarkerTestHook = path => {
            attempted++;
            try { File.Move(path, path + ".replacement"); throw new InvalidOperationException("Exclusive marker was replaceable."); }
            catch (IOException) { }
        };
        try { await f.Run(0); Check(attempted >= 2); }
        finally { PlaceholderHydrationCoordinator.CreatedMarkerTestHook = null; }
    }
#endif
    private static async Task ForeignScopeMarkers()
    {
        foreach (var contents in new[] { "foreign owner", new string('x', 129), "" }) {
            using var f = new Fixture();
            var scope = Path.Combine(f.Root, "verified-hydration-v1", Identity(0).ScopeKey);
            Directory.CreateDirectory(scope);
            var marker = Path.Combine(scope, ".verified-hydration-owner"); File.WriteAllText(marker, contents);
            var sink = new Sink(); await Reject(f.Run(0, sink: sink));
            Check(sink.Complete == 0 && sink.Failed == 1 && File.ReadAllText(marker) == contents);
        }
    }
#if LEDGETOP_CACHE_RACE_TEST
    private sealed class Unaware(Source source) : IQueuedDownloadSource
    {
        public string Alias => source.Alias; public Uri Origin => source.Origin;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) => source.GetSessionAsync(token);
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) => source.ResolveAsync(reference, token);
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => source.DownloadAsync(spec, destination, progress, cancellationToken);
    }
    private static async Task UnknownSource()
    {
        using var f = new Fixture(); using var coordinator = new PlaceholderHydrationCoordinator(new Unaware(f.Source), "pilot", f.Root, Bytes.Length, 1L << 30, Principal);
        var entered = Signal(); var release = Signal();
        f.Source.BeforeDownload = async (spec, token) => { if (spec.FileName == Identity(0).FileName) { entered.SetResult(); await release.Task.WaitAsync(token); } };
        var custom = f.Run(0, coordinator); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var normal = f.Run(1); Check(!normal.IsCompleted && f.Source.Downloads == 1);
        release.SetResult(); await Task.WhenAll(custom, normal).WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Source.Downloads == 2 && f.Source.Peak == 1);
        using var wrapped = new PlaceholderHydrationCoordinator(new LifetimeQueuedDownloadSource(new Unaware(f.Source), default), "pilot", f.Root, Bytes.Length, 1L << 30, Principal);
        await f.Run(2, wrapped); Check(f.Source.Downloads == 3);
    }
    private static async Task UnknownDrain()
    {
        using var f = new Fixture(); using var second = f.Coordinator();
        using var custom = new PlaceholderHydrationCoordinator(new Unaware(f.Source), "pilot", f.Root, Bytes.Length, 1L << 30, Principal);
        var entered1 = Signal(); var entered2 = Signal(); var release = Signal();
        f.Source.BeforeDownload = async (spec, token) => {
            if (spec.FileName == Identity(0).FileName) entered1.SetResult();
            if (spec.FileName == Identity(1).FileName) entered2.SetResult();
            await release.Task.WaitAsync(token);
        };
        var first = f.Run(0); var secondRun = f.Run(1, second);
        await Task.WhenAll(entered1.Task, entered2.Task).WaitAsync(TimeSpan.FromSeconds(5));
        using var cancellation = new CancellationTokenSource();
        var queued = f.Run(2, custom, token: cancellation.Token); Check(!queued.IsCompleted);
        cancellation.Cancel(); await Cancelled(queued);
        release.SetResult(); await Task.WhenAll(first, secondRun).WaitAsync(TimeSpan.FromSeconds(5));
        f.Source.BeforeDownload = null;
        await Task.WhenAll(f.Run(2, custom), f.Run(3, custom)).WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Source.Downloads == 4);
    }
    private static async Task UnknownWaiters()
    {
        using var f = new Fixture();
        using var custom = new PlaceholderHydrationCoordinator(new Unaware(f.Source), "pilot", f.Root, Bytes.Length, 1L << 30, Principal);
        var entered = Signal(); var release = Signal();
        f.Source.BeforeDownload = async (spec, token) => { if (spec.FileName == Identity(0).FileName) { entered.SetResult(); await release.Task.WaitAsync(token); } };
        var first = f.Run(0, custom); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var cancellation = new CancellationTokenSource();
        var waitingKnown = f.Run(1); var cancelledCustom = f.Run(2, custom, token: cancellation.Token); var waitingCustom = f.Run(3, custom);
        Check(!waitingKnown.IsCompleted && !cancelledCustom.IsCompleted && !waitingCustom.IsCompleted);
        cancellation.Cancel(); await Cancelled(cancelledCustom);
        release.SetResult(); await Task.WhenAll(first, waitingKnown, waitingCustom).WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Source.Downloads == 3);
    }
    private static async Task PromotionWaits(int cancelMode)
    {
        using var f = new Fixture(); await f.Run(0);
        var victim = Directory.EnumerateFiles(f.Root, Identity(0).FileName, SearchOption.AllDirectories).Single();
        var sourceEntered = Signal(); var sourceRelease = Signal(); var scanEntered = Signal(); var mutationEntered = Signal();
        using var scanRelease = new ManualResetEventSlim(false);
        f.Source.BeforeDownload = async (spec, token) => { if (spec.FileName == Identity(1).FileName) { sourceEntered.TrySetResult(); await sourceRelease.Task.WaitAsync(token); } };
        using var cancellation = new CancellationTokenSource(); using var generation = new CancellationTokenSource(); var sink = new Sink();
        using var owner = new PlaceholderHydrationCoordinator(new LifetimeQueuedDownloadSource(f.Source, generation.Token), "pilot", f.Root, Bytes.Length, 1L << 30, Principal);
        var first = f.Run(1, owner, sink, cancellation.Token); await sourceEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        PlaceholderHydrationCoordinator.CacheWalkTestHook = file => { if (StringComparer.OrdinalIgnoreCase.Equals(file, victim)) { scanEntered.TrySetResult(); if (!scanRelease.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException(); } };
        HydrationMutationScope.BeforeGateTestHook = () => mutationEntered.TrySetResult();
        Task? second = null;
        try {
            second = Task.Run(() => f.Run(2)); await scanEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            sourceRelease.TrySetResult(); await mutationEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Check(!first.IsCompleted);
            if (cancelMode == 1) cancellation.Cancel(); else if (cancelMode == 2) generation.Cancel();
        } finally { PlaceholderHydrationCoordinator.CacheWalkTestHook = null; HydrationMutationScope.BeforeGateTestHook = null; scanRelease.Set(); sourceRelease.TrySetResult(); }
        if (cancelMode != 0) { if (cancelMode == 1) await Cancelled(first); else await Reject(first); Check(sink.Complete == 0 && sink.Failed == 1 && !Directory.EnumerateFiles(f.Root, Identity(1).FileName, SearchOption.AllDirectories).Any()); }
        else await first.WaitAsync(TimeSpan.FromSeconds(5));
        if (second is not null) await second.WaitAsync(TimeSpan.FromSeconds(5));
    }
    private static async Task CacheDisappears()
    {
        using var f = new Fixture(); await f.Run(0);
        var victim = Directory.EnumerateFiles(f.Root, Identity(0).FileName, SearchOption.AllDirectories).Single();
        var wrote = false; var sink = new Sink { BeforeWrite = () => { wrote = true; return Task.CompletedTask; } };
        var callsBefore = f.Source.Downloads; var deleted = false;
        PlaceholderHydrationCoordinator.CacheWalkTestHook = file => {
            if (!deleted && StringComparer.OrdinalIgnoreCase.Equals(file, victim)) { File.Delete(victim); deleted = true; }
        };
        try {
            try { await f.Run(1, sink: sink); throw new InvalidOperationException("Expected cache scan refusal."); }
            catch (TransferException error) { Check(error.HydrationFailure?.Category == HydrationFailureCategory.LocalIO); }
            Check(deleted && !wrote && f.Source.Downloads == callsBefore && sink.Failed == 1 && sink.Complete == 0);
        } finally { PlaceholderHydrationCoordinator.CacheWalkTestHook = null; }
        await f.Run(1); Check(f.Source.Downloads == callsBefore + 1);
    }
#endif
    private static async Task Distinct()
    {
        using var f = new Fixture(); using var second = f.Coordinator();
        var four = Signal(); var release = Signal(); var entered = 0;
        f.Source.BeforeDownload = async (_, token) => { if (Interlocked.Increment(ref entered) == 4) four.TrySetResult(); await release.Task.WaitAsync(token); };
        var active = Enumerable.Range(0, 4).Select(i => f.Run(i, second)).ToArray(); await four.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var cancel = new CancellationTokenSource(); var sink = new Sink(); var queued = f.Run(4, second, sink, cancel.Token);
        Check(!queued.IsCompleted && f.Source.Downloads == 4); cancel.Cancel(); await Cancelled(queued); Check(sink.Failed == 1 && sink.Complete == 0);
        release.SetResult(); await Task.WhenAll(active).WaitAsync(TimeSpan.FromSeconds(5)); Check(f.Source.Peak == 4);
        Check(!Directory.EnumerateFiles(f.Root, "*.json", SearchOption.AllDirectories).Any(p => Path.GetFileName(Path.GetDirectoryName(p)) == ".hydration-reservations-v2"));
    }
    private static async Task SameEntry()
    {
        using var f = new Fixture(); using var second = f.Coordinator(); var entered = Signal(); var release = Signal();
        f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); };
        var s1 = new Sink(); var s2 = new Sink(); var first = f.Run(0, sink: s1); await entered.Task;
        var duplicate = f.Run(0, second, s2); Check(!duplicate.IsCompleted && f.Source.Downloads == 1);
        release.SetResult(); await Task.WhenAll(first, duplicate).WaitAsync(TimeSpan.FromSeconds(5));
        Check(f.Source.Downloads == 1 && f.Source.Resolves == 4 && s1.Complete == 1 && s2.Complete == 1 && s1.Failed + s2.Failed == 0);
    }
    private static async Task PreparationFailureReleasesLease()
    {
        using var f = new Fixture(); var id = Identity(0); var observed = false;
        f.Source.BeforeDownload = (_, _) => Task.FromException(new ResourceUnavailableException());
        var lockPath = Path.Combine(f.Root, "verified-hydration-v1", id.ScopeKey, id.CacheKey, ".hydration.lock");
        var sink = new Sink { OnFailure = () => {
            // The exact physical entry lease must be gone before the failure is
            // settled, even when preparation exits after acquiring the lease.
            using var probe = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            observed = true;
        } };
        await Reject(f.Run(0, sink: sink));
        Check(observed && sink.Failed == 1 && sink.Complete == 0);
        f.Source.BeforeDownload = null;
        var retried = new Sink(); await f.Run(0, sink: retried).WaitAsync(TimeSpan.FromSeconds(5));
        Check(retried.Complete == 1 && retried.Failed == 0);
    }
    private static async Task Quota()
    {
        using var f = new Fixture(); using var small1 = f.Coordinator(18000); using var small2 = f.Coordinator(18000);
        var entered = Signal(); var release = Signal(); f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); };
        using var cancel = new CancellationTokenSource(); var a = f.Run(0, small1, token: cancel.Token); await entered.Task;
        await Reject(f.Run(1, small2)); Check(f.Source.Downloads == 1);
        cancel.Cancel(); await Cancelled(a);
        f.Source.BeforeDownload = null; await f.Run(1, small2); Check(f.Source.Downloads == 2);
    }
    private static async Task StaleReservationTemporaryRecovery()
    {
        var id = Identity(0);
        var payloads = new[] {
            "foreign exact-shaped reservation temporary"u8.ToArray(),
            JsonSerializer.SerializeToUtf8Bytes(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey, Growth = 1L }),
            new byte[128 * 1024]
        };
        foreach (var payload in payloads) {
            using var f = new Fixture();
            await f.Run(0);
            var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
            var foreign = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json." + Guid.NewGuid().ToString("N") + ".tmp");
            var marker = Path.Combine(f.Root, "verified-hydration-v1", id.ScopeKey, id.CacheKey, id.FileName);
            var cached = File.ReadAllBytes(marker); var calls = f.Source.Downloads;
            using var measure = f.Coordinator();
            var method = typeof(PlaceholderHydrationCoordinator).GetMethod("CacheBytes", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance) ?? throw new IOException("Cache accounting unavailable.");
            var baseline = (long)method.Invoke(measure, null)!;
            File.WriteAllBytes(foreign, payload);
            Check((long)method.Invoke(measure, null)! == baseline + payload.Length);
            try { await f.Run(1); throw new InvalidOperationException("Expected review refusal."); }
            catch (TransferException error) {
                Check(error.HydrationFailure?.Reason == TransferFailureReason.LocalCacheReview &&
                    error.HydrationFailure.ActivityText.Contains("Keep existing files and contact LedgeTop support", StringComparison.Ordinal) &&
                    !error.HydrationFailure.ActivityText.Contains(f.Root, StringComparison.Ordinal));
            }
            Check(f.Source.Downloads == calls && File.ReadAllBytes(foreign).SequenceEqual(payload) && File.ReadAllBytes(marker).SequenceEqual(cached));
        }
        foreach (var link in new[] { false, true }) {
            using var f = new Fixture(); await f.Run(0);
            var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
            var foreign = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json." + Guid.NewGuid().ToString("N") + ".tmp");
            var target = Path.Combine(f.Root, "unrelated-target"); Directory.CreateDirectory(target);
            var sentinel = Path.Combine(target, "keep.txt"); File.WriteAllText(sentinel, "preserve");
            if (link) {
                try { Directory.CreateSymbolicLink(foreign, target); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or PlatformNotSupportedException) {
                    Console.WriteLine("SKIP synthetic reservation reparse test: " + error.GetType().Name); continue;
                }
            } else Directory.CreateDirectory(foreign);
            var calls = f.Source.Downloads; await Reject(f.Run(1));
            Check(Directory.Exists(foreign) && File.ReadAllText(sentinel) == "preserve" && f.Source.Downloads == calls);
        }
    }
    private static async Task Reservations()
    {
        using var f = new Fixture(); await f.Run(0);
        var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
        var foreign = Path.Combine(directory, "foreign.json"); File.WriteAllText(foreign, "{}");
        await Reject(f.Run(1)); Check(File.ReadAllText(foreign) == "{}" && f.Source.Downloads == 1);
        File.Delete(foreign); // Exact synthetic file created by this test, never cleanup unknown records.
        var id = Identity(1); var record = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json");
        File.WriteAllText(record, JsonSerializer.Serialize(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey, Growth = 0 }));
        await Reject(f.Run(1)); Check(File.Exists(record) && f.Source.Downloads == 1);
    }
    private static async Task DeniedMetadata()
    {
        using var f = new Fixture(); using var tiny = f.Coordinator(9000);
        var root = Path.Combine(f.Root, "verified-hydration-v1");
        var before = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Sum(p => new FileInfo(p).Length);
        for (var i = 0; i < 6; i++) {
            await Reject(f.Run(i, tiny));
            Check(Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Sum(p => new FileInfo(p).Length) == before);
            Check(!Directory.EnumerateDirectories(root).Any());
        }
        Check(f.Source.Downloads == 0);
    }
    private static async Task Stale()
    {
        using var f = new Fixture(); await f.Run(0);
        var id = Identity(1); var spec = new DownloadSpec(id.LogicalFileId + ":v1", new Uri(id.Origin + "/content"), id.FileName, id.Length, id.ETag, id.Sha256);
        var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
        var path = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json");
        // Simulate a crash after metadata creation. Recreate the precise owned entry/marker, not an unknown path.
        var entry = Path.Combine(f.Root, "verified-hydration-v1", id.ScopeKey, id.CacheKey); Directory.CreateDirectory(entry);
        File.WriteAllText(Path.Combine(entry, ".verified-hydration-owner"), "LedgeTop.VerifiedHydration/1\n");
        File.WriteAllText(path, JsonSerializer.Serialize(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey,
            Growth = checked(id.Length + Downloader.HydrationStateGrowthBudget(spec) + 1024) }));
        await f.Run(1); Check(f.Source.Downloads == 2 && !File.Exists(path));
    }
    private static async Task Partial()
    {
        using var f = new Fixture(); var waiting = Signal();
        f.Source.StreamFactory = () => new PrefixThenWait(waiting);
        using var cancel = new CancellationTokenSource(); var request = f.Run(0, token: cancel.Token);
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5)); cancel.Cancel(); await Cancelled(request);
        var part = Directory.EnumerateFiles(f.Root, "*.part", SearchOption.AllDirectories).Single();
        Check(new FileInfo(part).Length == 4096);
        Check(!Directory.EnumerateFiles(Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2"), "*.json").Any());
        f.Source.StreamFactory = null; var sink = new Sink(); await f.Run(0, sink: sink);
        Check(sink.Complete == 1 && sink.Failed == 0 && f.Source.Downloads == 2 && !File.Exists(part));
    }
    private static string ExactRecord(Fixture f, int i, long? overrideGrowth = null)
    {
        var id = Identity(i); var directory = Path.Combine(f.Root, "verified-hydration-v1", ".hydration-reservations-v2");
        var path = Path.Combine(directory, id.ScopeKey + "-" + id.CacheKey + ".json");
        File.WriteAllText(path, JsonSerializer.Serialize(new { Version = 2, Scope = id.ScopeKey, Entry = id.CacheKey,
            Growth = overrideGrowth ?? checked(id.Length + Downloader.HydrationStateGrowthBudget(id.Length, id.ETag, id.Sha256) + 1024) }));
        return path;
    }
    private static async Task CleanupFailure()
    {
        foreach (var cancelled in new[] { true, false }) {
            using var f = new Fixture(); using var cancel = new CancellationTokenSource(); var entered = Signal(); var release = Signal(); var sink = new Sink();
            f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); throw new ResourceUnavailableException(); };
            var operation = f.Run(0, sink: sink, token: cancel.Token); await entered.Task;
            var root = Path.Combine(f.Root, "verified-hydration-v1");
            using (var held = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                if (cancelled) { cancel.Cancel(); await Cancelled(operation); }
                else {
                    release.SetResult();
                    try { await operation.WaitAsync(TimeSpan.FromSeconds(5)); throw new InvalidOperationException("Expected primary failure."); }
                    catch (TransferException error) { Check(error.HydrationFailure?.Category == HydrationFailureCategory.ResourceUnavailable); }
                }
            }
            Check(sink.Failed == 1 && sink.Complete == 0 && Directory.EnumerateFiles(Path.Combine(root, ".hydration-reservations-v2"), "*.json").Count() == 1);
            f.Source.BeforeDownload = null; await f.Run(0);
            Check(!Directory.EnumerateFiles(Path.Combine(root, ".hydration-reservations-v2"), "*.json").Any());
        }
    }
    private static async Task PromotedStale()
    {
        using var f = new Fixture(); await f.Run(0); var path = ExactRecord(f, 0); var downloads = f.Source.Downloads;
        await f.Run(0); Check(f.Source.Downloads == downloads && !File.Exists(path));
        path = ExactRecord(f, 0); var resolves = f.Source.Resolves;
        using var offline = f.Coordinator(); await offline.EvictVerifiedCacheAsync(Identity(0));
        Check(!File.Exists(path) && f.Source.Resolves == resolves && f.Source.Downloads == downloads);
        await f.Run(0); path = ExactRecord(f, 0, 0); resolves = f.Source.Resolves;
        await Reject(offline.EvictVerifiedCacheAsync(Identity(0)));
        Check(File.Exists(path) && Directory.EnumerateFiles(f.Root, Identity(0).FileName, SearchOption.AllDirectories).Any() && f.Source.Resolves == resolves);
    }
    private static async Task CorruptCacheHit()
    {
        using var f = new Fixture(); await f.Run(0);
        var file = Directory.EnumerateFiles(f.Root, Identity(0).FileName, SearchOption.AllDirectories).Single();
        var changed = File.ReadAllBytes(file); changed[0] ^= 0xff; File.WriteAllBytes(file, changed);
        var writes = 0; var sink = new Sink { BeforeWrite = () => { writes++; return Task.CompletedTask; } };
        var downloads = f.Source.Downloads; await Reject(f.Run(0, sink: sink));
        Check(writes == 0 && sink.Complete == 0 && sink.Failed == 1 && f.Source.Downloads == downloads && File.ReadAllBytes(file).SequenceEqual(changed));
    }
    private sealed class PrefixThenWait(TaskCompletionSource waiting) : MemoryStream(Bytes)
    {
        private bool first = true;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            if (first) { first = false; return await base.ReadAsync(buffer[..Math.Min(4096, buffer.Length)], token); }
            waiting.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, token); return 0;
        }
    }
    private static async Task Legacy()
    {
        using var f = new Fixture(); await f.Run(0);
        var root = Path.Combine(f.Root, "verified-hydration-v1");
        using (var legacy = new FileStream(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) await Reject(f.Run(1));
        var entered = Signal(); var release = Signal(); f.Source.BeforeDownload = async (_, token) => { entered.SetResult(); await release.Task.WaitAsync(token); };
        var pending = f.Run(1); await entered.Task;
        try { using var legacy = new FileStream(Path.Combine(root, ".hydration-cache.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None); throw new InvalidOperationException("Expected legacy exclusion."); } catch (IOException) { }
        if (OperatingSystem.IsWindows()) foreach (var share in new[] { "None", "ReadWrite" }) Check(await LegacyChild(Path.Combine(root, ".hydration-cache.lock"), share) == 17);
        using (var shortQuota = new FileStream(Path.Combine(root, ".hydration-quota-v2.lock"), FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
        release.SetResult(); await pending;
        if (OperatingSystem.IsWindows()) foreach (var share in new[] { "None", "ReadWrite" }) Check(await LegacyChild(Path.Combine(root, ".hydration-cache.lock"), share) == 0);
    }
    private static async Task<int> LegacyChild(string path, string share)
    {
        var start = new System.Diagnostics.ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
        start.ArgumentList.Add("-NoProfile"); start.ArgumentList.Add("-NonInteractive"); start.ArgumentList.Add("-Command");
        start.ArgumentList.Add("try { $f = [IO.File]::Open($env:LEDGETOP_TEST_LEASE, 'Open', 'ReadWrite', $env:LEDGETOP_TEST_SHARE); $f.Dispose(); exit 0 } catch [IO.IOException] { exit 17 } catch { exit 18 }");
        start.Environment["LEDGETOP_TEST_LEASE"] = path;
        start.Environment["LEDGETOP_TEST_SHARE"] = share;
        using var child = System.Diagnostics.Process.Start(start) ?? throw new InvalidOperationException("Synthetic lease child failed to start.");
        try { await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
        catch (TimeoutException) { child.Kill(entireProcessTree: true); await child.WaitForExitAsync(); throw; }
        return child.ExitCode;
    }
    private static async Task Eviction()
    {
        using var f = new Fixture(); using var second = f.Coordinator(); var entered = Signal(); var release = Signal();
        var sink = new Sink { BeforeWrite = async () => { entered.TrySetResult(); await release.Task; } };
        var transfer = f.Run(0, sink: sink); await entered.Task;
        var eviction = second.EvictVerifiedCacheAsync(Identity(0)); Check(!eviction.IsCompleted);
        await f.Run(1, second).WaitAsync(TimeSpan.FromSeconds(5)); Check(!eviction.IsCompleted);
        release.SetResult(); await transfer; await eviction.WaitAsync(TimeSpan.FromSeconds(5));
        Check(sink.Complete == 1 && sink.Failed == 0 && !Directory.EnumerateFiles(f.Root, Identity(0).FileName, SearchOption.AllDirectories).Any());
    }
    private static Task Metadata()
    {
        var id = Identity(0); var spec = new DownloadSpec("x", new Uri(id.Origin + "/content"), id.FileName, long.MaxValue, "\"" + new string('<', 510) + "\"", id.Sha256);
        var exact = JsonSerializer.SerializeToUtf8Bytes(new { Version = 1, Descriptor = new string('a', 64), spec.Length, spec.ETag, Sha256 = spec.Sha256.ToLowerInvariant() }).LongLength + System.Text.Encoding.UTF8.GetByteCount("LedgeTop.WindowsDownload/1\n");
        Check(Downloader.HydrationStateGrowthBudget(spec) == exact && exact > 3000);
        return Task.CompletedTask;
    }
    private static async Task Drain()
    {
        using var f = new Fixture(); var four = Signal(); var entered = 0; var sinks = Enumerable.Range(0, 5).Select(_ => new Sink()).ToArray();
        f.Source.BeforeDownload = async (_, token) => { if (Interlocked.Increment(ref entered) == 4) four.TrySetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, token); };
        await using var dispatcher = new CloudFilesCallbackDispatcher(f.Source, "pilot", Principal, 42, f.Root,
            (core, id, context, token) => core.HydrateAsync(id, 0, Bytes.Length, sinks[(int)context.RequestKey], token));
        var requests = Enumerable.Range(0, 5).Select(i => dispatcher.FetchDataAsync(Identity(i).Encode(), new(42, 100 + i, i, Bytes.Length, 0, Bytes.Length))).ToArray();
        await four.Task.WaitAsync(TimeSpan.FromSeconds(5)); Check(f.Source.Downloads == 4);
        await dispatcher.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        foreach (var task in requests) await Cancelled(task);
        Check(sinks.All(sink => sink.Complete == 0 && sink.Failed == 1) && f.Source.Downloads == 4);
    }
    private sealed class Sink : IPlaceholderTransferSink
    {
        internal int Complete, Failed; internal Func<Task>? BeforeWrite; internal Action? OnFailure;
        public async Task WriteAsync(long offset, ReadOnlyMemory<byte> bytes, CancellationToken token) { token.ThrowIfCancellationRequested(); if (BeforeWrite is not null) await BeforeWrite(); }
        public Task CompleteAsync(CancellationToken token) { Complete++; return Task.CompletedTask; }
        public Task FailAsync(string code) { Failed++; OnFailure?.Invoke(); return Task.CompletedTask; }
    }
    private sealed class Source : IQueuedDownloadSource, IDisposable, IHydrationMutationAwareSource
    {
        bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => true;
        private readonly Downloader downloader;
        private int downloads, resolves, active, peak;
        internal int Downloads => Volatile.Read(ref downloads); internal int Resolves => Volatile.Read(ref resolves); internal int Peak => Volatile.Read(ref peak);
        internal Func<DownloadSpec, CancellationToken, Task>? BeforeDownload;
        internal Func<Stream>? StreamFactory;
        public string Alias => "portal"; public Uri Origin => new("https://concurrency.example.invalid");
        internal Source() { downloader = new(new Handler(this), [Origin]); }
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken token = default) { token.ThrowIfCancellationRequested(); return Task.FromResult(new QueuedDownloadSession(Principal, DateTimeOffset.UtcNow.AddHours(1))); }
        public Task<ResolvedQueuedDownload> ResolveAsync(string reference, CancellationToken token = default) {
            token.ThrowIfCancellationRequested(); Interlocked.Increment(ref resolves); var id = Identity(int.Parse(reference[6..], System.Globalization.CultureInfo.InvariantCulture));
            return Task.FromResult(new ResolvedQueuedDownload(Principal, id.LogicalFileId, id.RemoteVersion, new(id.LogicalFileId + ":v1", new Uri(Origin, "/content"), id.FileName, id.Length, id.ETag, id.Sha256)));
        }
        public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) {
            Interlocked.Increment(ref downloads); var current = Interlocked.Increment(ref active); int previous;
            do { previous = Volatile.Read(ref peak); if (previous >= current) break; } while (Interlocked.CompareExchange(ref peak, current, previous) != previous);
            try { if (BeforeDownload is not null) await BeforeDownload(spec, cancellationToken); return await downloader.DownloadAsync(spec, destination, cancellationToken, progress); }
            finally { Interlocked.Decrement(ref active); }
        }
        public void Dispose() => downloader.Dispose();
        private sealed class Handler(Source source) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
                token.ThrowIfCancellationRequested(); var offset = request.Headers.Range?.Ranges.Single().From ?? 0;
                var content = source.StreamFactory is { } factory ? (HttpContent)new StreamContent(factory()) : new ByteArrayContent(Bytes[(int)offset..]);
                content.Headers.ContentLength = Bytes.Length - offset;
                if (offset > 0) content.Headers.ContentRange = new(offset, Bytes.Length - 1, Bytes.Length);
                var response = new HttpResponseMessage(offset > 0 ? HttpStatusCode.PartialContent : HttpStatusCode.OK) { Content = content };
                response.Headers.ETag = EntityTagHeaderValue.Parse("\"v1\""); return Task.FromResult(response);
            }
        }
    }
    private sealed class Fixture : IDisposable
    {
        internal readonly string Root;
        internal readonly Source Source = new(); private readonly PlaceholderHydrationCoordinator coordinator;
        internal Fixture() {
            var parent = Environment.GetEnvironmentVariable("LEDGETOP_TEST_ARTIFACT_ROOT") ?? Path.Combine(Path.GetTempPath(), "LedgeTopFilesTests");
            if (!Path.IsPathFullyQualified(parent) || parent.StartsWith("\\\\", StringComparison.Ordinal)) throw new IOException("Use local test artifacts.");
            parent = Path.GetFullPath(parent);
            for (var part = parent; part is not null; part = Path.GetDirectoryName(part)) {
                if (File.Exists(part)) throw new IOException("Artifact ancestor is a file.");
                if (Directory.Exists(part) && (File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new IOException("Artifact ancestor is an alias.");
            }
            Root = Path.Combine(parent, "concurrency", Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Root); coordinator = Coordinator();
        }
        internal PlaceholderHydrationCoordinator Coordinator(long maximum = 1L << 30) => new(Source, "pilot", Root, Bytes.Length, maximum, Principal);
        internal Task Run(int i, PlaceholderHydrationCoordinator? owner = null, Sink? sink = null, CancellationToken token = default) => (owner ?? coordinator).HydrateAsync(Identity(i), 0, Bytes.Length, sink ?? new Sink(), token);
        public void Dispose() { coordinator.Dispose(); Source.Dispose(); File.WriteAllText(Path.Combine(Root, "synthetic-receipt.txt"), "Synthetic owned cache only. No source data or credentials.\n"); }
    }
}
