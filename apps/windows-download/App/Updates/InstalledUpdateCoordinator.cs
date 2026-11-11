namespace LedgeTop.Files.Updates;

internal enum InstalledUpdateApplyStatus
{
    NoUpdate, Unavailable, StageFailed, DrainFailed, RestartPostponed, RestartAccepted
}

/// <summary>
/// Orders deployment before provider shutdown and shutdown before restart. The drain callback must
/// disconnect and save the owned provider, never remove its registration or local files. A restart
/// acceptance is only a handoff; the next process must independently observe its installed version.
/// This coordinator is not enabled until an approved installed profile and restart adapter exist.
/// </summary>
internal sealed class InstalledUpdateCoordinator(IInstalledUpdatePlatform platform,
    Func<Task> drainProvider, Func<CancellationToken, Task<bool>> requestRestart)
{
    private readonly SemaphoreSlim operations = new(1, 1);
    private bool staged, restartAccepted;

    internal async Task<InstalledUpdateCheck> CheckAsync(CancellationToken cancellationToken)
    {
        await operations.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { return await platform.CheckAsync(cancellationToken).ConfigureAwait(false); }
        finally { operations.Release(); }
    }

    internal async Task<InstalledUpdateApplyStatus> ApplyAsync(CancellationToken cancellationToken)
    {
        await operations.WaitAsync(cancellationToken).ConfigureAwait(false);
        try {
            if (restartAccepted) return InstalledUpdateApplyStatus.RestartAccepted;
            cancellationToken.ThrowIfCancellationRequested();
            if (!staged) {
                var check = await platform.CheckAsync(cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (check.Status == InstalledUpdateStatus.Current) return InstalledUpdateApplyStatus.NoUpdate;
                if (check.Status is not (InstalledUpdateStatus.Available or InstalledUpdateStatus.Required))
                    return InstalledUpdateApplyStatus.Unavailable;
                try { await platform.StageDeferredAsync(cancellationToken).ConfigureAwait(false); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Exception) { return InstalledUpdateApplyStatus.StageFailed; }
                staged = true;
            }
            // Before drain, cancellation leaves the current provider running. After drain starts,
            // observe its complete shutdown even when cancellation arrives; never race native I/O.
            cancellationToken.ThrowIfCancellationRequested();
            try { await drainProvider().ConfigureAwait(false); }
            catch (Exception) { return InstalledUpdateApplyStatus.DrainFailed; }
            if (cancellationToken.IsCancellationRequested) return InstalledUpdateApplyStatus.RestartPostponed;
            try {
                restartAccepted = await requestRestart(cancellationToken).ConfigureAwait(false);
                return restartAccepted ? InstalledUpdateApplyStatus.RestartAccepted : InstalledUpdateApplyStatus.RestartPostponed;
            }
            catch (Exception) { return InstalledUpdateApplyStatus.RestartPostponed; }
        }
        finally { operations.Release(); }
    }
}
