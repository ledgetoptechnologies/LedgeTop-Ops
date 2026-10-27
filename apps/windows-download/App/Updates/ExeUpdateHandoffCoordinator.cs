using System.Globalization;
using System.Net.Http.Headers;
using System.Text.RegularExpressions;
using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Updates;

/// <summary>
/// EXE parent orchestration, separate from the concrete Windows adapter/helper. Application entry,
/// startup UI, scheduling and activation remain unwired; adapters require independent acceptance.
/// </summary>
internal sealed class ExeUpdateHandoffCoordinator
{
    private readonly IExeUpdateHandoffPlatform platform;
    private readonly TimeSpan readyTimeout;
    private readonly SemaphoreSlim operations = new(1, 1);
    // Keep fences alive after a possibly irreversible parent-exit request. Never dispose them on retry.
    private IAsyncDisposable? retainedMaintenance;
    private IExeUpdateBoundary? retainedBoundary;
    private IExeUpdateHelperReservation? retainedHelper;
    private ExeUpdateHandoffResult? terminal;
    internal bool HoldsRecoveryFences => retainedMaintenance is not null || retainedBoundary is not null || retainedHelper is not null;

    internal ExeUpdateHandoffCoordinator(IExeUpdateHandoffPlatform platform, TimeSpan? readyTimeout = null)
    {
        this.platform = platform ?? throw new ArgumentNullException(nameof(platform));
        this.readyTimeout = readyTimeout ?? TimeSpan.FromSeconds(30);
        if (this.readyTimeout < TimeSpan.FromMilliseconds(1) || this.readyTimeout > TimeSpan.FromMinutes(2))
            throw new ArgumentOutOfRangeException(nameof(readyTimeout));
    }

