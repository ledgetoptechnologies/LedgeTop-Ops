namespace LedgeTop.Files.Updates;

internal enum ExeUpdateHelperStatus
{
    Refused, Disarmed, ParentDidNotExit, AuthorityChanged, InstallFailed, InstallUncertain,
    InstalledVerificationFailed, RelaunchFailed, NewProcessStarted
}
internal enum ExeUpdateInstallResult { Failed, Uncertain, Succeeded }

internal interface IExeUpdateHelperPlatform : IAsyncDisposable
{
    // Must verify authenticated OS peer/image/start identity, current installed ownership, updater
    // gate transfer, exact artifact and selected cached-session account/fresh offer before READY.
    Task<bool> AcceptParentAsync(ExeUpdateHelperOffer offer, CancellationToken token);
    // Wait retained real parent HANDLE, not a later process with the same PID; true ONLY for known
    // termination with exit code0. Nonzero/crash/unknown/timeout refuses. Never kill the parent.
    Task<bool> WaitForParentExitAsync(ExeUpdateParentIdentity parent, CancellationToken token);
    // Recheck same principal/session, fresh exact offer and held immutable installer after real exit.
    Task<bool> ReverifyAfterExitAsync(ExeUpdateHelperOffer offer, CancellationToken token);
    // Exactly one invocation. Do not cancel/kill a running installer or retry an uncertain outcome.
    Task<ExeUpdateInstallResult> InstallOnceAsync(ExeUpdateHelperOffer offer);
    Task<bool> VerifyInstalledAsync(ExeUpdateHelperOffer offer, CancellationToken token);
    // Fixed new verified installed EXE only; true means started, NEVER sync connected/healthy.
    Task<bool> RelaunchVerifiedAsync(ExeUpdateHelperOffer offer, CancellationToken token);
}

internal static class ExeUpdateExitPolicy
{
    internal static bool KnownCleanExit(bool handleTerminated, int? exitCode) => handleTerminated && exitCode == 0;
}

