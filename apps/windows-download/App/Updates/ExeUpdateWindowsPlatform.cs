using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;
using LedgeTop.Files.Backends;
using LedgeTop.WindowsDownload;
using Microsoft.Win32.SafeHandles;

namespace LedgeTop.Files.Updates;

/// <summary>Concrete parent adapter; constructing/using it is NOT wired into the app. Root must supply
/// existing selected-session identity, maintenance UI callbacks and startup gate before activation.</summary>
[SupportedOSPlatform("windows")]
internal sealed class ExeUpdateWindowsPlatform(string sourceAlias, string selectedPrincipal,
    Func<Task> drainAndDisconnect, Func<Task<bool>> recoverProvider, ExeUpdateExitHook exitHook) : IExeUpdateHandoffPlatform
{
    private ReleaseProfile? profile;
    private ExeUpdateInstalledOwner? owner;
    private VerifiedInstalledPayload? payload;
    private ExeUpdateWindowsAuthority? authority;
    private ExeUpdateHandoff? staged;
    private HelperReservation? helper;

    // A UI check is deliberately separate from Apply: no gate creation, staging, drain, helper,
    // installer or reconnect. All installation read handles and cached credential pins are scoped.
    internal static async Task<WindowsAppReleaseCheck> CheckAvailableAsync(ConnectedExplorerUpdateBinding binding, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var principal = binding?.PrincipalId;
        if (binding is null || binding.Channel != "pilot" || binding.SourceAlias is not ("portal" or "employee") ||
            principal is null || !Regex.IsMatch(principal, @"\Aodqp1_[a-f0-9]{64}\z"))
            throw new IOException("Select an authenticated source before checking updates.");
        var profile = ExeUpdateWindowsTrust.Profile();
        if (HasPendingOperation("pilot") || InstallerActivity.Exists(InstallerActivity.ObjectName))
            throw new IOException("An update operation is already pending.");
        var observed = await ExeUpdateWindowsTrust.ReadCurrentAsync(profile, token).ConfigureAwait(false);
        await using var payload = observed.Payload;
        using var authority = new ExeUpdateWindowsAuthority(profile, observed.Owner.InstallRoot, binding.SourceAlias, principal, observed.Owner.Version);
        await authority.PinAsync(token).ConfigureAwait(false);
        async Task VerifyOwner(CancellationToken verifyToken)
        {
            ExeUpdateWindowsTrust.CheckOwner(observed.Owner);
            await payload.RevalidateAsync(verifyToken).ConfigureAwait(false);
            if (HasPendingOperation("pilot") || InstallerActivity.Exists(InstallerActivity.ObjectName))
                throw new IOException("An update operation became pending.");
        }
        return await ExeUpdateMetadataCheck.ReadAsync(authority.CheckAsync, VerifyOwner, authority.VerifySelectedSessionAsync, token).ConfigureAwait(false);
    }

    // Parent startup hook: normal source/UI work must stay unavailable with a plain pending-update
    // message while this is true. Exact maintenance/helper entries have their independent admission.
    internal static bool HasPendingOperation(string channel)
    {
        try {
            if (channel != "pilot") return true;
            using var process = Process.GetCurrentProcess();
            return ExeUpdateWindowsNative.GateExists(ExeUpdateWindowsNative.GateName(ExeUpdateWindowsNative.CurrentSid(), process.SessionId, channel));
        } catch { return true; }
    }

    public Task<IAsyncDisposable?> TryEnterMaintenanceAsync(CancellationToken token)
    {
        token.ThrowIfCancellationRequested(); profile = ExeUpdateWindowsTrust.Profile();
        if (sourceAlias is not ("employee" or "portal") || !Regex.IsMatch(selectedPrincipal ?? "", @"\Aodqp1_[a-f0-9]{64}\z"))
            throw new IOException("Select an authenticated source before updating.");
        if (InstallerActivity.Exists(InstallerActivity.ObjectName)) return Task.FromResult<IAsyncDisposable?>(null);
        using var current = Process.GetCurrentProcess();
        var gate = ExeUpdateWindowsNative.CreateGate(ExeUpdateWindowsNative.GateName(ExeUpdateWindowsNative.CurrentSid(), current.SessionId, "pilot"), ExeUpdateWindowsNative.CurrentSid());
        return Task.FromResult<IAsyncDisposable?>(gate is null ? null : new ParentLease(this, gate));
    }
    public async Task<ExeUpdatePreparation> PrepareFreshAsync(CancellationToken token)
    {
        var observed = await ExeUpdateWindowsTrust.ReadCurrentAsync(profile ?? throw new IOException("Update maintenance not entered."), token).ConfigureAwait(false);
        owner = observed.Owner; payload = observed.Payload;
        authority = new(profile!, owner.InstallRoot, sourceAlias, selectedPrincipal, owner.Version);
        await authority.PinAsync(token).ConfigureAwait(false);
        var stageRoot = ExeUpdateWindowsTrust.StageRoot;
        using var stageDirectories = CreateStageRoot(stageRoot);
        var result = await authority.StageAsync(stageRoot, token).ConfigureAwait(false);
        if (result.Check.Status != WindowsAppReleaseStatus.Available) return new(result.Check.Status);
        using var process = Process.GetCurrentProcess();
        var candidate = new ExeUpdateCandidate(owner, "pilot", authority.Origin, sourceAlias == "portal" ? "/api/client/app" : "/api/app",
            owner.Version, ExeUpdateWindowsNative.ProcessIdentity(process), result.Check.Release!, result.InstallerPath!);
        if (!ExeUpdateHandoffCoordinator.Valid(candidate)) throw new IOException("Update candidate refused.");
        return new(WindowsAppReleaseStatus.Available, candidate);
    }
    private static IDisposable CreateStageRoot(string root)
    {
        var missing = new Stack<string>(); var ancestor = root;
        while (!Directory.Exists(ancestor)) { missing.Push(ancestor); ancestor = Path.GetDirectoryName(ancestor) ?? throw new IOException("Update stage parent unavailable."); }
        var fences = new List<IDisposable>();
        try {
            fences.Add(ExeUpdateWindowsNative.HoldDirectoryChain(ancestor));
            while (missing.TryPop(out var next)) {
                Directory.CreateDirectory(next); ExeUpdateWindowsNative.NoAliases(next);
                fences.Add(ExeUpdateWindowsNative.HoldDirectoryChain(next));
            }
            return new StageDirectories(fences);
        } catch { foreach (var fence in fences) fence.Dispose(); throw; }
    }
    private sealed class StageDirectories(List<IDisposable> fences) : IDisposable
    { public void Dispose() { foreach (var fence in fences) fence.Dispose(); fences.Clear(); } }
    public Task StageHandoffAsync(ExeUpdateHandoff handoff, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (staged is not null || handoff.Id == Guid.Empty || handoff.Candidate.InstalledOwner != owner || !ExeUpdateHandoffCoordinator.Valid(handoff.Candidate))
            throw new IOException("Update proposal refused.");
        staged = handoff; return Task.CompletedTask; // Memory only. Never persist the selected account.
    }
    public Task DrainAndDisconnectAsync() => drainAndDisconnect();
    public async Task<IExeUpdateBoundary?> VerifyBoundaryAsync(ExeUpdateCandidate candidate, CancellationToken token)
    {
        if (staged?.Candidate != candidate || payload is null || authority is null) return null;
        ExeUpdateWindowsTrust.CheckOwner(candidate.InstalledOwner);
        await payload.RevalidateAsync(token).ConfigureAwait(false);
        if (!await authority.CheckExactAsync(candidate, token).ConfigureAwait(false)) return null;
        var artifact = await ExeUpdateWindowsTrust.HoldArtifactAsync(candidate, token).ConfigureAwait(false);
        return new Boundary(candidate, artifact);
    }
    public Task<IExeUpdateHelperReservation?> LaunchHelperAsync(ExeUpdateHandoff handoff, IExeUpdateBoundary boundary, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (staged != handoff || boundary is not Boundary fence || fence.Candidate != handoff.Candidate || helper is not null)
            throw new IOException("Update helper boundary refused.");
        ExeUpdateWindowsTrust.CheckOwner(handoff.Candidate.InstalledOwner);
        // The payload fence and artifact fence remain held by coordinator/maintenance through the handoff.
        var pipeName = "LedgeTop.Files.Update." + Guid.NewGuid().ToString("N");
        var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance, 4096, 4096);
        try {
            var parent = handoff.Candidate.Parent;
            var child = ExeUpdateWindowsNative.Spawn(Path.Combine(handoff.Candidate.InstalledOwner.InstallRoot, "LedgeTop.Files.exe"),
                [ExeUpdateWindowsHelperEntry.Argument, pipeName, parent.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture),
                 parent.StartTimeUtcTicks.ToString(System.Globalization.CultureInfo.InvariantCulture), handoff.Id.ToString("N")], true);
            // Once CreateProcess succeeds the reservation always owns its retained kernel handle.
            helper = new(pipe, child, new(handoff, new(selectedPrincipal, sourceAlias)));
            return Task.FromResult<IExeUpdateHelperReservation?>(helper);
        } catch { pipe.Dispose(); throw; }
    }
    public async Task<ExeUpdateParentExitDecision> RequestParentExitAsync(ExeUpdateHandoff handoff)
    {
        if (helper is null || staged != handoff || authority is null || payload is null) return ExeUpdateParentExitDecision.Rejected;
        try {
            using var fresh = new CancellationTokenSource(TimeSpan.FromSeconds(60));
            await payload.RevalidateAsync(fresh.Token).ConfigureAwait(false);
            ExeUpdateWindowsTrust.CheckOwner(handoff.Candidate.InstalledOwner);
            if (!await authority.CheckExactAsync(handoff.Candidate, fresh.Token).ConfigureAwait(false)) return ExeUpdateParentExitDecision.Rejected;
            return await ExeUpdateExitCommit.InvokeAsync(exitHook, () => helper.ArmAsync(fresh.Token),
                () => helper.CommitFinalExitAsync(fresh.Token), helper.DisarmAndWaitAsync).ConfigureAwait(false);
        } catch {
            // Lost final ACK is not proof of acceptance: keep parent alive and positively join disarm.
            try { await helper.DisarmAndWaitAsync().ConfigureAwait(false); return ExeUpdateParentExitDecision.Rejected; }
            catch { return ExeUpdateParentExitDecision.Uncertain; }
        }
    }
    public Task<bool> RecoverProviderAsync() => recoverProvider();
    public Task RetireHandoffAsync(ExeUpdateHandoff handoff)
    {
        if (staged is not null && staged != handoff) throw new IOException("Update proposal changed.");
        staged = null; return Task.CompletedTask;
    }
    private sealed class ParentLease(ExeUpdateWindowsPlatform owner, SafeWaitHandle gate) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            owner.authority?.Dispose(); owner.authority = null;
            if (owner.payload is not null) { await owner.payload.DisposeAsync().ConfigureAwait(false); owner.payload = null; }
            owner.owner = null; owner.staged = null; owner.helper = null; gate.Dispose();
        }
    }
    private sealed class Boundary(ExeUpdateCandidate candidate, ExeUpdateWindowsTrust.Artifact artifact) : IExeUpdateBoundary
    {
        public ExeUpdateCandidate Candidate { get; } = candidate;
        public ValueTask DisposeAsync() => artifact.DisposeAsync();
    }

    private sealed class HelperReservation(NamedPipeServerStream pipe, ExeUpdateWindowsNative.SpawnedProcess child,
        ExeUpdateHelperOffer offer) : IExeUpdateHelperReservation
    {
        private readonly IExeUpdateIpc ipc = new ExeUpdateIpc(pipe);
        private bool ready, armed, stopped;
        public async Task<bool> WaitReadyAsync(ExeUpdateHandoff handoff, CancellationToken token)
        {
            if (handoff != offer.Handoff) return false;
            await pipe.WaitForConnectionAsync(token).ConfigureAwait(false);
            if (ExeUpdateWindowsNative.PipePeer(pipe, true) != child.Id) return false;
            using var verified = ExeUpdateWindowsNative.OpenBoundProcess(child.Identity, handoff.Candidate.InstalledOwner);
            await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Prepare, handoff.Id, offer), token).ConfigureAwait(false);
            var reply = await ipc.ReadAsync(token).ConfigureAwait(false);
            return ready = reply.Kind == ExeUpdateIpcKind.Ready && reply.HandoffId == handoff.Id;
        }
        internal async Task ArmAsync(CancellationToken token)
        {
            if (!ready || armed) throw new IOException("Update helper not ready to arm.");
            await ipc.WriteAsync(new(1, ExeUpdateIpcKind.CommitExit, offer.Handoff.Id), token).ConfigureAwait(false);
            var reply = await ipc.ReadAsync(token).ConfigureAwait(false);
            if (reply.Kind != ExeUpdateIpcKind.Armed || reply.HandoffId != offer.Handoff.Id) throw new IOException("Update helper arm not confirmed.");
            armed = true;
        }
        internal async Task CommitFinalExitAsync(CancellationToken token)
        {
            if (!armed) throw new IOException("Update helper not armed.");
            await ipc.WriteAsync(new(1, ExeUpdateIpcKind.ExitNow, offer.Handoff.Id), token).ConfigureAwait(false);
            var reply = await ipc.ReadAsync(token).ConfigureAwait(false);
            if (reply.Kind != ExeUpdateIpcKind.ExitCommitted || reply.HandoffId != offer.Handoff.Id) throw new IOException("Final update exit not acknowledged.");
        }
        public async Task DisarmAndWaitAsync()
        {
            if (stopped) return;
            try {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                if (ready && pipe.IsConnected) {
                    await ipc.WriteAsync(new(1, ExeUpdateIpcKind.Disarm, offer.Handoff.Id), timeout.Token).ConfigureAwait(false);
                    var reply = await ipc.ReadAsync(timeout.Token).ConfigureAwait(false);
                    if (reply.Kind != ExeUpdateIpcKind.Stopped || reply.HandoffId != offer.Handoff.Id) throw new IOException("Helper disarm not acknowledged.");
                }
            } catch { /* A missing ACK is NOT safe recovery; below join the retained actual child. */ }
            await child.WaitUntilConfirmedExitAsync().ConfigureAwait(false);
            stopped = true; pipe.Dispose(); child.Dispose();
        }
    }
}
