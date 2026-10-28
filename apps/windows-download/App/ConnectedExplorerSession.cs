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
    Func<bool> HasOwnedProfileReceipt);
internal sealed record ConnectedExplorerUpdateBinding(string Channel, string SourceAlias, string PrincipalId);
internal interface ICachedExplorerReconnect
{
    bool CanReconnectCached { get; }
    Task ReconnectCachedAsync();
}

/// <summary>One trusted selected source. Only explicit Start invokes browser sign-in; construction/removal stay offline.</summary>
internal sealed class ConnectedExplorerSession : IExplorerPreviewSession, ICachedExplorerReconnect
{
    private const string Owner = "LedgeTop.Files.ConnectedExplorer.Index/1";
    private sealed record Index(int Schema, string Owner, string Sid, string Channel, string Alias,
        string OriginSha256, string PrincipalId, long Revision, bool Removed = false);
    private sealed record TransientRecheckRecovery(ConnectedExplorerEngine Engine, IFilesBackend Backend, Index Index, string InventoryDigest);
    private static readonly JsonSerializerOptions json = new() { WriteIndented = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private readonly Func<IFilesBackend> createBackend;
    private readonly Func<ConnectedExplorerEngineRequest, ConnectedExplorerEngine> createEngine;
    private readonly Func<IFilesBackend, string, string, CancellationToken, Task<ExplorerCatalogSnapshot>> capture;
    private readonly string channel, alias, origin, originHash, stateBase, preferredRoot, indexDirectory, indexPath, sid;
    private readonly SemaphoreSlim operations = new(1, 1);
    private readonly object view = new(), lifetime = new();
    private readonly List<string> activity = [];
    private CancellationTokenSource cancellation = new();
    private ConnectedExplorerEngine? engine;
    private IFilesBackend? backend;
    private Index? index;
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
        Func<IFilesBackend, string, string, CancellationToken, Task<ExplorerCatalogSnapshot>> capture)
    {
        ArgumentNullException.ThrowIfNull(backendFactory); ArgumentNullException.ThrowIfNull(engineFactory); ArgumentNullException.ThrowIfNull(capture);
        if (channel is not ("pilot" or "stable") || alias is null || !Regex.IsMatch(alias, "\\A[a-z0-9][a-z0-9_-]{0,63}\\z"))
            throw new ArgumentException("The connected file source is invalid.");
        origin = CanonicalOrigin(trustedOrigin); originHash = Hash(origin);
        this.channel = channel; this.alias = alias; createBackend = backendFactory; createEngine = engineFactory; this.capture = capture;
        stateBase = LocalDirectoryPath(stateBaseDirectory); this.preferredRoot = LocalDirectoryPath(preferredRoot, rootLeaf: true);
        indexDirectory = Path.Combine(stateBase, "connected-explorer-" + channel + "-" + alias);
        indexPath = Path.Combine(indexDirectory, "current.json");
        using var identity = WindowsIdentity.GetCurrent();
        sid = identity.User?.Value ?? throw new IOException("The current Windows identity is unavailable.");
        try {
            if (File.Exists(indexDirectory)) throw new IOException("The saved Explorer index is not a directory.");
            if (Directory.Exists(indexDirectory)) {
                index = ReadIndex();
                RestoreCleanupEngine();
                state = ValidatePreviousRemoval() ? ExplorerPreviewState.Removed : engine?.Session.State ?? ExplorerPreviewState.NotStarted;
            }
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException) {
            invalidIndex = true; state = ExplorerPreviewState.Failed;
            Add("The saved Explorer connection needs ownership review. No account, local files or Windows registrations were changed.");
        }
    }

    private static ConnectedExplorerEngine DefaultEngine(ConnectedExplorerEngineRequest request)
    {
        var owned = new OwnedExplorerRootSession(request.ProfileDirectory, request.PreferredRoot, request.Source, request.Scope, request.InitialManifest);
        return new(owned, () => owned.FrozenManifest, () => owned.HasOwnershipReceipt);
    }
    public string RootPath { get { lock (view) return engine?.Session.RootPath ?? preferredRoot; } }
    public ExplorerPreviewState State { get { lock (view) return state; } }
    // UI observation only. Full local ownership and fresh server identity are checked under
    // the operation lock before a recovery can resume this exact provider generation.
    internal bool CanRecoverTransientSession {
        get { lock (view) return RecoveryVisibleUnderView(); }
    }
    internal bool CanRecheckSession {
        get { lock (view) return !disposed && !closeRequested &&
            (state is ExplorerPreviewState.Running or ExplorerPreviewState.Paused || RecoveryVisibleUnderView()); }
    }
    private bool RecoveryVisibleUnderView() => !disposed && !closeRequested && !invalidIndex && state == ExplorerPreviewState.Failed &&
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
    public IReadOnlyList<string> Activity { get { lock (view) return activity.Concat(engine?.Session.Activity ?? []).TakeLast(100).ToArray(); } }
    public event EventHandler? Changed;