/// <summary>One helper connection/attempt. No installation before authenticated explicit commit
/// and confirmed parent-handle exit. Concrete Windows implementation and App hook are separate.</summary>
internal sealed class ExeUpdateHelper(IExeUpdateHelperPlatform platform, IExeUpdateIpc ipc,
    TimeSpan? protocolTimeout = null, TimeSpan? parentExitTimeout = null)
{
    private readonly SemaphoreSlim run = new(1, 1);
    private bool attempted;

    internal async Task<ExeUpdateHelperStatus> RunAsync(CancellationToken token)
    {
        await run.WaitAsync(token).ConfigureAwait(false);
        try {
            if (attempted) return ExeUpdateHelperStatus.Refused;
            attempted = true;
            try {
                var handshake = protocolTimeout ?? TimeSpan.FromSeconds(30);
                var exitTimeout = parentExitTimeout ?? TimeSpan.FromMinutes(2);
                if (!Bounded(handshake) || !Bounded(exitTimeout)) return ExeUpdateHelperStatus.Refused;
                ExeUpdateHelperOffer offer;
                using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token)) {
                    deadline.CancelAfter(handshake);
                    var first = await ipc.ReadAsync(deadline.Token).ConfigureAwait(false);
                    if (!ExeUpdateIpc.Valid(first) || first.Kind != ExeUpdateIpcKind.Prepare) return ExeUpdateHelperStatus.Refused;
                    offer = first.Offer!;
                    if (!await platform.AcceptParentAsync(offer, deadline.Token).ConfigureAwait(false)) return ExeUpdateHelperStatus.Refused;
                    deadline.Token.ThrowIfCancellationRequested();
                    await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Ready, first.HandoffId), deadline.Token).ConfigureAwait(false);
                    var commit = await ipc.ReadAsync(deadline.Token).ConfigureAwait(false);
                    if (!ExeUpdateIpc.Valid(commit) || commit.HandoffId != first.HandoffId) return ExeUpdateHelperStatus.Refused;
                    if (commit.Kind == ExeUpdateIpcKind.Disarm) {
                        await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Stopped, first.HandoffId), deadline.Token).ConfigureAwait(false);
                        return ExeUpdateHelperStatus.Disarmed;
                    }
                    if (commit.Kind != ExeUpdateIpcKind.CommitExit) return ExeUpdateHelperStatus.Refused;
                    await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Armed, first.HandoffId), deadline.Token).ConfigureAwait(false);
                }
                // Armed is not final exit intent. A parent crash/pipe loss here cannot authorize install.
                using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token)) {
                    deadline.CancelAfter(handshake);
                    var intent = await ipc.ReadAsync(deadline.Token).ConfigureAwait(false);
                    if (!ExeUpdateIpc.Valid(intent) || intent.HandoffId != offer.Handoff.Id) return ExeUpdateHelperStatus.Refused;
                    if (intent.Kind == ExeUpdateIpcKind.Disarm) {
                        await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Stopped, offer.Handoff.Id), deadline.Token).ConfigureAwait(false);
                        return ExeUpdateHelperStatus.Disarmed;
                    }
                    if (intent.Kind != ExeUpdateIpcKind.ExitNow) return ExeUpdateHelperStatus.Refused;
                    await ipc.WriteAsync(new(1, ExeUpdateIpcKind.ExitCommitted, offer.Handoff.Id), deadline.Token).ConfigureAwait(false);
                }
                var exited = await WaitExitOrDisarmAsync(offer, exitTimeout, token).ConfigureAwait(false);
                if (exited is not null) return exited.Value;
                token.ThrowIfCancellationRequested();
                if (!await platform.ReverifyAfterExitAsync(offer, token).ConfigureAwait(false)) return ExeUpdateHelperStatus.AuthorityChanged;
                token.ThrowIfCancellationRequested();
                ExeUpdateInstallResult installed;
                try { installed = await platform.InstallOnceAsync(offer).ConfigureAwait(false); }
                catch { return ExeUpdateHelperStatus.InstallUncertain; }
                if (installed != ExeUpdateInstallResult.Succeeded) return installed == ExeUpdateInstallResult.Uncertain
                    ? ExeUpdateHelperStatus.InstallUncertain : ExeUpdateHelperStatus.InstallFailed;
                try {
                    if (!await platform.VerifyInstalledAsync(offer, token).ConfigureAwait(false)) return ExeUpdateHelperStatus.InstalledVerificationFailed;
                } catch { return ExeUpdateHelperStatus.InstalledVerificationFailed; }
                try {
                    return await platform.RelaunchVerifiedAsync(offer, token).ConfigureAwait(false)
                        ? ExeUpdateHelperStatus.NewProcessStarted : ExeUpdateHelperStatus.RelaunchFailed;
                } catch { return ExeUpdateHelperStatus.RelaunchFailed; }
            }
            catch { return ExeUpdateHelperStatus.Refused; } // No private frame/account/adapter error enters logs.
            finally { try { await platform.DisposeAsync().ConfigureAwait(false); } catch { /* preserve unknown owned state; no retry */ } }
        }
        finally { run.Release(); }
    }

    private static bool Bounded(TimeSpan timeout) => timeout >= TimeSpan.FromMilliseconds(1) && timeout <= TimeSpan.FromMinutes(2);

    private async Task<ExeUpdateHelperStatus?> WaitExitOrDisarmAsync(ExeUpdateHelperOffer offer, TimeSpan timeout, CancellationToken token)
    {
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(token);
        using var control = CancellationTokenSource.CreateLinkedTokenSource(token);
        wait.CancelAfter(timeout);
        var parent = platform.WaitForParentExitAsync(offer.Handoff.Candidate.Parent, wait.Token);
        var next = ipc.ReadAsync(control.Token);
        try {
            await Task.WhenAny(parent, next).ConfigureAwait(false);
            // A completed Disarm wins even if termination completed concurrently. No installer was started.
            if (next.IsCompletedSuccessfully) {
                if (!ExeUpdateIpc.Valid(next.Result) || next.Result.HandoffId != offer.Handoff.Id || next.Result.Kind != ExeUpdateIpcKind.Disarm)
                    return ExeUpdateHelperStatus.Refused;
                wait.Cancel();
                try { await parent.ConfigureAwait(false); } catch (OperationCanceledException) { }
                await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Stopped, offer.Handoff.Id), token).ConfigureAwait(false);
                return ExeUpdateHelperStatus.Disarmed;
            }
            // Pipe EOF after final exit intent is normal only once the retained real parent handle exits.
            try { if (!await parent.ConfigureAwait(false)) return ExeUpdateHelperStatus.ParentDidNotExit; }
            catch (OperationCanceledException) { return ExeUpdateHelperStatus.ParentDidNotExit; }
            try {
                // Require actual clean channel closure, not a cancelled partial read. The terminated
                // parent closes its pipe handles; if that cannot be observed promptly, refuse install.
                var late = await next.WaitAsync(TimeSpan.FromSeconds(2), token).ConfigureAwait(false);
                if (!ExeUpdateIpc.Valid(late) || late.HandoffId != offer.Handoff.Id || late.Kind != ExeUpdateIpcKind.Disarm)
                    return ExeUpdateHelperStatus.Refused;
                await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Stopped, offer.Handoff.Id), token).ConfigureAwait(false);
                return ExeUpdateHelperStatus.Disarmed;
            } catch (ExeUpdatePeerClosedException) { }
            return null;
        }
        finally {
            wait.Cancel(); control.Cancel();
            try { await parent.ConfigureAwait(false); } catch { }
            try { await next.ConfigureAwait(false); } catch { }
        }
    }
}
