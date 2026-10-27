using LedgeTop.WindowsDownload;

namespace LedgeTop.Files.Updates;

internal enum ExeUpdateHandoffStatus
{
    NoUpdate, Busy, PreparationFailed, DrainFailed, Postponed, BoundaryRejected,
    HelperUnavailable, NeedsReconnect, RecoveryBlocked, ExitRejected, ExitUncertain, ParentExitRequested
}

// ParentExitRequested means a handoff only. No value claims installed/relaunched success.
// True includes an uncertain drain/recovery: active provider operation has NOT been confirmed restored.
internal sealed record ExeUpdateHandoffResult(ExeUpdateHandoffStatus Status, bool ProviderRequiresReconnect);
internal sealed record ExeUpdateParentIdentity(int ProcessId, long StartTimeUtcTicks);
// Observed existing installer ownership, not a generated installation capability. The Windows adapter
// must prove this exact tuple from the current SID/session, fixed registry/path, marker and actual files.
internal sealed record ExeUpdateInstalledOwner(string WindowsSid, int SessionId, string Version, string InstallRoot,
    string Owner, string PayloadManifestSha256, string SourceCommit, string AppHostSha256, string ManagedAssemblySha256);
internal sealed record ExeUpdateCandidate(ExeUpdateInstalledOwner InstalledOwner, string Channel, Uri Origin, string ApiBase,
    string CurrentVersion, ExeUpdateParentIdentity Parent, WindowsAppReleasePins Release, string InstallerPath);
internal sealed record ExeUpdatePreparation(WindowsAppReleaseStatus Status, ExeUpdateCandidate? Candidate = null);

// Bounded nonsecret model only: no token, credentials, principal name, launch arguments or arbitrary command.
// This is NOT an on-disk or IPC protocol. A separately reviewed adapter must define atomic owned storage,
// helper authentication/readiness, expiration and receipt cleanup before production use.
internal sealed record ExeUpdateHandoff(Guid Id, ExeUpdateCandidate Candidate)
{
    internal const int SchemaVersion = 1;
}

internal enum ExeUpdateParentExitDecision { Rejected, Accepted, Uncertain }

// Dispatcher hook: reject BEFORE invoking commitFinalExit; invoke it exactly once only when graceful
// shutdown can be accepted, await ExitCommitted acknowledgement, then close with code0. A failure after
// acknowledgement is uncertain. Sending intent and exiting cannot be atomic; the helper also demands
// retained-handle clean termination and fresh authority, and cannot distinguish every exit-code0 crash.
internal delegate Task<ExeUpdateParentExitDecision> ExeUpdateExitHook(Func<Task> commitFinalExit);

internal interface IExeUpdateBoundary : IAsyncDisposable
{
    ExeUpdateCandidate Candidate { get; }
}

internal interface IExeUpdateHelperReservation
{
    // Must authenticate readiness against this exact handoff AND real parent process/start identity.
    // Ready never permits installing while that parent is still alive. The real helper must itself
    // reverify owned paths/bytes/version/authority at execution time, after confirmed parent exit.
    Task<bool> WaitReadyAsync(ExeUpdateHandoff handoff, CancellationToken cancellationToken);
    // No cancellation: confirm helper cannot install before reconnecting/releasing maintenance.
    Task DisarmAndWaitAsync();
}

internal interface IExeUpdateHandoffPlatform
{
    // Lease serializes maintenance with source reconnect/new work/other update owners. Release on a
    // rejected attempt only; an accepted/uncertain exit keeps it held until actual process termination.
    // The lease must support asynchronous disposal on another thread or marshal to its owning thread.
    Task<IAsyncDisposable?> TryEnterMaintenanceAsync(CancellationToken cancellationToken);
    // Fresh cached-human authorization and WindowsAppReleaseClient verified staging; no interactive login.
    Task<ExeUpdatePreparation> PrepareFreshAsync(CancellationToken cancellationToken);
    // New owned bounded in-memory proposal, not a restartable on-disk authority. No account/token is
    // written here; any future diagnostic receipt needs separate privacy/ownership review.
    Task StageHandoffAsync(ExeUpdateHandoff handoff, CancellationToken cancellationToken);
    // Gracefully save/drain/disconnect existing provider; NEVER Remove/unregister/delete a sync root.
    Task DrainAndDisconnectAsync();
    // Revalidate exact current identity, installed ownership/version and staged bytes; hold a stable
    // artifact/session fence until disposal. Null refuses. Must not silently refresh another identity.
    Task<IExeUpdateBoundary?> VerifyBoundaryAsync(ExeUpdateCandidate candidate, CancellationToken cancellationToken);
    // No adapter is implemented. A throwing/null launch MUST confirm no install-capable child remains.
    Task<IExeUpdateHelperReservation?> LaunchHelperAsync(ExeUpdateHandoff handoff, IExeUpdateBoundary boundary,
        CancellationToken cancellationToken);
    // Cancellation is checked before this commit point. Exceptions are uncertain, never a safe rejection.
    Task<ExeUpdateParentExitDecision> RequestParentExitAsync(ExeUpdateHandoff handoff);
    // True only after the disconnected provider is actually restored. False requires explicit reconnect;
    // do not open a browser, change grants, remove roots or claim recovery from a callback invocation alone.
    Task<bool> RecoverProviderAsync();
    // Retire only this owned proposal after helper disarm, never installer/user payloads or profiles.
    Task RetireHandoffAsync(ExeUpdateHandoff handoff);
}
