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
    internal bool InventoryEmpty { get { lock (view) {
        var inventory = engine?.ReadFrozenManifest();
        return inventory is not null && inventory.Files.Count == 0 && inventory.Directories.Count == 0;
    } } }
    public IReadOnlyList<string> Activity { get { lock (view) return activity.Concat(engine?.Session.Activity ?? []).TakeLast(100).ToArray(); } }
    public event EventHandler? Changed;

    public Task StartAsync() => StartCoreAsync(explicitLogin: true);
    public bool CanReconnectCached
    {
        get {
            if (disposed || closeRequested || invalidIndex || backend is not null || index is null || engine is null) return false;
            try { return !ValidatePreviousRemoval() && engine.Session.State == ExplorerPreviewState.NotStarted &&
                engine.ReadFrozenManifest() is { } frozen && frozen.Scope == Scope(index); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or ArgumentException) { return false; }
        }
    }
    /// <summary>Reopens only an existing ready frozen generation using cached authorization. Never signs in or captures.</summary>
    internal Task ReconnectCachedAsync() => StartCoreAsync(explicitLogin: false);
    Task ICachedExplorerReconnect.ReconnectCachedAsync() => ReconnectCachedAsync();
    private Task StartCoreAsync(bool explicitLogin) => OperateAsync(async token => {
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
            await DrainCurrentAsync(); token.ThrowIfCancellationRequested();
            AcquireExistingIndexLease();
            token.ThrowIfCancellationRequested();
            backend = createBackend();
            var selected = SelectedSource(backend);
            if (explicitLogin) await backend.Session.SignInAsync(token); // Only this explicit user-button path may launch a browser.
            token.ThrowIfCancellationRequested();
            var person = await CurrentPersonAsync(backend, selected, token, explicitLogin ? null : index!.PrincipalId);
            if (index is { } previous && previous.PrincipalId != person && !previousRemoved) {
                Add("A different account is signed in. Remove the previous Explorer connection before connecting this account. Local files are kept.");
                throw new AccessDeniedException();
            }
            var scope = new ExplorerRootScope(channel, alias, origin, person);
            // The root engine also makes cached source requests with optional/default caller tokens.
            // Bind all of those requests and later hydrations to this coordinator generation's lifetime.
            var lifetimeSource = new LifetimeSource(selected, token);
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
            if (inventory is null) {
                if (candidate.Session.State is not (ExplorerPreviewState.NotStarted or ExplorerPreviewState.Removed))
                    throw new IOException("The saved Explorer inventory is unavailable.");
                await DisposeEngineAsync(); token.ThrowIfCancellationRequested();
                var snapshot = await capture(backend, channel, person, token);
                token.ThrowIfCancellationRequested();
                if (snapshot.Channel != channel || snapshot.Alias != alias || snapshot.Origin != origin || snapshot.PrincipalId != person)
                    throw new AccessDeniedException();
                inventory = new ExplorerRootManifest(scope, snapshot.Files, snapshot.Directories);
                SetEngine(Create(scope, lifetimeSource, inventory));
            }
            if (inventory.Scope != scope) throw new AccessDeniedException();
            _ = await CurrentPersonAsync(backend, selected, token, person);
            token.ThrowIfCancellationRequested();
            if (explicitLogin) SaveIndex(person); // Retain the cleanup identity even if subsequent native setup stops partway through.
            else token.ThrowIfCancellationRequested(); // Ready reconnect has durable ownership already; never republishes its index.
            // Engine writes Prepared ownership before its lifetime-bound cached preflight observes cancellation.
            await engine!.Session.StartAsync();
            token.ThrowIfCancellationRequested();
            SetState(engine.Session.State);
            Add(InventoryEmpty
                ? "Your account is connected, but no folders or files are currently shared with it in this source."
                : "Your selected files are connected in Explorer. This connection does not enable uploads.");
        } finally { starting = false; }
    });

    public Task PauseAsync() => OperateAsync(async token => {
        token.ThrowIfCancellationRequested();
        if (engine is null || backend is null) throw new LoginRequiredException();
        await engine.Session.PauseAsync(); token.ThrowIfCancellationRequested(); SetState(engine.Session.State);
    });
    public Task ResumeAsync() => OperateAsync(async token => {
        if (engine is null || backend is null || index is null) throw new LoginRequiredException();
        await CurrentPersonAsync(backend, SelectedSource(backend), token, index.PrincipalId);
        await engine.Session.ResumeAsync(); token.ThrowIfCancellationRequested(); SetState(engine.Session.State);
    });
    internal Task RecheckSessionAsync() => OperateAsync(async token => {
        if (backend is null || index is null || engine is null) return;
        try { await CurrentPersonAsync(backend, SelectedSource(backend), token, index.PrincipalId); }
        catch { Add("Your sign-in or file access changed. New downloads have stopped; reconnect the same account or remove this connection before choosing another."); throw; }
    });
    // This identity comes from the current selected server session, never saved UI text or a caller argument.
    // The updater must independently recheck the same principal under its own cached-session pin.
    internal async Task<ConnectedExplorerUpdateBinding> GetUpdateBindingAsync()
    {
        ConnectedExplorerUpdateBinding? result = null;
        await OperateAsync(async token => {
            if (channel != "pilot" || alias is not ("portal" or "employee") || backend is null || index is null || engine is null ||
                State is not (ExplorerPreviewState.Running or ExplorerPreviewState.Paused) || ValidatePreviousRemoval() ||
                engine.ReadFrozenManifest()?.Scope != Scope(index))
                throw new LoginRequiredException();
            var selected = backend;
            var source = SelectedSource(selected);
            using var pin = selected is LiveBackend live ? await live.PinCatalogSessionAsync(token).ConfigureAwait(false) : null;
            var principal = await CurrentPersonAsync(selected, source, token, index.PrincipalId).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            result = new(channel, alias, principal);
        }).ConfigureAwait(false);
        return result ?? throw new AccessDeniedException();
    }
    public Task RemoveAsync() => OperateAsync(async token => {
        token.ThrowIfCancellationRequested();
        _ = ValidatePreviousRemoval();
        // Never retain a signed-in backend for removal: the cleanup engine's source always denies network operations.
        await DrainCurrentAsync(); token.ThrowIfCancellationRequested();
        if (index is null) { SetState(ExplorerPreviewState.Removed); return; }
        AcquireExistingIndexLease(); RestoreCleanupEngine();
        _ = ValidatePreviousRemoval();
        await engine!.Session.RemoveAsync(); token.ThrowIfCancellationRequested();
        if (engine.Session.State != ExplorerPreviewState.Removed)
            throw new IOException("The saved Explorer connection did not confirm removal.");
        // A preflight failure may leave no engine profile to persist its Removed phase.
        // Publish this confirmation only after exact owned cleanup, so it survives restart.
        SaveIndex(index.PrincipalId, removed: true);
        SetState(ExplorerPreviewState.Removed);
        Add("The Explorer connection was removed. Downloaded and modified local files have been kept.");
    });

    private async Task OperateAsync(Func<CancellationToken, Task> action)
    {
        CancellationToken token;
        lock (lifetime) { ObjectDisposedException.ThrowIf(disposed || closeRequested, this); token = cancellation.Token; }
        await operations.WaitAsync(token).ConfigureAwait(false);
        try {
            token.ThrowIfCancellationRequested();
            if (invalidIndex) throw new IOException("The saved Explorer index needs ownership review.");
            await action(token).ConfigureAwait(false);
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception error) {
            if (engine?.Session.State == ExplorerPreviewState.Running) {
                try { await engine.Session.PauseAsync().ConfigureAwait(false); }
                catch { Add("The file provider could not confirm its pause; keep this app open for ownership review."); }
            }
            if (engine is null && index is not null) {
                try { RestoreCleanupEngine(); } catch { /* retain the index for exact ownership review */ }
            }
            SetState(ExplorerPreviewState.Failed);
            Add(FailureActivity(error));
            throw;
        } finally { operations.Release(); }
    }

    private IQueuedDownloadSource SelectedSource(IFilesBackend selected)
    {
        if (selected is null || selected.Sources.Count != 1 || selected.Session is null || selected.Catalog is null)
            throw new AccessDeniedException();
        var source = selected.Sources[0];
        if (source is null || source.Alias != alias || CanonicalOrigin(source.Origin) != origin) throw new AccessDeniedException();
        return source;
    }
    private async Task<string> CurrentPersonAsync(IFilesBackend selected, IQueuedDownloadSource source, CancellationToken token, string? expected = null)
    {
        if (!ReferenceEquals(source, SelectedSource(selected))) throw new AccessDeniedException();
        var current = await selected.Session.TryCurrentAsync(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (current is null) throw new LoginRequiredException();
        var actual = await source.GetSessionAsync(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (!ReferenceEquals(source, SelectedSource(selected)) || current.PrincipalId != actual.PrincipalId ||
            expected is not null && actual.PrincipalId != expected || !Principal(actual.PrincipalId)) throw new AccessDeniedException();
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
    private bool ValidatePreviousRemoval()
    {
        if (index is not null && !index.Removed && (engine is null || !engine.HasOwnedProfileReceipt()))
            throw new IOException("The saved Explorer index has no validated ownership receipt. Its Windows outcome needs ownership review.");
        if (index?.Removed == true && engine is not null &&
            engine.Session.State != ExplorerPreviewState.Removed &&
            (engine.Session.State != ExplorerPreviewState.NotStarted || engine.ReadFrozenManifest() is not null))
            throw new IOException("The saved removal confirmation contradicts the owned Explorer profile.");
        // An engine's durable Removed phase also covers a crash before the index update.
        return index?.Removed == true || engine?.Session.State == ExplorerPreviewState.Removed;
    }
    private void SetEngine(ConnectedExplorerEngine? next)
    {
        ConnectedExplorerEngine? previous;
        lock (view) { previous = engine; engine = next; }
        if (previous is not null) previous.Session.Changed -= EngineChanged;
        if (next is not null) next.Session.Changed += EngineChanged;
        Notify();
    }
    private void EngineChanged(object? sender, EventArgs e)
    {
        var current = engine;
        if (current is null || !ReferenceEquals(sender, current.Session)) return;
        if (!starting && !closeRequested) SetState(current.Session.State);
        else Notify();
    }
    private async Task DisposeEngineAsync()
    {
        var owned = engine;
        if (owned is null) return;
        await Task.Run(async () => await owned.Session.DisposeAsync().ConfigureAwait(false)).ConfigureAwait(false);
        SetEngine(null);
    }
    private async Task DrainCurrentAsync()
    {
        await DisposeEngineAsync().ConfigureAwait(false);
        if (backend is { } previous) {
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
        // Cancellation is visible before awaiting the operation lock, including an in-flight browser helper/catalog request.
        try { cancellation.Cancel(); } catch { Add("Cancellation reported a problem; the connection is still waiting for shutdown confirmation."); }
        _ = Task.Run(async () => {
            await operations.WaitAsync().ConfigureAwait(false);
            try {
                await DrainCurrentAsync().ConfigureAwait(false);
                indexLease?.Dispose(); indexLease = null;
                lock (lifetime) disposed = true;
                if (State != ExplorerPreviewState.Removed) SetState(ExplorerPreviewState.NotStarted);
                cancellation.Dispose(); done.TrySetResult();
            } catch (Exception error) {
                SetState(ExplorerPreviewState.Failed);
                Add("The Explorer connection could not confirm shutdown. Its saved ownership and local files were retained.");
                lock (lifetime) { closeRequested = false; closing = null; cancellation.Dispose(); cancellation = new(); }
                done.TrySetException(error);
            } finally { operations.Release(); }
        });
        return new(done.Task);
    }

    private static bool Principal(string? value) => Regex.IsMatch(value ?? "", "\\Aodqp1_[a-f0-9]{64}\\z");
    private static string FailureActivity(Exception error) => error switch {
        LoginRequiredException => "Sign-in is needed before files can connect. Use the Sign in button when you're ready; no browser was opened automatically.",
        OperationCanceledException => "Sign-in or file preparation was cancelled. Use the Sign in button to try again when you're ready.",
        AccessDeniedException => "This account is not allowed to use the selected file connection. Check the source and permissions; remove the previous connection before choosing another account.",
        ResourceUnavailableException => "The approved files are unavailable or have changed. Ask your LedgeTop contact to check the delivery or folder before reconnecting.",
        TransferException => "The file service or its metadata could not be verified. No redirects were followed. Check your connection, then ask your LedgeTop contact to check this source if it continues.",
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
    private void SetState(ExplorerPreviewState value) { lock (view) state = value; Notify(); }
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

    /// <summary>Non-owning cancellation bridge. Never authenticates or disposes the selected backend/source.</summary>
    private sealed class LifetimeSource(IQueuedDownloadSource source, CancellationToken generation) : IQueuedDownloadSource
    {
        public string Alias => source.Alias;
        public Uri Origin => source.Origin;
        public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, generation);
            linked.Token.ThrowIfCancellationRequested();
            var result = await source.GetSessionAsync(linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested(); return result;
        }
        public async Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, generation);
            linked.Token.ThrowIfCancellationRequested();
            var result = await source.ResolveAsync(resourceReference, linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested(); return result;
        }
        public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null,
            CancellationToken cancellationToken = default)
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, generation);
            linked.Token.ThrowIfCancellationRequested();
            var result = await source.DownloadAsync(spec, destination, progress, linked.Token).ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested(); return result;
        }
    }
}
