using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;
using LedgeTop.Files.Backends;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Updates;

[SupportedOSPlatform("windows")]
internal static class ExeUpdateWindowsHelperEntry
{
    internal const string Argument = "--exe-update-helper-v1";
    internal static bool Requested(IReadOnlyList<string> args) => args.Any(value => value.StartsWith("--exe-update-helper", StringComparison.OrdinalIgnoreCase));

    // App calls this before normal SingleInstance/UI startup. It does not create/register a
    // provider, acquire SingleInstance or pre-create the installer's mutex.
    internal static async Task<int> RunAsync(IReadOnlyList<string> args, CancellationToken token)
    {
        VerifiedInstalledPayload? payload = null; Process? parent = null;
        try {
            if (args.Count != 5 || args[0] != Argument || !Regex.IsMatch(args[1], @"\ALedgeTop\.Files\.Update\.[a-f0-9]{32}\z") ||
                !int.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out var pid) || pid <= 0 || args[2] != pid.ToString(CultureInfo.InvariantCulture) ||
                !long.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) || ticks <= 0 || args[3] != ticks.ToString(CultureInfo.InvariantCulture) ||
                !Guid.TryParseExact(args[4], "N", out var id) || id == Guid.Empty) return 20;
            var profile = ExeUpdateWindowsTrust.Profile();
            var observed = await ExeUpdateWindowsTrust.ReadCurrentAsync(profile, token).ConfigureAwait(false); payload = observed.Payload;
            parent = ExeUpdateWindowsNative.OpenBoundProcess(new(pid, ticks), observed.Owner);
            using var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token)) {
                deadline.CancelAfter(TimeSpan.FromSeconds(30)); await pipe.ConnectAsync(deadline.Token).ConfigureAwait(false);
            }
            if (ExeUpdateWindowsNative.PipePeer(pipe, false) != pid) return 20;
            ExeUpdateWindowsNative.VerifyProcess(parent, new(pid, ticks), observed.Owner);
            var platform = new ExeUpdateWindowsHelperPlatform(profile, observed.Owner, payload, parent, id);
            payload = null; parent = null; // platform now retains both actual fences through its terminal state.
            var result = await new ExeUpdateHelper(platform, new ExeUpdateIpc(pipe)).RunAsync(token).ConfigureAwait(false);
            return result == ExeUpdateHelperStatus.NewProcessStarted ? 0 : result == ExeUpdateHelperStatus.InstallUncertain ? 30 : 20;
        }
        catch { return 20; }
        finally {
            if (payload is not null) await payload.DisposeAsync().ConfigureAwait(false);
            parent?.Dispose();
        }
    }
}

