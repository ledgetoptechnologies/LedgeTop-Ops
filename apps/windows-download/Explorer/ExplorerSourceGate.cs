using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Explorer;

/// <summary>Pause is cancellation/availability, never authentication. Live resume reads only the current cached source session.</summary>
internal sealed class ExplorerSourceGate : IQueuedDownloadSource, IDisposable
{
    private readonly IQueuedDownloadSource source;
    private readonly ExplorerRootScope scope;
    private readonly Action? prepareGenerated, pauseGenerated, disposeGenerated;
    private readonly object sync = new();
    private CancellationTokenSource epoch = new();
    private bool enabled, disposed;
    public string Alias => scope.Alias;
    public Uri Origin => new(scope.Origin);

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
            throw new AccessDeniedException();
    }
    internal async Task CheckCurrentAsync(CancellationToken cancellationToken = default)
    {
        Configuration();
        var current = await source.GetSessionAsync(cancellationToken).ConfigureAwait(false);
        Configuration(); Session(current);
    }
    private void Session(QueuedDownloadSession current)
    {
        if (current.PrincipalId != scope.PrincipalId) throw new AccessDeniedException();
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
        if (result.PrincipalId != scope.PrincipalId) throw new AccessDeniedException();
        return result;
    }
    public async Task<string> DownloadAsync(DownloadSpec spec, string destination, IProgress<DownloadProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var lease = Lease(cancellationToken); using var linked = lease.Linked;
        var result = await source.DownloadAsync(spec, destination, progress, linked.Token).ConfigureAwait(false);
        Current(lease.Epoch); return result;
    }
    public void Dispose()
    {
        lock (sync) { if (disposed) return; disposed = true; }
        Pause();
        lock (sync) epoch.Dispose();
        disposeGenerated?.Invoke();
    }
}
