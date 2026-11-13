using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

// Disabled composition: the caller must retain this object, its selector lease,
// both sessions and their provider tasks on every outcome. This does not yet
// expose an operational ConnectedExplorerSession or support updates/uninstall.
internal sealed class FreshGenerationColdRestart
{
    // Deliberately false until selector/root fencing, session lifecycle, update
    // handoff and provider recovery have all passed qualification.
    private readonly OwnedExplorerRootSession prior, current;
    private readonly FreshGenerationIndexCodec.Index selector;
    private readonly Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate;
    private readonly Func<bool> selectorProof, qualified;
    private readonly bool synthetic;
    private readonly SemaphoreSlim lifecycle = new(1, 1);
    private int attempted;
    private bool priorAttempted, currentAttempted, priorHeld, currentHeld, priorStopped, currentStopped;
    private bool priorDisposed, currentDisposed;
    // Retained only by the experimental preactivation recovery path. Once an
    // authority is adopted, the original selector proof is no longer usable.
    private IStoppedGenerationAuthority? deferredRecoveryAuthority;
    private bool deferredRecoveryStarted, deferredCurrentDrained, deferredAuthorityAdopted;
    private FreshGenerationColdRestart(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate,
        Func<bool> selectorProof, Func<bool> qualified, bool synthetic = false)
    { this.prior = prior; this.current = current; this.selector = selector; this.authenticate = authenticate; this.selectorProof = selectorProof; this.qualified = qualified; this.synthetic = synthetic; }
    internal static FreshGenerationColdRestart CreateDisabled(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate) =>
        new(prior, current, selector, authenticate, () => false, () => false);
    internal static FreshGenerationColdRestart CreateForSession(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<CancellationToken, Task<FreshGenerationPlan.Scope>> authenticate, Func<bool> selectorProof) =>
        new(prior, current, selector, authenticate, selectorProof, () => FreshGenerationStagingQualification.Allows(selector.State.Old.Scope));
    // Synthetic test seam: both supplied sessions must already hold generated-only
    // observations. It does not admit a production factory or native startup.
    internal static FreshGenerationColdRestart CreateSyntheticHeldForTest(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<bool> selectorProof) =>
        new(prior, current, selector, _ => throw new InvalidOperationException(), selectorProof, () => true, synthetic: true) {
            attempted = 1, priorAttempted = true, currentAttempted = true, priorHeld = true, currentHeld = true
        };
    internal static FreshGenerationColdRestart CreateSyntheticPartialForTest(OwnedExplorerRootSession prior, OwnedExplorerRootSession current,
        FreshGenerationIndexCodec.Index selector, Func<bool> selectorProof, bool currentAttempted) =>
        new(prior, current, selector, _ => throw new InvalidOperationException(), selectorProof, () => true, synthetic: true) {
            attempted = 1, priorAttempted = true, priorHeld = true, currentAttempted = currentAttempted
        };
    internal void VerifyCapability() { if (!qualified()) throw new IOException("Fresh generation restart is not qualified."); }
    internal bool MatchesSelector(FreshGenerationIndexCodec.Index expected) => selector == expected;
    internal bool DeferredRecoveryStarted => deferredRecoveryStarted;
    internal OwnedExplorerRootSession CurrentSession => current;
    internal bool SyntheticForTest => synthetic;

    internal async Task VerifyAndStartAsync(CancellationToken token)
    {
        await lifecycle.WaitAsync(token).ConfigureAwait(false);
        try {
        VerifyCapability();
        if (Interlocked.Exchange(ref attempted, 1) != 0) throw new IOException("A restart was already attempted; retain ownership for review.");
        var state = selector.State; var next = state.New ?? throw new IOException("Candidate missing.");
        var ready = state.ReadyRoot ?? throw new IOException("Ready evidence missing.");
        if (state.Phase != FreshGenerationPlan.Phase.Published || selector.ActiveGeneration != next.Id || !selectorProof())
            throw new IOException("Published selector is unavailable.");
        var scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
        if (scope != state.Old.Scope || scope != next.Scope || !selectorProof()) throw new IOException("Restart account or selector changed.");
        priorAttempted = true;
        var old = prior.AcquireExistingRestartObservation();
        priorHeld = true;
        if (!Matches(old, state.Old, state.Old.RootVolume, state.Old.RootFileId, state.Old.NamespaceClsid,
            state.Old.ProfileRevision, state.Old.ProfileDocumentVolume, state.Old.ProfileDocumentFileId))
            throw new IOException("Prior generation differs from selector.");
        currentAttempted = true;
        var candidate = current.AcquireExistingRestartObservation();
        currentHeld = true;
        if (!Matches(candidate, next, ready.Volume, ready.FileId, ready.NamespaceClsid,
            ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId) || !selectorProof())
            throw new IOException("Candidate generation differs from selector.");
        token.ThrowIfCancellationRequested();
        bool Proof(RestartGenerationEvidence e) => selectorProof() && Matches(e, next, ready.Volume, ready.FileId,
            ready.NamespaceClsid, ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId);
        // Do not abandon the provider task when cancellation arrives: await settlement,
        // then retain both sessions on cancellation or any uncertain outcome.
        await current.StartHeldRestartProviderAsync(Proof).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (!Matches(prior.RecheckExistingRestartObservation(), state.Old, state.Old.RootVolume, state.Old.RootFileId,
            state.Old.NamespaceClsid, state.Old.ProfileRevision, state.Old.ProfileDocumentVolume, state.Old.ProfileDocumentFileId) || !selectorProof())
            throw new IOException("Prior generation or selector changed during restart.");
        scope = await authenticate(token).ConfigureAwait(false); token.ThrowIfCancellationRequested();
        if (scope != next.Scope || !selectorProof()) throw new IOException("Restart account or selector changed after startup.");
        } finally { lifecycle.Release(); }
    }
    // No root unregistration or deletion. Partial stop outcomes stay attached;
    // only successful, individually verified drains advance their in-memory state.
    internal async Task StopHeldAsync()
    {
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try {
            if (deferredRecoveryStarted) throw new IOException("Deferred recovery owns this restart.");
            VerifyCapability();
            var state = selector.State; var next = state.New ?? throw new IOException("Candidate missing.");
            var ready = state.ReadyRoot ?? throw new IOException("Ready evidence missing.");
            if (!selectorProof()) throw new IOException("Restart selector is not current.");
            if (currentHeld && !currentStopped) {
                await current.StopHeldRestartProviderAsync(e => selectorProof() && Matches(e, next, ready.Volume, ready.FileId,
                    ready.NamespaceClsid, ready.ProfileRevision, ready.ProfileDocumentVolume, ready.ProfileDocumentFileId)).ConfigureAwait(false);
                currentStopped = true;
            }
            if (priorHeld && !priorStopped) {
                var old = state.Old;
                await prior.StopHeldRestartProviderAsync(e => selectorProof() && Matches(e, old, old.RootVolume, old.RootFileId,
                    old.NamespaceClsid, old.ProfileRevision, old.ProfileDocumentVolume, old.ProfileDocumentFileId)).ConfigureAwait(false);
                priorStopped = true;
            }
            if ((priorAttempted && !priorHeld) || (currentAttempted && !currentHeld))
                throw new IOException("A restart acquisition outcome is uncertain; retain it for ownership review.");
        } finally { lifecycle.Release(); }
    }

