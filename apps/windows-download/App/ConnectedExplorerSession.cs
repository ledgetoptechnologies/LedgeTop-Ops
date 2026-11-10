using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;
using LedgeTop.Files.Presentation;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files;

internal sealed record ConnectedExplorerEngineRequest(string ProfileDirectory, string PreferredRoot,
    IQueuedDownloadSource Source, ExplorerRootScope Scope, ExplorerRootManifest? InitialManifest);
internal sealed record ConnectedExplorerEngine(IExplorerPreviewSession Session, Func<ExplorerRootManifest?> ReadFrozenManifest,
    Func<bool> HasOwnedProfileReceipt, Func<ConnectedGenerationSnapshot>? ObserveConnectedGeneration = null,
    Func<Task<PreparedConnectedGeneration>>? PrepareFreshCandidate = null);
// Generation pins are currently test-only: schema-2 selectors have no production
// session/ownership adapter yet. Schema-1 sessions preserve their existing null pin.
internal sealed record ConnectedExplorerGenerationBinding(Guid GenerationId, long SelectorRevision, string ManifestDigest,
    long RootFileId, Guid NamespaceClsid, long ProfileRevision)
{
    internal bool Valid => GenerationId != Guid.Empty && SelectorRevision > 0 && RootFileId != 0 && NamespaceClsid != Guid.Empty && ProfileRevision > 0 &&
        ManifestDigest is { Length: 64 } && ManifestDigest.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
}
internal sealed record ConnectedExplorerUpdateBinding(string Channel, string SourceAlias, string PrincipalId,
    ConnectedExplorerGenerationBinding? Generation = null);
internal sealed record SyntheticFirstTransitionHooks(
    Func<string, string, IQueuedDownloadSource, ExplorerRootScope, ExplorerRootManifest, OwnedExplorerRootSession> CreateCandidate,
    Action<FreshGenerationOwnedAdapter, OwnedExplorerRootSession> ConfigureAdapter);
internal interface ICachedExplorerReconnect
{
    bool CanReconnectCached { get; }
    Task ReconnectCachedAsync();
}

