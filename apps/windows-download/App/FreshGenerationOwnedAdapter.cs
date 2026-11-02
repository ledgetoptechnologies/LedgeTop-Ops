using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

// Actual owned-session adapter for a future coordinator. There is no production
// factory that grants qualification; an unqualified instance refuses before touching
// either session. Caller must retain this object through success or review.
internal sealed class FreshGenerationOwnedAdapter : IFreshGenerationCoordinatorAdapter
{
    private readonly OwnedExplorerRootSession prior, candidate;
    private readonly FreshGenerationPlan.Generation expectedOld;
    private readonly Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate;
    private readonly Func<ConnectedGenerationHeldObservation, PreparedConnectedGeneration, bool> proveSeparation;
    private readonly Func<PreparedConnectedGeneration, bool> proveJournal;
    private readonly Func<bool> qualification;
    private readonly bool synthetic;
    private ConnectedGenerationHeldObservation? priorObservation, readyObservation;
    private RetainedPriorGeneration? priorReceipt;
    private PreparedConnectedGeneration? prepared;
    private readonly SemaphoreSlim transition = new(1, 1);
    private IExplorerPreviewSession? syntheticPrior;
    private Func<ConnectedGenerationHeldObservation>? syntheticObservation;
    private Func<PreparedConnectedGeneration, Task<ConnectedGenerationHeldObservation>>? syntheticStart;
    private bool syntheticStartAttempted;
    private bool candidateStopped, candidateEvidenceReleased, priorReclaimed, priorStopped;

    private FreshGenerationOwnedAdapter(OwnedExplorerRootSession prior, OwnedExplorerRootSession candidate,
        FreshGenerationPlan.Generation expectedOld, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate,
        Func<ConnectedGenerationHeldObservation, PreparedConnectedGeneration, bool> proveSeparation,
        Func<PreparedConnectedGeneration, bool> proveJournal, Func<bool> qualification, bool synthetic = false)
    {
        this.prior = prior; this.candidate = candidate; this.expectedOld = expectedOld; this.authenticate = authenticate;
        this.proveSeparation = proveSeparation; this.proveJournal = proveJournal; this.qualification = qualification; this.synthetic = synthetic;
    }
    internal static FreshGenerationOwnedAdapter CreateDisabled(OwnedExplorerRootSession prior, OwnedExplorerRootSession candidate,
        FreshGenerationPlan.Generation old, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate) =>
        new(prior, candidate, old, authenticate, (_, _) => false, _ => false, () => false);
    internal static FreshGenerationOwnedAdapter CreateForSession(OwnedExplorerRootSession prior, OwnedExplorerRootSession candidate,
        FreshGenerationPlan.Generation old, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate,
        Func<ConnectedGenerationHeldObservation, PreparedConnectedGeneration, bool> separate,
        Func<PreparedConnectedGeneration, bool> journal) =>
        new(prior, candidate, old, authenticate, separate, journal, () => FreshGenerationStagingQualification.Allows(old.Scope));

    // Internal synthetic seam only; it must not be used by the production composition.
    internal static FreshGenerationOwnedAdapter CreateForTest(OwnedExplorerRootSession prior, OwnedExplorerRootSession candidate,
        FreshGenerationPlan.Generation old, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate,
        Func<ConnectedGenerationHeldObservation, PreparedConnectedGeneration, bool> separate,
        Func<PreparedConnectedGeneration, bool> journal) => new(prior, candidate, old, authenticate, separate, journal, () => true, synthetic: true);

