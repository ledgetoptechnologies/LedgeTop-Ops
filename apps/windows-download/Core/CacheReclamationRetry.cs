namespace LedgeTop.WindowsDownload;

// Only Windows sharing/lock violations are retried. Unknown, modified and
// inaccessible data remain untouched; diagnostics contain no paths or messages.
internal enum CacheReclamationFailureKind { Busy, AccessDenied, Unverified, Other }
internal sealed class CacheReclamationException(CacheReclamationFailureKind kind) : IOException("Cache reclamation was not confirmed.")
{
    internal CacheReclamationFailureKind Kind { get; } = kind;
}
internal sealed class CacheLeaseContentionTimeoutException() : IOException("Cache lease contention timed out.");
internal static class CacheReclamationRetry
{
    internal static CacheReclamationFailureKind Classify(Exception error) => error switch {
        CacheLeaseContentionTimeoutException => CacheReclamationFailureKind.Busy,
        IOException io when unchecked((uint)io.HResult) is 0x80070020 or 0x80070021 => CacheReclamationFailureKind.Busy,
        IOException io when unchecked((uint)io.HResult) == 0x80070005 => CacheReclamationFailureKind.AccessDenied,
        UnauthorizedAccessException => CacheReclamationFailureKind.AccessDenied,
        TransferException => CacheReclamationFailureKind.Unverified,
        _ => CacheReclamationFailureKind.Other
    };
    internal static async Task RunAsync(Func<CancellationToken, Task> work, CancellationToken token, Func<CancellationToken, Task>? delay = null)
    {
        delay ??= ct => Task.Delay(TimeSpan.FromMilliseconds(250), ct);
        for (var attempt = 0; ; attempt++) {
            token.ThrowIfCancellationRequested();
            try { await work(token).ConfigureAwait(false); return; }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
            catch (Exception error) {
                token.ThrowIfCancellationRequested();
                var kind = Classify(error);
                if (error is not IOException io || unchecked((uint)io.HResult) is not (0x80070020 or 0x80070021) || attempt >= 2)
                    throw new CacheReclamationException(kind);
                await delay(token).ConfigureAwait(false);
            }
        }
    }
}