/// <summary>One trusted selected source. Only explicit Start invokes browser sign-in; construction/removal stay offline.</summary>
internal sealed class ConnectedExplorerSession : IExplorerPreviewSession, ICachedExplorerReconnect, IAvailabilityRetry, IOrderedActivitySource
{
    private const string Owner = "LedgeTop.Files.ConnectedExplorer.Index/1";
    private sealed record Index(int Schema, string Owner, string Sid, string Channel, string Alias,
        string OriginSha256, string PrincipalId, long Revision, bool Removed = false);
    private sealed record TransientRecheckRecovery(ConnectedExplorerEngine Engine, IFilesBackend Backend, Index Index, string InventoryDigest);
    private static readonly JsonSerializerOptions json = new() { WriteIndented = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private readonly Func<IFilesBackend> createBackend;
    private readonly Func<ConnectedExplorerEngineRequest, ConnectedExplorerEngine> createEngine;
    private readonly Func<IFilesBackend, string, string, CancellationToken, Task<ExplorerCatalogSnapshot>> capture;
    private readonly Func<bool> coldPreparationAdmission;
    private readonly SyntheticFirstTransitionHooks? syntheticFirstTransition;
    private readonly FreshGenerationRemovalCoordinator.RemoveExactRoot? syntheticFreshRootRemoval;
    private readonly string channel, alias, origin, originHash, stateBase, preferredRoot, indexDirectory, indexPath, sid;
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly object view = new(), lifetime = new();
    private readonly OrderedActivity activity = new();
    private CancellationTokenSource cancellation = new();
    private ConnectedExplorerEngine? engine;
    private IFilesBackend? backend;
    private Index? index;
    private FreshGenerationIndexCodec.Index? heldFreshSelector;
    // Retained across every outcome, including cancellation and failed shutdown.
    // No production action currently creates this adapter.
    private FreshGenerationOwnedAdapter? heldFreshAdapter;
    private FreshGenerationColdRestart? heldColdRestart;
    private OwnedExplorerRootSession? pendingColdPrior, pendingColdCurrent;
    private bool coldPreparationReview;
    private OwnedExplorerRootSession? pendingFreshCandidate;
    private IQueuedDownloadSource? pendingFreshSource; // non-owning bridge; backend remains owner
    private bool freshPreparationReview;
    private bool freshReadOnlyActive;
    private bool coldStopRetryAllowed;
    private bool freshStopRetryAllowed;
    internal bool FreshReadOnlyActive { get { lock (view) return freshReadOnlyActive; } }
    internal bool FreshGenerationRecoveryRequired { get { lock (view) return heldFreshSelector is not null || heldFreshAdapter is not null || heldColdRestart is not null || coldPreparationReview || freshPreparationReview; } }
    // Read-only UI hint. An invalid index or an incomplete/held transition must
    // not expose schema-1 reconnect, removal or update actions.
    internal bool CanStartPublishedFresh { get { lock (view) return CanStartPublishedFreshLocked(); } }
    internal bool CanRemovePublishedFreshForInstaller { get { lock (view) return heldFreshSelector is { } saved && ValidRemovableFreshSelector(saved); } }
    internal bool CanStartFreshReadOnlyConnection { get { lock (view) return
        (FreshGenerationStagingQualification.Allows(channel, alias, origin) || syntheticFirstTransition is not null) && alias == "employee" &&
        !disposed && !closeRequested && !invalidIndex && !freshPreparationReview && !coldPreparationReview &&
        index is { Removed: false } && backend is not null && engine?.Session is OwnedExplorerRootSession { State: ExplorerPreviewState.Running } &&
        heldFreshSelector is null && heldFreshAdapter is null && heldColdRestart is null && HasOwnedIndexLeaseForFreshHint(); } }
    private bool HasOwnedIndexLeaseForFreshHint()
    {
        if (indexLease is not { } lease) return false;
        try { return new FreshGenerationIndexLockPin(lease, Path.Combine(indexDirectory, "index.lock")).StillHeld(lease); }
        catch (Exception error) when (error is IOException or ObjectDisposedException or UnauthorizedAccessException) { return false; }
    }
    private bool CanStartPublishedFreshLocked() => coldPreparationAdmission() && !disposed && !closeRequested && !invalidIndex &&
        !coldPreparationReview && !freshPreparationReview && heldFreshAdapter is null && heldColdRestart is null &&
        indexLease is null && backend is null && engine is null && heldFreshSelector is { } saved &&
        saved.State.Phase == FreshGenerationPlan.Phase.Published && saved.State.Removal is null &&
        saved.State.New is { } next && saved.ActiveGeneration == next.Id;
    // Both registrations are confirmed gone and both folders kept. Connecting again needs a new
    // root and selector retirement, which this pilot does not implement; it is not a review case.
    internal bool FreshRemovalComplete { get { lock (view) return !invalidIndex && heldFreshSelector?.State.Removal == FreshGenerationPlan.RemovalPhase.Complete; } }
    internal bool RequiresOwnershipReview { get { lock (view) return !freshReadOnlyActive && !CanStartPublishedFreshLocked() && (invalidIndex || heldFreshSelector is not null || heldFreshAdapter is not null || heldColdRestart is not null || coldPreparationReview || freshPreparationReview); } }

    // Installer check only: validate the published staging selector and both
    // generations without connecting a provider, signing in, or changing roots.
    // An incomplete or uncertain observation continues to refuse installation.
    internal async Task<bool> ValidatePublishedSelectorForInstallAsync()
    {
        var expected = heldFreshSelector;
        if (!PublishedSelectorEligibleForInstall(expected, invalidIndex, coldPreparationAdmission())) return false;
        var next = expected!.State.New!;
        var ready = expected.State.ReadyRoot!;
        var old = expected.State.Old;
        if (old.Scope != next.Scope) return false;
        Ancestors(indexDirectory, false);
        var lockPath = Path.Combine(indexDirectory, "index.lock");
        if (!File.Exists(lockPath) || (File.GetAttributes(lockPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
        using var selectorLease = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        var pin = new FreshGenerationIndexLockPin(selectorLease, lockPath);
        bool Selector() => pin.StillHeld(selectorLease) && FreshGenerationStartup.Observe(indexPath,
            Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) == expected;
        bool Old(RestartGenerationEvidence e) => Selector() && FreshGenerationColdRestart.Matches(e, old, old.RootVolume, old.RootFileId,
            old.NamespaceClsid, old.ProfileRevision, old.ProfileDocumentVolume, old.ProfileDocumentFileId);
        bool Current(RestartGenerationEvidence e) => Selector() && FreshGenerationColdRestart.Matches(e, next, ready.Volume, ready.FileId,
            ready.NamespaceClsid, ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId);
        if (!Selector()) return false;
        var scope = new ExplorerRootScope(channel, alias, origin, expected.Principal);
        var previous = new OwnedExplorerRootSession(old.ProfileDirectory, old.RootPath, new CleanupSource(alias, new Uri(origin)), scope);
        var current = new OwnedExplorerRootSession(next.ProfileDirectory, next.RootPath, new CleanupSource(alias, new Uri(origin)), scope);
        return await RunReadOnlyInstallObservationAsync(
            () => Old(previous.AcquireExistingRestartObservation()), () => Current(current.AcquireExistingRestartObservation()),
            () => Old(previous.RecheckExistingRestartObservation()), () => Current(current.RecheckExistingRestartObservation()), Selector,
            current.ReleaseReadOnlyRestartObservation, previous.ReleaseReadOnlyRestartObservation,
            () => current.DisposeAsync(), () => previous.DisposeAsync()).ConfigureAwait(false);
    }

    internal static async Task<bool> RunReadOnlyInstallObservationAsync(Func<bool> oldAcquire, Func<bool> currentAcquire,
        Func<bool> oldRecheck, Func<bool> currentRecheck, Func<bool> selector, Action releaseCurrent, Action releaseOld,
        Func<ValueTask> disposeCurrent, Func<ValueTask> disposeOld)
    {
        try {
            if (!oldAcquire() || !currentAcquire() || !oldRecheck() || !currentRecheck()) return false;
            return selector();
        } finally {
            try { releaseCurrent(); }
            finally {
                try { releaseOld(); }
                finally {
                    try { await disposeCurrent().ConfigureAwait(false); }
                    finally { await disposeOld().ConfigureAwait(false); }
                }
            }
        }
    }

    internal static bool PublishedSelectorEligibleForInstall(FreshGenerationIndexCodec.Index? expected, bool invalid, bool qualified) =>
        !invalid && qualified && expected is { State.Phase: FreshGenerationPlan.Phase.Published, State.New: { } next, State.ReadyRoot: not null } &&
        expected.ActiveGeneration == next.Id && expected.State.Old.Scope == next.Scope;

    // No production factory can qualify this path yet. The retained adapter and
    // index lock must survive failures or cancellation after ownership begins.
    internal async Task AttemptColdFreshRestartAsync(FreshGenerationColdRestart restart, CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(restart);
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            lock (lifetime) ObjectDisposedException.ThrowIf(disposed || closeRequested, this);
            restart.VerifyCapability();
            var expected = heldFreshSelector ?? throw new IOException("No saved fresh selector is available.");
            if (heldColdRestart is not null || indexLease is not null || !restart.MatchesSelector(expected))
                throw new IOException("Restart ownership differs from the saved selector.");
            Ancestors(indexDirectory, false);
            var lockPath = Path.Combine(indexDirectory, "index.lock");
            if (!File.Exists(lockPath) || (File.GetAttributes(lockPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                throw new IOException("The existing selector lock is unavailable.");
            indexLease = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            lock (view) { heldColdRestart = restart; viewEpoch++; }
            var pin = new FreshGenerationIndexLockPin(indexLease, lockPath);
            var actual = FreshGenerationStartup.Observe(indexPath, Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash);
            if (!pin.StillHeld(indexLease) || actual != expected) throw new IOException("The saved selector changed before restart.");
            await restart.VerifyAndStartAsync(token).ConfigureAwait(false);
            if (!pin.StillHeld(indexLease) || FreshGenerationStartup.Observe(indexPath, Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) != expected)
                throw new IOException("The saved selector changed during restart.");
            // Publication to the operational facade is intentionally unavailable until
            // two-generation update, disposal and removal are qualified.
        } finally { operations.Release(); }
    }

    // Product composition for a future qualified restart. Its first check is a
    // hard denial today, before opening the selector lock or constructing a backend.
    // Publication into a usable facade remains deliberately held after start.
    internal async Task ComposeColdFreshRestartAsync(bool explicitLogin, CancellationToken token)
    {
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            lock (lifetime) ObjectDisposedException.ThrowIf(disposed || closeRequested, this);
            if (!coldPreparationAdmission()) throw new IOException("Fresh generation restart is not qualified.");
            var coldPreparationStarted = false;
            try {
            var expected = heldFreshSelector ?? throw new IOException("No saved fresh selector is available.");
            var next = expected.State.New ?? throw new IOException("The current generation is unavailable.");
            if (coldPreparationReview || heldColdRestart is not null || heldFreshAdapter is not null || indexLease is not null || backend is not null || engine is not null)
                throw new IOException("Existing session ownership must be reconciled first.");
            coldPreparationStarted = true;
            Ancestors(indexDirectory, false);
            var lockPath = Path.Combine(indexDirectory, "index.lock");
            if (!File.Exists(lockPath) || (File.GetAttributes(lockPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                throw new IOException("The existing selector lock is unavailable.");
            indexLease = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            var pin = new FreshGenerationIndexLockPin(indexLease, lockPath);
            bool ExactSelector() => pin.StillHeld(indexLease) && FreshGenerationStartup.Observe(indexPath,
                Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) == expected;
            if (!ExactSelector()) throw new IOException("The fresh selector changed before sign-in.");
            var trace = new ConnectionFailureTrace(explicitLogin ? ConnectionAction.ExplicitConnect : ConnectionAction.CachedReconnect);
            backend = createBackend();
            var selected = SelectedSource(backend);
            if (explicitLogin) await backend.Session.SignInAsync(token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            var person = await CurrentPersonAsync(backend, selected, token, trace, expected.Principal).ConfigureAwait(false);
            if (person != expected.Principal || !ExactSelector()) throw new IOException("Restart account or selector changed.");
            var scope = new ExplorerRootScope(channel, alias, origin, person);
            var previous = new OwnedExplorerRootSession(expected.State.Old.ProfileDirectory, expected.State.Old.RootPath,
                new CleanupSource(alias, new Uri(origin)), scope);
            pendingColdPrior = previous;
            var current = new OwnedExplorerRootSession(next.ProfileDirectory, next.RootPath,
                new LifetimeQueuedDownloadSource(selected, cancellation.Token), scope);
            pendingColdCurrent = current;
            async Task<FreshGenerationPlan.Scope> Authenticate(CancellationToken currentToken)
            {
                var principal = await CurrentPersonAsync(backend, selected, currentToken, trace, expected.Principal).ConfigureAwait(false);
                return new(channel, alias, origin, principal);
            }
            var restart = FreshGenerationColdRestart.CreateForSession(previous, current, expected, Authenticate, ExactSelector);
            lock (view) { heldColdRestart = restart; viewEpoch++; }
            pendingColdPrior = null; pendingColdCurrent = null; // restart now retains both exact sessions
            await restart.VerifyAndStartAsync(token).ConfigureAwait(false);
            if (!ExactSelector()) throw new IOException("The fresh selector changed during provider startup.");
            PublishColdReadOnlyProvider(restart);
            } catch {
                if (coldPreparationStarted && heldColdRestart is null) {
                    try { await DrainColdPreparationAsync().ConfigureAwait(false); }
                    catch { lock (view) { coldPreparationReview = true; viewEpoch++; } Add("Fresh connection preparation could not confirm shutdown. Ownership needs review."); }
                }
                throw;
            }
        } finally { operations.Release(); }
    }
    private void PublishColdReadOnlyProvider(FreshGenerationColdRestart restart)
    {
        var current = restart.CurrentSession;
        if (!ReferenceEquals(heldColdRestart, restart) || current.State != ExplorerPreviewState.Running)
            throw new IOException("The fresh provider did not confirm running state.");
        // The exact verified candidate is the only folder exposed while the
        // prior generation remains retained. Mutating app actions remain gated.
        SetEngine(new ConnectedExplorerEngine(current, () => current.FrozenManifest, () => current.HasOwnershipReceipt));
        lock (view) { freshReadOnlyActive = true; coldStopRetryAllowed = true; viewEpoch++; }
        SetState(ExplorerPreviewState.Running);
        Add("Your current files are available in Explorer; the previous folder remains separate.");
    }
    // Generated-only test seam. No production factory marks a restart synthetic.
    internal async Task PublishSyntheticColdReadOnlyProviderForTestAsync(FreshGenerationColdRestart restart)
    {
        if (!restart.SyntheticForTest) throw new IOException("Synthetic restart required.");
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            var expected = heldFreshSelector ?? throw new IOException("No saved fresh selector is available.");
            if (heldColdRestart is not null || indexLease is not null || engine is not null || !restart.MatchesSelector(expected))
                throw new IOException("Synthetic session ownership differs.");
            var lockPath = Path.Combine(indexDirectory, "index.lock");
            indexLease = new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
            lock (view) { heldColdRestart = restart; viewEpoch++; }
            var pin = new FreshGenerationIndexLockPin(indexLease, lockPath);
            if (!pin.StillHeld(indexLease) || FreshGenerationStartup.Observe(indexPath,
                Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) != expected)
                throw new IOException("Synthetic selector changed.");
            PublishColdReadOnlyProvider(restart);
        } finally { operations.Release(); }
    }
    // Called under operations only, before either owned session has acquired a
    // restart lease or started a provider. Failed disposals retain exact objects.
    private async Task DrainColdPreparationAsync()
    {
        if (pendingColdCurrent is not null) { await pendingColdCurrent.DisposeAsync().ConfigureAwait(false); pendingColdCurrent = null; }
        if (pendingColdPrior is not null) { await pendingColdPrior.DisposeAsync().ConfigureAwait(false); pendingColdPrior = null; }
        if (backend is not null) { await backend.DisposeAsync().ConfigureAwait(false); backend = null; }
        indexLease?.Dispose(); indexLease = null;
        lock (view) { coldPreparationReview = false; viewEpoch++; }
    }
    // Internal shutdown path for a future qualified restart. It disconnects
    // providers only; both registrations and the durable selector remain.
    internal async Task StopColdFreshRestartAsync()
    {
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            lock (lifetime) ObjectDisposedException.ThrowIf(disposed || closeRequested, this);
            await StopColdFreshRestartCoreAsync().ConfigureAwait(false);
        } finally { operations.Release(); }
    }
    private async Task StopColdFreshRestartCoreAsync()
    {
            var restart = heldColdRestart ?? throw new IOException("No held cold restart is available.");
            // Once shutdown starts, the provider may already be paused or drained.
            // Never continue presenting it as available if any later step fails.
            lock (view) { freshReadOnlyActive = false; viewEpoch++; }
            SetState(ExplorerPreviewState.Failed);
            var expected = heldFreshSelector ?? throw new IOException("No fresh selector is available.");
            var ownedLock = indexLease ?? throw new IOException("Selector lock is unavailable.");
            var pin = new FreshGenerationIndexLockPin(ownedLock, Path.Combine(indexDirectory, "index.lock"));
            bool ExactSelector() => pin.StillHeld(indexLease) && FreshGenerationStartup.Observe(indexPath,
                Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) == expected;
            if (!ExactSelector()) throw new IOException("Selector ownership is not current.");
            await restart.StopHeldAsync().ConfigureAwait(false);
            await restart.DisposeStoppedSessionsAsync().ConfigureAwait(false);
            if (!ExactSelector()) throw new IOException("Selector changed while stopping the restart.");
            SetEngine(null);
            TryPersistStatus(ExplorerPreviewState.NotStarted);
            lock (view) { heldColdRestart = null; freshReadOnlyActive = false; coldStopRetryAllowed = false; viewEpoch++; }
            indexLease.Dispose(); indexLease = null;
            SetState(ExplorerPreviewState.Failed);
    }
    private async Task StopPublishedFreshCoreAsync()
    {
        var adapter = heldFreshAdapter ?? throw new IOException("No published fresh connection is held.");
        lock (view) { freshReadOnlyActive = false; viewEpoch++; }
        SetState(ExplorerPreviewState.Failed);
        var expected = heldFreshSelector ?? throw new IOException("No fresh selector is available.");
        var ownedLock = indexLease ?? throw new IOException("Selector lock is unavailable.");
        var pin = new FreshGenerationIndexLockPin(ownedLock, Path.Combine(indexDirectory, "index.lock"));
        bool ExactSelector() => pin.StillHeld(indexLease) && FreshGenerationStartup.Observe(indexPath,
            Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) == expected;
        if (!ExactSelector()) throw new IOException("Fresh selector ownership changed.");
        await adapter.StopPublishedAsync(ExactSelector).ConfigureAwait(false);
        if (!ExactSelector()) throw new IOException("Fresh selector changed while stopping.");
        SetEngine(null);
        TryPersistStatus(ExplorerPreviewState.NotStarted);
        lock (view) { heldFreshAdapter = null; freshReadOnlyActive = false; freshStopRetryAllowed = false; viewEpoch++; }
        indexLease.Dispose(); indexLease = null;
    }

    internal async Task<FreshGenerationIndexCodec.Index> ExecuteFreshGenerationAsync(
        FreshGenerationOwnedAdapter adapter, byte[] legacyBytes, FreshGenerationIndexStore.LegacyBinding legacy,
        CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(adapter);
        ArgumentNullException.ThrowIfNull(legacyBytes);
        var immutableLegacyBytes = legacyBytes.ToArray();
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            lock (lifetime) ObjectDisposedException.ThrowIf(disposed || closeRequested, this);
            if (heldFreshAdapter is not null || invalidIndex || indexLease is null || engine is null ||
                !(adapter.OwnsPrior(engine.Session) || adapter.OwnsSyntheticPriorForTest(engine.Session)))
                throw new IOException("Fresh connection ownership cannot be established.");
            adapter.VerifyCapability();
            if (index is not { Removed: false } saved || ReadIndex() != saved || legacy.Revision != saved.Revision ||
                legacy.Sid != saved.Sid || legacy.Channel != saved.Channel || legacy.Source != saved.Alias ||
                legacy.OriginSha256 != saved.OriginSha256 || legacy.Principal != saved.PrincipalId ||
                !File.ReadAllBytes(indexPath).AsSpan().SequenceEqual(immutableLegacyBytes))
                throw new IOException("Fresh connection legacy index differs from the active session.");
            var lockPin = new FreshGenerationIndexLockPin(indexLease, Path.Combine(indexDirectory, "index.lock"));
            // Hold before any await that can reserve or transfer ownership. Never auto-release on failure.
            lock (view) { heldFreshAdapter = adapter; viewEpoch++; }
            bool LeaseHeld() => lockPin.StillHeld(indexLease);
            FreshGenerationIndexStore.LegacyBinding? VerifyLegacy(byte[] bytes) =>
                bytes.AsSpan().SequenceEqual(immutableLegacyBytes) && ReadIndex() == saved &&
                File.ReadAllBytes(indexPath).AsSpan().SequenceEqual(bytes) ? legacy : null;
            var published = await FreshGenerationCoordinator.ExecuteAsync(indexDirectory, immutableLegacyBytes, legacy, LeaseHeld,
                VerifyLegacy, adapter, true, token).ConfigureAwait(false);
            // Publishing is not yet a qualified provider handoff. Keep both sessions
            // and their exact handles held; do not claim a usable new connection.
            lock (view) { heldFreshSelector = published; viewEpoch++; }
            SetState(ExplorerPreviewState.Failed);
            Add("The fresh connection was prepared and needs ownership review before use.");
            return published;
        } finally { operations.Release(); }
    }
    // First transition for the existing signed-in account. Production admission is
    // deliberately held until the journal and native ownership paths are qualified.
    internal async Task StartFreshReadOnlyConnectionAsync(CancellationToken token)
    {
        await operations.WaitAsync(token).ConfigureAwait(false);
        ConnectedGenerationHeldObservation? preliminary = null;
        var actionStarted = false;
        try {
            lock (lifetime) ObjectDisposedException.ThrowIf(disposed || closeRequested, this);
            if (!FreshGenerationStagingQualification.Allows(channel, alias, origin) && syntheticFirstTransition is null) throw new IOException("Fresh generation is not qualified.");
            if (invalidIndex || index is not { Removed: false } saved || backend is not { } currentBackend ||
                engine?.Session is not OwnedExplorerRootSession previous || heldFreshAdapter is not null || heldColdRestart is not null || freshPreparationReview ||
                previous.State != ExplorerPreviewState.Running)
                throw new IOException("A running owned connection is required.");
            if (syntheticFirstTransition is not null && !previous.IsSyntheticFixtureForTest) throw new IOException("Synthetic prior required.");
            AcquireExistingIndexLease();
            var ownedLock = indexLease ?? throw new IOException("Selector lock is unavailable.");
            var pin = new FreshGenerationIndexLockPin(ownedLock, Path.Combine(indexDirectory, "index.lock"));
            var original = File.ReadAllBytes(indexPath);
            if (!pin.StillHeld(indexLease) || ReadIndex() != saved) throw new IOException("Saved selector changed.");
            actionStarted = true; SetFreshAction(FreshActionObservation.Preparing);
            var selected = SelectedSource(currentBackend);
            var trace = new ConnectionFailureTrace(ConnectionAction.ExplicitConnect);
            var principal = await CurrentPersonAsync(currentBackend, selected, token, trace, saved.PrincipalId).ConfigureAwait(false);
            var nativeScope = new ExplorerRootScope(channel, alias, origin, principal);
            var planScope = new FreshGenerationPlan.Scope(channel, alias, origin, principal);
            var fresh = await CaptureInventoryAsync(currentBackend, nativeScope, principal, token, trace).ConfigureAwait(false);
            _ = await CurrentPersonAsync(currentBackend, selected, token, trace, principal).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            preliminary = previous.AcquireConnectedGenerationHandles();
            var snapshot = preliminary.Snapshot; var handles = preliminary.Handles;
            var old = new FreshGenerationPlan.Generation(snapshot.Identity, planScope, snapshot.ProfileDirectory, snapshot.RootPath,
                snapshot.ManifestDigest, handles.ProfileDirectoryVolume, handles.ProfileDirectoryFileId, snapshot.ProfileRevision,
                handles.ProfileVolume, handles.ProfileFileId, handles.RootVolume, handles.RootFileId, snapshot.NamespaceClsid);
            var freshId = Guid.NewGuid().ToString("N");
            var candidateProfile = Path.Combine(indexDirectory, "fresh-" + freshId);
            var candidateRoot = preferredRoot + " — Current " + freshId[..8];
            var candidateSource = new LifetimeQueuedDownloadSource(selected, cancellation.Token);
            pendingFreshSource = candidateSource;
            var candidate = syntheticFirstTransition is null
                ? new OwnedExplorerRootSession(candidateProfile, candidateRoot, candidateSource, nativeScope, fresh)
                : syntheticFirstTransition.CreateCandidate(candidateProfile, candidateRoot, candidateSource, nativeScope, fresh);
            pendingFreshCandidate = candidate;
            if (syntheticFirstTransition is not null && !candidate.IsSyntheticFixtureForTest) throw new IOException("Synthetic candidate required.");
            var legacy = new FreshGenerationIndexStore.LegacyBinding(saved.Revision, sid, channel, alias, originHash, principal, old);
            async Task<FreshGenerationPlan.Scope> Authenticate(CancellationToken currentToken) =>
                new(channel, alias, origin, await CurrentPersonAsync(currentBackend, selected, currentToken, trace, principal).ConfigureAwait(false));
            bool ExactLease() => pin.StillHeld(indexLease);
            FreshGenerationIndexStore.LegacyBinding? VerifyLegacy(byte[] bytes) =>
                bytes.AsSpan().SequenceEqual(original) && ReadIndex() == saved && File.ReadAllBytes(indexPath).AsSpan().SequenceEqual(bytes) ? legacy : null;
            bool Separate(ConnectedGenerationHeldObservation held, PreparedConnectedGeneration prepared) {
                held.Handles.Recheck();
                return held.Snapshot == snapshot && prepared.ProfileDirectory == candidateProfile && prepared.RootPath == candidateRoot &&
                    (held.Handles.ProfileDirectoryVolume != prepared.ProfileVolume || held.Handles.ProfileDirectoryFileId != prepared.ProfileFileId);
            }
            bool Journal(PreparedConnectedGeneration prepared) {
                if (!ExactLease()) return false;
                var current = FreshGenerationStartup.Observe(indexPath, Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash);
                var next = current?.State.New;
                return current?.State.Phase == FreshGenerationPlan.Phase.OldDrained && current.State.Old == old && next is not null &&
                    next.Id == prepared.Identity && next.ProfileDirectory == prepared.ProfileDirectory && next.RootPath == prepared.RootPath &&
                    next.ManifestDigest == prepared.ManifestDigest && next.ProfileDirectoryVolume == prepared.ProfileVolume &&
                    next.ProfileDirectoryFileId == prepared.ProfileFileId && next.ProfileDocumentVolume == prepared.ProfileDocumentVolume &&
                    next.ProfileDocumentFileId == prepared.ProfileDocumentFileId && next.ProfileRevision == prepared.ProfileRevision;
            }
            var adapter = syntheticFirstTransition is null
                ? FreshGenerationOwnedAdapter.CreateForSession(previous, candidate, old, Authenticate, Separate, Journal)
                : FreshGenerationOwnedAdapter.CreateForTest(previous, candidate, old, Authenticate, Separate, Journal);
            syntheticFirstTransition?.ConfigureAdapter(adapter, candidate);
            lock (view) { heldFreshAdapter = adapter; viewEpoch++; }
            pendingFreshCandidate = null; pendingFreshSource = null; // adapter retains the candidate and its source bridge
            var published = await FreshGenerationCoordinator.ExecuteAsync(indexDirectory, original, legacy, ExactLease, VerifyLegacy, adapter, true, token).ConfigureAwait(false);
            lock (view) { heldFreshSelector = published; viewEpoch++; }
            if (!ExactLease() || FreshGenerationStartup.Observe(indexPath, Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) != published ||
                candidate.State != ExplorerPreviewState.Running) throw new IOException("Fresh publication or provider state differs.");
            SetEngine(new ConnectedExplorerEngine(candidate, () => candidate.FrozenManifest, () => candidate.HasOwnershipReceipt));
            lock (view) { freshReadOnlyActive = true; freshStopRetryAllowed = true; viewEpoch++; }
            SetFreshAction(FreshActionObservation.Completed);
            SetState(ExplorerPreviewState.Running);
            Add("Your current files are available in Explorer; the previous folder remains separate.");
        } catch (Exception error) {
            if (heldFreshAdapter is null && (pendingFreshCandidate is not null || pendingFreshSource is not null)) {
                try { await DrainFreshPreparationAsync().ConfigureAwait(false); }
                catch { lock (view) { freshPreparationReview = true; viewEpoch++; } Add("Fresh connection preparation could not confirm shutdown. Ownership needs review."); }
            }
            if (actionStarted) SetFreshAction(heldFreshAdapter is not null || freshPreparationReview ? FreshActionObservation.NeedsReview : FreshActionObservation.Failed);
            if (error is CatalogCaptureException { Limit: not CatalogCaptureLimit.None }) Add(FailureActivity(error));
            throw;
        } finally { try { preliminary?.Dispose(); } finally { operations.Release(); } }
    }
    // Called under operations before reservation or provider startup. The source
    // wrapper is non-owning and must not dispose the existing signed-in backend.
    private async Task DrainFreshPreparationAsync()
    {
        if (pendingFreshCandidate is not null) { await pendingFreshCandidate.DisposeAsync().ConfigureAwait(false); pendingFreshCandidate = null; }
        pendingFreshSource = null;
        lock (view) { freshPreparationReview = false; viewEpoch++; }
    }
    internal async Task InstallSyntheticPriorForTestAsync(OwnedExplorerRootSession previous)
    {
        if (syntheticFirstTransition is null || !previous.IsSyntheticFixtureForTest) throw new IOException("Synthetic transition hooks required.");
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            if (index is null || backend is null || engine is null || previous.State != ExplorerPreviewState.Running)
                throw new IOException("Synthetic running session is unavailable.");
            await engine.Session.DisposeAsync().ConfigureAwait(false);
            SetEngine(new ConnectedExplorerEngine(previous, () => previous.FrozenManifest, () => previous.HasOwnershipReceipt));
            SetState(ExplorerPreviewState.Running);
        } finally { operations.Release(); }
    }
    // This read-only live-session check does not start or adopt a provider. Cold
    // startup has no retained receipt and remains held until separately qualified.
    internal async Task VerifyPublishedFreshGenerationAsync(CancellationToken token)
    {
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            lock (lifetime) ObjectDisposedException.ThrowIf(disposed || closeRequested, this);
            var expected = heldFreshSelector ?? throw new IOException("No published generation is held.");
            var adapter = heldFreshAdapter ?? throw new IOException("No live generation receipt is held.");
            var ownedLock = indexLease ?? throw new IOException("Index lock is unavailable.");
            var pin = new FreshGenerationIndexLockPin(ownedLock, Path.Combine(indexDirectory, "index.lock"));
            FreshGenerationIndexCodec.Index? Read() => FreshGenerationStartup.Observe(indexPath,
                Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash);
            if (!pin.StillHeld(indexLease) || Read() != expected) throw new IOException("Published selector changed.");
            await adapter.VerifyPublishedHeldAsync(expected, token).ConfigureAwait(false);
            if (!pin.StillHeld(indexLease) || Read() != expected) throw new IOException("Published selector changed during verification.");
        } finally { operations.Release(); }
    }
    // Generated-fixture teardown only, before the test adapter acquired any handles.
    internal async Task ReleaseEmptyFreshAdapterForTestAsync()
    {
        await operations.WaitAsync().ConfigureAwait(false);
        try {
            if (heldFreshAdapter?.HasNoAcquiredOwnershipForTest != true) throw new IOException("Synthetic transition is not empty.");
            lock (view) { heldFreshAdapter = null; viewEpoch++; }
        } finally { operations.Release(); }
    }
    private FileStream? indexLease;
    private Task? closing;
    private bool closeRequested, disposed, invalidIndex, starting;
    private TransientRecheckRecovery? transientRecovery;
    private long viewEpoch;
    private ExplorerPreviewState? lastEngineState;
    private ExplorerPreviewState state;

    internal ConnectedExplorerSession(Func<IFilesBackend> backendFactory, string channel, string alias, Uri trustedOrigin,
        string stateBaseDirectory, string preferredRoot)
        : this(backendFactory, channel, alias, trustedOrigin, stateBaseDirectory, preferredRoot, DefaultEngine,
            ExplorerCatalogSnapshotBuilder.CaptureAsync) { }

    internal ConnectedExplorerSession(Func<IFilesBackend> backendFactory, string channel, string alias, Uri trustedOrigin,
        string stateBaseDirectory, string preferredRoot, Func<ConnectedExplorerEngineRequest, ConnectedExplorerEngine> engineFactory,
        Func<IFilesBackend, string, string, CancellationToken, Task<ExplorerCatalogSnapshot>> capture,
        Func<bool>? syntheticColdPreparationAdmission = null, SyntheticFirstTransitionHooks? syntheticFirstTransition = null,
        FreshGenerationRemovalCoordinator.RemoveExactRoot? syntheticFreshRootRemoval = null)
    {
        ArgumentNullException.ThrowIfNull(backendFactory); ArgumentNullException.ThrowIfNull(engineFactory); ArgumentNullException.ThrowIfNull(capture);
        if (channel is not ("pilot" or "stable") || alias is null || !Regex.IsMatch(alias, "\\A[a-z0-9][a-z0-9_-]{0,63}\\z"))
            throw new ArgumentException("The connected file source is invalid.");
        origin = CanonicalOrigin(trustedOrigin); originHash = Hash(origin);
        this.channel = channel; this.alias = alias; createBackend = backendFactory; createEngine = engineFactory; this.capture = capture;
        // Even a synthetic preparation admission cannot qualify provider startup:
        // CreateForSession has a separate hard-false production gate.
        coldPreparationAdmission = syntheticColdPreparationAdmission ?? (() => FreshGenerationStagingQualification.Allows(channel, alias, origin));
        this.syntheticFirstTransition = syntheticFirstTransition;
        if (syntheticFreshRootRemoval is not null && syntheticColdPreparationAdmission is null)
            throw new IOException("Synthetic fresh-root removal requires the explicit test admission seam.");
        this.syntheticFreshRootRemoval = syntheticFreshRootRemoval;
        stateBase = LocalDirectoryPath(stateBaseDirectory); this.preferredRoot = LocalDirectoryPath(preferredRoot, rootLeaf: true);
        indexDirectory = Path.Combine(stateBase, "connected-explorer-" + channel + "-" + alias);
        indexPath = Path.Combine(indexDirectory, "current.json");
        using var identity = WindowsIdentity.GetCurrent();
        sid = identity.User?.Value ?? throw new IOException("The current Windows identity is unavailable.");
        try {
            if (File.Exists(indexDirectory)) throw new IOException("The saved Explorer index is not a directory.");
            if (Directory.Exists(indexDirectory)) {
                // A valid schema-2 selector is recognized only as an interrupted/unsupported
                // transition. No profile is adopted and no registration is changed here.
                Ancestors(indexDirectory, false);
                heldFreshSelector = FreshGenerationStartup.Observe(indexPath, Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup),
                    sid, channel, alias, originHash);
                if (heldFreshSelector is not null) {
                    var published = heldFreshSelector.State.Phase == FreshGenerationPlan.Phase.Published &&
                        heldFreshSelector.State.New is { } current && heldFreshSelector.ActiveGeneration == current.Id;
                    invalidIndex = !published || !coldPreparationAdmission();
                    state = heldFreshSelector.State.Removal == FreshGenerationPlan.RemovalPhase.Complete
                        ? ExplorerPreviewState.Removed : ExplorerPreviewState.Failed;
                    Add(invalidIndex ? "This PC has a fresh-files transition that needs review. Some previous online-only files may be unavailable."
                        : heldFreshSelector.State.Removal == FreshGenerationPlan.RemovalPhase.Complete
                        ? "The Explorer connection was removed. Both files folders were kept."
                        : "The current files connection is ready to reconnect.");
                    return;
                }
                index = ReadIndex();
                RestoreCleanupEngine();
                state = ValidatePreviousRemoval() ? ExplorerPreviewState.Removed : engine?.Session.State ?? ExplorerPreviewState.NotStarted;
            }
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException) {
            invalidIndex = true; state = ExplorerPreviewState.Failed;
            Add("The saved Explorer connection needs ownership review. No account, local files or Windows registrations were changed.");
        }
    }

    internal static ConnectedExplorerEngine DefaultEngine(ConnectedExplorerEngineRequest request)
    {
        var owned = new OwnedExplorerRootSession(request.ProfileDirectory, request.PreferredRoot, request.Source, request.Scope, request.InitialManifest);
        return new(owned, () => owned.FrozenManifest, () => owned.HasOwnershipReceipt,
            owned.ObserveConnectedGeneration, owned.PrepareFreshConnectedCandidateAsync);
    }
    public string RootPath { get { lock (view) return engine?.Session.RootPath ?? preferredRoot; } }
    public ExplorerPreviewState State { get { lock (view) return state; } }
    // UI observation only. Full local ownership and fresh server identity are checked under
    // the operation lock before a recovery can resume this exact provider generation.
    internal bool CanRecoverTransientSession {
        get { lock (view) return RecoveryVisibleUnderView(); }
    }
    internal bool CanRecheckSession {
        get { lock (view) return !disposed && !closeRequested && !freshPreparationReview && heldFreshAdapter is null && heldFreshSelector is null &&
            (state is ExplorerPreviewState.Running or ExplorerPreviewState.Paused || RecoveryVisibleUnderView()); }
    }
    private bool RecoveryVisibleUnderView() => !disposed && !closeRequested && !invalidIndex && !freshPreparationReview && heldFreshAdapter is null && heldFreshSelector is null && state == ExplorerPreviewState.Failed &&
        transientRecovery is { } pending && ReferenceEquals(engine, pending.Engine) &&
        ReferenceEquals(backend, pending.Backend) && ReferenceEquals(index, pending.Index);
    private void ClearTransientRecovery()
    {
        lock (view) { if (transientRecovery is not null) { transientRecovery = null; viewEpoch++; } }
    }
    internal bool InventoryEmpty { get { lock (view) {
        var inventory = engine?.ReadFrozenManifest();
        return inventory is not null && inventory.Files.Count == 0 && inventory.Directories.Count == 0;
    } } }
    // Only an explicit sign-in action can replace an empty ready generation. Cached reconnect never captures.
    internal bool CanRefreshEmptyInventory => ObserveSavedCapability(emptyInventory: true, disconnectedBackend: false);
    public IReadOnlyList<ActivityEntry> ActivityEntries { get {
        IExplorerPreviewSession? current;
        lock (view) current = engine?.Session;
        var engineEntries = OrderedActivity.From(current);
        lock (view) { if (!ReferenceEquals(engine?.Session, current)) engineEntries = []; }
        return OrderedActivity.Merge(activity.Snapshot(), engineEntries);
    } }
    public IReadOnlyList<string> Activity => ActivityEntries.Select(entry => entry.Text).ToArray();
    public event EventHandler? Changed;

    public bool CanRetryAvailability {
        get {
            IExplorerPreviewSession? current;
            lock (view) {
                if (disposed || closeRequested || state != ExplorerPreviewState.Running || freshReadOnlyActive) return false;
                current = engine?.Session;
            }
            try { return current is IAvailabilityRetry { CanRetryAvailability: true }; }
            catch (Exception error) when (error is IOException or ObjectDisposedException) { return false; }
        }
    }
    public async Task RetryAvailabilityAsync() {
        CancellationToken token;
        lock (lifetime) { ObjectDisposedException.ThrowIf(disposed || closeRequested, this); token = cancellation.Token; }
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            token.ThrowIfCancellationRequested();
            if (State != ExplorerPreviewState.Running || FreshReadOnlyActive || engine?.Session is not IAvailabilityRetry { CanRetryAvailability: true } retry)
                throw new InvalidOperationException("File availability retry is unavailable.");
            await retry.RetryAvailabilityAsync().ConfigureAwait(false);
        } finally { operations.Release(); }
    }

    public Task StartAsync() => CanStartPublishedFresh ? ComposeColdFreshRestartAsync(explicitLogin: true, CancellationToken.None) : StartCoreAsync(explicitLogin: true);
    public bool CanReconnectCached => CanStartPublishedFresh || ObserveSavedCapability(emptyInventory: false, disconnectedBackend: true);
    private bool ObserveSavedCapability(bool emptyInventory, bool disconnectedBackend)
    {
        ConnectedExplorerEngine owned; Index saved; long epoch;
        lock (view) {
            if (disposed || closeRequested || invalidIndex || freshPreparationReview || heldFreshAdapter is not null || heldFreshSelector is not null || (disconnectedBackend && backend is not null) || index is not { } currentIndex || engine is not { } currentEngine) return false;
            owned = currentEngine; saved = currentIndex; epoch = viewEpoch;
        }
        // A UI hint is not authority. Inspect one captured generation outside view; a
        // concurrent drain/replacement invalidates the observation, never another engine.
        try {
            if (ValidatePreviousRemoval(saved, owned)) return false;
            var engineState = owned.Session.State;
            if (emptyInventory ? engineState is not (ExplorerPreviewState.NotStarted or ExplorerPreviewState.Running or ExplorerPreviewState.Paused)
                : engineState != ExplorerPreviewState.NotStarted) return false;
            var frozen = owned.ReadFrozenManifest();
            if (frozen is null || frozen.Scope != Scope(saved) || (emptyInventory && (frozen.Files.Count != 0 || frozen.Directories.Count != 0))) return false;
            lock (view) return !disposed && !closeRequested && !invalidIndex && !freshPreparationReview && heldFreshAdapter is null && heldFreshSelector is null && viewEpoch == epoch &&
                ReferenceEquals(engine, owned) && ReferenceEquals(index, saved) && (!disconnectedBackend || backend is null);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException or ObjectDisposedException) { return false; }
    }
    // Read only the ownership/readiness already established by this instance. A partial,
    // invalid or changed generation is never interpreted as an absent connection.
    internal SavedProfileState StartupProfileState => invalidIndex || closeRequested || disposed
        ? SavedProfileState.NeedsReview
        : CanStartPublishedFresh ? SavedProfileState.OwnedReady
        : index is null ? SavedProfileState.Absent
        : CanReconnectCached ? SavedProfileState.OwnedReady
        : State == ExplorerPreviewState.Removed ? SavedProfileState.Removed : SavedProfileState.NeedsReview;

    /// <summary>Reopens only an existing ready frozen generation using cached authorization. Never signs in or captures.</summary>
    internal Task ReconnectCachedAsync() => CanStartPublishedFresh ? ComposeColdFreshRestartAsync(explicitLogin: false, CancellationToken.None) : StartCoreAsync(explicitLogin: false);
    Task ICachedExplorerReconnect.ReconnectCachedAsync() => ReconnectCachedAsync();
    private Task StartCoreAsync(bool explicitLogin) => OperateAsync(explicitLogin ? ConnectionAction.ExplicitConnect : ConnectionAction.CachedReconnect, async (token, trace) => {
        starting = true; SetState(ExplorerPreviewState.Starting);
        try {
            var previousRemoved = ValidatePreviousRemoval();
            ExplorerRootManifest? cachedInventory = null;
            if (!explicitLogin) {
                if (index is null || previousRemoved || engine is null ||
                    engine.Session.State is not (ExplorerPreviewState.NotStarted or ExplorerPreviewState.Running or ExplorerPreviewState.Paused) ||
                    (cachedInventory = engine.ReadFrozenManifest()) is null || cachedInventory.Scope != Scope(index))
                    throw new IOException("Cached reconnect requires an owned ready frozen Explorer connection.");
            }
            if (!previousRemoved && engine?.Session.State == ExplorerPreviewState.Failed) {
                Add("The saved Explorer setup needs local cleanup or ownership review before another sign-in. Use Remove this connection for normal cleanup.");
                throw new IOException("The saved Explorer setup is incomplete.");
            }
            await DrainCurrentAsync(trace); token.ThrowIfCancellationRequested();
            trace.Phase = ConnectionPhase.LocalOwnership;
            AcquireExistingIndexLease();
            token.ThrowIfCancellationRequested();
            trace.Phase = ConnectionPhase.BackendConstruction;
            backend = createBackend();
            trace.Phase = ConnectionPhase.SourceSelection;
            var selected = SelectedSource(backend);
            Add(explicitLogin ? "Waiting for browser sign-in to finish." : "Checking your saved sign-in.");
            trace.Phase = ConnectionPhase.ExplicitLogin;
            if (explicitLogin) await backend.Session.SignInAsync(token); // Only this explicit user-button path may launch a browser.
            token.ThrowIfCancellationRequested();
            var person = await CurrentPersonAsync(backend, selected, token, trace, explicitLogin ? null : index!.PrincipalId);
            Add("Sign-in confirmed. Preparing your files for Explorer.");
            if (index is { } previous && previous.PrincipalId != person && !previousRemoved) {
                Add("A different account is signed in. The previous Explorer connection needs review before connecting this account.");
                throw new AccessDeniedException();
            }
            var scope = new ExplorerRootScope(channel, alias, origin, person);
            // The root engine also makes cached source requests with optional/default caller tokens.
            // Bind all of those requests and later hydrations to this coordinator generation's lifetime.
            var lifetimeSource = new LifetimeQueuedDownloadSource(selected, token);
            trace.Phase = ConnectionPhase.ProviderPreparation;
            var candidate = Create(scope, lifetimeSource, null);
            SetEngine(candidate);
            if (index is not null && !previousRemoved && !candidate.HasOwnedProfileReceipt())
                throw new IOException("The existing connection's ownership receipt disappeared before reconnecting.");
            ExplorerRootManifest? inventory = candidate.ReadFrozenManifest();
            if (candidate.Session.State == ExplorerPreviewState.Failed)
                throw new IOException("The saved Explorer folder needs ownership review before reconnecting.");
            if (!explicitLogin && (inventory is null || inventory.Digest != cachedInventory!.Digest ||
                inventory.Scope != cachedInventory.Scope || candidate.Session.State is not (ExplorerPreviewState.NotStarted or ExplorerPreviewState.Paused)))
                throw new IOException("The ready frozen Explorer inventory changed before cached reconnect.");
            var refreshedEmpty = false;
            if (explicitLogin && !previousRemoved && index is not null &&
                inventory is { Files.Count: 0, Directories.Count: 0 } empty && candidate.Session.State == ExplorerPreviewState.NotStarted) {
                Add("Checking the current file list after your explicit sign-in.");
                var refreshed = await CaptureInventoryAsync(backend, scope, person, token, trace);
                _ = await CurrentPersonAsync(backend, selected, token, trace, person);
                token.ThrowIfCancellationRequested();
                trace.Phase = ConnectionPhase.LocalOwnership;
                if (refreshed.Files.Count != 0 || refreshed.Directories.Count != 0) {
                    if (!candidate.HasOwnedProfileReceipt() || candidate.ReadFrozenManifest() is not { } unchanged ||
                        unchanged.Digest != empty.Digest || unchanged.Scope != scope)
                        throw new IOException("The empty saved inventory changed before refresh.");
                    // Remove validates the exact existing native/profile ownership and keeps every local file.
                    // Never replay an uncertain removal. Persist its confirmed outcome even if quit arrives meanwhile.
                    trace.Phase = ConnectionPhase.ProviderRemoval;
                    await candidate.Session.RemoveAsync();
                    if (candidate.Session.State != ExplorerPreviewState.Removed)
                        throw new IOException("The empty Explorer connection did not confirm removal.");
                    trace.Phase = ConnectionPhase.OwnershipPublication;
                    SaveIndex(person, removed: true);
                    token.ThrowIfCancellationRequested();
                    await DisposeEngineAsync(trace); token.ThrowIfCancellationRequested();
                    inventory = refreshed;
                    trace.Phase = ConnectionPhase.ProviderPreparation;
                    SetEngine(Create(scope, lifetimeSource, inventory));
                    refreshedEmpty = true;
                    Add("The empty connection was refreshed. Explorer will use a new owned folder; check the previous folder for local files.");
                } else Add("The current authorized file list is still empty. The existing connection remains in place.");
            }
            if (inventory is null) {
                if (candidate.Session.State is not (ExplorerPreviewState.NotStarted or ExplorerPreviewState.Removed))
                    throw new IOException("The saved Explorer inventory is unavailable.");
                await DisposeEngineAsync(trace); token.ThrowIfCancellationRequested();
                inventory = await CaptureInventoryAsync(backend, scope, person, token, trace);
                trace.Phase = ConnectionPhase.ProviderPreparation;
                SetEngine(Create(scope, lifetimeSource, inventory));
            }
            else if (!refreshedEmpty) Add($"Using this PC's saved file list ({inventory.Files.Count} files).");
            if (inventory.Scope != scope) throw new AccessDeniedException();
            _ = await CurrentPersonAsync(backend, selected, token, trace, person);
            token.ThrowIfCancellationRequested();
            trace.Phase = ConnectionPhase.OwnershipPublication;
            if (explicitLogin) SaveIndex(person); // Retain the cleanup identity even if subsequent native setup stops partway through.
            else token.ThrowIfCancellationRequested(); // Ready reconnect has durable ownership already; never republishes its index.
            // Engine writes Prepared ownership before its lifetime-bound cached preflight observes cancellation.
            Add("Connecting your prepared files to Windows Explorer.");
            trace.Phase = ConnectionPhase.ProviderStart;
            await engine!.Session.StartAsync();
            token.ThrowIfCancellationRequested();
            // A saved manual pause is legacy UI state, not an access preference. Only resume
            // after this generation has freshly verified the same selected principal; the
            // source gate still performs its own current-session check without browser login.
            if (engine.Session.State == ExplorerPreviewState.Paused) {
                trace.Phase = ConnectionPhase.ProviderResume;
                await engine.Session.ResumeAsync();
                token.ThrowIfCancellationRequested();
            }
            SetState(engine.Session.State);
            Add(InventoryEmpty
                ? "Your account is connected. This PC's saved file list is empty. Sign in and refresh the file list to check current sharing."
                : "Your selected files are connected in Explorer. This connection does not enable uploads.");
        } finally { starting = false; }
    });

    private async Task<ExplorerRootManifest> CaptureInventoryAsync(IFilesBackend selectedBackend, ExplorerRootScope scope, string person, CancellationToken token, ConnectionFailureTrace trace, bool checkOnly = false)
    {
        trace.Phase = ConnectionPhase.InventoryPreparation;
        Add(checkOnly ? "Checking the current shared file list." : "Preparing the current file list. Large files can take longer.");
        var snapshot = await capture(selectedBackend, channel, person, token);
        token.ThrowIfCancellationRequested();
        if (snapshot.Channel != channel || snapshot.Alias != alias || snapshot.Origin != origin || snapshot.PrincipalId != person)
            throw new AccessDeniedException();
        var inventory = new ExplorerRootManifest(scope, snapshot.Files, snapshot.Directories);
        if (!checkOnly) Add($"Prepared {snapshot.Files.Count} files for File Explorer.");
        return inventory;
    }

    // Explicit observation only. A paged catalog has no atomic server revision and
    // is never authority to create, change, remove, or rebind local placeholders.
    internal Task CheckCatalogChangesAsync(CancellationToken cancellationToken = default) => OperateAsync(ConnectionAction.CatalogCheck, async (token, trace) => {
        if (State != ExplorerPreviewState.Running || engine is not { } current || backend is not { } currentBackend ||
            index is not { Removed: false } saved || current.ObserveConnectedGeneration is not { } observe ||
            current.Session.State != ExplorerPreviewState.Running) throw new IOException("A running owned files connection is required.");
        var before = observe();
        var manifest = current.ReadFrozenManifest() ?? throw new IOException("The saved file list is unavailable.");
        if (before.ManifestDigest != manifest.Digest || before.Scope != manifest.Scope || before.Scope.PrincipalId != saved.PrincipalId)
            throw new IOException("The saved file list changed.");
        var selected = SelectedSource(currentBackend);
        var principal = await CurrentPersonAsync(currentBackend, selected, token, trace, saved.PrincipalId).ConfigureAwait(false);
        var observed = await CaptureInventoryAsync(currentBackend, manifest.Scope, principal, token, trace, checkOnly: true).ConfigureAwait(false);
        _ = await CurrentPersonAsync(currentBackend, selected, token, trace, principal).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (!ReferenceEquals(engine, current) || !ReferenceEquals(backend, currentBackend) || index != saved ||
            ReadIndex() != saved || State != ExplorerPreviewState.Running || current.Session.State != ExplorerPreviewState.Running || observe() != before ||
            current.ReadFrozenManifest()?.Digest != manifest.Digest)
            throw new IOException("The files connection changed while checking.");
        var difference = CatalogSemanticComparison.Compare(manifest, observed);
        var changedReferences = observed.Files.Count(pair => manifest.Files.TryGetValue(pair.Key, out var old) && old.ResourceReference != pair.Value.ResourceReference);
        Add(difference.HasDifferences || changedReferences != 0
            ? $"File check observed {difference.NewFiles} new files, {difference.ChangedFiles} changed files, {difference.MissingFiles} missing files, {difference.NewDirectories} new folders, {difference.MissingDirectories} missing folders, and {changedReferences} changed file references. Explorer was not updated; sharing may have changed during the check."
            : "File check observed no differences. Explorer was not updated; sharing may have changed during the check.");
    }, cancellationToken);

    public Task PauseAsync() => OperateAsync(ConnectionAction.Pause, async (token, trace) => {
        token.ThrowIfCancellationRequested();
        if (engine is null || backend is null) throw new LoginRequiredException();
        trace.Phase = ConnectionPhase.ProviderPause;
        await engine.Session.PauseAsync(); token.ThrowIfCancellationRequested(); SetState(engine.Session.State);
    });
    public Task ResumeAsync() => OperateAsync(ConnectionAction.Resume, async (token, trace) => {
        if (engine is null || backend is null || index is null) throw new LoginRequiredException();
        await CurrentPersonAsync(backend, SelectedSource(backend), token, trace, index.PrincipalId);
        trace.Phase = ConnectionPhase.ProviderResume;
        await engine.Session.ResumeAsync(); token.ThrowIfCancellationRequested(); SetState(engine.Session.State);
    });
    internal Task RecheckSessionAsync() => OperateAsync(ConnectionAction.Recheck, async (token, trace) => {
        if (backend is null || index is null || engine is null) return;
        TransientRecheckRecovery? recovery;
        lock (view) recovery = transientRecovery;
        if (State == ExplorerPreviewState.Failed && (recovery is null || !RecoveryStillOwned(recovery, ExplorerPreviewState.Paused, requirePending: true))) {
            ClearTransientRecovery(); return;
        }
        if (State is not (ExplorerPreviewState.Running or ExplorerPreviewState.Paused or ExplorerPreviewState.Failed)) {
            ClearTransientRecovery(); return;
        }
        try { await CurrentPersonAsync(backend, SelectedSource(backend), token, trace, index.PrincipalId); }
        catch { Add("Your sign-in or file access could not be verified. New downloads have stopped; reconnect the same account or remove this connection before choosing another."); throw; }
        if (recovery is not null) {
            token.ThrowIfCancellationRequested();
            trace.Phase = ConnectionPhase.LocalOwnership;
            if (!RecoveryStillOwned(recovery, ExplorerPreviewState.Paused, requirePending: true)) throw new IOException("The paused recovery generation changed.");
            // Resume performs the root engine's own current cached-source gate checks.
            // No new backend, browser login, inventory capture or index publication occurs.
            ClearTransientRecovery();
            trace.Phase = ConnectionPhase.ProviderResume;
            await recovery.Engine.Session.ResumeAsync(); token.ThrowIfCancellationRequested();
            trace.Phase = ConnectionPhase.LocalOwnership;
            if (!RecoveryStillOwned(recovery, ExplorerPreviewState.Running)) throw new IOException("The recovery did not confirm its running generation.");
            SetState(ExplorerPreviewState.Running);
            Add("Downloads resumed automatically after your current account and file access were verified.");
        }
    });
    // This identity comes from the current selected server session, never saved UI text or a caller argument.
    // The updater must independently recheck the same principal under its own cached-session pin.
    internal async Task<ConnectedExplorerUpdateBinding> GetUpdateBindingAsync(CancellationToken cancellationToken = default)
    {
        ConnectedExplorerUpdateBinding? result = null;
        await OperateAsync(ConnectionAction.UpdateBinding, async (token, trace) => {
            if (channel != "pilot" || alias is not ("portal" or "employee") || backend is null || index is null || engine is null ||
                State is not (ExplorerPreviewState.Running or ExplorerPreviewState.Paused) || ValidatePreviousRemoval() ||
                engine.ReadFrozenManifest()?.Scope != Scope(index))
                throw new LoginRequiredException();
            var selected = backend;
            var source = SelectedSource(selected);
            using var pin = selected is LiveBackend live ? await live.PinCatalogSessionAsync(token).ConfigureAwait(false) : null;
            var principal = await CurrentPersonAsync(selected, source, token, trace, index.PrincipalId).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            result = new(channel, alias, principal);
        }, cancellationToken).ConfigureAwait(false);
        return result ?? throw new AccessDeniedException();
    }
    public Task RemoveAsync() => OperateAsync(ConnectionAction.Remove, async (token, trace) => {
        token.ThrowIfCancellationRequested();
        if (FreshReadOnlyActive)
            throw new IOException("The active fresh-files connection is read-only and cannot be removed from this session.");
        _ = ValidatePreviousRemoval();
        // Never retain a signed-in backend for removal: the cleanup engine's source always denies network operations.
        trace.Phase = ConnectionPhase.LocalOwnership;
        if (heldFreshSelector is { } fresh) {
            if (!ValidRemovableFreshSelector(fresh)) throw new IOException("The fresh-files selector needs ownership review before removal.");
            if (heldFreshAdapter is not null) await StopPublishedFreshCoreAsync().ConfigureAwait(false);
            if (heldColdRestart is not null) await StopColdFreshRestartCoreAsync().ConfigureAwait(false);
            await DrainCurrentAsync(trace).ConfigureAwait(false); token.ThrowIfCancellationRequested();
            await RemovePublishedFreshAsync(token, trace).ConfigureAwait(false);
            return;
        }
        await DrainCurrentAsync(trace); token.ThrowIfCancellationRequested();
        if (index is null) { SetState(ExplorerPreviewState.Removed); return; }
        AcquireExistingIndexLease(); RestoreCleanupEngine();
        _ = ValidatePreviousRemoval();
        trace.Phase = ConnectionPhase.ProviderRemoval;
        await engine!.Session.RemoveAsync(); token.ThrowIfCancellationRequested();
        if (engine.Session.State != ExplorerPreviewState.Removed)
            throw new IOException("The saved Explorer connection did not confirm removal.");
        // A preflight failure may leave no engine profile to persist its Removed phase.
        // Publish this confirmation only after exact owned cleanup, so it survives restart.
        trace.Phase = ConnectionPhase.OwnershipPublication;
        SaveIndex(index.PrincipalId, removed: true);
        SetState(ExplorerPreviewState.Removed);
        Add("The Explorer connection was removed. Check the previous folder for local files; online-only items may no longer be present.");
    });

    private bool ValidRemovableFreshSelector(FreshGenerationIndexCodec.Index expected) =>
        expected.State.Phase == FreshGenerationPlan.Phase.Published && expected.State.New is { } current &&
        expected.State.ReadyRoot is not null && expected.ActiveGeneration == current.Id &&
        expected.Sid == sid && expected.Channel == channel && expected.Source == alias && expected.OriginSha256 == originHash;

    // The generation selector itself is the removal journal. We preserve both root
    // directories and their files; only exact Windows registrations are removed.
    private async Task RemovePublishedFreshAsync(CancellationToken token, ConnectionFailureTrace trace)
    {
        var expected = heldFreshSelector ?? throw new IOException("No fresh-files selector is available.");
        if (!ValidRemovableFreshSelector(expected)) throw new IOException("The fresh-files selector is not a removable published generation.");
        var lockPath = Path.Combine(indexDirectory, "index.lock");
        if (!File.Exists(lockPath) || (File.GetAttributes(lockPath) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
            throw new IOException("The fresh-files selector lock is unavailable.");
        indexLease ??= new FileStream(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        var pin = new FreshGenerationIndexLockPin(indexLease, lockPath);
        var selectorPath = Path.Combine(indexDirectory, FreshGenerationIndexStore.Current);
        var backupPath = Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup);
        var current = expected;
        bool ExactSelector() => pin.StillHeld(indexLease) &&
            FreshGenerationStartup.Observe(selectorPath, backupPath, sid, channel, alias, originHash) == current;
        byte[] CurrentBytes()
        {
            if (!ExactSelector()) throw new IOException("The fresh-files selector changed during removal.");
            var info = new FileInfo(selectorPath);
            if (!info.Exists || info.Length is < 1 or > 16384 || (info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                throw new IOException("The fresh-files selector is missing or invalid.");
            byte[] bytes;
            using (var stream = new FileStream(selectorPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                if (stream.Length != info.Length) throw new IOException("The fresh-files selector changed while opening.");
                bytes = new byte[(int)stream.Length]; stream.ReadExactly(bytes);
            }
            if (!FreshGenerationIndexCodec.Decode(bytes).Equals(current)) throw new IOException("The fresh-files selector changed during removal.");
            return bytes;
        }
        async Task Publish(FreshGenerationIndexCodec.Index next)
        {
            var priorBytes = CurrentBytes();
            await FreshGenerationIndexStore.PublishAsync(indexDirectory, priorBytes, next,
                () => pin.StillHeld(indexLease), _ => null).ConfigureAwait(false);
            current = next;
            if (!ExactSelector()) throw new IOException("The fresh-files removal journal could not be confirmed.");
        }
        var scope = new ExplorerRootScope(channel, alias, origin, expected.Principal);
        var ready = expected.State.ReadyRoot!;
        var candidate = expected.State.New! with {
            ProfileRevision = ready.ProfileRevision,
            ProfileDocumentVolume = ready.ProfileDocumentVolume,
            ProfileDocumentFileId = ready.ProfileDocumentFileId,
            RootVolume = ready.Volume,
            RootFileId = ready.FileId,
            NamespaceClsid = ready.NamespaceClsid
        };
        async Task<FreshGenerationPlan.RemovalReceipt?> RemoveRoot(FreshGenerationPlan.Generation generation,
            Func<bool> selectorProof, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!selectorProof()) return null;
            if (syntheticFreshRootRemoval is not null)
                return await syntheticFreshRootRemoval(generation, selectorProof, cancellationToken).ConfigureAwait(false);
            var root = new OwnedExplorerRootSession(generation.ProfileDirectory, generation.RootPath,
                new CleanupSource(alias, new Uri(origin)), scope);
            var binding = new OwnedExplorerRemovalBinding(generation.Id, scope, generation.ProfileDirectory, generation.RootPath,
                generation.ManifestDigest, generation.ProfileDirectoryVolume, generation.ProfileDirectoryFileId,
                generation.ProfileRevision, generation.ProfileDocumentVolume, generation.ProfileDocumentFileId,
                generation.RootVolume, generation.RootFileId, generation.NamespaceClsid);
            try {
                await root.RemoveFreshGenerationAsync(binding, selectorProof).ConfigureAwait(false);
                var evidence = root.RemovedGenerationEvidence;
                if (root.State != ExplorerPreviewState.Removed || evidence is null || !selectorProof()) return null;
                return new(evidence.Identity, evidence.ProfileVolume, evidence.ProfileFileId, evidence.ProfileRevision);
            } finally { await root.DisposeAsync().ConfigureAwait(false); }
        }

        trace.Phase = ConnectionPhase.ProviderRemoval;
        var completed = await FreshGenerationRemovalCoordinator.RemoveAsync(expected, () => {
            if (!ExactSelector()) throw new IOException("The fresh-files selector changed during removal.");
            return current;
        }, Publish, (generation, proof, cancellationToken) =>
            RemoveRoot(generation.Id == candidate.Id ? candidate : generation, proof, cancellationToken), token).ConfigureAwait(false);
        if (completed.State.Removal != FreshGenerationPlan.RemovalPhase.Complete || !ExactSelector())
            throw new IOException("Both fresh-files registrations were not confirmed removed.");
        heldFreshSelector = completed;
        invalidIndex = false;
        indexLease.Dispose(); indexLease = null;
        SetState(ExplorerPreviewState.Removed);
        Add("The Explorer connection was removed. Both files folders were kept; online-only items may no longer be present locally.");
    }

    private async Task OperateAsync(ConnectionAction operation, Func<CancellationToken, ConnectionFailureTrace, Task> action, CancellationToken requestedCancellation = default)
    {
        CancellationToken connectionToken;
        lock (lifetime) { ObjectDisposedException.ThrowIf(disposed || closeRequested, this); connectionToken = cancellation.Token; }
        using var linked = requestedCancellation.CanBeCanceled ? CancellationTokenSource.CreateLinkedTokenSource(connectionToken, requestedCancellation) : null;
        var token = linked?.Token ?? connectionToken;
        await operations.WaitAsync(token).ConfigureAwait(false);
        var trace = new ConnectionFailureTrace(operation);
        ExplorerPreviewState previousState; TransientRecheckRecovery? previousRecovery;
        ConnectedExplorerEngine? previousEngine; IFilesBackend? previousBackend; Index? previousIndex; long observedEpoch;
        lock (view) {
            previousState = state; previousRecovery = state == ExplorerPreviewState.Failed ? transientRecovery : null;
            previousEngine = engine; previousBackend = backend; previousIndex = index;
            if ((operation != ConnectionAction.Recheck || previousState != ExplorerPreviewState.Failed) && transientRecovery is not null) {
                transientRecovery = null; viewEpoch++;
            }
            observedEpoch = viewEpoch;
        }
        var wasRunning = false;
        try {
            if (operation != ConnectionAction.Remove &&
                (heldFreshAdapter is not null || heldColdRestart is not null || coldPreparationReview || freshPreparationReview))
                throw new IOException("Fresh connection ownership needs review before further operations.");
            var observedRunning = operation == ConnectionAction.Recheck && previousState == ExplorerPreviewState.Running &&
                previousEngine?.Session.State == ExplorerPreviewState.Running;
            lock (view) wasRunning = observedRunning && viewEpoch == observedEpoch && ReferenceEquals(engine, previousEngine);
            token.ThrowIfCancellationRequested();
            if (invalidIndex && !(operation == ConnectionAction.Remove && heldFreshSelector is { } removable && ValidRemovableFreshSelector(removable)))
                throw new IOException("The saved Explorer index needs ownership review.");
            await action(token, trace).ConfigureAwait(false);
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) when (operation == ConnectionAction.CatalogCheck && CatalogCheckIncomplete(error)) {
            // A transient metadata failure does not establish that current access was revoked.
            // Keep the existing provider running; explicit sign-in/permission failures still fail closed below.
            Add(error is CatalogCaptureException capture
                ? "The file check was incomplete. Your existing connection was kept. Support code: " + capture.SupportCode + (capture.Limit == CatalogCaptureLimit.EntryCount ? "; this version supports at most 1,000 files and folders." : "")
                : "The file check was incomplete. Your existing connection was kept. " + trace.Failure(error));
            throw;
        }
        catch (Exception) when (heldFreshAdapter is not null || heldColdRestart is not null || coldPreparationReview || freshPreparationReview) {
            // A denied mutation must not pause or change the retained provider.
            throw;
        }
        catch (Exception error) {
            var primary = trace.Failure(error);
            var paused = false;
            if (engine?.Session.State == ExplorerPreviewState.Running) {
                try { await engine.Session.PauseAsync().ConfigureAwait(false); paused = engine.Session.State == ExplorerPreviewState.Paused; }
                catch (Exception pauseError) {
                    Add("The file provider could not confirm its pause; keep this app open for ownership review.");
                    Add(ConnectionFailureTrace.Format(operation, ConnectionPhase.ProviderPause, pauseError));
                }
            }
            if (engine is null && index is not null) {
                try { RestoreCleanupEngine(); } catch { /* retain the index for exact ownership review */ }
            }
            TransientRecheckRecovery? nextRecovery = null;
            long recoveryProofEpoch = -1;
            if (operation == ConnectionAction.Recheck && (trace.Phase is ConnectionPhase.CurrentSession or ConnectionPhase.SourceSession) &&
                TransientRecheckFailure(error) && previousEngine is not null && previousBackend is not null && previousIndex is not null &&
                (wasRunning && paused || previousRecovery is not null && IsCurrentRecovery(previousRecovery))) {
                try {
                    var candidate = previousRecovery ?? new TransientRecheckRecovery(previousEngine, previousBackend, previousIndex,
                        previousEngine.ReadFrozenManifest()?.Digest ?? "");
                    lock (view) recoveryProofEpoch = viewEpoch;
                    if (RecoveryStillOwned(candidate, ExplorerPreviewState.Paused)) nextRecovery = candidate;
                } catch { /* Unknown local ownership is a manual hold, never automatic recovery. */ }
            }
            // Ownership/I/O above stays outside the view lock. Publish these two fields
            // together so a late paused-provider Activity event cannot lose the retry.
            lock (view) {
                state = ExplorerPreviewState.Failed;
                transientRecovery = viewEpoch == recoveryProofEpoch ? nextRecovery : null;
                viewEpoch++;
            }
            Notify();
            Add(heldFreshSelector is not null
                ? "This fresh-files transition needs ownership review. Ask your LedgeTop contact to check the saved connections."
                : FailureActivity(error));
            Add(primary);
            TryPersistFailure(primary);
            if (CanRecoverTransientSession)
                Add("The file service is temporarily unavailable. Downloads will be checked again automatically; files already on this PC are kept.");
            throw;
        } finally { operations.Release(); }
    }

    private static bool TransientRecheckFailure(Exception error) => error is TransferException transfer &&
        (transfer.Reason is TransferFailureReason.Network or TransferFailureReason.Timeout ||
         transfer.Reason == TransferFailureReason.UnexpectedHttpStatus && transfer.HttpStatus is 502 or 503 or 504);

    private static bool CatalogCheckIncomplete(Exception error) => error switch {
        CatalogCaptureException capture => capture.Limit != CatalogCaptureLimit.None ||
            capture.Reason is TransferFailureReason.Network or TransferFailureReason.Timeout or TransferFailureReason.ResponseRead or TransferFailureReason.ServiceBusy ||
            capture.Reason == TransferFailureReason.UnexpectedHttpStatus && capture.HttpStatus is 502 or 503 or 504,
        TransferException transfer => transfer.Reason is TransferFailureReason.Network or TransferFailureReason.Timeout or TransferFailureReason.ResponseRead or TransferFailureReason.ServiceBusy ||
            transfer.Reason == TransferFailureReason.UnexpectedHttpStatus && transfer.HttpStatus is 502 or 503 or 504,
        _ => false
    };

    private bool IsCurrentRecovery(TransientRecheckRecovery pending) { lock (view) return ReferenceEquals(transientRecovery, pending); }
    private bool RecoveryStillOwned(TransientRecheckRecovery pending, ExplorerPreviewState expectedState, bool requirePending = false)
    {
        long observedEpoch;
        lock (view) {
            if (requirePending && !ReferenceEquals(transientRecovery, pending)) return false;
            observedEpoch = viewEpoch;
        }
        if (disposed || closeRequested || invalidIndex || indexLease is null || pending.InventoryDigest.Length == 0 ||
            !ReferenceEquals(engine, pending.Engine) || !ReferenceEquals(backend, pending.Backend) || !ReferenceEquals(index, pending.Index) ||
            pending.Index.Removed || pending.Engine.Session.State != expectedState || ReadIndex() != pending.Index ||
            ValidatePreviousRemoval() || !pending.Engine.HasOwnedProfileReceipt()) return false;
        var frozen = pending.Engine.ReadFrozenManifest();
        if (frozen is null || frozen.Scope != Scope(pending.Index) || frozen.Digest != pending.InventoryDigest) return false;
        lock (view) return viewEpoch == observedEpoch && ReferenceEquals(engine, pending.Engine) &&
            ReferenceEquals(backend, pending.Backend) && ReferenceEquals(index, pending.Index) &&
            (!requirePending || ReferenceEquals(transientRecovery, pending));
    }

    private IQueuedDownloadSource SelectedSource(IFilesBackend selected)
    {
        if (selected is null || selected.Sources.Count != 1 || selected.Session is null || selected.Catalog is null)
            throw new AccessDeniedException();
        var source = selected.Sources[0];
        if (source is null || source.Alias != alias || CanonicalOrigin(source.Origin) != origin) throw new AccessDeniedException();
        return source;
    }
    private async Task<string> CurrentPersonAsync(IFilesBackend selected, IQueuedDownloadSource source, CancellationToken token, ConnectionFailureTrace trace, string? expected = null)
    {
        trace.Phase = ConnectionPhase.SourceSelection;
        if (!ReferenceEquals(source, SelectedSource(selected))) throw new AccessDeniedException();
        trace.Phase = ConnectionPhase.CurrentSession;
        var current = selected.Session is IConnectionSessionGateway diagnostic
            ? await diagnostic.CheckCurrentForConnectionAsync(token).ConfigureAwait(false)
            : await selected.Session.TryCurrentAsync(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (current is null) throw new LoginRequiredException();
        trace.Phase = ConnectionPhase.SourceSession;
        var actual = await source.GetSessionAsync(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        trace.Phase = ConnectionPhase.PrincipalBinding;
        if (!ReferenceEquals(source, SelectedSource(selected)) || current.PrincipalId != actual.PrincipalId ||
            expected is not null && actual.PrincipalId != expected || !Principal(actual.PrincipalId)) throw new AccessDeniedException();
        trace.Phase = ConnectionPhase.SessionExpiry;
        if (current.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5) || actual.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5))
            throw new LoginRequiredException();
        return actual.PrincipalId;
    }

    private ExplorerRootScope Scope(Index item) => new(channel, alias, origin, item.PrincipalId);
    private string ProfileDirectory(ExplorerRootScope scope) => Path.Combine(indexDirectory, "profiles", Hash(channel + "\n" + alias + "\n" + origin + "\n" + scope.PrincipalId));
    private ConnectedExplorerEngine Create(ExplorerRootScope scope, IQueuedDownloadSource source, ExplorerRootManifest? manifest) =>
        createEngine(new(ProfileDirectory(scope), preferredRoot, source, scope, manifest));
    private void RestoreCleanupEngine()
    {
        if (index is null || engine is not null) return;
        var scope = Scope(index);
        SetEngine(Create(scope, new CleanupSource(alias, new Uri(origin)), null));
    }
    private bool ValidatePreviousRemoval() => ValidatePreviousRemoval(index, engine);
    private static bool ValidatePreviousRemoval(Index? saved, ConnectedExplorerEngine? owned)
    {
        if (saved is not null && !saved.Removed && (owned is null || !owned.HasOwnedProfileReceipt()))
            throw new IOException("The saved Explorer index has no validated ownership receipt. Its Windows outcome needs ownership review.");
        if (saved?.Removed == true && owned is not null &&
            owned.Session.State != ExplorerPreviewState.Removed &&
            (owned.Session.State != ExplorerPreviewState.NotStarted || owned.ReadFrozenManifest() is not null))
            throw new IOException("The saved removal confirmation contradicts the owned Explorer profile.");
        // An engine's durable Removed phase also covers a crash before the index update.
        return saved?.Removed == true || owned?.Session.State == ExplorerPreviewState.Removed;
    }
    private void SetEngine(ConnectedExplorerEngine? next)
    {
        ConnectedExplorerEngine? previous;
        lock (view) {
            previous = engine; engine = next;
            if (!ReferenceEquals(previous, next)) { transientRecovery = null; lastEngineState = null; }
            viewEpoch++;
        }
        if (previous is not null) { previous.Session.Changed -= EngineChanged; if (previous.Session is OwnedExplorerRootSession prior) { prior.HydrationTimingObserved -= ObserveHydrationTiming; prior.HydrationFailureObserved -= ObserveHydrationFailure; } }
        if (next is not null) { next.Session.Changed += EngineChanged; if (next.Session is OwnedExplorerRootSession current) { current.HydrationTimingObserved += ObserveHydrationTiming; current.HydrationFailureObserved += ObserveHydrationFailure; } }
        Notify();
    }
    private readonly object timingQueue = new();
    private readonly object failureQueue = new();
    private (OwnedExplorerRootSession Owner, HydrationFailureDiagnosticStore.Observation Value, DateTimeOffset At)? pendingHydrationFailure;
    private bool failureWorker;
#if DEBUG
    private Task failureWorkerTask = Task.CompletedTask;
    private Func<Task>? failureBarrierForTest;
    internal void SetFailureBarrierForTest(Func<Task> barrier)
    { if (syntheticFirstTransition is null) throw new IOException("Synthetic failure fixture required."); failureBarrierForTest=barrier; }
    internal Task ObserveHydrationFailureForTestAsync(OwnedExplorerRootSession owner, HydrationFailureDiagnosticStore.Observation value)
    { if (syntheticFirstTransition is null || !owner.IsSyntheticFixtureForTest) throw new IOException("Synthetic failure fixture required."); QueueHydrationFailure(owner,value); lock (failureQueue) return failureWorkerTask; }
#endif
    private void ObserveHydrationFailure(OwnedExplorerRootSession owner, HydrationFailureDiagnostic value)
    {
        if (!FreshGenerationStagingQualification.Allows(channel, alias, origin)) return;
        QueueHydrationFailure(owner, HydrationFailureDiagnosticStore.FromDiagnostic(value));
    }
    private void QueueHydrationFailure(OwnedExplorerRootSession owner, HydrationFailureDiagnosticStore.Observation value)
    {
        lock (view) {
            if (closeRequested || disposed || !ReferenceEquals(engine?.Session,owner)) return;
            lock (failureQueue) {
                pendingHydrationFailure = (owner,value,DateTimeOffset.UtcNow);
                if (failureWorker) return; failureWorker=true;
#if DEBUG
                failureWorkerTask=Task.Run(WriteHydrationFailureQueueAsync);
#else
                _=Task.Run(WriteHydrationFailureQueueAsync);
#endif
            }
        }
    }
    private async Task WriteHydrationFailureQueueAsync()
    {
        while (true) {
            (OwnedExplorerRootSession Owner, HydrationFailureDiagnosticStore.Observation Value, DateTimeOffset At) item;
            lock (failureQueue) { if (pendingHydrationFailure is not { } pending) { failureWorker=false; return; } item=pending; pendingHydrationFailure=null; }
#if DEBUG
            if (failureBarrierForTest is { } barrier) await barrier().ConfigureAwait(false);
#endif
            await operations.WaitAsync().ConfigureAwait(false);
            try {
                lock (view) { if (closeRequested || disposed || !ReferenceEquals(engine?.Session,item.Owner)) continue; }
                if (indexLease is not { } held) continue;
                var pin=new FreshGenerationIndexLockPin(held,Path.Combine(indexDirectory,"index.lock"));
                bool Owned() {
                    lock (view) { if (closeRequested || disposed || !ReferenceEquals(engine?.Session,item.Owner)) return false; }
                    if (!pin.StillHeld(indexLease)) return false;
                    if (heldFreshSelector is { } expected)
                        return FreshGenerationStartup.Observe(indexPath,Path.Combine(indexDirectory,FreshGenerationIndexStore.LegacyBackup),sid,channel,alias,originHash)==expected;
                    return !invalidIndex && index is { Removed:false } && ReadIndex()==index;
                }
                HydrationFailureDiagnosticStore.TrySave(indexDirectory,Owned,item.Value,item.At);
            } catch { /* Optional evidence must never alter transfers. */ }
            finally { operations.Release(); }
        }
    }
    private (OwnedExplorerRootSession Owner, HydrationTimingDiagnosticStore.Observation Value, DateTimeOffset At)? pendingTiming;
    private bool timingWorker;
#if DEBUG
    private Task timingWorkerTask = Task.CompletedTask;
    private Func<Task>? timingBarrierForTest;
    internal void SetTimingBarrierForTest(Func<Task> barrier)
    {
        if (syntheticFirstTransition is null) throw new IOException("Synthetic timing fixture required.");
        timingBarrierForTest = barrier;
    }
#endif
    private void ObserveHydrationTiming(OwnedExplorerRootSession owner, string text)
    {
        if (!FreshGenerationStagingQualification.Allows(channel, alias, origin)) return;
        QueueHydrationTiming(owner, text);
    }
#if DEBUG
    internal Task ObserveHydrationTimingForTestAsync(OwnedExplorerRootSession owner, string text)
    {
        if (syntheticFirstTransition is null || !owner.IsSyntheticFixtureForTest) throw new IOException("Synthetic timing fixture required.");
        QueueHydrationTiming(owner, text); lock (timingQueue) return timingWorkerTask;
    }
#endif
    private void QueueHydrationTiming(OwnedExplorerRootSession owner, string text)
    {
        var value = HydrationTimingDiagnosticStore.Parse(text); if (value is null) return;
        lock (timingQueue) {
            pendingTiming = (owner, value, DateTimeOffset.UtcNow);
            if (timingWorker) return; timingWorker = true;
#if DEBUG
            timingWorkerTask = Task.Run(WriteTimingQueueAsync);
#else
            _ = Task.Run(WriteTimingQueueAsync);
#endif
        }
    }
    private async Task WriteTimingQueueAsync()
    {
        while (true) {
            (OwnedExplorerRootSession Owner, HydrationTimingDiagnosticStore.Observation Value, DateTimeOffset At) item;
            lock (timingQueue) { if (pendingTiming is not { } pending) { timingWorker = false; return; } item = pending; pendingTiming = null; }
#if DEBUG
            if (timingBarrierForTest is { } barrier) await barrier().ConfigureAwait(false);
#endif
            await operations.WaitAsync().ConfigureAwait(false);
            try {
                lock (view) { if (closeRequested || disposed || !ReferenceEquals(engine?.Session, item.Owner)) continue; }
                if (indexLease is not { } held) continue;
                var pin = new FreshGenerationIndexLockPin(held, Path.Combine(indexDirectory, "index.lock"));
                bool Owned() {
                    if (!pin.StillHeld(indexLease)) return false;
                    if (heldFreshSelector is { } expected)
                        return FreshGenerationStartup.Observe(indexPath, Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) == expected;
                    return !invalidIndex && index is { Removed: false } && ReadIndex() == index;
                }
                HydrationTimingDiagnosticStore.TrySave(indexDirectory, Owned, item.Value, item.At);
            } catch { /* Optional diagnostics cannot alter transfers. */ }
            finally { operations.Release(); }
        }
    }
    private void EngineChanged(object? sender, EventArgs e)
    {
        ConnectedExplorerEngine? current; long observedEpoch;
        var publishStatus = false;
        lock (view) {
            current = engine;
            if (current is null || !ReferenceEquals(sender, current.Session)) return;
            observedEpoch = viewEpoch;
        }
        var engineState = current.Session.State; // Never take an engine/native lock while holding view.
        lock (view) {
            if (viewEpoch != observedEpoch || !ReferenceEquals(engine, current)) return;
            var changed = lastEngineState != engineState; lastEngineState = engineState;
            if (engineState != ExplorerPreviewState.Paused && transientRecovery is not null) { transientRecovery = null; changed = true; }
            // Events never promote a Failed hold. Explicit checked operations publish their
            // successful state only after awaiting authorization and engine completion.
            if (!starting && !closeRequested && state != ExplorerPreviewState.Failed && state != engineState) { state = engineState; changed = true; publishStatus = true; }
            if (changed) viewEpoch++;
        }
        if (publishStatus) QueueEngineStatus(current, engineState);
        Notify();
    }
    private readonly object statusQueue = new();
    private (ConnectedExplorerEngine Owner, ExplorerPreviewState State)? pendingEngineStatus;
    private bool statusWorker;
#if DEBUG
    private Task statusWorkerTask = Task.CompletedTask;
    private Func<Task>? statusBarrierForTest;
    internal Task WaitForEngineStatusForTestAsync() { lock (statusQueue) return statusWorkerTask; }
    internal void SetEngineStatusBarrierForTest(Func<Task> barrier) { statusBarrierForTest = barrier; }
    internal async Task ClearFakeEngineForStatusTestAsync()
    {
        await operations.WaitAsync().ConfigureAwait(false);
        try { if (engine?.Session is null or OwnedExplorerRootSession) throw new IOException("Fake engine required."); SetEngine(null); }
        finally { operations.Release(); }
    }
#endif
    private void QueueEngineStatus(ConnectedExplorerEngine owner, ExplorerPreviewState value)
    {
        lock (statusQueue) {
            pendingEngineStatus = (owner, value);
            if (statusWorker) return; statusWorker = true;
#if DEBUG
            statusWorkerTask = Task.Run(WriteEngineStatusAsync);
#else
            _ = Task.Run(WriteEngineStatusAsync);
#endif
        }
    }
    private async Task WriteEngineStatusAsync()
    {
        while (true) {
            (ConnectedExplorerEngine Owner, ExplorerPreviewState State) item;
            lock (statusQueue) { if (pendingEngineStatus is not { } pending) { statusWorker = false; return; } item = pending; pendingEngineStatus = null; }
#if DEBUG
            if (statusBarrierForTest is { } barrier) await barrier().ConfigureAwait(false);
#endif
            await operations.WaitAsync().ConfigureAwait(false);
            try {
                var actual = item.Owner.Session.State;
                lock (view) { if (closeRequested || disposed || !ReferenceEquals(engine, item.Owner) || state != item.State || actual != item.State) continue; }
                TryPersistStatus(item.State);
            } catch { /* Optional evidence cannot change the connection. */ }
            finally { operations.Release(); }
        }
    }
    private async Task DisposeEngineAsync(ConnectionFailureTrace? trace = null)
    {
        var owned = engine;
        if (owned is null) return;
        if (trace is not null) trace.Phase = ConnectionPhase.ProviderDrain;
        await Task.Run(async () => await owned.Session.DisposeAsync().ConfigureAwait(false)).ConfigureAwait(false);
        SetEngine(null);
    }
    private async Task DrainCurrentAsync(ConnectionFailureTrace? trace = null)
    {
        await DisposeEngineAsync(trace).ConfigureAwait(false);
        if (backend is { } previous) {
            if (trace is not null) trace.Phase = ConnectionPhase.BackendDispose;
            await Task.Run(async () => await previous.DisposeAsync().ConfigureAwait(false)).ConfigureAwait(false);
            backend = null;
        }
    }

    private Index ReadIndex()
    {
        Ancestors(indexDirectory, false);
        var file = new FileInfo(indexPath);
        if (!file.Exists || file.Length is < 1 or > 8192 || (file.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The saved Explorer index ownership marker is missing or invalid.");
        byte[] bytes;
        using (var stream = new FileStream(indexPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (stream.Length is < 1 or > 8192) throw new IOException("The saved Explorer index is too large.");
            bytes = new byte[stream.Length]; stream.ReadExactly(bytes);
        }
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 2 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() != root.EnumerateObject().Count())
            throw new JsonException();
        var item = JsonSerializer.Deserialize<Index>(bytes, json) ?? throw new JsonException();
        if (item.Schema != 1 || item.Owner != Owner || item.Sid != sid || item.Channel != channel || item.Alias != alias ||
            item.OriginSha256 != originHash || !Principal(item.PrincipalId) || item.Revision < 1)
            throw new IOException("The saved Explorer index belongs to a different user or trusted source.");
        return item;
    }
    private void AcquireExistingIndexLease()
    {
        if (!Directory.Exists(indexDirectory)) {
            if (index is not null || File.Exists(indexDirectory)) throw new IOException("The saved Explorer index disappeared or changed type.");
            return;
        }
        if (index is null || ReadIndex() != index) throw new IOException("The Explorer index changed outside this connection.");
        if (indexLease is null) {
            var path = Path.Combine(indexDirectory, "index.lock");
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("The Explorer index lock is an alias.");
            indexLease = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        if (ReadIndex() != index) throw new IOException("The Explorer index changed before its lease was acquired.");
    }
    private void SaveIndex(string principal, bool removed = false)
    {
        var next = new Index(1, Owner, sid, channel, alias, originHash, principal, checked((index?.Revision ?? 0) + 1), removed);
        if (index is null) {
            Ancestors(indexDirectory, true);
            if (Directory.Exists(indexDirectory) || File.Exists(indexDirectory)) throw new IOException("An existing unowned Explorer index directory was not adopted.");
            Directory.CreateDirectory(stateBase); Ancestors(stateBase, false);
            var temporary = Path.Combine(stateBase, ".connected-index-write-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporary); Ancestors(temporary, false);
            WriteIndex(Path.Combine(temporary, "current.json"), next);
            Directory.Move(temporary, indexDirectory); // Complete ownership marker and directory publish together, without replacement.
            index = next;
            AcquireExistingIndexLease();
        } else {
            AcquireExistingIndexLease();
            var temporary = Path.Combine(indexDirectory, ".current-write-" + Guid.NewGuid().ToString("N") + ".json");
            WriteIndex(temporary, next);
            if (ReadIndex() != index) throw new IOException("The Explorer index changed before atomic publication.");
            File.Move(temporary, indexPath, overwrite: true); index = next;
        }
    }
    private static void WriteIndex(string path, Index item)
    {
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        JsonSerializer.Serialize(stream, item, json); stream.Flush(flushToDisk: true);
    }

    public ValueTask DisposeAsync()
    {
        TaskCompletionSource done;
        lock (lifetime) {
            if (closing is not null) return new(closing);
            if (disposed) return ValueTask.CompletedTask;
            closeRequested = true;
            done = new(TaskCreationOptions.RunContinuationsAsynchronously); closing = done.Task;
        }
        ClearTransientRecovery();
        // Cancellation is visible before awaiting the operation lock, including an in-flight browser helper/catalog request.
        try { cancellation.Cancel(); } catch { Add("Cancellation reported a problem; the connection is still waiting for shutdown confirmation."); }
        _ = Task.Run(async () => {
            await operations.WaitAsync().ConfigureAwait(false);
            var trace = new ConnectionFailureTrace(ConnectionAction.Dispose);
            try {
                if (heldFreshAdapter is not null) {
                    if (!freshStopRetryAllowed) throw new IOException("Fresh connection ownership is retained for review.");
                    await StopPublishedFreshCoreAsync().ConfigureAwait(false);
                }
                if (heldColdRestart is not null) {
                    if (!coldStopRetryAllowed) throw new IOException("Fresh connection ownership is retained for review.");
                    await StopColdFreshRestartCoreAsync().ConfigureAwait(false);
                }
                if (coldPreparationReview) await DrainColdPreparationAsync().ConfigureAwait(false);
                if (freshPreparationReview) await DrainFreshPreparationAsync().ConfigureAwait(false);
                await DrainCurrentAsync(trace).ConfigureAwait(false);
                trace.Phase = ConnectionPhase.LocalOwnership;
                TryPersistStatus(ExplorerPreviewState.NotStarted);
                indexLease?.Dispose(); indexLease = null;
                lock (lifetime) disposed = true;
                if (State != ExplorerPreviewState.Removed) SetState(ExplorerPreviewState.NotStarted);
                cancellation.Dispose(); done.TrySetResult();
            } catch (Exception error) {
                SetState(ExplorerPreviewState.Failed);
                Add("The Explorer connection could not confirm shutdown. Its saved ownership needs review.");
                var primary = trace.Failure(error);
                Add(primary);
                TryPersistFailure(primary);
                lock (lifetime) { closeRequested = false; closing = null; cancellation.Dispose(); cancellation = new(); }
                done.TrySetException(error);
            } finally { operations.Release(); }
        });
        return new(done.Task);
    }

    private void TryPersistFailure(string supportCode)
    {
        // Both callers hold operations. Diagnostics are never authority or a lifecycle
        // decision, and cannot create an unowned index/lease or replace unknown data.
        try {
            bool OwnIndex() => channel == "pilot" && alias == "employee" && !invalidIndex && index is { Removed: false } &&
                indexLease is not null && !indexLease.SafeFileHandle.IsClosed && !indexLease.SafeFileHandle.IsInvalid && ReadIndex() == index;
            if (!OwnIndex()) return;
            ConnectionDiagnosticStore.TrySaveLatest(indexDirectory, OwnIndex, supportCode,
                typeof(ConnectedExplorerSession).Assembly.GetName().Version ?? new Version(0, 0, 0, 0), DateTimeOffset.UtcNow);
        } catch { /* Missing/uncertain local diagnostic ownership never changes connection handling. */ }
    }

    private static bool Principal(string? value) => Regex.IsMatch(value ?? "", "\\Aodqp1_[a-f0-9]{64}\\z");
    private static string FailureActivity(Exception error) => error switch {
        LoginRequiredException => "Sign-in is needed before files can connect. Use the Sign in button when you're ready; no browser was opened automatically.",
        OperationCanceledException => "Sign-in or file preparation was cancelled. Use the Sign in button to try again when you're ready.",
        AccessDeniedException => "This account is not allowed to use the selected file connection. Check the source and permissions; remove the previous connection before choosing another account.",
        ResourceUnavailableException => "The approved files are unavailable or have changed. Ask your LedgeTop contact to check the delivery or folder before reconnecting.",
        CatalogCaptureException { Limit: CatalogCaptureLimit.EntryCount } capture =>
            "This file list exceeds this version's limit of 1,000 files and folders. Ask your LedgeTop contact to review which folders are shared. Existing local files stay in their folders. Support code: " + capture.SupportCode,
        CatalogCaptureException { Limit: CatalogCaptureLimit.PathOrDepth } capture =>
            "A shared folder path or its nesting exceeds this version's limit. Ask your LedgeTop contact to review shared folder paths. Existing local files stay in their folders. Support code: " + capture.SupportCode,
        CatalogCaptureException { Limit: CatalogCaptureLimit.PageCount } capture =>
            "This file list requires more pages than this version supports. Ask your LedgeTop contact to review which folders are shared. Existing local files stay in their folders. Support code: " + capture.SupportCode,
        CatalogCaptureException { Limit: CatalogCaptureLimit.FileSize } capture =>
            "A file exceeds this version's 64 GiB file size limit. Ask your LedgeTop contact to review the shared files. Existing local files stay in their folders. Support code: " + capture.SupportCode,
        CatalogCaptureException capture => "File preparation stopped. Support code: " + capture.SupportCode +
            (capture.HttpStatus is { } status ? "; HTTP " + status.ToString(System.Globalization.CultureInfo.InvariantCulture) : "") +
            ". Ask your LedgeTop contact to check this source.",
        TransferException => "The file service or its metadata could not be verified. Check your connection, then ask your LedgeTop contact to check this source if it continues.",
        IOException => "The owned local Explorer connection needs ownership review. Try Remove for normal cleanup; if that is also blocked, keep the saved files and ask your LedgeTop contact to review the connection.",
        _ => "The Explorer action could not finish safely. Check the connection and ask your LedgeTop contact for help."
    };
    private static string Hash(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    private static string CanonicalOrigin(Uri value)
    {
        if (value is null || !value.IsAbsoluteUri || value.Scheme != "https" || value.UserInfo.Length != 0 || value.Query.Length != 0 || value.Fragment.Length != 0 || value.AbsolutePath != "/")
            throw new ArgumentException("A canonical trusted HTTPS source origin is required.");
        return value.GetLeftPart(UriPartial.Authority);
    }
    private static string LocalDirectoryPath(string path, bool rootLeaf = false)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || path.StartsWith("\\\\", StringComparison.Ordinal) || path.Contains('%'))
            throw new ArgumentException("A dedicated canonical local directory is required.");
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var drive = new DriveInfo(Path.GetPathRoot(full)!);
        if (drive.DriveType != DriveType.Fixed || !drive.DriveFormat.Equals("NTFS", StringComparison.OrdinalIgnoreCase) || full == Path.TrimEndingDirectorySeparator(drive.RootDirectory.FullName))
            throw new ArgumentException("Connected Explorer requires a dedicated local NTFS directory.");
        // The owned native root can itself be a cloud reparse point; only the engine's receipt can validate that leaf.
        Ancestors(rootLeaf ? Path.GetDirectoryName(full)! : full, true); return full;
    }
    private static void Ancestors(string path, bool allowMissing)
    {
        for (var part = Path.GetFullPath(path); part is not null; part = Path.GetDirectoryName(part)) {
            if (!Directory.Exists(part)) { if (allowMissing && !File.Exists(part)) continue; throw new IOException("An Explorer state directory is unavailable."); }
            if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new IOException("Explorer state aliases are unsupported.");
        }
    }
    private FreshActionObservation freshAction = FreshActionObservation.Unknown;
    private DateTimeOffset? freshActionAtUtc;
    private void SetFreshAction(FreshActionObservation action)
    {
        lock (view) { freshAction = action; freshActionAtUtc = DateTimeOffset.UtcNow; viewEpoch++; }
        TryPersistStatus(State); Notify();
    }
    private void SetState(ExplorerPreviewState value) { lock (view) { state = value; viewEpoch++; } TryPersistStatus(value); Notify(); }
    private void TryPersistStatus(ExplorerPreviewState value)
    {
        try {
            if (channel != "pilot" || alias != "employee" || indexLease is not { } held) return;
            var pin = new FreshGenerationIndexLockPin(held, Path.Combine(indexDirectory, "index.lock"));
            bool Owned() {
                if (!pin.StillHeld(indexLease)) return false;
                if (heldFreshSelector is { } expected)
                    return FreshGenerationStartup.Observe(indexPath, Path.Combine(indexDirectory, FreshGenerationIndexStore.LegacyBackup), sid, channel, alias, originHash) == expected;
                return !invalidIndex && index is { Removed: false } && ReadIndex() == index;
            }
            FreshActionObservation action; DateTimeOffset? actionAt; bool fresh;
            lock (view) { action = freshAction; actionAt = freshActionAtUtc; fresh = freshReadOnlyActive; }
            ConnectionStatusStore.TrySave(indexDirectory, Owned, value, fresh, DateTimeOffset.UtcNow, action, actionAt);
        } catch { /* The optional status is never authoritative for lifecycle. */ }
    }
    private void Add(string text) { activity.Add(text); Notify(); }
    private void Notify() { try { Changed?.Invoke(this, EventArgs.Empty); } catch { } }

    private sealed class CleanupSource(string alias, Uri origin) : IQueuedDownloadSource
    {
        public string Alias => alias;
        public Uri Origin => origin;
        public Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default) => throw new LoginRequiredException();
        public Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default) => throw new AccessDeniedException();
        public Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null, CancellationToken cancellationToken = default) => throw new AccessDeniedException();
    }

}