    internal async Task<ExeUpdateHandoffResult> ApplyAsync(CancellationToken cancellationToken)
    {
        await operations.WaitAsync(cancellationToken).ConfigureAwait(false);
        try {
            if (terminal is not null) return terminal;
            cancellationToken.ThrowIfCancellationRequested();
            IAsyncDisposable? maintenance;
            try { maintenance = await platform.TryEnterMaintenanceAsync(cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch { return new(ExeUpdateHandoffStatus.Busy, false); }
            if (maintenance is null) return new(ExeUpdateHandoffStatus.Busy, false);
            IExeUpdateBoundary? boundary = null;
            IExeUpdateHelperReservation? helper = null;
            ExeUpdateHandoff? handoff = null;
            bool drainStarted = false, disconnected = false, retain = false;
            var status = ExeUpdateHandoffStatus.PreparationFailed;
            try {
                cancellationToken.ThrowIfCancellationRequested();
                var prepared = await platform.PrepareFreshAsync(cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                if (prepared.Status is WindowsAppReleaseStatus.NoRelease or WindowsAppReleaseStatus.Current) {
                    status = prepared.Candidate is null ? ExeUpdateHandoffStatus.NoUpdate : ExeUpdateHandoffStatus.PreparationFailed;
                    throw new HandoffRefusedException();
                }
                if (prepared.Status != WindowsAppReleaseStatus.Available || !Valid(prepared.Candidate))
                    throw new HandoffRefusedException();
                handoff = new(Guid.NewGuid(), prepared.Candidate!);
                await platform.StageHandoffAsync(handoff, cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                drainStarted = true;
                status = ExeUpdateHandoffStatus.DrainFailed;
                // Once draining begins, join it even on cancellation. Cancellation can never race native I/O.
                await platform.DrainAndDisconnectAsync().ConfigureAwait(false);
                disconnected = true;
                cancellationToken.ThrowIfCancellationRequested();
                status = ExeUpdateHandoffStatus.BoundaryRejected;
                boundary = await platform.VerifyBoundaryAsync(handoff.Candidate, cancellationToken).ConfigureAwait(false);
                if (boundary is null || boundary.Candidate != handoff.Candidate) throw new HandoffRefusedException();
                cancellationToken.ThrowIfCancellationRequested();
                status = ExeUpdateHandoffStatus.HelperUnavailable;
                helper = await platform.LaunchHelperAsync(handoff, boundary, cancellationToken).ConfigureAwait(false);
                if (helper is null) throw new HandoffRefusedException();
                cancellationToken.ThrowIfCancellationRequested();
                using (var ready = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken)) {
                    ready.CancelAfter(readyTimeout);
                    if (!await helper.WaitReadyAsync(handoff, ready.Token).WaitAsync(ready.Token).ConfigureAwait(false)) throw new HandoffRefusedException();
                }
                cancellationToken.ThrowIfCancellationRequested();
                // From this point cancellation cannot undo an exit request whose acceptance is unknown.
                ExeUpdateParentExitDecision decision;
                try { decision = await platform.RequestParentExitAsync(handoff).ConfigureAwait(false); }
                catch { decision = ExeUpdateParentExitDecision.Uncertain; }
                if (decision == ExeUpdateParentExitDecision.Rejected) status = ExeUpdateHandoffStatus.ExitRejected;
                else {
                    retain = true;
                    retainedMaintenance = maintenance; retainedBoundary = boundary; retainedHelper = helper;
                    return terminal = new(decision == ExeUpdateParentExitDecision.Accepted
                        ? ExeUpdateHandoffStatus.ParentExitRequested : ExeUpdateHandoffStatus.ExitUncertain, true);
                }
            }
            catch (OperationCanceledException) {
                status = cancellationToken.IsCancellationRequested ? ExeUpdateHandoffStatus.Postponed : status;
            }
            catch { /* Return the typed boundary failure only; never expose adapter exception text. */ }
            finally {
                if (!retain) {
                    // A helper that cannot prove disarm is not safe to race against reconnect or a new update.
                    var safe = true;
                    if (helper is not null) { try { await helper.DisarmAndWaitAsync().ConfigureAwait(false); } catch { safe = false; } }
                    if (safe && boundary is not null) { try { await boundary.DisposeAsync().ConfigureAwait(false); } catch { safe = false; } }
                    if (safe && handoff is not null) { try { await platform.RetireHandoffAsync(handoff).ConfigureAwait(false); } catch { safe = false; } }
                    if (safe && drainStarted) {
                        try { disconnected = !await platform.RecoverProviderAsync().ConfigureAwait(false); }
                        catch { disconnected = true; }
                        if (disconnected) status = ExeUpdateHandoffStatus.NeedsReconnect;
                    }
                    if (safe) {
                        try { await maintenance.DisposeAsync().ConfigureAwait(false); }
                        catch { safe = false; }
                    }
                    if (!safe) {
                        retainedMaintenance = maintenance; retainedBoundary = boundary; retainedHelper = helper;
                        terminal = new(ExeUpdateHandoffStatus.RecoveryBlocked, drainStarted);
                    }
                }
            }
            return terminal ?? new(status, disconnected);
        }
        finally { operations.Release(); }
    }

    private sealed class HandoffRefusedException : Exception;

    internal static bool Valid(ExeUpdateCandidate? item)
    {
        if (item is null || !ValidOwner(item.InstalledOwner) || item.InstalledOwner.Version != item.CurrentVersion ||
            item.Parent is null || item.Parent.ProcessId <= 0 ||
            item.Parent.StartTimeUtcTicks <= 0 || item.Parent.StartTimeUtcTicks > DateTime.MaxValue.Ticks ||
            item.Channel is not ("pilot" or "stable") || item.ApiBase is not ("/api/app" or "/api/client/app") ||
            item.Origin is null || !item.Origin.IsAbsoluteUri || item.Origin.Scheme != "https" || !item.Origin.IsDefaultPort ||
            item.Origin.AbsolutePath != "/" || item.Origin.UserInfo.Length != 0 || item.Origin.Query.Length != 0 || item.Origin.Fragment.Length != 0 ||
            item.InstallerPath is null || item.InstallerPath.Length is < 8 or > 1024 ||
            !Regex.IsMatch(item.InstallerPath, @"\A[A-Za-z]:[\\/][^\x00-\x1f]+\.exe\z") ||
            item.InstallerPath.Contains("..", StringComparison.Ordinal) || item.InstallerPath.Contains('"') ||
            item.InstallerPath.Contains('%') || item.InstallerPath.AsSpan(2).Contains(':') ||
            !VersionText(item.CurrentVersion, out var current)) return false;
        var release = item.Release;
        return release is not null && release.Channel == item.Channel && release.InstallerType == "exe" &&
            VersionText(release.Version, out var target) && target > current && release.SizeBytes is > 0 and <= (1L << 30) &&
            Regex.IsMatch(release.Sha256 ?? "", @"\A[0-9a-f]{64}\z") && Regex.IsMatch(release.SourceCommit ?? "", @"\A[0-9a-f]{40}\z") &&
            release.StrongETag is { Length: > 0 and <= 512 } etag && Regex.IsMatch(etag, "\\A\"[\\x21\\x23-\\x7e]+\"\\z") &&
            EntityTagHeaderValue.TryParse(etag, out var parsed) && !parsed.IsWeak && parsed.Tag != "*" && parsed.ToString() == etag;
    }

    private static bool ValidOwner(ExeUpdateInstalledOwner? owner) => owner is not null &&
        owner.WindowsSid is { Length: > 0 and <= 184 } && Regex.IsMatch(owner.WindowsSid, @"\AS-1-[0-9]+(-[0-9]+){1,15}\z") &&
        owner.SessionId >= 0 && owner.Owner == "LedgeTop.Files.UnsignedPilotInstaller/1" &&
        owner.InstallRoot is { Length: > 3 and <= 1024 } && Regex.IsMatch(owner.InstallRoot, @"\A[A-Za-z]:[\\/][^\x00-\x1f]+\z") &&
        !owner.InstallRoot.Contains("..", StringComparison.Ordinal) && !owner.InstallRoot.Contains('"') &&
        !owner.InstallRoot.Contains('%') && !owner.InstallRoot.AsSpan(2).Contains(':') &&
        Regex.IsMatch(owner.PayloadManifestSha256 ?? "", @"\A[0-9a-f]{64}\z") && Regex.IsMatch(owner.SourceCommit ?? "", @"\A[0-9a-f]{40}\z") &&
        Regex.IsMatch(owner.AppHostSha256 ?? "", @"\A[0-9a-f]{64}\z") && Regex.IsMatch(owner.ManagedAssemblySha256 ?? "", @"\A[0-9a-f]{64}\z");

    private static bool VersionText(string? text, out Version version)
    {
        version = new Version(0, 0, 0, 0);
        if (text is null || text.Length > 23 || !Regex.IsMatch(text, @"\A(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){3}\z")) return false;
        var parts = text.Split('.').Select(part => int.Parse(part, CultureInfo.InvariantCulture)).ToArray();
        if (parts.Any(part => part > ushort.MaxValue)) return false;
        version = new(parts[0], parts[1], parts[2], parts[3]); return true;
    }
}