    private void RequireQualified() { if (!qualification()) throw new IOException("Fresh connections are not available until ownership checks are qualified."); }
    internal void VerifyCapability() => RequireQualified();
    internal bool OwnsPrior(IExplorerPreviewSession session) => ReferenceEquals(prior, session);
    internal OwnedExplorerRootSession CandidateSession => candidate;
    internal bool OwnsSyntheticPriorForTest(IExplorerPreviewSession session) => ReferenceEquals(syntheticPrior, session);
    internal void SetSyntheticPriorForTest(IExplorerPreviewSession session)
    { if (!synthetic) throw new IOException("Synthetic ownership is unavailable."); syntheticPrior = session; }
    internal void SetSyntheticObservationForTest(Func<ConnectedGenerationHeldObservation> acquire)
    { if (!synthetic) throw new IOException("Synthetic ownership is unavailable."); syntheticObservation = acquire; }
    internal void SetSyntheticStartForTest(Func<PreparedConnectedGeneration, Task<ConnectedGenerationHeldObservation>> start)
    { if (!synthetic) throw new IOException("Synthetic start is unavailable."); syntheticStart = start; }
    internal bool HasNoAcquiredOwnershipForTest => synthetic && syntheticPrior is not null && priorObservation is null && prepared is null && priorReceipt is null && readyObservation is null;
    // Coordinator holds this lease across every await, including selector publication.
    // The caller must retain this adapter after any return or exception.
    internal async Task<IDisposable> HoldTransitionAsync(CancellationToken token)
    {
        await transition.WaitAsync(token).ConfigureAwait(false);
        return new TransitionLease(transition);
    }
    private sealed class TransitionLease(SemaphoreSlim gate) : IDisposable
    {
        private SemaphoreSlim? held = gate;
        public void Dispose() => Interlocked.Exchange(ref held, null)?.Release();
    }
    // This only restores ownership of the exact old handles to the old session.
    // It neither restarts the provider nor unregisters either root.
    internal async Task ReclaimPriorAsync(CancellationToken token)
    {
        using var held = await HoldTransitionAsync(token).ConfigureAwait(false);
        var receipt = priorReceipt ?? throw new IOException("No confirmed prior transfer is available.");
        await prior.ReclaimPriorLeaseAsync(receipt, token).ConfigureAwait(false);
        priorReceipt = null;
    }
    // Stops a published fresh connection without removing either registration.
    // Every uncertain phase keeps the exact remaining sessions/handles for retry.
    internal async Task StopPublishedAsync(Func<bool> exactSelector)
    {
        ArgumentNullException.ThrowIfNull(exactSelector);
        using var held = await HoldTransitionAsync(CancellationToken.None).ConfigureAwait(false);
        RequireQualified();
        if (!exactSelector()) throw new IOException("Fresh selector ownership changed.");
        if (!candidateStopped) {
            var ready = readyObservation ?? throw new IOException("Candidate observation is unavailable.");
            ready.Handles.Recheck();
            await candidate.DisposeAsync().ConfigureAwait(false);
            candidateStopped = true;
        }
        if (!candidateEvidenceReleased) {
            var ready = readyObservation ?? throw new IOException("Candidate observation is unavailable.");
            ready.Handles.Recheck();
            if (!exactSelector()) throw new IOException("Fresh selector changed while stopping candidate.");
            ready.Dispose(); readyObservation = null; candidateEvidenceReleased = true;
        }
        if (!priorReclaimed) {
            var receipt = priorReceipt ?? throw new IOException("Prior generation receipt is unavailable.");
            await prior.ReclaimPriorLeaseAsync(receipt, CancellationToken.None).ConfigureAwait(false);
            priorReceipt = null; priorReclaimed = true;
        }
        if (!priorStopped) { await prior.DisposeAsync().ConfigureAwait(false); priorStopped = true; }
        if (!exactSelector()) throw new IOException("Fresh selector changed while stopping prior generation.");
    }
    // Live-session proof only: no provider is adopted or restarted, and this
    // observation cannot establish ownership after a process restart.
    internal async Task VerifyPublishedHeldAsync(FreshGenerationIndexCodec.Index selector, CancellationToken token)
    {
        using var held = await HoldTransitionAsync(token).ConfigureAwait(false);
        RequireQualified(); token.ThrowIfCancellationRequested();
        var previous = priorReceipt ?? throw new IOException("Prior generation receipt is unavailable.");
        var ready = readyObservation ?? throw new IOException("Candidate observation is unavailable.");
        var next = selector.State.New ?? throw new IOException("Candidate selector is unavailable.");
        var root = selector.State.ReadyRoot ?? throw new IOException("Ready evidence is unavailable.");
        var snapshot = ready.Snapshot; var pins = ready.Handles;
        if (selector.State.Phase != FreshGenerationPlan.Phase.Published || selector.ActiveGeneration != next.Id ||
            selector.State.Old != expectedOld || previous.Snapshot.Identity != expectedOld.Id ||
            snapshot.Identity != next.Id || snapshot.ProfileDirectory != next.ProfileDirectory || snapshot.RootPath != next.RootPath ||
            snapshot.ManifestDigest != next.ManifestDigest || snapshot.ProfileRevision != root.ProfileRevision ||
            snapshot.NamespaceClsid != root.NamespaceClsid || pins.RootVolume != root.Volume || pins.RootFileId != root.FileId ||
            pins.ProfileDirectoryVolume != next.ProfileDirectoryVolume || pins.ProfileDirectoryFileId != next.ProfileDirectoryFileId ||
            pins.ProfileVolume != root.ProfileDocumentVolume || pins.ProfileFileId != root.ProfileDocumentFileId)
            throw new IOException("Published generation evidence differs from the retained sessions.");
        pins.Recheck();
        var scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
        if (scope != expectedOld.Scope) throw new IOException("Authenticated source changed.");
        pins.Recheck();
    }
    internal async Task ReleaseReclaimedSyntheticBeforeStartAsync()
    {
        using var held = await HoldTransitionAsync(CancellationToken.None).ConfigureAwait(false);
        if (!synthetic || syntheticPrior is null || priorReceipt is not null || syntheticStartAttempted || readyObservation is not null)
            throw new IOException("Synthetic transition still owns uncertain work.");
        await candidate.DisposeAsync().ConfigureAwait(false);
        await prior.DisposeAsync().ConfigureAwait(false);
        priorObservation?.Dispose(); priorObservation = null; prepared = null;
    }
    internal async Task ReleaseReclaimedSyntheticAfterFakeStartAsync()
    {
        using var held = await HoldTransitionAsync(CancellationToken.None).ConfigureAwait(false);
        if (!synthetic || syntheticPrior is null || priorReceipt is not null || !syntheticStartAttempted || syntheticStart is null || readyObservation is null)
            throw new IOException("Synthetic transition still owns uncertain work.");
        readyObservation.Dispose(); readyObservation = null;
        await candidate.DisposeAsync().ConfigureAwait(false);
        await prior.DisposeAsync().ConfigureAwait(false);
        priorObservation?.Dispose(); priorObservation = null; prepared = null;
    }
    public async Task<FreshGenerationCandidate> CaptureAndReserveAsync(FreshGenerationPlan.Scope expected, CancellationToken token)
    {
        RequireQualified(); token.ThrowIfCancellationRequested();
        var current = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
        if (expected != expectedOld.Scope || current != expected) throw new IOException("Authenticated source changed.");
        if (priorObservation is not null || prepared is not null) throw new IOException("Candidate reservation already attempted.");
        priorObservation = syntheticObservation is null ? prior.AcquireConnectedGenerationHandles() : syntheticObservation(); // retained even on failure
        var snapshot = priorObservation.Snapshot;
        var pins = priorObservation.Handles;
        if (snapshot.Identity != expectedOld.Id || snapshot.Scope.Channel != expected.Channel || snapshot.Scope.Alias != expected.Source ||
            snapshot.Scope.Origin != expected.Origin || snapshot.Scope.PrincipalId != expected.Principal ||
            snapshot.ProfileDirectory != expectedOld.ProfileDirectory || snapshot.RootPath != expectedOld.RootPath ||
            snapshot.ManifestDigest != expectedOld.ManifestDigest || snapshot.ProfileRevision != expectedOld.ProfileRevision ||
            pins.ProfileDirectoryVolume != expectedOld.ProfileDirectoryVolume || pins.ProfileDirectoryFileId != expectedOld.ProfileDirectoryFileId ||
            pins.ProfileVolume != expectedOld.ProfileDocumentVolume || pins.ProfileFileId != expectedOld.ProfileDocumentFileId ||
            pins.RootVolume != expectedOld.RootVolume || pins.RootFileId != expectedOld.RootFileId || snapshot.NamespaceClsid != expectedOld.NamespaceClsid)
            throw new IOException("Prior generation changed before reservation.");
        prepared = await candidate.PrepareFreshConnectedCandidateAsync().ConfigureAwait(false); token.ThrowIfCancellationRequested();
        if (prepared.Scope.Channel != expected.Channel || prepared.Scope.Alias != expected.Source || prepared.Scope.Origin != expected.Origin ||
            prepared.Scope.PrincipalId != expected.Principal || !proveSeparation(priorObservation, prepared))
            throw new IOException("Candidate ownership or separation was not verified.");
        return new(new(prepared.Identity, expected, prepared.ProfileDirectory, prepared.RootPath, prepared.ManifestDigest,
            prepared.ProfileVolume, prepared.ProfileFileId, prepared.ProfileRevision, prepared.ProfileDocumentVolume, prepared.ProfileDocumentFileId), current, true);
    }
    public async Task<bool> DrainPriorAsync(FreshGenerationPlan.Generation expected, CancellationToken token)
    {
        RequireQualified();
        if (expected != expectedOld || priorObservation is null || priorReceipt is not null) throw new IOException("Prior generation ownership changed.");
        priorReceipt = await prior.DrainAndTransferPriorLeaseAsync(priorObservation, token).ConfigureAwait(false);
        return true;
    }
    public async Task<FreshGenerationReady> StartAndObserveAsync(FreshGenerationPlan.Generation expected, CancellationToken token)
    {
        RequireQualified(); token.ThrowIfCancellationRequested();
        var reserved = prepared ?? throw new IOException("Candidate reservation is absent.");
        if (priorReceipt is null || readyObservation is not null || expected.Id != reserved.Identity ||
            expected.ProfileDirectory != reserved.ProfileDirectory || expected.RootPath != reserved.RootPath ||
            expected.ManifestDigest != reserved.ManifestDigest || expected.ProfileDirectoryVolume != reserved.ProfileVolume ||
            expected.ProfileDirectoryFileId != reserved.ProfileFileId || expected.ProfileRevision != reserved.ProfileRevision ||
            expected.ProfileDocumentVolume != reserved.ProfileDocumentVolume || expected.ProfileDocumentFileId != reserved.ProfileDocumentFileId)
            throw new IOException("Candidate reservation changed.");
        if (synthetic) syntheticStartAttempted = true;
        if (syntheticStart is not null) readyObservation = await syntheticStart(reserved).ConfigureAwait(false);
        else { await candidate.StartReservedCandidateAsync(proveJournal).ConfigureAwait(false); readyObservation = candidate.AcquireConnectedGenerationHandles(); }
        token.ThrowIfCancellationRequested(); // observation remains owned if cancellation wins
        var snapshot = readyObservation.Snapshot; var handles = readyObservation.Handles;
        if (snapshot.Identity != expected.Id || snapshot.RootPath != expected.RootPath || snapshot.ProfileDirectory != expected.ProfileDirectory ||
            snapshot.ManifestDigest != expected.ManifestDigest || handles.ProfileDirectoryVolume != expected.ProfileDirectoryVolume || handles.ProfileDirectoryFileId != expected.ProfileDirectoryFileId)
            throw new IOException("Ready candidate differs from its reservation.");
        return new(snapshot.Identity, snapshot.ManifestDigest, snapshot.RootPath,
            new(handles.RootVolume, handles.RootFileId, snapshot.NamespaceClsid, snapshot.ProfileRevision, handles.ProfileVolume, handles.ProfileFileId), true);
    }
    public async Task<FreshGenerationPlan.Scope> RecheckAuthenticatedScopeAsync(CancellationToken token)
    {
        RequireQualified(); var result = await authenticate(token).ConfigureAwait(false);
        if (result != expectedOld.Scope) throw new IOException("Authenticated source changed.");
        return result;
    }
}
