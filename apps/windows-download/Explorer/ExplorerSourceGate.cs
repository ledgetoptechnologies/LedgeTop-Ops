using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Explorer;

/// <summary>Pause is cancellation/availability, never authentication. Live resume reads only the current cached source session.</summary>
internal sealed class ExplorerSourceGate : IQueuedDownloadSource, IVerifiedHydrationDownloadSource, IMemoryHydrationDownloadSource, IHydrationAuthoritySource, IHydrationMutationAwareSource, IDisposable
{
    private readonly IQueuedDownloadSource source;
    private readonly ExplorerRootScope scope;
    private readonly Action? prepareGenerated, pauseGenerated, disposeGenerated;
    private readonly object sync = new();
    private CancellationTokenSource epoch = new();
    private bool enabled, disposed;
    internal bool IsPaused { get { lock (sync) return !enabled && !disposed; } }
    public string Alias => scope.Alias;
    public Uri Origin => new(scope.Origin);
    bool IHydrationAuthoritySource.ResolveCarriesCurrentAuthority => source is IHydrationAuthoritySource { ResolveCarriesCurrentAuthority: true };
    bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => source is IHydrationMutationAwareSource { CoordinatesHydrationMutations: true };

    internal ExplorerSourceGate(IQueuedDownloadSource source, ExplorerRootScope scope,
        Action? prepareGenerated = null, Action? pauseGenerated = null, Action? disposeGenerated = null)
    {
        this.source = source; this.scope = scope; scope.Validate();
        this.prepareGenerated = prepareGenerated; this.pauseGenerated = pauseGenerated; this.disposeGenerated = disposeGenerated;
        Configuration();
    }
    private void Configuration()
    {
        if (source.Alias != scope.Alias || source.Origin.GetLeftPart(UriPartial.Authority) != scope.Origin)
            throw new AccessDeniedException(AccessDenialReason.SourceConfiguration);
    }
    internal async Task CheckCurrentAsync(CancellationToken cancellationToken = default)
    {
        Configuration();
        var current = await source.GetSessionAsync(cancellationToken).ConfigureAwait(false);
        Configuration(); Session(current);
    }
    private void Session(QueuedDownloadSession current)
    {
        if (current.PrincipalId != scope.PrincipalId) throw new AccessDeniedException(AccessDenialReason.PrincipalMismatch);
        if (current.ExpiresAt <= DateTimeOffset.UtcNow.AddSeconds(5)) throw new LoginRequiredException();
    }
    internal async Task ResumeAsync()
    {
        lock (sync) ObjectDisposedException.ThrowIf(disposed, this);
        prepareGenerated?.Invoke();
        await CheckCurrentAsync().ConfigureAwait(false);
        lock (sync) { ObjectDisposedException.ThrowIf(disposed, this); enabled = true; }
    }
    internal void Pause()
    {
        CancellationTokenSource previous;
        lock (sync) { enabled = false; previous = epoch; epoch = new(); }
        try { previous.Cancel(); } finally { previous.Dispose(); pauseGenerated?.Invoke(); }
    }
    private (CancellationTokenSource Linked, CancellationToken Epoch) Lease(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (sync) {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!enabled) throw new DownloadsPausedException();
            Configuration();
            return (CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, epoch.Token), epoch.Token);
        }
    }
    private void Current(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        lock (sync) { if (disposed || !enabled || token != epoch.Token) throw new DownloadsPausedException(); }
        Configuration();
    }
    public async Task<QueuedDownloadSession> GetSessionAsync(CancellationToken cancellationToken = default)
    {
        var lease = Lease(cancellationToken); using var linked = lease.Linked;
        var current = await source.GetSessionAsync(linked.Token).ConfigureAwait(false);
        Current(lease.Epoch); Session(current); return current;
    }
    public async Task<ResolvedQueuedDownload> ResolveAsync(string resourceReference, CancellationToken cancellationToken = default)
    {
        var lease = Lease(cancellationToken); using var linked = lease.Linked;
        var result = await source.ResolveAsync(resourceReference, linked.Token).ConfigureAwait(false);
        Current(lease.Epoch);
        if (result.PrincipalId != scope.PrincipalId) throw new AccessDeniedException(AccessDenialReason.PrincipalMismatch);
        return result;
    }
    public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var lease = Lease(cancellationToken); using var linked = lease.Linked;
        var result = await source.DownloadAsync(spec, destination, progress, linked.Token).ConfigureAwait(false);
        Current(lease.Epoch); return result;
    }
    bool IMemoryHydrationDownloadSource.SupportsMemoryHydration => source is IMemoryHydrationDownloadSource { SupportsMemoryHydration: true };
    async Task IMemoryHydrationDownloadSource.DownloadVerifiedIntoAsync(DownloadSpec spec, byte[] destination, CancellationToken cancellationToken)
    {
        if (source is not IMemoryHydrationDownloadSource { SupportsMemoryHydration: true } memory) throw new NotSupportedException();
        var lease = Lease(cancellationToken); using var linked = lease.Linked;
        await memory.DownloadVerifiedIntoAsync(spec, destination, linked.Token).ConfigureAwait(false);
        Current(lease.Epoch); // A paused or changed epoch refuses the result; the coordinator wipes the buffer.
    }
    public async Task<VerifiedHydrationDownload> DownloadForHydrationAsync(DownloadSpec spec, string destination,
        CancellationToken cancellationToken = default)
    {
        var lease = Lease(cancellationToken); using var linked = lease.Linked;
        VerifiedHydrationDownload? result = null;
        try {
            if (source is IVerifiedHydrationDownloadSource verified)
                result = await verified.DownloadForHydrationAsync(spec, destination, linked.Token).ConfigureAwait(false);
            else {
                var path = await source.DownloadAsync(spec, destination, cancellationToken: linked.Token).ConfigureAwait(false);
                result = new VerifiedHydrationDownload(path,
                    new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous), integrityVerified: false);
            }
            Current(lease.Epoch);
            var completed = result; result = null;
            return completed;
        } finally {
            if (result is not null) await result.DisposeAsync().ConfigureAwait(false);
        }
    }
    public void Dispose()
    {
        lock (sync) { if (disposed) return; disposed = true; }
        Pause();
        lock (sync) epoch.Dispose();
        disposeGenerated?.Invoke();
    }
}