    public Task StartAsync() => StartCoreAsync(explicitLogin: true);
    public bool CanReconnectCached => ObserveSavedCapability(emptyInventory: false, disconnectedBackend: true);
    private bool ObserveSavedCapability(bool emptyInventory, bool disconnectedBackend)
    {
        ConnectedExplorerEngine owned; Index saved; long epoch;
        lock (view) {
            if (disposed || closeRequested || invalidIndex || (disconnectedBackend && backend is not null) || index is not { } currentIndex || engine is not { } currentEngine) return false;
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
            lock (view) return !disposed && !closeRequested && !invalidIndex && viewEpoch == epoch &&
                ReferenceEquals(engine, owned) && ReferenceEquals(index, saved) && (!disconnectedBackend || backend is null);
        } catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException or ObjectDisposedException) { return false; }
    }
    // Read only the ownership/readiness already established by this instance. A partial,
    // invalid or changed generation is never interpreted as an absent connection.
    internal SavedProfileState StartupProfileState => invalidIndex || closeRequested || disposed
        ? SavedProfileState.NeedsReview
        : index is null ? SavedProfileState.Absent
        : CanReconnectCached ? SavedProfileState.OwnedReady
        : State == ExplorerPreviewState.Removed ? SavedProfileState.Removed : SavedProfileState.NeedsReview;

    /// <summary>Reopens only an existing ready frozen generation using cached authorization. Never signs in or captures.</summary>
    internal Task ReconnectCachedAsync() => StartCoreAsync(explicitLogin: false);
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
                Add("A different account is signed in. Remove the previous Explorer connection before connecting this account. Local files are kept.");
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
                Add("Checking the current file list after your explicit sign-in. Local files will be kept.");
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
                    Add("The empty connection was refreshed. Its old folder and all local files were kept; Explorer will use a new owned folder.");
                } else Add("The current authorized file list is still empty. The existing connection and local files were kept.");
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

    private async Task<ExplorerRootManifest> CaptureInventoryAsync(IFilesBackend selectedBackend, ExplorerRootScope scope, string person, CancellationToken token, ConnectionFailureTrace trace)
    {
        trace.Phase = ConnectionPhase.InventoryPreparation;
        Add("Preparing the current file list. Large files can take longer.");
        var snapshot = await capture(selectedBackend, channel, person, token);
        token.ThrowIfCancellationRequested();
        if (snapshot.Channel != channel || snapshot.Alias != alias || snapshot.Origin != origin || snapshot.PrincipalId != person)
            throw new AccessDeniedException();
        var inventory = new ExplorerRootManifest(scope, snapshot.Files, snapshot.Directories);
        Add($"Prepared {snapshot.Files.Count} files for File Explorer.");
        return inventory;
    }

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
        _ = ValidatePreviousRemoval();
        // Never retain a signed-in backend for removal: the cleanup engine's source always denies network operations.
        await DrainCurrentAsync(trace); token.ThrowIfCancellationRequested();
        trace.Phase = ConnectionPhase.LocalOwnership;
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
        Add("The Explorer connection was removed. Downloaded and modified local files have been kept.");
    });

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
            var observedRunning = operation == ConnectionAction.Recheck && previousState == ExplorerPreviewState.Running &&
                previousEngine?.Session.State == ExplorerPreviewState.Running;
            lock (view) wasRunning = observedRunning && viewEpoch == observedEpoch && ReferenceEquals(engine, previousEngine);
            token.ThrowIfCancellationRequested();
            if (invalidIndex) throw new IOException("The saved Explorer index needs ownership review.");
            await action(token, trace).ConfigureAwait(false);
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
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
            Add(FailureActivity(error));
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
        if (previous is not null) previous.Session.Changed -= EngineChanged;
        if (next is not null) next.Session.Changed += EngineChanged;
        Notify();
    }
    private void EngineChanged(object? sender, EventArgs e)
    {
        ConnectedExplorerEngine? current; long observedEpoch;
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
            if (!starting && !closeRequested && state != ExplorerPreviewState.Failed && state != engineState) { state = engineState; changed = true; }
            if (changed) viewEpoch++;
        }
        Notify();
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
                await DrainCurrentAsync(trace).ConfigureAwait(false);
                trace.Phase = ConnectionPhase.LocalOwnership;
                indexLease?.Dispose(); indexLease = null;
                lock (lifetime) disposed = true;
                if (State != ExplorerPreviewState.Removed) SetState(ExplorerPreviewState.NotStarted);
                cancellation.Dispose(); done.TrySetResult();
            } catch (Exception error) {
                SetState(ExplorerPreviewState.Failed);
                Add("The Explorer connection could not confirm shutdown. Its saved ownership and local files were retained.");
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
        CatalogCaptureException capture => "File preparation stopped. Support code: " + capture.SupportCode +
            (capture.HttpStatus is { } status ? "; HTTP " + status.ToString(System.Globalization.CultureInfo.InvariantCulture) : "") +
            ". Ask your LedgeTop contact to check this source. Local files were kept.",
        TransferException => "The file service or its metadata could not be verified. Check your connection, then ask your LedgeTop contact to check this source if it continues.",
        IOException => "The owned local Explorer connection needs ownership review. Try Remove for normal cleanup; if that is also blocked, keep the saved files and ask your LedgeTop contact to review the connection.",
        _ => "The Explorer action could not finish safely. Check the connection and try again. Local files were kept and the saved connection remains available for cleanup."
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
    private void SetState(ExplorerPreviewState value) { lock (view) { state = value; viewEpoch++; } Notify(); }
    private void Add(string text) { lock (view) { activity.Add(text); if (activity.Count > 100) activity.RemoveAt(0); } Notify(); }
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