[SupportedOSPlatform("windows")]
internal sealed class ExeUpdateWindowsHelperPlatform(ReleaseProfile profile, ExeUpdateInstalledOwner owner,
    VerifiedInstalledPayload originalPayload, Process parent, Guid expectedHandoff) : IExeUpdateHelperPlatform
{
    private SafeWaitHandle? gate;
    private ExeUpdateWindowsAuthority? authority;
    private ExeUpdateWindowsTrust.Artifact? artifact;
    private VerifiedInstalledPayload? installedPayload;
    private ExeUpdateHelperOffer? accepted;
    private bool cleanParentExit, attempted, reverified;
    private long verifiedAt;
    private ExeUpdateWindowsNative.SpawnedProcess? installer;

    public async Task<bool> AcceptParentAsync(ExeUpdateHelperOffer offer, CancellationToken token)
    {
        var candidate = offer.Handoff.Candidate;
        if (accepted is not null || offer.Handoff.Id != expectedHandoff || candidate.InstalledOwner != owner ||
            !ExeUpdateHandoffCoordinator.Valid(candidate) || candidate.Parent != ExeUpdateWindowsNative.ProcessIdentity(parent)) return false;
        ExeUpdateWindowsNative.VerifyProcess(parent, candidate.Parent, owner);
        ExeUpdateWindowsTrust.CheckOwner(owner);
        await originalPayload.RevalidateAsync(token).ConfigureAwait(false);
        gate = ExeUpdateWindowsNative.OpenGate(ExeUpdateWindowsNative.GateName(owner.WindowsSid, owner.SessionId, "pilot"));
        authority = new(profile, owner.InstallRoot, offer.Account.SourceAlias, offer.Account.PrincipalId, owner.Version);
        await authority.PinAsync(token).ConfigureAwait(false);
        if (!await authority.CheckExactAsync(candidate, token).ConfigureAwait(false)) return false;
        artifact = await ExeUpdateWindowsTrust.HoldArtifactAsync(candidate, token).ConfigureAwait(false);
        accepted = offer; return true;
    }
    public async Task<bool> WaitForParentExitAsync(ExeUpdateParentIdentity identity, CancellationToken token)
    {
        if (accepted?.Handoff.Candidate.Parent != identity) return false;
        await parent.WaitForExitAsync(token).ConfigureAwait(false); // Actual retained Process handle; no kill.
        return cleanParentExit = ExeUpdateExitPolicy.KnownCleanExit(parent.HasExited, parent.ExitCode);
    }
    public async Task<bool> ReverifyAfterExitAsync(ExeUpdateHelperOffer offer, CancellationToken token)
    {
        if (!cleanParentExit || accepted != offer || authority is null || artifact is null) return false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token); deadline.CancelAfter(TimeSpan.FromSeconds(60));
        ExeUpdateWindowsTrust.CheckOwner(owner);
        await originalPayload.RevalidateAsync(deadline.Token).ConfigureAwait(false);
        if (!await authority.CheckExactAsync(offer.Handoff.Candidate, deadline.Token).ConfigureAwait(false)) return false;
        // Rehash a second held handle after parent exit; immutable old handle remains held too.
        var fresh = await ExeUpdateWindowsTrust.HoldArtifactAsync(offer.Handoff.Candidate, deadline.Token).ConfigureAwait(false);
        if (fresh.Anchor != artifact.Anchor) { await fresh.DisposeAsync().ConfigureAwait(false); return false; }
        await artifact.DisposeAsync().ConfigureAwait(false); artifact = fresh;
        verifiedAt = Environment.TickCount64; reverified = true; return true;
    }
    public async Task<ExeUpdateInstallResult> InstallOnceAsync(ExeUpdateHelperOffer offer)
    {
        if (attempted || !reverified || !cleanParentExit || accepted != offer || artifact is null ||
            Environment.TickCount64 - verifiedAt is < 0 or > 30000) return ExeUpdateInstallResult.Failed;
        attempted = true;
        ExeUpdateWindowsTrust.CheckOwner(owner);
        if (InstallerActivity.Exists(InstallerActivity.ObjectName) || Directory.Exists(ExeUpdateWindowsTrust.Target(offer.Handoff.Candidate.Release.Version)))
            return ExeUpdateInstallResult.Failed;
        // No arbitrary /D, elevation, command shell, alternate installer or retry.
        installer = ExeUpdateWindowsNative.Spawn(offer.Handoff.Candidate.InstallerPath, ["/S"], true);
        // Remain live gate owner across deadline/unknown termination. This shared policy joins the
        // actual retained handle before returning Uncertain; no kill/retry or late-success relabeling.
        return await ExeUpdateInstallerWait.ObserveAsync(installer).ConfigureAwait(false);
    }
    public async Task<bool> VerifyInstalledAsync(ExeUpdateHelperOffer offer, CancellationToken token)
    {
        if (!attempted || accepted != offer || artifact is null || installer is null || installer.ExitCode != 0) return false;
        var release = offer.Handoff.Candidate.Release;
        if (ExeUpdateWindowsTrust.ActiveVersion() != release.Version || artifact.Anchor.SourceCommit != release.SourceCommit) return false;
        installedPayload = await InstalledPayloadVerifier.VerifyAsync(ExeUpdateWindowsTrust.Target(release.Version), release.Version,
            release.SourceCommit, artifact.Anchor.PayloadManifestSha256, profile.CloudflaredSha256!, token).ConfigureAwait(false);
        ExeUpdateWindowsTrust.VerifyManagedRelease(installedPayload.InstallRoot, release.Version);
        await installedPayload.RevalidateAsync(token).ConfigureAwait(false);
        return ExeUpdateWindowsTrust.ActiveVersion() == release.Version;
    }
    public async Task<bool> RelaunchVerifiedAsync(ExeUpdateHelperOffer offer, CancellationToken token)
    {
        if (accepted != offer || installedPayload is null || ExeUpdateWindowsTrust.ActiveVersion() != offer.Handoff.Candidate.Release.Version ||
            InstallerActivity.Exists(InstallerActivity.ObjectName)) return false;
        await installedPayload.RevalidateAsync(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
        // No installer remains capable of acting. Release only our updater gate so the new normal
        // startup can proceed. Actual process creation is not readiness, profile reconnect or sync proof.
        gate?.Dispose(); gate = null;
        using var next = ExeUpdateWindowsNative.Spawn(Path.Combine(installedPayload.InstallRoot, "LedgeTop.Files.exe"), [], false);
        return next.Id > 0;
    }
    public async ValueTask DisposeAsync()
    {
        // InstallOnce never returns from an uncertain running installer. This is reached only after
        // positive natural termination or before any installer creation, so closing the gate is safe.
        installer?.Dispose(); installer = null;
        authority?.Dispose(); authority = null;
        if (installedPayload is not null) await installedPayload.DisposeAsync().ConfigureAwait(false);
        if (artifact is not null) await artifact.DisposeAsync().ConfigureAwait(false);
        await originalPayload.DisposeAsync().ConfigureAwait(false);
        parent.Dispose(); gate?.Dispose(); gate = null;
    }
}