    // Recovery for an unactivated deferred current provider only. The caller
    // retains its original index lock until both provider stops have completed;
    // adoption must transfer that exact handle without closing it. This method
    // remains uncalled by production composition until deferred startup and
    // authority handoff are qualified together.
    internal async Task StopDeferredPreactivationAsync(Func<IStoppedGenerationAuthority> adopt)
    {
        ArgumentNullException.ThrowIfNull(adopt);
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try {
            VerifyCapability();
            deferredRecoveryStarted = true;
            var state = selector.State;
            var next = state.New ?? throw new IOException("Candidate missing.");
            var ready = state.ReadyRoot ?? throw new IOException("Ready evidence missing.");
            if (!deferredAuthorityAdopted && !selectorProof()) throw new IOException("Restart selector is not current.");
            if (!currentHeld || (priorAttempted && !priorHeld) || (currentAttempted && !currentHeld))
                throw new IOException("A restart acquisition outcome is uncertain; retain it for ownership review.");
            if (!deferredCurrentDrained) {
                await current.StopHeldRestartDeferredProviderAsync().ConfigureAwait(false);
                deferredCurrentDrained = true;
            }
            if (priorHeld && !priorStopped) {
                var old = state.Old;
                await prior.StopHeldRestartProviderAsync(e => selectorProof() && Matches(e, old, old.RootVolume, old.RootFileId,
                    old.NamespaceClsid, old.ProfileRevision, old.ProfileDocumentVolume, old.ProfileDocumentFileId)).ConfigureAwait(false);
                priorStopped = true;
            }
            if (!deferredAuthorityAdopted) {
                if (!selectorProof()) throw new IOException("Restart selector changed before handoff.");
                deferredRecoveryAuthority = adopt() ?? throw new IOException("Selector handoff failed.");
                deferredAuthorityAdopted = true;
            }
            if (!currentStopped) {
                if (deferredRecoveryAuthority is not null)
                    current.ReleaseStoppedDeferredObservationOwned(ref deferredRecoveryAuthority);
                else
                    current.RetryStoppedDeferredOwnedCleanup();
                currentStopped = true;
            }
        } finally { lifecycle.Release(); }
    }
    // Called only after both provider stops have completed. No unregistration or
    // profile deletion is performed; failures retain exact session objects.
    internal async Task DisposeStoppedSessionsAsync()
    {
        await lifecycle.WaitAsync().ConfigureAwait(false);
        try {
            if ((currentHeld && !currentStopped) || (priorHeld && !priorStopped) ||
                (currentAttempted && !currentHeld) || (priorAttempted && !priorHeld))
                throw new IOException("Restart sessions are not confirmed stopped.");
            if (!currentDisposed) { await current.DisposeAsync().ConfigureAwait(false); currentDisposed = true; }
            if (!priorDisposed) { await prior.DisposeAsync().ConfigureAwait(false); priorDisposed = true; }
        } finally { lifecycle.Release(); }
    }
    internal static bool Matches(RestartGenerationEvidence e, FreshGenerationPlan.Generation g, uint volume, ulong file,
        Guid clsid, long revision, uint documentVolume, ulong documentFile)
    {
        var s = e.Snapshot;
        return s.Identity == g.Id && s.ProfileDirectory == g.ProfileDirectory && s.RootPath == g.RootPath &&
            s.ManifestDigest == g.ManifestDigest && s.Scope.Channel == g.Scope.Channel && s.Scope.Alias == g.Scope.Source &&
            s.Scope.Origin == g.Scope.Origin && s.Scope.PrincipalId == g.Scope.Principal && s.ProfileRevision == revision &&
            s.NamespaceClsid == clsid && e.ProfileDirectoryVolume == g.ProfileDirectoryVolume && e.ProfileDirectoryFileId == g.ProfileDirectoryFileId &&
            e.ProfileDocumentVolume == documentVolume && e.ProfileDocumentFileId == documentFile && e.RootVolume == volume && e.RootFileId == file;
    }
}
