namespace LedgeTop.WindowsDownload;

/// <summary>Non-owning cancellation bridge for one selected source generation.
/// No authentication, source disposal or authority is added by wrapping a source.</summary>
public sealed class LifetimeQueuedDownloadSource : IQueuedDownloadSource, IVerifiedHydrationDownloadSource, IMemoryHydrationDownloadSource, IHydrationAuthoritySource, IHydrationMutationAwareSource
{
    bool IHydrationMutationAwareSource.CoordinatesHydrationMutations => source is IHydrationMutationAwareSource { CoordinatesHydrationMutations: true };
    private readonly IQueuedDownloadSource source;
    private readonly CancellationToken generation;
    public LifetimeQueuedDownloadSource(IQueuedDownloadSource source, CancellationToken generation)
    { this.source = source ?? throw new ArgumentNullException(nameof(source)); this.generation = generation; }
    public string Alias => source.Alias;
    public Uri Origin => source.Origin;
    // Internal, exact-type capability: arbitrary adapters cannot opt into this policy.
    internal bool TrustedEmployeeForAuthorizationRetry => source is EmployeeQueuedDownloadSource ||
        source is LifetimeQueuedDownloadSource { TrustedEmployeeForAuthorizationRetry: true };
    internal async Task DelayAuthorizationRetryAsync(TimeSpan delay, Func<TimeSpan, CancellationToken, Task> wait, CancellationToken token)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, generation);
        linked.Token.ThrowIfCancellationRequested();
        if (source is LifetimeQueuedDownloadSource inner) await inner.DelayAuthorizationRetryAsync(delay, wait, linked.Token).ConfigureAwait(false);
        else await wait(delay, linked.Token).ConfigureAwait(false);
        linked.Token.ThrowIfCancellationRequested();
    }
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
    bool IMemoryHydrationDownloadSource.SupportsMemoryHydration => source is IMemoryHydrationDownloadSource { SupportsMemoryHydration: true };
    async Task<byte[]> IMemoryHydrationDownloadSource.DownloadVerifiedToMemoryAsync(DownloadSpec spec, long maximumBytes, CancellationToken cancellationToken)
    {
        if (source is not IMemoryHydrationDownloadSource { SupportsMemoryHydration: true } memory) throw new NotSupportedException();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, generation);
        linked.Token.ThrowIfCancellationRequested();
        var bytes = await memory.DownloadVerifiedToMemoryAsync(spec, maximumBytes, linked.Token).ConfigureAwait(false);
        try { linked.Token.ThrowIfCancellationRequested(); return bytes; }
        catch { System.Security.Cryptography.CryptographicOperations.ZeroMemory(bytes); throw; }
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
