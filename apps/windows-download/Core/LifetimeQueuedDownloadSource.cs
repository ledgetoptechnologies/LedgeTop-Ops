namespace LedgeTop.WindowsDownload;

/// <summary>Non-owning cancellation bridge for one selected source generation.
/// No authentication, source disposal or authority is added by wrapping a source.</summary>
public sealed class LifetimeQueuedDownloadSource : IQueuedDownloadSource, IVerifiedHydrationDownloadSource, IHydrationAuthoritySource, IHydrationMutationAwareSource
{
    bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => source is IHydrationMutationAwareSource { CoordinatesHydrationMutations: true };
    private readonly IQueuedDownloadSource source;
    private readonly CancellationToken generation;
    public LifetimeQueuedDownloadSource(IQueuedDownloadSource source, CancellationToken generation)
    { this.source = source ?? throw new ArgumentNullException(nameof(source)); this.generation = generation; }
    public string Alias => source.Alias;
    public Uri Origin => source.Origin;
    bool IHydrationAuthoritySource.ResolveCarriesCurrentAuthority => source is IHydrationAuthoritySource { ResolveCarriesCurrentAuthority: true };
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
    async Task<VerifiedHydrationDownload> IVerifiedHydrationDownloadSource.DownloadForHydrationAsync(DownloadSpec spec, string destination,
        CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, generation);
        linked.Token.ThrowIfCancellationRequested();
        VerifiedHydrationDownload result;
        if (source is IVerifiedHydrationDownloadSource verified)
            result = await verified.DownloadForHydrationAsync(spec, destination, linked.Token).ConfigureAwait(false);
        else {
            var path = await source.DownloadAsync(spec, destination, cancellationToken: linked.Token).ConfigureAwait(false);
            result = new VerifiedHydrationDownload(path,
                new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous), integrityVerified: false);
        }
        try { linked.Token.ThrowIfCancellationRequested(); return result; }
        catch { await result.DisposeAsync().ConfigureAwait(false); throw; }
    }
}
